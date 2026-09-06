import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime } from '../src/runtime.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

test('Issue#90: a detached asyncio task cannot mutate globals after its cell returns', async () => {
  const runtime = createRlmRuntime(undefined, { timeout: 5_000 })
  try {
    const first = await runtime.eval('issue90-global', {
      code: [
        'import asyncio',
        'shared = "terminal"',
        'async def late():',
        '    await asyncio.sleep(0.05)',
        '    globals()["shared"] = "late-mutation"',
        'asyncio.create_task(late())',
        'shared',
      ].join('\n'),
    })
    assert.equal(first.result, 'terminal')

    const second = await runtime.eval('issue90-global', {
      code: 'await asyncio.sleep(0.15)\nshared',
    })
    assert.equal(second.result, 'terminal')
  } finally {
    await runtime.dispose()
  }
})

test('Issue#90: a detached asyncio task cannot perform a late file side effect after cell retirement', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i90-file-'))
  const marker = path.join(root, 'late.txt')
  const runtime = createRlmRuntime(undefined, { timeout: 5_000 })
  try {
    const first = await runtime.eval('issue90-file', {
      code: [
        'import asyncio',
        `marker = ${JSON.stringify(marker)}`,
        'async def late_write():',
        '    await asyncio.sleep(0.05)',
        '    open(marker, "w", encoding="utf-8").write("late")',
        'asyncio.create_task(late_write())',
        '"returned"',
      ].join('\n'),
    })
    assert.equal(first.result, 'returned')

    await runtime.eval('issue90-file', { code: 'await asyncio.sleep(0.15)\n"next-cell"' })
    assert.equal(existsSync(marker), false)
  } finally {
    await runtime.dispose()
    await removeTree(root)
  }
})
