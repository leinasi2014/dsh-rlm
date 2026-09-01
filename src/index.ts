import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerRlmPlugin } from './runtime.js'

export const name = 'rlm'
export const inject = ['tools']

export interface Config {
  /** When false, the plugin registers no tool and starts no runtime. */
  enabled?: boolean
  /** The `ctx.subagents` provider used for each one-shot rlm_query child. */
  provider?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false).description('Enable dsh-rlm after the local kernel/query loop is implemented.'),
  provider: z.string().default('spawn').description('The ctx.subagents provider used to answer each rlm_query call.'),
})

/**
 * M1C/M1D entrypoint: delegate to the testable registration helper in
 * `runtime.ts` (kept there so `node --test` can load it directly without
 * pulling this plugin module's `./runtime.js` specifier into the test graph).
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  registerRlmPlugin(ctx, config)
}
