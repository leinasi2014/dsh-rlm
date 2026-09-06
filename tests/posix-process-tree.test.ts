import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime } from '../src/runtime.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${file}`)
}

async function waitForGone(pid: number, timeoutMs = 6_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (processGone(pid)) return true
    await sleep(50)
  }
  return processGone(pid)
}

test('POSIX Issue#72: disposing one kernel kills its descendant process group', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-posix-tree-'))
  const childPidFile = path.join(dir, 'child.pid')
  const runtime = createRlmRuntime(undefined, { timeout: 15_000 })
  try {
    const pending = runtime.eval('posix-tree', {
      code: [
        'import subprocess, sys, time',
        `p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])`,
        `open(${JSON.stringify(childPidFile)}, 'w', encoding='utf-8').write(str(p.pid))`,
        'time.sleep(30)',
      ].join('\n'),
    })
    await waitForFile(childPidFile)
    const childPid = Number(readFileSync(childPidFile, 'utf8'))
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0)

    const disposal = runtime.dispose()
    await assert.rejects(pending)
    await disposal

    assert.equal(await waitForGone(childPid), true, `descendant pid ${childPid} survived runtime disposal`)
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
