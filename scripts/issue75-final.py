from pathlib import Path
import subprocess

SOURCE = 'origin/codex/issue-75-settings-ux-v2'


def show(path: str) -> str:
    return subprocess.check_output(['git', 'show', f'{SOURCE}:{path}'], text=True, encoding='utf-8')

for path in [
    'src/client/RlmSettingsCard.tsx',
    'src/client/rlm-settings-locales.ts',
    'tests/rlm-settings-ux.test.ts',
]:
    Path(path).write_text(show(path), encoding='utf-8')

package = Path('package.json')
text = package.read_text(encoding='utf-8')
anchor = 'tests/rlm-settings-manifest.test.ts tests/rlm-python-resolution.test.ts'
replacement = 'tests/rlm-settings-manifest.test.ts tests/rlm-settings-ux.test.ts tests/rlm-python-resolution.test.ts'
if replacement not in text:
    if text.count(anchor) != 1:
        raise SystemExit('package test anchor changed')
    text = text.replace(anchor, replacement, 1)
package.write_text(text, encoding='utf-8')

memory = Path('docs/development-memory/records/2026/issue-75.jsonl')
memory.parent.mkdir(parents=True, exist_ok=True)
memory.write_text('''{"schemaVersion":1,"recordId":"mem-20260906-issue75-final-ui","recordedAt":"2026-09-06T22:39:00+08:00","agent":{"name":"chatgpt-ui-implementer","id":"chatgpt-ui-implementer","model":"GPT-5.6 Sol","role":"implementer","reasoning":"high"},"issue":75,"workItem":"issue-0075","baseCommit":"28bfa9348be03076e92cca00453aa14593f5c94f","candidateRef":"same-commit","summary":"Final clean replay of the simple-first M13 settings UI on main after Issue #73 landed, preserving Issue #69 atomic revision-fenced save semantics.","files":[{"path":"src/client/RlmSettingsCard.tsx","pointers":["General/Limits/Recovery & safety/Token guard tabs","DSH alias tokens","dependencyOf","scope.mutate(buildMutation(...), revision)","Save/Discard/Reset"]},{"path":"src/client/rlm-settings-locales.ts","pointers":["detailed en/zh field help","tab help","human-readable option labels"]},{"path":"tests/rlm-settings-ux.test.ts","pointers":["bilingual help","atomic save no fallback","preconfiguration/dependencies","DSH styling/accessibility"]},{"path":"package.json","pointers":["scripts.test includes rlm-settings-ux.test.ts"]}],"steps":["Replayed only the three Issue #75 UI/test files from the successful stacked v2 implementation onto the post-#73 main; no old branch history or settings-manifest changes were copied.","Kept the current SettingsScope import and Issue #69 contract: one buildMutation op list through one revision-fenced mutate call; no sequential set/unset compatibility fallback.","Retained simple-first tab grouping, DSH theme aliases, detailed bilingual explanations, human-readable units, disabled-plugin preconfiguration, true dependency disabling, and Save/Discard/Reset actions."],"evidence":[{"kind":"test","target":"old Issue #75 candidate CI 34006899788","result":"PASS","note":"Earlier visual/copy implementation typechecked, built and passed its then-current full test suite."},{"kind":"test","target":"stacked v2 replay workflow 34037486620","result":"PASS","note":"The current atomic-save UI material was successfully generated on the Issue #73 stack."},{"kind":"test","target":"final Windows+Ubuntu PR CI","result":"NOT_RUN","note":"Must pass before merge."}],"limitations":["No browser/computer renderer is available here, so manual visual click-through in real DSH light/dark and narrow/desktop layouts is not claimed; static DSH-token, responsive layout and ARIA checks are automated."]}
''', encoding='utf-8')

Path('scripts/issue75-final.py').unlink()
Path('.github/workflows/issue-75-final.yml').unlink()
