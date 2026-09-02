# Reference Project Decisions

> English | [简体中文](reference-analysis.zh-CN.md)

## Pinned sources

| Reference | Commit | Direct V1 value |
|---|---|---|
| `PrimeIntellect-ai/prime-agent` | `6179a608f394d0858d463e40d648df0def6dbb7a` | Python owns execution state; the host owns credentials and model calls |
| `alexzhang13/rlm` | `854e688fbba9d8f8989e3da9989812e4b6dfe270` | The RLM core is a persistent namespace, a code loop, and an ordinary model-call function |

Exact source identities live in `ref/*/SOURCE_POINTER.json`. Local source
checkouts are read-only evidence and are not published.

## Adopted for V1

- context becomes a Python variable;
- one persistent namespace is reused within a Session;
- Python can loop, branch, and call the model;
- the TypeScript host owns Provider, credentials, Subagent, and cancellation;
- Python receives only prompts and visible text results;
- cells are serialized with hard timeout and output limits;
- the official DSH Agent Loop replaces a reference-specific outer
  `answer.ready` loop.

Reference RLM defaults to `max_depth = 1`, so V1 `rlm_query` is a one-shot leaf
call. Recursive child RLM is not a prerequisite.

## Bounded protocol versus references

Prime Agent ships a similar REPL/JSONL/text-truncation shape, but it does not
enforce a strict total JSONL frame budget or this Issue's per-channel content
bounds (query prompt/result, error detail, stderr, untrimmed raw-line counting,
LF-only wire). `alexzhang13/rlm` is a same-process local REPL and has no
TS↔Python wire at all. The mechanism is reused from the references, but the
strictly bounded protocol is dsh-rlm-specific hardening, and this project does
not claim that either reference's test suite covers these boundaries.

## Rejected for V1

- Prime Agent's daemon, TUI, installer, and complete repair machinery;
- Markdown REPL-block parsing and a second Agent Loop;
- Python-side model clients or credentials;
- a public `RlmService`, Provider registry, or conformance suite;
- run/context/checkpoint Storage Domain;
- snapshot/restore, continuable spawn, batching, and deep recursion;
- Workflow, Jobs, Team, UI, or observability runtime.

These are not permanently forbidden. Add one only after a real trigger in
[Future extensions](future-extensions.md).

## DSH adaptation

- `rlm_eval` derives the Session from the current `exec.agent`.
- The runtime keys Python processes by Session and accepts no model-supplied run ID.
- `rlm_query` uses the official one-shot Subagent and denies RLM tools in the child.
- Tool calls and results enter the official Session log.
- Plugin unload owns cleanup of every Python process and one-shot run.

Implementation line count is not a target. The only progress criterion is
whether the [M1 end-to-end loop](milestones.md#m1-rlm-and-self-iteration-loop)
passes in a real Profile.
