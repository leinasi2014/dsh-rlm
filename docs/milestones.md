# Milestones

> English | [简体中文](milestones.zh-CN.md)

Milestones define capability order and exit criteria, not live status, dates,
or owners. Completion is determined by executable results—not file count,
design volume, or lines of code.

## M1: RLM and self-iteration loop

**Outcome:** In a real DSH Profile, an Agent uses `rlm_eval` to read a local
file, calls a one-shot Subagent from Python, continues execution, reuses the
variables in a second cell, and returns the final answer.

**Included:**

- host-only function plugin and the only tool, `rlm_eval`;
- one persistent Python kernel per Session;
- top-level `await`, `rlm_query`, and bounded output;
- visible text returned from one-shot queries;
- concise system prompt;
- one automated loop test and one real Profile smoke.

**Exit criteria:**

1. The plugin builds, loads, and unloads in the target Profile.
2. The first cell reads a UTF-8 file from an absolute path into `context`.
3. Python continues after at least one `rlm_query` result.
4. A second `rlm_eval` reads variables from the first cell.
5. The Agent returns an answer based on the revised result.
6. Both tool calls and bounded results appear in the official Session log.
7. Child agents and Python processes are disposed at test completion.

Before M1 passes, do not implement snapshot, spawn, Storage, a public Service,
or a second Provider.

## M2: Local reliability baseline

**Outcome:** The core loop stops explicitly under common faults without leaking
processes or cross-Session state.

**Exit criteria:**

1. Two Sessions have isolated globals.
2. Concurrent cells in one Session are serialized.
3. Timeout or cancellation kills only the owning Session process tree and
   reports namespace loss.
4. The next `rlm_eval` starts a clean kernel.
5. Oversized output and protocol frames fail or truncate explicitly.
6. Queries beyond the per-cell limit are rejected.
7. No plugin-owned Python process survives plugin unload.

## Conditional milestones

These milestones have no predetermined order. Start one only when the matching
trigger in [Future extensions](future-extensions.md) is real.

| Milestone | Completion outcome |
|---|---|
| F1 Snapshot recovery | Restore supported variables after kernel loss and report skipped values |
| F2 Recursive child RLM | A child Session iterates within a depth limit and returns text |
| F3 Managed context sources | Load large text from stable file/attachment handles without model copying |
| F4 Batched query | Bounded, ordered, cancellable concurrent queries |
| F5 Second kernel | A second implementation passes the same end-to-end loop |
| F6 External consumer | Jobs, UI, or swarm reuse the runtime without creating a second authority loop |
