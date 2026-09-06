/**
 * Per-Session runtime owner (Issue #84): FIFO eval queue, one kernel per
 * Session key, sandbox launch resolution, idle retention, and M5/M10
 * checkpoint registry integration. Private implementation boundary.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { open as openFile, readFile as readFileAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_TIMEOUT, DURABLE_MAGIC, IDLE_KERNEL_TTL_MS, isManualReset, MAX_DURABLE_HEADER_BYTES,
  MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROOT_BYTES, RlmError,
  type RlmEvalInput, type RlmEvalOutput, type RlmRuntimeConfig,
} from './model.ts'
import { KERNEL_PATH, Kernel, type KernelLaunch, type QueuedEval, type SandboxConfined, type SandboxPolicyService, type SandboxProvider } from './kernel.ts'
import { releaseRuntimeJobSlots } from './jobs.ts'


export interface RlmRuntime {
  /**
   * Run one Python cell for a session key, reusing that session's kernel when
   * one already exists and starting a fresh process on its first use.
   */
  eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput>
  /**
   * Terminate every owned Python process and release all session kernels.
   * Terminal state is set synchronously (later evals reject `closed`); the
   * returned barrier resolves after every kernel's child cleanup barrier, so
   * a plugin unload can await full quiescence.
   */
  dispose(): Promise<void>
  /**
   * The config the runtime was created with, when available. Used by the M12
   * job producer to build the same query/spawn/followup bridge as foreground
   * `rlm_eval` (Issue #78).
   */
  runtimeConfig?(): RlmRuntimeConfig | undefined
}

export class RlmRuntimeImpl implements RlmRuntime {
  private kernels = new Map<string, Kernel>()
  private readonly checkpointRoot: string | undefined
  private readonly checkpoints = new Set<string>()
  private readonly checkpointReservations = new Map<string, number>()
  private queues = new Map<string, QueuedEval[]>()
  private drains = new Map<string, Promise<void>>()
  private readonly kernelLastUse = new Map<string, number>()
  private config: RlmRuntimeConfig
  private readonly ctx: Context | undefined
  private readonly durableRoot: string | undefined
  private readonly durableVersion = 2
  private readonly durableAccounting = new Map<string, number>()
  /** Validated content hashes and file fingerprints used for safe same-runtime dedup. */
  private readonly durableHashes = new Map<string, string>()
  private readonly durableFingerprints = new Map<string, string>()
  private disposed = false
  private disposePromise: Promise<void> | undefined
  constructor(config: RlmRuntimeConfig, ctx?: Context) {
    this.config = config
    this.ctx = ctx
    this.durableRoot = typeof config.durableRoot === 'string' && config.durableRoot.trim() !== '' ? path.resolve(config.durableRoot) : undefined
    if (this.durableRoot) {
      mkdirSync(this.durableRoot, { recursive: true })
      // Issue #89: account the bytes already persisted in the durable root so
      // the 64 MiB bound survives plugin/host restarts (in-memory reservation
      // maps reset while durable files remain).
      this.rescanDurableRoot()
    }
    if (config.snapshotRecovery === true) {
      this.checkpointRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m5-'))
    }
  }

  runtimeConfig(): RlmRuntimeConfig | undefined {
    return this.config
  }

  private durablePath(sessionKey: string, suffix: string): string {
    return path.join(this.durableRoot!, this.durableFileKey(sessionKey) + suffix)
  }

  private durableFileKey(sessionKey: string): string {
    return createHash('sha256').update(sessionKey).digest('hex')
  }

  private durableError(message: string): RlmError {
    return new RlmError('snapshot', message, { phase: 'snapshot' })
  }

  private durableLstat(file: string, label: string): ReturnType<typeof lstatSync> | undefined {
    try {
      return lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw this.durableError(`could not inspect ${label}`)
    }
  }

  private async syncDurableDirectory(): Promise<void> {
    if (!this.durableRoot || process.platform === 'win32') return
    let handle: Awaited<ReturnType<typeof openFile>> | undefined
    try {
      handle = await openFile(this.durableRoot, 'r')
      await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
        throw this.durableError('durable directory fsync failed')
      }
    } finally {
      if (handle !== undefined) {
        try { await handle.close() } catch { /* best-effort close after fsync */ }
      }
    }
  }

  private durableFingerprint(info: NonNullable<ReturnType<typeof lstatSync>>): string {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
  }

  private rememberDurableGeneration(sessionKey: string, payload: Buffer, info?: NonNullable<ReturnType<typeof lstatSync>>): void {
    const key = this.durableFileKey(sessionKey)
    this.durableHashes.set(key, createHash('sha256').update(payload).digest('hex'))
    const current = info ?? this.durableLstat(this.durablePath(sessionKey, '.checkpoint.json'), 'durable checkpoint')
    if (current?.isFile()) this.durableFingerprints.set(key, this.durableFingerprint(current))
  }
  private encodeDurableEnvelope(bytes: Buffer): Buffer {
    if (bytes.length < 1 || bytes.length > MAX_SNAPSHOT_BYTES) {
      throw this.durableError('durable checkpoint exceeds the per-Session byte limit')
    }
    const header = Buffer.from(JSON.stringify({
      magic: DURABLE_MAGIC,
      schemaVersion: this.durableVersion,
      checkpointBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }) + '\n', 'utf8')
    if (header.length < 2 || header.length > MAX_DURABLE_HEADER_BYTES) {
      throw this.durableError('durable checkpoint header is invalid')
    }
    return Buffer.concat([header, bytes], header.length + bytes.length)
  }

  private decodeDurableEnvelope(container: Buffer): Buffer {
    if (container.length < 2 || container.length > MAX_SNAPSHOT_BYTES + MAX_DURABLE_HEADER_BYTES) {
      throw this.durableError('durable checkpoint envelope size is invalid')
    }
    const newline = container.indexOf(0x0a)
    if (newline <= 0 || newline > MAX_DURABLE_HEADER_BYTES) {
      throw this.durableError('durable checkpoint header is malformed')
    }
    const headerBytes = container.subarray(0, newline)
    const headerText = headerBytes.toString('utf8')
    if (!Buffer.from(headerText, 'utf8').equals(headerBytes)) {
      throw this.durableError('durable checkpoint header is not valid UTF-8')
    }
    let header: Record<string, unknown>
    try {
      const parsed = JSON.parse(headerText) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object')
      header = parsed as Record<string, unknown>
    } catch {
      throw this.durableError('durable checkpoint header is malformed')
    }
    if (header.magic !== DURABLE_MAGIC) throw this.durableError('durable checkpoint magic mismatch')
    if (header.schemaVersion !== this.durableVersion) throw this.durableError('durable schema version mismatch')
    const declaredBytes = header.checkpointBytes
    if (
      typeof declaredBytes !== 'number'
      || !Number.isSafeInteger(declaredBytes)
      || declaredBytes < 1
      || declaredBytes > MAX_SNAPSHOT_BYTES
    ) {
      throw this.durableError('durable checkpoint byte count is invalid')
    }
    const payload = container.subarray(newline + 1)
    if (payload.length !== declaredBytes) throw this.durableError('durable checkpoint byte count mismatch')
    if (
      typeof header.sha256 !== 'string'
      || header.sha256 !== createHash('sha256').update(payload).digest('hex')
    ) {
      throw this.durableError('durable content hash mismatch')
    }
    return Buffer.from(payload)
  }

  /**
   * Scan the durable root for persisted generations (v2 envelopes, legacy v1
   * pairs, and stale temp files) and rebuild the byte accounting (Issue #89).
   * Accounting is size-based: validity is enforced at read time.
   */
  private rescanDurableRoot(): void {
    this.durableAccounting.clear()
    this.durableHashes.clear()
    this.durableFingerprints.clear()
    if (!this.durableRoot) return
    let entries: string[]
    try {
      entries = readdirSync(this.durableRoot)
    } catch {
      return
    }
    for (const name of entries) {
      const full = path.join(this.durableRoot, name)
      let info
      try {
        info = lstatSync(full)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (name.endsWith('.checkpoint.json.tmp-') || name.includes('.checkpoint.json.tmp-')) {
        // Interrupted publication leftovers are ours (exclusive temp naming).
        try { rmSync(full, { force: true }) } catch { /* best-effort */ }
        continue
      }
      if (name.endsWith('.checkpoint.json') || name.endsWith('.meta.json')) {
        const key = name.replace(/\.(checkpoint\.json|meta\.json)$/u, '')
        this.durableAccounting.set(key, (this.durableAccounting.get(key) ?? 0) + info.size)
      }
    }
  }

  private durableTotalBytes(): number {
    let total = 0
    for (const bytes of this.durableAccounting.values()) total += bytes
    return total
  }

  /** Publish one crash-consistent durable generation without blocking the Host event loop. */
  private async publishDurable(sessionKey: string, bytes: Buffer): Promise<{ published: boolean; reason?: string }> {
    if (!this.durableRoot) return { published: false }
    const key = this.durableFileKey(sessionKey)
    const target = this.durablePath(sessionKey, '.checkpoint.json')
    const legacyMeta = this.durablePath(sessionKey, '.meta.json')
    const contentHash = createHash('sha256').update(bytes).digest('hex')

    // Safe same-runtime content-addressed dedup. The hash alone is not enough:
    // confirm the committed file identity has not changed since it was last
    // validated/published, so an external replacement cannot be hidden by cache.
    const current = this.durableLstat(target, 'durable checkpoint')
    if (
      current?.isFile()
      && this.durableHashes.get(key) === contentHash
      && this.durableFingerprints.get(key) === this.durableFingerprint(current)
    ) {
      return { published: true }
    }

    const temp = target + '.tmp-' + randomBytes(16).toString('hex')
    const envelope = this.encodeDurableEnvelope(bytes)
    const oldTotal = this.durableAccounting.get(key) ?? 0
    if (this.durableTotalBytes() + (envelope.length - oldTotal) > MAX_SNAPSHOT_ROOT_BYTES) {
      return { published: false, reason: 'durable-root quota exceeded' }
    }
    let handle: Awaited<ReturnType<typeof openFile>> | undefined
    try {
      handle = await openFile(temp, 'wx', 0o600)
      await handle.writeFile(envelope)
      await handle.sync()
      await handle.close()
      handle = undefined
      await renameAsync(temp, target)
      try { await rmAsync(legacyMeta, { force: true }) } catch { /* best-effort migration cleanup */ }
      await this.syncDurableDirectory()
      const committed = this.durableLstat(target, 'durable checkpoint')
      if (!committed?.isFile()) throw this.durableError('durable checkpoint disappeared after publication')
      this.durableAccounting.set(key, envelope.length)
      this.durableHashes.set(key, contentHash)
      this.durableFingerprints.set(key, this.durableFingerprint(committed))
      return { published: true }
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch { /* best-effort close */ }
      }
      try { await rmAsync(temp, { force: true }) } catch { /* never expose temp paths */ }
      if (error instanceof RlmError) throw error
      throw this.durableError('durable checkpoint publication failed')
    }
  }
  /** Read a committed v2 envelope, with strict read-only compatibility for M10 v1 pairs. */
  private readDurable(sessionKey: string): Buffer | undefined {
    if (!this.durableRoot) return undefined
    const target = this.durablePath(sessionKey, '.checkpoint.json')
    const legacyMetaPath = this.durablePath(sessionKey, '.meta.json')
    const targetInfo = this.durableLstat(target, 'durable checkpoint')
    const legacyMetaInfo = this.durableLstat(legacyMetaPath, 'durable metadata')
    if (!targetInfo && !legacyMetaInfo) return undefined
    if (!targetInfo) throw this.durableError('durable checkpoint is incomplete')
    if (!targetInfo.isFile()) throw this.durableError('durable checkpoint is not a regular file')

    let container: Buffer
    try {
      container = readFileSync(target)
    } catch {
      throw this.durableError('durable checkpoint could not be read')
    }

    // New generations are self-describing and ignore any stale legacy sidecar.
    const newline = container.indexOf(0x0a)
    if (newline > 0 && newline <= MAX_DURABLE_HEADER_BYTES) {
      try {
        const candidate = JSON.parse(container.subarray(0, newline).toString('utf8')) as unknown
        if (
          typeof candidate === 'object'
          && candidate !== null
          && !Array.isArray(candidate)
          && (candidate as Record<string, unknown>).magic === DURABLE_MAGIC
        ) {
          const payload = this.decodeDurableEnvelope(container)
          this.rememberDurableGeneration(sessionKey, payload, targetInfo)
          return payload
        }
      } catch {
        if (!legacyMetaInfo) throw this.durableError('durable checkpoint header is malformed')
      }
    }

    // Legacy v1 pair: validate strictly, then migrate on the next successful publish.
    if (!legacyMetaInfo) throw this.durableError('durable checkpoint envelope is invalid')
    if (!legacyMetaInfo.isFile()) throw this.durableError('durable metadata is not a regular file')
    if (container.length < 1 || container.length > MAX_SNAPSHOT_BYTES) {
      throw this.durableError('legacy durable checkpoint size is invalid')
    }
    let meta: { schemaVersion?: unknown; bytes?: unknown; sha256?: unknown }
    try {
      const rawMeta = readFileSync(legacyMetaPath)
      if (rawMeta.length < 2 || rawMeta.length > MAX_DURABLE_HEADER_BYTES) {
        throw new Error('legacy metadata size')
      }
      meta = JSON.parse(rawMeta.toString('utf8')) as { schemaVersion?: unknown; bytes?: unknown; sha256?: unknown }
    } catch {
      throw this.durableError('legacy durable metadata is malformed')
    }
    if (meta.schemaVersion !== 1) throw this.durableError('durable schema version mismatch')
    if (meta.bytes !== undefined && meta.bytes !== container.length) {
      throw this.durableError('legacy durable byte count mismatch')
    }
    if (
      typeof meta.sha256 !== 'string'
      || meta.sha256 !== createHash('sha256').update(container).digest('hex')
    ) {
      throw this.durableError('durable content hash mismatch')
    }
    this.rememberDurableGeneration(sessionKey, container, targetInfo)
    return container
  }

  private dropDurable(sessionKey: string): void {
    if (!this.durableRoot) return
    rmSync(this.durablePath(sessionKey, '.checkpoint.json'), { force: true })
    rmSync(this.durablePath(sessionKey, '.meta.json'), { force: true })
    // Issue #89: reset releases the Session's persistent quota share.
    const key = this.durableFileKey(sessionKey)
    this.durableAccounting.delete(key)
    this.durableHashes.delete(key)
    this.durableFingerprints.delete(key)
  }

  private snapshotFor(sessionKey: string): { path: string; restore: boolean; maxBytes: number } | undefined {
    if (!this.checkpointRoot) return undefined
    const durable = this.readDurable(sessionKey)
    if (durable && !this.checkpoints.has(sessionKey)) {
      // Materialize a durable reference into the host-private path so the
      // existing M9 restore transport (chunked frames) can feed the kernel.
      writeFileSync(this.checkpointPath(sessionKey), durable)
      this.checkpoints.add(sessionKey)
    }
    let reservation = this.checkpointReservations.get(sessionKey)
    if (reservation === undefined) {
      // A Session already persisted durably is counted by its actual file bytes;
      // only sessions without a durable generation charge their reservation cap.
      const liveUsed = [...this.checkpointReservations.entries()]
        .reduce((total, [key, bytes]) => this.durableAccounting.has(this.durableFileKey(key)) ? total : total + bytes, 0)
      const used = this.durableTotalBytes() + liveUsed
      reservation = Math.min(MAX_SNAPSHOT_BYTES, Math.max(0, MAX_SNAPSHOT_ROOT_BYTES - used))
      this.checkpointReservations.set(sessionKey, reservation)
    }
    return { path: this.checkpointPath(sessionKey), restore: this.checkpoints.has(sessionKey), maxBytes: reservation }
  }

  private checkpointPath(sessionKey: string): string {
    return path.join(this.checkpointRoot!, createHash('sha256').update(sessionKey).digest('hex') + '.json')
  }

  private dropCheckpoint(sessionKey: string): void {
    this.checkpoints.delete(sessionKey)
    this.checkpointReservations.delete(sessionKey)
    if (this.checkpointRoot) rmSync(this.checkpointPath(sessionKey), { force: true })
  }

  private readService<T>(name: string): T | undefined {
    const accessor = this.ctx as unknown as { get?: (key: string) => unknown } | undefined
    return accessor?.get?.(name) as T | undefined
  }

  /**
   * Resolve exactly one kernel launch per Session kernel start (M9).
   * 'off' keeps the legacy trusted spawn. 'auto' falls back to legacy only
   * when the DSH sandbox services are absent; 'require' fails closed. A
   * present sandbox that cannot confine always fails closed for both.
   */
  private resolveKernelLaunch(session?: unknown): KernelLaunch | undefined {
    const mode = this.config.kernelSandbox ?? 'auto'
    if (mode === 'off') return undefined
    const provider = this.readService<SandboxProvider>('sandbox')
    const policyService = this.readService<SandboxPolicyService>('sandboxPolicy')
    if (!provider || !policyService) {
      if (mode === 'require') {
        throw new RlmError('sandbox', 'kernelSandbox=require but no DSH sandbox services are available')
      }
      return undefined
    }
    const policy = policyService.resolve(session === undefined ? {} : { session })
    if (policy.mode === 'danger-full-access') {
      // The upstream consumer contract bypasses confine() entirely for the
      // unrestricted mode. The Session workspace identity is still preserved
      // (Issue #87): the kernel starts in policy.workspaceRoot with the plain
      // interpreter argv, and the M9 chunked checkpoint transport stays off
      // because the launch is not confined.
      return {
        argv: [this.config.python ?? 'python', KERNEL_PATH],
        cwd: policy.workspaceRoot,
        mode: policy.mode,
        enforcement: 'full',
        denialSignatures: [],
        runnerFailureRules: [],
        confined: false,
      }
    }
    let confined: SandboxConfined
    try {
      confined = provider.confine([this.config.python ?? 'python', KERNEL_PATH], policy)
    } catch (err) {
      throw new RlmError('sandbox', 'DSH sandbox cannot confine the kernel: ' + String(err))
    }
    return {
      argv: [...confined.argv],
      cwd: policy.workspaceRoot,
      mode: policy.mode,
      enforcement: confined.enforcement,
      denialSignatures: [...confined.denialSignatures],
      runnerFailureRules: [...confined.runnerFailureRules],
      confined: true,
    }
  }
  /**
   * Bounded idle-kernel retention (Issue #76): release ready kernels that have
   * been unused past the TTL. Active/queued cells are never evicted and a
   * later same-Session eval starts a fresh kernel (M5/M10 recovery is the
   * documented resume path).
   */
  private evictIdleKernels(): void {
    const ttl = this.config.kernelIdleTtlMs ?? IDLE_KERNEL_TTL_MS
    const now = Date.now()
    for (const [key, kernel] of [...this.kernels]) {
      if (!kernel.isIdle()) continue
      if ((this.kernelLastUse.get(key) ?? 0) + ttl > now) continue
      const queued = this.queues.get(key)
      if (queued !== undefined && queued.some((entry) => !entry.active)) continue
      this.kernels.delete(key)
      this.kernelLastUse.delete(key)
      void kernel.dispose({ keepCheckpoint: true })
    }
  }

  async eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput> {
    this.evictIdleKernels()
    // A pre-aborted signal never starts a session kernel and never queues work.
    if (input.signal?.aborted) {
      throw new RlmError('cancel', String(input.signal.reason ?? 'cancelled'))
    }
    // Dispose is terminal: reject without looking up, queueing, or starting anything.
    if (this.disposed) {
      throw new RlmError('closed', 'runtime is disposed')
    }
    if (isManualReset(input)) {
      if (input.code !== undefined || input.contextPath !== undefined || input.timeout !== undefined || input.onQuery !== undefined || input.onSpawn !== undefined || input.onFollowup !== undefined) {
        throw new RlmError('eval', 'reset input must not include code, contextPath, timeout, onQuery, onSpawn, or onFollowup')
      }
    } else if (typeof input.code !== 'string' || input.reset !== undefined) {
      throw new RlmError('eval', 'code input must contain code and must not include reset')
    }
    // One effective timeout is the total budget for the whole eval: it is frozen
    // at submission so startup, queue wait, and cell execution share one deadline.
    const budget = isManualReset(input)
      ? (this.config.timeout ?? DEFAULT_TIMEOUT)
      : (input.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT)
    const entry = this.enqueue(sessionKey, input, Date.now() + budget)
    void this.ensureDrain(sessionKey)
    return entry.promise
  }

  private enqueue(sessionKey: string, input: RlmEvalInput, deadline: number): QueuedEval {
    let resolve!: (out: RlmEvalOutput) => void
    let reject!: (err: RlmError) => void
    const promise = new Promise<RlmEvalOutput>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: QueuedEval = {
      sessionKey,
      input,
      deadline,
      signal: input.signal,
      onAbort: undefined,
      timer: undefined,
      settled: false,
      active: false,
      resolve,
      reject,
      promise,
    }
    const signal = input.signal
    if (signal) {
      const onAbort = (): void => this.cancelQueued(entry, String(signal.reason ?? 'cancelled'))
      entry.onAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
      // Close the race between the eval() pre-check and the listener
      // registration: an abort that landed in between must still settle as a
      // queued cancel, without enqueueing or starting anything.
      if (signal.aborted) {
        this.cancelQueued(entry, String(signal.reason ?? 'cancelled'))
        return entry
      }
    }
    // Budget already exhausted at submission: reject without queue or kernel.
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      this.settleEntry(entry, undefined, new RlmError('timeout', 'cell timed out before it could start'))
      return entry
    }
    // The queued-phase deadline timer settles ONLY this entry; once the entry
    // becomes active the Kernel owns the same deadline (remaining budget).
    entry.timer = setTimeout(() => this.expireQueued(entry), remaining)
    let queue = this.queues.get(sessionKey)
    if (!queue) {
      queue = []
      this.queues.set(sessionKey, queue)
    }
    queue.push(entry)
    return entry
  }

  /** Queued-phase abort: settles only this entry; the running kernel is untouched. */
  private cancelQueued(entry: QueuedEval, message: string): void {
    if (entry.settled || entry.active) return
    this.settleEntry(entry, undefined, new RlmError('cancel', message))
  }

  /** Queued-phase budget exhaustion: settles only this entry; no kernel action. */
  private expireQueued(entry: QueuedEval): void {
    if (entry.settled || entry.active) return
    this.settleEntry(entry, undefined, new RlmError('timeout', 'cell timed out before it could start'))
  }

  private settleEntry(entry: QueuedEval, out: RlmEvalOutput | undefined, err?: RlmError): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    const onAbort = entry.onAbort
    if (onAbort !== undefined) {
      entry.onAbort = undefined
      entry.signal?.removeEventListener('abort', onAbort)
    }
    this.removeQueued(entry)
    if (err !== undefined) entry.reject(err)
    else if (out !== undefined) entry.resolve(out)
  }

  private removeQueued(entry: QueuedEval): void {
    const queue = this.queues.get(entry.sessionKey)
    if (!queue) return
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(entry.sessionKey)
  }

  /** One drain worker per session; a new eval joins the running worker. */
  private ensureDrain(sessionKey: string): Promise<void> {
    let drain = this.drains.get(sessionKey)
    if (drain) return drain
    const loop = this.drainLoop(sessionKey)
    drain = loop.finally(() => {
      if (this.drains.get(sessionKey) !== drain) return
      this.drains.delete(sessionKey)
      // Lost-wakeup guard: an eval may have been enqueued after this worker
      // observed an empty queue but before this finally removed it from
      // `drains`; that eval attached to the about-to-finish worker. If
      // unsettled work remains, start a fresh worker (unless disposed).
      if (!this.disposed) {
        const queue = this.queues.get(sessionKey)
        if (queue && queue.some((entry) => !entry.settled)) {
          void this.ensureDrain(sessionKey)
        }
      }
    })
    this.drains.set(sessionKey, drain)
    return drain
  }

  private async drainLoop(sessionKey: string): Promise<void> {
    for (;;) {
      if (this.disposed) return
      const queue = this.queues.get(sessionKey)
      const entry = queue?.[0]
      if (!entry) return
      if (entry.settled) {
        this.removeQueued(entry)
        continue
      }
      if (entry.deadline - Date.now() <= 0) {
        this.settleEntry(entry, undefined, new RlmError('timeout', 'cell timed out before it could start'))
        continue
      }
      await this.runEntry(sessionKey, entry)
    }
  }

  /**
   * Run one dequeued entry. The queued-phase listener/timer are removed before
   * the entry becomes active; from here on the Kernel owns the caller signal and
   * the remaining deadline, and the outer promise settles only after the
   * Kernel's existing child-cleanup barrier completes.
   */
  private async runEntry(sessionKey: string, entry: QueuedEval): Promise<void> {
    entry.active = true
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    const onAbort = entry.onAbort
    if (onAbort !== undefined) {
      entry.onAbort = undefined
      entry.signal?.removeEventListener('abort', onAbort)
    }
    try {
      if (this.disposed || entry.settled) {
        if (!entry.settled) {
          this.settleEntry(entry, undefined, new RlmError('closed', 'runtime is disposed'))
        }
        return
      }
      if (entry.deadline - Date.now() <= 0) {
        this.settleEntry(entry, undefined, new RlmError('timeout', 'cell timed out before it could start'))
        return
      }
      if (isManualReset(entry.input)) {
        // Reset deliberately ignores an abort that arrives after dequeue. It
        // owns this FIFO position until the existing kernel cleanup barrier and
        // M5 checkpoint deletion have completed, so a later eval cannot overtake
        // deletion or revive pre-reset state.
        const kernel = this.kernels.get(sessionKey)
        if (kernel) {
          await kernel.dispose()
          if (this.kernels.get(sessionKey) === kernel) this.kernels.delete(sessionKey)
        }
        this.dropCheckpoint(sessionKey)
        this.dropDurable(sessionKey)
        this.settleEntry(entry, { stdout: '', result: 'RLM state reset', truncated: false })
        return
      }
      // Dequeue-time kernel capture: a fatal eviction (by identity) removes the
      // old kernel before the next dequeue, so an entry can never reuse a dead one.
      let kernel = this.kernels.get(sessionKey)
      if (!kernel) {
        const launch = this.resolveKernelLaunch((entry.input as { session?: unknown }).session)
        kernel = new Kernel(sessionKey, this.config, this.snapshotFor(sessionKey), launch)
        kernel.onExit = (exited) => {
          if (this.kernels.get(sessionKey) === kernel) this.kernels.delete(sessionKey)
          this.kernelLastUse.delete(sessionKey)
          if (!exited.keepsCheckpoint || !this.checkpoints.has(sessionKey)) this.dropCheckpoint(sessionKey)
        }
        this.kernels.set(sessionKey, kernel)
      }
      this.kernelLastUse.set(sessionKey, Date.now())
      const remaining = Math.max(0, entry.deadline - Date.now())
      await kernel.waitReady({
        timeout: remaining,
        ...(entry.input.signal ? { signal: entry.input.signal } : {}),
      })
      const out = await kernel.evalCell(entry.input, entry.deadline)
      const assembledCheckpoint = kernel.takeCommittedCheckpointPayload()
      if (out.recovery?.checkpointCommitted) {
        this.checkpoints.add(sessionKey)
        if (this.durableRoot && this.checkpointRoot) {
          const p = this.checkpointPath(sessionKey)
          if (existsSync(p)) {
            const payload = assembledCheckpoint ?? await readFileAsync(p)
            const durable = await this.publishDurable(sessionKey, payload)
            if (!durable.published && out.recovery) {
              out.recovery.durable = durable
            }
          }
        }
      }
      this.kernelLastUse.set(sessionKey, Date.now())
      this.settleEntry(entry, out)
    } catch (err) {
      if (entry.settled) return
      const rlmErr = err instanceof RlmError ? err : new RlmError('closed', String(err))
      if (rlmErr.kind === 'snapshot') this.dropCheckpoint(sessionKey)
      this.settleEntry(entry, undefined, rlmErr)
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    // Issue #86: disposal releases every per-Session job slot; later starts on
    // a disposed runtime still fail closed through eval.
    releaseRuntimeJobSlots(this)
    this.kernelLastUse.clear()
    // Terminal state synchronously: new evals reject immediately and drain
    // workers stop starting new work.
    this.disposed = true
    // Settle every not-yet-active queued entry at once; an active entry is
    // settled by its kernel.dispose() through the existing child cleanup barrier.
    for (const entry of [...this.queues.values()].flat()) {
      if (!entry.active) {
        this.settleEntry(entry, undefined, new RlmError('cancel', 'runtime disposed while queued'))
      }
    }
    this.queues.clear()
    const kernels = [...this.kernels.values()]
    const drainWait = Promise.all([...this.drains.values()])
    this.disposePromise = Promise.all([
      ...kernels.map((kernel) => kernel.dispose()),
      drainWait,
    ]).then(() => {
      this.kernels.clear()
      this.checkpoints.clear()
      this.checkpointReservations.clear()
      if (this.checkpointRoot) rmSync(this.checkpointRoot, { recursive: true, force: true })
    })
    return this.disposePromise
  }
}

/**
 * Create the plugin-internal RLM runtime. The runtime keys its Python kernels
 * by the session identity the caller supplies; the same session always reuses
 * one kernel and one globals namespace.
 */
export function createRlmRuntime(
  ctx: Context | undefined,
  config: RlmRuntimeConfig,
): RlmRuntime {
  return new RlmRuntimeImpl(config, ctx)
}

// ---- M1C/M1D: DSH tool registration and rlm_query -> one-shot Subagent bridge ----

/** The single non-recursive tool this plugin contributes. */
