import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

// M1E profile-smoke. Two gated tests (skip unless RLM_LIVE_SMOKE='1'):
//   1. The full M1E architecture loop through a REAL, fresh, isolated DSH
//      Profile that installs this package (real dsh plugin command), enables
//      it with provider 'spawn', selects the configured vLLM
//      DeepSeek-V4-Flash-Vision-Exp, drives a one-shot headless task, and
//      inspects the official Session log for: rlm_eval tool call + bounded
//      result carrying the local UTF-8 Chinese fixture; an rlm_query subagent
//      whose final text returns and lets the Python cell continue; a second
//      rlm_eval reusing the first cell's globals; and a child agent whose tool
//      set has no rlm_eval (no recursion).
//   2. Runtime dispose releases the Python kernel process (unload frees it).
//
// These are LIVE integration smoke tests: they boot the real profile and make
// real model requests against the configured vLLM endpoint. They are gated so
// the default unit run stays offline.

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The dsh-rlm package lives at packages/.external/dsh-rlm; the harness checkout
// is three levels up.
const DEFAULT_REPO_ROOT = path.resolve(PKG_ROOT, '..', '..', '..')
/**
 * Resolve the DeepSeek Harness checkout root. The in-tree package default is
 * the historical three-level parent; an explicit `RLM_DSH_REPO_ROOT` (absolute
 * or relative, resolved to absolute) wins for external worktrees.
 */
function resolveDshRepoRoot(): string {
  const override = process.env.RLM_DSH_REPO_ROOT
  const value = override !== undefined && override.trim() !== '' ? override : DEFAULT_REPO_ROOT
  return path.resolve(value)
}
const REPO_ROOT = resolveDshRepoRoot()
const BIN = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const PROFILE = 'dsh-rlm-m1e'
const LIVE = process.env.RLM_LIVE_SMOKE === '1'
// Disposable-only live selection: the isolated copy of settings.yaml is
// rewritten to this provider/model so the smoke never inherits the ambient
// agent-default-model. Overridable without touching ambient settings.
const LIVE_PROVIDER = process.env.RLM_LIVE_PROVIDER ?? 'vllm'
const LIVE_MODEL = process.env.RLM_LIVE_MODEL ?? 'DeepSeek-V4-Flash-Vision-Exp'

/** Node launcher shared by every dsh invocation (source execution). */
function runDsh(args: string[], env: Record<string, string>, cwd: string, timeoutMs = 10000) {
  const res = spawnSync('node', ['--import', 'tsx/esm', BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  if (res.error) throw res.error
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Little-endian zstd frame magic (0xFD2FB528). */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

async function decompressSession(file: string): Promise<string> {
  const zdata = await fs.promises.readFile(file)
  const offsets: number[] = []
  for (let i = 0; i + 3 < zdata.length; i++) {
    if (zdata[i] === MAGIC[0] && zdata[i + 1] === MAGIC[1] && zdata[i + 2] === MAGIC[2] && zdata[i + 3] === MAGIC[3]) offsets.push(i)
  }
  let all = ''
  for (let k = 0; k < offsets.length; k++) {
    const s = offsets[k]
    const e = k + 1 < offsets.length ? offsets[k + 1] : zdata.length
    try {
      const buf = await new Promise<Buffer>((resolve, reject) => {
        zlib.zstdDecompress(zdata.subarray(s, e), (err, out) => (err ? reject(err) : resolve(out)))
      })
      all += buf.toString('utf8')
    } catch { /* torn trailing frame */ }
  }
  return all
}

/** All persisted session logs under a home, keyed by their session id. */
async function readSessionLogs(home: string): Promise<Map<string, string>> {
  const root = path.join(home, 'sessions')
  const out = new Map<string, string>()
  async function walk(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.name.endsWith('.jsonl.zstd')) {
        out.set(path.basename(dir), await decompressSession(p))
      }
    }
  }
  await walk(root)
  return out
}

test('M1E: fresh isolated DSH Profile runs the real RLM loop', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the live profile smoke (needs the configured vLLM model)'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  const harnessBin = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')
  assert.ok(
    fs.existsSync(harnessBin),
    'DSH harness bin.ts not found at ' + REPO_ROOT
      + '; set RLM_DSH_REPO_ROOT to the authoritative harness checkout (e.g. the deepseek-harness root) before running the live smoke',
  )

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m1e-smoke-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  // Disposable-only rewrite: read the ambient settings bytes, rewrite the
  // top-level agent-default-model block in the COPY, and write the temp home.
  // Ambient settings/credentials are never modified.
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientSettingsText = ambientSettingsBytes.toString('utf8')
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  const rewritten = replaceAgentDefaultModel(ambientSettingsText, LIVE_PROVIDER, LIVE_MODEL)
  fs.writeFileSync(path.join(home, 'settings.yaml'), rewritten)
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home }

  try {
    // 1. Real dsh plugin command installs the local package into a fresh profile.
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')

    // 2. Compose the profile as a headless one-shot and mount dsh-rlm enabled.
    // Preserve the manifest pnpm/dsh wrote (its dsh-rlm dependency) and only add
    // the headless bundle alongside the existing base bundle.
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(
      path.join(profileDir, 'cordis.patch.yml'),
      '# M1E smoke: mount dsh-rlm enabled, delegating rlm_query to the spawn provider.\n'
        + '- insert:\n'
        + '    - id: rlm\n'
        + '      name: dsh-rlm\n'
        + '      config:\n'
        + '        enabled: true\n'
        + '        provider: spawn\n',
    )

    // 3. Local UTF-8 Chinese fixture, referenced by absolute path.
    const fixture = path.join(home, 'fixture.txt')
    fs.writeFileSync(fixture, '这是中文夹具内容。深度求索强化学习闭环。\n第二行：模型通过 rlm_eval 读取本文件到上下文。\n', 'utf8')

    const task = [
      'You are running an RLM acceptance test. Use the rlm_eval tool to complete EXACTLY these two steps.',
      '',
      'Step 1: call rlm_eval ONCE with this exact Python source (do not change it):',
      '    content = open(r\'' + fixture + '\', encoding=\'utf-8\').read()',
      '    q = await rlm_query(\'In one short English sentence, answer: what is 2 plus 2? Reply with only that sentence.\')',
      '    answer = content + \' || \' + q',
      '    answer',
      '',
      'The rlm_query call spawns a one-shot subagent whose final text is returned; the Python cell must continue after it.',
      '',
      'Step 2: call rlm_eval a SECOND time with this exact Python source:',
      '    len(content) + len(q)',
      '',
      'After both steps succeed, your final reply must be a single line beginning with RLM_ACCEPT_OK followed by the step-2 integer result.',
    ].join('\n')

    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 12 * 60_000)
    const outTail = run.stdout.slice(-800)
    const errTail = (run.stderr ?? '').slice(-800)
    assert.equal(run.status, 0, `headless run exited ${run.status}; bounded stdout tail: ${outTail}; bounded stderr tail: ${errTail}`)
    assert.match(outTail, /RLM_ACCEPT_OK\s+\d+/, 'headless run did not report RLM_ACCEPT_OK; bounded stdout tail: ' + outTail)

    // 4. Inspect the official Session log.
    const logs = await readSessionLogs(home)
    assert.ok(logs.size >= 2, 'expected a main agent session and at least one subagent child session')

    let main: string | undefined
    let child: string | undefined
    for (const [id, text] of logs) {
      const header = JSON.parse(text.split('\n')[0])
      if (header.delegationDepth === 0 && /rlm_eval/.test(text)) main = text
      else if (header.delegationDepth > 0) child = text
    }
    assert.ok(main, 'no main agent session contains a rlm_eval tool call')

    const calls = [...main.matchAll(/\{"type":"tool\/call"[^\n]*?"name":"rlm_eval"/g)]
    assert.ok(calls.length >= 2, 'expected at least two rlm_eval tool calls, got ' + calls.length)

    // Point 2 & 3: the step-1 result carries the Chinese fixture INTO context and,
    // after await rlm_query, the subagent's sentence after the ' || ' separator
    // (Python continued after await and the run did not error).
    assert.match(main, /这是中文夹具内容/, 'main session result is missing the Chinese fixture text')
    assert.match(main, /这是中文夹具内容[\s\S]*? \|\| /, 'main session has the Chinese fixture but no rlm_query subagent sentence (Python did not continue after await)')

    // Point 4: a second rlm_eval reuses the first cell's globals (numeric result).
    const cell2 = main.match(/\{"type":"tool\/result"[^\n]*?"text":"(\d+)"[^\n]*\}/)
    assert.ok(cell2, 'second rlm_eval result not found')

    // Point 6: the official session log records the tool calls and bounded result.
    assert.match(main, /tool\/call/, 'session log missing tool/call record')
    assert.match(main, /tool\/result/, 'session log missing tool/result record')

    // Point 5: the child agent's tool set has no rlm_eval (no recursion).
    assert.ok(child, 'no subagent child session was persisted')
    assert.ok(!/rlm_eval/.test(child), 'child agent logged an rlm_eval tool call (recursion leak)')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the live smoke')
      if (ambientCredsBytes !== null) {
        assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the live smoke')
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test('M1E: runtime dispose releases the Python kernel process', { timeout: 30_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the live kernel-dispose smoke'); return }
  const { createRlmRuntime } = await import('../src/runtime.ts')
  const rt = createRlmRuntime(undefined, { timeout: 5000 })
  const pid = Number((await rt.eval('dispose', { code: 'import os\nos.getpid()' })).result)
  assert.ok(Number.isInteger(pid) && pid > 0)
  rt.dispose()
  await new Promise((r) => setTimeout(r, 1500))
  const probe = spawnSync(process.platform === 'win32' ? 'tasklist' : 'ps', process.platform === 'win32' ? ['/FI', 'PID eq ' + String(pid), '/NH'] : ['-p', String(pid)], { encoding: 'utf8' })
  assert.ok(!String(probe.stdout).includes(String(pid)), 'kernel process ' + pid + ' still alive after dispose')
})

// ---- M2 Issue #18: disposable live-smoke model selection ----

/** Value allowed in the disposable selection (safe YAML plain scalar). */
const SAFE_MODEL_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Deterministically rewrite the top-level `agent-default-model` block (its
 * `provider` and `model` scalars) in a DSH settings text copy. Line-oriented
 * and YAML-dependency-free: the input EOL style is detected once, unrelated
 * lines are preserved byte-for-byte, and only the two 2-space-indented scalars
 * inside the block are replaced. Throws when the block is missing, duplicated,
 * malformed (missing/duplicate/unknown child lines) or when a new scalar is
 * unsafe (must match [A-Za-z0-9][A-Za-z0-9._-]*).
 */
function replaceAgentDefaultModel(settingsText: string, provider: string, model: string): string {
  if (!SAFE_MODEL_SCALAR.test(provider) || !SAFE_MODEL_SCALAR.test(model)) {
    throw new Error('unsafe agent-default-model scalar; expected [A-Za-z0-9][A-Za-z0-9._-]*')
  }
  const eol = settingsText.includes('\r\n') ? '\r\n' : '\n'
  const lines = settingsText.split(/\r?\n/)
  const headers: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'agent-default-model:') headers.push(i)
  }
  if (headers.length === 0) throw new Error('agent-default-model block is missing')
  if (headers.length > 1) throw new Error('agent-default-model block is duplicated')
  const start = headers[0]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] !== '' && !lines[i].startsWith(' ')) {
      end = i
      break
    }
  }
  let providerIndex = -1
  let modelIndex = -1
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    if (line === '') continue
    const match = /^ {2}(provider|model):\s*\S+$/.exec(line)
    if (!match) throw new Error('agent-default-model block is malformed')
    if (match[1] === 'provider') {
      if (providerIndex !== -1) throw new Error('agent-default-model block is malformed')
      providerIndex = i
    } else {
      if (modelIndex !== -1) throw new Error('agent-default-model block is malformed')
      modelIndex = i
    }
  }
  if (providerIndex === -1 || modelIndex === -1) throw new Error('agent-default-model block is malformed')
  lines[providerIndex] = '  provider: ' + provider
  lines[modelIndex] = '  model: ' + model
  return lines.join(eol)
}

test('M2 Issue#18: isolated smoke deterministically pins agent-default-model to DSV4-FVE', () => {
  const unrelated = 'agent-presets:\n  defaultPreset: dsh\nproviders:\n  deepseek:\n    models:\n      - DeepSeek-V4-Flash-Vision-Exp\n'
  const lfInput = unrelated + 'agent-default-model:\n  provider: qwen38-207\n  model: qwen38-flash-next\n'
  const lfOut = replaceAgentDefaultModel(lfInput, 'vllm', 'DeepSeek-V4-Flash-Vision-Exp')
  assert.match(lfOut, /agent-default-model:\n {2}provider: vllm\n {2}model: DeepSeek-V4-Flash-Vision-Exp/)
  assert.ok(lfOut.startsWith(unrelated), 'unrelated settings must be preserved')
  assert.ok(!lfOut.includes('\r\n'), 'LF style must be preserved when the input uses LF')

  const crlfInput = lfInput.replace(/\n/g, '\r\n')
  const crlfOut = replaceAgentDefaultModel(crlfInput, 'vllm', 'DeepSeek-V4-Flash-Vision-Exp')
  assert.match(crlfOut, /agent-default-model:\r\n {2}provider: vllm\r\n {2}model: DeepSeek-V4-Flash-Vision-Exp/)
  assert.ok(!/[^\r]\n/.test(crlfOut), 'CRLF style must be preserved when the input uses CRLF')

  assert.throws(() => replaceAgentDefaultModel('a: 1\n', 'vllm', 'DeepSeek-V4-Flash-Vision-Exp'), /agent-default-model/)
  assert.throws(
    () => replaceAgentDefaultModel(lfInput + 'agent-default-model:\n  provider: x\n  model: y\n', 'vllm', 'DeepSeek-V4-Flash-Vision-Exp'),
    /agent-default-model/,
  )
  assert.throws(() => replaceAgentDefaultModel('agent-default-model:\n  model: qwen38-flash-next\n', 'vllm', 'DeepSeek-V4-Flash-Vision-Exp'), /agent-default-model/)
  assert.throws(() => replaceAgentDefaultModel('agent-default-model:\n  provider: qwen38-207\n', 'vllm', 'DeepSeek-V4-Flash-Vision-Exp'), /agent-default-model/)
  assert.throws(() => replaceAgentDefaultModel(lfInput, 'deep seek', 'DeepSeek-V4-Flash-Vision-Exp'), /scalar|unsafe/i)
  assert.throws(() => replaceAgentDefaultModel(lfInput, 'vllm', 'x ${ENV} y'), /scalar|unsafe/i)

  // Portability seam: an explicit RLM_DSH_REPO_ROOT override wins and is
  // resolved to an absolute path; without it the in-tree three-level default
  // is preserved. Purely synthetic; no filesystem access.
  const prevRepoRoot = process.env.RLM_DSH_REPO_ROOT
  try {
    process.env.RLM_DSH_REPO_ROOT = 'relative/harness'
    assert.equal(resolveDshRepoRoot(), path.resolve('relative/harness'))
    delete process.env.RLM_DSH_REPO_ROOT
    assert.equal(resolveDshRepoRoot(), path.resolve(PKG_ROOT, '..', '..', '..'))
  } finally {
    if (prevRepoRoot === undefined) delete process.env.RLM_DSH_REPO_ROOT
    else process.env.RLM_DSH_REPO_ROOT = prevRepoRoot
  }
})
