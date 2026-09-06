/**
 * M4/M8/M11 bridge (Issue #84): one-shot Subagent queries, continuable
 * spawn/follow-up, the per-cell token guard, and the shared cell-input factory
 * used by both the foreground tool and M12 jobs. Private boundary.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf, type SubagentRun, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_MAX_DEPTH, RlmError, TOOL_NAME, type RlmCodeEvalInput, type RlmPluginConfig } from './model.ts'


export const DELIVER_SUBAGENT_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

export interface HostPromptDeliverer {
  [DELIVER_SUBAGENT_PROMPT](parent: Agent, childId: unknown, content: unknown[], source: unknown, signal: AbortSignal, delivery: 'queue' | 'steer'): Promise<unknown>
}

/**
 * Gate M8 admission on the loaded host's official continuable-inbox adapter.
 * Checking before `startContinuable` prevents an unsupported host from leaving
 * Python with a capability for a child it can never follow up.
 */
export function requireHostPromptAdapter(ctx: Context): HostPromptDeliverer[typeof DELIVER_SUBAGENT_PROMPT] {
  const deliver = (ctx.subagents as unknown as Partial<HostPromptDeliverer>)[DELIVER_SUBAGENT_PROMPT]
  if (typeof deliver !== 'function') {
    throw new RlmError('query', 'DSH host does not expose the official continuable inbox adapter', { phase: 'query' })
  }
  return deliver
}

/**
 * Cap one query-error text field to a total of at most `limit` UTF-8 bytes
 * (the stable marker counts inside that budget). An over-limit field keeps a
 * code-point-safe prefix and appends the marker so truncation is observable.
 */
export function textOf(output: readonly { type: string; text?: unknown }[]): string {
  let out = ''
  for (const block of output) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Answer one `rlm_query(prompt)` by starting a fresh one-shot DSH Subagent.
 *
 * DSH owns the child Session, persisted delegation depth, and capability
 * enforcement. The plugin passes an absolute cap and only structurally removes
 * `rlm_eval` from an exact-cap leaf. The call is foreground: we wait for the
 * child's terminal result and always dispose it in `finally`. Only the child's
 * final assistant text crosses back to the Python cell.
 */
async function runQuery(
  ctx: Context,
  provider: string,
  parent: Agent,
  prompt: string,
  signal: AbortSignal,
  maxDepth: number,
): Promise<string> {
  // Fail the whole branch before its first child exists if the selected
  // provider cannot enforce both the absolute cap and the eventual leaf tool
  // restriction. `start()` still authoritatively revalidates each request.
  const selected = ctx.subagents.getProvider(provider)
  if (selected === undefined) {
    throw new RlmError('query', `rlm_query provider "${provider}" is not registered`, { phase: 'query' })
  }
  if (!selected.capabilities.depthLimit || !selected.capabilities.toolFilter) {
    throw new RlmError('query', `rlm_query provider "${provider}" must support depthLimit and toolFilter`, { phase: 'query' })
  }
  const childDepth = delegationDepthOf(parent) + 1
  const run: SubagentRun = await ctx.subagents.start(provider, {
    label: 'rlm query',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    maxDepth,
    ...(childDepth === maxDepth ? { toolFilter: { deny: [TOOL_NAME] } } : {}),
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

/** Admit a continuable child through DSH; its durable id never reaches user Python. */
async function runSpawn(
  ctx: Context,
  provider: string,
  parent: Agent,
  prompt: string,
  signal: AbortSignal,
  maxDepth: number,
): Promise<string> {
  requireHostPromptAdapter(ctx)
  const selected = ctx.subagents.getProvider(provider)
  if (selected === undefined) {
    throw new RlmError('query', `rlm_spawn provider "${provider}" is not registered`, { phase: 'query' })
  }
  if (!selected.capabilities.depthLimit || !selected.capabilities.toolFilter || !selected.prepareContinuable) {
    throw new RlmError('query', `rlm_spawn provider "${provider}" must support continuable depthLimit and toolFilter`, { phase: 'query' })
  }
  const childDepth = delegationDepthOf(parent) + 1
  const started = await ctx.subagents.startContinuable({
    provider,
    label: 'rlm continuable child',
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent,
      maxDepth,
      ...(childDepth === maxDepth ? { toolFilter: { deny: [TOOL_NAME] } } : {}),
    },
    signal,
  })
  return String(started.childId)
}

/** Admit one later message through the official child inbox; no plugin queue exists. */
async function runFollowup(
  ctx: Context,
  parent: Agent,
  childId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  const deliver = requireHostPromptAdapter(ctx)
  await deliver.call(
    ctx.subagents,
    parent,
    SessionId(childId),
    [{ type: 'text', text: prompt }],
    { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
    signal,
    'queue',
  )
}

export interface RlmEvalValue {
  stdout: string
  result?: string
  truncated: boolean
  recovery?: string
}

export function renderValue(value: RlmEvalValue): string {
  const parts: string[] = []
  if (value.stdout) parts.push(value.stdout)
  if (value.result !== undefined) parts.push(value.result)
  if (value.recovery) parts.push('[recovery: ' + value.recovery + ']')
  if (parts.length === 0) parts.push('(no output)')
  let text = parts.join('\n')
  if (value.truncated) text += '\n[output truncated]'
  return text
}

/**
 * Shared cell-input builder for foreground `rlm_eval` and M12 RLM jobs
 * (Issue #78): query/spawn/followup bridges, the per-cell token guard, the
 * Session identity for sandbox policy resolution, and M8 continuable tracking
 * all come from one place so the two paths cannot drift.
 */
export function buildRlmCodeEvalInput(
  ctx: Context,
  config: RlmPluginConfig,
  parent: Agent,
  signal: AbortSignal,
  continuableParents: Set<Agent>,
  code: string,
  contextPath?: string,
): RlmCodeEvalInput {
  const provider = config.provider ?? 'spawn'
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH
  const tokenGuard = createCellTokenGuard(ctx, parent.session, config)
  const input: RlmCodeEvalInput = {
    code,
    signal,
    session: parent.session,
    onQuery: async (prompt: string, cellSignal: AbortSignal) => {
      tokenGuard?.admit()
      return runQuery(ctx, provider, parent, prompt, cellSignal, maxDepth)
    },
    onSpawn: async (prompt: string, cellSignal: AbortSignal) => {
      tokenGuard?.admit()
      const childId = await runSpawn(ctx, provider, parent, prompt, cellSignal, maxDepth)
      continuableParents.add(parent)
      return childId
    },
    onFollowup: async (childId: string, prompt: string, cellSignal: AbortSignal) => {
      tokenGuard?.admit()
      return runFollowup(ctx, parent, childId, prompt, cellSignal)
    },
  }
  if (contextPath !== undefined) input.contextPath = contextPath
  return input
}

/** Shared per-context M8 continuable tracking (tool + M12 job paths). */
export const continuableParentsByContext = new WeakMap<Context, Set<Agent>>()

export function continuableParentsFor(ctx: Context): Set<Agent> {
  let set = continuableParentsByContext.get(ctx)
  if (set === undefined) {
    set = new Set()
    continuableParentsByContext.set(ctx, set)
  }
  return set
}

/**
 * Register the single `rlm_eval` tool and bridge `rlm_query` to a one-shot
 * DSH Subagent. The runtime is created here and torn down with the calling
 * Cordis fiber, so no plugin-owned Python process survives plugin unload.
 */
export interface TokenMeterLike {
  measure(session: unknown, requestHeader?: unknown): {
    baseline?: { kind: 'none' | 'estimated' | 'usage'; tokens: number; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
    totalTokens?: number
  }
}

/**
 * M11 cell-scoped admission guard over official observed token-meter data
 * (Issue #66/#68). One instance lives for one `rlm_eval` cell: the baseline is
 * captured at the first admission and only positive observed growth during the
 * cell counts against the ceiling. A Session that is already above the ceiling
 * before the cell starts can still admit that cell's first query, and the
 * accounting resets at every new cell. Unobserved provider spend (e.g. child
 * subagent sessions the parent meter does not aggregate) is never invented.
 */
export class CellQueryTokenGuard {
  private baseline: number | undefined
  private peak = 0
  private readonly meter: TokenMeterLike
  private readonly session: unknown
  private readonly ceiling: number

  constructor(meter: TokenMeterLike, session: unknown, ceiling: number) {
    this.meter = meter
    this.session = session
    this.ceiling = ceiling
  }

  /** Record one admission; throws a typed query error before any dispatch when the cell's observed growth exceeded the ceiling. */
  admit(): void {
    const observed = this.meter.measure(this.session)
    const usage = observed?.baseline?.kind === 'usage' ? observed.baseline.usage : undefined
    if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return
    const total = usage.inputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + usage.outputTokens
    if (this.baseline === undefined) this.baseline = total
    if (total > this.peak) this.peak = total
    const cellUsage = this.peak - this.baseline
    if (cellUsage > this.ceiling) {
      throw new RlmError('query', 'per-cell observed token budget exceeded: cell consumed ' + cellUsage + ' > ' + this.ceiling, { phase: 'query' })
    }
  }
}

/** Build a cell-scoped guard, or undefined when the guard is off or no official meter is mounted. */
export function createCellTokenGuard(ctx: Context, session: unknown, config: RlmPluginConfig): CellQueryTokenGuard | undefined {
  if (!config.guardQueryTokens || config.maxQueryTokensPerCell === undefined || config.maxQueryTokensPerCell <= 0) return undefined
  const accessor = ctx as unknown as { tokenMeter?: TokenMeterLike; get?: (key: string) => unknown }
  const meter = accessor.tokenMeter ?? accessor.get?.('tokenMeter') as TokenMeterLike | undefined
  if (!meter || typeof meter.measure !== 'function') return undefined
  return new CellQueryTokenGuard(meter, session, config.maxQueryTokensPerCell)
}

