import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { RlmPluginConfig } from './runtime.js'

/**
 * The official DSH settings namespace for the dsh-rlm host plugin. Disjoint
 * from `agent-swarm`; `settings.plugin.item` is keyed by this namespace.
 */
export const RLM_SETTINGS_NAMESPACE = settingsNamespace('rlm')

/** Minimal live Subagent provider handle used by the Tier B validation. */
interface SubagentCapabilities {
  depthLimit?: boolean
  toolFilter?: boolean
}
interface SubagentsLike {
  getProvider(name: string): { capabilities?: SubagentCapabilities } | undefined
}

/**
 * Read the live subagent broker without throwing when the service is absent,
 * so a headless composition that lacks `ctx.subagents` still resolves its
 * composition layer (the provider precondition is re-validated at each query).
 */
function subagentsOf(ctx: Context): SubagentsLike | undefined {
  const accessor = ctx as unknown as {
    subagents?: SubagentsLike
    get?: (key: string, strict?: boolean) => unknown
  }
  if (accessor.subagents && typeof accessor.subagents.getProvider === 'function') {
    return accessor.subagents
  }
  if (typeof accessor.get === 'function') {
    try {
      const got = accessor.get('subagents', false) as SubagentsLike | undefined
      if (got && typeof got.getProvider === 'function') return got
    } catch {
      // service absent; fall through
    }
  }
  return undefined
}

/** Resolve a bare or path-prefixed interpreter exactly like the runtime spawns it. */
function pythonResolves(python: string): boolean {
  const cmd = python.trim()
  if (cmd === '') return false
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return existsSync(cmd)
  }
  return onPath(cmd)
}

function onPath(cmd: string): boolean {
  const separator = path.delimiter
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ['']
  for (const dir of pathVar.split(separator)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = path.join(dir, cmd + (ext === '' ? '' : ext))
      try {
        if (existsSync(candidate)) return true
      } catch {
        // ignore a single unreadable entry
      }
    }
  }
  return false
}

/**
 * Tier B host-side validation (beyond the ConfigSchema, which stays the single
 * validation authority). Runs on save through the namespace `validate` hook so
 * a staged invalid value blocks the write. `provider` must name a registered
 * DSH Subagent provider; `durableRoot`, when non-empty, must be an absolute
 * host directory; `python` must resolve host-side, mirroring the runtime's own
 * spawn precondition.
 */
export function assertRlmConfig(ctx: Context, value: RlmPluginConfig): void {
  const provider = (value.provider ?? 'spawn').trim()
  if (provider === '') throw new Error('rlm: provider must not be empty')
  const subagents = subagentsOf(ctx)
  if (subagents !== undefined) {
    const selected = subagents.getProvider(provider)
    if (selected === undefined) {
      throw new Error(`rlm: provider "${provider}" is not registered on this DSH host`)
    }
    const capabilities = selected.capabilities ?? {}
    if (capabilities.depthLimit !== true || capabilities.toolFilter !== true) {
      throw new Error(`rlm: provider "${provider}" must support depthLimit and toolFilter`)
    }
  }
  if (typeof value.durableRoot === 'string' && value.durableRoot.trim() !== '') {
    if (!path.isAbsolute(value.durableRoot)) {
      throw new Error('rlm: durableRoot must be an absolute host directory')
    }
  }
  if (typeof value.python === 'string' && value.python.trim() !== '') {
    if (!pythonResolves(value.python)) {
      throw new Error(`rlm: python interpreter "${value.python}" does not resolve`)
    }
  }
}

/**
 * Register the `rlm` settings namespace for the owner plugin and return its
 * scope. The composition `config` is the `base` layer, `applies: 'restart'`
 * matches the swarm card's "restart DSH to apply" hint, and the Tier B
 * validation is wired through the namespace hook so a staged invalid value
 * blocks the save.
 */
export function registerRlmSettings(
  ctx: Context,
  config: RlmPluginConfig,
  schema: z<RlmPluginConfig>,
): SettingsScope<RlmPluginConfig> {
  return ctx.settings.register(RLM_SETTINGS_NAMESPACE, schema, {
    base: config,
    applies: 'restart',
    validate: (value) => assertRlmConfig(ctx, value),
  })
}

/**
 * Merge the composition `base` layer with the stored user section and resolve
 * schema defaults — exactly the reader `{ ...compositionDefaults, ...userSettings }`
 * the runtime consumes. With no user section the result is the schema defaults
 * byte-equivalent to the current M1-M12 base (maxDepth stays 1).
 */
export function mergeRlmConfig(
  schema: z<RlmPluginConfig>,
  base: RlmPluginConfig | undefined,
  user: Record<string, unknown> | undefined,
): RlmPluginConfig {
  return schema({ ...(base ?? {}), ...(user ?? {}) } as RlmPluginConfig)
}

/**
 * Resolve the stored user layer before constructing the runtime so a restart
 * really applies every field, mirroring swarm's host-load-order logic. When
 * Settings is absent (headless composition) register it lazily via injection;
 * when Settings is later replaced, re-register the namespace without partially
 * mutating an already-constructed runtime.
 */
export function resolveRlmConfig(
  ctx: Context,
  config: RlmPluginConfig,
  schema: z<RlmPluginConfig>,
): RlmPluginConfig {
  const settings = (ctx as unknown as { get?: (key: string) => unknown }).get?.('settings')
  if (settings === undefined) {
    ctx.inject(['settings'], (settingsCtx: Context) => {
      registerRlmSettings(settingsCtx, config, schema)
    })
    return config
  }
  const resolved = registerRlmSettings(ctx, config, schema).get()
  // Keep a scoped injection so a replacement Settings Provider re-registers the
  // namespace (the first callback sees the already-registered current provider).
  ctx.inject(['settings'], (settingsCtx: Context) => {
    if (settingsCtx.settings.get(RLM_SETTINGS_NAMESPACE) === undefined) {
      registerRlmSettings(settingsCtx, config, schema)
    }
  })
  return resolved
}
