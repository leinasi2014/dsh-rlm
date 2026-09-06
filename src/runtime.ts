/**
 * dsh-rlm public runtime surface (Issue #84). Aggregation boundary only: the
 * implementation subsystems live under src/runtime/ and the public plugin entry
 * (src/index.ts) keeps importing from here unchanged.
 */
export { ConfigSchema, RlmError, TOOL_NAME } from './runtime/model.ts'
export type {
  RlmCodeEvalInput,
  RlmEvalInput,
  RlmEvalOutput,
  RlmPluginConfig,
  RlmResetInput,
  RlmRuntimeConfig,
} from './runtime/model.ts'
export { createRlmRuntime, type RlmRuntime } from './runtime/session.ts'
export { registerRlmPlugin } from './runtime/plugin.ts'
export { createRlmJobSpec, startRlmJob, type RlmJobSpecOptions } from './runtime/jobs.ts'
