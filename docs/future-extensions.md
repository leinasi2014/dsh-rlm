# Future Extension Architecture

> English | [简体中文](future-extensions.zh-CN.md)

This document is not a V1 backlog. Add a capability only after the real Profile
loop in [Core architecture](architecture.md) passes and the matching trigger
below exists.

Managed Context through Batched Query are accepted ordered
[M3–M7](milestones.md) contracts. Continuable spawn is now Issue #39's frozen
next slice; the remaining rows are conditional after M7.

## Invariants

Every extension must preserve these boundaries:

- the DSH Agent Loop and Session log remain the model-interaction authority;
- Python executes code but does not own model credentials or DSH-private objects;
- one Session's kernel and variables never leak into another Session;
- extensions reuse the `rlm_eval` path instead of creating a second RLM runtime;
- consider a public Service only after a second consumer exists;
- consider a Provider interface only after a second real implementation exists.

## Add only from evidence

| Capability | Trigger | Minimal addition | Acceptance outcome |
|---|---|---|---|
| Continuable spawn | Work must continue after the parent cell exits | Use the official continuable Subagent and inbox | The child continues and delivers through the official Session path |
| Cross-host persistence | Users require the same RLM Session after plugin restart | Persist only recovery metadata and snapshot references | The Session restores, while version mismatch fails explicitly |
| M7 Batched query | Measured sequential-query latency is a bottleneck | Add one concurrency-bounded `rlm_query_batched` | Results preserve input order and cancellation stops every child |
| Second kernel (route A) | The user requires policy-confined `rlm_eval` execution on the host | Reuse `ctx.sandbox` + `ctx.sandboxPolicy` for one same-world confined kernel (M9) | Kernel file effects follow the Session sandbox policy; M5 stays host-private |
| Token/cost guard | A Provider exposes reliable usage and a reproducible cost problem exists | Read observed usage at query admission and reject later calls | New queries stop at the limit without inventing unobserved tokens |
| Jobs, UI, swarm | A named consumer and end-to-end scenario exist | Consume the existing runtime without entering the Python core | The new consumer preserves `rlm_eval` and Session authority |

## Four questions before an extension

1. Which running scenario proves V1 is insufficient?
2. What is the smallest existing file or boundary that can change?
3. Which existing end-to-end loop must remain unchanged?
4. What executable result proves the extension complete?

If there is no runnable trigger, do not add the feature.

M5 satisfies the observed timeout/crash trigger with an opt-in, per-loaded-
runtime checkpoint only. M6 owns the observed explicit-clear-state trigger
through the existing `rlm_eval` route. Cross-host or host-restart persistence
remains a separate conditional extension and must not reuse M5's private mapping
without a new contract.

M7 is now constrained by its [bounded ordered batch contract](m7-batched-query.md).
It remains a private Python helper over the existing bridge; provider-native
batching, global scheduling, and durable batch work remain conditional extensions.
