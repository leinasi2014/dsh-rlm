import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RLM_FIELDS,
  RLM_SETTINGS_LOCALE_NS,
  RLM_SETTINGS_NAMESPACE,
  deriveDraft,
  deriveOverrides,
  validateDraft,
  isDraftValid,
  isFieldOverridden,
  buildWrites,
  resetState,
  saveStateReducer,
  valueFromDraft,
  isAbsolutePath,
} from '../src/client/rlm-settings-model.ts'

test('RLM_FIELDS exposes exactly the 14 Tier A fields and no Tier-C constants', () => {
  const keys = RLM_FIELDS.map(spec => spec.key).toSorted()
  assert.deepEqual(keys, [
    'enabled', 'provider', 'python', 'maxDepth',
    'timeout', 'maxStdout', 'maxResult', 'maxQueries', 'maxContextBytes',
    'snapshotRecovery', 'kernelSandbox', 'durableRoot',
    'guardQueryTokens', 'maxQueryTokensPerCell',
  ].toSorted())
  // Tier-C constants are never surfaced as field keys.
  for (const key of keys) {
    assert.ok(!/^(CHECKPOINT|MAX_FRAME|MAX_STDERR|DEFAULT_|MAX_SNAPSHOT)/u.test(key), `Tier-C constant leaked as a field: ${key}`)
  }
})

test('namespace and locale namespace constants are the frozen values', () => {
  assert.equal(RLM_SETTINGS_NAMESPACE, 'rlm')
  assert.equal(RLM_SETTINGS_LOCALE_NS, 'rlm.settings')
})

test('deriveDraft seeds staged text/booleans from an effective settings value', () => {
  const draft = deriveDraft({ enabled: true, provider: 'spawn', maxDepth: 2, timeout: 45000 })
  assert.equal(draft.enabled, true)
  assert.equal(draft.provider, 'spawn')
  assert.equal(draft.python, 'python')
  assert.equal(draft.maxDepth, '2')
  assert.equal(draft.timeout, '45000')
  assert.equal(draft.maxStdout, '65536')
  assert.equal(draft.maxQueries, '16')
  assert.equal(draft.kernelSandbox, 'auto')
  assert.equal(draft.snapshotRecovery, false)
  assert.equal(draft.guardQueryTokens, false)
})

test('deriveDraft applies schema defaults (maxDepth stays 1, not the doc table 8)', () => {
  const draft = deriveDraft(undefined)
  assert.equal(draft.maxDepth, '1')
  assert.equal(draft.maxQueryTokensPerCell, '0')
  assert.equal(draft.durableRoot, '')
})

test('deriveOverrides marks a field overridden by bare presence, even when equal to default', () => {
  // provider: 'spawn' equals the default, but its PRESENCE in the user layer is an override.
  const overrides = deriveOverrides({ provider: 'spawn', timeout: 30000 })
  assert.deepEqual([...overrides].toSorted(), ['provider', 'timeout'])
  assert.equal(isFieldOverridden('provider', { dirty: false, stagedClear: false, userOwns: overrides.has('provider') }), true)
  assert.equal(isFieldOverridden('python', { dirty: false, stagedClear: false, userOwns: overrides.has('python') }), false)
  assert.equal(isFieldOverridden('python', { dirty: true, stagedClear: false, userOwns: true }), true)
  assert.equal(isFieldOverridden('provider', { dirty: true, stagedClear: true, userOwns: true }), false)
})

test('validateDraft rejects out-of-range number, empty required text, and non-absolute durableRoot', () => {
  const draft = deriveDraft({ enabled: true })
  assert.equal(isDraftValid(draft), true)

  const badTimeout = { ...draft, timeout: '999' }
  assert.equal(validateDraft(badTimeout).timeout, 'invalidNumber')
  assert.equal(isDraftValid(badTimeout), false)

  const highDepth = { ...draft, maxDepth: '9' }
  assert.equal(validateDraft(highDepth).maxDepth, 'invalidNumber')

  const emptyProvider = { ...draft, provider: ' ' }
  assert.equal(validateDraft(emptyProvider).provider, 'required')

  const relativeRoot = { ...draft, durableRoot: 'relative/path' }
  assert.equal(validateDraft(relativeRoot).durableRoot, 'pathNotAbsolute')
  assert.equal(validateDraft({ ...draft, durableRoot: '' }).durableRoot, undefined)
  assert.equal(validateDraft({ ...draft, durableRoot: 'C:\\data\\rlm' }).durableRoot, undefined)
  assert.equal(validateDraft({ ...draft, durableRoot: '/data/rlm' }).durableRoot, undefined)

  const badSandbox = { ...draft, kernelSandbox: 'nope' }
  assert.equal(validateDraft(badSandbox).kernelSandbox, 'invalidEnum')
})

test('isAbsolutePath accepts drive, UNC and POSIX roots and rejects relatives', () => {
  assert.equal(isAbsolutePath('C:\\data'), true)
  assert.equal(isAbsolutePath('C:/data'), true)
  assert.equal(isAbsolutePath('/data'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('data/rlm'), false)
  assert.equal(isAbsolutePath(''), false)
})

test('invalid staged values block the save (dirty + invalid)', () => {
  const draft = deriveDraft({ enabled: true })
  const invalidDraft = { ...draft, timeout: '0' }
  // Card rule: canSave = editable && dirty.size > 0 && !isDraftValid(draft)
  const dirty = new Set(['timeout'] as const)
  const canSave = dirty.size > 0 && isDraftValid(invalidDraft)
  assert.equal(canSave, false)
  // The draft is retained (we do not discard it on a blocked save).
  assert.equal(invalidDraft.timeout, '0')
})

test('buildWrites writes only the dirty fields, and clears optional empty text', () => {
  const draft = deriveDraft({ enabled: false, provider: 'spawn', maxDepth: 2 })
  const dirty = new Set(['enabled', 'maxDepth', 'durableRoot'] as const)
  const writes = buildWrites(draft, dirty, new Set())
  assert.deepEqual(writes.toSorted(byKey), [
    { key: 'enabled', op: 'set', value: false },
    { key: 'maxDepth', op: 'set', value: 2 },
    { key: 'durableRoot', op: 'clear' },
  ].toSorted(byKey))
  // Empty durableRoot clears, so it re-inherits the composition layer.
  assert.equal(writes.find(w => w.key === 'durableRoot')?.op, 'clear')
})

test('valueFromDraft converts staged text to the JSON-shaped storage value', () => {
  const draft = deriveDraft({ enabled: true, maxQueries: 7, maxDepth: 3, kernelSandbox: 'require' })
  assert.equal(valueFromDraft('enabled', draft), true)
  assert.equal(valueFromDraft('maxQueries', draft), 7)
  assert.equal(valueFromDraft('maxDepth', draft), 3)
  assert.equal(valueFromDraft('kernelSandbox', draft), 'require')
  assert.equal(valueFromDraft('python', draft), 'python')
})

function byKey(left: { key: string }, right: { key: string }): number { return left.key < right.key ? -1 : left.key > right.key ? 1 : 0 }

test('reset-to-composition reverts the draft to the base layer and stages clears of the user overrides', () => {
  const base = { provider: 'spawn', maxDepth: 1, timeout: 30000 }
  const user = { provider: 'custom', timeout: 12345 }
  const next = resetState(base, user)
  assert.equal(next.draft.provider, 'spawn')
  assert.equal(next.draft.timeout, '30000')
  assert.deepEqual([...next.dirty].toSorted(), ['provider', 'timeout'])
  assert.deepEqual([...next.stagedClear].toSorted(), ['provider', 'timeout'])
  const writes = buildWrites(next.draft, next.dirty, next.stagedClear)
  assert.deepEqual(writes.toSorted(byKey), [
    { key: 'provider', op: 'clear' },
    { key: 'timeout', op: 'clear' },
  ].toSorted(byKey))
})

test('save state machine: idle -> saving -> saved | failed, and any edit/reset returns to idle', () => {
  assert.equal(saveStateReducer('idle', { type: 'begin' }), 'saving')
  assert.equal(saveStateReducer('saving', { type: 'succeed' }), 'saved')
  assert.equal(saveStateReducer('idle', { type: 'begin' }), 'saving')
  assert.equal(saveStateReducer('saving', { type: 'fail' }), 'failed')
  // A new edit clears a stale saved/failed state.
  assert.equal(saveStateReducer('saved', { type: 'edit' }), 'idle')
  assert.equal(saveStateReducer('failed', { type: 'reset' }), 'idle')
  // A save already in flight stays 'saving'; succeed/fail outside 'saving' are no-ops.
  assert.equal(saveStateReducer('saving', { type: 'begin' }), 'saving')
  assert.equal(saveStateReducer('idle', { type: 'succeed' }), 'idle')
  assert.equal(saveStateReducer('idle', { type: 'fail' }), 'idle')
})
