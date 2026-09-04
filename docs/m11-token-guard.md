# M11 Per-Cell Query Token/Cost Guard Architecture

> English (authoritative) | [简体中文](m11-token-guard.zh-CN.md) | [Interactive diagram](m11-token-guard.html)

## Outcome

M11 adds one opt-in per-cell guard around every query admission: before an `rlm_query`
or `rlm_spawn` child is admitted, the plugin reads the official
`ctx.tokenMeter.measure(parent.session)` observation and rejects the call when the
observed token budget for the cell is exhausted. Only observed tokens are counted —
the plugin never invents, estimates, or extrapolates unobserved provider usage.

The DSH Agent Loop and Session log remain the model-interaction authority; the provider
and `dsh-token-meter` remain the usage authority. Python never sees token numbers.

## Authority and API

- Authority: `@deepseek-ai/dsh-token-meter` (mounted by DSH base) `TokenMeter.measure(session, header?)`
  returns a `TokenMeasurement`; provider usage surfaces (input, cacheRead, cacheWrite, output)
  live in `TokenMeasurement.baseline.usage` (type `TokenUsage`) only when
  `baseline.kind === 'usage'`. `estimated` / `none` baselines are unobserved; the guard
  treats unobserved as not-counted, never as zero-spend proof. The guard never reads a
  provider surface from a top-level measurement field (there is none).
- New config (all optional, default off):
  - `maxQueryTokensPerCell?: number` — hard stop at admission when observed cell usage
    exceeds the budget.
  - `guardQueryTokens?: boolean` — enable the guard (default false).
- The guard runs in the host bridge, exactly once per helper admission, and is ordered
  before child creation (no dispatch on reject). M7 batched helpers share one per-cell
  accounting cycle.

## State and failure semantics

1. Per-cell accounting starts when a cell begins and is released when it settles;
   the guard reads the session-observed usage at each admission, not a plugin ledger.
2. When the observed usage already exceeds the budget, admission fails with the typed
   `query` error (phase `query`, kind `query`), no child starts, and the cell remains
   usable for non-query work.
3. A provider that reports no usage is not counted toward the cap; the guard closes only
   on observable over-budget, so it never blocks on uncertainty it did not observe.
4. Cancellation of a rejected admission is a no-op; reset/recovery re-arm the next cell.
5. The guard is read-only: it never writes to the DSH session log, never mutates provider
   state, and never exposes token numbers to Python or the model tool result beyond the
   bounded rejection message.

## Limits and non-goals

No provider framework, no pricing/cost ledger, no persistence of quotas, no global/cross-
Session budget, no token counters inside Python, no estimate fallbacks. The guard is a
bounded safety filter, not accounting software.

## TDD acceptance contract

1. **RED:** accepted M10 admits a query without consulting any token observation; a
   recording stub observes zero `measure` calls (fails as RED because exactly one call per
   admission is the expected behavior).
2. **GREEN:** with `guardQueryTokens=true` and a stub reporting over-budget usage, the first
   admission calls `measure` once, rejects with typed `query` error, and no child dispatches.
3. **GREEN:** a stub reporting under-budget usage allows admission and does not reject.
4. **GREEN:** M7 batch over budget rejects before any child; the cell remains usable and
   next cell re-arms the accounting cycle.
5. **Clean Profile:** disposable installed Profile proves the guard path with DSV4-FVE
   (or GLM fallback) without inventing token numbers.
