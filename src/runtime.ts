import type { Context } from '@deepseek-ai/cordis'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentResult } from '@deepseek-ai/dsh-subagent'

const KERNEL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'python-runtime',
  'rlm_kernel.py',
)
const PROTOCOL_VERSION = 1
const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_STDOUT = 64 * 1024
const DEFAULT_MAX_RESULT = 64 * 1024
const DEFAULT_MAX_QUERIES = 16
const MAX_FRAME_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_QUERY_RESULT_BYTES = 64 * 1024
const STDERR_TRUNCATED_MARKER = ' [stderr truncated]'
const MAX_QUERY_ERROR_BYTES = 64 * 1024
const QUERY_ERROR_TRUNCATED_MARKER = ' [query error truncated]'

/**
 * Cap one query-error text field to a total of at most `limit` UTF-8 bytes
 * (the stable marker counts inside that budget). An over-limit field keeps a
 * code-point-safe prefix and appends the marker so truncation is observable.
 */
function capQueryErrorText(s: string, limit: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= limit) return { text: s, truncated: false }
  const markerBytes = byteLength(QUERY_ERROR_TRUNCATED_MARKER)
  const prefix = truncateUtf8(s, Math.max(0, limit - markerBytes))
  return { text: prefix + QUERY_ERROR_TRUNCATED_MARKER, truncated: true }
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Read one untrusted property without letting a throwing getter escape. */
function safeReadField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Non-throwing error text: message first, then String, then a fixed fallback. */
function safeErrorText(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.message
    return String(value)
  } catch {
    // fall through
  }
  try {
    return String(value)
  } catch {
    return 'query handler failed'
  }
}

/** Non-throwing detail text: strings as-is; JSON-native structure kept as JSON. */
function safeDetailText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text
  } catch {
    // fall through
  }
  try {
    return String(value)
  } catch {
    return '[unprintable detail]'
  }
}

/**
 * Format a typed runtime error for the model-facing tool failure. The total
 * UTF-8 size stays within one 64 KiB content budget: kind + message + the
 * optional bounded detail + an explicit `[truncated]` marker; when the budget
 * is exceeded the largest component is shrunk first (marker already counted).
 */
function formatToolError(error: RlmError): string {
  let message = error.message
  let detail = error.detailed ?? ''
  for (let attempt = 0; attempt < 64; attempt++) {
    const text =
      `rlm_eval failed (${error.kind}): ${message}`
      + (detail.length > 0 ? `\nDetail: ${detail}` : '')
      + (error.truncated ? '\n[truncated]' : '')
    if (byteLength(text) <= MAX_QUERY_ERROR_BYTES) return text
    if (detail.length > 0 && byteLength(detail) > byteLength(message)) {
      detail = truncateUtf8(detail, Math.max(0, Math.floor(byteLength(detail) / 2)))
    } else {
      message = truncateUtf8(message, Math.max(0, Math.floor(byteLength(message) / 2)))
    }
  }
  return `rlm_eval failed (${error.kind}): [error text truncated]`
}

/**
 * Truncate `s` to at most `limit` UTF-8 bytes without splitting a code point,
 * so no U+FFFD is ever introduced. It iterates code points and stops before
 * the first one that would cross the byte budget.
 */
function truncateUtf8(s: string, limit: number): string {
  if (byteLength(s) <= limit) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = byteLength(ch)
    if (bytes + b > limit) break
    out += ch
    bytes += b
  }
  return out
}

/**
 * Resolve the canonical Windows tree-kill tool. A bare `taskkill` name would
 * go through PATH, so a stripped PATH breaks cleanup and a planted CWD
 * `taskkill.exe` could hijack it; the absolute System32 path (with the CWD
 * search disabled at spawn time) is the pinned prime-agent reference's
 * hardening. Env is read lazily so tests can inject a bogus SystemRoot
 * without touching the global environment permanently.
 */
function resolveTaskkill(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export interface RlmRuntimeConfig {
  enabled?: boolean
  /** Python interpreter command. Defaults to the `python` on PATH. */
  python?: string
  /** Total timeout budget for one eval (startup handshake + cell execution). */
  timeout?: number
  /** Byte cap for a cell's captured stdout. */
  maxStdout?: number
  /** Byte cap for a cell's resulting expression text. */
  maxResult?: number
  /** Max number of rlm_query calls a single cell may make. */
  maxQueries?: number
}

export interface RlmEvalInput {
  /** Python source; top-level await is supported. */
  code: string
  /** Overrides the runtime's total timeout budget for this call (startup + cell). */
  timeout?: number
  /**
   * Resolves an rlm_query(prompt) issued by the active cell. The second
   * argument is this cell's own cancellation signal: it merges the caller's
   * `signal` with a per-cell AbortController, so every terminal transition of
   * the cell (timeout, cancel, protocol fault, kernel exit, dispose) cancels
   * and disposes the active one-shot child before the cell settles.
   */
  onQuery?: (prompt: string, signal: AbortSignal) => Promise<string>
  /**
   * Caller-owned cancellation. When it aborts, the owning session's kernel is
   * evicted and its process tree killed; the cell is rejected with
   * `RlmError kind='cancel'`. A pre-aborted signal never starts a kernel.
   */
  signal?: AbortSignal
}

export interface RlmEvalOutput {
  stdout: string
  result?: string
  truncated: boolean
}

export type RlmErrorKind =
  | 'spawn' // the Python process could not be started
  | 'closed' // the kernel exited before producing a terminal frame
  | 'timeout' // a cell exceeded its per-cell timeout
  | 'cancel' // the runtime was disposed while a cell was running
  | 'busy' // a cell was still running on the same kernel
  | 'eval' // the Python cell failed with a typed error
  | 'query' // an rlm_query call failed
  | 'protocol' // the kernel violated the protocol and was terminated

export class RlmError extends Error {
  readonly kind: RlmErrorKind
  readonly phase?: 'eval' | 'query'
  readonly detailed?: string
  /** True when the underlying error frame reported a truncation. */
  readonly truncated: boolean
  constructor(
    kind: RlmErrorKind,
    message: string,
    opts: { phase?: 'eval' | 'query'; detailed?: string; truncated?: boolean } = {},
  ) {
    super(message)
    this.name = 'RlmError'
    this.kind = kind
    if (opts.phase !== undefined) this.phase = opts.phase
    if (opts.detailed !== undefined) this.detailed = opts.detailed
    this.truncated = opts.truncated === true
  }
}

interface PendingEval {
  id: number
  maxStdout: number
  maxResult: number
  maxQueries: number
  timeout: number
  onQuery: ((prompt: string, signal: AbortSignal) => Promise<string>) | undefined
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

interface Frame {
  type: string
  [key: string]: unknown
}

/** One managed Python kernel process for a single session key. */
class Kernel {
  readonly key: string
  child: ChildProcess | null = null
  private config: Required<
    Pick<RlmRuntimeConfig, 'python' | 'timeout' | 'maxStdout' | 'maxResult' | 'maxQueries'>
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
  onExit: ((k: Kernel) => void) | null = null

  constructor(key: string, config: RlmRuntimeConfig) {
    this.key = key
    this.config = {
      python: config.python ?? 'python',
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxStdout: config.maxStdout ?? DEFAULT_MAX_STDOUT,
      maxResult: config.maxResult ?? DEFAULT_MAX_RESULT,
      maxQueries: config.maxQueries ?? DEFAULT_MAX_QUERIES,
    }
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
    }
    if (process.platform !== 'win32') opts.detached = true
    let child: ChildProcess
    try {
      child = spawn(this.config.python, [KERNEL_PATH], opts)
    } catch (err) {
      this.rejectReady(new RlmError('spawn', String(err)))
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
      this.handleExit(new RlmError('spawn', String(err)))
    })
    child.on('close', () => {
      let detail = this.stderr.trim()
      if (this.stderrTruncated) detail += STDERR_TRUNCATED_MARKER
      this.handleExit(new RlmError('closed', 'kernel exited', { detailed: detail }))
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
        try {
          // A rejection is untrusted: message/detail/detailed getters and
          // toString may throw, so every read goes through non-throwing
          // helpers. The cell must always get a typed query error rather than
          // an unhandled rejection with a hanging cell.
          const source = err instanceof Error ? err : undefined
          const rawMessage = safeErrorText(err)
          const detailRaw = safeReadField(source, 'detail') ?? safeReadField(source, 'detailed')
          const rawDetail = safeDetailText(detailRaw)
          const m = capQueryErrorText(rawMessage, MAX_QUERY_ERROR_BYTES)
          const d = capQueryErrorText(rawDetail, MAX_QUERY_ERROR_BYTES)
          let response: Frame = {
            type: 'error',
            id: qid,
            phase: 'query',
            kind: 'query_error',
            message: m.text,
          }
          if (d.text.length > 0) response.detail = d.text
          // Fit the real serialized wire budget for message then detail, so a
          // control-character error payload (budget-fine raw, sixfold when
          // serialized) is truncated here instead of protocol-killing the kernel.
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
          // Absolute last resort: never leave the cell hanging on a query.
          this.write({
            type: 'error',
            id: qid,
            phase: 'query',
            kind: 'query_error',
            message: 'query handler failed',
          })
        }
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

  private onResult(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'result frame for unknown cell'))
      return
    }
    this.clearTimer(p)
    this.detachAbort()
    this.pending = null
    // Block routing now; the public settle waits for child quiescence.
    this.settling = true
    const out: RlmEvalOutput = {
      stdout: String(frame.stdout ?? ''),
      truncated: frame.truncated === true,
    }
    if (typeof frame.result === 'string') out.result = frame.result
    if (!this.cellFinish) this.cellFinish = this.finishCell(p, out)
  }

  private onError(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'error frame for unknown cell'))
      return
    }
    this.clearTimer(p)
    this.detachAbort()
    this.pending = null
    // Block routing now; the public settle waits for child quiescence.
    this.settling = true
    const phase = frame.phase === 'query' ? 'query' : 'eval'
    const kind = phase === 'query' ? 'query' : 'eval'
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
    this.pending = null
    const err = new RlmError('cancel', message)
    this.exited = true
    this.settling = true
    this.kill()
    if (!this.cellFinish) this.cellFinish = this.finishCell(p, undefined, err)
  }

  private handleExit(err: RlmError): void {
    if (this.exited) return
    this.exited = true
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

  async evalCell(input: RlmEvalInput, deadline?: number): Promise<RlmEvalOutput> {
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
    }
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
      this.pending = null
      const err = new RlmError('timeout', 'cell timed out after ' + timeout + 'ms')
      this.exited = true
      this.settling = true
      this.kill()
      if (!this.cellFinish) this.cellFinish = this.finishCell(p, undefined, err)
    }, timeout)
    this.attachAbort(p)
    // A signal that was already aborted cancels the cell synchronously above;
    // only send the eval frame if this cell is still pending.
    if (this.pending !== p) return promise
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

  dispose(): Promise<void> {
    if (this.disposedPromise) return this.disposedPromise
    // Terminal state is set synchronously so no eval can enter after unload;
    // the awaitable barrier resolves only after the child cleanup barrier.
    this.disposed = true
    this.exited = true
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
}

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
}

class RlmRuntimeImpl implements RlmRuntime {
  private kernels = new Map<string, Kernel>()
  private config: RlmRuntimeConfig
  private disposed = false
  private disposePromise: Promise<void> | undefined
  constructor(config: RlmRuntimeConfig) {
    this.config = config
  }

  async eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput> {
    // A pre-aborted signal never starts a session kernel.
    if (input.signal?.aborted) {
      throw new RlmError('cancel', String(input.signal.reason ?? 'cancelled'))
    }
    // Dispose is terminal: reject without looking up or starting any kernel.
    if (this.disposed) {
      throw new RlmError('closed', 'runtime is disposed')
    }
    // One effective timeout is the total budget for the whole eval: it is taken
    // at the true entry so the synchronous kernel lookup/construction (spawn)
    // is already charged to the same deadline that waitReady and evalCell
    // consume; a slow startup can never stack a second full timeout.
    const budget = input.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT
    const deadline = Date.now() + budget
    let kernel = this.kernels.get(sessionKey)
    if (!kernel) {
      kernel = new Kernel(sessionKey, this.config)
      kernel.onExit = () => {
        if (this.kernels.get(sessionKey) === kernel) this.kernels.delete(sessionKey)
      }
      this.kernels.set(sessionKey, kernel)
    }
    await kernel.waitReady({
      timeout: Math.max(0, deadline - Date.now()),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    return kernel.evalCell(input, deadline)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    // Synchronously terminal: new evals reject immediately, even while the
    // child cleanup barriers still run.
    this.disposed = true
    const kernels = [...this.kernels.values()]
    this.disposePromise = Promise.all(kernels.map((kernel) => kernel.dispose())).then(() => {
      this.kernels.clear()
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
  _ctx: Context | undefined,
  config: RlmRuntimeConfig,
): RlmRuntime {
  return new RlmRuntimeImpl(config)
}

// ---- M1C/M1D: DSH tool registration and rlm_query -> one-shot Subagent bridge ----

/** The single non-recursive tool this plugin contributes. */
export const TOOL_NAME = 'rlm_eval'

/** Concatenate a subagent's final assistant text content into one string. */
function textOf(output: readonly { type: string; text?: unknown }[]): string {
  let out = ''
  for (const block of output) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Answer one `rlm_query(prompt)` by starting a fresh one-shot DSH Subagent.
 *
 * The child is spawned with a tool filter that removes `rlm_eval`, so a child
 * can never recurse into another RLM loop. The call is foreground: we wait for
 * the child's terminal result and always dispose it in `finally`. Only the
 * child's final assistant text crosses back to the Python cell.
 */
async function runQuery(
  ctx: Context,
  provider: string,
  parent: Agent,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const run: SubagentRun = await ctx.subagents.start(provider, {
    label: 'rlm query',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    toolFilter: { deny: [TOOL_NAME] },
  })
  try {
    const result: SubagentResult = await run.result
    if (result.stopReason !== 'completed') {
      const text = textOf(result.output)
      const suffix = text.length === 0 ? '' : ` (partial: ${text})`
      throw new Error(`rlm_query subagent ended with stop reason "${result.stopReason}"${suffix}`)
    }
    const text = textOf(result.output)
    if (text.length === 0) {
      throw new RlmError('query', 'rlm_query produced no visible text', { phase: 'query' })
    }
    return text
  } finally {
    await run.dispose()
  }
}

interface RlmEvalValue {
  stdout: string
  result?: string
  truncated: boolean
}

function renderValue(value: RlmEvalValue): string {
  const parts: string[] = []
  if (value.stdout) parts.push(value.stdout)
  if (value.result !== undefined) parts.push(value.result)
  if (parts.length === 0) parts.push('(no output)')
  let text = parts.join('\n')
  if (value.truncated) text += '\n[output truncated]'
  return text
}

/**
 * Register the single `rlm_eval` tool and bridge `rlm_query` to a one-shot
 * DSH Subagent. The runtime is created here and torn down with the calling
 * Cordis fiber, so no plugin-owned Python process survives plugin unload.
 */
export function registerRlmPlugin(
  ctx: Context,
  config: RlmRuntimeConfig & { provider?: string },
): void {
  if (config.enabled !== true) return
  const provider = config.provider ?? 'spawn'
  const runtime = createRlmRuntime(ctx, config)

  const disposeTool = ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Run one Python cell in the current session\'s persistent kernel and return its '
      + 'stdout and last-expression result. The cell may call `await rlm_query(prompt)`, '
      + 'which answers by delegating the prompt to a one-shot DSH Subagent and returns only '
      + 'its final text. The child session has no rlm_eval tool, so it cannot recurse.',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'Python source to run; top-level await and persistent globals are supported.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          result: { type: 'string' },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: RlmEvalValue) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args: { code: string }, exec): Promise<RlmEvalValue> {
      const parent = exec.agent
      if (!parent) {
        throw new Error('rlm_eval requires a calling agent (exec.agent was undefined)')
      }
      // The agent/session share one identity; this is the stable per-session key.
      const sessionKey = String(parent.id)
      let output: Awaited<ReturnType<typeof runtime.eval>>
      try {
        output = await runtime.eval(sessionKey, {
          code: args.code,
          signal: exec.signal,
          onQuery: async (prompt: string, cellSignal: AbortSignal) =>
            runQuery(ctx, provider, parent, prompt, cellSignal),
        })
      } catch (error) {
        // Surface the typed runtime error as a normal tool failure so the model
        // sees a useful, bounded message (the registry marks the call isError).
        if (error instanceof RlmError) {
          const toolError = new Error(formatToolError(error))
          // Keep the typed taxonomy visible on the model-facing tool failure:
          // query-phase failures must remain kind=query / phase=query, not only
          // a message prefix, per the Issue #4 contract.
          Object.assign(toolError, { kind: error.kind, phase: error.phase })
          throw toolError
        }
        throw error
      }
      const value: RlmEvalValue = { stdout: output.stdout, truncated: output.truncated }
      if (output.result !== undefined) value.result = output.result
      return value
    },
  }))

  // Tear down the runtime and unregister the tool whenever the plugin's fiber
  // unloads, so no plugin-owned Python process survives the plugin.
  ctx.effect(() => () => {
    disposeTool()
    return runtime.dispose()
  }, 'rlm runtime teardown')
}
