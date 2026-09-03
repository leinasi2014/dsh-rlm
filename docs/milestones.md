# Milestones

> English | [简体中文](milestones.zh-CN.md)

Milestones define capability order and exit criteria, not live status, dates,
or owners. Completion is determined by executable results—not file count,
design volume, or lines of code.

## M1: RLM and self-iteration loop

**Outcome:** In a real DSH Profile, an Agent uses `rlm_eval` to read a local
file, calls a one-shot Subagent from Python, continues execution, reuses the
variables in a second cell, and returns the final answer.

**Included:**

- host-only function plugin and the only tool, `rlm_eval`;
- one persistent Python kernel per Session;
- top-level `await`, `rlm_query`, and bounded output;
- visible text returned from one-shot queries;
- concise system prompt;
- one automated loop test and one real Profile smoke.

**Exit criteria:**

1. The plugin builds, loads, and unloads in the target Profile.
2. The first cell reads a UTF-8 file from an absolute path into `context`.
3. Python continues after at least one `rlm_query` result.
4. A second `rlm_eval` reads variables from the first cell.
5. The Agent returns an answer based on the revised result.
6. Both tool calls and bounded results appear in the official Session log.
7. Child agents and Python processes are disposed at test completion.

Before M1 passes, do not implement snapshot, spawn, Storage, a public Service,
or a second Provider.

## M2: Local reliability baseline

**Outcome:** The core loop stops explicitly under common faults without leaking
processes or cross-Session state.

**Exit criteria:**

1. Two Sessions have isolated globals.
2. Concurrent cells in one Session are serialized.
3. Timeout or cancellation kills only the owning Session process tree and
   reports namespace loss.
4. The next `rlm_eval` starts a clean kernel.
5. Oversized output and protocol frames fail or truncate explicitly.
6. Queries beyond the per-cell limit are rejected.
7. No plugin-owned Python process survives plugin unload.

## M3: Managed Context

**Outcome:** `rlm_eval(code, contextPath?)` atomically loads one bounded,
absolute UTF-8 file into protected Session-local `context` without copying its
contents through the model-visible tool input.

**Exit criteria:**

1. Omitting `contextPath` is backward compatible with M1/M2.
2. The same cell sees the loaded context and later cells reuse it.
3. Other Sessions cannot see it, and cell code cannot permanently replace the
   protected `context` or `context_meta` values.
4. Invalid path, target type, size, UTF-8, and read-race failures are typed and
   atomic: the prior live kernel/context remains intact.
5. Protocol version mismatch fails explicitly; file bytes never appear in a
   host-side frame, model-visible tool input, or tool result.
6. Unit/integration tests, independent review, CI, remote-main read-back, and a
   clean DSV4-FVE Profile smoke pass.

See [M3 architecture](m3-managed-context.md).

## M4: Recursive Child RLM

**Outcome:** `rlm_query` can start an official, depth-bounded child DSH Session
that owns its own `rlm_eval` kernel below the cap, while the leaf at the cap
retains one-shot tool denial.

**Exit criteria:**

1. `maxDepth=1` preserves the delivered M1/M2 behavior.
2. Depth-2 and depth-3 paths complete through official DSH Subagent/Session
   APIs and return visible text to the parent Python cell.
3. The official depth cap prevents deeper children and provider capability
   absence fails before partial recursive work begins.
4. Parent, child, sibling, and descendant Python namespaces are isolated while
   official Session metadata/logs preserve lineage.
5. Timeout, cancellation, protocol failure, and plugin unload quiesce the whole
   owned descendant branch without affecting unrelated Sessions.
6. Unit/integration tests, independent review, CI, remote-main read-back, and
   clean DSV4-FVE depth-2/depth-3 Profile smokes pass.

See [M4 architecture](m4-recursive-child-rlm.md).

## M5: Session Snapshot Recovery

**Outcome:** When explicitly enabled, the existing `rlm_eval` path restores the
last valid, supported Session checkpoint after an owned timeout, crash, or
fatal protocol loss, before the next cell executes.

**Exit criteria:**

1. `snapshotRecovery=false` retains M2 namespace-loss behavior exactly.
2. Eligible fatal loss creates a new PID and restores only bounded JSON-safe
   globals and protected M3 context for the same Session.
3. Checkpoint publication is atomic; corrupt, oversized, or partial candidates
   never replace a valid checkpoint, and invalid recovery fails closed.
4. Cancellation, reset, unload, host restart, sibling, and recursive child
   boundaries cannot restore an unrelated or stale checkpoint.
5. Values and context text never appear in model-visible protocol data or
   recovery metadata; skipped values are reported only as bounded summaries.
6. Unit/integration tests, independent review, CI, remote-main read-back, and
   a clean installed-plugin DSV4-FVE Profile smoke pass.

See [M5 architecture](m5-session-snapshot-recovery.md) and the
[M5 delivery contract](m5-development-contract.md).

## M6: Manual Reset

**Outcome:** `rlm_eval({ reset: true })` explicitly discards only the current
Session's RLM kernel, managed context, and private M5 checkpoint through the
existing FIFO lifecycle path.

**Exit criteria:**

1. Existing code-bearing `rlm_eval` calls remain backward compatible; reset is
   mutually exclusive with code and context input.
2. Reset is ordered behind earlier accepted same-Session work and acknowledges
   only after the existing kernel/child cleanup barrier completes.
3. The next same-Session eval has a fresh PID and cannot read old globals,
   managed context, or an old M5 checkpoint.
4. Cancellation, unload, siblings, parents, and recursive children do not
   cause cross-Session reset or stale-state recovery.
5. Unit/integration tests, independent review, CI, remote-main read-back, and
   a clean installed-plugin DSV4-FVE Profile smoke pass.

See [M6 architecture](m6-manual-reset.md) and the
[M6 delivery contract](m6-development-contract.md).

## M7: Bounded Ordered Batched Query

**Outcome:** Python code can call `await rlm_query_batched(prompts)` inside the
existing Session kernel. At most four ordinary DSH child queries are active for
one batch; successful text returns in input order.

**Exit criteria:**

1. Invalid input starts no child; empty input returns an empty list.
2. Out-of-order child completion and duplicate prompts still yield an exactly
   input-ordered result list.
3. The observed per-batch active-child count never exceeds four; existing
   `maxQueries`, byte limits, depth rules, and child tool denial remain intact.
4. An item error stops new admission, drains admitted children, then returns one
   deterministic typed failure without poisoning the next cell.
5. Cancellation, timeout, reset, and unload quiesce all admitted work and M5
   never serializes helper bookkeeping as user state.
6. Unit/integration tests, independent review, CI, remote-main read-back, and
   a clean installed-plugin Profile smoke pass.

See [M7 architecture](m7-batched-query.md) and the
[M7 delivery contract](m7-development-contract.md).

## M8: Continuable Spawn

Start M8 only after M7 is accepted on `main` and its matching trigger in
[Future extensions](future-extensions.md) is real.

Issue #39 now freezes the thin contract: private Python spawn/follow-up helpers
reuse the official continuable Subagent manager and its parent inbox; they do
not return child answers or create a plugin queue. See
[M8 architecture](m8-continuable-spawn.md) and the
[M8 delivery contract](m8-development-contract.md).
