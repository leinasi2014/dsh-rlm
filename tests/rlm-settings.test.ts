import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ConfigSchema } from '../src/runtime.ts'
import {
  RLM_SETTINGS_NAMESPACE,
  assertRlmConfig,
  mergeRlmConfig,
  mountRlmSettings,
  registerRlmSettings,
  resolveRlmConfig,
} from '../src/settings.ts'
import type { RlmPluginConfig } from '../src/runtime.ts'

interface MemorySettingsStore {
  doc: Record<string, unknown>
}

/** In-memory SettingsProvider mirroring dsh-agent-swarm's test double. */
class MemorySettings extends SettingsProvider {
  private readonly store: MemorySettingsStore

  constructor(ctx: Context, options: { store: MemorySettingsStore }) {
    super(ctx)
    this.store = options.store
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.store.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.store.doc = { ...this.store.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function descriptor(ctx: Context) {
  return ctx.settings.describe().find(row => row.ns === RLM_SETTINGS_NAMESPACE)
}

async function mountSettings(ctx: Context, doc: Record<string, unknown>) {
  const fiber = ctx.plugin(MemorySettings, { store: { doc } })
  await fiber.await()
  return fiber
}

/** Fake subagent broker exposing exactly the two capabilities rlm requires. */
function fakeSubagents() {
  return {
    getProvider: (name: string) =>
      name === 'spawn' ? { capabilities: { depthLimit: true, toolFilter: true } } : undefined,
  }
}

test('mergeRlmConfig layers composition then user and resolves schema defaults', () => {
  const merged = mergeRlmConfig(ConfigSchema, { enabled: true, maxDepth: 2 }, { maxDepth: 4 })
  assert.equal(merged.enabled, true)
  assert.equal(merged.maxDepth, 4)
  assert.equal(merged.provider, 'spawn')
  assert.equal(merged.timeout, 30000)
  assert.equal(merged.maxQueries, 16)
})

test('no user settings resolves byte-equivalent defaults and keeps maxDepth = 1', () => {
  const merged = mergeRlmConfig(ConfigSchema, {}, undefined)
  assert.equal(merged.maxDepth, 1)
  assert.equal(merged.enabled, false)
  assert.equal(merged.maxQueries, 16)
  assert.equal(merged.kernelSandbox, 'auto')
})

test('assertRlmConfig rejects invalid staged values', () => {
  const ctx = { subagents: fakeSubagents() } as unknown as Context
  assert.throws(
    () => assertRlmConfig(ctx, { provider: 'nope' } as RlmPluginConfig),
    /not registered/,
  )
  assert.throws(
    () => assertRlmConfig(ctx, { provider: 'spawn', durableRoot: 'relative/path' } as RlmPluginConfig),
    /absolute host directory/,
  )
  assert.throws(
    () => assertRlmConfig(ctx, { provider: 'spawn', python: 'definitely-not-a-real-interpreter-xyz' } as RlmPluginConfig),
    /does not resolve/,
  )
})

test('apply-path registers the rlm namespace and read-back merges composition + user layer', async () => {
  const ctx = new Context()
  ctx.provide('subagents', fakeSubagents())
  try {
    const settingsFiber = await mountSettings(ctx, { rlm: { maxDepth: 4, guardQueryTokens: true } })
    const resolved = resolveRlmConfig(ctx, { maxDepth: 2 }, ConfigSchema)
    assert.equal(resolved.maxDepth, 4)
    assert.equal(resolved.guardQueryTokens, true)
    assert.equal(resolved.enabled, false)
    const row = descriptor(ctx)
    assert.ok(row, 'expected an rlm settings descriptor')
    assert.equal(row!.ns, RLM_SETTINGS_NAMESPACE)
    assert.equal(row!.applies, 'restart')
    assert.equal(row!.value.maxDepth, 4)
    assert.equal(row!.value.guardQueryTokens, true)
    await settingsFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('registerRlmSettings: invalid staged value blocks the save and reset returns composition', async () => {
  const ctx = new Context()
  ctx.provide('subagents', fakeSubagents())
  try {
    const settingsFiber = await mountSettings(ctx, {})
    registerRlmSettings(ctx, { maxDepth: 2 }, ConfigSchema)
    await ctx.settings.update(RLM_SETTINGS_NAMESPACE, { maxDepth: 5 })
    const current = ctx.settings.get(RLM_SETTINGS_NAMESPACE) as RlmPluginConfig
    assert.equal(current.maxDepth, 5)
    await assert.rejects(ctx.settings.update(RLM_SETTINGS_NAMESPACE, { durableRoot: 'relative' }))
    const afterInvalid = ctx.settings.get(RLM_SETTINGS_NAMESPACE) as RlmPluginConfig
    assert.equal(afterInvalid.maxDepth, 5)
    await ctx.settings.replace(RLM_SETTINGS_NAMESPACE, {})
    const reset = ctx.settings.get(RLM_SETTINGS_NAMESPACE) as RlmPluginConfig
    assert.equal(reset.maxDepth, 2)
    await settingsFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})


/**
 * M13 successor RED (load order): the plugin may apply before the Settings
 * service fiber activates, but the runtime must still mount with the merged
 * user layer once Settings becomes available. `mountRlmSettings` returns a
 * live binding: `effective()` always reflects { ...compositionDefaults,
 * ...userSettings }, never a stale early snapshot.
 */
test('mountRlmSettings effective() reflects the user layer when Settings mounts after the plugin', async () => {
  const ctx = new Context()
  ctx.provide('subagents', fakeSubagents())
  try {
    const binding = mountRlmSettings(ctx, { enabled: true, maxQueries: 16, maxDepth: 2 }, ConfigSchema)
    assert.equal(binding.effective().maxQueries, 16)
    assert.equal(binding.scope(), undefined)
    const settingsFiber = await mountSettings(ctx, { rlm: { maxQueries: 1 } })
    await settingsFiber.await()
    assert.equal(binding.effective().maxQueries, 1)
    assert.ok(binding.scope(), 'expected the rlm scope to be registered once Settings mounts')
    await settingsFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})
