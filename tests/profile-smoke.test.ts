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
  const tsxUrl = 'file:///' + REPO_ROOT.replace(/\\/g, '/') + '/node_modules/tsx/dist/esm/index.mjs'
  const res = spawnSync('node', ['--import', tsxUrl, BIN, ...args], {
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
    const fixtureSentinel = 'M3_CONTEXT_LOADER_SENTINEL_4b9d8e'
    const fixtureText = '这是中文夹具内容。深度求索强化学习闭环。\n' + fixtureSentinel + '。\n第二行：模型通过 rlm_eval 读取本文件到上下文。\n'
    fs.writeFileSync(fixture, fixtureText, 'utf8')

    const task = [
      'You are running an RLM acceptance test. Use the rlm_eval tool to complete EXACTLY these two steps.',
      '',
      'Step 1: call rlm_eval ONCE with contextPath set exactly to this absolute file path:',
      '    ' + fixture,
      'Use this exact Python source (do not change it):',
      '    content = context',
      '    q = await rlm_query(\'In one short English sentence, answer: what is 2 plus 2? Reply with only that sentence.\')',
      '    answer = content + \' || \' + q',
      '    answer',
      '',
      'The rlm_query call spawns a one-shot subagent whose final text is returned; the Python cell must continue after it.',
      '',
      'Step 2: call rlm_eval a SECOND time with this exact Python source:',
      '    len(context) + len(q)',
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

    // Structured session selection: main is the depth-0 session with the most
    // rlm_eval tool calls; every depth>0 session is collected as a child.
    const children: string[] = []
    let main: string | undefined
    let mainCalls = -1
    for (const [id, text] of logs) {
      const header = JSON.parse(text.split('\n')[0])
      if (header.delegationDepth === 0) {
        const calls = countToolCalls(text, 'rlm_eval')
        if (main === undefined || calls > mainCalls) {
          main = text
          mainCalls = calls
        }
      } else if (header.delegationDepth > 0) {
        children.push(text)
      }
    }
    assert.ok(main, 'no depth-0 main agent session was persisted')
    assert.ok(mainCalls >= 2, 'expected at least two rlm_eval tool calls in the main session, got ' + mainCalls)
    const rlmArguments = toolCallArguments(main, 'rlm_eval')
    const managedCall = rlmArguments.find((args) => (
      args !== null
      && typeof args === 'object'
      && !Array.isArray(args)
      && (args as { contextPath?: unknown }).contextPath === fixture
    ))
    assert.ok(managedCall, 'no persisted rlm_eval call carried the exact contextPath')
    assert.ok(
      rlmArguments.every((args) => !JSON.stringify(args).includes(fixtureSentinel)),
      'managed loader copied the unique fixture sentinel into model-visible rlm_eval arguments',
    )

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

    // Point 5: no child agent actually invoked rlm_eval. A mention in
    // prompt/system-visible text is not a tool call; only a persisted
    // tool/call record with that exact name counts as recursion.
    assert.ok(children.length >= 1, 'no subagent child session was persisted')
    for (const child of children) {
      assert.equal(countToolCalls(child, 'rlm_eval'), 0, 'child agent logged an rlm_eval tool call (recursion leak)')
    }
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

test('M4 Issue#25: fresh isolated DSH Profile completes a depth-three RLM branch', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M4 recursive live smoke (needs the configured vLLM model)'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m4-smoke-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  const copiedSettings = replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL)
    .replace(/defaultPreset: danger-full-access/, 'defaultPreset: workspace-write')
  fs.writeFileSync(path.join(home, 'settings.yaml'), copiedSettings)
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write' }

  const leafPrompt = 'Reply exactly M4_LEAF_OK. Do not call tools.'
  const depth2Prompt = [
    'You are the depth-2 child in an RLM acceptance test. Call rlm_eval exactly once with the following Python source, then reply with one line beginning M4_D2_OK followed by its visible result.',
    'try:',
    '    root_marker',
    '    isolation = "M4_D2_LEAK"',
    'except NameError:',
    '    isolation = "M4_D2_ISOLATED"',
    `leaf = await rlm_query(${JSON.stringify(leafPrompt)})`,
    'isolation + " " + leaf',
  ].join('\n')
  const depth1Prompt = [
    'You are the depth-1 child in an RLM acceptance test. Call rlm_eval exactly once with the following Python source, then reply with one line beginning M4_D1_OK followed by its visible result.',
    'try:',
    '    root_marker',
    '    isolation = "M4_D1_LEAK"',
    'except NameError:',
    '    isolation = "M4_D1_ISOLATED"',
    `child = await rlm_query(${JSON.stringify(depth2Prompt)})`,
    'isolation + " " + child',
  ].join('\n')
  const rootCode = [
    'root_marker = "M4_ROOT_ONLY"',
    `child = await rlm_query(${JSON.stringify(depth1Prompt)})`,
    'child',
  ].join('\n')
  const task = [
    'You are running a recursive RLM acceptance test. Call rlm_eval exactly once with this exact Python source, then reply with one line beginning RLM_M4_ACCEPT_OK followed by its visible result.',
    '',
    rootCode,
  ].join('\n')

  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        maxDepth: 3',
      '',
    ].join('\n'))

    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 12 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M4 run failed: ' + outTail + ' ' + run.stderr.slice(-1200))
    assert.match(outTail, /RLM_M4_ACCEPT_OK[\s\S]*M4_D1_OK[\s\S]*M4_D1_ISOLATED[\s\S]*M4_D2_OK[\s\S]*M4_D2_ISOLATED[\s\S]*M4_LEAF_OK/)

    const logs = await readSessionLogs(home)
    const headers = [...logs.values()].map((text) => JSON.parse(text.split('\n')[0]))
    const depths = headers.map((header) => header.delegationDepth).sort((a, b) => a - b)
    assert.ok(depths.includes(0) && depths.includes(1) && depths.includes(2) && depths.includes(3), 'missing persisted root/depth-1/depth-2/leaf lineage: ' + JSON.stringify(depths))
    assert.ok(headers.every((header) => header.delegationDepth <= 3), 'a Session exceeded maxDepth=3: ' + JSON.stringify(depths))
    const headerById = new Map(headers.map((header) => [header.id, header]))
    for (const header of headers) {
      if (header.delegationDepth === 0) continue
      const parentHeader = headerById.get(header.parentSession)
      assert.ok(parentHeader, 'child Session has no persisted parent header: ' + JSON.stringify(header))
      assert.equal(parentHeader.delegationDepth, header.delegationDepth - 1, 'persisted parent/child depths are not adjacent')
    }
    for (const [id, text] of logs) {
      const header = JSON.parse(text.split('\n')[0])
      if (header.delegationDepth === 1 || header.delegationDepth === 2) {
        assert.ok(countToolCalls(text, 'rlm_eval') >= 1, 'recursive Session ' + id + ' did not call rlm_eval')
      }
      if (header.delegationDepth === 3) {
        assert.equal(countToolCalls(text, 'rlm_eval'), 0, 'exact-depth leaf ' + id + ' called rlm_eval')
      }
    }
    const allLogs = [...logs.values()].join('\n')
    assert.match(allLogs, /M4_D1_ISOLATED/)
    assert.match(allLogs, /M4_D2_ISOLATED/)
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M4 live smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M4 live smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test('M5 Issue#31 RED: a timed-out kernel restores supported Session globals in a fresh installed Profile', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M5 recovery acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m5-recovery-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  fs.writeFileSync(path.join(home, 'settings.yaml'), replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL))
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home }
  const marker = 'M5_STATE_LOSS_MARKER_88be31'
  const task = [
    'You are validating M5 RLM recovery. Use rlm_eval exactly three times in this order.',
    `1. Run exactly: m5_marker = ${JSON.stringify(marker)}`,
    '2. Run exactly: import time; time.sleep(2). This is expected to time out and replace the kernel.',
    '3. Run exactly: m5_marker. It must now return the original marker because M5 recovery restores the checkpoint.',
    'After the third call succeeds and returns the marker, reply with exactly M5_STATE_RECOVERY_OBSERVED.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        timeout: 1000',
      '        snapshotRecovery: true',
      '',
    ].join('\n'))
    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 8 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M5 recovery failed: ' + outTail + ' ' + run.stderr.slice(-1200))
    assert.match(outTail, /M5_STATE_RECOVERY_OBSERVED/)
    const logs = await readSessionLogs(home)
    const main = [...logs.values()].find((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    assert.ok(main, 'no persisted depth-0 Session log')
    assert.ok(countToolCalls(main, 'rlm_eval') >= 3, 'expected three rlm_eval attempts')
    assert.match(main, /timeout/i, 'Session log did not record the induced timeout')
    assert.match(main, new RegExp(marker), 'Session log did not record the restored marker')
    assert.doesNotMatch(main, /m5_marker.*not defined|NameError/i, 'Session log recorded loss of the checkpointed marker')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M5 recovery smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M5 observation')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test('M6 Issue#33 RED: reset creates a new Session-local RLM kernel in a fresh installed Profile', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M6 manual-reset acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m6-reset-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  fs.writeFileSync(path.join(home, 'settings.yaml'), replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL))
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home }
  const marker = 'M6_RESET_MARKER_f26f69'
  const task = [
    'You are validating M6 RLM manual reset. Use rlm_eval exactly three times in this order.',
    `1. Run exactly: m6_marker = ${JSON.stringify(marker)}`,
    '2. Call rlm_eval with exactly this JSON input and no other property: {"reset":true}.',
    '3. Run exactly: m6_marker. The call must report that m6_marker is not defined because reset made a new empty kernel.',
    'If all three steps occur and the third call reports m6_marker is not defined, reply with exactly M6_RESET_OBSERVED. Otherwise reply with exactly M6_RESET_UNSUPPORTED.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        timeout: 1000',
      '        snapshotRecovery: true',
      '',
    ].join('\n'))
    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 8 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M6 reset journey failed: ' + outTail + ' ' + run.stderr.slice(-1200))
    assert.match(outTail, /M6_RESET_OBSERVED/)
    assert.doesNotMatch(outTail, /M6_RESET_UNSUPPORTED/)
    const logs = await readSessionLogs(home)
    const main = [...logs.values()].find((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    assert.ok(main, 'no persisted depth-0 Session log')
    assert.equal(countToolCalls(main, 'rlm_eval'), 3, 'expected exactly the ordered set, reset, and post-reset read calls')
    assert.deepEqual(toolCallArguments(main, 'rlm_eval'), [
      { code: `m6_marker = ${JSON.stringify(marker)}` },
      { reset: true },
      { code: 'm6_marker' },
    ], 'official Session log did not record the exact set -> reset -> read tool journey')
    const outcomes = toolOutcomes(main, 'rlm_eval')
    assert.equal(outcomes.length, 3, 'each ordered rlm_eval call must have one official tool/result event')
    assert.equal(outcomes[0].result?.isError, false, 'the pre-reset assignment must succeed')
    assert.equal(outcomes[1].result?.isError, false, 'the reset call must succeed')
    assert.equal(outcomes[1].result?.text, 'RLM state reset', 'the reset acknowledgement must not expose discarded state')
    assert.equal(outcomes[2].result?.isError, true, 'the post-reset read must be the failing tool result')
    assert.match(outcomes[2].result?.text ?? '', /rlm_eval failed \(eval\):[\s\S]*(?:m6_marker.*not defined|NameError)/i, 'the post-reset read must report a typed undefined-marker error')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M6 reset smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M6 reset smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test('M7 Issue#36 RED: a fresh installed Profile returns ordered rlm_query_batched results through rlm_eval', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M7 batched-query acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m7-batch-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  fs.writeFileSync(path.join(home, 'settings.yaml'), replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL))
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home }
  const left = 'M7_BATCH_LEFT_7d642e'
  const right = 'M7_BATCH_RIGHT_4a9c3b'
  const code = [
    `results = await rlm_query_batched([${JSON.stringify(`Reply exactly ${left}. Do not call tools.`)}, ${JSON.stringify(`Reply exactly ${right}. Do not call tools.`)}])`,
    "' | '.join(results)",
  ].join('\n')
  const task = [
    'You are validating M7 batched RLM queries. Call rlm_eval exactly once with the exact Python source below and no other rlm_eval call.',
    '',
    code,
    '',
    `Only if that same tool call succeeds and visibly returns ${left} before ${right}, reply with exactly M7_BATCHED_PROFILE_OK. Otherwise reply with exactly M7_BATCHED_PROFILE_UNSUPPORTED.`,
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '',
    ].join('\n'))

    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 12 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M7 batch journey failed: ' + outTail + ' ' + run.stderr.slice(-1200))
    const logs = await readSessionLogs(home)
    const main = [...logs.values()].find((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    assert.ok(main, 'no persisted depth-0 Session log')
    assert.equal(countToolCalls(main, 'rlm_eval'), 1, 'M7 acceptance must use exactly one ordinary rlm_eval call')
    assert.deepEqual(toolCallArguments(main, 'rlm_eval'), [{ code }], 'official Session log did not record the exact batched helper call')
    const outcomes = toolOutcomes(main, 'rlm_eval')
    assert.equal(outcomes.length, 1, 'the exact rlm_eval call must have one correlated official result')
    assert.equal(outcomes[0].result?.isError, false, 'rlm_query_batched must be provided by the Session Python kernel; actual result: ' + (outcomes[0].result?.text ?? '<missing>'))
    assert.match(outcomes[0].result?.text ?? '', new RegExp(`${left}[\\s\\S]*${right}`), 'the correlated rlm_eval result must preserve input order')
    const children = [...logs.values()].filter((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 1)
    assert.equal(children.length, 2, 'the batch must persist one depth-1 DSH child Session for each admitted prompt')
    for (const child of children) {
      assert.equal(countToolCalls(child, 'rlm_eval'), 0, 'a batched leaf child must not receive rlm_eval')
    }
    assert.match(outTail, /M7_BATCHED_PROFILE_OK/, 'headless agent did not observe the successful correlated result')
    assert.doesNotMatch(outTail, /M7_BATCHED_PROFILE_UNSUPPORTED/, 'headless agent reported that the helper is unavailable')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M7 batch smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M7 batch smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test('M8 Issue#39: a fresh installed Profile keeps an opaque handle across cells and admits an official child inbox follow-up', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M8 continuable-spawn acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured vLLM provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m8-spawn-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  fs.writeFileSync(path.join(home, 'settings.yaml'), replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL))
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home }
  const childPrompt = 'Reply exactly M8_CONTINUABLE_CHILD_4b2d9a. Do not call tools.'
  const followupPrompt = 'Reply exactly M8_CONTINUABLE_FOLLOWUP_9ca27e. Do not call tools.'
  const spawnCode = `h = await rlm_spawn(${JSON.stringify(childPrompt)})\n"M8_SPAWNED"`
  // Keep the parent Agent live long enough for the official continuation
  // manager to route its settlement notice. DSH deliberately does not retain
  // a notice once the direct parent Agent has already left its live registry.
  const followupCode = `await rlm_followup(h, ${JSON.stringify(followupPrompt)})\nawait __import__("asyncio").sleep(30)\n"M8_FOLLOWED"`
  const task = [
    'You are validating M8 continuable spawn. Call rlm_eval exactly twice, in the stated order, with the exact Python sources below and no other rlm_eval call.',
    '',
    'First call:',
    spawnCode,
    '',
    'Second call after the first succeeds:',
    followupCode,
    '',
    'Do not use any other tool. Only if both correlated rlm_eval results succeed, reply exactly M8_CONTINUABLE_PROFILE_OK.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        timeout: 60000',
      '',
    ].join('\n'))

    const run = runDsh(['--profile', PROFILE, task], env, REPO_ROOT, 12 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M8 journey failed before its correlated tool result: ' + outTail + ' ' + run.stderr.slice(-1200))
    let logs = new Map<string, string>()
    for (let attempt = 0; attempt < 25; attempt++) {
      logs = await readSessionLogs(home)
      const childReceivedFollowup = [...logs.values()].some((text) =>
        JSON.parse(text.split('\n')[0]).delegationDepth === 1 && text.includes(followupPrompt))
      const parentObservedSettlement = [...logs.values()].some((text) =>
        JSON.parse(text.split('\n')[0]).delegationDepth === 0 && text.includes('subagent-settled'))
      if (childReceivedFollowup && parentObservedSettlement) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const mainEntry = [...logs.entries()].find(([, text]) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    const main = mainEntry?.[1]
    assert.ok(main, 'no persisted depth-0 Session log')
    assert.equal(countToolCalls(main, 'rlm_eval'), 2, 'M8 acceptance must use exactly two ordered ordinary rlm_eval calls')
    assert.deepEqual(toolCallArguments(main, 'rlm_eval'), [{ code: spawnCode }, { code: followupCode }], 'official Session log did not record the exact spawn/follow-up cells')
    const outcomes = toolOutcomes(main, 'rlm_eval')
    assert.equal(outcomes.length, 2, 'each exact rlm_eval call must have one correlated official result')
    assert.deepEqual(outcomes.map((outcome) => outcome.result?.isError), [false, false], 'spawn and follow-up must both be admitted: ' + JSON.stringify(outcomes))
    assert.match(outcomes[0].result?.text ?? '', /M8_SPAWNED/, 'spawn cell did not receive its non-answer acknowledgement')
    assert.match(outcomes[1].result?.text ?? '', /M8_FOLLOWED/, 'follow-up cell did not continue after inbox admission')
    assert.match(main, /subagent-settled/, 'official parent Session log did not record the continuable child settlement notice')
    const children = [...logs.values()].filter((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 1)
    assert.ok(children.length >= 1, 'spawn must persist an official depth-1 child Session')
    assert.ok(children.some((text) => text.includes(childPrompt) && text.includes(followupPrompt)), 'official child Session log did not publish both ordered inbox prompts')
    assert.match(outTail, /M8_CONTINUABLE_PROFILE_OK/, 'headless agent did not observe both successful correlated results')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M8 RED smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M8 RED smoke')
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
 * lines inside the block (comments, blank lines, sibling scalar keys such as
 * `reasoningEffort`, future sibling keys) are preserved byte-for-byte and in
 * order, and only the two 2-space-indented provider/model scalar lines are
 * replaced. Throws when the block is missing or duplicated, when provider or
 * model is missing or duplicated, or when a new scalar is unsafe (must match
 * [A-Za-z0-9][A-Za-z0-9._-]*). Unrelated YAML is not validated.
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
    if (/^ {2}provider:\s*\S+$/.test(line)) {
      if (providerIndex !== -1) throw new Error('agent-default-model block is malformed')
      providerIndex = i
    } else if (/^ {2}model:\s*\S+$/.test(line)) {
      if (modelIndex !== -1) throw new Error('agent-default-model block is malformed')
      modelIndex = i
    }
    // Every other line (reasoningEffort, comments, blank lines, sibling
    // keys) is preserved byte-for-byte; only provider/model are rewritten.
  }
  if (providerIndex === -1 || modelIndex === -1) throw new Error('agent-default-model block is malformed')
  lines[providerIndex] = '  provider: ' + provider
  lines[modelIndex] = '  model: ' + model
  return lines.join(eol)
}

/**
 * Count persisted JSONL SessionEvents of exactly one tool call using the
 * authoritative DSH contract: `row.type === 'tool/call'` AND `row.data` is a
 * non-null object AND `row.data.name === toolName`. Lines are parsed
 * defensively; torn, non-JSON and empty lines are ignored (they are not
 * evidence of a call). A model-visible text mention is zero, and a wrong
 * top-level `row.name` without `data.name` is zero.
 */
function countToolCalls(logText: string, toolName: string): number {
  let count = 0
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (
      row !== null
      && typeof row === 'object'
      && !Array.isArray(row)
      && (row as { type?: unknown }).type === 'tool/call'
      && (row as { data?: unknown }).data !== null
      && typeof (row as { data?: unknown }).data === 'object'
      && (row as { data: { name?: unknown } }).data.name === toolName
    ) {
      count += 1
    }
  }
  return count
}

/** Parsed model-visible arguments from official persisted tool/call events. */
function toolCallArguments(logText: string, toolName: string): unknown[] {
  const out: unknown[] = []
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (
      row === null
      || typeof row !== 'object'
      || Array.isArray(row)
      || (row as { type?: unknown }).type !== 'tool/call'
    ) continue
    const data = (row as { data?: unknown }).data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    if ((data as { name?: unknown }).name !== toolName) continue
    const rawArgs = (data as { arguments?: unknown }).arguments
    if (typeof rawArgs !== 'string') continue
    try {
      out.push(JSON.parse(rawArgs))
    } catch {
      // A malformed persisted argument is not trusted evidence.
    }
  }
  return out
}

/** One ordered official tool/call and its result, correlated by durable callId. */
function toolOutcomes(logText: string, toolName: string): { args: unknown; result?: { isError: boolean; text: string } }[] {
  const ordered: { callId: string; args: unknown; result?: { isError: boolean; text: string } }[] = []
  const byCallId = new Map<string, { isError: boolean; text: string }>()
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const event = row as { type?: unknown; data?: unknown }
    if (event.type === 'tool/call' && event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)) {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (data.name !== toolName || typeof data.callId !== 'string' || typeof data.arguments !== 'string') continue
      try {
        ordered.push({ callId: data.callId, args: JSON.parse(data.arguments) })
      } catch {
        // A malformed persisted argument is not evidence for an accepted call.
      }
      continue
    }
    if (event.type !== 'tool/result' || event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) continue
    const message = (event.data as { message?: unknown }).message
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content) || content.length !== 1) continue
    const block = content[0]
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const toolResult = block as { type?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown }
    if (toolResult.type !== 'tool-result' || typeof toolResult.toolCallId !== 'string' || !Array.isArray(toolResult.content)) continue
    const text = toolResult.content
      .filter((item): item is { type: 'text'; text: string } => item !== null && typeof item === 'object' && !Array.isArray(item) && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string')
      .map((item) => item.text)
      .join('')
    byCallId.set(toolResult.toolCallId, { isError: toolResult.isError === true, text })
  }
  return ordered.map(({ callId, args }) => ({ args, ...(byCallId.has(callId) ? { result: byCallId.get(callId)! } : {}) }))
}

test('M2 Issue#18: isolated smoke deterministically pins agent-default-model to DSV4-FVE', () => {
  const unrelated = 'agent-presets:\n  defaultPreset: dsh\nproviders:\n  deepseek:\n    models:\n      - DeepSeek-V4-Flash-Vision-Exp\n'
  const lfInput = unrelated + 'agent-default-model:\n  provider: qwen38-207\n  model: qwen38-flash-next\n  reasoningEffort: max\n'
  const lfOut = replaceAgentDefaultModel(lfInput, 'vllm', 'DeepSeek-V4-Flash-Vision-Exp')
  assert.match(lfOut, /agent-default-model:\n {2}provider: vllm\n {2}model: DeepSeek-V4-Flash-Vision-Exp/)
  assert.ok(
    lfOut.includes('agent-default-model:\n  provider: vllm\n  model: DeepSeek-V4-Flash-Vision-Exp\n  reasoningEffort: max'),
    'reasoningEffort child must remain exactly unchanged',
  )
  assert.ok(lfOut.startsWith(unrelated), 'unrelated settings must be preserved')
  assert.ok(!lfOut.includes('\r\n'), 'LF style must be preserved when the input uses LF')

  const crlfInput = lfInput.replace(/\n/g, '\r\n')
  const crlfOut = replaceAgentDefaultModel(crlfInput, 'vllm', 'DeepSeek-V4-Flash-Vision-Exp')
  assert.match(crlfOut, /agent-default-model:\r\n {2}provider: vllm\r\n {2}model: DeepSeek-V4-Flash-Vision-Exp/)
  assert.ok(
    crlfOut.includes('agent-default-model:\r\n  provider: vllm\r\n  model: DeepSeek-V4-Flash-Vision-Exp\r\n  reasoningEffort: max'),
    'CRLF reasoningEffort child must remain exactly unchanged',
  )
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

  // Structured tool-call oracle (official DSH SessionEvent shape): a parsed
  // event counts only when row.type === 'tool/call' AND row.data is a non-null
  // object AND row.data.name === toolName. A plain-text mention is zero, and a
  // wrong top-level row.name without data.name is zero.
  const mentionJsonl = '{"type":"text","text":"persistent rlm_eval instructions"}\n'
  const officialCall = '{"type":"tool/call","data":{"turn":1,"step":1,"callId":"c1","name":"rlm_eval","arguments":"{}"}}\n'
  const wrongTopLevel = '{"type":"tool/call","name":"rlm_eval","arguments":"{}"}\n'
  assert.equal(countToolCalls(mentionJsonl, 'rlm_eval'), 0, 'text mention must not count as a tool call')
  assert.equal(countToolCalls(officialCall, 'rlm_eval'), 1, 'official nested data.name record must count as one')
  assert.equal(countToolCalls(wrongTopLevel, 'rlm_eval'), 0, 'top-level name without data.name must not count')
  assert.equal(countToolCalls(officialCall + '{"type":"tool/call","data":{\n', 'rlm_eval'), 1, 'torn non-JSON line must be ignored')
  assert.deepEqual(toolCallArguments(officialCall, 'rlm_eval'), [{}])
  assert.deepEqual(toolCallArguments(mentionJsonl, 'rlm_eval'), [])
})

test('M9 Issue#42: a fresh installed Profile confines the kernel to the Session workspace', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M9 sandbox acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m9-spawn-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m9-ws-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  const copiedSettings = replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL)
    .replace(/defaultPreset: danger-full-access/, 'defaultPreset: workspace-write')
  fs.writeFileSync(path.join(home, 'settings.yaml'), copiedSettings)
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write' }
  const cell1 = [
    "import os",
    "p = os.path.join(os.getcwd(), 'm9_marker.txt')",
    "open(p, 'w').write('M9_WRITE_OK')",
    "denied = 'allowed'",
    "try:",
    "    with open(r'C:\\Windows\\System32\\dsh-rlm-m9-denied.txt', 'w') as f: f.write('x')",
    "except OSError:",
    "    denied = 'denied'",
    "os.getcwd() + '|' + denied",
  ].join('\n')
  const cell2 = "open('m9_marker.txt').read()"
  const task = [
    'You are validating M9 sandbox confinement. Call rlm_eval exactly twice, in the stated order, with the exact Python sources below and no other rlm_eval call.',
    '',
    'First call:',
    cell1,
    '',
    'Second call after the first succeeds:',
    cell2,
    '',
    'Do not use any other tool. Only if both correlated rlm_eval results succeed, reply exactly M9_CONTINUABLE_SANDBOX_OK.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        kernelSandbox: auto',
      '        timeout: 60000',
      '',
    ].join('\n'))

    const run = runDsh(['--profile', PROFILE, task], env, workspace, 12 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'headless M9 journey failed before its correlated tool result: ' + outTail + ' ' + run.stderr.slice(-1200))
    let logs = new Map<string, string>()
    for (let attempt = 0; attempt < 25; attempt++) {
      logs = await readSessionLogs(home)
      const main = [...logs.values()].find((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
      if (main && countToolCalls(main, 'rlm_eval') === 2) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const mainEntry = [...logs.entries()].find(([, text]) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    const main = mainEntry?.[1]
    assert.ok(main, 'no persisted depth-0 Session log')
    assert.equal(countToolCalls(main, 'rlm_eval'), 2, 'M9 acceptance must use exactly two ordered ordinary rlm_eval calls; log: ' + main.slice(-3000))
    const outcomes = toolOutcomes(main, 'rlm_eval')
    assert.equal(outcomes.length, 2, 'each exact rlm_eval call must have one correlated official result')
    assert.deepEqual(outcomes.map((outcome) => outcome.result?.isError), [false, false], 'both cells must succeed: ' + JSON.stringify(outcomes))
    const first = outcomes[0].result?.text ?? ''
    assert.match(first, /\|denied$/, 'out-of-workspace write was NOT denied: ' + first)
    const cwd = first.split('|')[0]
    assert.equal(path.resolve(cwd), path.resolve(workspace), 'kernel cwd is not the session workspace: ' + cwd + ' vs ' + workspace)
    assert.match(outcomes[1].result?.text ?? '', /M9_WRITE_OK/, 'relative write did not land/re-read in the workspace')
    assert.ok(fs.existsSync(path.join(workspace, 'm9_marker.txt')), 'marker file missing in the workspace')
    assert.equal(fs.readFileSync(path.join(workspace, 'm9_marker.txt'), 'utf8'), 'M9_WRITE_OK')
    assert.ok(!fs.existsSync('C:\\Windows\\System32\\dsh-rlm-m9-denied.txt'), 'denied target exists (sandbox did not block)')
    assert.match(outTail, /M9_CONTINUABLE_SANDBOX_OK/, 'headless agent did not observe both successful correlated results')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M9 smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M9 smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('M10 Issue#44: a fresh installed Profile resumes the same Session after a runtime restart', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M10 durable persistence acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-spawn-'))
  const durable = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-durable-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  const copiedSettings = replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL)
    .replace(/defaultPreset: danger-full-access/, 'defaultPreset: workspace-write')
  fs.writeFileSync(path.join(home, 'settings.yaml'), copiedSettings)
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write' }
  const cell1 = [
    "from pathlib import Path",
    "p = Path('m10_value.txt')",
    "p.write_text('41')",
    "value = 41",
    "p.read_text()",
  ].join('\\n')
  const cell2 = [
    "from pathlib import Path",
    "value + 1",
    "Path('m10_value.txt').read_text()",
  ].join('\\n')
  const task = [
    'You are validating M10 durable persistence. Call rlm_eval EXACTLY once with this exact Python source (do not change it):',
    cell1,
    '',
    'Then reply exactly M10_FIRST_OK when that one correlated rlm_eval result succeeds.',
  ].join('\n')
  const task2 = [
    'You are validating M10 resume. Call rlm_eval EXACTLY once with this exact Python source (do not change it):',
    cell2,
    '',
    'Then reply exactly M10_SECOND_OK when that one correlated rlm_eval result succeeds.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        kernelSandbox: auto',
      '        snapshotRecovery: true',
      '        durableRoot: ' + JSON.stringify(durable),
      '        timeout: 60000',
      '',
    ].join('\n'))

    const run1 = runDsh(['--profile', PROFILE, task], env, home, 12 * 60_000)
    assert.equal(run1.status, 0, 'M10 first journey failed: ' + run1.stdout.slice(-400) + ' ' + run1.stderr.slice(-400))
    assert.match(run1.stdout.slice(-800), /M10_FIRST_OK/, 'first headless run did not report M10_FIRST_OK')
    const firstLogs = await readSessionLogs(home)
    const firstMainId = [...firstLogs.keys()][0]
    assert.ok(firstMainId, 'no main session id found after first run')
    const durableFiles = fs.readdirSync(durable)
    assert.ok(durableFiles.some((f) => f.endsWith('.checkpoint.json')), 'no durable checkpoint file published')
    assert.ok(durableFiles.some((f) => f.endsWith('.meta.json')), 'no durable meta file published')

    // A new runtime instance (separate Node process) with the same durableRoot
    // resumes the same Session through the M9 transport. The durable files were
    // produced by the real installed Profile above.
    const resumeScript = [
      "import { createRlmRuntime } from './src/runtime.ts';",
      "const runtime = createRlmRuntime(undefined, { durableRoot: " + JSON.stringify(durable) + ", snapshotRecovery: true, timeout: 60000 });",
      "const key = " + JSON.stringify(firstMainId) + ";",
      "const out = await runtime.eval(key, { code: 'value + 1' });",
      "console.log('M10_RESUME:' + JSON.stringify(out));",
      "await runtime.dispose();",
    ].join('\n');
    const resumeTsx = 'file:///' + REPO_ROOT.replace(/\\/g, '/') + '/node_modules/tsx/dist/esm/index.mjs'
    const resume = spawnSync('node', ['--import', resumeTsx, '--input-type=module', '-e', resumeScript], { cwd: PKG_ROOT, encoding: 'utf8', timeout: 120000 });
    assert.equal(resume.status, 0, 'M10 resume script failed: ' + resume.stderr.slice(-4000));
    const resumeOut = resume.stdout;
    assert.match(resumeOut, /"result":"42"/, 'new runtime did not restore value (expect 42): ' + resumeOut.slice(-400))
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M10 smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M10 smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(durable, { recursive: true, force: true })
    }
  }
})

test('M11 Issue#46: a fresh installed Profile lets a query through under the observed-token guard', { timeout: 15 * 60_000 }, async (t) => {
  if (!LIVE) { t.skip('set RLM_LIVE_SMOKE=1 to run the M11 token guard acceptance'); return }
  const ambientHome = process.env.DSH_HOME
  if (!ambientHome || !fs.existsSync(path.join(ambientHome, 'settings.yaml'))) {
    t.skip('DSH_HOME with settings.yaml is required; it supplies the configured provider and credential refs')
    return
  }
  assert.ok(fs.existsSync(BIN), 'DSH harness bin.ts not found at ' + REPO_ROOT)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m11-spawn-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const ambientSettingsPath = path.join(ambientHome, 'settings.yaml')
  const ambientSettingsBytes = fs.readFileSync(ambientSettingsPath)
  const ambientCredsPath = path.join(ambientHome, '.credentials.yaml')
  const ambientCredsBytes = fs.existsSync(ambientCredsPath) ? fs.readFileSync(ambientCredsPath) : null
  const copiedSettings = replaceAgentDefaultModel(ambientSettingsBytes.toString('utf8'), LIVE_PROVIDER, LIVE_MODEL)
    .replace(/defaultPreset: danger-full-access/, 'defaultPreset: workspace-write')
  fs.writeFileSync(path.join(home, 'settings.yaml'), copiedSettings)
  if (ambientCredsBytes !== null) fs.writeFileSync(path.join(home, '.credentials.yaml'), ambientCredsBytes)
  const env = { DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write' }
  const task = [
    'You are validating M11 token guard. Call rlm_eval exactly once with exactly this Python source:',
    "text = await rlm_query('Reply exactly M11_GUARD_OK')",
    '',
    'Then reply exactly M11_PROFILE_OK when that one correlated rlm_eval result succeeds.',
  ].join('\n')
  try {
    const add = runDsh(['plugin', '--profile', PROFILE, 'add', '-w', PKG_ROOT], env, REPO_ROOT, 180_000)
    assert.equal(add.status, 0, 'dsh plugin add failed: ' + add.stderr)
    assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-rlm')), 'dsh-rlm not installed into the profile')
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: rlm',
      '      name: dsh-rlm',
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '        kernelSandbox: auto',
      '        guardQueryTokens: true',
      '        maxQueryTokensPerCell: 100000000',
      '        timeout: 60000',
      '',
    ].join('\n'))

    const run = runDsh(['--profile', PROFILE, task], env, home, 12 * 60_000)
    const outTail = run.stdout.slice(-1200)
    assert.equal(run.status, 0, 'M11 headless journey failed: ' + outTail + ' ' + run.stderr.slice(-600))
    assert.match(outTail, /M11_PROFILE_OK/, 'headless agent did not confirm M11_PROFILE_OK: ' + outTail.slice(-200))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const logs = await readSessionLogs(home)
    const main = [...logs.values()].find((text) => JSON.parse(text.split('\n')[0]).delegationDepth === 0)
    assert.ok(main, 'no main Session log after M11 journey')
    assert.equal(countToolCalls(main, 'rlm_eval'), 1, 'M11 must use exactly one rlm_eval call')
  } finally {
    try {
      assert.ok(ambientSettingsBytes.equals(fs.readFileSync(ambientSettingsPath)), 'ambient settings.yaml was modified by the M11 smoke')
      if (ambientCredsBytes !== null) assert.ok(ambientCredsBytes.equals(fs.readFileSync(ambientCredsPath)), 'ambient .credentials.yaml was modified by the M11 smoke')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

