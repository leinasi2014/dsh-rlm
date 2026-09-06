import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pythonResolves } from '../src/settings.ts'

function withPathEnvironment<T>(directory: string, run: () => T): T {
  const oldPath = process.env.PATH
  const oldPathAlt = process.env.Path
  const oldPathExt = process.env.PATHEXT
  process.env.PATH = directory
  process.env.Path = directory
  process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM'
  try {
    return run()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPathAlt === undefined) delete process.env.Path
    else process.env.Path = oldPathAlt
    if (oldPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = oldPathExt
  }
}

test('Issue#70: pythonResolves rejects directories instead of treating existence as executable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-python-dir-'))
  const nested = path.join(dir, 'not-an-interpreter')
  mkdirSync(nested)
  try {
    assert.equal(pythonResolves(nested), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Issue#70 Windows: PATHEXT lookup accepts extensionless, explicit .exe and mixed-case suffix', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-python-win-'))
  writeFileSync(path.join(dir, 'demo.exe'), '')
  try {
    withPathEnvironment(dir, () => {
      assert.equal(pythonResolves('demo'), true)
      assert.equal(pythonResolves('demo.exe'), true)
      assert.equal(pythonResolves('demo.EXE'), true)
      assert.equal(pythonResolves('missing.exe'), false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Issue#70 POSIX: PATH lookup requires executable permission', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-python-posix-'))
  const candidate = path.join(dir, 'demo-python')
  writeFileSync(candidate, '#!/bin/sh\nexit 0\n')
  try {
    withPathEnvironment(dir, () => {
      chmodSync(candidate, 0o644)
      assert.equal(pythonResolves('demo-python'), false)
      chmodSync(candidate, 0o755)
      assert.equal(pythonResolves('demo-python'), true)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
