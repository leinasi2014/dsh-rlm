import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  ConfigSchema,
  createRlmJobSpec,
  createRlmRuntime,
  registerRlmPlugin,
  startRlmJob,
  TOOL_NAME,
  type RlmEvalInput,
  type RlmPluginConfig,
  type RlmRuntime,
  type RlmEvalOutput,
} from './runtime.js'

export const name = 'rlm'
export const inject = ['tools', 'subagents', 'systemPrompt']

export type Config = RlmPluginConfig

export const Config: z<Config> = ConfigSchema

/**
 * M1C/M1D entrypoint: delegate to the testable registration helper in
 * `runtime.ts` (kept there so `node --test` can load it directly without
 * pulling this plugin module's `./runtime.js` specifier into the test graph).
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  registerRlmPlugin(ctx, config)
}

// M12 host-consumer API: a library consumer can run an RLM cell as an official
// DSH background job without constructing the plugin runtime by hand.
export {
  createRlmRuntime,
  createRlmJobSpec,
  startRlmJob,
  TOOL_NAME,
  type RlmRuntime,
  type RlmEvalInput,
  type RlmEvalOutput,
}
