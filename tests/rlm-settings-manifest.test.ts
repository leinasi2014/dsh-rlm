import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '../src/runtime.ts'
import { RLM_SETTINGS_MANIFEST } from '../src/settings-manifest.ts'
import { RLM_FIELDS, deriveDraft, fieldSpec } from '../src/client/rlm-settings-model.ts'

test('Issue#73: one pure manifest owns all 14 Tier-A field keys and GUI metadata', () => {
  const keys = RLM_SETTINGS_MANIFEST.map(spec => spec.key)
  assert.equal(keys.length, 14)
  assert.equal(new Set(keys).size, 14)
  assert.deepEqual(RLM_FIELDS, RLM_SETTINGS_MANIFEST)
  for (const spec of RLM_SETTINGS_MANIFEST) assert.equal(fieldSpec(spec.key), spec)
})

test('Issue#73: Host ConfigSchema defaults are derived without inventing durableRoot', () => {
  const parsed = ConfigSchema({}) as Record<string, unknown>
  for (const spec of RLM_SETTINGS_MANIFEST) {
    if (spec.schemaDefault) assert.deepEqual(parsed[spec.key], spec.default, spec.key)
    else assert.equal(Object.hasOwn(parsed, spec.key), false, `${spec.key} must remain optional without a Host default`)
  }
  const draft = deriveDraft(parsed)
  for (const spec of RLM_SETTINGS_MANIFEST) {
    const staged = draft[spec.key]
    const expected = spec.kind === 'toggle' ? spec.default : String(spec.default)
    assert.deepEqual(staged, expected, spec.key)
  }
})

test('Issue#73: numeric and enum bounds cannot drift between manifest and Host schema', () => {
  for (const spec of RLM_SETTINGS_MANIFEST) {
    if (spec.kind === 'number') {
      if (spec.min !== undefined) {
        assert.doesNotThrow(() => ConfigSchema({ [spec.key]: spec.min }))
        if (spec.min > 0) assert.throws(() => ConfigSchema({ [spec.key]: spec.min - 1 }))
      }
      if (spec.max !== undefined) {
        assert.doesNotThrow(() => ConfigSchema({ [spec.key]: spec.max }))
        assert.throws(() => ConfigSchema({ [spec.key]: spec.max + 1 }))
      }
    }
    if (spec.kind === 'select') {
      for (const option of spec.options) assert.doesNotThrow(() => ConfigSchema({ [spec.key]: option }))
      assert.throws(() => ConfigSchema({ [spec.key]: '__invalid_issue73_option__' }))
    }
  }
})

test('Issue#73: shared manifest stays browser-safe and environment-neutral', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/settings-manifest.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai|from ['"]node:|react|document\.|window\./u)
})
