import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime, RlmError } from '../src/runtime.ts'

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

function regularFiles(root: string): string[] {
  const output: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(item)
      else if (entry.isFile()) output.push(item)
    }
  }
  walk(root)
  return output
}

function directoriesBelow(root: string): string[] {
  const output: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const item = path.join(directory, entry.name)
      output.push(item)
      walk(item)
    }
  }
  walk(root)
  return output
}

async function seedDurable(root: string, key: string): Promise<void> {
  const runtime = createRlmRuntime(undefined, {
    snapshotRecovery: true,
    durableRoot: root,
    timeout: 8_000,
  })
  try {
    const saved = await runtime.eval(key, { code: 'valuable = 41' })
    assert.equal(saved.recovery?.checkpointCommitted, true)
  } finally {
    await runtime.dispose()
  }
}

function markerCode(marker: string): string {
  return `open(${JSON.stringify(marker)}, "w").write("ran")\nreplacement = 2`
}

test('Issue#71: corrupt existing durable state is a typed snapshot failure before user code can overwrite it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i71-corrupt-'))
  const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i71-marker-'))
  const marker = path.join(markerRoot, 'executed.txt')
  try {
    await seedDurable(root, 'issue71-corrupt')
    const files = regularFiles(root)
    assert.ok(files.length >= 1, 'expected at least one committed durable file')
    const target = [...files].sort((a, b) => statSync(b).size - statSync(a).size)[0]
    writeFileSync(target, 'corrupt-durable-state', 'utf8')
    const corrupted = readFileSync(target)

    const runtime = createRlmRuntime(undefined, {
      snapshotRecovery: true,
      durableRoot: root,
      timeout: 8_000,
    })
    try {
      await assert.rejects(
        runtime.eval('issue71-corrupt', { code: markerCode(marker) }),
        (error: unknown) => error instanceof RlmError && error.kind === 'snapshot',
      )
      assert.equal(existsSync(marker), false, 'fresh user code must not run after durable corruption')
      assert.deepEqual(readFileSync(target), corrupted, 'invalid durable bytes must not be overwritten')
    } finally {
      await runtime.dispose()
    }
  } finally {
    await removeTree(root)
    await removeTree(markerRoot)
  }
})

test('Issue#71: unsupported durable schema version fails closed before a fresh namespace is used', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i71-version-'))
  const markerRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i71-version-marker-'))
  const marker = path.join(markerRoot, 'executed.txt')
  try {
    await seedDurable(root, 'issue71-version')
    const versionFile = regularFiles(root).find((file) => readFileSync(file, 'utf8').includes('"schemaVersion"'))
    assert.ok(versionFile, 'expected durable metadata/envelope containing schemaVersion')
    const original = readFileSync(versionFile!, 'utf8')
    const changed = original.replace(/"schemaVersion"\s*:\s*\d+/, '"schemaVersion":999')
    assert.notEqual(changed, original, 'fixture must change the durable schema version')
    writeFileSync(versionFile!, changed, 'utf8')
    const incompatible = readFileSync(versionFile!)

    const runtime = createRlmRuntime(undefined, {
      snapshotRecovery: true,
      durableRoot: root,
      timeout: 8_000,
    })
    try {
      await assert.rejects(
        runtime.eval('issue71-version', { code: markerCode(marker) }),
        (error: unknown) => error instanceof RlmError && error.kind === 'snapshot',
      )
      assert.equal(existsSync(marker), false, 'user code must not execute on an unsupported durable schema')
      assert.deepEqual(readFileSync(versionFile!), incompatible, 'unsupported durable state must remain intact')
    } finally {
      await runtime.dispose()
    }
  } finally {
    await removeTree(root)
    await removeTree(markerRoot)
  }
})

test('Issue#83 POSIX: durable files remain private under a permissive umask', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i83-mode-'))
  const priorUmask = process.umask(0)
  try {
    await seedDurable(root, 'issue83-mode')
  } finally {
    process.umask(priorUmask)
  }
  try {
    const files = regularFiles(root)
    assert.ok(files.length >= 1, 'expected durable files')
    for (const file of files) {
      assert.equal(statSync(file).mode & 0o777, 0o600, `${path.basename(file)} must be mode 0600`)
    }
    for (const directory of directoriesBelow(root)) {
      assert.equal(statSync(directory).mode & 0o777, 0o700, `${path.basename(directory)} must be mode 0700`)
    }
  } finally {
    await removeTree(root)
  }
})

test('Issue#83 POSIX: a pre-planted legacy temp symlink cannot redirect durable checkpoint bytes outside the root', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i83-symlink-'))
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-i83-outside-'))
  const outside = path.join(outsideRoot, 'outside.txt')
  const sentinel = Buffer.from('outside-must-remain-unchanged', 'utf8')
  writeFileSync(outside, sentinel)
  const sessionKey = 'issue83-symlink'
  const legacyBase = createHash('sha256').update(sessionKey).digest('hex') + '.checkpoint.json'
  const plantedTemp = path.join(root, legacyBase + '.tmp-' + String(process.pid))
  const runtime = createRlmRuntime(undefined, {
    snapshotRecovery: true,
    durableRoot: root,
    timeout: 8_000,
  })
  try {
    symlinkSync(outside, plantedTemp, 'file')
    let failure: unknown
    try {
      await runtime.eval(sessionKey, { code: 'valuable = 41' })
    } catch (error) {
      failure = error
    }
    assert.deepEqual(readFileSync(outside), sentinel, 'durable publication must never follow the planted temp symlink')
    if (failure !== undefined) {
      assert.ok(failure instanceof RlmError && failure.kind === 'snapshot', 'unsafe durable state should fail as a typed snapshot error')
    }
  } finally {
    await runtime.dispose()
    // lstat proves cleanup never needs to follow a surviving symlink.
    if (existsSync(plantedTemp)) assert.ok(lstatSync(plantedTemp).isSymbolicLink())
    await removeTree(root)
    await removeTree(outsideRoot)
  }
})
