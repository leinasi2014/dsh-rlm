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
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..', '..')
const BIN = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const PROFILE = 'dsh-rlm-m1e'
const LIVE = process.env.RLM_LIVE_SMOKE === '1'

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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m1e-smoke-'))
  const profileDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  fs.copyFileSync(path.join(ambientHome, 'settings.yaml'), path.join(home, 'settings.yaml'))
  if (fs.existsSync(path.join(ambientHome, '.credentials.yaml'))) {
    fs.copyFileSync(path.join(ambientHome, '.credentials.yaml'), path.join(home, '.credentials.yaml'))
  }
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
    assert.match(run.stdout, /RLM_ACCEPT_OK\s+\d+/, 'headless run did not report RLM_ACCEPT_OK; stdout=' + run.stdout.slice(-800))

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
    fs.rmSync(home, { recursive: true, force: true })
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
