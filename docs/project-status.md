# Project Status

> English | [简体中文](project-status.zh-CN.md)

This document records the accepted implementation boundary and the next ordered
milestones. GitHub Issues, [Milestones](milestones.md), and executable tests
jointly define live progress.

## Goal

Deliver the smallest verifiable RLM loop for DeepSeek Harness:

```text
DSH Agent -> rlm_eval(code) -> Session Python kernel
  -> await rlm_query(prompt) -> one-shot DSH Subagent
  -> text returns to Python -> cell continues
  -> next rlm_eval reuses globals
```

The target boundary keeps the DSH Session log as the model-visible history
authority and keeps Provider credentials in the host. Python executes code,
holds Session-local globals, and asks the host for child calls.

## Publication baseline

- Accepted milestone ladder: M1 through M8 on `main`.
- Status date: 2026-09-04
- Pinned references: `ref/rlm` and `ref/prime-agent`, used as design evidence,
  not literal compatibility targets
- DSH source-freshness evidence for M8: official `master` at
  `76fda729799fe9b3848dbe2c211d4b231032b81e` (ahead=0 behind=0) with the loaded
  Profile runtime exercising the official continuable Subagent adapter
- Current stage: M1-M7 are accepted baselines; M8 Continuable Spawn (Issue #39)
  is accepted on `main` with final DSV4-FVE clean-Profile evidence. Conditional
  future extensions remain trigger-gated.

## Delivered

### M1A-M1E: RLM loop
- persistent Python kernel with top-level `await`, typed errors, and bounded
  stdout/results per Session;
- JSON-lines host bridge in `src/runtime.ts` with start/eval/result/error/
  timeout/cancel/dispose and process-tree cleanup;
- single Session-scoped `rlm_eval` tool; one-shot `rlm_query` Subagent with
  child `rlm_eval` denial;
- clean-Profile M1E smoke on the DSV4-FVE route.

### M2: local reliability baseline
- Session FIFO serialization, bounded protocol frames and errors, query/child
  quiescence, scaffold/result isolation, validated configuration and system
  prompt, and safe-name Python environment allowlist.

### M3: Managed Context
- atomic bounded absolute UTF-8 file loading into protected Session-local
  `context`, typed and atomic failures, bytes never model-visible.

### M4: Recursive Child RLM
- official depth-bounded child Sessions with isolated kernels and whole-branch
  quiescence; leaf retains one-shot tool denial.

### M5: Session Snapshot Recovery
- opt-in checkpoint restore after owned kernel loss with JSON-safe globals and
  managed context, atomic publication, and fail-closed recovery.

### M6: Manual Reset
- Session-local FIFO reset through `rlm_eval({ reset: true })` with a cleanup
  barrier and fresh-kernel guarantee.

### M7: Bounded Ordered Batched Query
- `rlm_query_batched` with at most four admitted children, input-ordered
  results, drain-before-failure, and no helper bookkeeping in checkpoints.

### M8: Continuable Spawn
- `rlm_spawn` / `rlm_followup` private helpers over the existing host bridge;
  opaque non-snapshottable live-kernel capability; official continuable
  Subagent and parent inbox ownership; no custom queue or second loop;
- pre-admission gate requires the official host-delivery Symbol
  (`Symbol.for('dsh.subagent.deliverPrompt')`) and fails via the typed
  `kind=query, phase=query` path without child admission on older hosts.

## Ordered open work

None within the frozen V1 boundary. The remaining Future-extension rows stay
conditional until their observed trigger is real; any new milestone starts from
architecture design plus its tracked Archify diagram using the same
contract-first TDD pipeline.

Live tests are gated by `RLM_LIVE_SMOKE=1` so ordinary test runs cannot make
accidental model calls.
