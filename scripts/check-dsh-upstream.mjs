import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OFFICIAL_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
const DEFAULT_BRANCH = 'master'
const GIT_TIMEOUT_MS = 45_000

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`expected --name value arguments; received ${name ?? '(end)'}`)
    }
    values.set(name.slice(2), value)
  }
  return values
}

function repositoryIdentity(value) {
  const input = value.trim()
  const scp = /^([^@]+@)?([^:]+):(.+)$/.exec(input)
  if (scp && !input.includes('://') && !/^[A-Za-z]:[\\/]/.test(input)) {
    return `${scp[2].toLowerCase()}/${scp[3].replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()}`
  }
  try {
    const url = new URL(input)
    if (url.protocol === 'file:') return path.normalize(fileURLToPath(url)).toLowerCase().replace(/\.git$/i, '')
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()}`
  } catch {
    return path.resolve(input).toLowerCase().replace(/\.git$/i, '')
  }
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? `timed out after ${GIT_TIMEOUT_MS}ms` : result.error.message
    throw new Error(`git ${args[0]} ${reason}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`git ${args[0]} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function defaultRepo() {
  if (process.env.RLM_DSH_REPO_ROOT) return path.resolve(process.env.RLM_DSH_REPO_ROOT)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = path.resolve(args.get('repo') ?? defaultRepo())
  const remote = args.get('remote') ?? process.env.DSH_UPSTREAM_REMOTE ?? 'origin'
  const branch = args.get('branch') ?? process.env.DSH_UPSTREAM_BRANCH ?? DEFAULT_BRANCH
  const expectedRepository = args.get('expected-repository')
    ?? process.env.DSH_UPSTREAM_REPOSITORY
    ?? OFFICIAL_REPOSITORY

  const actualRepository = git(repo, ['remote', 'get-url', remote])
  const actualIdentity = repositoryIdentity(actualRepository)
  const expectedIdentity = repositoryIdentity(expectedRepository)
  if (actualIdentity !== expectedIdentity) {
    throw new Error(`repository authority mismatch: ${remote} is ${actualIdentity}; expected ${expectedIdentity}`)
  }

  git(repo, ['fetch', '--no-tags', '--filter=blob:none', remote, `refs/heads/${branch}`])
  const local = git(repo, ['rev-parse', 'HEAD'])
  const upstream = git(repo, ['rev-parse', 'FETCH_HEAD'])
  const [aheadText, behindText] = git(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/)
  const ahead = Number(aheadText)
  const behind = Number(behindText)
  const evidence = `authority=${actualIdentity} branch=${branch} local=${local} upstream=${upstream} ahead=${ahead} behind=${behind}`
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new Error(`could not parse ahead/behind relationship: ${evidence}`)
  }
  if (behind !== 0) throw new Error(`local DSH does not contain the latest authority tip: ${evidence}`)
  process.stdout.write(`dsh-upstream: PASS ${evidence}\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-upstream: FAIL ${message}\n`)
  process.exitCode = 1
}
