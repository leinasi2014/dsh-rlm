/**
 * DSH plugin registration (Issue #84): the single `rlm_eval` tool, its
 * system-prompt section, and runtime teardown. Private boundary.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  formatToolError,
  MAX_QUERY_ERROR_BYTES,
  RlmError,
  TOOL_NAME,
  truncateUtf8,
  type RlmEvalInput,
  type RlmPluginConfig,
} from './model.ts'
import { buildRlmCodeEvalInput, continuableParentsFor, renderValue, type RlmEvalValue } from './bridge.ts'
import { attachRlmJobController } from './jobs.ts'
import { createRlmRuntime } from './session.ts'


export function registerRlmPlugin(
  ctx: Context,
  config: RlmPluginConfig,
): void {
  if (config.enabled !== true) return
  const runtime = createRlmRuntime(ctx, config)
  const continuableParents = continuableParentsFor(ctx)
  const detachRlmJobs = attachRlmJobController(ctx)

  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:' + TOOL_NAME,
    order: 150,
    text:
      'Persistent globals and variables are kept across rlm_eval cells in one per-session Python kernel. '
      + 'Pass contextPath to load one absolute UTF-8 regular file into persistent context; invalid sources leave the prior context intact. '
      + 'Cells may also read files by absolute paths. Top-level await is supported, and '
      + 'await rlm_query(prompt) delegates the prompt to a depth-bounded DSH subagent and returns its text. '
      + 'For independent prompts, await rlm_query_batched(prompts) starts at most four child queries and returns text in input order. '
      + 'For work that outlives a cell, await rlm_spawn(prompt) returns an opaque live-kernel handle and '
      + 'await rlm_followup(handle, prompt) admits a later official child-inbox turn; child reports and settlement arrive only through DSH. '
      + 'A later rlm_eval call reuses the same variables and can iterate on earlier results. '
      + 'Call rlm_eval with reset: true and no other input to discard this Session\'s RLM state before a fresh later cell.',
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Run one Python cell in the current session\'s persistent kernel and return its '
      + 'stdout and last-expression result. The cell may call `await rlm_query(prompt)`, '
      + 'which answers by delegating the prompt to a depth-bounded DSH Subagent and returns only '
      + 'its final text. Pass `{ reset: true }` with no code or contextPath to discard only the current Session\'s RLM state. '
      + 'An exact-depth leaf has no rlm_eval tool; lower-depth children may recurse.',
    parameters: {
      code: {
        type: 'string',
        description: 'Python source to run; top-level await and persistent globals are supported.',
      },
      contextPath: {
        type: 'string',
        description: 'Optional absolute UTF-8 regular file loaded atomically as persistent `context` for this session kernel.',
      },
      reset: {
        type: 'boolean',
        description: 'Set exactly true with no code or contextPath to discard this Session\'s Python globals, managed context, and private checkpoint.',
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
          recovery: { type: 'string' },
        },
      },
      render: (_args: unknown, value: RlmEvalValue) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args: { code?: string; contextPath?: string; reset?: boolean }, exec): Promise<RlmEvalValue> {
      const parent = exec.agent
      if (!parent) {
        throw new Error('rlm_eval requires a calling agent (exec.agent was undefined)')
      }
      // The agent/session share one identity; this is the stable per-session key.
      const sessionKey = String(parent.id)
      let output: Awaited<ReturnType<typeof runtime.eval>>
      try {
        let input: RlmEvalInput
        if (args.reset === true) {
          if (args.code !== undefined || args.contextPath !== undefined) {
            throw new RlmError('eval', 'reset input must not include code or contextPath')
          }
          input = { reset: true, signal: exec.signal }
        } else {
          if (args.reset !== undefined || typeof args.code !== 'string') {
            throw new RlmError('eval', 'rlm_eval requires either code or reset: true')
          }
          input = buildRlmCodeEvalInput(ctx, config, parent, exec.signal, continuableParents, args.code, args.contextPath)
        }
        output = await runtime.eval(sessionKey, input)
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
      if (output.recovery) {
        const status = [
          output.recovery.restored ? 'restored' : 'not-restored',
          output.recovery.checkpointCommitted ? 'checkpoint-committed' : 'checkpoint-unchanged',
          ...(output.recovery.skipped?.length ? ['skipped=' + output.recovery.skipped.join(', ')] : []),
          ...(output.recovery.reason ? ['reason=' + output.recovery.reason] : []),
        ].join('; ')
        value.recovery = truncateUtf8(status, MAX_QUERY_ERROR_BYTES)
      }
      return value
    },
  }))

  // Tear down the runtime and unregister the tool whenever the plugin's fiber
  // unloads, so no plugin-owned Python process survives the plugin.
  ctx.effect(() => () => {
    detachRlmJobs?.()
    disposeTool()
    disposeSection()
    return (async () => {
      try {
        if (continuableParents.size > 0) {
          await ctx.subagents.drainContinuableDescendants([...continuableParents])
        }
        continuableParents.clear()
      } finally {
        await runtime.dispose()
      }
    })()
  }, 'rlm runtime teardown')
}
