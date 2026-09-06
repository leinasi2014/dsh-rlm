from pathlib import Path
import re
import subprocess

OLD = 'origin/codex/issue-75-settings-ux'


def show(path: str) -> str:
    return subprocess.check_output(['git', 'show', f'{OLD}:{path}'], text=True, encoding='utf-8')


card = Path('src/client/RlmSettingsCard.tsx')
text = show('src/client/RlmSettingsCard.tsx')
text = text.replace(
    "import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'",
    "import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'",
)
text = text.replace("  buildWrites,\n  resetState,", "  buildWrites,\n  buildMutation,\n  resetState,")
text = text.replace("  type RlmFieldWrite,\n", "")
text = re.sub(
    r"\ntype SettingsMutationOp =\n  \| \{ op: 'set'; path: string\[\]; value: boolean \| number \| string \}\n  \| \{ op: 'unset'; path: string\[\] \}\n",
    "\n",
    text,
    count=1,
)

save_pattern = re.compile(
    r"  const save = \(\) => \{\n.*?\n  \}\n\n  if \(snapshot\.status === 'unavailable'\)",
    re.S,
)
new_save = """  const save = () => {
    if (!canSave || snapshot.revision === undefined) return
    const expectedRevision = snapshot.revision
    const planned = [...writes]
    void (async () => {
      dispatch({ type: 'begin' })
      try {
        // Issue #69 is the supported contract: one atomic, revision-fenced
        // namespace mutation. Never regress this UI to sequential field writes.
        await props.scope.mutate(buildMutation(planned), expectedRevision)
        setDirty(new Set())
        setStagedClear(new Set())
        dispatch({ type: 'succeed' })
      } catch {
        // Keep the staged draft so the user can inspect and retry.
        dispatch({ type: 'fail' })
      }
    })()
  }

  if (snapshot.status === 'unavailable')"""
text, n = save_pattern.subn(new_save, text, count=1)
if n != 1:
    raise SystemExit('Issue #75 save function anchor changed')

helpers_start = text.find('\nfunction mutationOps(')
helpers_end = text.find('\nfunction firstProblemKey(', helpers_start)
if helpers_start < 0 or helpers_end < 0:
    raise SystemExit('Issue #75 compatibility helpers not found')
text = text[:helpers_start] + text[helpers_end:]
card.write_text(text, encoding='utf-8')

Path('src/client/rlm-settings-locales.ts').write_text(show('src/client/rlm-settings-locales.ts'), encoding='utf-8')

Path('tests/rlm-settings-ux.test.ts').write_text("""import test from 'node:test'
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
  assert.match(cardSource, /props\\.scope\\.mutate\\(buildMutation\\(planned\\), expectedRevision\\)/)
  assert.doesNotMatch(cardSource, /props\\.scope\\.set\\(/)
  assert.doesNotMatch(cardSource, /props\\.scope\\.unset\\(/)
  assert.doesNotMatch(cardSource, /compatible\\.mutate/)
})

test('M13 UX #75/#80: existing overrides can reset before another edit', () => {
  assert.match(cardSource, /dirty\\.size > 0 \\|\\| overrides\\.size > 0/)
  assert.match(cardSource, /resetState\\(snapshot\\.base/)
})

test('M13 UX #75: disabled plugin can still be preconfigured; only true dependencies disable fields', () => {
  assert.doesNotMatch(cardSource, /!props\\.draft\\.enabled/)
  assert.match(cardSource, /field === 'durableRoot' && !draft\\.snapshotRecovery/)
  assert.match(cardSource, /field === 'maxQueryTokensPerCell' && !draft\\.guardQueryTokens/)
})

test('M13 UX #75: card uses DSH aliases and no bespoke gradient mini-app styling', () => {
  assert.match(cardSource, /--dsw-alias-/)
  assert.doesNotMatch(cardSource, /linear-gradient/)
  assert.match(cardSource, /role=\"tablist\"/)
  assert.match(cardSource, /role=\"tabpanel\"/)
  assert.match(cardSource, /aria-controls=/)
})
""", encoding='utf-8')

package = Path('package.json')
pkg = package.read_text(encoding='utf-8')
anchor = 'tests/rlm-settings-manifest.test.ts tests/rlm-python-resolution.test.ts'
replacement = 'tests/rlm-settings-manifest.test.ts tests/rlm-settings-ux.test.ts tests/rlm-python-resolution.test.ts'
if replacement not in pkg:
    if pkg.count(anchor) != 1:
        raise SystemExit('package test command anchor changed')
    pkg = pkg.replace(anchor, replacement, 1)
package.write_text(pkg, encoding='utf-8')

memory = Path('docs/development-memory/records/2026/issue-75.jsonl')
memory.parent.mkdir(parents=True, exist_ok=True)
memory.write_text('''{"schemaVersion":1,"recordId":"mem-20260906-issue75-clean-ui-replay","recordedAt":"2026-09-06T22:11:00+08:00","agent":{"name":"chatgpt-ui-implementer","id":"chatgpt-ui-implementer","model":"GPT-5.6 Sol","role":"implementer","reasoning":"high"},"issue":75,"workItem":"issue-0075","baseCommit":"58119a125f26c87b2493f604e9d0a46f4fbc6960","candidateRef":"same-commit","summary":"Replay the previously tested simple-first settings UI on the current shared-manifest stack while preserving the merged Issue #69 atomic mutation contract and removing the obsolete sequential-write compatibility fallback.","files":[{"path":"src/client/RlmSettingsCard.tsx","pointers":["simple-first tabs","DSH alias tokens","dependencyOf","atomic save","discard/reset footer"]},{"path":"src/client/rlm-settings-locales.ts","pointers":["detailed en/zh field help","TAB_HELP"]},{"path":"tests/rlm-settings-ux.test.ts","pointers":["bilingual help","atomic save","preconfiguration","DSH styling/accessibility"]},{"path":"package.json","pointers":["scripts.test UX regression"]}],"steps":["Copied only the reviewed UI/card and locale copy from the stale Issue #75 branch onto the corrected Issue #73 shared-manifest stack.","Replaced the old optional mutate/sequential set-unset compatibility path with the current Issue #69 contract: buildMutation plus one revision-fenced SettingsScope.mutate call.","Kept simple-first General/Limits/Recovery & safety/Token guard navigation, DSH alias tokens, readable units, detailed bilingual help, Save/Discard/Reset and true dependency disabling only.","Added source-level regression guards that forbid sequential setting writes and bespoke gradient styling."],"evidence":[{"kind":"test","target":"old Issue #75 candidate CI 34006899788","result":"PASS","note":"The earlier visual/copy candidate typechecked, built and passed its full baseline tests before later main changes."},{"kind":"test","target":"current stacked Windows+Ubuntu CI","result":"NOT_RUN","note":"Final replay acceptance is pending after this commit."}],"limitations":["No browser/computer renderer is available in this execution environment, so manual light/dark and narrow/desktop visual click-through remains unclaimed; static DSH-token/responsive/accessibility checks are automated."]}
''', encoding='utf-8')

Path('scripts/issue75-replay.py').unlink()
Path('.github/workflows/issue-75-replay-ui-v2.yml').unlink()
