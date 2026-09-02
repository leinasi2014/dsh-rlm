import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  addedRecordText,
  isAppendOnlyRecordText,
  materialPathReferenced,
  parseRecords,
  rangeAppendOnlyErrors,
  removedRecordLines,
  validateEntry,
  validateRecordSet,
} from '../scripts/check-development-memory.mjs'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function historyFixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'development-memory-range-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.email', 'memory@example.invalid')
  git(root, 'config', 'user.name', 'Memory Gate Test')
  writeFileSync(path.join(root, 'README.md'), 'fixture\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  const directory = path.join(root, 'docs', 'development-memory', 'records', '2026')
  mkdirSync(directory, { recursive: true })
  const shard = path.join(directory, 'issue-1.jsonl')
  writeFileSync(shard, 'record-one\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'create shard')
  return { root, base, directory, shard }
}

const validEntry = {
  schemaVersion: 1,
  recordId: 'mem-20260902-example-agent',
  recordedAt: '2026-09-02T07:54:32+08:00',
  agent: {
    name: 'Example Agent',
    id: 'example-agent',
    model: 'Example Model',
    role: 'implementer',
    reasoning: 'high',
  },
  issue: 1,
  workItem: 'issue-0001',
  baseCommit: 'a'.repeat(40),
  candidateRef: 'same-commit',
  summary: 'Implemented a bounded example.',
  files: [{ path: 'src/example.ts', pointers: ['runExample'] }],
  steps: ['Added the bounded implementation.'],
  evidence: [{ kind: 'test', target: 'pnpm test', result: 'PASS', note: 'All tests passed.' }],
  limitations: [],
}

test('accepts a complete agent-owned development-memory record', () => {
  assert.deepEqual(validateEntry(validEntry), [])
})

test('rejects missing agent identity and repository path escape', () => {
  const invalid = structuredClone(validEntry)
  invalid.agent.name = ''
  invalid.files[0].path = '../outside.ts'
  const errors = validateEntry(invalid)
  assert.ok(errors.some((error) => error.includes('agent.name')))
  assert.ok(errors.some((error) => error.includes('repository-relative path')))
})

test('rejects duplicate record IDs across workstream shards', () => {
  const records = [
    { source: 'issue-1.jsonl', entries: [validEntry] },
    { source: 'issue-2.jsonl', entries: [structuredClone(validEntry)] },
  ]
  assert.ok(validateRecordSet(records).some((error) => error.includes('duplicate recordId')))
})

test('detects changed or removed historical JSONL lines', () => {
  const diff = '--- a/record.jsonl\n+++ b/record.jsonl\n-old record\n+new record\n'
  assert.deepEqual(removedRecordLines(diff), ['-old record'])
})

test('accepts an append after an unterminated final record without treating it as rewritten', () => {
  const prior = JSON.stringify(validEntry)
  const appended = JSON.stringify({ ...validEntry, recordId: 'mem-20260902-next-agent' })
  const diff = [
    '--- a/record.jsonl',
    '+++ b/record.jsonl',
    `-${prior}`,
    '\\ No newline at end of file',
    `+${prior}`,
    `+${appended}`,
    '\\ No newline at end of file',
    '',
  ].join('\n')

  assert.deepEqual(removedRecordLines(diff), [])
  assert.equal(addedRecordText(diff), appended)
})

test('rejects inserting a new record before existing development-memory history', () => {
  const prior = `${JSON.stringify(validEntry)}\n`
  const inserted = JSON.stringify({ ...validEntry, recordId: 'mem-20260903-inserted-agent' })

  assert.equal(isAppendOnlyRecordText(prior, `${inserted}\n${prior}`), false)
})

test('accepts only a true append to existing development-memory history', () => {
  const prior = JSON.stringify(validEntry)
  const appended = JSON.stringify({ ...validEntry, recordId: 'mem-20260903-appended-agent' })

  assert.equal(isAppendOnlyRecordText(prior, `${prior}\n${appended}\n`), true)
  assert.equal(isAppendOnlyRecordText(`${prior}\n`, `${prior}\n${appended}\n`), true)
})

test('range gate rejects an intermediate commit that inserts before existing history', (t) => {
  const { root, base, shard } = historyFixture(t)
  writeFileSync(shard, 'record-two\nrecord-one\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'insert before history')

  assert.ok(rangeAppendOnlyErrors(`${base}..HEAD`, 'fixture range', root)
    .some((error) => error.includes('exact prefix')))
})

test('range gate rejects renaming a development-memory shard', (t) => {
  const { root, base, directory, shard } = historyFixture(t)
  git(root, 'mv', shard, path.join(directory, 'issue-1-part-02.jsonl'))
  git(root, 'commit', '-m', 'rename shard')

  assert.ok(rangeAppendOnlyErrors(`${base}..HEAD`, 'fixture range', root)
    .some((error) => error.includes('exact prefix')))
})

test('still rejects changing an unterminated final record', () => {
  const diffs = [
    '-old record\n\\ No newline at end of file\n+changed record\n+new record',
    '-old record\n\\ No newline at end of file',
    '-first record\n-second record\n\\ No newline at end of file\n+second record\n+first record',
  ]
  for (const diff of diffs) assert.ok(removedRecordLines(diff).length > 0)
})

test('keeps a truly duplicated record visible after terminal-newline normalization', () => {
  const record = JSON.stringify(validEntry)
  const diff = [
    `-${record}`,
    '\\ No newline at end of file',
    `+${record}`,
    `+${record}`,
  ].join('\n')
  const added = JSON.parse(addedRecordText(diff))

  assert.ok(validateRecordSet([
    { source: 'record.jsonl', entries: [validEntry, added] },
  ]).some((error) => error.includes('duplicate recordId')))
})

test('requires at least one changed material path to be referenced', () => {
  assert.equal(materialPathReferenced(['src/example.ts'], [validEntry]), true)
  assert.equal(materialPathReferenced(['tests/example.test.ts'], [validEntry]), false)
  assert.equal(materialPathReferenced(['README.md'], []), true)
})

test('parses one compact JSON object per line', () => {
  const result = parseRecords(`${JSON.stringify(validEntry)}\n`, 'fixture.jsonl')
  assert.equal(result.entries.length, 1)
  assert.deepEqual(result.errors, [])
})
