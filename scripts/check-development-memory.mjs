import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECORDS_ROOT = 'docs/development-memory/records'
export const MAX_LINE_BYTES = 64 * 1024
export const MAX_SHARD_BYTES = 2 * 1024 * 1024
export const MAX_SHARD_RECORDS = 1000
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = new Set(['PASS', 'FAIL', 'FLAKY', 'NOT_RUN', 'NOT_CONFIGURED'])
const REASONING = new Set(['low', 'medium', 'high', 'max', 'system-managed'])
const MATERIAL_PREFIXES = [
  'src/', 'python-runtime/', 'tests/', 'scripts/', '.githooks/',
  '.github/workflows/',
]
const MATERIAL_FILES = new Set(['AGENTS.md', 'package.json', 'pnpm-lock.yaml'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    typeof item === 'string' && item.trim().length > 0)
}

export function normalizeRepositoryPath(value) {
  return value.replaceAll('\\', '/')
}

export function isMaterialPath(value) {
  const file = normalizeRepositoryPath(value)
  return MATERIAL_FILES.has(file) || MATERIAL_PREFIXES.some((prefix) => file.startsWith(prefix))
}

export function validateEntry(entry, label = 'entry') {
  const errors = []
  const requireString = (value, field) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${label}.${field} must be a non-empty string`)
    }
  }

  if (!isObject(entry)) return [`${label} must be a JSON object`]
  if (entry.schemaVersion !== 1) errors.push(`${label}.schemaVersion must equal 1`)
  requireString(entry.recordId, 'recordId')
  requireString(entry.recordedAt, 'recordedAt')
  if (typeof entry.recordedAt === 'string' && Number.isNaN(Date.parse(entry.recordedAt))) {
    errors.push(`${label}.recordedAt must be an ISO-8601 timestamp`)
  }
  requireString(entry.workItem, 'workItem')
  requireString(entry.summary, 'summary')
  if (entry.issue !== null && (!Number.isInteger(entry.issue) || entry.issue < 1)) {
    errors.push(`${label}.issue must be null or a positive integer`)
  }
  if (typeof entry.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(entry.baseCommit)) {
    errors.push(`${label}.baseCommit must be a full lowercase commit SHA`)
  }
  if (entry.candidateRef !== 'same-commit' &&
      (typeof entry.candidateRef !== 'string' || !/^[0-9a-f]{40}$/.test(entry.candidateRef))) {
    errors.push(`${label}.candidateRef must be same-commit or a full lowercase commit SHA`)
  }
  if (entry.correctsRecordId !== undefined) requireString(entry.correctsRecordId, 'correctsRecordId')

  if (!isObject(entry.agent)) {
    errors.push(`${label}.agent must be an object`)
  } else {
    for (const field of ['name', 'id', 'model', 'role']) requireString(entry.agent[field], `agent.${field}`)
    if (!REASONING.has(entry.agent.reasoning)) {
      errors.push(`${label}.agent.reasoning must be one of ${[...REASONING].join(', ')}`)
    }
  }

  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    errors.push(`${label}.files must contain at least one file record`)
  } else {
    for (const [index, file] of entry.files.entries()) {
      const fileLabel = `${label}.files[${index}]`
      if (!isObject(file)) {
        errors.push(`${fileLabel} must be an object`)
        continue
      }
      requireString(file.path, `files[${index}].path`)
      if (typeof file.path === 'string') {
        const normalized = normalizeRepositoryPath(file.path)
        const segments = normalized.split('/')
        if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(file.path) ||
            segments.includes('..') || normalized.startsWith('./')) {
          errors.push(`${fileLabel}.path must be a normalized repository-relative path`)
        }
      }
      if (!strings(file.pointers)) {
        errors.push(`${fileLabel}.pointers must contain semantic anchors or deleted`)
      }
    }
  }

  if (!strings(entry.steps)) errors.push(`${label}.steps must contain implementation/review steps`)
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    errors.push(`${label}.evidence must contain at least one test, review, or live-check record`)
  } else {
    for (const [index, evidence] of entry.evidence.entries()) {
      const evidenceLabel = `${label}.evidence[${index}]`
      if (!isObject(evidence)) {
        errors.push(`${evidenceLabel} must be an object`)
        continue
      }
      if (!['test', 'review', 'live'].includes(evidence.kind)) {
        errors.push(`${evidenceLabel}.kind must be test, review, or live`)
      }
      requireString(evidence.target, `evidence[${index}].target`)
      if (!RESULTS.has(evidence.result)) {
        errors.push(`${evidenceLabel}.result must be one of ${[...RESULTS].join(', ')}`)
      }
      requireString(evidence.note, `evidence[${index}].note`)
    }
  }
  if (!Array.isArray(entry.limitations) || !entry.limitations.every((item) =>
    typeof item === 'string' && item.trim().length > 0)) {
    errors.push(`${label}.limitations must be an array of non-empty strings`)
  }
  return errors
}

export function parseRecords(text, source) {
  const entries = []
  const errors = []
  let count = 0
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    count += 1
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      errors.push(`${source}:${index + 1} exceeds ${MAX_LINE_BYTES} UTF-8 bytes`)
      continue
    }
    try {
      const entry = JSON.parse(line)
      entries.push(entry)
      errors.push(...validateEntry(entry, `${source}:${index + 1}`))
    } catch (error) {
      errors.push(`${source}:${index + 1} is not valid JSON: ${error.message}`)
    }
  }
  if (count > MAX_SHARD_RECORDS) {
    errors.push(`${source} has ${count} records; start the next part after ${MAX_SHARD_RECORDS}`)
  }
  return { entries, errors }
}

export function validateRecordSet(records) {
  const errors = []
  const seen = new Map()
  for (const { source, entries } of records) {
    for (const entry of entries) {
      if (typeof entry.recordId !== 'string') continue
      if (seen.has(entry.recordId)) {
        errors.push(`duplicate recordId ${entry.recordId} in ${seen.get(entry.recordId)} and ${source}`)
      } else {
        seen.set(entry.recordId, source)
      }
    }
  }
  return errors
}

export function materialPathReferenced(changedPaths, entries) {
  const changed = new Set(changedPaths.filter(isMaterialPath).map(normalizeRepositoryPath))
  if (changed.size === 0) return true
  return entries.some((entry) => Array.isArray(entry.files) && entry.files.some((file) =>
    changed.has(normalizeRepositoryPath(file.path ?? ''))))
}

export function analyzeRecordDiff(diff) {
  const lines = diff.split(/\r?\n/)
  const removed = []
  const syntheticReadds = new Set()
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('-') || line.startsWith('---')) continue
    const nextRecord = lines[index + 3]
    const terminalNewlineAppend = lines[index + 1] === '\\ No newline at end of file' &&
      lines[index + 2] === `+${line.slice(1)}` &&
      nextRecord?.startsWith('+') && !nextRecord.startsWith('+++') &&
      nextRecord.slice(1).trim().length > 0
    if (terminalNewlineAppend) syntheticReadds.add(index + 2)
    else removed.push(line)
  }
  const added = lines.filter((line, index) =>
    line.startsWith('+') && !line.startsWith('+++') && !syntheticReadds.has(index))
  return { added, removed }
}

export function removedRecordLines(diff) {
  return analyzeRecordDiff(diff).removed
}

export function isAppendOnlyRecordText(before, after) {
  if (before === null) return after !== null
  if (after === null || after === before) return after === before
  const prefix = before.endsWith('\n') ? before : `${before}\n`
  return after.startsWith(prefix)
}

function recordFiles(directory) {
  const files = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name)
    if (item.isDirectory()) files.push(...recordFiles(itemPath))
    else if (item.isFile() && item.name.endsWith('.jsonl')) files.push(itemPath)
  }
  return files.sort()
}

function loadAllRecords() {
  const records = []
  const errors = []
  const directory = path.join(ROOT, RECORDS_ROOT)
  for (const file of recordFiles(directory)) {
    const source = normalizeRepositoryPath(path.relative(ROOT, file))
    const size = statSync(file).size
    if (size > MAX_SHARD_BYTES) {
      errors.push(`${source} exceeds ${MAX_SHARD_BYTES} bytes; start the next part`)
    }
    const parsed = parseRecords(readFileSync(file, 'utf8'), source)
    records.push({ source, entries: parsed.entries })
    errors.push(...parsed.errors)
  }
  errors.push(...validateRecordSet(records))
  return { records, entries: records.flatMap((record) => record.entries), errors }
}

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function changedPaths(args, root = ROOT) {
  return git(args, root).split('\0').filter(Boolean).map(normalizeRepositoryPath)
}

function recordDiff(args) {
  return git([...args, '--', RECORDS_ROOT])
}

function gitFile(ref, file, root = ROOT) {
  const revision = ref === ':' ? `:${file}` : `${ref}:${file}`
  const result = spawnSync('git', ['show', revision], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result.status === 0 ? result.stdout : null
}

function appendOnlyRecordErrors(paths, beforeRef, afterRef, label, root = ROOT) {
  const errors = []
  const records = new Set(paths.filter((file) =>
    file.startsWith(`${RECORDS_ROOT}/`) && file.endsWith('.jsonl')))
  for (const file of records) {
    if (!isAppendOnlyRecordText(gitFile(beforeRef, file, root), gitFile(afterRef, file, root))) {
      errors.push(`${label}: ${file} must preserve its prior content as an exact prefix and append new records only at EOF`)
    }
  }
  return errors
}

function revisionEndpoints(range) {
  const separator = range.indexOf('..')
  if (separator < 1 || range[separator + 2] === '.' || range.slice(separator + 2).length === 0) {
    throw new Error(`range ${range} must use base..head syntax`)
  }
  return [range.slice(0, separator), range.slice(separator + 2)]
}

export function rangeAppendOnlyErrors(range, label, root = ROOT) {
  revisionEndpoints(range)
  const commits = git(['rev-list', '--reverse', '--topo-order', range], root)
    .split(/\r?\n/)
    .filter(Boolean)
  const errors = []
  for (const commit of commits) {
    const [, parent = EMPTY_TREE] = git(['rev-list', '--parents', '-n', '1', commit], root)
      .trim()
      .split(/\s+/)
    const paths = changedPaths([
      'diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACMRD', parent, commit,
    ], root)
    errors.push(...appendOnlyRecordErrors(paths, parent, commit, `${label} commit ${commit}`, root))
  }
  return errors
}

export function addedRecordText(diff) {
  return analyzeRecordDiff(diff).added
    .map((line) => line.slice(1))
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

function issueFromBranch() {
  const branch = process.env.GITHUB_HEAD_REF || git(['branch', '--show-current']).trim()
  const match = /^codex\/issue-(\d+)-/.exec(branch)
  return match ? Number(match[1]) : null
}

function checkChangeSet(paths, diff, label, appendErrors = []) {
  const errors = [...appendErrors]
  const removed = removedRecordLines(diff)
  if (removed.length > 0) {
    errors.push(`${label}: development-memory records are append-only; ${removed.length} existing line(s) changed or were removed`)
  }

  const material = paths.filter(isMaterialPath)
  const added = parseRecords(addedRecordText(diff), `${label}:added-record`)
  errors.push(...added.errors)
  if (material.length > 0 && added.entries.length === 0) {
    errors.push(`${label}: material code/test/governance changes require a new agent record`)
  }
  if (!materialPathReferenced(material, added.entries)) {
    errors.push(`${label}: a new agent record must reference at least one changed material path`)
  }
  const branchIssue = issueFromBranch()
  if (branchIssue !== null && material.length > 0 &&
      !added.entries.some((entry) => entry.issue === branchIssue)) {
    errors.push(`${label}: branch issue #${branchIssue} needs a matching agent record`)
  }
  return errors
}

function defaultRange() {
  const before = process.env.MEMORY_BASE
  const head = process.env.MEMORY_HEAD || 'HEAD'
  if (before && !/^0+$/.test(before)) return `${before}..${head}`
  try {
    git(['rev-parse', 'HEAD^'])
    return `HEAD^..${head}`
  } catch {
    return `4b825dc642cb6eb9a060e54bf8d69288fbee4904..${head}`
  }
}

function main() {
  const full = loadAllRecords()
  const errors = [...full.errors]
  const [mode = '--all', value] = process.argv.slice(2)

  if (mode === '--staged') {
    const paths = changedPaths(['diff', '--cached', '--no-renames', '--name-only', '-z', '--diff-filter=ACMRD'])
    const diff = recordDiff(['diff', '--cached', '--no-renames', '--unified=0'])
    const appendErrors = appendOnlyRecordErrors(paths, 'HEAD', ':', 'staged change')
    errors.push(...checkChangeSet(paths, diff, 'staged change', appendErrors))
  } else if (mode === '--range') {
    const range = value || defaultRange()
    const paths = changedPaths(['diff', '--no-renames', range, '--name-only', '-z', '--diff-filter=ACMRD'])
    const diff = recordDiff(['diff', '--no-renames', '--unified=0', range])
    const appendErrors = rangeAppendOnlyErrors(range, `range ${range}`)
    errors.push(...checkChangeSet(paths, diff, `range ${range}`, appendErrors))
  } else if (mode !== '--all') {
    errors.push(`unknown mode ${mode}; use --all, --staged, or --range [base..head]`)
  }

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`development-memory: ${error}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`development-memory: PASS (${full.entries.length} record(s))\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
