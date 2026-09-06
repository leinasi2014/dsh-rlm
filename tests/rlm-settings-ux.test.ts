import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RLM_FIELDS } from '../src/client/rlm-settings-model.ts'
import {
  FIELD_HINT,
  TAB_HELP,
  rlmSettingsEn,
  rlmSettingsZh,
} from '../src/client/rlm-settings-locales.ts'

const cardSource = readFileSync(new URL('../src/client/RlmSettingsCard.tsx', import.meta.url), 'utf8')

test('M13 UX #75: every user-facing field has detailed bilingual help', () => {
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

test('M13 UX #75/#69: Save is one revision-fenced atomic mutate with read-back verification', () => {
  assert.match(cardSource, /props\.scope\.mutate\(ops, expectedRevision\)/)
  assert.match(cardSource, /props\.scope\.getSnapshot\(\)/)
  assert.match(cardSource, /writesLanded\(accepted\.user, planned\)/)
  assert.doesNotMatch(cardSource, /await props\.scope\.(?:set|unset)\(/)
})

test('M13 UX #75/#80: existing overrides can be reset before the user makes another edit', () => {
  assert.match(cardSource, /dirty\.size > 0 \|\| overrides\.size > 0/)
  assert.match(cardSource, /resetState\(snapshot\.base/)
})

test('M13 UX #75: global enabled state does not disable every independent field', () => {
  assert.doesNotMatch(cardSource, /!props\.draft\.enabled/)
  assert.match(cardSource, /field === 'durableRoot' && !draft\.snapshotRecovery/)
  assert.match(cardSource, /field === 'maxQueryTokensPerCell' && !draft\.guardQueryTokens/)
})
