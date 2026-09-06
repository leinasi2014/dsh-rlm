/**
 * Shared cross-milestone model for the dsh-rlm runtime (Issue #84): config
 * types/schema, cell and error contracts, wire limits, and protocol helpers.
 * Private implementation boundary; the public plugin entry stays small.
 */
import z from '@deepseek-ai/schemastery'
import { RLM_SETTINGS_MANIFEST, type RlmRuntimeTierASettings, type RlmSettingsSpec, type RlmTierASettings } from '../settings-manifest.ts'


/** The single non-recursive tool this plugin contributes. */
export const TOOL_NAME = 'rlm_eval'
export const DEFAULT_TIMEOUT = 30_000
export const DEFAULT_MAX_STDOUT = 64 * 1024
export const DEFAULT_MAX_RESULT = 64 * 1024
export const DEFAULT_MAX_QUERIES = 16
export const DEFAULT_MAX_CONTEXT_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_DEPTH = 1
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_SNAPSHOT_ROOT_BYTES = 64 * 1024 * 1024
export const IDLE_KERNEL_TTL_MS = 15 * 60 * 1000
export const DURABLE_MAGIC = 'dsh-rlm-durable'
export const MAX_DURABLE_HEADER_BYTES = 4 * 1024
export const MAX_FRAME_BYTES = 256 * 1024
export const CHECKPOINT_CHUNK_BYTES = 128 * 1024
export const MAX_CHECKPOINT_CHUNKS = Math.ceil(MAX_SNAPSHOT_BYTES / CHECKPOINT_CHUNK_BYTES)
export const MAX_CHECKPOINT_CHUNK_BASE64_CHARS = Math.ceil(CHECKPOINT_CHUNK_BYTES / 3) * 4
export const CHECKPOINT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export const MAX_STDERR_BYTES = 64 * 1024
export const MAX_QUERY_RESULT_BYTES = 64 * 1024
export const STDERR_TRUNCATED_MARKER = ' [stderr truncated]'
export const MAX_QUERY_ERROR_BYTES = 64 * 1024
export const QUERY_ERROR_TRUNCATED_MARKER = ' [query error truncated]'
/**
 * Official DSH host-prompt adapter key. In current DSH this is exported from
 * `@deepseek-ai/dsh-subagent/internal`; spelling the process-stable key here
 * keeps this external plugin compatible with the exact loaded host even when
 * its published type package is one release behind the checked source.
 */
export function capQueryErrorText(s: string, limit: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= limit) return { text: s, truncated: false }
  const markerBytes = byteLength(QUERY_ERROR_TRUNCATED_MARKER)
  const prefix = truncateUtf8(s, Math.max(0, limit - markerBytes))
  return { text: prefix + QUERY_ERROR_TRUNCATED_MARKER, truncated: true }
}

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Read one untrusted property without letting a throwing getter escape. */
export function safeReadField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Non-throwing error text: message first, then String, then a fixed fallback. */
export function safeErrorText(value: unknown): string {
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
export function safeDetailText(value: unknown): string {
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
export function formatToolError(error: RlmError): string {
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
export function truncateUtf8(s: string, limit: number): string {
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

// ---- Issue #7: fixed safe-name allowlist for the Python kernel env ----

export type RlmRuntimeConfig = RlmRuntimeTierASettings & {
  /**
   * Idle TTL before a ready kernel is released (Issue #76). Bounded
   * retention only; this runtime-only knob is intentionally absent
   * from the 14-field Tier-A settings manifest and GUI.
   */
  kernelIdleTtlMs?: number
}

/** Plugin-facing Tier-A settings plus the runtime-only idle TTL. */
export type RlmPluginConfig = RlmTierASettings & {
  kernelIdleTtlMs?: number
}

/** Build one Host Schemastery field from the environment-neutral manifest. */
export function schemaForSettingsSpec(spec: RlmSettingsSpec): z<unknown> {
  let schema: any
  switch (spec.kind) {
    case 'toggle':
      schema = z.boolean()
      break
    case 'text':
      schema = z.string()
      if ('hostMinLength' in spec && spec.hostMinLength !== undefined) schema = schema.min(spec.hostMinLength)
      break
    case 'number':
      schema = z.natural().min(spec.min).max(spec.max)
      break
    case 'select':
      schema = z.union(spec.options.map(option => z.const(option)) as any)
      break
  }
  if (spec.schemaDefault) schema = schema.default(spec.default)
  return schema.description(spec.description) as z<unknown>
}

export const CONFIG_SCHEMA_FIELDS = Object.fromEntries(
  RLM_SETTINGS_MANIFEST.map(spec => [spec.key, schemaForSettingsSpec(spec)]),
) as Record<string, z<unknown>>

/**
 * Single authoritative Config schema for the plugin. Field names,
 * defaults, ranges and enum choices come from RLM_SETTINGS_MANIFEST;
 * Tier-B live validation remains in settings.ts.
 */
export const ConfigSchema: z<RlmPluginConfig> = z.object(CONFIG_SCHEMA_FIELDS) as unknown as z<RlmPluginConfig>

export interface RlmEvalCommon {
  /**
   * Caller-owned cancellation. A pre-aborted signal never starts a kernel or
   * queues work. Once a reset becomes active it owns its cleanup barrier, so a
   * later abort cannot interrupt the deliberate deletion.
   */
  signal?: AbortSignal
}

export interface RlmCodeEvalInput extends RlmEvalCommon {
  /** Python source; top-level await is supported. */
  code: string
  /** Optional absolute UTF-8 regular file loaded by the session kernel. */
  contextPath?: string
  /** Internal: the official Session used to resolve the sandbox policy for this kernel. */
  session?: unknown
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
  /** Admit one official continuable child and return its host-private id. */
  onSpawn?: (prompt: string, signal: AbortSignal) => Promise<string>
  /** Admit one official FIFO follow-up for a host-private child id. */
  onFollowup?: (childId: string, prompt: string, signal: AbortSignal) => Promise<void>
  reset?: never
}

/** One explicit Session-local reset on the existing model-facing tool path. */
export interface RlmResetInput extends RlmEvalCommon {
  reset: true
  code?: never
  contextPath?: never
  timeout?: never
  onQuery?: never
  onSpawn?: never
  onFollowup?: never
}

export type RlmEvalInput = RlmCodeEvalInput | RlmResetInput

export function isManualReset(input: RlmEvalInput): input is RlmResetInput {
  return input.reset === true
}

export interface RlmEvalOutput {
  stdout: string
  result?: string
  truncated: boolean
  recovery?: {
    restored: boolean
    checkpointCommitted: boolean
    checkpointBytes?: number
    skipped?: string[]
    reason?: string
    /** M10 durable publication outcome (Issue #89): absent when published. */
    durable?: { published: boolean; reason?: string }
  }
}

export type RlmErrorKind =
  | 'spawn' // the Python process could not be started
  | 'closed' // the kernel exited before producing a terminal frame
  | 'timeout' // a cell exceeded its per-cell timeout
  | 'cancel' // the runtime was disposed while a cell was running
  | 'busy' // a cell was still running on the same kernel
  | 'eval' // the Python cell failed with a typed error
  | 'query' // an rlm_query call failed
  | 'context' // a managed context source was rejected atomically
  | 'snapshot' // a private M5 checkpoint failed closed
  | 'sandbox' // the DSH sandbox could not confine the kernel
  | 'protocol' // the kernel violated the protocol and was terminated

export class RlmError extends Error {
  readonly kind: RlmErrorKind
  readonly phase?: 'eval' | 'query' | 'context' | 'snapshot'
  readonly detailed?: string
  /** True when the underlying error frame reported a truncation. */
  readonly truncated: boolean
  constructor(
    kind: RlmErrorKind,
    message: string,
    opts: { phase?: 'eval' | 'query' | 'context' | 'snapshot'; detailed?: string; truncated?: boolean } = {},
  ) {
    super(message)
    this.name = 'RlmError'
    this.kind = kind
    if (opts.phase !== undefined) this.phase = opts.phase
    if (opts.detailed !== undefined) this.detailed = opts.detailed
    this.truncated = opts.truncated === true
  }
}

