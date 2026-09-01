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

export interface RlmRuntimeConfig {
  enabled?: boolean
  /** Python interpreter command. Defaults to the `python` on PATH. */
  python?: string
  /** Per-cell total timeout in milliseconds. */
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
  /** Overrides the runtime's per-cell timeout for this call. */
  timeout?: number
  /** Resolves an rlm_query(prompt) issued by the active cell. */
  onQuery?: (prompt: string) => Promise<string>
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
  constructor(
    kind: RlmErrorKind,
    message: string,
    opts: { phase?: 'eval' | 'query'; detailed?: string } = {},
  ) {
    super(message)
    this.name = 'RlmError'
    this.kind = kind
    if (opts.phase !== undefined) this.phase = opts.phase
    if (opts.detailed !== undefined) this.detailed = opts.detailed
  }
}

interface PendingEval {
  id: number
  maxStdout: number
  maxResult: number
  maxQueries: number
  timeout: number
  onQuery: ((prompt: string) => Promise<string>) | undefined
  queries: number
  timer: ReturnType<typeof setTimeout> | undefined
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
  private ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (err: RlmError) => void
  private readyDone = false
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
      this.stderr += d
    })
    child.on('error', (err) => {
      this.handleExit(new RlmError('spawn', String(err)))
    })
    child.on('close', () => {
      const detail = this.stderr.trim()
      this.handleExit(new RlmError('closed', 'kernel exited', { detailed: detail }))
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      this.onFrame(this.parse(line))
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
          this.readyDone = true
          this.rejectReady(
            new RlmError('protocol', 'unsupported kernel protocol version: ' + String(frame.version)),
          )
          this.kill()
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
    Promise.resolve()
      .then(() => onQuery(String(frame.prompt ?? '')))
      .then((text) => {
        if (this.exited || this.disposed) return
        this.write({ type: 'query_result', id: qid, text: String(text) })
      })
      .catch((err) => {
        if (this.exited || this.disposed) return
        const message = err instanceof Error ? err.message : String(err)
        this.write({
          type: 'error',
          id: qid,
          phase: 'query',
          kind: 'query_error',
          message,
        })
      })
  }

  private onResult(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'result frame for unknown cell'))
      return
    }
    this.clearTimer(p)
    this.pending = null
    const out: RlmEvalOutput = {
      stdout: String(frame.stdout ?? ''),
      truncated: frame.truncated === true,
    }
    if (typeof frame.result === 'string') out.result = frame.result
    p.resolve(out)
  }

  private onError(frame: Frame): void {
    const p = this.pending
    if (!p || frame.id !== p.id) {
      this.handleExit(new RlmError('protocol', 'error frame for unknown cell'))
      return
    }
    this.clearTimer(p)
    this.pending = null
    const phase = frame.phase === 'query' ? 'query' : 'eval'
    const kind = phase === 'query' ? 'query' : 'eval'
    const message = String(frame.message ?? 'kernel reported an error')
    p.reject(new RlmError(kind, message, { phase, detailed: String(frame.detail ?? '') }))
  }

  private clearTimer(p: PendingEval): void {
    if (p.timer !== undefined) clearTimeout(p.timer)
  }

  private handleExit(err: RlmError): void {
    if (this.exited) return
    this.exited = true
    if (!this.readyDone) {
      this.readyDone = true
      this.rejectReady(err)
    }
    const p = this.pending
    if (p) {
      this.clearTimer(p)
      this.pending = null
      p.reject(err)
    }
    this.onExit?.(this)
  }

  waitReady(): Promise<void> {
    return this.ready
  }

  async evalCell(input: RlmEvalInput): Promise<RlmEvalOutput> {
    await this.ready
    if (this.exited || this.disposed) {
      throw new RlmError('closed', 'kernel is not running')
    }
    if (this.pending) {
      throw new RlmError('busy', 'a cell is already running on this kernel')
    }
    const id = this.nextId++
    const timeout = input.timeout ?? this.config.timeout
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
      resolve,
      reject,
    }
    this.pending = p
    p.timer = setTimeout(() => {
      if (this.pending !== p) return
      this.clearTimer(p)
      this.pending = null
      const err = new RlmError('timeout', 'cell timed out after ' + timeout + 'ms')
      this.exited = true
      this.kill()
      this.onExit?.(this)
      reject(err)
    }, timeout)
    this.write({
      type: 'eval',
      id,
      code: input.code,
      max_stdout: p.maxStdout,
      max_result: p.maxResult,
    })
    return promise
  }

  private write(frame: Frame): void {
    if (this.exited || this.disposed) return
    const stdin = this.child?.stdin
    if (!stdin) return
    try {
      stdin.write(JSON.stringify(frame) + '\n')
    } catch {
      // The process may have died concurrently; the close handler reports it.
    }
  }

  private kill(): void {
    const child = this.child
    if (!child || child.pid == null) {
      if (child && !child.killed) child.kill()
      return
    }
    const pid = child.pid
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const p = this.pending
    if (p) {
      this.clearTimer(p)
      this.pending = null
      p.reject(new RlmError('cancel', 'runtime disposed while a cell was running'))
    }
    this.kill()
    this.onExit?.(this)
  }
}

export interface RlmRuntime {
  /**
   * Run one Python cell for a session key, reusing that session's kernel when
   * one already exists and starting a fresh process on its first use.
   */
  eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput>
  /** Terminate every owned Python process and release all session kernels. */
  dispose(): void
}

class RlmRuntimeImpl implements RlmRuntime {
  private kernels = new Map<string, Kernel>()
  private config: RlmRuntimeConfig
  constructor(config: RlmRuntimeConfig) {
    this.config = config
  }

  async eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput> {
    let kernel = this.kernels.get(sessionKey)
    if (!kernel) {
      kernel = new Kernel(sessionKey, this.config)
      kernel.onExit = () => {
        if (this.kernels.get(sessionKey) === kernel) this.kernels.delete(sessionKey)
      }
      this.kernels.set(sessionKey, kernel)
    }
    await kernel.waitReady()
    return kernel.evalCell(input)
  }

  dispose(): void {
    for (const kernel of this.kernels.values()) kernel.dispose()
    this.kernels.clear()
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
    return textOf(result.output)
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
          onQuery: async (prompt: string) => runQuery(ctx, provider, parent, prompt, exec.signal),
        })
      } catch (error) {
        // Surface the typed runtime error as a normal tool failure so the model
        // sees a useful, bounded message (the registry marks the call isError).
        if (error instanceof RlmError) {
          throw new Error(`rlm_eval failed (${error.kind}): ${error.message}`)
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
    runtime.dispose()
  }, 'rlm runtime teardown')
}
