import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('Issue#61: chunked recovery restores managed context metadata emitted by the same kernel', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m5-context-meta-'))
  const contextPath = path.join(workspace, 'context.txt')
  const contextText = 'context-元数据-hello'
  const contextBytes = Buffer.byteLength(contextText, 'utf8')
  writeFileSync(contextPath, contextText, 'utf8')
  const runtime = createRlmRuntime(sandboxContext(workspace), {
    snapshotRecovery: true,
    timeout: 8_000,
    maxContextBytes: 1024 * 1024,
  })
  try {
    const saved = await runtime.eval('issue61-context-meta', {
      contextPath,
      code: 'keep = 41',
    })
    assert.equal(saved.recovery?.checkpointCommitted, true)

    await assert.rejects(
      runtime.eval('issue61-context-meta', { code: 'import os\nos._exit(13)' }),
      (error: unknown) => error instanceof RlmError && error.kind === 'closed',
    )

    const restored = await runtime.eval('issue61-context-meta', {
      code: '(keep + 1, context, context_meta["kind"], context_meta["bytes"])',
    })
    assert.equal(restored.result, `(42, '${contextText}', 'file', ${contextBytes})`)
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await runtime.dispose()
    await removeTree(workspace)
  }
})
