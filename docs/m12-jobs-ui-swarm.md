# M12 Jobs / UI / Swarm Architecture (RLM as a Job Consumer)

> English (authoritative) | [简体中文](m12-jobs-ui-swarm.zh-CN.md) | [Interactive diagram](m12-jobs-ui-swarm.html)

## Outcome

M12 consumes the existing official DSH job surface (`ctx.jobs`, `@deepseek-ai/dsh-jobs-local`,
`@deepseek-ai/dsh-tool-jobs`) so an RLM cell can run as a DSH-owned background job: the
plugin contributes ONE job producer per Session whose spec runs the same persistent
kernel/cell and reports bounded output through the official job record. No second Agent
loop, no custom scheduler, no Workflow engine, no Storage Domain, and no UI is added.
The DSH tools `jobs`/`job_read`/`job_kill` remain the UI/control surface; the plugin only
registers a job controller-facing producer.

The “swarm” row stays conditional: it requires a named external consumer and an
end-to-end scenario before any multi-agent orchestration is added. M12 does NOT
create swarm orchestration.

## Authority and API

- Authority: official `ctx.jobs` service (`start/wait/read/kill/list`), mounted by DSH base;
  the plugin registers one `attachController` producer for the Session it owns.
- The producer wraps the existing RLM runtime: `createRlmJobSpec` returns an INERT spec,
  and `run()` (called by the official job registry) lazily awaits
  `runtime.eval(sessionKey, cell)`, streaming bounded stdout/result into the job output;
  `kill` maps to the existing per-Session kernel dispose. `startRlmJob(ctx, parent, code,
  runtime)` is the consumer-path helper that calls `ctx.jobs.start` with that spec; a
  spec that is never started leaks no kernel/work.
- No plugin queue/scheduler: DSH decides job admission/lifecycle; the plugin only answers
  `start/wait/read/kill` against its own Session kernel.

## State and failure semantics

1. One job may be active per Session at a time (kernel is singular). A second start
   for the same Session is rejected while the first is running.
2. Job cancellation maps to the existing kernel cancel/dispose barrier: the owned process
   tree is killed, the Session kernel is evicted, and the job settles as cancelled with
   the existing typed error text.
3. M5 recovery still applies within a job-driven cell; M10 durable references are untouched
   by job lifecycle; M6 reset inside a job behaves exactly as through `rlm_eval`.
4. Plugin unload drains its own job producer; DSH-owned jobs outside the plugin are unaffected.
5. The DSH job record, not the plugin, is the model-visible history authority; the plugin
   never writes a duplicate history.

## Limits and non-goals

No custom Workflow/Job engine, no queue/scheduler, no cross-Session job routing, no new
Agent loop, no UI/markup, no swarm orchestration. UI remains DSH-owned; the plugin only
exposes one official job producer per Session.

## TDD acceptance contract

1. **RED:** accepted M11 has no job producer; a started job for a Session key fails with
   no job controller attached (observed as RED).
2. **GREEN:** the plugin attaches one controller; `start` returns a bounded job that
   awaits the same kernel cell and streams `stdout/result` into the official job output;
   `wait` completes; `read` returns bounded text; `kill` settles cancelled.
3. **Boundaries:** two concurrent starts for one Session reject the second; unload drains;
   M5/M6/M10 behaviors remain green; no second history is written.
4. **Clean Profile:** disposable installed Profile exercises a job through the official job
   tools and reads its bounded output (DSV4-FVE preferred; GLM fallback documented).
