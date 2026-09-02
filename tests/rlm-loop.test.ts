import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kernelPath = path.join(rootDir, 'python-runtime', 'rlm_kernel.py')
const pythonCmd: string = process.env.PYTHON ?? 'python'

interface Frame {
  type: string
  [key: string]: unknown
}

class Kernel {
  child: ChildProcessWithoutNullStreams
  private buf = ''
  private lines: Frame[] = []
  private waiters: ((f: Frame) => void)[] = []
  stderr = ''
  exit: Promise<number | null>

  constructor() {
    this.child = spawn(pythonCmd, [kernelPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (d: string) => {
      this.stderr += d
    })
    this.child.stdout.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        const frame = JSON.parse(line) as Frame
        const w = this.waiters.shift()
        if (w) w(frame)
        else this.lines.push(frame)
      }
    })
    this.exit = new Promise((resolve) => {
      this.child.on('close', (code) => resolve(code))
    })
  }

  send(obj: object) {
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  next(timeoutMs = 10000): Promise<Frame> {
    const f = this.lines.shift()
    if (f) return Promise.resolve(f)
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('timed out waiting for a frame')),
        timeoutMs,
      )
      this.waiters.push((frame) => {
        clearTimeout(t)
        resolve(frame)
      })
    })
  }

  async close() {
    this.child.stdin.end()
  }

  id(frame: Frame): number {
    return frame.id as number
  }
}

async function ready(k: Kernel): Promise<void> {
  const frame = await k.next()
  assert.equal(frame.type, 'ready')
  assert.equal(frame.version, 1)
}

test('M1A: persistent globals and top-level await across cells', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import asyncio\nawait asyncio.sleep(0.01)\nseed = 7' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    assert.equal(r1.id, 1)
    assert.equal(r1.result, undefined)
    k.send({ type: 'eval', id: 2, code: 'await asyncio.sleep(0.01)\nseed * 6' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '42')
  } finally {
    await k.close()
  }
})

test('M1A: rlm_query request/response resumes the cell', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: 'text = await rlm_query("what is 2+2?")\ntext + "!"',
    })
    const q = await k.next()
    assert.equal(q.type, 'query')
    assert.equal(q.prompt, 'what is 2+2?')
    k.send({ type: 'query_result', id: k.id(q), text: '4' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, '4!')
  } finally {
    await k.close()
  }
})

test('M1A: runtime error is typed and kernel continues', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'raise ValueError("boom")' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'ValueError')
    assert.equal(e.message, 'boom')
    k.send({ type: 'eval', id: 2, code: '5 + 5' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, '10')
  } finally {
    await k.close()
  }
})

test('M1A: syntax error is typed and kernel continues', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'def f(:\n  pass' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.kind, 'syntax_error')
    assert.equal(e.name, 'SyntaxError')
    k.send({ type: 'eval', id: 2, code: '3 * 3' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, '9')
  } finally {
    await k.close()
  }
})

test('M1A: query failure is a typed error and kernel continues', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'await rlm_query("hello")' })
    const q = await k.next()
    assert.equal(q.type, 'query')
    k.send({
      type: 'error',
      id: k.id(q),
      phase: 'query',
      kind: 'query_error',
      message: 'model unavailable',
    })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'query_error')
    assert.equal(e.name, 'RlmQueryError')
    assert.equal(e.message, 'model unavailable')
    k.send({ type: 'eval', id: 2, code: '1 + 1' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, '2')
  } finally {
    await k.close()
  }
})

test('M1A: stdout is byte-bounded and marked truncated', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'print("a" * 100)', max_stdout: 32 })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.truncated, true)
    assert.equal(r.stdout, 'a'.repeat(32))
  } finally {
    await k.close()
  }
})

test('M1A: protocol error terminates the kernel nonzero', async () => {
  const k = new Kernel()
  await ready(k)
  k.send({ type: 'eval', id: 1, code: 'x = 1' })
  await k.next()
  k.child.stdin.write('this is not json\n')
  const code = await k.exit
  assert.notEqual(code, 0)
})

// ---- M1A Issue #5: scaffold isolation and result formatting containment ----

test('M1A Issue#5: a cell that shadows rlm_query cannot poison later cells', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'rlm_query = lambda prompt: "fake"\n1' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    assert.equal(r1.result, '1')
    k.send({ type: 'eval', id: 2, code: 'await rlm_query("real")' })
    const q = await k.next()
    assert.equal(q.type, 'query')
    assert.equal(q.prompt, 'real')
    k.send({ type: 'query_result', id: k.id(q), text: 'official' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, 'official')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: deleting rlm_query in a failing cell is restored before the next cell', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'del rlm_query\nraise ValueError("boom")' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'ValueError')
    k.send({ type: 'eval', id: 2, code: 'await rlm_query("after-delete")' })
    const q = await k.next()
    assert.equal(q.type, 'query')
    assert.equal(q.prompt, 'after-delete')
    k.send({ type: 'query_result', id: k.id(q), text: 'restored' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, 'restored')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a failed result leaves no stale result and keeps user __rlm_result__', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: '__rlm_result__ = "stale"\n1 / 0' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'ZeroDivisionError')
    k.send({ type: 'eval', id: 2, code: 'x = 5' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, undefined)
    k.send({ type: 'eval', id: 3, code: '__rlm_result__' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, 'stale')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a user-defined __rlm_result__ is an ordinary persistent global', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: '__rlm_result__ = "mine"\n40 + 2' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    assert.equal(r1.result, '42')
    k.send({ type: 'eval', id: 2, code: '__rlm_result__' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, 'mine')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a raising __repr__ is a typed eval error and the kernel survives', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'marker = 1' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    k.send({
      type: 'eval',
      id: 2,
      code: 'class Boom:\n    def __repr__(self):\n        raise RuntimeError("repr boom")\nBoom()',
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'RuntimeError')
    assert.equal(e.message, 'repr boom')
    k.send({ type: 'eval', id: 3, code: 'marker' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '1')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a bare awaitable last expression is not auto-awaited', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import asyncio\nasyncio.sleep(0.01)' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(typeof r.result, 'string')
    assert.match(r.result as string, /<coroutine object .* at 0x[0-9a-fA-F]+>/)
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: hostile exception attributes cannot escape as a kernel fatal', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nmarker = 1\nos.getpid()' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    const pid = Number(r1.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + r1.result)
    k.send({
      type: 'eval',
      id: 2,
      code: [
        'class Evil(Exception):',
        '    @property',
        '    def lineno(self):',
        '        raise RuntimeError("lineno boom")',
        '    @property',
        '    def offset(self):',
        '        raise RuntimeError("offset boom")',
        '    @property',
        '    def text(self):',
        '        raise RuntimeError("text boom")',
        '    @property',
        '    def detail(self):',
        '        raise RuntimeError("detail boom")',
        '    def __str__(self):',
        '        return "evil repr"',
        'class Boom:',
        '    def __repr__(self):',
        '        raise Evil("repr boom")',
        'Boom()',
      ].join('\n'),
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'Evil')
    assert.equal(e.message, 'evil repr')
    assert.equal(e.line, undefined)
    assert.equal(e.column, undefined)
    k.send({ type: 'eval', id: 3, code: 'import os\nmarker + 40' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '41')
    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, String(pid))
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: flaky or NaN result detail cannot escape error-frame construction', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nmarker = 1\nos.getpid()' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    const pid = Number(r1.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + r1.result)
    k.send({
      type: 'eval',
      id: 2,
      code: [
        'class FlakyDetail(list):',
        '    def __init__(self):',
        '        list.__init__(self, [1, 2, 3])',
        '        self.calls = 0',
        '    def __iter__(self):',
        '        self.calls += 1',
        '        if self.calls > 1:',
        '            raise RuntimeError("detail boom on second pass")',
        '        return list.__iter__(self)',
        'class Boom:',
        '    def __repr__(self):',
        '        e = RuntimeError("repr boom")',
        '        e.detail = FlakyDetail()',
        '        raise e',
        'Boom()',
      ].join('\n'),
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'RuntimeError')
    assert.equal(e.message, 'repr boom')
    assert.deepEqual(e.detail, [1, 2, 3])
    k.send({ type: 'eval', id: 3, code: 'import os\nmarker + 40' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '41')
    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, String(pid))
    k.send({
      type: 'eval',
      id: 5,
      code: [
        'class BoomNaN:',
        '    def __repr__(self):',
        '        e = RuntimeError("nan repr")',
        '        e.detail = float("nan")',
        '        raise e',
        'BoomNaN()',
      ].join('\n'),
    })
    const e2 = await k.next()
    assert.equal(e2.type, 'error')
    assert.equal(e2.name, 'RuntimeError')
    assert.equal(e2.message, 'nan repr')
    assert.equal(e2.detail, 'nan')
    k.send({ type: 'eval', id: 6, code: 'marker' })
    const r4 = await k.next()
    assert.equal(r4.type, 'result')
    assert.equal(r4.result, '1')
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a lone surrogate in result detail is a typed error and the kernel survives', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nmarker = 1\nos.getpid()' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    const pid = Number(r1.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + r1.result)
    k.send({
      type: 'eval',
      id: 2,
      code: [
        'class Boom:',
        '    def __repr__(self):',
        '        e = RuntimeError("repr boom")',
        '        e.detail = chr(0xD800)',
        '        raise e',
        'Boom()',
      ].join('\n'),
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'RuntimeError')
    assert.equal(e.message, 'repr boom')
    assert.equal(e.detail, '\uD800')
    k.send({ type: 'eval', id: 3, code: 'import os\nmarker + 40' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '41')
    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, String(pid))
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: a lone surrogate in an error message is a typed error and the kernel survives', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nmarker = 7\nos.getpid()' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    const pid = Number(r1.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + r1.result)
    k.send({
      type: 'eval',
      id: 2,
      code: [
        'class Evil(Exception):',
        '    def __str__(self):',
        '        return chr(0xD800)',
        'class Boom:',
        '    def __repr__(self):',
        '        raise Evil("x")',
        'Boom()',
      ].join('\n'),
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'Evil')
    assert.equal(e.message, '\uD800')
    k.send({ type: 'eval', id: 3, code: 'import os\nmarker + 35' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '42')
    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, String(pid))
  } finally {
    await k.close()
  }
})

test('M1A Issue#5: normal UTF-8 and Chinese text round-trip through the wire', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'print("中文输出")\n"中文结果"' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.stdout, '中文输出\n')
    assert.equal(r.result, '中文结果')
    k.send({ type: 'eval', id: 2, code: 'await rlm_query("你好")' })
    const q = await k.next()
    assert.equal(q.type, 'query')
    assert.equal(q.prompt, '你好')
    k.send({ type: 'query_result', id: k.id(q), text: '世界' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '世界')
  } finally {
    await k.close()
  }
})

// ---- M1B: TypeScript runtime process protocol ----

import { createRlmRuntime, RlmError } from '../src/runtime.ts'

function rt(config: Record<string, unknown> = {}) {
  return createRlmRuntime(undefined, config)
}

test('M1B: starts a kernel, returns results and reuses it per session key', async () => {
  const runtime = rt()
  try {
    const first = await runtime.eval('sess-a', { code: 'seed = 7' })
    assert.equal(first.result, undefined)
    const second = await runtime.eval('sess-a', { code: 'seed * 6' })
    assert.equal(second.result, '42')
    await assert.rejects(
      runtime.eval('sess-b', { code: 'seed' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: a cell error is typed and the same kernel keeps serving', async () => {
  const runtime = rt()
  try {
    await assert.rejects(
      runtime.eval('err', { code: 'raise ValueError("boom")' }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError)
        assert.equal(err.kind, 'eval')
        assert.equal(err.phase, 'eval')
        assert.match(err.message, /boom/)
        return true
      },
    )
    const next = await runtime.eval('err', { code: '5 + 5' })
    assert.equal(next.result, '10')
  } finally {
    runtime.dispose()
  }
})

test('M1B: rlm_query callbacks resume the running cell', async () => {
  const runtime = rt()
  try {
    const prompts: string[] = []
    const out = await runtime.eval('q', {
      code: 'a = await rlm_query("first")\nb = await rlm_query("second")\na + "-" + b',
      onQuery: async (prompt: string) => {
        prompts.push(prompt)
        return prompt.toUpperCase()
      },
    })
    assert.deepEqual(prompts, ['first', 'second'])
    assert.equal(out.result, 'FIRST-SECOND')
  } finally {
    runtime.dispose()
  }
})

test('M1B: a failing query callback surfaces as a cell error', async () => {
  const runtime = rt()
  try {
    await assert.rejects(
      runtime.eval('qf', {
        code: 'await rlm_query("anything")',
        onQuery: async () => {
          throw new Error('model down')
        },
      }),
      (err: unknown) =>
        err instanceof RlmError && err.kind === 'eval' && /model down/.test(err.message),
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: rlm_query without a handler fails the cell explicitly', async () => {
  const runtime = rt()
  try {
    await assert.rejects(
      runtime.eval('noh', { code: 'await rlm_query("x")' }),
      (err: unknown) => err instanceof RlmError && /no query handler/.test(err.message),
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: a cell cannot exceed the per-cell query limit', async () => {
  const runtime = rt({ maxQueries: 1 })
  try {
    await assert.rejects(
      runtime.eval('lim', {
        code: 'a = await rlm_query("one")\nb = await rlm_query("two")',
        onQuery: async () => 'ok',
      }),
      (err: unknown) => err instanceof RlmError && /query limit exceeded/.test(err.message),
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: stdout and result are byte-bounded and marked truncated', async () => {
  const runtime = rt({ maxStdout: 32, maxResult: 8 })
  try {
    const out = await runtime.eval('st', { code: 'print("a" * 100)\n"0123456789"' })
    assert.equal(out.stdout, 'a'.repeat(32))
    assert.equal(out.result, '01234567')
    assert.equal(out.truncated, true)
  } finally {
    runtime.dispose()
  }
})

test('M1B: a cell that runs past its timeout is terminated', async () => {
  const runtime = rt({ timeout: 300 })
  try {
    await assert.rejects(
      runtime.eval('t', { code: 'import time\ntime.sleep(5)\n1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: after a timeout a later eval starts a fresh kernel', async () => {
  const runtime = rt({ timeout: 300 })
  try {
    // The first eval keeps the tight 300ms budget: it must time out and evict
    // the kernel exactly as before.
    await assert.rejects(
      runtime.eval('fresh', { code: 'import time\ntime.sleep(5)\nval = 1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
    // The second eval is a fresh-namespace semantic check (NameError), not a
    // cold-start probe: give it an explicit generous budget so a slow Windows
    // Python start is never mistaken for a semantic error. The production
    // default timeout is unchanged.
    await assert.rejects(
      runtime.eval('fresh', { code: 'val', timeout: 5000 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B: dispose cancels an in-flight cell and is idempotent', async () => {
  const runtime = rt()
  const pending = runtime.eval('c', { code: 'import time\ntime.sleep(5)' })
  await new Promise((res) => setTimeout(res, 400))
  runtime.dispose()
  runtime.dispose()
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
  )
})

test('M1B: a bad python command is a spawn failure', async () => {
  const runtime = createRlmRuntime(undefined, { python: 'dsh-rlm-no-such-interpreter' })
  try {
    await assert.rejects(
      runtime.eval('sp', { code: '1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'spawn',
    )
  } finally {
    runtime.dispose()
  }
})

test('M1B Issue#5: a raising __repr__ is kind=eval and the same kernel keeps its globals', async () => {
  const runtime = rt()
  try {
    const pidOut = await runtime.eval('repr', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)
    await runtime.eval('repr', { code: 'marker = 1' })
    await assert.rejects(
      runtime.eval('repr', {
        code: 'class Boom:\n    def __repr__(self):\n        raise RuntimeError("repr boom")\nBoom()',
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval' && /repr boom/.test(err.message),
    )
    const pidAgain = await runtime.eval('repr', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
    const markerOut = await runtime.eval('repr', { code: 'marker' })
    assert.equal(markerOut.result, '1')
  } finally {
    runtime.dispose()
  }
})


// ---- M1C/M1D: DSH tool registration and rlm_query -> one-shot Subagent bridge ----

import { registerRlmPlugin } from '../src/runtime.ts'

interface FakeExec { agent: { id: string }; signal: AbortSignal }

function makeExec(agentId: string): FakeExec {
  return { agent: { id: agentId }, signal: new AbortController().signal }
}

interface MockCtx {
  ctx: any
  registered: any[]
  starts: { provider: string; request: any }[]
  run: any
  teardown: (() => void) | undefined
  label: string | undefined
}

function makeMockCtx(options: { queryText?: string } = {}): MockCtx {
  const registered: any[] = []
  const starts: { provider: string; request: any }[] = []
  const run: any = {
    disposed: false,
    result: Promise.resolve({ output: [{ type: 'text', text: options.queryText ?? '4' }], stopReason: 'completed' }),
    dispose: async () => { run.disposed = true },
  }
  // Build the mutable mock first; ctx.effect writes straight onto it (not a
  // closure local, which the returned object would capture as stale undefined).
  const m: MockCtx = { ctx: undefined as any, registered, starts, run, teardown: undefined, label: undefined }
  m.ctx = {
    tools: {
      register(def: any) {
        registered.push(def)
        return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1) }
      },
    },
    subagents: {
      async start(provider: string, request: any) {
        starts.push({ provider, request })
        return run
      },
    },
    effect(execute: () => () => void, effectLabel: string) {
      m.label = effectLabel
      m.teardown = execute()
    },
  }
  return m
}

test('M1C: rlm_eval is registered only when the plugin is enabled', () => {
  const disabled = makeMockCtx()
  registerRlmPlugin(disabled.ctx, { enabled: false })
  assert.equal(disabled.registered.length, 0)
  assert.equal(disabled.teardown, undefined)

  const enabled = makeMockCtx()
  registerRlmPlugin(enabled.ctx, { enabled: true })
  try {
    assert.equal(enabled.registered.length, 1)
    assert.equal(enabled.registered[0].name, 'rlm_eval')
    // Minimal input: only code, and it is required. defineTool normalizes
    // `parameters` to JSON Schema ({ type, properties, required }).
    assert.equal(enabled.registered[0].parameters.type, 'object')
    assert.deepEqual(Object.keys(enabled.registered[0].parameters.properties), ['code'])
    assert.equal(enabled.registered[0].parameters.properties.code.type, 'string')
    assert.ok(enabled.registered[0].parameters.required.includes('code'))
    // The runtime teardown effect is mounted.
    assert.equal(typeof enabled.teardown, 'function')
    assert.equal(enabled.label, 'rlm runtime teardown')
  } finally {
    enabled.teardown?.()
  }
})

test('M1D: the one-shot child request filters out rlm_eval and uses the calling agent', async () => {
  const m = makeMockCtx({ queryText: 'four' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  const exec = makeExec('sess-a')

  try {
    const out = await tool.execute({ code: 't = await rlm_query("what is 2+2?")\nt + "!"' }, exec)

    assert.equal(out.result, 'four!')
    assert.equal(m.starts.length, 1)
    const { provider, request } = m.starts[0]
    assert.equal(provider, 'spawn')
    assert.equal(request.label, 'rlm query')
    assert.equal(request.parent.id, 'sess-a')
    assert.equal(request.signal, exec.signal)
    // Child cannot recurse: rlm_eval is explicitly denied.
    assert.deepEqual(request.toolFilter, { deny: ['rlm_eval'] })
    assert.deepEqual(request.prompt, [{ type: 'text', text: 'what is 2+2?' }])
    // Foreground call must dispose the child after collecting its text.
    assert.equal(m.run.disposed, true)
  } finally {
    m.teardown?.()
  }
})

test('M1C: rlm_eval keys Python kernels by the calling agent id (session isolation)', async () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]

  try {
    await tool.execute({ code: 'seed = 7' }, makeExec('sess-a'))
    // Same session reuses the kernel/globals.
    const same = await tool.execute({ code: 'seed * 6' }, makeExec('sess-a'))
    assert.equal(same.result, '42')
    // A different session has a fresh kernel with no seed.
    await assert.rejects(
      tool.execute({ code: 'seed' }, makeExec('sess-b')),
      (err: unknown) => err instanceof Error && err.message.includes('rlm_eval failed (eval)'),
    )
  } finally {
    m.teardown?.()
  }
})

test('M1C/M1D: plugin teardown unregisters the tool and cancels the in-flight cell', async () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]

  try {
    // Start a cell that blocks so the kernel is live and the eval is pending.
    const pending = tool.execute({ code: 'import time\ntime.sleep(5)' }, makeExec('sess-a'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(typeof m.teardown, 'function')

    // Tear down the runtime while the cell is still running.
    m.teardown!()
    // The tool is unregistered…
    assert.equal(m.registered.length, 0)
    // …and the in-flight cell is cancelled rather than left hanging.
    await assert.rejects(
      pending,
      (err: unknown) =>
        err instanceof Error
        && (err.message.includes('cancel') || err.message.includes('rlm_eval failed (cancel)')),
    )
  } finally {
    m.teardown?.()
  }
})// ---- M2: propagate tool cancellation (exec.signal) to the session kernel ----

/** True when no Windows process owns `pid` (an orphan-free session kernel). */
function isProcessGone(pid: number): boolean {
  const probe = spawnSync('tasklist', ['/FI', 'PID eq ' + String(pid), '/NH'], { encoding: 'utf8' })
  const out = String(probe.stdout ?? '')
  return !out.includes(String(pid))
}

/** Poll until the kernel process is gone (taskkill settles asynchronously). */
async function waitForPidGone(pid: number, timeoutMs = 6000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isProcessGone(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return isProcessGone(pid)
}

const SHORT_DELAY = 400

function runningCell(): string {
  return 'import time\ntime.sleep(60)'
}

test('M2: a pre-aborted signal rejects with cancel and never starts a kernel', async () => {
  const runtime = rt()
  try {
    const ctl = new AbortController()
    ctl.abort('too-late')
    const start = Date.now()
    await assert.rejects(
      runtime.eval('pre', { code: '1', signal: ctl.signal }),
      (err: unknown) => err instanceof RlmError && err.kind === 'cancel' && /too-late/.test(err.message),
    )
    // The rejection is immediate (no kernel spawn, no timeout wait).
    assert.ok(Date.now() - start < 1000, 'pre-aborted eval must reject immediately')
    // A later normal eval on the same session still starts a clean kernel.
    const out = await runtime.eval('pre', { code: '2 * 3' })
    assert.equal(out.result, '6')
  } finally {
    runtime.dispose()
  }
})

test('M2: aborting a running pure-Python cell cancels fast, not at the default timeout', async () => {
  const runtime = rt() // default per-cell timeout is 30s; a cancel must beat it
  try {
    const ctl = new AbortController()
    const pending = runtime.eval('act', { code: runningCell(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    const start = Date.now()
    ctl.abort('user-cancel')
    await assert.rejects(pending, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    assert.ok(Date.now() - start < 5000, 'cancel should reject well before the 30s default timeout')
  } finally {
    runtime.dispose()
  }
})

test('M2: cancelling a session evicts its kernel so the next eval is a fresh namespace', async () => {
  const runtime = rt()
  try {
    await runtime.eval('gone', { code: 'marker = 1' })
    const ctl = new AbortController()
    const pending = runtime.eval('gone', { code: runningCell(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    ctl.abort('user-cancel')
    await assert.rejects(pending, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    // The cancelled session's globals are gone: a fresh kernel has no `marker`.
    await assert.rejects(
      runtime.eval('gone', { code: 'marker' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
    // Yet the fresh kernel serves a normal cell.
    const fresh = await runtime.eval('gone', { code: '2 + 2' })
    assert.equal(fresh.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M2: cancelling one session leaves another session globals intact', async () => {
  const runtime = rt()
  try {
    await runtime.eval('keep', { code: 'keepvar = 42' })
    const ctl = new AbortController()
    const pending = runtime.eval('kill', { code: runningCell(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    ctl.abort('user-cancel')
    await assert.rejects(pending, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    // The other session's kernel and globals survive untouched.
    const out = await runtime.eval('keep', { code: 'keepvar' })
    assert.equal(out.result, '42')
  } finally {
    runtime.dispose()
  }
})

test('M2: rlm_eval forwards exec.signal so a parent cancel stops the cell', async () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  const ctl = new AbortController()
  try {
    const exec = { agent: { id: 'sess-sig' }, signal: ctl.signal }
    const pending = tool.execute({ code: runningCell() }, exec)
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    ctl.abort('user-cancel')
    // The tool wraps the typed runtime cancel into a normal tool failure.
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /cancel/.test(err.message),
    )
  } finally {
    m.teardown?.()
  }
})

test('M2: cancelling and disposing leaves no orphaned kernel process', async () => {
  const runtime = rt()
  const ctl = new AbortController()
  try {
    // Capture this session kernel's own OS pid.
    const idOut = await runtime.eval('leak', { code: 'import os\nos.getpid()' })
    const pid = Number(idOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + idOut.result)

    const pending = runtime.eval('leak', { code: runningCell(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    ctl.abort('user-cancel')
    await assert.rejects(pending, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    runtime.dispose()

    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'kernel pid ' + pid + ' is still alive after cancel + dispose')
  } finally {
    runtime.dispose()
  }
})

// ---- M2 Issue #1: protocol-fault kill, ready deadline/abort, terminal dispose ----

/**
 * Wait until the silent-kernel marker writes the child's OS pid. Used instead
 * of a fixed sleep so the ready-timeout/abort tests stay event-driven.
 */
async function waitForPidFile(pidFile: string, timeoutMs = 5000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(pidFile)) return Number(readFileSync(pidFile, 'utf8'))
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('silent kernel pid marker was not written in time')
}

/**
 * Run the very next Python process with a `sitecustomize` that writes its own
 * PID to a marker file and then executes `body` (Python statements) before
 * blocking. Shadowing `sitecustomize` through PYTHONPATH lets tests simulate a
 * kernel that never sends `ready` or one that sends a bad `ready` frame,
 * without touching `python-runtime/rlm_kernel.py`.
 */
async function withPressedKernel<T>(body: string, fn: (pidFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-silent-'))
  const pidFile = path.join(dir, 'pid.txt')
  const py =
    'import os, time\nopen(' + JSON.stringify(pidFile) + ', "w").write(str(os.getpid()))\n'
    + body + '\ntime.sleep(60)\n'
  writeFileSync(path.join(dir, 'sitecustomize.py'), py)
  const prev = process.env.PYTHONPATH
  process.env.PYTHONPATH = dir + path.delimiter + (prev ?? '')
  try {
    return await fn(pidFile)
  } finally {
    if (prev === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

function withHungKernel<T>(fn: (pidFile: string) => Promise<T>): Promise<T> {
  return withPressedKernel('', fn)
}

test('M2: a corrupt JSON frame from the kernel kills and evicts the process tree', async () => {
  const runtime = rt()
  try {
    await runtime.eval('fault-json', { code: 'marker = 7' })
    const pidOut = await runtime.eval('fault-json', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)

    await assert.rejects(
      runtime.eval('fault-json', {
        code: `import sys
sys.__stdout__.write('this is not json\\n')`,
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'protocol',
    )
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'corrupt JSON frame left kernel pid ' + pid + ' alive')
    // The kernel was evicted, so the next eval starts a fresh namespace.
    await assert.rejects(
      runtime.eval('fault-json', { code: 'marker' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    runtime.dispose()
  }
})

test('M2: a non-object frame from the kernel kills and evicts the process tree', async () => {
  const runtime = rt()
  try {
    const pidOut = await runtime.eval('fault-array', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)

    await assert.rejects(
      runtime.eval('fault-array', {
        code: `import sys
sys.__stdout__.write('[1, 2, 3]\\n')`,
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'protocol',
    )
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'non-object frame left kernel pid ' + pid + ' alive')
  } finally {
    runtime.dispose()
  }
})

test('M2: an unknown frame type from the kernel kills and evicts the process tree', async () => {
  const runtime = rt()
  try {
    const pidOut = await runtime.eval('fault-unknown', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)

    await assert.rejects(
      runtime.eval('fault-unknown', {
        code: `import sys
sys.__stdout__.write('{"type":"mystery"}\\n')`,
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'protocol',
    )
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'unknown frame type left kernel pid ' + pid + ' alive')
  } finally {
    runtime.dispose()
  }
})

test('M2: a frame with a wrong request id from the kernel kills and evicts the process tree', async () => {
  const runtime = rt()
  try {
    const pidOut = await runtime.eval('fault-id', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)

    await assert.rejects(
      runtime.eval('fault-id', {
        code: `import sys, json
sys.__stdout__.write(json.dumps({"type": "result", "id": 999, "stdout": "", "truncated": False}) + "\\n")`,
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'protocol',
    )
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'wrong request id left kernel pid ' + pid + ' alive')
  } finally {
    runtime.dispose()
  }
})

test('M2: a wrong ready version terminates the startup path once, kills, and evicts', async () => {
  const runtime = rt()
  try {
    await withPressedKernel(
      `import sys, json
sys.stdout.write(json.dumps({"type": "ready", "version": 999}) + "\\n")
sys.stdout.flush()`,
      async (pidFile) => {
        const pending = runtime.eval('bad-version', { code: '1' })
        // Attach the rejection handler immediately: the bad ready frame can
        // arrive before the pid marker poll completes, and an unhandled
        // rejection would turn this test into a spurious failure.
        const rejection = assert.rejects(
          pending,
          (err: unknown) =>
            err instanceof RlmError && err.kind === 'protocol' && /version/.test(err.message),
        )
        const pid = await waitForPidFile(pidFile)
        await rejection
        const gone = await waitForPidGone(pid)
        assert.ok(gone, 'bad-ready-version kernel pid ' + pid + ' is still alive')
      },
    )
    // After the pressed startup window, the same session gets a fresh kernel.
    const out = await runtime.eval('bad-version', { code: '2 + 2' })
    assert.equal(out.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M2: a silent kernel that never sends ready is killed by the startup deadline', async () => {
  const runtime = rt({ timeout: 1500 })
  try {
    await withHungKernel(async (pidFile) => {
      const pending = runtime.eval('silent-ready', { code: '1' })
      const rejection = assert.rejects(
        pending,
        (err: unknown) => err instanceof RlmError && err.kind === 'timeout' && /startup/.test(err.message),
      )
      const pid = await waitForPidFile(pidFile)
      const start = Date.now()
      await rejection
      assert.ok(Date.now() - start < 5000, 'ready timeout must reject promptly, not hang')
      const gone = await waitForPidGone(pid)
      assert.ok(gone, 'silent kernel pid ' + pid + ' survived the startup deadline')
    })
  } finally {
    runtime.dispose()
  }
})

test('M2: aborting during the ready handshake kills the kernel and rejects with cancel', async () => {
  const runtime = rt()
  try {
    await withHungKernel(async (pidFile) => {
      const ctl = new AbortController()
      const pending = runtime.eval('ready-abort', { code: '1', signal: ctl.signal })
      const rejection = assert.rejects(
        pending,
        (err: unknown) => err instanceof RlmError && err.kind === 'cancel' && /ready-cancel/.test(err.message),
      )
      // The child is up but cannot send `ready`; abort while the host waits.
      const pid = await waitForPidFile(pidFile)
      ctl.abort('ready-cancel')
      await rejection
      const gone = await waitForPidGone(pid)
      assert.ok(gone, 'ready-aborted kernel pid ' + pid + ' is still alive')
    })
  } finally {
    runtime.dispose()
  }
})

test('M2: disposing during the ready handshake settles the waiter and kills the kernel', async () => {
  const runtime = rt()
  try {
    await withHungKernel(async (pidFile) => {
      const pending = runtime.eval('ready-dispose', { code: '1' })
      const rejection = assert.rejects(
        pending,
        (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
      )
      const pid = await waitForPidFile(pidFile)
      runtime.dispose()
      await rejection
      const gone = await waitForPidGone(pid)
      assert.ok(gone, 'pid ' + pid + ' survived dispose during the ready handshake')
    })
  } finally {
    runtime.dispose()
  }
})

test('M2: dispose is terminal and a later eval is rejected without spawning', async () => {
  // A missing interpreter would surface as `spawn` if eval still tried to
  // start a kernel; the terminal-dispose check must win and reject `closed`.
  const runtime = createRlmRuntime(undefined, { python: 'dsh-rlm-no-such-interpreter' })
  runtime.dispose()
  runtime.dispose()
  const start = Date.now()
  await assert.rejects(
    runtime.eval('post-dispose', { code: '1' }),
    (err: unknown) => err instanceof RlmError && err.kind === 'closed' && /disposed/.test(err.message),
  )
  assert.ok(Date.now() - start < 500, 'post-dispose eval must reject immediately')
  runtime.dispose()
})

// ---- M2 Issue #1 successor: Windows kill fallback, shared deadline, ready guards ----

test('M2 Issue#1 successor: a taskkill startup failure falls back and never crashes the host', {
  skip: process.platform !== 'win32',
}, async () => {
  const runtime = rt({ timeout: 5000 })
  const savedPath = process.env.PATH
  const savedSystemRoot = process.env.SystemRoot
  try {
    // Live kernel so a terminal transition has a real OS pid to kill.
    const idOut = await runtime.eval('tkfail', { code: 'import os\nos.getpid()' })
    const pid = Number(idOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + idOut.result)

    const ctl = new AbortController()
    const pending = runtime.eval('tkfail', { code: runningCell(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, SHORT_DELAY))
    const rejection = assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
    )

    // Make both the bare-name taskkill (the b1f13ae bug) and the canonical
    // SystemRoot\System32\taskkill.exe resolution fail, then restore before any
    // further probe so no other tooling sees a stripped environment.
    const bogus = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-no-taskkill-'))
    process.env.PATH = bogus
    process.env.SystemRoot = bogus
    try {
      ctl.abort('tkfail-cancel')
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = savedSystemRoot
      rmSync(bogus, { recursive: true, force: true })
    }

    await rejection
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'kernel pid ' + pid + ' survived a taskkill startup failure without a fallback')

    // The host survived the failed taskkill spawn (any unhandled ChildProcess
    // 'error' would have exited the test process) and can still start kernels.
    const out = await runtime.eval('tkfail-other', { code: '2 + 2' })
    assert.equal(out.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#1 successor: startup and cell share one total deadline', async () => {
  const runtime = rt({ timeout: 1200 })
  try {
    await withPressedKernel(
      `import time
time.sleep(0.5)
import sys, json
sys.stdout.write(json.dumps({"type": "ready", "version": 1}) + "\\n")
sys.stdout.flush()`,
      async (pidFile) => {
        const start = Date.now()
        const pending = runtime.eval('shared-budget', { code: 'import time\ntime.sleep(60)' })
        const rejection = assert.rejects(
          pending,
          (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
        )
        const pid = await waitForPidFile(pidFile)
        await rejection
        const elapsed = Date.now() - start
        // b1f13ae charges the full timeout to startup AND the cell (~0.5s+1.2s);
        // the successor charges one budget (~1.2s) from eval entry.
        assert.ok(elapsed < 1600, `eval exceeded a single 1200ms budget (${elapsed}ms)`)
        const gone = await waitForPidGone(pid)
        assert.ok(gone, 'shared-budget kernel pid ' + pid + ' is still alive after the deadline')
      },
    )
    const out = await runtime.eval('shared-budget-other', { code: '2 + 2' })
    assert.equal(out.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#1 successor: a late abort after a settled eval cannot evict the idle kernel', async () => {
  const runtime = rt()
  try {
    await runtime.eval('late-abort', { code: 'marker = 1' })
    const ctl = new AbortController()
    const out = await runtime.eval('late-abort', { code: 'marker + 1', signal: ctl.signal })
    assert.equal(out.result, '2')
    // The ready waiters' abort listener is removed synchronously when ready
    // settles; a late abort must be a no-op on the idle kernel and its globals.
    ctl.abort('too-late')
    const again = await runtime.eval('late-abort', { code: 'marker + 2' })
    assert.equal(again.result, '3')
  } finally {
    runtime.dispose()
  }
})
