# dsh-rlm Core Architecture

> English | [简体中文](architecture.zh-CN.md)

## 1. V1 outcome

`dsh-rlm` adds one capability to DeepSeek Harness: the model can call one
`rlm_eval` tool to execute code in a persistent Python namespace, and that code
can call the model with `await rlm_query(prompt)`. The query text returns to
Python, the current cell continues, and a later `rlm_eval` call can reuse the
same variables.

V1 is complete when this path works in a real DSH Profile:

```text
DSH Agent Loop
  -> rlm_eval(code)
  -> current Session's Python kernel
  -> await rlm_query(prompt)
  -> DSH one-shot Subagent
  -> visible text returns to Python
  -> the cell continues and returns a result
  -> the Agent calls rlm_eval again or gives the final answer
```

V1 does not include a public Service, Storage Domain, run ID, checkpoint,
restore, `rlm_spawn`, recursive child RLM, Provider framework, background jobs,
UI, Workflow, or Team.

## 2. DSH boundary

| DSH capability | V1 use |
|---|---|
| Tools | Register the only model-facing tool, `rlm_eval` |
| Agent Loop | Own the outer execute, observe, iterate, or answer loop |
| Subagent | Execute each `rlm_query` as a one-shot child call |
| Session log | Persist official tool calls, results, and model messages |
| System Prompt | Explain persistent variables, file reads, and iteration |

The plugin is a host-only function plugin. With one tool, one implementation,
and one consumer, V1 does not create an `RlmService`. The private runtime selects
the kernel from the current `exec.agent` Session identity; the model cannot
submit a forgeable run ID.

## 3. The only tool

```ts
interface RlmEvalInput {
  code: string
}

interface RlmEvalResult {
  stdout: string
  result?: string
  truncated: boolean
}
```

- `code` is ordinary Python and supports top-level `await`.
- `stdout` and the last-expression result have byte limits.
- Python failures, query failures, timeout, and cancellation are explicit tool
  errors, not successful strings that start with `Error:`.
- Only one cell executes at a time for a Session; different Sessions have
  separate kernels and globals.

V1 needs no separate context-loading tool. Local Python is trusted execution,
not a sandbox, so it can read a user-provided absolute path directly:

```python
context = open(path, encoding="utf-8").read()
```

Large context becomes a Python variable without first being copied through the
model-facing tool input.

## 4. Session Python kernel

The first `rlm_eval` lazily starts one Python process for the current Session.
That process only:

1. keeps one persistent `globals` namespace;
2. serially executes cells with top-level `await`;
3. exposes `await rlm_query(prompt)`;
4. buffers and bounds stdout, stderr, and results;
5. communicates with the TypeScript host over a small JSON-lines protocol.

Later `rlm_eval` calls in the same Session reuse that process. The target
boundary keeps credentials, Provider objects, DSH Agent objects, and Session
transcripts out of Python. The child receives a fixed safe-name environment
allowlist instead of the host `process.env`: Windows keeps `PATH`,
`SystemRoot`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SYSTEMDRIVE`, `USERPROFILE`,
`TEMP`, and `TMP` (case-insensitive match, canonical output); POSIX keeps
`PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, and only the exact standard
`LC_*` category names; both platforms keep the public Python startup items
`PYTHONIOENCODING`, `PYTHONUTF8`, `PYTHONUNBUFFERED`, and `PYTHONPATH`. No
environment passthrough is exposed, and a custom `python` command uses the same
allowlist, so it must resolve through the allowlisted `PATH` or an absolute
path. Proxy variables, `VIRTUAL_ENV`/`CONDA_*`, `PYTHONHOME`,
`LD_LIBRARY_PATH`, `DSH_*`, and credential-looking variables are never
forwarded. The original environment-inheritance gap was audited and fixed in
[Issue #7](https://github.com/leinasi2014/dsh-rlm/issues/7). This is credential
hygiene, not a filesystem/process/network sandbox: trusted Python can still
read host-user-readable files, use the network, start processes, and read
on-disk credential files.

## 5. `rlm_query` round trip

When an active cell calls `await rlm_query(prompt)`:

1. Python sends a `query` message with a local `queryId`.
2. TypeScript uses the configured official one-shot Subagent Provider.
3. The child denies `rlm_eval`, making V1 equivalent to reference RLM's default
   `max_depth = 1`.
4. The host concatenates visible `text` blocks in order and ignores reasoning
   blocks.
5. No visible text, a non-completed stop reason, or infrastructure failure is
   an explicit error.
6. The one-shot run is disposed and `query_result` resumes the active cell.

Each cell has a simple query-count limit and a total deadline. V1 has no token
budget ledger or reservation/settlement transaction.

## 6. Self-iteration loop

### Inside one cell

```python
draft = await rlm_query("Write a draft from context")
critique = await rlm_query(f"Find the problems in this draft:\n{draft}")
revised = await rlm_query(
    f"Revise the draft from the critique.\nDraft: {draft}\nCritique: {critique}"
)
```

Python can loop, branch, split data, and use an earlier query result to decide
the next query.

### Across cells

After the DSH Agent receives a tool result, it can call `rlm_eval` again. The
second cell can read `context`, `draft`, `critique`, and `revised` left by the
first cell. The official Agent Loop decides whether to iterate or answer; the
plugin never creates a second Agent Loop.

## 7. Minimal protocol and lifecycle

V1 has six protocol messages:

```text
ready, eval, query, query_result, result, error
```

`ready` carries an integer version. Every eval and query has a local ID. Frames
and outputs must be byte-bounded. A cell emits exactly one terminal `result` or
`error`.

- Normal completion: return a bounded result and keep the kernel alive.
- Python or query failure: fail only the cell and keep the kernel alive.
- Cancel, hard timeout, protocol fault, or process crash: terminate that
  Session's process tree, report namespace loss, and create a fresh kernel on
  the next `rlm_eval`.
- Plugin unload: reject new cells and terminate all owned Python processes.

V1 does not promise variable recovery after a fault.

### Cancellation state machine (M2)

`RlmEvalInput` accepts `signal?: AbortSignal` from the tool call's
`exec.signal`. Parent cancellation affects only the owning Session kernel;
other Session kernels and globals remain intact.

- Pre-abort: reject as `cancel` without starting a kernel.
- Active abort: evict and kill the owning Session kernel, reject the cell as
  `cancel`, and create a clean kernel on the next eval.
- Settlement paths remove their abort listeners, and a late abort only acts
  when that cell is still the current pending request.
- Cancellation reuses the existing Kernel kill/evict path.

### Session serialization (Issue #2)

Concurrent `rlm_eval` calls for the same Session are never rejected `busy`;
they are serialized by a minimal per-Session FIFO queue:

- Each Session key owns one queue and one drain worker with at most one active
  cell; requests run in submission order, and a later cell sees the earlier
  cell's successful globals on the same kernel.
- The total deadline is frozen at `eval()` submission: queue wait and startup
  consume the same budget. A request whose budget expires before it is dequeued
  rejects as `timeout` and never starts a kernel; once active, the Kernel owns
  the remaining budget (startup + cell share one deadline).
- A queued request observes its own `AbortSignal` immediately: abort (or
  queued deadline expiry) settles only that entry with `cancel` (or `timeout`)
  and never touches the running kernel, so cancelling a queued cell does not
  evict the same-Session kernel.
- Kernel lookup/creation happens only at dequeue time; after a fatal
  (timeout, cancel, protocol fault, crash) the old kernel is evicted through
  the identity-checked `onExit` before the next entry dequeues, so a successor
  can only use a fresh kernel and the namespace loss is observable (old
  globals gone, new PID).
- `runtime.dispose()` is terminal: it rejects every not-yet-active queued entry
  with `cancel` synchronously, lets the active entry settle through the
  existing `Kernel.dispose` child-cleanup barrier, and its returned barrier
  waits for both the kernels and the drain workers; no queued work starts after
  dispose.
- Queues are per-Session: different Sessions still run in parallel with
  isolated kernels and globals; there is no global scheduler or cross-process
  queue. `RlmError kind='busy'` remains only as an unreachable internal
  defense of `Kernel.evalCell`.

### Bounded protocol contract (Issue #3)

- Total frame budget `MAX_FRAME_BYTES = 256 * 1024` is enforced on the exact
  serialized JSONL line **including its single terminating LF** (a CR on the
  wire, when present, counts as part of the line). Python protocol stdout is
  forced to LF-only (`newline="\n"`); the host counts the **untrimmed** raw
  line and rejects any line over the budget before parsing it.
- Content budgets are `64 * 1024` UTF-8 bytes for `prompt`, `query result`,
  `query error message/detail`, `stdout`, `result`, and `stderr`. If a payload
  fits the content budget but JSON escaping inflates the serialized frame
  beyond `MAX_FRAME_BYTES`, it is re-fit against the real serialized wire
  bytes and marked `truncated`.
- Every truncation/cut is UTF-8 code-point safe: no split characters, no
  U+FFFD, and a lone surrogate keeps its original U+D800 code-unit semantics.
- Oversized frames, unterminated no-newline buffers over the budget, frames
  that cannot make shrinking progress, and protocol faults terminate and
  evict the kernel (namespace lost); a recoverable typed error or a bounded
  truncated frame keeps the kernel alive.
- Query errors carry `phase='query'` and `kind='query_error'`;
  `frame.truncated` propagates to the public `RlmError.truncated`; `detail` is
  surfaced as stable text (strings verbatim, arrays/objects as JSON), and the
  tool-facing failure keeps `kind + message + Detail + [truncated]` within the
  64 KiB budget. `PROTOCOL_VERSION` stays `1`; no protocol message, Service,
  or framework was added.

### Query/child lifecycle (Issue #4)

One `rlm_query` call owns exactly one one-shot Subagent for the lifetime of
the cell that issued it:

- Every cell creates its own `AbortController`; the child's request signal is
  the merge of that controller with the caller's `exec.signal`. A timeout,
  caller cancel, protocol fault, kernel exit, or plugin dispose aborts the
  controller, so the provider cancels the child's remaining turn work.
- A cell's tool Promise settles only after its in-flight child work settles:
  every query task includes `run.dispose()` before it resolves, and terminal
  paths wait for that cleanup barrier before rejecting or resolving the cell.
  No one-shot child survives its cell's terminal frame.
- Terminal transitions use an explicit `active -> settling -> settled` shape:
  routing and child publication are blocked synchronously on the first terminal
  edge, and the session-map eviction plus the public cell Promise settle happen
  only after child quiescence. A concurrent same-Session eval is queued by the
  Issue #2 per-Session FIFO — it never slips through the settlement window; it
  starts only after the window closes, on the same kernel after a live
  settlement or on a fresh kernel after a fatal one. `Kernel.busy` is an
  unreachable internal defense, not the contract.
- Plugin unload returns an awaitable disposal barrier: `runtime.dispose()` is
  terminal synchronously (later evals reject `closed`) and resolves after every
  kernel's child cleanup barrier, so Cordis teardown can await real child
  quiescence instead of fire-and-forget cancellation.
- Late child outcomes never enter a later cell: the host drops any response
  whose query no longer belongs to the current cell (the pending-cell identity
  guard), and the Python kernel applies reply delivery on the event loop with
  task-local cell-owner tokens (`contextvars`), so ownership is fixed when a
  detached task is created and a retired cell's task can never open a query
  into a later cell. A reply is applied while its cell is still active — even
  when already queued before a terminal edge — and is dropped only once the
  owner has actually retired (ids below the current monotonic floor, or ids of
  the just-terminated cell); unknown, future, duplicate, and non-integer reply
  ids remain fatal protocol faults (Issue #1 contract). The reader never pops
  replies (delivery runs on the event loop and re-checks owner/future state),
  so no reader/loop InvalidStateError race exists, and user code may still
  catch a query error and keep the cell running with its sibling queries.
- A query that resolves `completed` with no visible `text` block is a typed
  `query` error (`phase='query'`), never an empty successful string.
- Query failures keep `kind='query'` / `phase='query'` at the model-facing
  tool boundary, alongside the Issue #3 bounded detail/truncation contract.

## 8. Minimal configuration

V1 needs:

- one-shot Subagent Provider name;
- Python command;
- total cell timeout;
- maximum output bytes;
- maximum queries per cell.

An unknown Provider, Python startup failure, or Provider that cannot deny the
RLM tool must fail explicitly rather than silently switching implementation.

## 9. First acceptance scenario

In a real DSH Profile:

1. the user supplies a local UTF-8 path and asks for analysis;
2. `rlm_eval` reads it into `context`;
3. the same cell completes at least one query round trip and keeps executing;
4. a second `rlm_eval` reads the first cell's variables and revises the result;
5. the Agent returns the final answer;
6. the official Session log contains both bounded tool calls and results.

Only this result proves the RLM and self-iteration loop. See
[Future extensions](future-extensions.md) for evidence-triggered additions and
[Milestones](milestones.md) for delivery order and exit criteria.
