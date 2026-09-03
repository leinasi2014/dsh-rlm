# M8 Continuable Spawn Architecture

> English (authoritative) | [简体中文](m8-continuable-spawn.zh-CN.md) | [Interactive diagram](m8-continuable-spawn.html)

## Outcome

M8 adds the smallest Python-facing path for work that must outlive its initiating
RLM cell. `rlm_spawn(prompt)` returns an opaque durable child Session id after
the official DSH continuable manager accepts the initial inbox message.
`rlm_followup(child_id, prompt)` accepts a later message into that same child’s
official FIFO inbox. Neither helper returns a child answer.

The child’s selected report and eventual settlement reach the direct parent only
through the official DSH parent inbox and Session log. The parent Agent loop,
not Python, decides when that inbox message becomes a turn.

## Authority and API

The executable authority is the installed `@deepseek-ai/dsh-subagent` types:
`ctx.subagents.startContinuable`, `followup`, and `reportFrom`. The official
upstream checkout remains the freshness authority. M8 reuses the existing
`rlm_eval` tool, Session-keyed Python kernel, host child-work lifecycle, M4
depth policy, and official Session lineage.

`rlm_spawn(prompt)` and `rlm_followup(child_id, prompt)` are private kernel
helpers, not DSH tools. Inputs are exact strings; `child_id` is a validated
opaque id returned by a previous successful spawn in the same Session. Invalid
input fails before child admission. A handle carries no result, runnable object,
credential, parent Agent, or cross-Session authority.

## State and failure semantics

1. Spawn succeeds only after DSH durably accepts the initial inbox message; it
   returns the child id and records it Session-locally as an owned handle.
2. The parent cell may then end. The continuable child keeps its official durable
   identity and its inbox owns later message order, including cold resume.
3. A follow-up succeeds only when the official manager admits it; cancellation
   before admission leaves no ghost message. The manager, not the plugin,
   serializes child turns.
4. A child report/settlement is never injected into an old or later Python cell.
   It is attributed and delivered by `reportFrom`/official settlement handling to
   the direct parent’s inbox.
5. M6 reset drops only Python state and handles for that parent Session. It does
   not secretly destroy an accepted official child. Plugin unload uses official
   continuable-descendant draining; a failed drain is surfaced, never hidden.
6. M5 snapshots never serialize live handles, child ids, inbox state, or child
   bookkeeping. Kernel recovery cannot manufacture authority over a child.

## Limits and non-goals

M8 introduces no custom queue, scheduler, background task, polling loop,
Storage Domain, host-restart promise, provider client, second Agent loop, UI,
or public service. It has no answer-await API, callback into Python, arbitrary
child lookup, cross-parent follow-up, or custom report routing. Existing M4
depth/tool filtering applies to continuable creation; exact-depth leaves deny
`rlm_eval` as before.

## TDD acceptance contract

1. **RED:** accepted M7 has no continuable Python helper and a clean Profile
   cannot create an official continuable child from `rlm_eval`.
2. **GREEN:** a Python cell creates one child, receives only its opaque id, then
   finishes; official logs prove the child Session and initial inbox entry exist.
3. **GREEN:** a later cell sends one follow-up to that id; official child inbox
   ordering and parent/child lineage are observable without a plugin queue.
4. **Lifecycle:** malformed/cross-Session handles dispatch nothing; cancellation,
   reset, recovery, unload, and child report/settlement preserve the stated
   ownership boundaries. M4 leaf denial remains exact.
5. **Clean Profile:** a disposable installed plugin proves child survival after
   the spawn cell returns, follow-up delivery, and parent inbox attribution.
   Prefer DSV4-FVE; during its outage record the GLM-5.2 fallback and re-run
   DSV4-FVE after recovery.
