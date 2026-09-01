# Project Status

> English | [简体中文](project-status.zh-CN.md)

This document records the implementation boundary at the first public release.
GitHub Issues, [Milestones](milestones.md), and executable tests jointly define
subsequent progress.

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

- Audited implementation: `e1ce33e0d984a340e949768975e2397d8b62bd0b`
- Audit date: 2026-09-02
- Pinned references: `ref/rlm` and `ref/prime-agent`, used as design evidence,
  not literal compatibility targets
- Current stage: the M1 main loop passed a real clean-Profile smoke; the M2
  reliability baseline remains open

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

## Open work

The M2 gaps are grouped into seven public work items:

1. [Kernel lifecycle](https://github.com/leinasi2014/dsh-rlm/issues/1): protocol-fault orphans, ready deadline, and terminal dispose.
2. [Session serialization](https://github.com/leinasi2014/dsh-rlm/issues/2): queue concurrent cells instead of returning `busy`.
3. [Bounded protocol](https://github.com/leinasi2014/dsh-rlm/issues/3): byte limits for stderr, incomplete frames, queries, and errors.
4. [Query/child lifecycle](https://github.com/leinasi2014/dsh-rlm/issues/4): cancel and await children on timeout, failure, and unload; reject empty child text; preserve query taxonomy.
5. [Scaffold and result isolation](https://github.com/leinasi2014/dsh-rlm/issues/5): contain `repr()`, protect the result slot, and restore `rlm_query`.
6. [Configuration and system prompt](https://github.com/leinasi2014/dsh-rlm/issues/6): expose V1 settings and register concise usage guidance.
7. [Python environment isolation](https://github.com/leinasi2014/dsh-rlm/issues/7): do not inherit host variables that may carry Provider credentials.

The accurate status is: **the M1 core loop is delivered; M1 closeout and M2
reliability remain open**.

## Conditional future work

Snapshot/restore, Storage Domain, run records, continuable spawn, recursive RLM,
batch queries, a second kernel, cross-host recovery, cost accounting, UI,
Workflow, Jobs, and swarm have not started and are not M1 defects. They enter a
milestone only after a real trigger exists.
