# M7 Delivery Contract

> English (authoritative) | [简体中文](m7-development-contract.zh-CN.md)

This contract governs only [M7 Bounded Ordered Batched Query](m7-batched-query.md)
on accepted M6 `main`. It inherits the repository upstream, access, TDD,
memory, review, Git, CI, and clean-Profile gates.

## Delivery sequence

1. Freeze and independently review the M7 architecture and its checked diagram;
   preserve a kernel/Profile RED demonstrating that M6 lacks the helper.
2. Add the smallest kernel/protocol RED tests for strict input, four-way
   admission, out-of-order ordered results, error drain, and reuse after error.
3. Add runtime lifecycle RED tests that observe no more than four active child
   works and prove cleanup under `maxQueries`, direct Python task cancellation,
   cell cancellation, timeout, kernel exit, fatal protocol loss, reset, and
   unload. Reset must remain FIFO behind the batch; eligible M5 fatal recovery
   behavior must remain intact.
4. Implement the smallest private Python helper plus protected-scaffold/M5
   handling. Do not add a runtime API unless an executable test proves it is
   necessary.
5. Run full gates, independent semantic review, GitHub CI, remote-main
   read-back, and a fresh installed-plugin DSH Profile smoke.

One Issue owns M7. Dogfood findings are reproduced, classified, and filed
separately unless they block this contract.

## Required evidence

- Immediately before each production or test mutation, run the official DSH
  upstream gate against the selected clean upstream checkout.
- RED must fail for the intended absent-M7 behavior. Mock tests may supplement
  it but cannot replace Python-process/protocol or installed-Profile evidence.
- GREEN must prove the fixed cap with observed concurrent child work, index
  preservation despite out-of-order replies, no-dispatch invalid input,
  deterministic lower-index failure after two reverse-completion failures and
  full drain, empty-input and mixed-batch query-cap behavior, retained query
  cap, direct-Python-
  cancellation drain/re-raise without an unknown reply, cleanup finality for
  kernel/protocol fatal paths, M5 scaffold/recovery boundaries, M4 child-tool
  depth behavior, and Session isolation.
- The clean Profile installs the local package into a disposable DSH Home,
  proves structured official Session-log tool/result evidence, and leaves
  no plugin-owned process. Prefer `DeepSeek-V4-Flash-Vision-Exp` through the
  vLLM/PTC route; while that service is down, the permitted fallback is
  `zai-coding-cn / glm-5.2`, explicitly recorded with the outage and followed
  by a DSV4-FVE regression after recovery.

## Candidate boundary

Production changes belong in `python-runtime/rlm_kernel.py`; touch
`src/runtime.ts` only for a demonstrated lifecycle defect. Tests stay in the
existing two test files. Update the system prompt only to explain the helper's
observable call shape. Do not add a new tool schema, public Service, Storage
Domain, scheduler, provider abstraction, configurable pool, UI, Job, workflow,
or DSH API shortcut.

Each material contributor writes its own Issue #36 record to
`docs/development-memory/records/2026/issue-36.jsonl`. The independent reviewer
is read-only; every behavioral finding starts a successor RED before a further
production correction.
