# M8 Delivery Contract

> English (authoritative) | [简体中文](m8-development-contract.zh-CN.md)

This contract governs [M8 Continuable Spawn](m8-continuable-spawn.md) for Issue
#39, after accepted M7 main. It inherits the repository upstream, access, TDD,
memory, review, Git, CI, and clean-Profile gates.

## Delivery sequence

1. Record the exact loaded Profile runtime and the fresh official source for the
   continuable/inbox operations. They are distinct compatibility authorities:
   the current upstream runtime exposes the host-only
   `Symbol.for('dsh.subagent.deliverPrompt')` adapter, while the bundled
   `0.1.1-rc.2` declarations describe the older public surface and do not export
   that internal entry. Freeze the runtime capability gate and independently
   review this contract.
2. Add a smallest kernel/Profile RED proving the absent helper on accepted M7.
3. Add protocol/runtime REDs for non-snapshottable opaque same-Session capabilities, no-dispatch
   invalid/cross-Session input, post-cell continuation, follow-up FIFO, official
   inbox report/settlement, M4 depth, M5/M6 boundaries, and unload draining.
4. Implement only the necessary private helpers and existing host bridge frames.
   No new DSH tool or custom work manager is permitted.
5. Run full gates, independent review, CI, remote-main read-back, and clean
   installed-plugin smoke before acceptance.

## Required evidence

- Run `pnpm check:upstream` before every production or test edit.
- RED must fail because M7 lacks the M8 helper, not because a mock hides DSH.
- Tests must observe real Python JSON-lines behavior and official DSH child /
  parent Session records; a fake manager supplements but never replaces them.
- The runtime must detect the official host-delivery Symbol before routing a
  spawn or follow-up and fail with the existing typed `kind=query, phase=query`
  path without child admission or dispatch when it is absent. M8 is compatible only with a loaded DSH runtime that
  supplies that Symbol; an `0.1.1-rc.2` host that exposes only the older public
  declarations is explicitly unsupported for M8. Its installed declaration
  package is compile-time evidence, not proof of this host capability.
- The Profile test must wait for official asynchronous Session-log publication,
  then prove the child survives the originating cell, receives
  a later follow-up, and reports through the parent inbox without an answer
  handle or cross-Session privilege.
- Every contributor records its own Issue #39 evidence in development memory;
  an independent reviewer is read-only and behavioral findings start successor
  RED work.

## Candidate boundary

Production belongs first in `python-runtime/rlm_kernel.py` and `src/runtime.ts`.
Keep tests in the existing two test files. Do not add files unless a genuine
testable boundary appears; do not add Storage, a queue, scheduler, Service,
provider abstraction, UI, Job, Workflow, or DSH API shortcut.
