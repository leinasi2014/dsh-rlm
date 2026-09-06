from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, body: str, label: str) -> str:
    first = text.find(start)
    if first < 0 or text.find(start, first + 1) >= 0:
        raise SystemExit(f"{label}: start marker is missing or non-unique")
    last = text.find(end, first + len(start))
    if last < 0:
        raise SystemExit(f"{label}: end marker missing")
    return text[:first] + body + text[last:]


path = Path("src/runtime.ts")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import { createHash } from 'node:crypto'",
    "import { createHash, randomBytes } from 'node:crypto'",
    "crypto imports",
)
text = replace_once(
    text,
    "import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'",
    "import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'",
    "fs imports",
)
text = replace_once(
    text,
    "const MAX_SNAPSHOT_ROOT_BYTES = 64 * 1024 * 1024\n",
    """const MAX_SNAPSHOT_ROOT_BYTES = 64 * 1024 * 1024
const DURABLE_MAGIC = 'dsh-rlm-durable'
const MAX_DURABLE_HEADER_BYTES = 4 * 1024
""",
    "durable constants",
)
text = replace_once(text, "  private readonly durableVersion = 1", "  private readonly durableVersion = 2", "durable version")

durable_block = """  private durablePath(sessionKey: string, suffix: string): string {
    return path.join(this.durableRoot!, createHash('sha256').update(sessionKey).digest('hex') + suffix)
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

  private syncDurableDirectory(): void {
    if (!this.durableRoot || process.platform === 'win32') return
    let fd: number | undefined
    try {
      fd = openSync(this.durableRoot, 'r')
      fsyncSync(fd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
        throw this.durableError('durable directory fsync failed')
      }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best-effort close after fsync */ }
      }
    }
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

  /** Publish one crash-consistent, host-private durable generation. */
  private publishDurable(sessionKey: string, bytes: Buffer): void {
    if (!this.durableRoot) return
    const target = this.durablePath(sessionKey, '.checkpoint.json')
    const legacyMeta = this.durablePath(sessionKey, '.meta.json')
    const temp = target + '.tmp-' + randomBytes(16).toString('hex')
    const envelope = this.encodeDurableEnvelope(bytes)
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, envelope)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      // The prior committed target remains valid until this single rename.
      renameSync(temp, target)
      // A stale legacy sidecar is irrelevant once target is a v2 envelope.
      try { rmSync(legacyMeta, { force: true }) } catch { /* best-effort migration cleanup */ }
      this.syncDurableDirectory()
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best-effort close */ }
      }
      try { rmSync(temp, { force: true }) } catch { /* never follow or expose temp paths */ }
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
          return this.decodeDurableEnvelope(container)
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
    return container
  }

  private dropDurable(sessionKey: string): void {
    if (!this.durableRoot) return
    rmSync(this.durablePath(sessionKey, '.checkpoint.json'), { force: true })
    rmSync(this.durablePath(sessionKey, '.meta.json'), { force: true })
  }

"""
text = replace_between(
    text,
    "  private durablePath(sessionKey: string, suffix: string): string {",
    "  private snapshotFor(sessionKey: string):",
    durable_block,
    "durable implementation block",
)
path.write_text(text, encoding="utf-8")

# Update the old M10 version-mismatch regression to the new fail-closed v2 contract.
test_path = Path("tests/rlm-loop.test.ts")
test_text = test_path.read_text(encoding="utf-8")
old_start = "test('M10 Issue#44: a durable version mismatch fails closed without restoring stale state', async () => {"
next_start = "test('M12 Issue#48: registerRlmPlugin attaches the rlm job controller when jobs exist', async () => {"
new_test = """test('M10 Issue#44: a durable version mismatch fails closed without restoring stale state', async () => {
  const durable = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-ver-'))
  const runtime = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m10-ver', { code: 'x = 1' })
  } finally {
    await runtime.dispose()
  }
  const durableFile = path.join(durable, readdirSync(durable).find((f) => f.endsWith('.checkpoint.json'))!)
  const envelope = readFileSync(durableFile)
  const newline = envelope.indexOf(0x0a)
  assert.ok(newline > 0, 'v2 durable envelope must contain one bounded header line')
  const header = JSON.parse(envelope.subarray(0, newline).toString('utf8'))
  header.schemaVersion = 999
  writeFileSync(durableFile, Buffer.concat([
    Buffer.from(JSON.stringify(header) + '\n', 'utf8'),
    envelope.subarray(newline + 1),
  ]))
  const runtimeB = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true })
  try {
    await assert.rejects(
      runtimeB.eval('m10-ver', { code: 'y = 2' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'snapshot',
    )
  } finally {
    await runtimeB.dispose()
  }
})


"""
test_text = replace_between(test_text, old_start, next_start, new_test, "M10 version regression")
test_path.write_text(test_text, encoding="utf-8")

Path("scripts/issue-71-apply-durable-v2.py").unlink()
