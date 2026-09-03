# M4 Recursive Child RLM Architecture

> English (authoritative) | [简体中文](m4-recursive-child-rlm.zh-CN.md)

## Outcome

M4 lets `rlm_query` delegate to a depth-bounded child DSH Session that may use
its own `rlm_eval` and Session Python kernel. It composes the existing plugin
with the official DSH Subagent and Session authorities; it does not create a
second agent loop or call a model client directly.

```text
root DSH Agent (depth 0)
  -> rlm_eval / root kernel
  -> rlm_query
  -> child DSH Session (depth 1, recursive when depth < maxDepth)
       -> its own rlm_eval / its own kernel
       -> rlm_query
       -> leaf DSH Subagent (depth == maxDepth, rlm_eval denied)
  -> visible child text resumes the parent Python cell
```

## Depth contract

- Add `maxDepth`, default `1`, integer range `1..8`.
- Root delegation depth is `0`. A child is always `parentDepth + 1`.
- If `childDepth < maxDepth`, start an official child DSH Session with
  `rlm_eval` available. Its Agent may iterate and owns an isolated kernel.
- If `childDepth == maxDepth`, preserve the current one-shot leaf behavior and
  deny `rlm_eval` with the official tool filter.
- A request beyond the cap is rejected by the official DSH depth authority.
- `maxDepth = 1` is backward compatible with M1/M2: every `rlm_query` is a leaf
  one-shot call and cannot invoke `rlm_eval`.

The runtime derives depth from official DSH Session/runtime metadata and passes
the cap through `ctx.subagents.start`. It does not trust model-supplied depth or
maintain a parallel counter. Before the first branch admission it obtains the
selected official provider and requires both `depthLimit` and `toolFilter`:
the former authorizes the absolute cap and the latter guarantees structural
leaf denial. Capability absence therefore fails before any recursive child is
created; `start()` remains the authoritative enforcement point at each child.

## Ownership and isolation

- Each recursive child has an official child Session with persisted parent and
  delegation-depth metadata.
- Every child Session key selects a distinct Python kernel and globals. Parent,
  sibling, and descendant namespaces are never shared.
- Each parent cell owns the child branch created by its `rlm_query`; visible
  text returns only after that branch completes and disposes.
- The official DSH Session log remains the sole model-interaction history. The
  plugin stores no parallel transcript or recursive run record.

## Lifecycle contract

Timeout, caller cancellation, protocol fault, kernel exit, and plugin unload
close admission to the owned branch, propagate abort through every descendant,
and await descendant/disposal quiescence before the parent cell settles. A late
descendant result cannot publish into a retired or later cell. Unrelated
Sessions remain unaffected.

Query text/result byte bounds and the per-cell query count apply at every
kernel boundary. Each child Session gets its own cell budget; there is no
shared token or cost ledger in M4.

## Non-goals

- continuable/background spawn or inbox delivery;
- a custom recursive scheduler, second Agent Loop, or direct Provider client;
- shared Python globals between recursion levels;
- persistence or resumption of a recursive tree after restart;
- batched queries, dynamic per-call depth, or model-selected Providers;
- global token/cost accounting.

## Acceptance examples

1. `maxDepth=1` retains the existing one-shot behavior and leaf tool denial.
2. At `maxDepth=2`, a depth-1 child uses its own `rlm_eval`, calls a depth-2
   leaf, and returns visible text to the root Python cell.
3. At `maxDepth=3`, two recursive child levels complete and no depth-4 Session
   can be created.
4. Root, child, sibling, and leaf Session lineage is visible in official DSH
   Session metadata/logs; Python globals stay isolated.
5. Provider capability absence fails before partial recursive work begins.
6. Timeout, cancel, and plugin unload leave no descendant agent or Python
   process alive and do not affect unrelated Sessions.
7. A clean Profile with `DeepSeek-V4-Flash-Vision-Exp` proves a real depth-2
   and depth-3 path using the installed plugin, official Subagent APIs, and
   bounded Session-log evidence.
