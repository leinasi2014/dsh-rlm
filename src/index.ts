import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ConfigSchema, registerRlmPlugin, type RlmPluginConfig } from './runtime.js'

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
