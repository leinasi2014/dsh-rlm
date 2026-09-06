from pathlib import Path
import subprocess

BASE = '28bfa9348be03076e92cca00453aa14593f5c94f'
SOURCE = 'origin/codex/issue-67-snapshot-io-v2'
paths = ['src/runtime.ts', 'tests/rlm-snapshot-io.test.ts', 'scripts/benchmark-snapshot.ts']
patch = subprocess.check_output(['git', 'diff', f'{BASE}...{SOURCE}', '--', *paths])
if not patch:
    raise SystemExit('Issue #67 material diff is empty')
Path('/tmp/issue67-final.patch').write_bytes(patch)
subprocess.run(['git', 'apply', '--check', '/tmp/issue67-final.patch'], check=True)
subprocess.run(['git', 'apply', '/tmp/issue67-final.patch'], check=True)

package = Path('package.json')
text = package.read_text(encoding='utf-8')
bench = '    "bench:snapshot": "node scripts/benchmark-snapshot.ts",\n'
if bench not in text:
    anchor = '    "check:upstream": "node scripts/check-dsh-upstream.mjs",\n'
    if text.count(anchor) != 1:
        raise SystemExit('package scripts anchor changed')
    text = text.replace(anchor, anchor + bench, 1)
if 'tests/rlm-snapshot-io.test.ts' not in text:
    anchor = 'tests/rlm-durable-integrity.test.ts tests/profile-smoke.test.ts'
    replacement = 'tests/rlm-durable-integrity.test.ts tests/rlm-snapshot-io.test.ts tests/profile-smoke.test.ts'
    if text.count(anchor) != 1:
        raise SystemExit('package test anchor changed')
    text = text.replace(anchor, replacement, 1)
if 'tests/rlm-settings-ux.test.ts' not in text:
    raise SystemExit('post-#75 UI test entry disappeared; refusing replay')
package.write_text(text, encoding='utf-8')

memory = Path('docs/development-memory/records/2026/issue-67.jsonl')
memory.parent.mkdir(parents=True, exist_ok=True)
memory.write_text('''{"schemaVersion":1,"recordId":"mem-20260906-issue67-final-ui-main","recordedAt":"2026-09-06T22:55:00+08:00","agent":{"name":"chatgpt-snapshot-perf","id":"chatgpt-snapshot-perf","model":"GPT-5.6 Sol","role":"implementer","reasoning":"high"},"issue":67,"workItem":"issue-0067","baseCommit":"3267ea5425b9ef2a6aa4fed69ef9dee4399c563b","candidateRef":"same-commit","summary":"Final clean replay of Issue #67 onto post-#75 main: corrected asynchronous snapshot/durable publication, validated chunk Buffer reuse, safe hash+fingerprint dedup, tests, and benchmark without overwriting the newly merged UI test entry.","files":[{"path":"src/runtime.ts","pointers":["async checkpoint commit","takeCommittedCheckpointPayload","async restore read","async publishDurable","hash+fingerprint dedup","runEntry Buffer reuse"]},{"path":"tests/rlm-snapshot-io.test.ts","pointers":["durable no-rewrite dedup","settle/restorable barrier","hot-path sync I/O guard"]},{"path":"scripts/benchmark-snapshot.ts","pointers":["repeatable ephemeral/durable benchmark"]},{"path":"package.json","pointers":["bench:snapshot","snapshot I/O test while preserving rlm-settings-ux test"]}],"steps":["Replayed the corrected v2 runtime/test/benchmark diff relative to the pre-#75 main onto current post-#75 main.","Merged package scripts semantically instead of replaying the old package file, preserving tests/rlm-settings-ux.test.ts.","Included the compile-only v2 corrections: removed unused sync fs imports and narrowed lstat return types with NonNullable.","Kept #88 traversal bounding unchanged; this candidate only addresses remaining Host hot-path I/O/dedup work."],"evidence":[{"kind":"test","target":"v2 guarded runtime patch workflow 34037971417","result":"PASS","note":"Async/dedup production transformation matched its anchors."},{"kind":"test","target":"v2 compile correction workflow 34038402636","result":"PASS","note":"Compile-only correction applied successfully."},{"kind":"test","target":"final clean replay git apply --check","result":"PASS","note":"Corrected Issue #67-only runtime/test/benchmark patch applies to post-#75 main."},{"kind":"test","target":"final Windows+Ubuntu PR CI","result":"NOT_RUN","note":"Must pass before merge."}],"limitations":["Benchmark has no CI threshold and no numbers are claimed until explicitly executed.","Startup rescan/reset cleanup remain synchronous because they are outside the repeated per-cell hot path."]}
''', encoding='utf-8')

Path('scripts/issue67-final.py').unlink()
Path('.github/workflows/issue-67-final.yml').unlink()
