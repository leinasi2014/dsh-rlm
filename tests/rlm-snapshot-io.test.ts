import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime } from '../src/runtime.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function removeTree(directory: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      await sleep(50)
    }
  }
  throw last
}

function durableTarget(root: string): string {
  const files = readdirSync(root).filter(name => name.endsWith('.checkpoint.json'))
  assert.equal(files.length, 1, 'one Session should own exactly one durable generation')
  return path.join(root, files[0]!)
}

test('Issue#67: identical checkpoint content does not rewrite the durable generation', async () => {
  const durableRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i67-dedup-'))
  const runtime = createRlmRuntime(undefined, { snapshotRecovery: true, durableRoot, timeout: 12_000 })
  try {
    const first = await runtime.eval('issue67-dedup', { code: "stable = 'x' * 200000" })
    assert.equal(first.recovery?.checkpointCommitted, true)
    const target = durableTarget(durableRoot)
    const before = statSync(target, { bigint: true })
    const bytesBefore = readFileSync(target)

    // Force a distinct filesystem timestamp opportunity. The second cell does
    // not mutate globals, so the deterministic checkpoint payload is identical.
    await sleep(75)
    const second = await runtime.eval('issue67-dedup', { code: '1 + 1' })
    assert.equal(second.result, '2')
    assert.equal(second.recovery?.checkpointCommitted, true)

    const after = statSync(target, { bigint: true })
    assert.equal(after.mtimeNs, before.mtimeNs, 'content-addressed dedup must keep the committed generation untouched')
    assert.deepEqual(readFileSync(target), bytesBefore)
  } finally {
    await runtime.dispose()
    await removeTree(durableRoot)
  }
})

test('Issue#67: eval settles only after durable commit is immediately restorable', async () => {
  const durableRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i67-barrier-'))
  const writer = createRlmRuntime(undefined, { snapshotRecovery: true, durableRoot, timeout: 12_000 })
  try {
    const saved = await writer.eval('issue67-barrier', { code: 'keep = 41' })
    assert.equal(saved.recovery?.checkpointCommitted, true)
    assert.ok(readFileSync(durableTarget(durableRoot)).length > 0, 'durable generation must exist before eval resolves')
  } finally {
    await writer.dispose()
  }

  const reader = createRlmRuntime(undefined, { snapshotRecovery: true, durableRoot, timeout: 12_000 })
  try {
    const restored = await reader.eval('issue67-barrier', { code: 'keep + 1' })
    assert.equal(restored.result, '42')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await reader.dispose()
    await removeTree(durableRoot)
  }
})

test('Issue#67: hot checkpoint publication uses awaited async I/O and reuses chunk payloads', () => {
  // Issue #84 split: the assertions follow the owning implementation files.
  const session = readFileSync(new URL('../src/runtime/session.ts', import.meta.url), 'utf8')
  const kernel = readFileSync(new URL('../src/runtime/kernel.ts', import.meta.url), 'utf8')
  const source = session + kernel
  assert.match(source, /from 'node:fs\/promises'/)
  assert.match(source, /await this\.publishDurable\(/)
  assert.match(source, /takeCommittedCheckpointPayload\(\)/)
  const runEntry = session.slice(session.indexOf('private async runEntry'), source.indexOf('\n  dispose(): Promise<void>', source.indexOf('private async runEntry')))
  assert.doesNotMatch(runEntry, /readFileSync\(p\)/, 'runEntry must not synchronously reread a just-committed snapshot')
  const onResult = kernel.slice(kernel.indexOf('private onResult'), source.indexOf('\n  private onError', source.indexOf('private onResult')))
  assert.doesNotMatch(onResult, /writeFileSync|renameSync/, 'chunked checkpoint commit must not block the Host event loop')
})
