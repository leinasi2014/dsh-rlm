# M6 Delivery Contract

> English (authoritative) | [简体中文](m6-development-contract.zh-CN.md)

This contract governs only [M6 Manual Reset](m6-manual-reset.md) on the
accepted M5 `main` baseline. It inherits the repository upstream, TDD, memory,
access, Git, review, CI, and clean-Profile gates.

## Delivery sequence

1. Preserve a real Profile RED showing that accepted M5 main rejects the
   intended `rlm_eval({reset:true})` journey; independently review this narrow
   Session-lifecycle boundary and merge this contract, Chinese mirror, and
   checked lifecycle diagram.
2. Add focused RED tests for same-Session ordering, PID replacement, M3/M5
   cleanup, cancellation, and sibling/recursive isolation.
3. Implement the smallest queue-aware reset path without changing the one-tool,
   one-loop DSH authority boundary.
4. Run full checks, independent semantic review, GitHub CI, remote-main
   read-back, and a fresh installed-plugin DSV4-FVE Profile smoke.

One Issue owns M6. Incidental dogfood findings are reproduced and filed
separately unless they block manual reset acceptance.

## Required evidence

- Run the official DSH upstream gate immediately before every production or test edit.
- RED must prove the accepted Profile cannot perform the intended reset journey;
  mocks may supplement but cannot replace the Python process/session boundary.
- GREEN must cover FIFO ordering, kernel/child cleanup, M3 context loss, M5
  checkpoint deletion, cancellation, and Session isolation.
- The real acceptance uses a disposable DSH Home, installs this local package,
  enables `snapshotRecovery`, pins `DeepSeek-V4-Flash-Vision-Exp` through the
  vLLM/PTC route, and proves ambient settings/credentials are byte-unchanged.

## Candidate boundary

Production changes may touch `src/runtime.ts` and `src/index.ts` only if tool
schema/result plumbing requires it. `python-runtime/rlm_kernel.py` remains
unchanged unless a proved protocol need appears. Tests stay in the existing two
test files. No new model-facing tool, public Service, Storage Domain, Provider
abstraction, UI, job, background task, or DSH API shortcut may enter M6.

Each material contributor writes an Issue #33 record to
`docs/development-memory/records/2026/issue-33.jsonl`. The independent reviewer
is read-only; a behavioral finding creates a successor RED before correction.
