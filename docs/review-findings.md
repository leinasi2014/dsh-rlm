# Implementation and Architecture Review

> English | [简体中文](review-findings.zh-CN.md)

## Verdict

The implementation follows the two pinned references in the dimensions that
matter for this project: a persistent Python namespace, host-owned model
authority, one-shot children, Session isolation, and no second Agent Loop. The
representative real M1 loop works, and the core algorithm choices are restrained
and generally sound.

It is not yet accurate to claim every exit criterion passes. The system prompt
is missing, and M2 still has real gaps in serialization, bounded protocol
handling, fault termination, and child-work lifecycle.

## Confirmed high-priority findings

1. Invalid JSON and unknown frames enter `handleExit()` without guaranteeing
   process-tree termination, after which the runtime can no longer find the
   process in its Map.
2. Concurrent evals in one Session return `busy`; M2 requires ordered
   serialization.
3. stderr, incomplete stdout frames, query prompt/result, error detail, and raw
   JSONL lines are not all covered by UTF-8 byte limits.
4. Cell timeout, protocol failure, and plugin unload do not fully bind an active
   one-shot Subagent to the cell lifecycle.
5. `Runtime.dispose()` is not terminal and a later eval can start a new kernel.
6. The ready handshake occurs before the cell timer and abort listener, so a
   silent interpreter can wait forever.
7. Python inherits `process.env`, contrary to the project's credential-isolation
   target.

## Confirmed correctness and contract findings

- Last-value `repr()` is outside the cell exception boundary, so an exception
  can kill the kernel instead of failing only that cell.
- A user cell can overwrite or delete `rlm_query`; the internal result slot can
  collide with user globals or survive a failed cell.
- A completed child with no visible text is accepted as an empty string even
  though the architecture requires a typed query error.
- The public schema does not expose the runtime's Python command, timeout,
  output limits, or query limit; the concise RLM system prompt is not registered.
- `RlmError kind='query'` is unreachable on the current bridge path, so the
  declared taxonomy and observed behavior differ.

## Algorithm quality

The following core algorithms are valid:

- a reader thread safely wakes asyncio futures and correlates queries by ID;
- the AST last-expression transform works with ordinary cells and top-level await;
- stdout/result truncation observes UTF-8 byte boundaries;
- the main result/error/timeout/cancel/dispose paths largely obey one-time settlement;
- child recursion is denied structurally instead of relying on prompt wording.

However, “no algorithmic defects” is too strong. Exceptional `repr()`, an
orphaned protocol process, a stale result slot, and background query work crossing
the cell terminal state are reproducible state-machine or isolation defects.

## Findings confirmed from the supplied review

The audit confirmed missing host-side query limits, inherited Python environment,
timeout that does not fully cancel child work, unbounded stderr, mutable scaffold,
the incorrect busy behavior, and no kill-on-close protection if a Windows host
crashes suddenly.

A Windows Job Object is a hardening proposal, not a currently promised M1/M2
exit criterion.

## Stale claims that do not apply

Do not create issues from these older or different designs:

- V1 should have six tools; current V1 deliberately has only `rlm_eval`.
- V1 should expose an eight-operation `RlmService`; it deliberately has no public Service.
- Storage Domain, run records, and checkpoints are mandatory now; they are conditional extensions.
- V1 should have nine TypeScript files; the current directory contract has two.
- The protocol must use `hello/evaluate/host_reply/done`; current V1 uses
  `ready/eval/query/query_result/result/error`.
- `protocol.ts`/`protocol.py` mirrors or roughly 1,600 lines are required; neither
  is a current acceptance criterion.

The references are prior art, not specifications to copy literally. This project
adopts their lifecycle, resource-governance, and namespace-protection lessons,
not their daemon, Storage, frame names, automatic snapshots, or wider framework.

## Correction order

1. Close process, deadline, dispose, and child-lifecycle gaps.
2. Add the per-Session queue and byte limits for every protocol/diagnostic channel.
3. Fix Python scaffold, result formatting, and empty child-result isolation.
4. Add the environment allowlist, public configuration, and system prompt.
5. Run local regression tests and then the isolated real Profile smoke again.
