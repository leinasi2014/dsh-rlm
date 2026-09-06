import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createRlmRuntime } from '../src/runtime.ts'

function dangerContext(workspaceRoot: string): { ctx: Context; confineCalls: () => number } {
  let calls = 0
  const sandbox = {
    confine() {
      calls += 1
      throw new Error('danger-full-access must bypass sandbox confinement')
    },
  }
  const sandboxPolicy = {
    resolve() {
      return { mode: 'danger-full-access' as const, workspaceRoot }
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return sandboxPolicy
      return undefined
    },
  } as unknown as Context
  return { ctx, confineCalls: () => calls }
}

test('Issue#87: danger-full-access bypasses confine but preserves the Session workspace cwd', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-danger-cwd-'))
  const marker = path.join(workspace, 'relative-marker.txt')
  const { ctx, confineCalls } = dangerContext(workspace)
  const runtime = createRlmRuntime(ctx, { kernelSandbox: 'auto', timeout: 8_000 })
  try {
    const cwd = await runtime.eval('danger-cwd', {
      session: { id: 'danger-cwd' },
      code: 'import os\nos.getcwd()',
    })
    assert.equal(path.resolve(cwd.result ?? ''), path.resolve(workspace))
    assert.equal(confineCalls(), 0, 'unrestricted policy must not invoke sandbox.confine')

    await runtime.eval('danger-cwd', {
      session: { id: 'danger-cwd' },
      code: 'open("relative-marker.txt", "w", encoding="utf-8").write("ok")',
    })
    assert.equal(existsSync(marker), true, 'relative Python writes must stay anchored to the Session workspace')
  } finally {
    await runtime.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})
