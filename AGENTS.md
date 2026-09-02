# dsh-rlm Agent Instructions

## Mission

Build the smallest working RLM loop for DeepSeek Harness:

```text
DSH Agent -> rlm_eval(code) -> Session Python kernel
  -> await rlm_query(prompt) -> one-shot DSH Subagent
  -> text returns to Python -> cell continues -> next rlm_eval can reuse globals
```

Do not add a second agent loop, public service, storage domain, checkpoint system,
recursive child RLM, UI, Workflow, Jobs, or provider framework before M1 passes in
a real clean DSH Profile.

## Development Rules

- Treat `docs/architecture.md`, `docs/directory-structure.md`,
  `docs/milestones.md`, and `docs/future-extensions.md` as the current product
  boundary.
- Keep the V1 source layout small:
  - `src/index.ts`
  - `src/runtime.ts`
  - `python-runtime/rlm_kernel.py`
  - `tests/rlm-loop.test.ts`
  - `tests/profile-smoke.test.ts`
- Add files only when one of the existing files becomes too large or a testable
  boundary truly appears.
- Prefer direct code over framework machinery. A short private helper is fine; a
  registry or public interface is not V1.
- Use installed `@deepseek-ai/*` package types as the execution authority. Do not
  guess DSH APIs from memory.
- Keep `ref/` read-only. Use it only as pinned design evidence.

## Implementation Order

1. Make the Python kernel execute one cell with persistent globals and top-level
   `await`.
2. Add the JSON-lines protocol between `src/runtime.ts` and `rlm_kernel.py`.
3. Register the single `rlm_eval` tool and route it by current DSH Session.
4. Bridge Python `rlm_query(prompt)` to a one-shot DSH Subagent, with `rlm_eval`
   disabled for the child.
5. Add bounded stdout/result output, per-cell query limit, timeout, cancellation,
   and dispose.
6. Prove the M1 loop in tests and in a clean DSH Profile using the configured
   `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC model path.

## Milestone Split

- M1A: Python kernel local loop. Prove persistent globals, top-level `await`, and
  typed errors without DSH.
- M1B: TypeScript runtime protocol. Prove process start, eval, result, error,
  timeout, and dispose.
- M1C: DSH tool registration. Prove `rlm_eval` appears only when enabled and uses
  the current agent/session authority.
- M1D: `rlm_query` bridge. Prove one-shot Subagent text returns to the active
  Python cell and the child cannot call `rlm_eval`.
- M1E: clean Profile smoke. Prove the full architecture path in a fresh DSH
  Profile and record the exact command/result.
- M2: local reliability baseline after M1 passes.

## PTC / Multi-Agent Coordination

- Follow the authoritative [GitHub Issue Repair Playbook](docs/issue-repair-playbook.md)
  for Issue-based repair, candidate, review, integration, and closure. A Chinese
  translation is available at
  [docs/issue-repair-playbook.zh-CN.md](docs/issue-repair-playbook.zh-CN.md).
- The coordinator owns `main`, integration, and final verification.
- Development agents may work only on a clearly assigned milestone slice and
  must report changed files, checks run, and any unverified assumption.
- Parallel work must have disjoint write scopes. Shared files are integrated
  serially by the coordinator.
- Use `DeepSeek-V4-Flash-Vision-Exp` through the configured vLLM/PTC path when
  dispatching implementation agents from the local DSH control surface.
- Assign reasoning effort by semantic risk: `high` is the code default; use
  `max` for architecture/root-cause decisions and final semantic review on
  concurrency, lifecycle, protocol, or security work. After that approach is
  frozen, bounded implementation normally returns to `high`. `medium` is
  limited to bounded support work. `low` must not edit production code, design
  tests, review, or issue acceptance verdicts. Never silently downgrade an
  active assignment.
- A model report is not completion. Completion needs committed code plus local
  checks and the clean Profile smoke required by the milestone.

## Development Memory Gate

- Follow [Development Memory](docs/development-memory/README.md). Its English
  version is authoritative; the Chinese translation is
  [docs/development-memory/README.zh-CN.md](docs/development-memory/README.zh-CN.md).
- Every agent that materially implements, repairs, designs tests, reviews, or
  performs live verification appends its own record to the Issue/workstream
  JSONL. The implementing agent owns later correction records for its work.
- Record at Candidate or handoff granularity, not per prompt, edit, command, or
  commit. Use durable symbol/test/heading pointers and exact evidence results.
- A coordinator may serially append another agent's returned record, but must
  preserve that agent's identity and may not claim its contribution.
- Existing record lines are immutable. Correct mistakes by appending a record
  with `correctsRecordId`; never edit, delete, or reorder history.
- Before commit, `pnpm check:memory:staged` must pass. Do not bypass the hook or
  weaken the CI range gate to make a Candidate green.

## Git Rules

- Commit small working slices. Do not batch future-feature scaffolding into M1.
- Before committing, run at least:
  - `pnpm typecheck`
  - `pnpm build`
- Run the focused tests for the touched milestone once they exist.
- Do not commit `lib/`, `node_modules/`, coverage output, logs, or `ref/*/source/`.
- Never rewrite published history unless the user explicitly asks.
- Preserve unrelated user changes. If a file has unexpected edits, read it before
  touching it.

## Clean Profile Verification

The first real acceptance target is a disposable DSH Profile that loads this
plugin from the local package, enables it, selects the configured
`DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC model route, and proves:

1. the plugin loads and unloads;
2. `rlm_eval` can read a local UTF-8 file into `context`;
3. `await rlm_query(...)` returns visible text and Python continues executing;
4. a second `rlm_eval` sees variables from the first cell;
5. the official Session log contains the tool calls and bounded results.

If this smoke cannot run, report the exact product blocker and keep improving the
nearest executable slice instead of creating more design documents.
