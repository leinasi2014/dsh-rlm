/**
 * One Python kernel process per Session (Issue #84): launch/teardown, the
 * JSONL wire protocol, per-cell query/spawn/followup routing, and bounded
 * result/error framing. Private implementation boundary.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open as openFile, readFile as readFileAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  byteLength, capQueryErrorText, CHECKPOINT_BASE64_RE, CHECKPOINT_CHUNK_BYTES,
  DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_QUERIES, DEFAULT_MAX_RESULT, DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT,
  MAX_CHECKPOINT_CHUNK_BASE64_CHARS, MAX_CHECKPOINT_CHUNKS, MAX_FRAME_BYTES,
  MAX_QUERY_ERROR_BYTES, MAX_QUERY_RESULT_BYTES, MAX_SNAPSHOT_BYTES, MAX_STDERR_BYTES,
  RlmError, safeDetailText, safeErrorText, safeReadField, STDERR_TRUNCATED_MARKER, truncateUtf8,
  type RlmCodeEvalInput, type RlmEvalInput, type RlmEvalOutput, type RlmRuntimeConfig,
} from './model.ts'


export const KERNEL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'python-runtime',
  'rlm_kernel.py',
)
export const PROTOCOL_VERSION = 5
export interface SandboxPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

export interface SandboxConfined {
  argv: readonly string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly unknown[]
}

export interface SandboxPolicyService {
  resolve(request?: { session?: unknown }): SandboxPolicy
}

export interface SandboxProvider {
  confine(argv: readonly string[], policy: SandboxPolicy): SandboxConfined
}

export interface KernelLaunch {
  argv: string[]
  cwd: string
  mode: SandboxPolicy['mode']
  enforcement: string
  denialSignatures: readonly string[]
  runnerFailureRules: readonly unknown[]
  /**
   * True only for kernels launched through an enforced DSH sandbox
   * confinement. A `danger-full-access` launch shares the Session cwd but
   * stays on the legacy (non-chunked) M5 transport like an unconfined kernel.
   */
  confined: boolean
}

export const KERNEL_ENV_WIN32 = [
  'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'USERPROFILE', 'TEMP', 'TMP',
] as const

export const KERNEL_ENV_POSIX = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
] as const

export const KERNEL_ENV_PYTHON = [
  'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONUNBUFFERED', 'PYTHONPATH',
] as const

/**
 * Build the fixed safe environment for a Python kernel child (Issue #7). Only
 * allowlisted names may cross; the child never inherits the host environment.
 * Windows names are matched case-insensitively and emitted in the allowlist's
 * canonical casing; POSIX names are matched exactly and no `LC_*` wildcard is
 * applied (so a planted `LC_SECRET` cannot pass). Values absent in the host
 * are never synthesised, and no environment value is logged.
 */
export function collectKernelEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const canonical = new Map<string, string>()
    for (const name of [...KERNEL_ENV_WIN32, ...KERNEL_ENV_PYTHON]) {
      canonical.set(name.toUpperCase(), name)
    }
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue
      const match = canonical.get(name.toUpperCase())
      if (match !== undefined) env[match] = value
    }
  } else {
    for (const name of [...KERNEL_ENV_POSIX, ...KERNEL_ENV_PYTHON]) {
      const value = source[name]
      if (value !== undefined) env[name] = value
    }
  }
  return env
}


/**
 * Resolve the canonical Windows tree-kill tool. A bare `taskkill` name would
 * go through PATH, so a stripped PATH breaks cleanup and a planted CWD
 * `taskkill.exe` could hijack it; the absolute System32 path (with the CWD
 * search disabled at spawn time) is the pinned prime-agent reference's
 * hardening. Env is read lazily so tests can inject a bogus SystemRoot
 * without touching the global environment permanently.
 */
export function resolveTaskkill(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export interface PendingEval {
  id: number
  maxStdout: number
  maxResult: number
  maxQueries: number
  timeout: number
  onQuery: ((prompt: string, signal: AbortSignal) => Promise<string>) | undefined
  onSpawn: ((prompt: string, signal: AbortSignal) => Promise<string>) | undefined
  onFollowup: ((childId: string, prompt: string, signal: AbortSignal) => Promise<void>) | undefined
  queries: number
  timer: ReturnType<typeof setTimeout> | undefined
  signal: AbortSignal | undefined
  /** Per-cell cancel source: aborted by every terminal transition of this cell. */
  controller: AbortController
  /** In-flight one-shot child work of this cell (settles only after child dispose). */
  childWorks: Promise<unknown>[]
  resolve: (out: RlmEvalOutput) => void
  reject: (err: RlmError) => void
}

/** One queued same-session eval request; the runtime owns its lifecycle. */
export interface QueuedEval {
  sessionKey: string
  input: RlmEvalInput
  /** Total deadline frozen at eval() submission; queue wait consumes it. */
  deadline: number
  signal: AbortSignal | undefined
  /** Queued-phase abort listener; removed before the entry becomes active. */
  onAbort: (() => void) | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
  active: boolean
  resolve: (out: RlmEvalOutput) => void
  reject: (err: RlmError) => void
  promise: Promise<RlmEvalOutput>
}

export interface Frame {
  type: string
  [key: string]: unknown
}

/** One managed Python kernel process for a single session key. */
export class Kernel {
  readonly key: string
  child: ChildProcess | null = null
  private config: Required<
    Pick<RlmRuntimeConfig, 'python' | 'timeout' | 'maxStdout' | 'maxResult' | 'maxQueries' | 'maxContextBytes' | 'snapshotRecovery'>
  >
  private buf = ''
  private exited = false
  private disposed = false
  private pending: PendingEval | null = null
  private nextId = 1
  private stderr = ''
  private stderrTruncated = false
  private killStarted = false
  private ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (err: RlmError) => void
  private readyDone = false
  private abortBound: { signal: AbortSignal; onAbort: () => void } | null = null
  /** True once a terminal transition started; new evals are busy/closed until settled. */
  private settling = false
  /** The one in-flight terminal-transition completion (cleanup barrier + settle). */
  private cellFinish: Promise<void> | null = null
  /** True once the kernel was evicted from the session map (exactly once). */
  private evicted = false
  private disposedPromise: Promise<void> | undefined
  private readonly snapshotPath: string | undefined
  private readonly launch: KernelLaunch | undefined
  private restoreSnapshot: boolean
  private pendingChunks = new Map<number, { count: number; parts: Buffer[]; bytes: number }>()
  /** Last host-assembled checkpoint bytes; consumed once by the Session runtime. */
  private committedCheckpointPayload: Buffer | undefined
  private readonly maxSnapshotBytes: number
  private retainCheckpoint = true
  /** Kernel capability token -> official child id. Never sent back to Python. */
  private continuableChildren = new Map<string, string>()
  onExit: ((k: Kernel) => void) | null = null

  constructor(key: string, config: RlmRuntimeConfig, snapshot?: { path: string; restore: boolean; maxBytes: number }, launch?: KernelLaunch) {
    this.key = key
    this.config = {
      python: config.python ?? 'python',
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxStdout: config.maxStdout ?? DEFAULT_MAX_STDOUT,
      maxResult: config.maxResult ?? DEFAULT_MAX_RESULT,
      maxQueries: config.maxQueries ?? DEFAULT_MAX_QUERIES,
      maxContextBytes: config.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
      snapshotRecovery: config.snapshotRecovery ?? false,
    }
    this.snapshotPath = snapshot?.path
    this.launch = launch
    this.restoreSnapshot = snapshot?.restore === true
    this.maxSnapshotBytes = snapshot?.maxBytes ?? 0
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.spawn()
  }

  private spawn(): void {
    const opts: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: collectKernelEnv(process.env, process.platform),
    }
    if (this.launch) {
      opts.cwd = this.launch.cwd
      if (process.platform !== 'win32') opts.env!.TMPDIR = '/tmp'
    }
    if (process.platform !== 'win32') opts.detached = true
    let child: ChildProcess
    try {
      child = this.launch
        ? spawn(this.launch.argv[0]!, this.launch.argv.slice(1), opts)
        : spawn(this.config.python, [KERNEL_PATH], opts)
    } catch (err) {
      this.rejectReady(this.launch?.confined
        ? new RlmError('sandbox', 'sandboxed kernel launch failed: ' + String(err))
        : new RlmError('spawn', String(err)))
      return
    }
    this.child = child
    child.stdin?.on('error', () => {})
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.onData(d))
    child.stderr?.on('data', (d: string) => {
      // Keep the truncation marker inside the 64 KiB stderr budget: reserve
      // its bytes up front, so detailed (prefix + marker) always fits and the
      // marker stays observable. After truncation no further bytes accumulate.
      if (this.stderrTruncated) return
      const budget = MAX_STDERR_BYTES - byteLength(STDERR_TRUNCATED_MARKER)
      const combined = this.stderr + d
      if (byteLength(combined) > budget) {
        this.stderrTruncated = true
        this.stderr = truncateUtf8(combined, budget)
      } else {
        this.stderr = combined
      }
    })
    child.on('error', (err) => {
      this.handleExit(this.launch?.confined && !this.readyDone
        ? new RlmError('sandbox', 'sandbox runner failed: ' + String(err))
        : new RlmError('spawn', String(err)))
    })
    child.on('close', () => {
      let detail = this.stderr.trim()
      if (this.stderrTruncated) detail += STDERR_TRUNCATED_MARKER
      this.handleExit(this.launch?.confined && !this.readyDone
        ? new RlmError('sandbox', 'sandbox runner exited before the kernel became ready', { detailed: detail })
        : new RlmError('closed', 'kernel exited', { detailed: detail }))
    })
  }

  private onData(chunk: string): void {
    if (this.exited || this.disposed) return
    this.buf += chunk
    let i: number
    while (!this.exited && (i = this.buf.indexOf('\n')) >= 0) {
      // Count the UNTRIMMED raw line (bytes before the LF, including any CR or
      // trailing whitespace) plus the LF terminator. Trim only after the cap
      // check, so a whitespace/CR-padded oversized raw line is a protocol
      // fault instead of being accepted on its trimmed JSON.
      const rawLine = this.buf.slice(0, i)
      if (byteLength(rawLine) + 1 > MAX_FRAME_BYTES) {
        this.handleExit(new RlmError('protocol', 'kernel frame exceeds 256 KiB'))
        return
      }
      this.buf = this.buf.slice(i + 1)
      const line = rawLine.trim()
      if (!line) continue
      this.onFrame(this.parse(line))
    }
    if (this.exited || this.disposed) return
    // The remaining buffer has no newline; if it can no longer fit the 256 KiB
    // budget even after a newline, it is an oversized no-newline giant frame.
    if (byteLength(this.buf) + 1 > MAX_FRAME_BYTES) {
      this.handleExit(new RlmError('protocol', 'kernel frame exceeds 256 KiB without newline'))
    }
  }

  private parse(line: string): Frame | null {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.handleExit(new RlmError('protocol', 'invalid JSON frame from kernel'))
      return null
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      this.handleExit(new RlmError('protocol', 'kernel frame is not an object'))
      return null
    }
    return frame as Frame
  }

  private onFrame(frame: Frame | null): void {
    if (!frame) return
    switch (frame.type) {
      case 'ready': {
        if (frame.version !== PROTOCOL_VERSION) {
          // A wrong protocol version is a startup protocol fault: route it
          // through the single terminal transition so the process tree is
          // killed, the kernel is evicted, and waiters settle exactly once.
          this.handleExit(
            new RlmError('protocol', 'unsupported kernel protocol version: ' + String(frame.version)),
          )
          return
        }
        this.readyDone = true
        this.resolveReady()
        return
      }
      case 'query':
        this.onQuery(frame)
        return
      case 'spawn':
        this.onSpawn(frame)
        return
      case 'followup':
        this.onFollowup(frame)
        return
      case 'checkpoint_chunk': {
        const p = this.pending
        const id = frame.id
        const seq = frame.seq
        const count = frame.count
        const data = frame.data
        if (
          !p
          || !this.config.snapshotRecovery
          || !this.snapshotPath
          || this.launch?.confined !== true
          || typeof id !== 'number'
          || typeof seq !== 'number'
          || typeof count !== 'number'
          || !Number.isSafeInteger(id)
          || !Number.isSafeInteger(seq)
          || !Number.isSafeInteger(count)
          || id !== p.id
          || frame.encoding !== 'base64'
          || typeof data !== 'string'
        ) {
          this.handleExit(new RlmError('protocol', 'malformed checkpoint_chunk frame'))
          return
        }
        const maxCount = Math.min(
          MAX_CHECKPOINT_CHUNKS,
          Math.max(0, Math.ceil(this.maxSnapshotBytes / CHECKPOINT_CHUNK_BYTES)),
        )
        if (count < 1 || count > maxCount || seq < 0 || seq >= count) {
          this.handleExit(new RlmError('protocol', 'checkpoint_chunk sequence is out of range'))
          return
        }
        if (
          data.length === 0
          || data.length > MAX_CHECKPOINT_CHUNK_BASE64_CHARS
          || data.length % 4 !== 0
          || !CHECKPOINT_BASE64_RE.test(data)
        ) {
          this.handleExit(new RlmError('protocol', 'checkpoint_chunk base64 is invalid'))
          return
        }
        const decoded = Buffer.from(data, 'base64')
        if (
          decoded.length < 1
          || decoded.length > CHECKPOINT_CHUNK_BYTES
          || decoded.toString('base64') !== data
          || (seq < count - 1 && decoded.length !== CHECKPOINT_CHUNK_BYTES)
        ) {
          this.handleExit(new RlmError('protocol', 'checkpoint_chunk decoded bytes are invalid'))
          return
        }
        const acc = this.pendingChunks.get(id) ?? { count, parts: [], bytes: 0 }
        if (acc.count !== count || seq !== acc.parts.length) {
          this.handleExit(new RlmError('protocol', 'checkpoint_chunk is duplicate, reordered, or count-mismatched'))
          return
        }
        const aggregate = acc.bytes + decoded.length
        if (aggregate > this.maxSnapshotBytes || aggregate > MAX_SNAPSHOT_BYTES) {
          this.handleExit(new RlmError('protocol', 'checkpoint_chunk aggregate exceeds snapshot limit'))
          return
        }
        acc.parts.push(decoded)
        acc.bytes = aggregate
        this.pendingChunks.set(id, acc)
        return
      }
      case 'result':
        this.onResult(frame)
        return
      case 'error':
        this.onError(frame)
        return
      default:
        this.handleExit(new RlmError('protocol', 'unexpected frame type: ' + String(frame.type)))
    }
  }

  private onQuery(frame: Frame): void {
    const p = this.pending
    if (!p) {
      this.handleExit(new RlmError('protocol', 'query frame with no active cell'))
      return
    }
    const qid = frame.id as number
    if (typeof qid !== 'number') {
      this.handleExit(new RlmError('protocol', 'query frame without a numeric id'))
      return
    }
    p.queries += 1
    if (p.queries > p.maxQueries) {
      this.write({
        type: 'error',
        id: qid,
        phase: 'query',
        kind: 'query_limit',
        message: 'query limit exceeded: ' + p.maxQueries + ' per cell',
      })
      return
    }
    const onQuery = p.onQuery
    if (!onQuery) {
      this.write({
        type: 'error',
        id: qid,
        phase: 'query',
        kind: 'query_unhandled',
        message: 'rlm_query called but no query handler is configured',
      })
      return
    }
    // One cell-bound child task: it settles only after the child run is
    // disposed (runQuery's finally), so every terminal path can use it as the
    // cleanup barrier. If the cell is already terminal, never start child work.
    const childWork: Promise<unknown> = Promise.resolve().then(() => {
      if (this.exited || this.disposed || this.pending !== p) return undefined
      return onQuery(String(frame.prompt ?? ''), this.childSignal(p))
    })
    p.childWorks.push(childWork)
    void childWork.then((text) => {
        if (text === undefined || this.exited || this.disposed || this.pending !== p) return
        const raw = String(text)
        // First the 64 KiB payload budget, then the real JSONL wire budget:
        // JSON.stringify inflates control characters sixfold, so a payload that
        // fits the content cap can still serialize past 256 KiB. The wire fit
        // is code-point safe and marks the frame truncated instead of letting
        // the central outbound guard protocol-kill the kernel.
        const payloadLimited = truncateUtf8(raw, MAX_QUERY_RESULT_BYTES)
        let response: Frame = { type: 'query_result', id: qid, text: payloadLimited }
        const payloadTruncated = byteLength(raw) > MAX_QUERY_RESULT_BYTES
        const fit = this.fitFrameTextField(response, 'text', true)
        response = { ...response, text: fit.text }
        if (payloadTruncated || fit.truncated) response.truncated = true
        this.write(response)
      })
      .catch((err) => {
        if (this.exited || this.disposed || this.pending !== p) return
        this.writeOperationError(qid, err)
      })
  }

  /** Return one bounded typed bridge failure to the active Python request. */
  private writeOperationError(id: number, err: unknown): void {
    try {
      const source = err instanceof Error ? err : undefined
      const rawMessage = safeErrorText(err)
      const detailRaw = safeReadField(source, 'detail') ?? safeReadField(source, 'detailed')
      const rawDetail = safeDetailText(detailRaw)
      const m = capQueryErrorText(rawMessage, MAX_QUERY_ERROR_BYTES)
      const d = capQueryErrorText(rawDetail, MAX_QUERY_ERROR_BYTES)
      let response: Frame = { type: 'error', id, phase: 'query', kind: 'query_error', message: m.text }
      if (d.text.length > 0) response.detail = d.text
      let truncated = m.truncated || d.truncated
      const fitMessage = this.fitFrameTextField(response, 'message', true)
      if (fitMessage.truncated) {
        response = { ...response, message: fitMessage.text }
        truncated = true
      }
      if (d.text.length > 0) {
        const fitDetail = this.fitFrameTextField(response, 'detail', true)
        if (fitDetail.truncated) {
          response = { ...response, detail: fitDetail.text }
          truncated = true
        }
      }
      if (truncated) response.truncated = true
      this.write(response)
    } catch {
      this.write({ type: 'error', id, phase: 'query', kind: 'query_error', message: 'query handler failed' })
    }
  }

  private onSpawn(frame: Frame): void {
    const p = this.pending
    const id = frame.id
    const capability = frame.capability
    if (!p || typeof id !== 'number' || typeof capability !== 'string' || capability.length === 0 || byteLength(capability) > MAX_QUERY_ERROR_BYTES) {
      this.handleExit(new RlmError('protocol', 'spawn frame without an active numeric request id and bounded capability'))
      return
    }
    if (this.continuableChildren.has(capability)) {
      this.writeOperationError(id, new Error('duplicate continuable child capability'))
      return
    }
    const onSpawn = p.onSpawn
    if (!onSpawn) {
      this.write({ type: 'error', id, phase: 'query', kind: 'query_unhandled', message: 'rlm_spawn called but no spawn handler is configured' })
      return
    }
    const work: Promise<string | undefined> = Promise.resolve().then(() => {
      if (this.exited || this.disposed || this.pending !== p) return undefined
      return onSpawn(String(frame.prompt ?? ''), this.childSignal(p))
    })
    p.childWorks.push(work)
    void work.then((childId) => {
      if (childId === undefined || this.exited || this.disposed || this.pending !== p) return
      if (childId.length === 0 || byteLength(childId) > MAX_QUERY_ERROR_BYTES) {
        this.writeOperationError(id, new Error('continuable child id is invalid'))
        return
      }
      // The durable official id stays exclusively in this host-local map.
      // Python sees only its opaque object and can send its capability token
      // back on a later follow-up frame.
      this.continuableChildren.set(capability, childId)
      this.write({ type: 'spawn_result', id })
    }).catch((err) => {
      if (this.exited || this.disposed || this.pending !== p) return
      this.writeOperationError(id, err)
    })
  }

  private onFollowup(frame: Frame): void {
    const p = this.pending
    const id = frame.id
    const capability = frame.capability
    if (!p || typeof id !== 'number' || typeof capability !== 'string' || capability.length === 0 || byteLength(capability) > MAX_QUERY_ERROR_BYTES) {
      this.handleExit(new RlmError('protocol', 'followup frame without an active numeric request id and bounded capability'))
      return
    }
    const onFollowup = p.onFollowup
    if (!onFollowup) {
      this.write({ type: 'error', id, phase: 'query', kind: 'query_unhandled', message: 'rlm_followup called but no follow-up handler is configured' })
      return
    }
    const childId = this.continuableChildren.get(capability)
    if (!childId) {
      this.writeOperationError(id, new Error('unknown or expired continuable child capability'))
      return
    }
    const work: Promise<void> = Promise.resolve().then(() => {
      if (this.exited || this.disposed || this.pending !== p) return undefined
      return onFollowup(childId, String(frame.prompt ?? ''), this.childSignal(p))
    })
    p.childWorks.push(work)
    void work.then(() => {
      if (this.exited || this.disposed || this.pending !== p) return
      this.write({ type: 'followup_result', id })
    }).catch((err) => {
      if (this.exited || this.disposed || this.pending !== p) return
      this.writeOperationError(id, err)
    })
  }

  /**
   * Merge the caller's signal with the cell's own cancel source for one child.
   */
  private childSignal(p: PendingEval): AbortSignal {
    const own = p.controller.signal
    if (!p.signal) return own
    return AbortSignal.any([own, p.signal])
  }

  /**
   * Cleanup barrier for one cell: abort the cell's child cancel source, then
   * wait for every in-flight child task to settle (each settles only after its
   * one-shot run was disposed). Every terminal path settles a cell only after
   * this barrier, so the tool Promise never resolves while a child still
   * consumes tokens.
   */
  private async settleChild(p: PendingEval): Promise<void> {
    p.controller.abort()
    if (p.childWorks.length > 0) {
      await Promise.allSettled(p.childWorks)
    }
  }

  /** Evict from the session map exactly once, only after child quiescence. */
  private evict(): void {
    if (this.evicted) return
    this.evicted = true
    this.onExit?.(this)
  }

  /**
   * Finish one cell terminal transition in the ordered shape
   * active -> settling -> (child cleanup barrier) -> settle -> evict.
   *
   * `this.pending` is cleared (and `settling` set) synchronously by the caller,
   * so routing and child publication are already blocked while this barrier
   * runs; only the public Promise settle and the session-map eviction wait for
   * child quiescence. The barrier never awaits a promise that contains this
   * cell's own write/handleExit chain, so no self-await deadlock is possible.
   */
  private async finishCell(p: PendingEval, out?: RlmEvalOutput, err?: RlmError): Promise<void> {
    try {
      await this.settleChild(p)
    } catch {
      // A cleanup failure must never override the terminal taxonomy.
    }
    if (err !== undefined) p.reject(err)
    else if (out !== undefined) p.resolve(out)
    this.settling = false
    this.cellFinish = null
    if (this.exited) this.evict()
  }

  /** Atomically commit one host-assembled M5 checkpoint without blocking the event loop. */
  private async commitCheckpointBuffer(payload: Buffer): Promise<void> {
    if (!this.snapshotPath) throw new Error('snapshot path is undefined')
    const temp = this.snapshotPath + '.tmp-' + randomBytes(16).toString('hex')
    let handle: Awaited<ReturnType<typeof openFile>> | undefined
    try {
      handle = await openFile(temp, 'wx', 0o600)
      await handle.writeFile(payload)
      await handle.sync()
      await handle.close()
      handle = undefined
      await renameAsync(temp, this.snapshotPath)
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch { /* best-effort close */ }
      }
      try { await rmAsync(temp, { force: true }) } catch { /* private temp cleanup */ }
      throw error
    }
  }

  /** Consume, at most once, the bytes already assembled for the latest chunked checkpoint. */
  takeCommittedCheckpointPayload(): Buffer | undefined {
    const payload = this.committedCheckpointPayload
    this.committedCheckpointPayload = undefined
    return payload
  }

  private async finishResult(
    p: PendingEval,
    out: RlmEvalOutput,
    recovery: Record<string, unknown> | undefined,
    checkpointBuffer: Buffer | undefined,
  ): Promise<void> {
    if (checkpointBuffer !== undefined && recovery !== undefined) {
      try {
        await this.commitCheckpointBuffer(checkpointBuffer)
        // Reuse exactly these validated bytes for M10 durable publication.
        this.committedCheckpointPayload = checkpointBuffer
      } catch {
        recovery.checkpoint_committed = false
        recovery.reason = 'host checkpoint write failed'
      }
    }
    if (recovery !== undefined) {
      out.recovery = {
        restored: recovery.restored === true,
        checkpointCommitted: recovery.checkpoint_committed === true,
      }
      if (typeof recovery.checkpoint_bytes === 'number') out.recovery.checkpointBytes = recovery.checkpoint_bytes
      if (Array.isArray(recovery.skipped)) out.recovery.skipped = recovery.skipped.filter((x): x is string => typeof x === 'string').slice(0, 64)
      if (typeof recovery.reason === 'string') out.recovery.reason = recovery.reason
    }
    await this.finishCell(p, out)
  }

  private onResult(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'result frame for unknown cell'))
      return
    }
    const recovery = typeof frame.recovery === 'object' && frame.recovery !== null && !Array.isArray(frame.recovery)
      ? (frame.recovery as Record<string, unknown>)
      : undefined
    const chunked = this.config.snapshotRecovery && this.snapshotPath !== undefined && this.launch?.confined === true
    const chunks = this.pendingChunks.get(p.id)
    const checkpointCommitted = recovery?.checkpoint_committed === true
    let checkpointBuffer: Buffer | undefined

    if (chunked && recovery === undefined) {
      this.handleExit(new RlmError('protocol', 'chunked result is missing recovery metadata'))
      return
    }
    if (!chunked && chunks !== undefined) {
      this.handleExit(new RlmError('protocol', 'checkpoint chunks arrived for a non-chunked cell'))
      return
    }
    if (chunked && checkpointCommitted) {
      const declaredBytes = recovery?.checkpoint_bytes
      if (
        !chunks
        || typeof declaredBytes !== 'number'
        || !Number.isSafeInteger(declaredBytes)
        || declaredBytes < 1
        || declaredBytes > this.maxSnapshotBytes
        || declaredBytes > MAX_SNAPSHOT_BYTES
        || chunks.bytes !== declaredBytes
        || chunks.parts.length !== chunks.count
        || chunks.count !== Math.max(1, Math.ceil(declaredBytes / CHECKPOINT_CHUNK_BYTES))
      ) {
        this.handleExit(new RlmError('protocol', 'checkpoint chunk sequence is incomplete or byte count mismatched'))
        return
      }
      checkpointBuffer = Buffer.concat(chunks.parts, chunks.bytes)
      try {
        const checkpointText = checkpointBuffer.toString('utf8')
        if (!Buffer.from(checkpointText, 'utf8').equals(checkpointBuffer)) {
          throw new Error('checkpoint is not canonical UTF-8')
        }
        const envelope = JSON.parse(checkpointText) as unknown
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
          throw new Error('checkpoint envelope is not an object')
        }
      } catch {
        this.handleExit(new RlmError('protocol', 'checkpoint payload is invalid before publication'))
        return
      }
    } else if (chunked && chunks !== undefined) {
      this.handleExit(new RlmError('protocol', 'checkpoint chunks were emitted without a committed checkpoint'))
      return
    }

    this.clearTimer(p)
    this.detachAbort()
    this.pending = null
    this.settling = true
    const out: RlmEvalOutput = {
      stdout: String(frame.stdout ?? ''),
      truncated: frame.truncated === true,
    }
    if (typeof frame.result === 'string') out.result = frame.result
    this.pendingChunks.delete(p.id)

    // The public eval Promise remains unsettled until the awaited checkpoint
    // commit and child cleanup barriers finish. Plugin disposal also reuses
    // this same cellFinish barrier.
    if (!this.cellFinish) this.cellFinish = this.finishResult(p, out, recovery, checkpointBuffer)
  }
  private onError(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'error frame for unknown cell'))
      return
    }
    this.clearTimer(p)
    this.detachAbort()
    this.pendingChunks.delete(p.id)
    this.pending = null
    // Block routing now; the public settle waits for child quiescence.
    this.settling = true
    const phase = frame.phase === 'query' || frame.phase === 'context' || frame.phase === 'snapshot' ? frame.phase : 'eval'
    const kind = phase === 'query' ? 'query' : phase === 'context' ? 'context' : phase === 'snapshot' ? 'snapshot' : 'eval'
    const message = safeErrorText(frame.message ?? 'kernel reported an error')
    if (!this.cellFinish) {
      this.cellFinish = this.finishCell(p, undefined, new RlmError(kind, message, {
        phase,
        detailed: safeDetailText(frame.detail),
        truncated: frame.truncated === true,
      }))
    }
  }

  private clearTimer(p: PendingEval): void {
    if (p.timer !== undefined) clearTimeout(p.timer)
  }

  /** Drop the pending cell's abort listener so a late signal cannot touch an idle kernel. */
  private detachAbort(): void {
    const bound = this.abortBound
    this.abortBound = null
    if (bound) bound.signal.removeEventListener('abort', bound.onAbort)
  }

  /**
   * Attach the caller's signal to the pending cell. A signal that is already
   * aborted cancels immediately; otherwise a single abort listener is bound and
   * torn down on every settle path.
   */
  private attachAbort(p: PendingEval): void {
    const signal = p.signal
    if (!signal) return
    const onAbort = (): void => this.cancelCell(p, String(signal.reason ?? 'cancelled'))
    if (signal.aborted) {
      this.cancelCell(p, String(signal.reason ?? 'cancelled'))
      return
    }
    this.abortBound = { signal, onAbort }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  /**
   * Active cancellation: evict the session kernel, kill its process tree, and
   * reject the running cell with `kind='cancel'`. Only settles while the cell
   * is still this kernel's pending eval, so a race with timeout/result/error
   * settles exactly once.
   */
  private cancelCell(p: PendingEval, message: string): void {
    if (this.pending !== p) return
    this.clearTimer(p)
    this.detachAbort()
    this.pendingChunks.delete(p.id)
    this.pending = null
    const err = new RlmError('cancel', message)
    this.retainCheckpoint = false
    this.exited = true
    this.continuableChildren.clear()
    this.settling = true
    this.kill()
    if (!this.cellFinish) this.cellFinish = this.finishCell(p, undefined, err)
  }

  private handleExit(err: RlmError): void {
    if (this.exited) return
    this.exited = true
    this.continuableChildren.clear()
    this.pendingChunks.clear()
    this.settling = true
    if (!this.readyDone) {
      this.readyDone = true
      this.rejectReady(err)
    }
    const p = this.pending
    if (p) {
      this.clearTimer(p)
      this.detachAbort()
      this.pending = null
      // Kill immediately (fatal), but defer eviction and the public settle
      // until the child cleanup barrier completes.
      this.kill()
      if (!this.cellFinish) this.cellFinish = this.finishCell(p, undefined, err)
      return
    }
    this.kill()
    if (this.cellFinish) return
    this.evict()
  }

  /**
   * Wait for the ready handshake under the eval's startup deadline and the
   * caller's abort signal. A deadline or abort here is a terminal kernel
   * fault: it goes through `handleExit`, so the process tree is killed, the
   * kernel evicted, and the waiter rejected exactly once.
   */
  waitReady(opts: { timeout: number; signal?: AbortSignal }): Promise<void> {
    if (this.exited || this.disposed) {
      return Promise.reject(new RlmError('closed', 'kernel is not running'))
    }
    if (this.readyDone) return this.ready
    let cleanup = (): void => {}
    // A local 'settled' guard makes the timer and the abort listener exact
    // once: the first path to settle clears the timer/listener and is the only
    // one allowed to drive `handleExit`, so a re-entrant or queued event
    // between `resolveReady` and the finally-cleaned window is a no-op.
    let settled = false
    const finish = (err: RlmError): void => {
      if (settled) return
      settled = true
      cleanup()
      this.handleExit(err)
    }
    const timer = setTimeout(() => {
      finish(new RlmError('timeout', 'kernel startup timed out after ' + opts.timeout + 'ms'))
    }, opts.timeout)
    cleanup = () => clearTimeout(timer)
    const signal = opts.signal
    if (signal) {
      if (signal.aborted) {
        finish(new RlmError('cancel', String(signal.reason ?? 'cancelled')))
        return this.ready
      }
      const onAbort = (): void => {
        finish(new RlmError('cancel', String(signal.reason ?? 'cancelled')))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const clearTimerOnly = cleanup
      cleanup = () => {
        clearTimerOnly()
        signal.removeEventListener('abort', onAbort)
      }
    }
    // The finally runs synchronously inside the ready settlement cascade
    // (before any further macrotask can deliver another timer/abort event), so
    // it marks the waiter settled and clears both handles on every path.
    return this.ready.finally(() => {
      settled = true
      cleanup()
    })
  }

  private async buildRestoreFrames(): Promise<Frame[]> {
    if (!this.snapshotPath || !existsSync(this.snapshotPath)) {
      throw new RlmError('snapshot', 'checkpoint file is missing before restore')
    }
    const payload = await readFileAsync(this.snapshotPath)
    const limit = Math.min(MAX_SNAPSHOT_BYTES, this.maxSnapshotBytes)
    if (payload.length < 1 || payload.length > limit) {
      throw new RlmError('snapshot', 'checkpoint file exceeds the restore byte limit')
    }
    const total = Math.ceil(payload.length / CHECKPOINT_CHUNK_BYTES)
    if (total < 1 || total > MAX_CHECKPOINT_CHUNKS) {
      throw new RlmError('snapshot', 'checkpoint file has an invalid restore chunk count')
    }
    const frames: Frame[] = []
    for (let seq = 0; seq < total; seq++) {
      const chunk = payload.subarray(
        seq * CHECKPOINT_CHUNK_BYTES,
        Math.min(payload.length, (seq + 1) * CHECKPOINT_CHUNK_BYTES),
      )
      frames.push({
        type: 'restore_chunk',
        id: 0,
        seq,
        total,
        encoding: 'base64',
        data: chunk.toString('base64'),
      })
    }
    frames.push({ type: 'restore_end', total, bytes: payload.length, encoding: 'base64' })
    for (const frame of frames) {
      if (this.outboundFrameBytes(frame) > MAX_FRAME_BYTES) {
        throw new RlmError('protocol', 'host restore frame exceeds 256 KiB')
      }
    }
    return frames
  }

  async evalCell(input: RlmCodeEvalInput, deadline?: number): Promise<RlmEvalOutput> {
    await this.ready
    if (this.exited || this.disposed) {
      throw new RlmError('closed', 'kernel is not running')
    }
    if (this.settling) {
      throw new RlmError('busy', 'a cell is still settling on this kernel')
    }
    if (this.pending) {
      throw new RlmError('busy', 'a cell is already running on this kernel')
    }
    const id = this.nextId++
    // The caller hands down the eval-entry deadline so startup and cell
    // execution consume one budget instead of two full timeouts back to back.
    const timeout = deadline === undefined
      ? input.timeout ?? this.config.timeout
      : Math.max(0, deadline - Date.now())
    // Pre-check the exact JSONL wire bytes of the eval frame BEFORE installing
    // the pending cell, timer, or abort listener, and before writing to stdin.
    // An over-size frame is a host-side protocol error: reject it without
    // touching the kernel so its PID and namespace are preserved.
    const evalFrame: Frame = {
      type: 'eval',
      id,
      code: input.code,
      max_stdout: this.config.maxStdout,
      max_result: this.config.maxResult,
      max_context_bytes: this.config.maxContextBytes,
    }
    if (this.launch) evalFrame.cwd = this.launch.cwd
    const chunked = this.config.snapshotRecovery && this.snapshotPath !== undefined && this.launch?.confined === true
    const restorePending = this.restoreSnapshot
    let restoreFrames: Frame[] = []
    if (this.config.snapshotRecovery && this.snapshotPath) {
      evalFrame.snapshot_recovery = true
      evalFrame.max_snapshot_bytes = this.maxSnapshotBytes
      if (chunked) evalFrame.snapshot_chunked = true
      else evalFrame.snapshot_path = this.snapshotPath
      if (restorePending) {
        evalFrame.restore_snapshot = true
        if (chunked) restoreFrames = await this.buildRestoreFrames()
      }
    }
    if (input.contextPath !== undefined) evalFrame.context_path = input.contextPath
    if (this.outboundFrameBytes(evalFrame) > MAX_FRAME_BYTES) {
      throw new RlmError('protocol', 'host frame exceeds 256 KiB')
    }
    let resolve!: (out: RlmEvalOutput) => void
    let reject!: (err: RlmError) => void
    const promise = new Promise<RlmEvalOutput>((res, rej) => {
      resolve = res
      reject = rej
    })
    const p: PendingEval = {
      id,
      maxStdout: this.config.maxStdout,
      maxResult: this.config.maxResult,
      maxQueries: this.config.maxQueries,
      timeout,
      onQuery: input.onQuery,
      onSpawn: input.onSpawn,
      onFollowup: input.onFollowup,
      queries: 0,
      timer: undefined,
      signal: input.signal,
      controller: new AbortController(),
      childWorks: [],
      resolve,
      reject,
    }
    this.pending = p
    p.timer = setTimeout(() => {
      if (this.pending !== p) return
      this.clearTimer(p)
      this.detachAbort()
      this.pendingChunks.delete(p.id)
      this.pending = null
      const err = new RlmError('timeout', 'cell timed out after ' + timeout + 'ms')
      this.exited = true
      this.settling = true
      this.kill()
      if (!this.cellFinish) this.cellFinish = this.finishCell(p, undefined, err)
    }, timeout)
    this.attachAbort(p)
    // A signal that was already aborted cancels the cell synchronously above;
    // only commit the one-shot restore after every host preflight passed
    // and this cell is still the admitted pending cell.
    if (this.pending !== p) return promise
    if (restorePending) {
      this.restoreSnapshot = false
      for (const frame of restoreFrames) this.write(frame)
    }
    this.write(evalFrame)
    return promise
  }

  /** Exact JSONL wire bytes for one Host→Python frame (JSON text + trailing '\n'). */
  private outboundFrameBytes(frame: Frame): number {
    return byteLength(JSON.stringify(frame)) + 1
  }

  /**
   * Shrink one string field of `frame` so the serialized JSONL frame (JSON
   * text + trailing '\n') fits MAX_FRAME_BYTES. JSON.stringify can inflate
   * control characters sixfold, so a payload under the 64 KiB content budget
   * can still serialize past 256 KiB; the search walks code-point prefixes so
   * a surrogate pair is never split and no U+FFFD is introduced. The caller
   * owns the `truncated` flag on the frame.
   */
  private fitFrameTextField(
    frame: Frame,
    key: string,
    reserveTruncatedFlag = false,
  ): { text: string; truncated: boolean } {
    const original = String(frame[key] ?? '')
    // A caller usually marks the frame truncated after fitting; reserve those
    // wire bytes now so adding the flag can never push the line back over the
    // budget through the central outbound guard.
    const reserved = reserveTruncatedFlag
      ? byteLength(JSON.stringify({ ...frame, truncated: true })) - byteLength(JSON.stringify(frame))
      : 0
    if (this.outboundFrameBytes(frame) + reserved <= MAX_FRAME_BYTES) {
      return { text: original, truncated: false }
    }
    const base = this.outboundFrameBytes({ ...frame, [key]: '' })
    const target = MAX_FRAME_BYTES - base - reserved
    if (target < 2) return { text: '', truncated: true }
    // JSON.stringify(s) includes the surrounding quotes; the incremental bytes
    // over the empty-string value are its "content bytes", monotone in the
    // code-point prefix length.
    const contentBytes = (s: string): number => byteLength(JSON.stringify(s)) - 2
    const points = Array.from(original)
    let lo = 0
    let hi = points.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (contentBytes(points.slice(0, mid).join('')) <= target) lo = mid
      else hi = mid - 1
    }
    const text = points.slice(0, lo).join('')
    return { text, truncated: lo < points.length }
  }

  private write(frame: Frame): void {
    if (this.exited || this.disposed) return
    const stdin = this.child?.stdin
    if (!stdin) return
    // Central outbound guard: every Host→Python frame must fit the 256 KiB
    // wire line budget. The eval path pre-checks and rejects without eviction;
    // any other unexpectedly oversized frame is a terminal protocol fault.
    if (this.outboundFrameBytes(frame) > MAX_FRAME_BYTES) {
      this.handleExit(new RlmError('protocol', 'host frame exceeds 256 KiB'))
      return
    }
    try {
      stdin.write(JSON.stringify(frame) + '\n')
    } catch {
      // The process may have died concurrently; the close handler reports it.
    }
  }

  private kill(): void {
    // Every terminal path calls kill; one attempt per kernel is enough, so
    // repeated calls cannot stack taskkill spawns or redundant signals.
    if (this.killStarted) return
    this.killStarted = true
    const child = this.child
    if (!child || child.pid == null) {
      if (child && !child.killed) child.kill()
      return
    }
    const pid = child.pid
    if (process.platform === 'win32') {
      this.killWin32(child, pid)
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Windows tree kill: absolute System32 taskkill `/T /F` with the CWD search
   * disabled (a bare PATH name can resolve a planted `taskkill.exe`). The
   * async `error` must be listened because Windows reports a missing command
   * after `spawn` returns; an unlistened error would crash the host. Any
   * startup failure or non-zero close falls back to killing the direct child,
   * so a terminal transition always settles.
   */
  private killWin32(child: ChildProcess, pid: number): void {
    let fellBack = false
    const fallback = (): void => {
      if (fellBack) return
      fellBack = true
      try {
        child.kill()
      } catch {
        // ignore; the kernel's own close handler reports the final state
      }
    }
    let killer: ChildProcess
    try {
      killer = spawn(resolveTaskkill(), ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
      })
    } catch {
      fallback()
      return
    }
    killer.on('error', fallback)
    killer.on('close', (code) => {
      if (code !== 0) fallback()
    })
  }

  /** True when no cell is running or settling and the process is ready (Issue #76). */
  isIdle(): boolean {
    return this.readyDone && this.pending === null && !this.settling
  }

  dispose(options?: { keepCheckpoint?: boolean }): Promise<void> {
    if (this.disposedPromise) return this.disposedPromise
    // Terminal state is set synchronously so no eval can enter after unload;
    // the awaitable barrier resolves only after the child cleanup barrier.
    this.disposed = true
    // Idle eviction (Issue #76) keeps the committed M5 checkpoint so the next
    // same-Session eval resumes through the documented recovery path.
    if (options?.keepCheckpoint !== true) this.retainCheckpoint = false
    this.exited = true
    this.continuableChildren.clear()
    this.pendingChunks.clear()
    this.settling = true
    // A dispose during the ready handshake must settle the waiting eval; the
    // startup waiters share the ready promise, so rejecting it unblocks them.
    if (!this.readyDone) {
      this.readyDone = true
      this.rejectReady(new RlmError('cancel', 'runtime disposed while the kernel was starting'))
    }
    const p = this.pending
    if (p) {
      this.clearTimer(p)
      this.detachAbort()
      this.pending = null
    }
    this.kill()
    this.disposedPromise = p && !this.cellFinish
      ? this.finishCell(p, undefined, new RlmError('cancel', 'runtime disposed while a cell was running'))
      : (this.cellFinish ?? Promise.resolve().then(() => this.evict()))
    return this.disposedPromise
  }

  get keepsCheckpoint(): boolean { return this.retainCheckpoint }
}

