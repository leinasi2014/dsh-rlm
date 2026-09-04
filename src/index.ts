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
import { RLM_SETTINGS_NAMESPACE, resolveRlmConfig } from './settings.js'

export const name = 'rlm'
export const inject = ['tools', 'subagents', 'systemPrompt']

export type Config = RlmPluginConfig

export const Config: z<Config> = ConfigSchema

/**
 * M13 entrypoint: register the `rlm` settings namespace and consume the
 * normalized merged config (composition layer + user layer) instead of the raw
 * loader `config`. The enabled gate is preserved, and the runtime surface stays
 * byte-for-byte backward compatible (M1-M12) when no user settings exist.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveRlmConfig(ctx, config, ConfigSchema)
  if (resolved.enabled !== true) return
  registerRlmPlugin(ctx, resolved)
}

export { RLM_SETTINGS_NAMESPACE }

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
