# dsh-rlm

> English | [简体中文](README.zh-CN.md)

`dsh-rlm` is a minimal Recursive Language Model (RLM) plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It gives a
DSH Agent one tool, `rlm_eval`, backed by a persistent Python namespace for the
current Session.

Python cells support top-level `await` and can call
`await rlm_query(prompt)`. The host answers that call through an official
one-shot DSH Subagent, returns visible text to Python, and lets the cell continue.

> Status: M1-M13 are implemented, reviewed, and DSV4-FVE clean-Profile verified.
> See [Project status](docs/project-status.md) and [Milestones](docs/milestones.md).

![dsh-rlm architecture](docs/dsh-rlm-architecture.visual-check.1440x900.light.png)

The interactive diagram is available in
[docs/dsh-rlm-architecture.html](docs/dsh-rlm-architecture.html).

## Goal

The V1 goal is deliberately small:

```text
DSH Agent
  -> rlm_eval(code)
  -> current Session's persistent Python kernel
  -> await rlm_query(prompt)
  -> one-shot DSH Subagent (rlm_eval denied)
  -> visible text returns to Python
  -> cell continues
  -> a later rlm_eval reuses the same globals
```

The DSH Agent Loop and official Session log remain authoritative. Python never
becomes a second Agent Loop and does not receive DSH Provider or Session objects.

## Implemented

- one host-only function plugin and one model-facing tool: `rlm_eval`;
- one persistent Python process and globals namespace per DSH Session;
- top-level `await` and last-expression results;
- JSON-lines host/kernel protocol;
- `await rlm_query(prompt)` through a one-shot DSH Subagent;
- recursion prevention through `toolFilter: { deny: ['rlm_eval'] }`;
- typed syntax, runtime, protocol, timeout, cancellation, and process errors,
  with explicit query failure propagation;
- byte-bounded stdout and last-expression results;
- per-cell query count limit;
- timeout/cancellation eviction and clean namespace recreation;
- plugin teardown for owned Python kernels;
- M3 managed context: an optional `contextPath` is kernel-read as one bounded,
  strict UTF-8 regular file and published atomically as protected `context`;
- M4 recursive child RLM: official depth-bounded child Sessions with isolated kernels;
- M5 snapshot recovery: opt-in restore after owned kernel loss (JSON-safe globals + context);
- M6 manual reset: Session-local FIFO reset through `rlm_eval({ reset: true })`;
- M7 batched query: bounded ordered concurrent `rlm_query_batched` with drain-before-failure;
- M8 continuable spawn: official continuable child Sessions with parent inbox delivery;
- M9 sandbox-backed kernel: `kernelSandbox: auto|require|off` via `ctx.sandbox` +
  `ctx.sandboxPolicy`, protocol v4 host-private chunked M5 checkpoint, workspace cwd;
- M10 cross-host durable persistence: opt-in `durableRoot` atomic references with
  new-runtime restore and typed version-mismatch failure;
- M11 token guard: `guardQueryTokens` / `maxQueryTokensPerCell` reading the official
  `tokenMeter.measure(...).baseline.usage` observation (never invents tokens);
- M13 GUI plugin configuration: official `rlm` settings namespace + `RlmSettingsCard` under Settings > Plugins (en/zh, staged draft, restart-applied);
- M12 job consumer: official `ctx.jobs` `rlm` controller + `createRlmJobSpec` /
  `startRlmJob` (no second Agent loop; swarm stays trigger-gated);
- offline tests plus gated real clean-Profile smoke tests.

## Milestone roadmap

Accepted on `main`: M1-M13 (see [Milestones](docs/milestones.md)). Remaining rows
in [Future extensions](docs/future-extensions.md) are conditional and
trigger-gated:

- a public `RlmService` or Kernel Provider framework (only with a second consumer);
- container or remote kernels (route B — separate contract and trigger);
- Swarm orchestration beyond the M12 job consumer (named consumer +
  end-to-end scenario required).

Open reliability defects and conditional future work are separated in
[Project status](docs/project-status.md). GitHub Issues are the live work authority.

## Security model

The current Python kernel is **trusted local execution, not a sandbox**.
`rlm_eval` can read and modify files and start processes with the DSH host user's
permissions. Do not enable it for untrusted users, prompts, or workspaces.

The child Python process receives only a fixed safe-name allowlist instead of
the full host environment. On Windows: `PATH`, `SystemRoot`, `WINDIR`,
`COMSPEC`, `PATHEXT`, `SYSTEMDRIVE`, `USERPROFILE`, `TEMP`, and `TMP`. On
POSIX: `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, and the exact standard
`LC_*` category names. Both platforms also keep the public Python startup items
`PYTHONIOENCODING`, `PYTHONUTF8`, `PYTHONUNBUFFERED`, and `PYTHONPATH`. No
arbitrary environment passthrough is supported, and a custom `python` command
uses the same filtered environment. Proxy variables, `VIRTUAL_ENV`/`CONDA_*`,
`PYTHONHOME`, `LD_LIBRARY_PATH`, `DSH_*`, and credential-looking variables are
never forwarded. This is credential hygiene, not a sandbox: trusted Python can
still read host-user-readable files, access the network, start processes, and
read on-disk credential files. See [SECURITY.md](SECURITY.md) and
[Issue #7](https://github.com/leinasi2014/dsh-rlm/issues/7).

From M9, `kernelSandbox` can confine that same trusted execution to the DSH
Session sandbox policy: `auto` (default) uses `ctx.sandbox` + `ctx.sandboxPolicy`
when the loaded Profile mounts them, `require` fails closed, and `off` keeps the
legacy trusted-local spawn. Under a confined mode the kernel starts in the
Session workspace root and its file effects follow the same read-only /
workspace-write / danger-full-access ladder as DSH bash/fs tools; Windows ACL
reports partial enforcement and reads/network remain same-world unconfined.

## Requirements

- Node.js `^22.19.0` or `>=24`;
- pnpm `9.15.9`;
- Python 3.11+ available as `python` on `PATH`;
- a compatible DeepSeek Harness checkout/Profile with the peer dependencies in
  [package.json](package.json);
- a configured DSH one-shot Subagent provider (the default is `spawn`).

## Local development

```bash
pnpm install --frozen-lockfile
git config --local core.hooksPath .githooks
pnpm check:memory
pnpm typecheck
pnpm build
pnpm test
```

The two real Profile tests are intentionally gated because they install a fresh
Profile and call a configured model. The current test harness expects this
repository at `packages/.external/dsh-rlm` inside a DeepSeek Harness checkout;
it is not an independent-clone smoke runner:

```bash
RLM_LIVE_SMOKE=1 DSH_HOME=/path/to/configured/dsh-home \
  node --test tests/profile-smoke.test.ts
```

Never point the live smoke at an unverified or user-owned target. It creates
and removes an isolated temporary DSH home. The complete `settings.yaml` and,
when present, the complete `.credentials.yaml` are copied byte-for-byte from
the supplied `DSH_HOME`; in the disposable copy only, the top-level
`agent-default-model` block is deterministically rewritten to provider
`vllm` and model `DeepSeek-V4-Flash-Vision-Exp`, so the isolated run
exercises the explicit vLLM/PTC route instead of the ambient default. Override
with `RLM_LIVE_PROVIDER` and `RLM_LIVE_MODEL` if needed. For an external
worktree, point the test at the authoritative harness checkout with
`RLM_DSH_REPO_ROOT` (resolved to an absolute path); without it the in-tree
three-level default is used, and the test fails fast with a bounded non-secret
message when `apps/cli/src/bin.ts` is missing there. Ambient settings and
credentials are never rewritten and are asserted byte-unchanged after the run.
Those disposable temporary files and Session logs must never be committed or
uploaded.

## Install into a DSH Profile

Build this checkout, then run the following from the root of a compatible
DeepSeek Harness checkout (where its `pnpm dsh` command is available):

```bash
pnpm dsh plugin --profile <profile> add -w /absolute/path/to/dsh-rlm
```

Enable it in the Profile's Cordis composition:

```yaml
- insert:
    - id: rlm
      name: dsh-rlm
      config:
        enabled: true
        provider: spawn
        python: python
        timeout: 30000
        maxStdout: 65536
        maxResult: 65536
        maxQueries: 16
        maxContextBytes: 67108864
```

The values above are the schema defaults. `provider` defaults to `spawn`. The
six runtime settings are optional and validated by the single `Config` schema:

| Setting | Default | Legal range / unit |
|---|---|---|
| `python` | `python` | non-empty interpreter command; resolved through the allowlisted `PATH` or an absolute path |
| `timeout` | `30000` | integer `1000..3600000` ms per eval |
| `maxStdout` | `65536` | integer `1024..262144` UTF-8 bytes of cell stdout |
| `maxResult` | `65536` | integer `1024..262144` UTF-8 bytes of the cell result |
| `maxQueries` | `16` | integer `1..4096` `rlm_query` calls per cell |
| `maxContextBytes` | `67108864` | integer `1048576..1073741824` bytes of one managed UTF-8 context file |
| `snapshotRecovery` | `false` | boolean; restore JSON-safe globals + context after owned kernel loss (M5) |
| `kernelSandbox` | `auto` | `auto` / `require` / `off` (M9) |
| `durableRoot` | *(unset)* | absolute host directory for cross-restart checkpoint references (M10) |
| `guardQueryTokens` | `false` | enable the per-cell observed-token guard (M11) |
| `maxQueryTokensPerCell` | `0` | positive integer ceiling; `0` disables (M11) |

This repository has not published an npm package. The command above is a real
local-package Profile installation, not a registry installation.

## M9-M12 operational guide

The plugin configuration below enables every milestone in one Profile. All keys
are optional; the values are the schema defaults unless noted.

```yaml
- insert:
    - id: rlm
      name: dsh-rlm
      config:
        enabled: true
        provider: spawn
        kernelSandbox: auto        # M9: auto | require | off
        snapshotRecovery: true     # M5/M10: checkpoint after owned kernel loss
        durableRoot: /absolute/host/durable  # M10: references only; host-owned
        guardQueryTokens: true     # M11: per-cell observed-token guard
        maxQueryTokensPerCell: 1000000   # M11: observed-token ceiling, 0 = off
        timeout: 30000
```

### M9: sandbox-backed kernel

`kernelSandbox` governs how the Session Python process is launched:

- `auto` (default): if the loaded Profile mounts `ctx.sandbox` and
  `ctx.sandboxPolicy`, the kernel runs confined under the Session policy
  (base default `workspace-write`); otherwise it keeps the legacy trusted
  spawn. It never silently bypasses a broken sandbox — a runner failure fails
  closed.
- `require`: fail before any Python starts when the official sandbox services
  are missing or unusable.
- `off`: trusted local spawn, exactly M1-M8 behavior.

Observable behavior under a confined mode:

- The kernel starts with `cwd` = the Session workspace root, so relative
  Python paths resolve inside the workspace.
- File effects follow the same ladder as DSH bash/fs tools: writes inside the
  workspace succeed, writes outside are denied under `workspace-write`
  (test with a closed-ACL target on Windows), `read-only` denies writes, and
  `danger-full-access` bypasses confinement.
- M5 checkpoints move through bounded chunked protocol frames (protocol v4)
  and stay host-private; the kernel never writes a sandbox-visible checkpoint.
- Windows uses the ACL restricted-token runner, which reports `partial`
  enforcement (Everyone/hard-link boundaries remain); reads and network stay
  same-world unconfined.

Verify from a cell:

```python
import os
open('inside_ws.txt', 'w').write('ok')   # succeeds under workspace-write
os.getcwd()                              # == Session workspace root
```

### M10: cross-host durable persistence

With `snapshotRecovery: true` and an absolute `durableRoot`, after each
committed checkpoint the host atomically publishes a reference pair:

```
<durableRoot>/<sha256(sessionId)>.checkpoint.json
<durableRoot>/<sha256(sessionId)>.meta.json
```

- The reference is bounded (<= 8 MiB per Session, <= 64 MiB root) and contains
  no Session id, no values, and no context text.
- A new runtime instance (plugin restart, another host with the same root) can
  restore the same Session through the existing M9 transport.
- `rlm_eval({ reset: true })` deletes that Session reference only; plugin
  unload retains it.
- Version or content-hash mismatch fails closed with a typed `snapshot` error
  and starts the Session fresh — it never guesses state.
- Treat `durableRoot` as host-private: never commit it, mirror it, or point a
  model-visible path at it.

### M11: per-cell token guard

With `guardQueryTokens: true` and a positive `maxQueryTokensPerCell`, every
`rlm_query` / `rlm_spawn` admission first reads the official
`ctx.tokenMeter.measure(parent.session)` observation:

- Only `TokenMeasurement.baseline.usage` counts (when
  `baseline.kind === "usage"`); `estimated` / `none` baselines are
  treated as unobserved and do not block.
- No tokens are invented, estimated, or extrapolated; Python never sees token
  numbers; the guard writes nothing to the Session log.
- Over budget rejects before child dispatch with a typed `query` error
  (phase `query`). `maxQueryTokensPerCell: 0` (default) disables the guard.
- Note: `measure(session)` is session-wide pressure, so the ceiling is an
  effective Session-wide cap rather than a strictly per-cell one.

### M12: RLM as a DSH job consumer

The plugin lazily attaches the official `rlm` job controller when the loaded
Profile mounts `ctx.jobs` (DSH `jobs-local` + `tool-jobs`); a Profile
without it loads normally and simply has no job surface.

For a host-side consumer that wants an RLM cell as a DSH-owned background job:

```ts
import { createRlmRuntime, startRlmJob } from 'dsh-rlm'
const runtime = createRlmRuntime(ctx, { enabled: true })
const jobId = startRlmJob(ctx, parent, 'value = 41', runtime)
// Watch/read through the official DSH job tools: jobs -> job_read -> job_kill.
```

- `createRlmJobSpec` returns an inert spec; the cell starts only when the
  official registry calls `run()` (`ctx.jobs.start`). A never-started job
  leaks no kernel/work.
- `cancel` maps to the per-Session kernel dispose; the job settles as
  `killed`; `readOutput` returns bounded stdout/result.
- No second Agent loop, scheduler, queue, Workflow engine, Storage, or UI
  markup; swarm stays conditional on a named consumer + end-to-end scenario.

### Boundary checks before live verification

- `pnpm build` must run before Profile smokes: `package.json` `main`
  loads `lib/index.mjs`, not `src`.
- Cordis requires `inject` for directly read services; the plugin reads
  `jobs` / `sandbox` / `sandboxPolicy` / `tokenMeter` via non-strict
  `ctx.get`, so a Profile missing any of them still loads.
- Live acceptance per milestone:

```bash
RLM_LIVE_SMOKE=1 DSH_HOME=/path/to/configured/dsh-home \
  RLM_LIVE_PROVIDER=dsv4f-local RLM_LIVE_MODEL=DeepSeek-V4-Flash-Vision-Exp \
  node --test --test-name-pattern "M9 Issue#42|M10 Issue#44|M11 Issue#46|M12 Issue#48" \
  tests/profile-smoke.test.ts
```

### M13: Settings UI (Settings > Plugins)

- In the DSH Web UI open **Settings > Plugins > Plugin configuration**; `dsh-rlm`
  shows its own card (tabs Core / Bounded I/O / Recovery & Sandbox / Guard) with
  the 14 user-configurable fields, staged draft, per-field override badges,
  reset-to-composition, and Save/Saving/Saved/Failed states.
- Saves apply on restart (`applies: restart`) — restart DSH to apply, exactly
  like the `dsh-agent-swarm` Team card.
- CLI and UI share one authority: runtime reads
  `{ ...compositionDefaults, ...userSettings }`; `cordis.patch.yml` stays the
  composition layer, so the same normalized config is consumed either way.
- i18n: `en` fallback plus `zh` under the `rlm.settings` locale namespace.

## Example

The Agent can call `rlm_eval` with an absolute `contextPath` and a cell such as:

```python
draft = await rlm_query("Summarize the key evidence in this context:\n" + context)
draft
```

A later cell in the same DSH Session can reuse `context` and `draft`:

```python
revision = await rlm_query("Critique and improve this draft:\n" + draft)
revision
```

## Documentation

- [Architecture](docs/architecture.md)
- [Interactive architecture diagram](docs/dsh-rlm-architecture.html)
- [Directory and language boundaries](docs/directory-structure.md)
- [Milestone definitions](docs/milestones.md)
- [Project status: completed and incomplete work](docs/project-status.md)
- [Reference analysis](docs/reference-analysis.md)
- [Independent review reconciliation](docs/review-findings.md)
- [GitHub Issue repair playbook](docs/issue-repair-playbook.md)
- [Development memory and agent evidence](docs/development-memory/README.md)
- [Future extensions and their triggers](docs/future-extensions.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

Chinese counterparts are available from [README.zh-CN.md](README.zh-CN.md) and
the language switch at the top of every core document.

## References

The repository contains pinned source identities—not vendored upstream source—for:

- `PrimeIntellect-ai/prime-agent@6179a608f394d0858d463e40d648df0def6dbb7a`;
- `alexzhang13/rlm@854e688fbba9d8f8989e3da9989812e4b6dfe270`.

See [ref/README.md](ref/README.md). The ignored `ref/*/source/` checkouts are local,
read-only review evidence and are not published in this repository.

## License

[MIT](LICENSE). This package originated inside the MIT-licensed DeepSeek Harness
checkout, so its upstream copyright notice is preserved; see [NOTICE](NOTICE).
