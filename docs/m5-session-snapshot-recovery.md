# M5 Session Snapshot Recovery Architecture

> English (authoritative) | [简体中文](m5-session-snapshot-recovery.zh-CN.md)

## Outcome

M5 is an opt-in, ephemeral recovery capability for the existing `rlm_eval`
path. When an owned Python kernel is lost because of a hard timeout, process
exit, or fatal protocol error, the next `rlm_eval` for that same DSH Session
can restore the most recent valid checkpoint before it executes its cell.

```text
successful cell -> private atomic checkpoint
owned timeout / crash / protocol-fatal -> kernel eviction
next rlm_eval -> fresh kernel restores checkpoint -> cell executes
```

The checkpoint belongs to one loaded plugin runtime and one official DSH
Session. It is not Session persistence: cancellation, manual reset, plugin
unload, host restart, and cross-host use do not restore it.

The acceptance diagram is generated from
[the tracked Archify source](m5-session-snapshot-recovery.archify.json).

## Public surface and configuration

M5 adds one backwards-compatible configuration field:

```ts
snapshotRecovery?: boolean // default false
```

When false, M2 namespace-loss behavior is unchanged. When true, the runtime
creates one private temporary checkpoint root for its own lifetime. It uses a
non-forgeable Session-key-to-opaque-file mapping; no checkpoint path, payload,
or operation is public to the model.

The fixed limits are deliberately not a storage configuration surface:

- one checkpoint is at most `8 MiB` encoded UTF-8;
- the private root is at most `64 MiB` across Sessions;
- recovery metadata exposes at most 64 skipped names/reasons and no values,
  paths, context text, credentials, stderr, or raw checkpoint bytes.

If root admission cannot reserve space, the successful live cell still returns
normally, its prior valid checkpoint stays intact, and its bounded recovery
metadata reports that no newer checkpoint was committed.

## Checkpoint contents

The Python kernel owns validation, serialization, restoration, and atomic
publication. A versioned envelope contains only:

- user globals whose values are a finite JSON tree: `null`, booleans, finite
  safe-range numbers, strings, lists, and dictionaries with string keys;
- the protected M3 `context` text and validated `context_meta`, if managed
  context exists;
- bounded status metadata (version, byte count, skipped names/reasons).

Object identity and aliases are not preserved. Functions, classes, modules,
bytes, handles, tasks, generators, custom objects, cyclic values, non-finite
numbers, integers outside the JavaScript safe range, and internal/reserved
globals are omitted and recorded as skipped. The protected names
`__builtins__`, `asyncio`, `rlm_query`, `rlm_query_batched`, `context`, and
`context_meta` never enter the user-globals section.

M3 context is captured as its exact validated text plus metadata in the private
checkpoint—not merely as a source path. Recovery therefore cannot silently
substitute a changed, deleted, or replaced source file. Context text remains
inside the local checkpoint and never crosses model-visible tool input, tool
result, Session log, or host/kernel JSON-lines payload.

## Atomicity, protocol, and ownership

`RlmRuntimeImpl` owns the private root, the Session mapping, reservation, and
cleanup. The kernel receives only a private `snapshotPath`, a boolean indicating
whether recovery is enabled, and `maxSnapshotBytes` in the existing private
`eval` frame. This raises the protocol version from 2 to 3. No snapshot bytes
travel through a frame.

Before publishing, the kernel validates the complete candidate and encodes it
in memory. It writes a private temporary sibling file, flushes and fsyncs it,
then atomically replaces the prior checkpoint. A failed validation, size check,
write, flush, or replacement leaves the old checkpoint untouched.

On a fresh kernel after an eligible fatal loss, restore happens before optional
new `contextPath` loading and before user code. The kernel validates the whole
envelope into fresh structures, reinstalls its scaffold, then publishes the
restored namespace and protected M3 state as one step. A supplied new
`contextPath` may replace restored M3 context through the existing M3 atomic
loader after restore succeeds.

A missing, malformed, or version-mismatched checkpoint fails closed as typed
`snapshot`/`recovery` error. It is invalidated so a following evaluation starts
clean rather than repeatedly trusting bad state. The runtime keeps checkpoints
after eligible fatal loss, but deletes them after cancellation, manual reset,
runtime disposal/plugin unload, and normal best-effort root cleanup. Host
restart has no retained runtime mapping and is an explicit non-goal.

The terminal tool result may include bounded `recovery` metadata such as whether
a prior checkpoint was restored, whether a new one committed, its byte count,
and skipped-name summaries. It never includes checkpoint values. A checkpoint
failure does not turn a successfully executed cell into a Python failure; it
only means that the preceding valid checkpoint remains the recovery point.

## Lifecycle matrix

| Event | Kernel | Checkpoint | Next same-Session eval |
|---|---|---|---|
| Successful cell | stays alive | atomically replaces prior valid checkpoint | reuses live namespace |
| Python/query cell error | stays alive | not replaced | reuses prior live namespace/checkpoint |
| Timeout, process exit, protocol-fatal | evicted | retained | restores then evaluates |
| Caller cancellation | evicted | deleted | clean kernel |
| Manual reset | evicted | deleted | clean kernel |
| Plugin unload/runtime dispose | all owned kernels stop | root removed | no runtime remains |
| Host restart | old process gone | no mapping is reused | clean runtime |

Recursive M4 children follow the same rule independently because official child
Sessions select distinct runtime keys. Parent, sibling, and descendant
checkpoints cannot be read or restored across those keys.

## Non-goals

- a new model-facing restore/reset tool, run ID, public service, registry, or
  second Agent loop;
- DSH Storage Domain, Session-record persistence, host-restart recovery,
  replication, cross-host restore, or a checkpoint browser/UI;
- arbitrary Python object serialization, `pickle`, custom serializer hooks, or
  user-controlled checkpoint paths;
- background checkpointing, durable jobs, provider changes, or recursive
  scheduler changes.

## TDD acceptance contract

1. A RED runtime/kernel test forces timeout or process exit after a successful
   cell, proves a fresh PID, and then proves scalar/nested JSON globals restore.
2. Unsupported values are absent after restore and appear only as bounded
   skipped-name/reason metadata.
3. M3 context restores exact checkpointed text and metadata after its source is
   mutated or deleted; contents remain absent from model-visible protocol data.
4. An oversized, partial, corrupt, or version-mismatched candidate cannot
   replace a prior valid checkpoint; invalid recovery fails closed and then
   starts clean.
5. Cancellation, reset, unload, siblings, and recursive child Sessions cannot
   restore another Session's checkpoint.
6. A clean Profile with the installed plugin and configured
   `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC route proves timeout/crash recovery
   through real DSH tool calls and bounded official Session-log evidence.

