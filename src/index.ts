import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRlmRuntime } from './runtime.js'

export const name = 'rlm'

export interface Config {
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false).description('Enable dsh-rlm after the local kernel/query loop is implemented.'),
})

/**
 * Architecture-first scaffold. The runtime is deliberately unavailable until
 * the minimal per-Session Python kernel and one-shot query loop are implemented.
 */
export function apply(_ctx: Context, config: Config): void {
  if (config.enabled === true) {
    createRlmRuntime(_ctx, config)
  }
}
