import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RLM_FIELDS } from '../src/client/rlm-settings-model.ts'
import { FIELD_HINT, TAB_HELP, rlmSettingsEn, rlmSettingsZh } from '../src/client/rlm-settings-locales.ts'

const cardSource = readFileSync(new URL('../src/client/RlmSettingsCard.tsx', import.meta.url), 'utf8')

test('M13 UX #75: every user-facing field and section has detailed bilingual help', () => {
  for (const field of RLM_FIELDS) {
    const key = FIELD_HINT[field.key]
    assert.equal(typeof key, 'string', `missing hint key for ${field.key}`)
    assert.ok(rlmSettingsEn[key].length >= 40, `English help is too short for ${field.key}`)
    assert.ok(rlmSettingsZh[key].length >= 20, `Chinese help is too short for ${field.key}`)
  }
  for (const key of Object.values(TAB_HELP)) {
    assert.ok(rlmSettingsEn[key].length >= 40)
    assert.ok(rlmSettingsZh[key].length >= 20)
  }
})

test('M13 UX #75/#69: Save is one atomic revision-fenced mutation with no sequential fallback', () => {
  assert.match(cardSource, /props\.scope\.mutate\(buildMutation\(planned\), expectedRevision\)/)
  assert.doesNotMatch(cardSource, /props\.scope\.set\(/)
  assert.doesNotMatch(cardSource, /props\.scope\.unset\(/)
  assert.doesNotMatch(cardSource, /compatible\.mutate/)
})

test('M13 UX #75/#80: existing overrides can reset before another edit', () => {
  assert.match(cardSource, /dirty\.size > 0 \|\| overrides\.size > 0/)
  assert.match(cardSource, /resetState\(snapshot\.base/)
})

test('M13 UX #75: disabled plugin can still be preconfigured; only true dependencies disable fields', () => {
  assert.doesNotMatch(cardSource, /!props\.draft\.enabled/)
  assert.match(cardSource, /field === 'durableRoot' && !draft\.snapshotRecovery/)
  assert.match(cardSource, /field === 'maxQueryTokensPerCell' && !draft\.guardQueryTokens/)
})

test('M13 UX #75: card uses DSH aliases and no bespoke gradient mini-app styling', () => {
  assert.match(cardSource, /--dsw-alias-/)
  assert.doesNotMatch(cardSource, /linear-gradient/)
  assert.match(cardSource, /role="tablist"/)
  assert.match(cardSource, /role="tabpanel"/)
  assert.match(cardSource, /aria-controls=/)
})
