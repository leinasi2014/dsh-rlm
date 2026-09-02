import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OFFICIAL_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
const OFFICIAL_REMOTE = 'origin'
const OFFICIAL_BRANCH = 'master'
const GIT_TIMEOUT_MS = 45_000
const MAX_DIAGNOSTIC_CHARS = 2_000

function parseRepoArg(argv) {
  let repo
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name !== '--repo') throw new Error(`unsupported argument ${name ?? '(end)'}`)
    if (value === undefined) throw new Error('expected a value after --repo')
    if (repo !== undefined) throw new Error('--repo may be specified only once')
    repo = value
  }
  return repo
}

function nativePathIdentity(input, repo, platform) {
  const implementation = platform === 'win32' ? path.win32 : path.posix
  const resolved = implementation.isAbsolute(input)
    ? implementation.normalize(input)
    : implementation.resolve(repo, input)
  const withoutSuffix = resolved.replace(/\.git$/i, '')
  return platform === 'win32' ? withoutSuffix.toLowerCase() : withoutSuffix
}

export function repositoryIdentity(value, repo = process.cwd(), platform = process.platform) {
  const input = value.trim()
  const native = platform === 'win32' ? path.win32 : path.posix
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(input) || /^\\\\/.test(input)
  if (native.isAbsolute(input) || isWindowsPath) {
    return nativePathIdentity(input, repo, isWindowsPath ? 'win32' : platform)
  }

  const scp = /^([^@]+@)?([^:]+):(.+)$/.exec(input)
  if (scp && !input.includes('://')) {
    const host = scp[2].toLowerCase()
    const repository = scp[3].replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '')
    return `${host}/${host === 'github.com' ? repository.toLowerCase() : repository}`
  }

  try {
    const url = new URL(input)
    if (url.protocol === 'file:') {
      return nativePathIdentity(fileURLToPath(url), repo, platform)
    }
    const host = url.host.toLowerCase()
    const repository = url.pathname.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '')
    return `${host}/${url.hostname.toLowerCase() === 'github.com' ? repository.toLowerCase() : repository}`
  } catch {
    return nativePathIdentity(input, repo, platform)
  }
}

export function redactGitDiagnostic(value) {
  const redacted = value
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^@\s/'"]+@/gi, '$1')
    .replace(/\b([a-z][a-z\d+.-]*:\/\/[^\s?#'"]+)[?#][^\s'"]*/gi, '$1')
  return redacted.length <= MAX_DIAGNOSTIC_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_DIAGNOSTIC_CHARS)}…[diagnostic truncated]`
}

export function gitInvocation(repo, args, environment = process.env) {
  return {
    args: [
    '-C', repo,
    '-c', 'credential.helper=',
    '-c', 'credential.interactive=false',
    ...args,
    ],
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: process.execPath,
      SSH_ASKPASS: process.execPath,
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    },
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  }
}

function git(repo, args) {
  const invocation = gitInvocation(repo, args)
  const result = spawnSync('git', invocation.args, {
    encoding: 'utf8',
    env: invocation.env,
    timeout: invocation.timeout,
    windowsHide: invocation.windowsHide,
  })
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${GIT_TIMEOUT_MS}ms`
      : 'could not start'
    throw new Error(`git ${args[0]} failed: ${reason}`)
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status ?? 'unknown'})`)
  }
  return result.stdout.trim()
}

function defaultRepo() {
  if (process.env.RLM_DSH_REPO_ROOT) return path.resolve(process.env.RLM_DSH_REPO_ROOT)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

export function checkDshUpstream({
  repo,
  remote = OFFICIAL_REMOTE,
  branch = OFFICIAL_BRANCH,
  expectedRepository = OFFICIAL_REPOSITORY,
}) {
  const root = path.resolve(repo)
  const actualRepository = git(root, ['remote', 'get-url', remote])
  const actualIdentity = repositoryIdentity(actualRepository, root)
  const expectedIdentity = repositoryIdentity(expectedRepository, root)
  if (actualIdentity !== expectedIdentity) {
    throw new Error(`repository authority mismatch: ${remote} is ${actualIdentity}; expected ${expectedIdentity}`)
  }

  const trackedChanges = git(root, ['status', '--porcelain', '--untracked-files=no'])
  if (trackedChanges.length !== 0) {
    throw new Error('selected DSH checkout has tracked index/worktree changes; local SHA would not identify tested source')
  }

  git(root, ['fetch', '--no-tags', '--filter=blob:none', remote, `refs/heads/${branch}`])
  const local = git(root, ['rev-parse', 'HEAD'])
  const upstream = git(root, ['rev-parse', 'FETCH_HEAD'])
  const [aheadText, behindText] = git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/)
  const ahead = Number(aheadText)
  const behind = Number(behindText)
  const evidence = `authority=${actualIdentity} branch=${branch} local=${local} upstream=${upstream} ahead=${ahead} behind=${behind}`
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new Error(`could not parse ahead/behind relationship: ${evidence}`)
  }
  if (behind !== 0) throw new Error(`local DSH does not contain the latest authority tip: ${evidence}`)
  return evidence
}

function main() {
  const repoArg = parseRepoArg(process.argv.slice(2))
  const evidence = checkDshUpstream({ repo: path.resolve(repoArg ?? defaultRepo()) })
  process.stdout.write(`dsh-upstream: PASS ${evidence}\n`)
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-upstream: FAIL ${message}\n`)
    process.exitCode = 1
  }
}
