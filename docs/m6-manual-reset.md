# M6 Manual Reset Architecture

> English (authoritative) | [简体中文](m6-manual-reset.zh-CN.md)

## Outcome

M6 gives an Agent one explicit, model-visible way to discard the RLM state of
its current DSH Session:

```text
rlm_eval({ reset: true })
```

The next ordinary `rlm_eval` for that same Session starts a new Python PID with
no prior globals, no managed `context`, and no M5 checkpoint. The operation
does not add a second tool, Agent loop, Service, Storage Domain, background
worker, or UI.

## Public input and compatibility

`rlm_eval` remains the only model-facing RLM tool. Its input becomes a strict
union:

```ts
{ code: string; contextPath?: string } | { reset: true }
```

`reset: true` is mutually exclusive with `code`, `contextPath`, and an
operation-specific timeout. Existing code-bearing calls, including their
timeouts and cancellation behavior, are unchanged. The successful reset result
is a bounded acknowledgement only; it never reveals discarded values, paths,
context text, checkpoint data, or PID.

## Ownership and ordering

The TypeScript runtime remains the owner of all process lifecycle decisions.
Reset is an internal queue entry keyed by the exact current DSH Session key:

```text
same Session: earlier accepted eval -> reset -> later eval
other Session: unaffected and independently runnable
```

It waits behind an already accepted cell for the same Session. Once active it
awaits the existing kernel disposal/child-cleanup barrier, evicts that kernel,
and drops the Session's M5 checkpoint reservation and file. The reset entry
does not start a Python kernel and cannot run `rlm_query` work itself.

The later eval may lazily start a new kernel. Because reset removed the private
checkpoint before that start, M5 recovery cannot restore state into the new
namespace. M3 context is absent until a later code-bearing call supplies a new
`contextPath` through the existing atomic loader.

## Failure and cancellation semantics

| Condition | Required result |
|---|---|
| Pre-aborted reset signal | Typed `cancel`; no queue entry, kernel action, or checkpoint deletion |
| Reset waiting behind a cell and caller cancels | Typed `cancel`; running cell and live state remain unchanged |
| Plugin runtime unload | Existing terminal dispose wins; reset never starts afterward |
| Kernel disposal failure | Typed failure; no new kernel is started by reset and no cross-Session action occurs |
| Other Session reset/eval | Has no effect on this Session's kernel, context, or checkpoint |

Reset is deliberate user-directed deletion, not M5 fault recovery. It does not
restore state, persist metadata, alter DSH Session history, or cross a recursive
parent/child/sibling Session boundary.

## Limits and non-goals

- No checkpoint contents or M3 context bytes enter tool results, host protocol
  frames, logs, or reset metadata.
- Reset adds no new byte, concurrency, or depth setting. Existing queue,
  timeout, cancellation, environment, and child-disposal limits remain in
  force.
- The operation is not a host-restart reset, an all-Sessions cleanup, a
  recursive-branch cancellation primitive, or a durable data deletion API.
- Manual reset is intentionally synchronous at the tool boundary: its success
  means the owned kernel cleanup barrier has completed.

## TDD acceptance contract

1. **RED on accepted M5 main:** a fresh installed-plugin DSH Profile can keep a
   marker across cells but has no accepted `reset:true` input.
2. **GREEN local process path:** a reset after globals and managed context
   disposes the old PID; the next cell has a new PID and cannot read either
   prior globals or context.
3. **Isolation/ordering:** a queued reset never touches a running cell or a
   sibling Session; after it becomes active, later same-Session evals see the
   clean namespace.
4. **M5 boundary:** with `snapshotRecovery=true`, reset removes the checkpoint
   so a subsequent owned timeout cannot resurrect pre-reset state.
5. **Clean Profile:** a disposable DSH Home installs this local package, enables
   M5 recovery, pins `DeepSeek-V4-Flash-Vision-Exp` through vLLM/PTC, performs
   set -> reset -> read, and proves the official Session log records the reset
   call without exposing discarded content.
