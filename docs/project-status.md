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
holds Session-local globals, and asks the host for one-shot child calls.

## Publication baseline

- Accepted M1/M2 base: `260484d7d92e43fcb99c54ab987436d494501845`
- Status date: 2026-09-03
- Pinned references: `ref/rlm` and `ref/prime-agent`, used as design evidence,
  not literal compatibility targets
- Current stage: M1 and M2 passed their local, review, CI, remote-main, and real
  clean-Profile gates; M3 architecture/contract integration is in progress

## Delivered

### M1A: Python kernel

- persistent globals;
- top-level `await`;
- last-expression result;
- UTF-8 byte truncation for stdout and result;
- typed cell failures.

### M1B: TypeScript runtime

- JSON-lines child-process protocol;
- one kernel per Session;
- main eval, result, error, timeout, cancel, and dispose paths;
- process-tree kill and lazy clean-kernel recreation after timeout.

### M1C / M1D: DSH integration and query bridge

- only public tool: `rlm_eval`;
- Session-scoped isolation;
- `await rlm_query(prompt)` round trip through a one-shot DSH Subagent;
- child recursion prevented with `toolFilter` denying `rlm_eval`;
- child disposal on normal completion.

### M1E: Real Profile smoke

A fresh DSH Profile verified real package installation/loading, a Chinese UTF-8
file read, Python continuation after `rlm_query`, cross-cell variable reuse,
bounded tool results in the official Session log, and no recursive `rlm_eval`
availability in the child.

Live tests are gated by `RLM_LIVE_SMOKE=1` so ordinary test runs cannot make
accidental model calls.

## Accepted M2 reliability

The public M2 repair Issues are closed. The accepted base includes Session FIFO
serialization, bounded protocol frames and errors, query/child quiescence,
scaffold/result isolation, validated configuration and system prompt, and a
safe-name Python environment allowlist. The complete base has 138 tests (136
passing plus two deliberately live-gated smokes) and passed the DSV4-FVE clean
Profile path.

## Ordered open work

1. [M3 Managed Context](m3-managed-context.md): bounded, atomic, protected
   absolute-file loading without copying contents through model-visible input.
2. [M4 Recursive Child RLM](m4-recursive-child-rlm.md): official depth-bounded
   child Sessions with isolated kernels and whole-branch quiescence.

The [development contract](m3-m4-development-contract.md) requires docs-first
integration, WIP=1, TDD, independent review, CI, remote-main read-back, and a
real DSH/Profile acceptance for each milestone. Dogfood findings are reproduced,
aggregated, and filed separately rather than silently widening M3/M4.

## Conditional future work

Snapshot/restore, Storage Domain, run records, continuable spawn, batch queries,
a second kernel, cross-host recovery, cost accounting, UI, Workflow, Jobs, and
swarm remain conditional and have not started.
