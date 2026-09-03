# M7 Bounded Ordered Batched Query Architecture

> English (authoritative) | [简体中文](m7-batched-query.zh-CN.md) | [Interactive diagram](m7-batched-query.html)

## Outcome

M7 adds one Python-only convenience helper to the existing persistent RLM
kernel:

```python
answers = await rlm_query_batched(["first prompt", "second prompt"])
```

It starts ordinary one-shot DSH subagent queries with a fixed maximum of four
active children for that one batch, then returns `list[str]` in the same order
as the input. It does not add a model-facing tool, a second Agent loop, a
global scheduler, a provider batch API, a Service, Storage, a job, or UI.

## Contracted API and compatibility

`rlm_query_batched(prompts)` is injected into every RLM Python namespace and
restored with the existing protected helper scaffold after each cell and M5
restore. It accepts only a `list` or `tuple` whose every item is a `str`.

- An empty input returns `[]` and sends no `query` protocol frame or child
  request (the enclosing ordinary `eval` frame still exists).
- Invalid container or item input raises the existing typed query failure before
  any child is started; a `str` itself is not a valid batch container.
- Equal prompts are independent positions. The return list has exactly the
  input length and preserves those positions even when child responses finish
  out of order.
- Existing `await rlm_query(prompt)` behavior, `rlm_eval` input, Session FIFO,
  limits, logs, and one-tool public surface are unchanged.

The fixed concurrency cap is `4`; it is deliberately not a user option in M7.
It scopes to one invocation only. Separate Sessions retain their existing
independent runtimes; M7 creates no cross-Session pool or fairness mechanism.

## Admission, ordering, and failure semantics

The helper tracks each prompt with its input index and uses the existing
`_rlm_query` bridge for every admitted item. Consequently, every child keeps
the existing prompt and result byte limits, official DSH Subagent ownership,
M4 depth/tool policy, and per-cell `maxQueries` accounting. Below the official
M4 depth cap a child retains its own RLM kernel and `rlm_eval`; only the exact-
depth leaf denies `rlm_eval`.

1. It admits at most four pending items at once, filling a finished slot only
   while no failure has been observed.
2. A successful item is written to its indexed result slot; final success
   returns slots in input order, never completion order.
3. Any malformed input dispatches none. Any admitted query failure stops future
   admission, but does **not** cancel children already sent to the host.
4. The helper drains every already admitted child before it raises one typed
   query failure. If several admitted items fail, it raises the failure from
   the lowest input index, making the terminal error deterministic.
5. If the existing per-cell `maxQueries` limit is reached, no over-limit item
   starts a DSH child. Started items still drain before the typed limit failure
   returns. M7 neither changes nor reserves a new query budget.

Draining is required because cancelling a Python `_rlm_query` waiter while its
host request remains live would turn its later `query_result` into an unknown
protocol response. The normal failure path therefore preserves protocol
integrity and lets existing host cleanup own the actual child work.

Direct Python cancellation is a separate, mandatory rule. If user code cancels
the task running `rlm_query_batched` (including through `asyncio.wait_for`),
the helper must stop new admission, shield/drain every already admitted
`_rlm_query` waiter while the owning cell remains live, and only then re-raise
`CancelledError`. It may not let caller cancellation remove a pending query ID
before its host reply is consumed. A terminal cell cancellation, timeout, or
fatal kernel/protocol loss instead follows the existing host-owned cell cleanup
path.

## Lifecycle, state, and boundaries

Cancellation, timeout, kernel crash, fatal protocol loss, and plugin unload
continue to use the existing per-cell abort controller and child-disposal
barrier. They abort and dispose every admitted child before the cell settles;
they never let a batch result arrive in a later cell. M5 retains its existing
eligible-fatal-loss checkpoint and restore rules for those loss paths.

M6 reset is not cell cancellation: it stays queued behind the accepted batch in
the same Session FIFO. The batch first settles under its own normal success,
item-failure, or direct-Python-cancellation drain semantics; only then does
reset own the existing kernel/child cleanup barrier. The Session FIFO still
serializes cells in one Session, so a batch cannot overlap another cell in that
Session.

The helper itself, its worker bookkeeping, and partial results are ephemeral.
They must not become user globals, M5 snapshot data, managed `context`, host
protocol fields, Session metadata, or tool results. Only a successful
`list[str]` assigned by user Python code may become an ordinary snapshot-eligible
global under existing M5 rules.

M7 reuses M4 recursion exactly as it exists: an admitted query may follow the
official recursive-child route where M4 permits it, child RLM remains available
below the authoritative cap, and only exact-depth leaves deny the RLM tool. M7
never introduces another recursive policy or a second kernel.

## Limits and explicit non-goals

- Fixed cap: four active child queries per invocation.
- Existing `timeout` covers the whole cell, including draining; M7 adds no
  per-item timeout, retry, streaming, partial success value, or background
  continuation.
- Existing `maxQueries` is consumed only by actual calls to `_rlm_query`.
- No native provider batch endpoint, configurable worker count, global
  scheduler, back-pressure service, cost accounting, durable batch record, or
  new DSH API surface is allowed.

## TDD acceptance contract

1. **RED on accepted M6 main:** a kernel has `rlm_query` but does not expose
   `rlm_query_batched`; a fresh installed-plugin Profile cannot use it.
2. **Kernel/protocol GREEN:** six prompts admit four initial `query` frames;
   deliberately out-of-order `query_result` frames refill slots and produce the
   original input order, including duplicate prompts.
3. **Failure GREEN:** invalid input sends no query; an item failure stops new
   admission, drains started work, raises the deterministic typed query error,
   and leaves the kernel usable for the next cell. Two admitted items must also
   fail in reverse completion order while all admitted work drains; the observed
   terminal error must be the lower input-index failure. Explicit mixed-batch
   cases cover empty input and exhaustion of the remaining `maxQueries` budget.
4. **Runtime/lifecycle GREEN:** observed active child work never exceeds four;
   `maxQueries`, direct Python task cancellation, cell cancellation, timeout,
   kernel exit, fatal protocol loss, reset, and unload leave no admitted child
   or protocol waiter alive after the owning cell settles. Direct Python
   cancellation must drain and re-raise without an unknown late reply; reset
   must first wait FIFO behind the batch. Eligible M5 fatal paths retain their
   recovery behavior.
5. **M4 depth boundary:** a batch below the authoritative cap can use its child
   RLM path; a batch at the exact leaf cap proves `rlm_eval` is denied there.
6. **M5 scaffold boundary:** the helper is re-injected after execution and
   restore and is not serialized as a checkpoint user global.
7. **Clean Profile:** a disposable DSH Home installs this local package and
   proves a multi-prompt batch yields visible, ordered child-backed text with
   bounded official Session-log evidence. Use the DSV4-FVE vLLM/PTC route when
   available; while that service is unavailable, record the explicit temporary
   fallback `zai-coding-cn / glm-5.2` and re-run DSV4-FVE after recovery.
