# GitHub Issue Repair Playbook

> English authority | [简体中文](issue-repair-playbook.zh-CN.md)

This playbook governs corrective work for the public `dsh-rlm` repository. It
keeps repairs small, traceable, independently reviewable, and bound to executable
evidence. It does not authorize new product scope, release, destructive cleanup,
or external mutation beyond the assigned Issue.

## 1. Repair objective

Close an Issue only after its accepted change is present on authoritative
`main`, target-level CI passes, required real-boundary evidence passes, and all
task-owned processes and workspaces are reconciled.

The M2 repair program must preserve the V1 architecture: one `rlm_eval` tool,
one Session-local Python kernel, one one-shot `rlm_query` bridge, the official
DSH Agent Loop and Session log as authority, and no public Service, Storage,
snapshot system, recursive child RLM, or second Agent Loop.

## 2. Reasoning-effort policy

Reasoning effort is assigned by semantic risk, not by agent name or task length.
Every dispatch records its level explicitly. An executor must not silently
downgrade it.

| Level | Use | Never use for |
|---|---|---|
| `max` | Architecture/contract decisions; concurrency, ordering, cancellation, timeout, process lifecycle, protocol/adversarial limits, credentials/security; unresolved root-cause analysis; clean-Profile failure classification; final integrated M2 review | Polling, formatting, routine status updates |
| `high` | Default for bounded implementation, test-oracle design, code review, integration/conflict resolution, plugin/configuration behavior | Purely mechanical maintenance that has no semantic choice |
| `medium` | Deterministic test coding after the oracle is fixed, documentation, Issue/PR evidence comments, known mechanical corrections | Architecture, security, lifecycle, concurrency, acceptance verdicts |
| `low` | Waiting/polling, formatting, label changes, exact transcription, and other non-semantic clerical work | Any production code edit, test design, root-cause decision, review, QA verdict, integration decision, or live acceptance |

Project defaults:

- `high` is the default for code work.
- Issues #1, #2, #3, #4, and #7 use `max` for root-cause/contract decisions and
  independent semantic review; once the approach is frozen, their bounded code
  implementation uses `high` by default.
- Issues #5 and #6 use `high`; escalate to `max` if the implementation changes
  lifecycle/authority boundaries or the first semantic correction fails.
- The final combined M2 audit and real clean-Profile acceptance use `max`.
- A reviewer may not use a lower level than the author for the same semantic
  surface.
- One unexpected semantic failure escalates the next correction by one level.
  Two repeated failures without new evidence stop mutation and trigger a
  coordinator-led, reference-first re-scope at `max`.
- Downgrade only by splitting completed semantic work from a new, purely
  mechanical package. Never downgrade an in-flight semantic assignment.

If `DeepSeek-V4-Flash-Vision-Exp` is unavailable, do not change model or effort
level. Stop dependent dispatch, preserve task/candidate identity, detect and wait
for recovery, then resume only the missing work at the assigned level.

## 3. One Issue, one repair pipeline

Use one stable pipeline for each independently acceptable Issue:

```text
OPEN -> REPRODUCED -> IMPLEMENTING -> CANDIDATE
     -> REVIEWED -> ACCEPTED -> INTEGRATED -> VERIFIED -> CLOSED
```

`CANDIDATE`, `REVIEWED`, and `ACCEPTED` are not completion. A content change
creates a new candidate. An accepted candidate must be integrated immediately or
reported as `INTEGRATION_BLOCKED` with its exact candidate, target, owner, and
blocker.

## 4. Ready gate

Before mutation, bind:

```yaml
issue: "#<number>"
base: "<full origin/main SHA>"
branch: "codex/issue-<number>-<slug>"
workspace: "<absolute owned worktree or controlled environment>"
session: "<DSH workspace/team/Session identity>"
model: "DeepSeek-V4-Flash-Vision-Exp"
runtime: "vLLM/PTC"
reasoning: "medium | high | max"
access: "Read Only | Full Access"
access_basis: "<why the complete assignment is no-mutation or needs full execution>"
writer: "<single writer identity>"
reviewer: "<non-author identity>"
owned_paths: []
mutable_scope: [] # Git/config/Profile/process/port/external resources authorized by the task
forbidden_scope: []
acceptance_tests: []
memory_stream: "docs/development-memory/records/<year>/issue-<number>.jsonl"
first_material_event: "<failing reproduction or exact blocker>"
```

The work is ready only when the Issue outcome and non-goals are testable, the
base and worktree state are known, access and mutable scope match the complete
assignment, dependencies are explicit, writer/reviewer and integration capacity
exist, and no other writer owns the same mutable surface.

## 5. DSH/PTC control-surface rules

When dispatching through the local DSH control surface:

- use the in-app browser at `http://127.0.0.1:49321/` through real UI actions;
- never use the page's API as an implementation shortcut;
- keep one tab only, close it when finished, and reopen only when needed;
- use `Read Only` only for an assignment confirmed to make no file, Git,
  configuration, Profile, process, port, build/test-artifact, or external-state
  change;
- start implementation, repair, test/build, integration, live verification,
  and task-owned cleanup assignments in `Full Access`; do not rely on repeated
  approval escalation after work has started;
- treat `Full Access` as execution capability, not expanded authorization:
  assigned paths, non-goals, destructive-action safeguards, credential
  boundaries, and push/merge/release limits remain unchanged;
- if a read-only task discovers a required mutation, stop and redispatch it
  with explicit write scope and `Full Access`; a reviewer that becomes a fixer
  loses independence for that candidate;
- before the first prompt, read back candidate/base, workspace, team/Session,
  model, vLLM/PTC route, reasoning effort, access mode, and write scope;
- keep model-facing development and acceptance state isolated per candidate;
- do not treat an agent report as code, review, integration, or acceptance proof.

## 6. Repair loop

### 6.1 Reproduce first

Before editing production code, obtain at least one of:

- a regression test that fails on the accepted base;
- a deterministic minimal reproduction;
- process PID/state evidence;
- a typed error or authoritative terminal-state mismatch;
- a candidate-bound real DSH observation.

No reproduction means no implementation. Preserve a failed real attempt as
evidence; never patch that running attempt into a passing state.

### 6.2 Reference-first decision

Inspect the affected implementation/tests, `ref/rlm`, and `ref/prime-agent` for
the same lifecycle, ordering, cancellation, protocol, or namespace mechanism.
Record one conclusion in the Issue:

```text
directly reusable | reusable through a small adapter
contradicts current dsh-rlm architecture | mechanism absent
```

Use authoritative upstream sources only when local and pinned references leave a
material uncertainty. Do not copy a reference daemon, Storage model, old frame
names, or second authority merely because it solves a similar symptom.

### 6.3 Implement the smallest correction

- Change only the Issue's owned surface and acceptance behavior.
- Prefer direct code and small private helpers over frameworks or registries.
- Do not weaken assertions, delete tests, hide failures, or inflate timeouts to
  manufacture green results.
- Open a separate Issue for unrelated scope.
- Never commit `lib/`, `node_modules/`, Profiles, Session logs, credentials,
  coverage, logs, or `ref/*/source/`.

### 6.4 Author proof

Every candidate runs:

```bash
pnpm typecheck
pnpm build
node --test tests/rlm-loop.test.ts tests/profile-smoke.test.ts
```

It also runs focused positive and negative tests for the changed contract. Use
PID/process-tree probes for lifecycle work, oversized and multi-byte fixtures for
protocol work, timeout/cancel/late-result cases for query work, reserved-name and
exceptional-`repr()` cases for kernel work, sentinel secrets for environment
isolation, and schema/prompt lifecycle checks for plugin configuration.

Report each check as `PASS`, `FAIL`, `FLAKY`, `NOT_RUN`, or `NOT_CONFIGURED`.
Each materially participating agent appends its own record to the Issue's
development-memory stream. The record names its files and semantic pointers,
steps, evidence, and limitations; the coordinator does not impersonate authors.

### 6.5 Freeze and review

Freeze one candidate packet:

```text
Issue, base SHA, candidate SHA, changed paths,
focused checks, full checks, development-memory record IDs,
documentation impact, known limitations
```

The independent reviewer is read-only and checks the exact candidate for root
cause, current-architecture alignment, failure/cleanup behavior, security and
Session isolation, reference use, regression quality, and claim ceiling.
Blocking findings create a successor candidate. Use delta review unless the
architecture or security boundary changed.

## 7. Git and PR rules

- Branch: `codex/issue-<number>-<slug>`.
- Use Conventional Commits, for example
  `fix(runtime): terminate kernels on protocol faults`.
- Keep commits as small working slices; do not combine all M2 Issues into one
  commit or PR.
- Preserve unrelated changes and never rewrite published history without
  explicit user authorization.
- One Issue normally maps to one PR. The PR body contains `Closes #N` and:

```markdown
## Problem
## Root cause
## Reference decision
## Implementation
## Acceptance mapping
## Tests
## Security / lifecycle impact
## Remaining limitations
```

The PR also lists every participating development-memory `recordId`. Existing
JSONL lines are append-only evidence and must never be rewritten during review.

## 8. Concurrency and integration

Use shared-authority mode for `runtime.ts`, `rlm_kernel.py`, and shared tests:
one writer owns the moving surface while QA/oracle design, read-only reference
analysis, and review preparation may proceed in parallel. Separate worktrees do
not permit two writers to change the same semantic authority.

Integrate PRs serially. After required proof and review pass, the next action is
integration against the expected `main`, remote result read-back, and target CI.
Do not pull a dependent repair first.

Recommended dependency order:

1. #1 kernel lifecycle;
2. #5 scaffold and result isolation;
3. #3 bounded protocol;
4. #4 query/child lifecycle;
5. #2 Session serialization;
6. #7 Python environment isolation;
7. #6 configuration and system prompt.

Read-only investigation and test design may overlap; mutable integration remains
serial.

## 9. Close criteria

Close an Issue only when:

- every acceptance item is mapped to evidence;
- a regression fails on the accepted base and passes on the candidate;
- the required independent review passes;
- the PR is merged and the remote `main` result is read back;
- target-branch CI passes;
- required clean-Profile evidence passes;
- no owned Python process, Subagent, worktree, or dirty state remains;
- public/security/architecture documentation is updated or explicitly
  `not-needed`.
- every material contributor's development-memory record is present and its ID
  is linked from the Candidate/PR evidence.

Post this final Issue comment:

```text
Integrated candidate: <SHA>
Main result: <SHA>
CI: <URL>
Focused tests: PASS
Full offline suite: PASS
Live Profile smoke: PASS | NOT_REQUIRED
Process/resource cleanup: PASS
Documentation: updated | not-needed
Residual risk: none | <exact limitation>
```

The M2 milestone closes only after all seven Issues are verified on `main` and a
fresh Profile loads the exact built candidate, exercises the full RLM loop,
proves isolation/bounds/cleanup/configuration, and records authoritative Session
evidence.
