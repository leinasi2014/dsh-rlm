import type { Context } from '@deepseek-ai/cordis'

export interface RlmRuntimeConfig {
  enabled?: boolean
}

export interface RlmRuntime {
  dispose(): void
}

export function createRlmRuntime(_ctx: Context, _config: RlmRuntimeConfig): RlmRuntime {
  throw new Error('dsh-rlm: M1 runtime is not implemented yet')
}
