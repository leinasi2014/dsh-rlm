# Future Extension Architecture

> English | [简体中文](future-extensions.zh-CN.md)

This document is not a V1 backlog. Add a capability only after the real Profile
loop in [Core architecture](architecture.md) passes and the matching trigger
below exists.

Managed Context and Recursive Child RLM have accumulated accepted evidence and
are no longer conditional items. They are the ordered [M3 and M4](milestones.md)
contracts; this table starts with capabilities that remain conditional after
M4.

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
| Manual reset | Users need to clear variables or release a kernel explicitly | Add a reset operation to `rlm_eval`, or one `rlm_reset` tool | Only the current Session resets |
| Snapshot/restore | An accepted use case requires variables after timeout, crash, or host restart | Serialize supported globals and atomically replace a temporary file | Restart restores supported variables and reports skipped values |
| Continuable spawn | Work must continue after the parent cell exits | Use the official continuable Subagent and inbox | The child continues and delivers through the official Session path |
| Cross-host persistence | Users require the same RLM Session after plugin restart | Persist only recovery metadata and snapshot references | The Session restores, while version mismatch fails explicitly |
| Batched query | Measured sequential-query latency is a bottleneck | Add one concurrency-bounded `rlm_query_batched` | Results preserve input order and cancellation stops every child |
| Second kernel | A container or remote kernel implementation has started | Extract the smallest `KernelDriver` interface | Local and second implementations pass the same loop |
| Token/cost guard | A Provider exposes reliable usage and a reproducible cost problem exists | Read observed usage at query admission and reject later calls | New queries stop at the limit without inventing unobserved tokens |
| Jobs, UI, swarm | A named consumer and end-to-end scenario exist | Consume the existing runtime without entering the Python core | The new consumer preserves `rlm_eval` and Session authority |

## Four questions before an extension

1. Which running scenario proves V1 is insufficient?
2. What is the smallest existing file or boundary that can change?
3. Which existing end-to-end loop must remain unchanged?
4. What executable result proves the extension complete?

If there is no runnable trigger, do not add the feature.
