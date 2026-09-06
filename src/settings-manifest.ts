/**
 * Environment-neutral Tier-A settings contract shared by Host and browser code.
 *
 * Keep this module free of React, DOM, Cordis, Schemastery and Node-only imports.
 * It is the single owner of the 14 user-facing keys plus UI-relevant defaults,
 * ranges, enum options and grouping metadata. Host-only Tier-B validation stays
 * in settings.ts; protocol/runtime constants stay out of this manifest.
 */

export type RlmManifestTab = 'core' | 'bounded' | 'recovery' | 'guard'
export type RlmManifestKind = 'toggle' | 'select' | 'number' | 'text'

interface RlmManifestBase {
  readonly key: string
  readonly tab: RlmManifestTab
  readonly kind: RlmManifestKind
  readonly default: boolean | number | string
  /** Whether ConfigSchema applies the manifest default when the key is absent. */
  readonly schemaDefault: boolean
  /** Whether the setting is consumed by the low-level runtime (not only plugin glue). */
  readonly runtime: boolean
  readonly description: string
  readonly required?: boolean
  readonly hostMinLength?: number
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
}

export const RLM_SETTINGS_MANIFEST = [
  {
    key: 'enabled', tab: 'core', kind: 'toggle', default: false, schemaDefault: true, runtime: true,
    description: 'Enable dsh-rlm after the local kernel/query loop is implemented.',
  },
  {
    key: 'provider', tab: 'core', kind: 'text', default: 'spawn', schemaDefault: true, runtime: false, required: true,
    description: 'The ctx.subagents provider used to answer each rlm_query call.',
  },
  {
    key: 'python', tab: 'core', kind: 'text', default: 'python', schemaDefault: true, runtime: true, required: true, hostMinLength: 1,
    description: 'Python interpreter command; defaults to the python on PATH.',
  },
  {
    key: 'maxDepth', tab: 'core', kind: 'number', default: 1, schemaDefault: true, runtime: false, min: 1, max: 8,
    description: 'Absolute DSH delegation-depth cap for recursive rlm_query children.',
  },
  {
    key: 'timeout', tab: 'bounded', kind: 'number', default: 30_000, schemaDefault: true, runtime: true, min: 1_000, max: 3_600_000,
    description: 'Per-eval total timeout in milliseconds.',
  },
  {
    key: 'maxStdout', tab: 'bounded', kind: 'number', default: 65_536, schemaDefault: true, runtime: true, min: 1_024, max: 262_144,
    description: 'Byte cap for a cell captured stdout.',
  },
  {
    key: 'maxResult', tab: 'bounded', kind: 'number', default: 65_536, schemaDefault: true, runtime: true, min: 1_024, max: 262_144,
    description: 'Byte cap for a cell last-expression result.',
  },
  {
    key: 'maxQueries', tab: 'bounded', kind: 'number', default: 16, schemaDefault: true, runtime: true, min: 1, max: 4_096,
    description: 'Max rlm_query calls per cell.',
  },
  {
    key: 'maxContextBytes', tab: 'bounded', kind: 'number', default: 67_108_864, schemaDefault: true, runtime: true, min: 1_048_576, max: 1_073_741_824,
    description: 'Byte cap for one kernel-managed UTF-8 context file.',
  },
  {
    key: 'snapshotRecovery', tab: 'recovery', kind: 'toggle', default: false, schemaDefault: true, runtime: true,
    description: 'Restore a private bounded checkpoint after an owned kernel fault.',
  },
  {
    key: 'kernelSandbox', tab: 'recovery', kind: 'select', default: 'auto', schemaDefault: true, runtime: true,
    options: ['auto', 'require', 'off'] as const,
    description: 'Sandbox confinement for the Session Python kernel: auto uses DSH ctx.sandbox when available, require fails closed, off keeps trusted local spawn.',
  },
  {
    key: 'durableRoot', tab: 'recovery', kind: 'text', default: '', schemaDefault: false, runtime: true,
    description: 'Optional absolute host-owned directory for cross-restart durable checkpoint references (M10).',
  },
  {
    key: 'guardQueryTokens', tab: 'guard', kind: 'toggle', default: false, schemaDefault: true, runtime: false,
    description: 'Reject query admission when the observed token usage exceeds the per-cell ceiling (M11).',
  },
  {
    key: 'maxQueryTokensPerCell', tab: 'guard', kind: 'number', default: 0, schemaDefault: true, runtime: false, min: 0, max: 1_073_741_824,
    description: 'Observed token ceiling per cell; 0 means no ceiling.',
  },
] as const satisfies readonly RlmManifestBase[]

export type RlmSettingsSpec = (typeof RLM_SETTINGS_MANIFEST)[number]
export type RlmSettingsKey = RlmSettingsSpec['key']

type ValueForSpec<S> =
  S extends { readonly kind: 'toggle' } ? boolean
    : S extends { readonly kind: 'number' } ? number
      : S extends { readonly kind: 'select'; readonly options: readonly (infer O extends string)[] } ? O
        : string

export type RlmTierASettings = Partial<{
  [S in RlmSettingsSpec as S['key']]: ValueForSpec<S>
}>

type RlmRuntimeSpec = Extract<RlmSettingsSpec, { readonly runtime: true }>

export type RlmRuntimeTierASettings = Partial<{
  [S in RlmRuntimeSpec as S['key']]: ValueForSpec<S>
}>

export function rlmSettingsSpec(key: RlmSettingsKey): RlmSettingsSpec {
  const spec = RLM_SETTINGS_MANIFEST.find(candidate => candidate.key === key)
  if (spec === undefined) throw new Error(`unknown RLM settings field: ${String(key)}`)
  return spec
}
