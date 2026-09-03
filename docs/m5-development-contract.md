# M5 Delivery Contract

> English (authoritative) | [简体中文](m5-development-contract.zh-CN.md)

This contract governs only [M5 Session Snapshot Recovery](m5-session-snapshot-recovery.md)
on the accepted M4 `main` baseline. It inherits the repository TDD, upstream,
memory, access, Git, and clean-Profile gates.

## Delivery sequence

1. Preserve the real loss reproduction, independently review the M5 boundary,
   and merge this English-first contract, Chinese mirror, and checked diagram.
2. Turn the reproduction into a failing, cross-process RED recovery test; add
   the smallest focused kernel/runtime tests for each contract behavior.
3. Implement the private checkpoint seam without changing the one-tool/one-loop
   DSH authority boundary.
4. Run focused tests, full checks, independent semantic review, GitHub CI,
   remote-main read-back, and a fresh installed-plugin DSV4-FVE Profile smoke.

One Issue owns M5. Incidental dogfood findings are reproduced and filed
separately; they do not expand this Candidate unless they block recovery.

## Required evidence

- Official DSH upstream gate immediately before every production or test edit.
- RED evidence that fails because a new PID lacks state before M5 code exists.
- GREEN evidence for eligible fatal recovery, context integrity, atomic failure,
  cancellation/unload deletion, and Session/recursive isolation.
- A test must use the real Python process/protocol boundary when asserting
  checkpoint behavior; mocks may supplement, never replace it.
- The real acceptance runs against a disposable DSH home, installs this local
  package, enables `snapshotRecovery`, pins the configured
  `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC route, and verifies ambient settings
  and credentials were unchanged.

## Candidate boundary

Allowed production surfaces are `src/runtime.ts`, `python-runtime/rlm_kernel.py`,
and `src/index.ts` only if tool-result/config plumbing requires it. Tests remain
in the existing two test files. No framework, public service, Storage Domain,
new model-facing tool, provider abstraction, UI, job, or DSH API shortcut may
enter the M5 Candidate.

Each material contributor writes a record to
`docs/development-memory/records/2026/issue-31.jsonl` with semantic pointers
and exact evidence. The independent reviewer is read-only and a behavioral
finding creates a successor RED before any correction.

