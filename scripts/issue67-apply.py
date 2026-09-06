from pathlib import Path
import re

p = Path('src/runtime.ts')
text = p.read_text(encoding='utf-8')

old_import = "import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'\n"
new_import = old_import + "import { open as openFile, readFile as readFileAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises'\n"
if text.count(old_import) != 1:
    raise SystemExit('fs import anchor changed')
text = text.replace(old_import, new_import, 1)

old_props = "  private pendingChunks = new Map<number, { count: number; parts: Buffer[]; bytes: number }>()\n  private readonly maxSnapshotBytes: number\n"
new_props = "  private pendingChunks = new Map<number, { count: number; parts: Buffer[]; bytes: number }>()\n  /** Last host-assembled checkpoint bytes; consumed once by the Session runtime. */\n  private committedCheckpointPayload: Buffer | undefined\n  private readonly maxSnapshotBytes: number\n"
if text.count(old_props) != 1:
    raise SystemExit('Kernel property anchor changed')
text = text.replace(old_props, new_props, 1)

on_result_start = text.find('  private onResult(frame: Frame): void {')
on_result_end = text.find('\n  private onError(frame: Frame): void {', on_result_start)
if on_result_start < 0 or on_result_end < 0:
    raise SystemExit('onResult block changed')
new_on_result = r'''  /** Atomically commit one host-assembled M5 checkpoint without blocking the event loop. */
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
'''
text = text[:on_result_start] + new_on_result.rstrip() + text[on_result_end:]

build_start = text.find('  private buildRestoreFrames(): Frame[] {')
build_end = text.find('\n  async evalCell(', build_start)
if build_start < 0 or build_end < 0:
    raise SystemExit('buildRestoreFrames block changed')
build_block = text[build_start:build_end]
build_block = build_block.replace('private buildRestoreFrames(): Frame[]', 'private async buildRestoreFrames(): Promise<Frame[]>', 1)
build_block = build_block.replace('const payload = readFileSync(this.snapshotPath)', 'const payload = await readFileAsync(this.snapshotPath)', 1)
text = text[:build_start] + build_block + text[build_end:]
old_restore_call = 'if (chunked) restoreFrames = this.buildRestoreFrames()'
new_restore_call = 'if (chunked) restoreFrames = await this.buildRestoreFrames()'
if text.count(old_restore_call) != 1:
    raise SystemExit('restore frame call anchor changed')
text = text.replace(old_restore_call, new_restore_call, 1)

old_runtime_props = "  private readonly durableVersion = 2\n  private readonly durableAccounting = new Map<string, number>()\n"
new_runtime_props = "  private readonly durableVersion = 2\n  private readonly durableAccounting = new Map<string, number>()\n  /** Validated content hashes and file fingerprints used for safe same-runtime dedup. */\n  private readonly durableHashes = new Map<string, string>()\n  private readonly durableFingerprints = new Map<string, string>()\n"
if text.count(old_runtime_props) != 1:
    raise SystemExit('runtime durable property anchor changed')
text = text.replace(old_runtime_props, new_runtime_props, 1)

# Replace directory fsync with awaited FileHandle.sync().
sync_start = text.find('  private syncDurableDirectory(): void {')
sync_end = text.find('\n  private encodeDurableEnvelope', sync_start)
if sync_start < 0 or sync_end < 0:
    raise SystemExit('syncDurableDirectory block changed')
new_sync = r'''  private async syncDurableDirectory(): Promise<void> {
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

  private durableFingerprint(info: ReturnType<typeof lstatSync>): string {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
  }

  private rememberDurableGeneration(sessionKey: string, payload: Buffer, info?: ReturnType<typeof lstatSync>): void {
    const key = this.durableFileKey(sessionKey)
    this.durableHashes.set(key, createHash('sha256').update(payload).digest('hex'))
    const current = info ?? this.durableLstat(this.durablePath(sessionKey, '.checkpoint.json'), 'durable checkpoint')
    if (current?.isFile()) this.durableFingerprints.set(key, this.durableFingerprint(current))
  }
'''
text = text[:sync_start] + new_sync.rstrip() + text[sync_end:]

# Ensure rescan invalidates memoized identities.
old_rescan = "  private rescanDurableRoot(): void {\n    this.durableAccounting.clear()\n"
new_rescan = "  private rescanDurableRoot(): void {\n    this.durableAccounting.clear()\n    this.durableHashes.clear()\n    this.durableFingerprints.clear()\n"
if text.count(old_rescan) != 1:
    raise SystemExit('rescan anchor changed')
text = text.replace(old_rescan, new_rescan, 1)

pub_start = text.find('  /** Publish one crash-consistent, host-private durable generation. */\n  private publishDurable(')
pub_end = text.find('\n  /** Read a committed v2 envelope', pub_start)
if pub_start < 0 or pub_end < 0:
    raise SystemExit('publishDurable block changed')
new_publish = r'''  /** Publish one crash-consistent durable generation without blocking the Host event loop. */
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
'''
text = text[:pub_start] + new_publish.rstrip() + text[pub_end:]

# Remember validated durable generations so unchanged post-restore cells can dedup.
v2_return = '          return this.decodeDurableEnvelope(container)'
v2_new = "          const payload = this.decodeDurableEnvelope(container)\n          this.rememberDurableGeneration(sessionKey, payload, targetInfo)\n          return payload"
if text.count(v2_return) != 1:
    raise SystemExit('v2 readDurable return anchor changed')
text = text.replace(v2_return, v2_new, 1)
legacy_return = '    return container\n  }\n\n  private dropDurable'
legacy_new = "    this.rememberDurableGeneration(sessionKey, container, targetInfo)\n    return container\n  }\n\n  private dropDurable"
if text.count(legacy_return) != 1:
    raise SystemExit('legacy readDurable return anchor changed')
text = text.replace(legacy_return, legacy_new, 1)

old_drop = "    this.durableAccounting.delete(this.durableFileKey(sessionKey))\n  }"
new_drop = "    const key = this.durableFileKey(sessionKey)\n    this.durableAccounting.delete(key)\n    this.durableHashes.delete(key)\n    this.durableFingerprints.delete(key)\n  }"
if text.count(old_drop) != 1:
    raise SystemExit('dropDurable anchor changed')
text = text.replace(old_drop, new_drop, 1)

# Reuse chunk-assembled bytes; direct-path fallback is asynchronous.
old_run = '''      const out = await kernel.evalCell(entry.input, entry.deadline)
      if (out.recovery?.checkpointCommitted) {
        this.checkpoints.add(sessionKey)
        if (this.durableRoot && this.checkpointRoot) {
          const p = this.checkpointPath(sessionKey)
          if (existsSync(p)) {
            const durable = this.publishDurable(sessionKey, readFileSync(p))
            if (!durable.published && out.recovery) {
              out.recovery.durable = durable
            }
          }
        }
      }'''
new_run = '''      const out = await kernel.evalCell(entry.input, entry.deadline)
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
      }'''
if text.count(old_run) != 1:
    raise SystemExit('runEntry durable block changed')
text = text.replace(old_run, new_run, 1)

p.write_text(text, encoding='utf-8')
Path('scripts/issue67-apply.py').unlink()
Path('.github/workflows/issue-67-apply.yml').unlink()
