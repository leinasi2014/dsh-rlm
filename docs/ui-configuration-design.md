# dsh-rlm GUI Plugin Configuration Design

> English (authoritative) | [简体中文](ui-configuration-design.zh-CN.md) | [Interactive diagram](ui-configuration-design.html)

## Goal and scope

Give the Web UI **Settings > Plugins > Plugin configuration** an expandable card
for `dsh-rlm`, exactly like the shipped DSH host plugins (bash, agent-loop,
web-search) and the `dsh-agent-swarm` Team settings card. The card edits a
DSH-owned settings namespace; the Host runtime consumes the same normalized
configuration that `cordis.patch.yml` would provide today, so CLI and UI stay
one authority. No second UI system, no duplicate config schema, no new storage:
the settings namespace is the single user layer, and deployment composition
(cordis patches) remains the fallback layer.

Deliberately out of scope: configuring the Python kernel contents, provider
credentials, model selection (already owned by DSH Model settings), or any
per-Session behavior.

## Configuration tiers

### A. User-configurable (shown as editable fields)

These have safe defaults and are intended for per-deployment tuning. They are
the fields the card renders:

| Field | Kind | Default | Notes |
|---|---|---|---|
| `enabled` | toggle | `false` | master switch; gate before any kernel starts |
| `provider` | select (text) | `spawn` | one-shot query Subagent provider |
| `python` | text | `python` | interpreter; allow-listed PATH or absolute |
| `timeout` | number (ms) | `30000` | per-eval total budget |
| `maxStdout` | number (bytes) | `65536` | bounded cell stdout |
| `maxResult` | number (bytes) | `65536` | bounded cell result |
| `maxQueries` | number | `16` | rlm_query calls per cell |
| `maxContextBytes` | number (bytes) | `67108864` | managed context cap |
| `snapshotRecovery` | toggle | `false` | M5/M10 restore after owned kernel loss |
| `kernelSandbox` | select | `auto` | M9: auto/require/off |
| `durableRoot` | text (path) | none | M10 host-private durable root |
| `guardQueryTokens` | toggle | `false` | M11 observed-token guard |
| `maxQueryTokensPerCell` | number | `0` | M11 ceiling; 0 = off |
| `maxDepth` | number | `8` | M4 delegation-depth cap |

### B. Required-to-configure (validated, no safe runtime default)

- `enabled: true` is required for the plugin to do anything; the card makes it
  explicit and disables the rest of the form while off.
- `provider` must name a registered DSH Subagent provider; validated against the
  live `ctx.subagents` catalog (staged invalid value blocks save).
- `durableRoot`, when non-empty, must be an absolute host directory; closed-ACL
  path is validated server-side before commit.
- `python` must resolve; validated on save (host-side) rather than per keystroke.

### C. System-managed defaults (no user field, not rendered)

- Kernel/protocol constants: frame caps, `CHECKPOINT_CHUNK_BYTES`, process-tree
  kill strategy, env allowlist, scaffold reset, M2 FIFO/serialization rules.
- Security invariants: credentials never cross to Python; checkpoint/context
  values never model-visible; no second Agent loop; depth/cancellation semantics.
- DSH-owned identity: Session id, provider route, userId, model selection.
- These stay frozen by the architecture and tests; exposing them as UI fields
  would violate the accepted M1-M12 contract and is an explicit non-goal.

## UI layout (DSH-consistent)

The card mirrors `dsh-agent-swarm` and the shipped host cards:

```text
+--------------------------------------------------------------+
| dsh-rlm                                          [Configured] |
|   Persistent Python RLM loop for a DSH Session               |
+--------------------------------------------------------------+
| [Core] [Bounded I/O] [Recovery & Sandbox] [Guard]           |
|                                                              |
| Core                                                        |
|   [x] Enable dsh-rlm            Provider [spawn          v] |
|   Interpreter [python          ]  Depth [8        ]          |
|                                                              |
| Bounded I/O                                                  |
|   Per-cell queries [16]  Stdout bytes [65536]                |
|   Result bytes [65536]  Context bytes [67108864]             |
|   Timeout ms [30000]                                         |
|                                                              |
| Recovery & Sandbox                                          |
|   [ ] Snapshot recovery   Kernel sandbox [auto          v]   |
|   Durable root (absolute path) [____________________]        |
|                                                              |
| Guard                                                       |
|   [ ] Observed-token guard   Max tokens/cell [0      ]       |
|                                                              |
|   [Save plugin settings]                    [Reset defaults] |
+--------------------------------------------------------------+
```

- Card shell: header (mark + title + description + Configured badge), collapsible
  body, tab navigation, staged draft, per-field override badge, reset-to-composition,
  footer with Save/Saving/Saved/Save-failed states.
- Styling uses the same CSS custom properties as DSH (--dsh-color-border,
  --dsh-color-primary) and the same 38px inputs; no bespoke theme.
- Each field shows effective value = user layer > composition layer > schema default,
  and marks whether the user layer carries it (an override equal to default is still
  an override), exactly like CardForm in dsh-client-ui-settings-plugins.
- Save fences the namespace revision and writes only staged fields; invalid staged
  values block save and keep the draft.

## i18n

One dictionary namespace (`rlm.settings`) with `en` and `zh` in the client plugin,
registered through `ctx.locale.register` and augmented into LocaleNamespaceMap
(same pattern as swarm teamSkillSettingsEn/Zh). Labels, hints, validation
messages, tab names, and Save states are all localized. English is the fallback;
the locale mechanism is DSH-owned.

## Architecture

```text
Host (Node)                                     Browser (web)
+----------------------------------+               +----------------------------+
| dsh-rlm Host plugin              |               | dsh-rlm client plugin      |
|  Config schema (schemastery)     |               |  RlmSettingsCard (React)   |
|  settingsNamespace(rlm)   -------+-- settings --->|  settingsScope.bind(rlm)  |
|  reads user layer only           |   namespace   |  staged Draft + validation|
|  + composition layer (patch)     |               |  slots.settings.plugin.item|
|  runtime consumes normalized     |               |  ctx.locale.register(rlm)  |
+----------------------------------+               +----------------------------+
```

- Host: keep `ConfigSchema` as the single validation authority (already exported);
  add a settings namespace `rlm` via `@deepseek-ai/dsh-settings` so the user layer
  merges over the cordis-composed defaults; runtime reads
  `{ ...compositionDefaults, ...userSettings }`.
- Client: a new client entry (`exports["./client"]` + `dsh.client` manifest like
  swarm) registers the card under `settings.plugin.item` keyed by the namespace;
  it requires the same client packages swarm uses (locale, settings, slots,
  ui-settings-plugins).
- No changes to the accepted kernel/protocol; the runtime surface stays byte-for-byte
  backward compatible (M1-M12).

## Global integration view (dsh-rlm x dsh-agent-swarm)

Both plugins live as siblings under `packages/.external` and are composed into
the same DSH Profile, so coexistence is a first-class design requirement.

### Verified cross points (source evidence)

| Dimension | dsh-rlm | dsh-agent-swarm | Verdict |
|---|---|---|---|
| Plugin form | host function plugin, `inject = [tools, subagents, systemPrompt]` | bundle plugin (`cordis.patch.yml` + `cordis:group`), `inject = [tools, subagents, agents, sessions, systemPrompt, sessionPersistence, storageDomain]` | coexist; DSH stacks bundle + function plugins |
| Tool names | `rlm_eval` | `agent_swarm_*` (26 tools) | disjoint |
| Subagent provider | reads `provider` (default `spawn`) | reads `memberProvider` (default `spawn`) plus scheduler/review providers | same official `ctx.subagents` registry; may share `spawn` or use distinct keys |
| systemPrompt sections | `name = tool:rlm_eval`, order 150 | `name = agent-swarm:usage`, order 118 (configurable) | disjoint (name-unique, order-sorted) |
| Jobs | `attachController('rlm')`, `startRlmJob` | `jobsBridge` read-only projection (`agent_swarm_list_jobs`, kind `team-task`) | disjoint kinds; shared DSH jobs list shows both kinds (filter by kind) |
| Settings namespace | planned `settingsNamespace('rlm')` | `settingsNamespace('agent-swarm')` | disjoint; `settings.plugin.item` is keyed by namespace (official external-plugin extension point) |
| Storage | none (M10 `durableRoot` is a host-private file) | `ctx.storageDomain` Team aggregate | disjoint; rlm durable refs never enter Storage Domain |
| Client | none today | `dsh.client` web plugin (dashboard + settings card) | disjoint; each card keys its own namespace |

### DSH mechanism reconciliation

- `cordis.patch.yml` layers compose bundle layers then the user patch layer;
  `cordis:include` / `cordis:group` are official Loader built-ins, so a single
  Profile may carry both plugins plus the base/headless bundles.
- `settings.plugin.item` is officially documented as the external-plugin card
  extension point, keyed by the settings namespace of the contributing plugin
  (`packages/client/ui-settings-plugins/src/client/slot-contract.ts`), so the
  new rlm card and swarm card dispatch independently.
- `ctx.settings` namespaces, `ctx.systemPrompt.section` names, `ctx.tools`
  names, and `ctx.subagents` provider keys are all name-scoped; no cross-plugin
  override is possible without an explicit same-name registration.

### Coexistence norms to freeze

1. Shared `spawn` subagent provider is fine (DSH registry is concurrency-safe);
   separate `provider` / `memberProvider` keys when resource isolation is wanted.
2. Depth stacking: a Captain member executing `rlm_eval` adds subagent layers;
   keep `maxDepth` (rlm) within the remaining budget of `memberMaxDepth` (swarm)
   under DSH's absolute cap of 8. Recommended: `memberMaxDepth=1` + `maxDepth=1`
   (deepest observed branch = 2).
3. Jobs list merging: `rlm` jobs and `team-task` projection rows share the DSH
   Jobs surface; use kind filters when both bridges are enabled.
4. Prompt sections are self-contained: rlm (order 150) and swarm usage (order
   118) both appear in one model context; neither may assume the other exists.
5. Sandbox: rlm kernels use `ctx.sandbox` (Session policy); swarm execution
   roots are git-worktrees under the same DSH sandbox policy - keep
   `executionRootsBase` inside an allowed workspace root when `kernelSandbox`
   is `require`.
6. Settings save semantics: both plugins register restart-applied namespaces
   (`applies: restart`); the rlm card must show the same "restart DSH to apply"
   hint as the swarm card.

## Multi-agent execution plan

Directed by the coordinator in this repository, using `dsh-agent-swarm` (already a
sibling `packages/.external` project) with a fresh clean dsh-rlm worktree per lane:

1. **Architecture lane (agent A):** freeze this design + Archify diagram; verify the
   settings-namespace merge against installed `@deepseek-ai/dsh-settings` types.
2. **Host lane (agent B):** add `settingsNamespace('rlm')` + merge reader + focused
   tests (schema unchanged, backward compatible).
3. **Client lane (agent C):** implement `RlmSettingsCard` + locales + slot
   registration; reuse swarm/shipped card scaffolding; browser tests.
4. **Integration lane (agent D):** Profile + Web smoke, i18n check, memory records.
5. **Independent review (agent E, read-only):** contract/architecture + UI review;
   blocking findings open successor RED before any production fix.

Swarm lanes write disjoint scopes; only the coordinator touches shared runtime.ts.
At most two active writers; investigation/review are read-only.

## Acceptance

1. Settings > Plugins shows a `dsh-rlm` card in a loadable Profile; enabled toggle
   and all user-configurable fields persist and survive DSH restart (restart hint).
2. Save writes only staged fields fenced by revision; invalid staged values block
   save and keep the draft; reset returns to composition values.
3. Runtime behaves identically whether configured via UI or cordis patch (same
   normalized config), and M1-M12 offline + live smokes stay green.
4. zh/en labels render with the rest of the DSH settings UI (locale parity).
5. Out-of-scope constants remain non-fields and are covered by the accepted tests.

## Risks and mitigations

- Swarm/worktree isolation bugs could block lanes -> stop, open a clean dsh-rlm repair
  worktree, fix, then resume (per PTC). Collected swarm issues are filed separately.
- settings namespace registration is host-load-order sensitive -> register in a
  `ctx.effect` after provider is available and re-register on provider swap (swarm
  precedent).
- UI card without live model catalog: provider/path validation is host-side on save,
  not per keystroke, to avoid extra model calls.
