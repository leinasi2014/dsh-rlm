import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime, RlmError } from '../src/runtime.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function sandboxContext(workspace: string): any {
  return {
    get(name: string) {
      if (name === 'sandbox') {
        return {
          confine(argv: string[]) {
            return {
              argv: [...argv],
              enforcement: 'full',
              denialSignatures: [],
              runnerFailureRules: [],
            }
          },
        }
      }
      if (name === 'sandboxPolicy') {
        return {
          resolve() {
            return { mode: 'workspace-write', workspaceRoot: workspace }
          },
        }
      }
      return undefined
    },
  }
}

async function forceLoss(runtime: ReturnType<typeof createRlmRuntime>, key: string): Promise<void> {
  await assert.rejects(
    runtime.eval(key, { code: 'import os\nos._exit(13)' }),
    (error: unknown) => error instanceof RlmError && error.kind === 'closed',
  )
}

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

test('Issue#82: chunked checkpoint publication and restore preserve CJK bytes across chunk boundaries', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i82-cjk-'))
  const runtime = createRlmRuntime(sandboxContext(workspace), { snapshotRecovery: true, timeout: 8_000 })
  try {
    const saved = await runtime.eval('issue82-cjk', { code: 'x = chr(0x6c49) * 100000' })
    assert.equal(saved.recovery?.checkpointCommitted, true)
    await forceLoss(runtime, 'issue82-cjk')
    const restored = await runtime.eval('issue82-cjk', {
      code: '(len(x), x.count(chr(65533)), x == chr(0x6c49) * 100000)',
    })
    assert.equal(restored.result, '(100000, 0, True)')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await runtime.dispose()
    await removeTree(workspace)
  }
})

test('Issue#82: checkpoint chunks fit the JSONL wire budget even for heavily escaped values', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i82-escape-'))
  const runtime = createRlmRuntime(sandboxContext(workspace), { snapshotRecovery: true, timeout: 8_000 })
  try {
    const saved = await runtime.eval('issue82-escape', { code: 'x = chr(92) * 100000' })
    assert.equal(saved.recovery?.checkpointCommitted, true)
    await forceLoss(runtime, 'issue82-escape')
    const restored = await runtime.eval('issue82-escape', { code: 'x == chr(92) * 100000' })
    assert.equal(restored.result, 'True')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await runtime.dispose()
    await removeTree(workspace)
  }
})

test('Issue#82: host-to-kernel chunked restore preserves durable non-ASCII checkpoint bytes', async () => {
  const durableRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i82-durable-'))
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i82-restore-'))
  const config = { snapshotRecovery: true, durableRoot, timeout: 8_000 }
  const direct = createRlmRuntime(undefined, config)
  try {
    const saved = await direct.eval('issue82-host-restore', { code: 'x = chr(0x6c49) * 100000' })
    assert.equal(saved.recovery?.checkpointCommitted, true)
  } finally {
    await direct.dispose()
  }

  const chunked = createRlmRuntime(sandboxContext(workspace), config)
  try {
    const restored = await chunked.eval('issue82-host-restore', {
      code: '(len(x), x.count(chr(65533)), x == chr(0x6c49) * 100000)',
    })
    assert.equal(restored.result, '(100000, 0, True)')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await chunked.dispose()
    await removeTree(workspace)
    await removeTree(durableRoot)
  }
})

for (const [name, fragment] of [
  ['foreign id', '{"type":"checkpoint_chunk","id":999,"seq":0,"count":1,"encoding":"base64","data":"e30="}'],
  ['negative sequence', '{"type":"checkpoint_chunk","id":1,"seq":-1,"count":1,"encoding":"base64","data":"e30="}'],
  ['fractional sequence', '{"type":"checkpoint_chunk","id":1,"seq":0.5,"count":1,"encoding":"base64","data":"e30="}'],
  ['out-of-range sequence', '{"type":"checkpoint_chunk","id":1,"seq":1,"count":1,"encoding":"base64","data":"e30="}'],
  ['duplicate sequence', '{"type":"checkpoint_chunk","id":1,"seq":0,"count":1,"encoding":"base64","data":"e30="}'],
] as const) {
  test(`Issue#81: ${name} checkpoint chunks are fatal and preserve the prior committed snapshot`, async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i81-malformed-'))
    const runtime = createRlmRuntime(sandboxContext(workspace), { snapshotRecovery: true, timeout: 8_000 })
    try {
      const saved = await runtime.eval('issue81-malformed', { code: 'keep = 41' })
      assert.equal(saved.recovery?.checkpointCommitted, true)
      const code = [
        'keep = 99',
        `rlm_query.__self__._send(${fragment})`,
      ].join('\n')
      await assert.rejects(
        runtime.eval('issue81-malformed', { code }),
        (error: unknown) => error instanceof RlmError && error.kind === 'protocol',
      )
      const restored = await runtime.eval('issue81-malformed', { code: 'keep' })
      assert.equal(restored.result, '41')
      assert.equal(restored.recovery?.restored, true)
    } finally {
      await runtime.dispose()
      await removeTree(workspace)
    }
  })
}
