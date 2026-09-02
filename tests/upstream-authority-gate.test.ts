import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkDshUpstream,
  redactGitDiagnostic,
  repositoryIdentity,
} from '../scripts/check-dsh-upstream.mjs'

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
  try {
    const evidence = checkDshUpstream({
      repo,
      remote: 'origin',
      branch: 'master',
      expectedRepository,
    })
    return { status: 0, stdout: `dsh-upstream: PASS ${evidence}\n`, stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 1, stdout: '', stderr: `dsh-upstream: FAIL ${message}\n` }
  }
}

test('passes when the local DSH checkout contains the fetched authority tip', (t) => {
  const { remote, work } = fixture(t)
  const result = runChecker(work, remote)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dsh-upstream: PASS/)
  assert.match(result.stdout, /ahead=0 behind=0/)
})

test('passes when a clean local checkout is ahead of and contains the authority tip', (t) => {
  const { remote, work } = fixture(t)
  writeFileSync(path.join(work, 'local.txt'), 'local\n')
  git(work, 'add', 'local.txt')
  git(work, 'commit', '-m', 'local compatible work')
  const result = runChecker(work, remote)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ahead=1 behind=0/)
})

test('fails closed when tracked DSH content differs from the recorded local SHA', (t) => {
  const { remote, work } = fixture(t)
  writeFileSync(path.join(work, 'contract.txt'), 'dirty\n')
  const result = runChecker(work, remote)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /tracked index\/worktree changes/)
  assert.doesNotMatch(result.stderr, /contract\.txt/)
})

test('ignores untracked DSH files because they do not alter tracked source at HEAD', (t) => {
  const { remote, work } = fixture(t)
  writeFileSync(path.join(work, 'untracked.txt'), 'local material\n')
  const result = runChecker(work, remote)
  assert.equal(result.status, 0, result.stderr)
})

test('resolves a relative remote URL against the inspected DSH checkout', (t) => {
  const { remote, work } = fixture(t)
  git(work, 'remote', 'set-url', 'origin', path.relative(work, remote))
  const result = runChecker(work, remote)
  assert.equal(result.status, 0, result.stderr)
})

test('preserves case for native repository paths on case-sensitive platforms', () => {
  const upper = repositoryIdentity('/tmp/DSH.git', '/tmp/work', 'linux')
  const lower = repositoryIdentity('/tmp/dsh.git', '/tmp/work', 'linux')
  assert.notEqual(upper, lower)
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

test('the production CLI cannot redefine the official authority from environment', (t) => {
  const { remote, work } = fixture(t)
  const result = spawnSync(process.execPath, [checker, '--repo', work], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_UPSTREAM_REMOTE: 'origin',
      DSH_UPSTREAM_BRANCH: 'master',
      DSH_UPSTREAM_REPOSITORY: remote,
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /repository authority mismatch/)
})

test('never echoes credentials when an identity-matching fetch fails', (t) => {
  const { work } = fixture(t)
  git(work, 'remote', 'set-url', 'origin', 'https://user:secret@127.0.0.1:1/private.git')
  const result = runChecker(work, 'https://127.0.0.1:1/private.git')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git fetch failed/)
  assert.doesNotMatch(result.stderr, /user:secret/)
})

test('never echoes query tokens or fragments from a failed Git transport', (t) => {
  const { work } = fixture(t)
  const remote = 'https://127.0.0.1:1/private.git?access_token=query-secret#fragment-secret'
  git(work, 'remote', 'set-url', 'origin', remote)
  const result = runChecker(work, remote)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git fetch failed/)
  assert.doesNotMatch(result.stderr, /access_token|query-secret|fragment-secret/)
})

test('overrides ambient Git and SSH askpass helpers with non-interactive sentinels', (t) => {
  const { work } = fixture(t)
  const root = path.dirname(work)
  const invoked = path.join(root, 'askpass-invoked.txt')
  const helper = process.platform === 'win32'
    ? path.join(root, 'askpass.cmd')
    : path.join(root, 'askpass.sh')
  if (process.platform === 'win32') {
    writeFileSync(helper, `@echo off\r\n>"${invoked}" echo invoked\r\n`)
  } else {
    writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${invoked}'\n`)
    chmodSync(helper, 0o755)
  }
  const remote = 'ssh://git@127.0.0.1:1/private.git'
  git(work, 'remote', 'set-url', 'origin', remote)
  const previousGitAskpass = process.env.GIT_ASKPASS
  const previousSshAskpass = process.env.SSH_ASKPASS
  process.env.GIT_ASKPASS = helper
  process.env.SSH_ASKPASS = helper
  try {
    const result = runChecker(work, remote)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /git fetch failed/)
    assert.equal(existsSync(invoked), false)
  } finally {
    if (previousGitAskpass === undefined) delete process.env.GIT_ASKPASS
    else process.env.GIT_ASKPASS = previousGitAskpass
    if (previousSshAskpass === undefined) delete process.env.SSH_ASKPASS
    else process.env.SSH_ASKPASS = previousSshAskpass
  }
})

test('sanitizes URL userinfo from raw Git diagnostics', () => {
  const diagnostic = 'fatal: unable to access https://user:secret@example.invalid/private.git'
  assert.equal(
    redactGitDiagnostic(diagnostic),
    'fatal: unable to access https://example.invalid/private.git',
  )
})

test('sanitizes URL query and fragment secrets from raw diagnostics', () => {
  const diagnostic = 'fatal: https://example.invalid/private.git?access_token=secret#fragment-secret'
  assert.equal(redactGitDiagnostic(diagnostic), 'fatal: https://example.invalid/private.git')
})

test('the production CLI rejects authority override arguments', (t) => {
  const { remote, work } = fixture(t)
  const result = spawnSync(process.execPath, [
    checker,
    '--repo', work,
    '--expected-repository', remote,
  ], { cwd: projectRoot, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unsupported argument --expected-repository/)
})
