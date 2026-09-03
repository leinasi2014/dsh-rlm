# dsh-rlm Agent Instructions

## Mission

Build the smallest working RLM loop for DeepSeek Harness:

```text
DSH Agent -> rlm_eval(code) -> Session Python kernel
  -> await rlm_query(prompt) -> one-shot DSH Subagent
  -> text returns to Python -> cell continues -> next rlm_eval can reuse globals
```

M1–M5 are delivered. Extend the same loop in strict order: M6 Manual Reset,
then M7 Batched Query, then M8 Continuable Spawn. Do not add a second agent
loop, public service, Storage Domain, host-restart persistence, UI, Workflow,
Jobs, or provider framework.

## Development Rules

- Treat `docs/architecture.md`, `docs/directory-structure.md`,
  `docs/milestones.md`, and `docs/future-extensions.md` as the current product
  boundary.
- For M6, also treat `docs/m6-manual-reset.md` and
  `docs/m6-development-contract.md` as binding; English is authoritative and
  each has a Chinese mirror. M3/M4/M5 documents remain binding for their owned
  boundaries.
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

## Official DSH Upstream Gate

- Before changing production code or tests for any work item, point
  `RLM_DSH_REPO_ROOT` at the selected DSH source checkout and run
  `pnpm check:upstream`.
- The fixed source-freshness authority is
  `https://github.com/deepseek-ai/deepseek-harness.git:master`; installed or
  published `@deepseek-ai/*` types and the exact loaded Profile runtime remain
  the executable compatibility authorities.
- A stale, diverged, wrong, unreachable, or tracked-dirty DSH checkout is not
  ready for mutation. `ref/` remains pinned prior art, never freshness evidence.
- Follow the authoritative [GitHub Issue Repair Playbook](docs/issue-repair-playbook.md#41-official-dsh-upstream-authority-gate)
  for evidence, artifact mapping, failure handling, and final live re-checks.

## Architecture Contract and TDD

- Freeze the affected architecture contract before production edits: observable
  behavior, state and ownership boundaries, failure semantics, byte/time/resource
  limits, compatibility, and explicit non-goals. Resolve material uncertainty
  against the current code, installed DSH types, and pinned `ref/` evidence.
- Bug repair defaults to strict test-driven development:
  1. **RED:** add the smallest regression test or executable reproduction and
     prove that it fails for the intended reason on the accepted base/candidate;
  2. **GREEN:** make the smallest causal production change that passes that test;
  3. **REFACTOR:** improve structure only while the focused and representative
     checks remain green;
  4. **FULL GATE:** run the required build, full tests, memory gate, independent
     review, integration read-back, and real-boundary checks.
- New features start with a thin architecture contract and a user-observable
  acceptance example. Once the example is testable, implement each behavior with
  the same RED -> GREEN -> REFACTOR loop.
- Do not write a ceremonial test for documentation-only work, exploratory spikes,
  or a live boundary that cannot yet be automated. Preserve a repeatable failing
  observation first, then add the nearest useful automated regression as soon as
  the contract is executable.
- A test that passes before the fix is not RED evidence. Do not weaken assertions,
  broaden timeouts, or test a mock-only path when the defect crosses a real process,
  protocol, Session, or Profile boundary.

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
7. M3–M5 are accepted on `main`; preserve their contract boundaries.
8. Implement M6 only after its docs slice is integrated: use strict TDD to
   reset only the current Session through the existing `rlm_eval` path, after
   the queue-ordered kernel/child cleanup barrier and M5 checkpoint deletion.
9. Start M7 only after M6 acceptance; start M8 only after M7 acceptance.

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
- M3: managed absolute UTF-8 context loading with atomic Session-local state.
- M4: depth-bounded recursive child DSH Sessions with isolated RLM kernels.
- M5: opt-in, private runtime checkpoint recovery after eligible kernel loss.
- M6: explicit FIFO Session-local reset through the existing `rlm_eval` tool.
- M7: bounded ordered concurrent `rlm_query_batched`.
- M8: official continuable child DSH Sessions with inbox delivery.

## PTC / Multi-Agent Coordination

- Follow the authoritative [GitHub Issue Repair Playbook](docs/issue-repair-playbook.md)
  for Issue-based repair, candidate, review, integration, and closure. A Chinese
  translation is available at
  [docs/issue-repair-playbook.zh-CN.md](docs/issue-repair-playbook.zh-CN.md).
- The coordinator owns `main`, integration, and final verification.
- Development agents may work only on a clearly assigned milestone slice and
  must report changed files, checks run, and any unverified assumption.
- Every implementation or repair dispatch states its current TDD phase and the
  frozen contract. Test-only RED work must not edit production files; GREEN work
  must not silently expand the contract. A review finding that changes behavior
  creates a successor RED before the next production correction.
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
- During M6–M8, dogfood the latest completed plugin through a real clean DSH
  Profile with the local package installed and the configured vLLM/PTC route.
  Aggregate incidental findings, reproduce and classify them, then create a
  separate GitHub Issue; do not opportunistically fold them into the active
  milestone unless they block its acceptance.

## Execution Access Policy

- Classify access before every DSH dispatch. Use `Read Only` only after
  confirming that the entire assignment will not modify files, Git state,
  configuration, Profiles, processes, ports, build/test artifacts, or external
  state.
- Start every other assignment in `Full Access`, including implementation,
  repair, test/build execution, integration, clean-Profile verification, and
  task-owned artifact cleanup. Do not start write-capable work in a restricted
  mode and depend on repeated mid-task approvals.
- `Full Access` grants execution capability, not broader authority. Owned paths,
  forbidden scope, destructive-action safeguards, credential rules, the ban on
  DSH API shortcuts, and push/merge/release limits still apply.
- If a read-only assignment later needs mutation, stop it and issue a new
  explicitly scoped `Full Access` assignment. A reviewer that becomes a fixer
  is no longer the independent reviewer for that candidate.
- Record and read back the selected access mode with the workspace, base,
  model, runtime, reasoning level, and write scope before the first prompt.

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
6. with `snapshotRecovery=true`, a timeout/crash starts a new kernel and the
   next same-Session `rlm_eval` restores supported state without exposing
   checkpoint values or context text in the model-visible log.

If this smoke cannot run, report the exact product blocker and keep improving the
nearest executable slice instead of creating more design documents.
