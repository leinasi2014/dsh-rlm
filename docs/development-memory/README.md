# Development Memory

> English authority | [简体中文](README.zh-CN.md)

This directory preserves the development, repair, test, and review trail of
each human or AI contributor. GitHub Issues remain the authority for live task
state; these files are immutable historical evidence, not a second backlog or
agent-management system.

## Record sharding

Use one JSONL stream per independently acceptable workstream, not per agent,
prompt, edit, or commit:

```text
records/<creation-year>/issue-<N>.jsonl       # work governed by an Issue
records/<creation-year>/task-<slug>.jsonl     # bounded non-Issue work
```

Development, repair, testing, and review for the same open Issue stay in that
Issue's stream. New product scope or a defect found after closure gets a new
Issue stream. The creation-year directory provides natural old/new
sedimentation without moving closed evidence or duplicating GitHub state.

The paths are the index. Use `rg` to find a work item, agent, file, symbol, or
record ID:

```bash
rg --files docs/development-memory/records
rg '"issue":1|src/runtime.ts|Kernel.evalCell' docs/development-memory/records
```

Do not add a hand-maintained record index, database, vector store, or generated
cache to Git. If one workstream reaches 2 MiB or 1,000 records, continue with
`issue-<N>-part-02.jsonl` or `task-<slug>-part-02.jsonl`.

## Record ownership and granularity

Every materially participating agent writes its own record. The agent that
implements a feature or fixes a bug owns the corresponding implementation
record. Test designers, reviewers, and live-verification agents record their own
contribution instead of being folded into the implementer's identity.

Write at most one record per agent per frozen Candidate or handoff. Consolidate
that agent's iterative edits before the Candidate freezes. A blocking finding
that creates a successor Candidate receives a new record. A coordinator may
append records returned by other agents, but must preserve their declared
identity and may not claim their work.

Each compact JSON line contains:

- `schemaVersion`, unique `recordId`, and offset-aware `recordedAt`;
- `agent` identity, model, role, and declared reasoning effort;
- `issue` or a bounded `workItem`, plus `baseCommit` and `candidateRef`;
- summary and key `files`, each with durable semantic `pointers` such as a
  symbol, test name, heading, or `deleted` (line numbers may only supplement);
- implementation/diagnosis/review `steps`;
- test, review, or live `evidence` with target, normalized result, and note;
- known `limitations`; and optional `correctsRecordId` for an append-only
  correction.

Never store prompts, chain-of-thought, credentials, Session logs, Profile
contents, or private model output.

## Agent workflow

1. Bind Issue, base, Candidate, and your identity before material work.
2. Work only on the assigned surface and run the applicable checks.
3. Append your own record to the workstream with semantic pointers and honest
   evidence. Never edit, delete, or reorder an existing line; append a correction.
4. Stage the record with the material change. Put all participant `recordId`
   values in the Candidate packet and Issue/PR evidence.

## Hook and gates

Install the repository hook once per clone:

```bash
git config --local core.hooksPath .githooks
```

Run the same checks directly with:

```bash
pnpm check:memory
pnpm check:memory:staged
node scripts/check-development-memory.mjs --range <base>..<head>
```

The gate validates schema, line/shard limits, unique IDs, append-only history,
repository-relative semantic pointers, material-change evidence, and
`codex/issue-N-*` branch binding. CI repeats the range check. It intentionally
does not record every mechanical action or require every changed documentation
path to be repeated in JSON.

Identity is contributor-declared: automation cannot cryptographically prove it
or discover an omitted participant. Independent review and Candidate evidence
remain responsible for that social boundary.
