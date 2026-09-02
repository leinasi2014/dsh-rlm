# M3/M4 Development Contract

> English (authoritative) | [简体中文](m3-m4-development-contract.zh-CN.md)

This contract controls implementation of [M3 Managed Context](m3-managed-context.md)
followed by [M4 Recursive Child RLM](m4-recursive-child-rlm.md). The shared
[architecture diagram](dsh-rlm-architecture.html) is generated from the tracked
[Archify source](dsh-rlm-architecture.archify.json).

## Delivery order and WIP

1. Freeze and independently review these contracts against the latest official
   DSH source and pinned `ref/` evidence.
2. Integrate the documentation slice before editing M3 production code.
3. Complete M3 through TDD, review, CI, remote-main read-back, and clean-Profile
   acceptance.
4. Only then start M4 through the same gates.

Work-in-progress is one milestone. M4 tests may be designed early, but M4
production code must not enter the M3 Candidate.

## TDD contract

For each observable behavior:

1. **RED:** add the smallest focused test/reproduction and preserve evidence
   that it fails for the intended contract reason.
2. **GREEN:** make the smallest causal production change.
3. **REFACTOR:** improve structure only while focused and representative tests
   stay green.
4. **FULL GATE:** run `pnpm check:upstream`, typecheck, build, focused and full
   tests, development-memory gates, independent semantic review, GitHub CI,
   remote-main read-back, and the milestone's clean-Profile smoke.

Tests must cross the real process/protocol/Session boundary when the behavior
does. Mock-only success cannot close a cross-boundary acceptance item.

## DSH dogfood and finding intake

Development uses the latest completed plugin with the latest accepted official
DSH checkout and the configured `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC route.
Dogfood analysis should use `rlm_eval` for real source/context work when useful.

An incidental finding does not expand the active milestone:

1. record the observation, exact Profile/model/plugin revision, and evidence;
2. reproduce it outside the candidate change when possible;
3. classify it as plugin defect, DSH compatibility change, environment issue,
   or expected behavior;
4. aggregate duplicates, then create one independently scoped GitHub Issue;
5. schedule repair after the current milestone unless it blocks acceptance.

No opportunistic fix is allowed without a frozen contract and a RED test.

## Agent, memory, and review gates

- The coordinator owns integration, `main`, and final acceptance.
- Every agent gets one bounded write scope, the current TDD phase, base SHA,
  architecture links, access mode, and required checks.
- Architecture, recursion, lifecycle, security, and final semantic review use
  maximum reasoning. Bounded implementation normally uses high reasoning.
- Any assignment that may write, run tests, create artifacts, or manipulate
  processes starts with Full Access. Truly non-mutating review may use Read Only.
- Every material contributor appends its own immutable record under
  `docs/development-memory/`; the implementation owner also records corrections
  for findings in its Candidate.
- The independent reviewer does not modify the Candidate. A behavioral finding
  creates a successor RED before correction.

## Git and Issue gates

- One GitHub Issue owns one acceptance contract and one development-memory
  stream. Do not split by file or micro-step.
- Commit RED evidence separately when practical; GREEN/REFACTOR commits must
  name the Issue and remain reviewable.
- Candidate branches are never merged on model report alone. Required checks,
  review findings, and live evidence must be recorded first.
- After merge, fetch remote `main`, verify the merged SHA/content and CI state,
  then run the clean-Profile acceptance from the accepted revision.
- New dogfood defects become separate Issues; they do not hide inside M3/M4.

## Compatibility authority

Before any production/test mutation, the selected DSH checkout must pass
`pnpm check:upstream`. Installed `@deepseek-ai/*` types and the exact loaded
Profile runtime are the executable authorities; `ref/` is read-only prior-art
evidence. When these disagree, stop mutation, document the discrepancy, and
resolve the contract before continuing.
