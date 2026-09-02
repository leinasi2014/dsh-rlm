import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectRoot = path.resolve(import.meta.dirname, '..')
const checker = path.join(projectRoot, 'scripts', 'check-dsh-upstream.mjs')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function fixture(t: test.TestContext): { remote: string; seed: string; work: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-upstream-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const work = path.join(root, 'work')

  git(root, 'init', '--bare', remote)
  git(root, 'init', '--initial-branch=master', seed)
  git(seed, 'config', 'user.email', 'gate@example.invalid')
  git(seed, 'config', 'user.name', 'Upstream Gate Test')
  writeFileSync(path.join(seed, 'contract.txt'), 'v1\n')
  git(seed, 'add', 'contract.txt')
  git(seed, 'commit', '-m', 'initial contract')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'master')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/master')
  git(root, 'clone', remote, work)
  git(work, 'config', 'user.email', 'gate@example.invalid')
  git(work, 'config', 'user.name', 'Upstream Gate Test')
  return { remote, seed, work }
}

function runChecker(repo: string, expectedRepository: string) {
  return spawnSync(process.execPath, [
    checker,
    '--repo', repo,
    '--remote', 'origin',
    '--branch', 'master',
    '--expected-repository', expectedRepository,
  ], { cwd: projectRoot, encoding: 'utf8' })
}

test('passes when the local DSH checkout contains the fetched authority tip', (t) => {
  const { remote, work } = fixture(t)
  const result = runChecker(work, remote)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dsh-upstream: PASS/)
  assert.match(result.stdout, /ahead=0 behind=0/)
})

test('fails closed when the local DSH checkout is behind the authority tip', (t) => {
  const { remote, seed, work } = fixture(t)
  writeFileSync(path.join(seed, 'contract.txt'), 'v2\n')
  git(seed, 'add', 'contract.txt')
  git(seed, 'commit', '-m', 'advance contract')
  git(seed, 'push', 'origin', 'master')

  const result = runChecker(work, remote)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dsh-upstream: FAIL/)
  assert.match(result.stderr, /ahead=0 behind=1/)
})

test('fails closed when local and authority histories diverge', (t) => {
  const { remote, seed, work } = fixture(t)
  writeFileSync(path.join(work, 'local.txt'), 'local\n')
  git(work, 'add', 'local.txt')
  git(work, 'commit', '-m', 'local work')
  writeFileSync(path.join(seed, 'remote.txt'), 'remote\n')
  git(seed, 'add', 'remote.txt')
  git(seed, 'commit', '-m', 'remote work')
  git(seed, 'push', 'origin', 'master')

  const result = runChecker(work, remote)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dsh-upstream: FAIL/)
  assert.match(result.stderr, /ahead=1 behind=1/)
})

test('rejects a remote that is not the configured repository authority', (t) => {
  const { work } = fixture(t)
  const result = runChecker(work, path.join(path.dirname(work), 'different.git'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /repository authority mismatch/)
})

test('never echoes remote URL credentials in authority failures', (t) => {
  const { work } = fixture(t)
  git(work, 'remote', 'set-url', 'origin', 'https://user:secret@example.invalid/private.git')
  const result = runChecker(work, 'https://example.invalid/expected.git')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /example\.invalid\/private/)
  assert.doesNotMatch(result.stderr, /user:secret/)
})
