# Directory Structure and Language Boundary

> English | [简体中文](directory-structure.zh-CN.md)

## Language boundary

- **TypeScript/Node.js** registers the DSH tool, manages processes by Session,
  invokes the one-shot Subagent, propagates cancellation, and handles plugin
  disposal.
- **Python 3.11+** owns globals, executes cells, and implements
  `await rlm_query()` through a host callback.

V1 is one npm package plus one Python script. It does not split out a Service,
Provider, or protocol package.

## V1 layout

```text
dsh-rlm/
├─ package.json
├─ src/
│  ├─ index.ts              # config, system prompt, tool registration, dispose
│  └─ runtime.ts            # Session kernels, protocol, one-shot query bridge
├─ python-runtime/
│  └─ rlm_kernel.py         # globals, top-level await, rlm_query
├─ tests/
│  ├─ rlm-loop.test.ts      # Python/query/cross-cell loop
│  ├─ profile-smoke.test.ts # real DSH Profile composition
│  └─ development-memory-gate.test.ts # repository evidence gate
├─ docs/
│  └─ development-memory/
│     └─ records/<year>/    # append-only Issue/workstream agent trails
├─ scripts/                 # small repository governance checks
├─ .githooks/               # local fast gate; CI is authoritative
└─ ref/
```

The governance files do not change the V1 runtime boundary. Do not split runtime
code further until a file reaches the project size limit, a second
independent consumer appears, or a second real kernel implementation starts.
At that point, follow the triggers in [Future extensions](future-extensions.md).
