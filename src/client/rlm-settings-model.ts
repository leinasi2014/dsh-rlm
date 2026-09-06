import { RLM_SETTINGS_MANIFEST, rlmSettingsSpec, type RlmManifestKind, type RlmManifestTab, type RlmSettingsKey, type RlmSettingsSpec, type RlmTierASettings } from '../settings-manifest.ts'

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
 * schema default. Field keys/defaults/ranges/options come from the shared pure
 * `RLM_SETTINGS_MANIFEST`; Host-only validation remains outside browser code.
 */

export const RLM_SETTINGS_NAMESPACE = 'rlm' as const
export const RLM_SETTINGS_LOCALE_NS = 'rlm.settings' as const

export type RlmTab = RlmManifestTab
export type RlmFieldKind = RlmManifestKind
export type RlmSettings = RlmTierASettings
export type RlmFieldKey = RlmSettingsKey
export type RlmFieldSpec = RlmSettingsSpec

/** The exact shared Tier-A manifest; no browser-side metadata mirror. */
export const RLM_FIELDS: readonly RlmFieldSpec[] = RLM_SETTINGS_MANIFEST

/** Staged, user-typed value for every field (booleans for toggles, text otherwise). */
type DraftValueForSpec<S> = S extends { readonly kind: 'toggle' } ? boolean : string

/** Staged values are generated from the same 14-field manifest. */
export type RlmDraft = {
  [S in RlmFieldSpec as S['key']]: DraftValueForSpec<S>
}

export function fieldSpec(key: RlmFieldKey): RlmFieldSpec {
  return rlmSettingsSpec(key)
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
  const draft: Partial<Record<RlmFieldKey, boolean | string>> = {}
  for (const spec of RLM_FIELDS) {
    const configured = settings?.[spec.key]
    const effective = configured ?? spec.default
    draft[spec.key] = spec.kind === 'toggle' ? effective as boolean : String(effective)
  }
  return draft as RlmDraft
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
        if (!(spec.options as readonly string[]).includes(String(draft[spec.key]))) problems[spec.key] = 'invalidEnum'
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
        if ('required' in spec && spec.required === true && raw.trim() === '') {
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

/**
 * One ordered operation of a single atomic SettingsScope.mutate call
 * (Issue #69). The card commits all staged writes in one revision-fenced
 * mutation instead of sequential set/unset calls, so a save is all-or-nothing.
 */
export type RlmScopeMutation =
  | { readonly op: 'set'; readonly path: string[]; readonly value: boolean | number | string }
  | { readonly op: 'unset'; readonly path: string[] }

/** Convert staged writes to the ordered op list consumed by one mutate. */
export function buildMutation(writes: readonly RlmFieldWrite[]): RlmScopeMutation[] {
  return writes.map((write) => write.op === 'clear'
    ? { op: 'unset' as const, path: [write.key] }
    : { op: 'set' as const, path: [write.key], value: write.value })
}

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

/**
 * Whether the Reset-to-composition action is meaningful in the current editor
 * state (Issue #80): it must be available whenever the user layer still owns at
 * least one field (even when the draft is clean), and whenever local staged
 * edits exist that can be discarded. The card gates the button on this instead
 * of on draft dirtiness alone.
 */
export function canStageReset(
  storedOverrides: ReadonlySet<RlmFieldKey>,
  dirty: ReadonlySet<RlmFieldKey>,
): boolean {
  return storedOverrides.size > 0 || dirty.size > 0
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
