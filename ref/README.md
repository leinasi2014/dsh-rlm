# Reference sources

`ref/` contains read-only architecture and code evidence for `dsh-rlm`.

- `prime-agent/` studies a productized RLM harness: persistent kernel, host bridge,
  recursive child agents, durable sessions, compaction, skills, and long-running work.
- `rlm/` studies the research-oriented RLM inference library: context-as-variable,
  REPL execution, recursive model calls, sandbox providers, persistence, and training.

Each reference has a `SOURCE_POINTER.json` that fixes the reviewed commit and tree.
The nested `source/` checkout is intentionally ignored by the outer project and must
remain unmodified. Architecture decisions belong in `docs/`; upstream code never
becomes a second DSH Agent Loop or canonical Session/state authority.

These snapshots are not the DeepSeek Harness compatibility authority and are not
updated merely to mean "latest." Before development, verify the selected DSH source
checkout against `deepseek-ai/deepseek-harness:master` with `pnpm check:upstream`,
then record the exact upstream SHA in the work item's evidence. Official DSH
`master` remains the live source-freshness authority; published packages and the
loaded runtime define executable compatibility. `ref/` remains frozen prior art.
