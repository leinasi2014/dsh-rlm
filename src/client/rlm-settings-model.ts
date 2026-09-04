/**
 * Pure, React-free, DSH-free model behind the dsh-rlm settings card.
 *
 * This module is imported by the browser card (`src/client/RlmSettingsCard.tsx`)
 * and directly by `node --test` (`tests/rlm-client-settings.test.ts`), so it
 * must never import React, a DOM type, or any `@deepseek-ai` package. It owns
 * the staged-draft derivation, the per-field override decision, the staged
 * validation, and the Save/Saving/Saved/Failed state machine.
 *
 * Effective value rule (frozen M13 contract): user layer > composition layer >
 * schema default. The card's hard-coded defaults mirror the single authoritative
 * `ConfigSchema` (`src/runtime.ts`), including `maxDepth` default `1` (task-1
 * determination: the schema default stays 1 to preserve M1-M12 byte-equivalence
 * when no user settings exist).
 */

export const RLM_SETTINGS_NAMESPACE = 'rlm' as const
export const RLM_SETTINGS_LOCALE_NS = 'rlm.settings' as const

export type RlmTab = 'core' | 'bounded' | 'recovery' | 'guard'
export type RlmFieldKind = 'toggle' | 'select' | 'number' | 'text'

/** User-configurable (Tier A) settings fields; exactly the 14 schema fields. */
export interface RlmSettings {
  enabled?: boolean
  provider?: string
  python?: string
  timeout?: number
  maxStdout?: number
  maxResult?: number
  maxQueries?: number
  maxContextBytes?: number
  kernelSandbox?: 'auto' | 'require' | 'off'
  durableRoot?: string
  snapshotRecovery?: boolean
  maxDepth?: number
  guardQueryTokens?: boolean
  maxQueryTokensPerCell?: number
}

export type RlmFieldKey = keyof RlmSettings

export interface RlmFieldSpec {
  readonly key: RlmFieldKey
  readonly tab: RlmTab
  readonly kind: RlmFieldKind
  readonly default: boolean | number | string
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly required?: boolean
}

/**
 * The 14 Tier A fields, grouped into the four card tabs. No Tier-C system-managed
 * constant (frame caps, CHECKPOINT_CHUNK_BYTES, env allowlist, provider/model
 * selection) is surfaced here.
 */
export const RLM_FIELDS: readonly RlmFieldSpec[] = [
  { key: 'enabled', tab: 'core', kind: 'toggle', default: false },
  { key: 'provider', tab: 'core', kind: 'text', default: 'spawn', required: true },
  { key: 'python', tab: 'core', kind: 'text', default: 'python', required: true },
  { key: 'maxDepth', tab: 'core', kind: 'number', default: 1, min: 1, max: 8 },
  { key: 'timeout', tab: 'bounded', kind: 'number', default: 30_000, min: 1000, max: 3_600_000 },
  { key: 'maxStdout', tab: 'bounded', kind: 'number', default: 65_536, min: 1024, max: 262_144 },
  { key: 'maxResult', tab: 'bounded', kind: 'number', default: 65_536, min: 1024, max: 262_144 },
  { key: 'maxQueries', tab: 'bounded', kind: 'number', default: 16, min: 1, max: 4096 },
  { key: 'maxContextBytes', tab: 'bounded', kind: 'number', default: 67_108_864, min: 1_048_576, max: 1_073_741_824 },
  { key: 'snapshotRecovery', tab: 'recovery', kind: 'toggle', default: false },
  { key: 'kernelSandbox', tab: 'recovery', kind: 'select', default: 'auto', options: ['auto', 'require', 'off'] },
  { key: 'durableRoot', tab: 'recovery', kind: 'text', default: '' },
  { key: 'guardQueryTokens', tab: 'guard', kind: 'toggle', default: false },
  { key: 'maxQueryTokensPerCell', tab: 'guard', kind: 'number', default: 0, min: 0, max: 1_073_741_824 },
] as const

/** Staged, user-typed value for every field (booleans for toggles, text otherwise). */
export interface RlmDraft {
  enabled: boolean
  provider: string
  python: string
  maxDepth: string
  timeout: string
  maxStdout: string
  maxResult: string
  maxQueries: string
  maxContextBytes: string
  snapshotRecovery: boolean
  kernelSandbox: string
  durableRoot: string
  guardQueryTokens: boolean
  maxQueryTokensPerCell: string
}

export function fieldSpec(key: RlmFieldKey): RlmFieldSpec {
  const spec = RLM_FIELDS.find(candidate => candidate.key === key)
  if (spec === undefined) throw new Error(`unknown RLM settings field: ${String(key)}`)
  return spec
}

export function tabFields(tab: RlmTab): readonly RlmFieldKey[] {
  return RLM_FIELDS.filter(spec => spec.tab === tab).map(spec => spec.key)
}

/**
 * Build the staged draft from an effective settings value (user layer over
 * composition layer over schema default). Every numeric field is staged as
 * text so the user can type in the raw value; every toggle/select is staged as
 * its typed value.
 */
export function deriveDraft(settings: RlmSettings | undefined): RlmDraft {
  return {
    enabled: settings?.enabled ?? false,
    provider: settings?.provider ?? 'spawn',
    python: settings?.python ?? 'python',
    maxDepth: String(settings?.maxDepth ?? 1),
    timeout: String(settings?.timeout ?? 30_000),
    maxStdout: String(settings?.maxStdout ?? 65_536),
    maxResult: String(settings?.maxResult ?? 65_536),
    maxQueries: String(settings?.maxQueries ?? 16),
    maxContextBytes: String(settings?.maxContextBytes ?? 67_108_864),
    snapshotRecovery: settings?.snapshotRecovery ?? false,
    kernelSandbox: settings?.kernelSandbox ?? 'auto',
    durableRoot: settings?.durableRoot ?? '',
    guardQueryTokens: settings?.guardQueryTokens ?? false,
    maxQueryTokensPerCell: String(settings?.maxQueryTokensPerCell ?? 0),
  }
}

/** The set of fields the raw user layer carries. Presence, not value, marks an override. */
export function deriveOverrides(user: Record<string, unknown> | undefined): ReadonlySet<RlmFieldKey> {
  const overrides = new Set<RlmFieldKey>()
  if (user === undefined || typeof user !== 'object' || user === null || Array.isArray(user)) return overrides
  for (const spec of RLM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(user, spec.key)) overrides.add(spec.key)
  }
  return overrides
}

export type RlmDraftProblem = 'invalidNumber' | 'required' | 'pathNotAbsolute' | 'invalidEnum'

/**
 * Validate every staged field. A single invalid staged value is enough to make
 * the whole save refuse (the draft is kept). Mirrors the host-side ConfigSchema
 * bounds; the host remains the authority for provider registration and path ACLs.
 */
export function validateDraft(draft: RlmDraft): Readonly<Partial<Record<RlmFieldKey, RlmDraftProblem>>> {
  const problems: Partial<Record<RlmFieldKey, RlmDraftProblem>> = {}
  for (const spec of RLM_FIELDS) {
    switch (spec.kind) {
      case 'toggle':
        break
      case 'select': {
        if (!(spec.options ?? []).includes(String(draft[spec.key]))) problems[spec.key] = 'invalidEnum'
        break
      }
      case 'number': {
        const raw = String(draft[spec.key])
        const value = Number(raw)
        const whole = /^\d+$/u.test(raw)
        const range = Number.isSafeInteger(value) && value >= (spec.min ?? 0) && value <= (spec.max ?? Number.MAX_SAFE_INTEGER)
        if (!whole || !range) problems[spec.key] = 'invalidNumber'
        break
      }
      case 'text': {
        const raw = String(draft[spec.key])
        if (spec.required === true && raw.trim() === '') {
          problems[spec.key] = 'required'
        } else if (spec.key === 'durableRoot' && raw.trim() !== '' && !isAbsolutePath(raw.trim())) {
          problems[spec.key] = 'pathNotAbsolute'
        }
        break
      }
    }
  }
  return problems
}

export function isDraftValid(draft: RlmDraft): boolean {
  return Object.keys(validateDraft(draft)).length === 0
}

/** Absolute-host-dir check: Win32 drive root/UNC or POSIX root (the host checks ACLs). */
export function isAbsolutePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
}

/**
 * Display-time override decision, matching CardForm semantics (the badge
 * previews what a save would do). A staged clear removes the user entry; a
 * staged edit would leave one; otherwise presence in the user layer decides.
 */
export function isFieldOverridden(
  key: RlmFieldKey,
  opts: { readonly dirty: boolean; readonly stagedClear: boolean; readonly userOwns: boolean },
): boolean {
  // Validate the key is a known Tier A field (throws on an unknown key), and
  // keep the per-field semantics uniform across every field.
  fieldSpec(key)
  if (opts.stagedClear) return false
  if (opts.dirty) return true
  return opts.userOwns
}

/** A single write a save performs against the settings scope. */
export type RlmFieldWrite =
  | { readonly key: RlmFieldKey; readonly op: 'set'; readonly value: boolean | number | string }
  | { readonly key: RlmFieldKey; readonly op: 'clear' }

/** Convert a staged draft value to the JSON-shaped value a `set` writes. */
export function valueFromDraft(key: RlmFieldKey, draft: RlmDraft): boolean | number | string {
  const spec = fieldSpec(key)
  switch (spec.kind) {
    case 'toggle':
      return draft[key] as boolean
    case 'number':
      return Number(String(draft[key]))
    case 'select':
    case 'text':
      return String(draft[key])
  }
}

/**
 * Plan the writes for a save: only the dirty fields, in dirty order. An optional
 * text field staged empty (and not required) is written as a clear so it
 * re-inherits the composition layer, exactly like the swarm card.
 */
export function buildWrites(
  draft: RlmDraft,
  dirty: ReadonlySet<RlmFieldKey>,
  stagedClear: ReadonlySet<RlmFieldKey>,
): RlmFieldWrite[] {
  const writes: RlmFieldWrite[] = []
  for (const key of dirty) {
    if (stagedClear.has(key)) {
      writes.push({ key, op: 'clear' })
      continue
    }
    const spec = fieldSpec(key)
    if (spec.kind === 'text' && String(draft[key]).trim() === '') {
      writes.push({ key, op: 'clear' })
      continue
    }
    writes.push({ key, op: 'set', value: valueFromDraft(key, draft) })
  }
  return writes
}

/**
 * Reset-to-composition. The draft reverts to the composition layer, every field
 * the user layer currently carries becomes a staged clear (so a save re-inherits
 * the composition values), and the badge previews "not overridden".
 */
export function resetState(base: RlmSettings | undefined, user: Record<string, unknown> | undefined): {
  readonly draft: RlmDraft
  readonly dirty: ReadonlySet<RlmFieldKey>
  readonly stagedClear: ReadonlySet<RlmFieldKey>
} {
  const overrides = deriveOverrides(user)
  return {
    draft: deriveDraft(base),
    dirty: overrides,
    stagedClear: overrides,
  }
}

/** Save state machine: idle -> saving -> saved | failed; any edit/reset returns to idle. */
export type RlmSaveState = 'idle' | 'saving' | 'saved' | 'failed'
export type RlmSaveEvent =
  | { readonly type: 'begin' }
  | { readonly type: 'succeed' }
  | { readonly type: 'fail' }
  | { readonly type: 'edit' }
  | { readonly type: 'reset' }

export function saveStateReducer(state: RlmSaveState, event: RlmSaveEvent): RlmSaveState {
  switch (event.type) {
    case 'begin':
      return state === 'saving' ? state : 'saving'
    case 'succeed':
      return state === 'saving' ? 'saved' : state
    case 'fail':
      return state === 'saving' ? 'failed' : state
    case 'edit':
    case 'reset':
      return 'idle'
  }
}
