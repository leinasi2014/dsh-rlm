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
        const rawLine = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        const line = rawLine.trim()
        if (!line) continue
        const frame = JSON.parse(line) as Frame
        // Test-only metadata: exact serialized JSONL wire bytes incl. the newline.
        ;(frame as Frame & { wireBytes?: number }).wireBytes = Buffer.byteLength(rawLine, 'utf8') + 1
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
    assert.equal(e.phase, 'query')
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

test('M1A Issue#5: a hostile metaclass __name__ is a typed error and the kernel survives', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nmarker = 5\nos.getpid()' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    const pid = Number(r1.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + r1.result)
    k.send({
      type: 'eval',
      id: 2,
      code: [
        'class Meta(type):',
        '    def __getattribute__(self, name):',
        '        if name == "__name__":',
        '            raise RuntimeError("name boom")',
        '        return super().__getattribute__(name)',
        'class Evil(Exception, metaclass=Meta):',
        '    pass',
        'raise Evil("boom")',
      ].join('\n'),
    })
    const e = await k.next(4000)
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'eval')
    assert.equal(e.kind, 'runtime_error')
    assert.equal(e.name, 'BaseException')
    assert.equal(e.message, 'boom')
    k.send({ type: 'eval', id: 3, code: 'import os\nmarker + 37' })
    const r2 = await k.next()
    assert.equal(r2.type, 'result')
    assert.equal(r2.result, '42')
    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const r3 = await k.next()
    assert.equal(r3.type, 'result')
    assert.equal(r3.result, String(pid))
    k.send({
      type: 'eval',
      id: 5,
      code: [
        'class Meta2(type):',
        '    def __getattribute__(self, name):',
        '        if name == "__name__":',
        '            raise RuntimeError("name boom 2")',
        '        return super().__getattribute__(name)',
        'class Evil2(Exception, metaclass=Meta2):',
        '    def __str__(self):',
        '        raise RuntimeError("str boom")',
        'raise Evil2("x")',
      ].join('\n'),
    })
    const e2 = await k.next()
    assert.equal(e2.type, 'error')
    assert.equal(e2.phase, 'eval')
    assert.equal(e2.kind, 'runtime_error')
    assert.equal(e2.name, 'BaseException')
    assert.equal(e2.message, 'BaseException')
    k.send({ type: 'eval', id: 6, code: 'marker' })
    const r4 = await k.next()
    assert.equal(r4.type, 'result')
    assert.equal(r4.result, '5')
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
        err instanceof RlmError && err.kind === 'query' && /model down/.test(err.message),
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
  const ctl = new AbortController()
  const m = makeMockCtx({ queryText: 'four' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  const exec = { agent: { id: 'sess-a' }, signal: ctl.signal }

  try {
    const out = await tool.execute({ code: 't = await rlm_query("what is 2+2?")\nt + "!"' }, exec)

    assert.equal(out.result, 'four!')
    assert.equal(m.starts.length, 1)
    const { provider, request } = m.starts[0]
    assert.equal(provider, 'spawn')
    assert.equal(request.label, 'rlm query')
    assert.equal(request.parent.id, 'sess-a')
    // Issue #4: the child receives the cell's merged cancellation signal, not
    // the raw exec.signal. The cell-owned controller is torn down as part of
    // normal settlement (cleanup barrier), so by the time the child is
    // disposed the merged signal is terminal.
    assert.notEqual(request.signal, exec.signal)
    assert.ok(request.signal instanceof AbortSignal)
    assert.equal(request.signal.aborted, true)
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

// ---- M2 Issue #3: bounded wire / channel limits ----

test('M2 Issue#3: a giant no-newline frame from the kernel is a protocol fault and evicts the kernel', async () => {
  const runtime = rt({ timeout: 4000 })
  try {
    const pidOut = await runtime.eval('giant-nl', { code: 'import os\nos.getpid()' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)
    await assert.rejects(
      runtime.eval('giant-nl', {
        code: [
          'import sys',
          'sys.__stdout__.write("a" * (256 * 1024 + 1))',
          'sys.__stdout__.flush()',
          'import time',
          'time.sleep(60)',
        ].join('\n'),
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'protocol',
    )
    const gone = await waitForPidGone(pid)
    assert.ok(gone, 'giant no-newline frame left kernel pid ' + pid + ' alive')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: kernel stderr over 64KiB is capped in the error detail and marked truncated', async () => {
  const runtime = rt()
  try {
    await assert.rejects(
      runtime.eval('stderr-cap', {
        code: [
          'import sys',
          'sys.stderr.write("e" * (64 * 1024 * 2))',
          'sys.stderr.flush()',
          'import os',
          'os._exit(1)',
        ].join('\n'),
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError)
        assert.equal(err.kind, 'closed')
        const detailed = (err as RlmError).detailed ?? ''
        // The truncation marker counts inside the 64 KiB stderr budget: the
        // final detailed string (prefix + " [stderr truncated]") must never
        // exceed 64 KiB in total.
        assert.ok(
          Buffer.byteLength(detailed, 'utf8') <= 64 * 1024,
          'stderr detail with marker is not bounded: ' + Buffer.byteLength(detailed, 'utf8') + ' bytes',
        )
        assert.ok(detailed.includes('[stderr truncated]'), 'stderr detail lacks a truncation marker')
        return true
      },
    )
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: an over-size rlm_query prompt is a typed query error and never invokes the handler', async () => {
  const runtime = rt()
  let called = 0
  try {
    await assert.rejects(
      runtime.eval('prompt-cap', {
        code: 'await rlm_query("x" * (64 * 1024 + 1))',
        onQuery: async () => {
          called += 1
          return 'unexpected'
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError)
        assert.equal(err.kind, 'query')
        assert.match(err.message, /prompt/i)
        return true
      },
    )
    assert.equal(called, 0, 'onQuery must not be called for an over-size prompt')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: an over-size multibyte query result is truncated code-point-safely and the kernel continues', async () => {
  const runtime = rt()
  try {
    const pidOut = await runtime.eval('qr-cap', { code: 'import os\npid = os.getpid()\nmarker = 1\npid' })
    const pid = Number(pidOut.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidOut.result)
    let called = 0
    const out = await runtime.eval('qr-cap', {
      code: [
        'text = await rlm_query("size")',
        'n = len(text.encode("utf-8"))',
        'bad = "\\ufffd" in text',
        'f"{n}|{bad}"',
      ].join('\n'),
      onQuery: async () => {
        called += 1
        return '中'.repeat(64 * 1024)
      },
    })
    assert.equal(called, 1)
    assert.equal(out.truncated, true, 'over-size query result must be reported as truncated')
    const [nStr, badStr] = (out.result ?? '').split('|')
    const n = Number(nStr)
    assert.ok(
      Number.isInteger(n) && n <= 64 * 1024,
      'query result text byte length not capped: ' + out.result,
    )
    assert.equal(badStr, 'False', 'query result truncation introduced U+FFFD: ' + out.result)
    const cont = await runtime.eval('qr-cap', { code: 'marker' })
    assert.equal(cont.result, '1')
    const pidAgain = await runtime.eval('qr-cap', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: Python inbound giant no-newline frame fatals the kernel nonzero', async () => {
  const k = new Kernel()
  await ready(k)
  try {
    // Send strictly more than 256 KiB and no newline so the kernel reader must
    // trip its own framing bound and fatal instead of buffering forever.
    k.child.stdin.write('x'.repeat(256 * 1024 + 1))
    const code = await Promise.race([
      k.exit,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('kernel did not fatal on a giant no-newline inbound frame')),
          5000,
        ),
      ),
    ])
    assert.notEqual(code, 0, 'expected the Python kernel to exit nonzero')
    assert.match(k.stderr, /(frame|protocol|256 ?KiB)/i)
  } finally {
    try {
      k.child.stdin.end()
    } catch {
      // ignore
    }
    await k.exit.catch(() => {})
  }
})

test('M2 Issue#3: host outbound giant eval frame is a protocol error and preserves the kernel', async () => {
  const runtime = rt()
  try {
    const seed = await runtime.eval('out-cap', { code: 'import os\npid = os.getpid()\nmarker = 23\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    const bigCode = 'x'.repeat(300 * 1024)
    await assert.rejects(
      runtime.eval('out-cap', { code: bigCode }),
      (err: unknown) =>
        err instanceof RlmError
          && err.kind === 'protocol'
          && /frame/i.test(err.message)
          && /256 ?KiB/i.test(err.message),
    )
    const ret = await runtime.eval('out-cap', { code: 'marker' })
    assert.equal(ret.result, '23')
    const pidAgain = await runtime.eval('out-cap', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})



test('M2 Issue#3: query rejection bounds message and detailed and preserves the kernel', async () => {
  const runtime = rt()
  try {
    const seed = await runtime.eval('q-reject-cap', { code: 'import os\npid = os.getpid()\nmarker = 7\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    await assert.rejects(
      runtime.eval('q-reject-cap', {
        code: 'await rlm_query("q")',
        onQuery: async () => {
          const err = new Error('错'.repeat(64 * 1024))
          ;(err as { detail?: string }).detail = '详'.repeat(64 * 1024)
          throw err
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError, 'expected a typed RlmError')
        const r = err as RlmError
        const message = r.message
        assert.ok(
          Buffer.byteLength(message, 'utf8') <= 64 * 1024 + 256,
          'error message not bounded: ' + Buffer.byteLength(message, 'utf8') + ' bytes',
        )
        assert.ok(message.includes('[query error truncated]'), 'error message lacks [query error truncated]')
        assert.ok(!message.includes('\uFFFD'), 'error message contains U+FFFD')
        const detailed = r.detailed ?? ''
        assert.ok(
          Buffer.byteLength(detailed, 'utf8') <= 64 * 1024 + 256,
          'error detailed not bounded: ' + Buffer.byteLength(detailed, 'utf8') + ' bytes',
        )
        assert.ok(detailed.includes('[query error truncated]'), 'error detailed lacks [query error truncated]')
        assert.ok(!detailed.includes('\uFFFD'), 'error detailed contains U+FFFD')
        return true
      },
    )
    const ret = await runtime.eval('q-reject-cap', { code: 'marker' })
    assert.equal(ret.result, '7')
    const pidAgain = await runtime.eval('q-reject-cap', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: Python outbound serialized frames fit the 256 KiB wire budget', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'import os\nos.getpid()' })
    const pidFrame = await k.next()
    assert.equal(pidFrame.type, 'result')
    const pid = Number(pidFrame.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + pidFrame.result)

    k.send({
      type: 'eval',
      id: 2,
      code: 'import sys\nsys.stdout.write("\\x01" * (64 * 1024))\n"\\x01" * (64 * 1024)',
    })
    const r = await k.next()
    assert.equal(r.type, 'result')
    const wire = (r as Frame & { wireBytes?: number }).wireBytes as number
    assert.ok(wire <= 256 * 1024, 'result frame wire bytes exceed 256 KiB: ' + wire)
    assert.equal(r.truncated, true, 'result frame must be marked truncated when fields are shrunk')
    assert.ok(Buffer.byteLength(String(r.stdout), 'utf8') <= 64 * 1024, 'result stdout not bounded')
    assert.ok(Buffer.byteLength(String(r.result), 'utf8') <= 64 * 1024, 'result result not bounded')
    assert.ok(!String(r.stdout).includes('\uFFFD'), 'result stdout contains U+FFFD')
    assert.ok(!String(r.result).includes('\uFFFD'), 'result result contains U+FFFD')

    k.send({
      type: 'eval',
      id: 3,
      code: [
        'class Boom(Exception):',
        '    pass',
        'e = Boom("错" * (64 * 1024))',
        'e.detail = "详" * (64 * 1024)',
        'raise e',
      ].join('\n'),
    })
    const e = await k.next()
    assert.equal(e.type, 'error')
    const ewire = (e as Frame & { wireBytes?: number }).wireBytes as number
    assert.ok(ewire <= 256 * 1024, 'error frame wire bytes exceed 256 KiB: ' + ewire)
    const emsg = String(e.message ?? '')
    const edet = String(e.detail ?? '')
    assert.ok(Buffer.byteLength(emsg, 'utf8') <= 64 * 1024 + 256, 'error message not bounded')
    assert.ok(Buffer.byteLength(edet, 'utf8') <= 64 * 1024 + 256, 'error detail not bounded')
    assert.ok(
      e.truncated === true || emsg.includes('[error truncated]') || edet.includes('[error truncated]'),
      'error frame not marked truncated',
    )
    assert.ok(!emsg.includes('\uFFFD') && !edet.includes('\uFFFD'), 'error frame contains U+FFFD')

    k.send({ type: 'eval', id: 4, code: 'import os\nos.getpid()' })
    const pidAgain = await k.next()
    assert.equal(Number(pidAgain.result), pid, 'kernel PID changed after capped outbound frames')
  } finally {
    await k.close()
  }
})

test('M2 Issue#3: an error frame with non-shrinkable oversized metadata makes progress or fatals', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    // A runtime-constructed exception whose class __name__ is ~300 KiB lands in
    // the error frame's `name` field, which the kernel's adaptive shrink loop
    // does not treat as shrinkable; the only shrinkable text field (message
    // "x") is already at its 1-byte floor. A shrink loop that cannot make
    // progress would spin forever instead of sending a bounded error frame or
    // fatalling, so the test owns its own short deadline and kills the child.
    k.send({
      type: 'eval',
      id: 1,
      code: 'E = type("E" * 300000, (Exception,), {})\nraise E("x")',
    })
    const outcome = await Promise.race([
      k.next(5000).then((f): { kind: 'frame'; f: Frame } => ({ kind: 'frame', f })),
      k.exit.then((code): { kind: 'exit'; code: number | null } => ({ kind: 'exit', code })),
    ])
    if (outcome.kind === 'exit') {
      assert.notEqual(outcome.code, 0, 'a kernel self-fatal must exit nonzero')
    } else {
      assert.equal(outcome.f.type, 'error')
      const wire = (outcome.f as Frame & { wireBytes?: number }).wireBytes as number
      assert.ok(wire <= 256 * 1024, 'error frame wire bytes exceed 256 KiB: ' + wire)
      // Recoverable typed error: the same kernel must keep serving.
      k.send({ type: 'eval', id: 2, code: '1 + 1' })
      const r = await k.next(5000)
      assert.equal(r.type, 'result')
      assert.equal(r.result, '2')
    }
  } finally {
    try {
      k.child.kill()
    } catch {
      // already dead
    }
    await k.exit.catch(() => {})
  }
})

test('M2 Issue#3: a control-character query result is shrunk to the wire budget instead of protocol-killing', async () => {
  const runtime = rt({ timeout: 5000 })
  try {
    const seed = await runtime.eval('ctrl-result', { code: 'import os\npid = os.getpid()\nmarker = 3\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    // 64 KiB of U+0001: the raw UTF-8 payload is NOT over the 64 KiB payload
    // cap, but JSON.stringify escapes every control char to 6 bytes, so the
    // serialized query_result line would be ~384 KiB. The host must shrink by
    // the real JSONL wire budget (code-point-safe, explicit truncated) instead
    // of tripping the central outbound guard into a protocol kill/evict.
    const out = await runtime.eval('ctrl-result', {
      code: [
        'text = await rlm_query("ctrl")',
        'n = len(text.encode("utf-8"))',
        'bad = "\\ufffd" in text',
        'f"{n}|{bad}"',
      ].join('\n'),
      onQuery: async () => '\u0001'.repeat(64 * 1024),
    })
    assert.equal(out.truncated, true, 'wire-shrunk control-char result must be marked truncated')
    const [nStr, badStr] = (out.result ?? '').split('|')
    const n = Number(nStr)
    assert.ok(
      Number.isInteger(n) && n <= 64 * 1024,
      'control-char result byte length not capped: ' + out.result,
    )
    assert.equal(badStr, 'False', 'control-char result contains U+FFFD')
    // The cell must have SUCCEEDED (not a protocol kill/evict), so the same
    // session kernel still owns the same PID and globals.
    const cont = await runtime.eval('ctrl-result', { code: 'marker' })
    assert.equal(cont.result, '3')
    const pidAgain = await runtime.eval('ctrl-result', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: kernel stdout JSONL uses LF-only line delimiters on Windows', async () => {
  const child = spawn(pythonCmd, [kernelPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  let raw = Buffer.alloc(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const delimiter = await new Promise<{ index: number; precededByCR: boolean }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('no LF delimiter in kernel stdout within 5s')), 5000)
      const onData = (d: Buffer): void => {
        raw = Buffer.concat([raw, d])
        const i = raw.indexOf(0x0a)
        if (i < 0) return
        clearTimeout(timer)
        child.stdout.removeListener('data', onData)
        resolve({ index: i, precededByCR: raw[i - 1] === 0x0d })
      }
      child.stdout.on('data', onData)
    })
    assert.ok(delimiter.index > 0, 'no line delimiter found in kernel stdout')
    assert.equal(
      delimiter.precededByCR,
      false,
      'kernel stdout writes CRLF line endings; JSONL must use LF-only delimiters',
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    child.kill()
    await new Promise((r) => child.on('close', r))
  }
})

test('M2 Issue#3: host counts the untrimmed raw line, so a whitespace-padded ready frame is a protocol fault', async () => {
  const runtime = rt({ timeout: 4000 })
  try {
    await withPressedKernel(
      [
        'import sys, json, time',
        // Content before CR is exactly MAX_FRAME_BYTES - 1 = 262143 bytes:
        // valid ready JSON plus trailing spaces, then a CRLF terminator (real
        // wire 262145 bytes). The write is split into two deliveries with a
        // gap: the first 250000 bytes carry no newline (the no-newline buffer
        // guard allows it), and the second delivery carries the remaining
        // content plus CRLF, so onData sees the newline in a later data event
        // and reaches the trim-then-count path. The host must count the
        // untrimmed raw line and reject before ever accepting ready.
        'payload = json.dumps({"type": "ready", "version": 1, "python": "x"}).encode("utf-8")',
        'content = payload + b" " * (262143 - len(payload))',
        'sys.stdout.buffer.write(content[:250000])',
        'sys.stdout.buffer.flush()',
        'time.sleep(0.1)',
        'sys.stdout.buffer.write(content[250000:] + b"\\r\\n")',
        'sys.stdout.buffer.flush()',
        // If the host wrongly accepts the ready frame, serve its eval with a
        // result so the acceptance is observable as a successful eval.
        'for raw in sys.stdin.buffer:',
        '    try:',
        '        frame = json.loads(raw.decode("utf-8"))',
        '    except Exception:',
        '        break',
        '    if frame.get("type") != "eval":',
        '        break',
        '    sys.stdout.buffer.write(json.dumps({"type": "result", "id": frame.get("id"), "stdout": "", "result": "11", "truncated": False}).encode("utf-8") + b"\\n")',
        '    sys.stdout.buffer.flush()',
      ].join('\n'),
      async (pidFile) => {
        const pending = runtime.eval('raw-line-cap', { code: '1' })
        const rejection = assert.rejects(
          pending,
          (err: unknown) =>
            err instanceof RlmError && err.kind === 'protocol' && /frame/i.test(err.message),
        )
        const pid = await waitForPidFile(pidFile)
        await rejection
        const gone = await waitForPidGone(pid)
        assert.ok(gone, 'whitespace-padded kernel pid ' + pid + ' survived the raw-line protocol fault')
      },
    )
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: an exact 256 KiB no-newline inbound line fatals the kernel while the writer stays open', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    // Exactly MAX_FRAME_BYTES bytes with no newline and stdin left open:
    // readline(MAX + 1) would wait for the 262145th byte, so the kernel must
    // instead detect the bound itself and fatal within a short deadline.
    k.child.stdin.write('x'.repeat(256 * 1024))
    const code = await Promise.race([
      k.exit,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('kernel did not fatal on an exact-256KiB newline-less inbound frame')),
          5000,
        ),
      ),
    ])
    assert.notEqual(code, 0, 'expected the Python kernel to exit nonzero')
    assert.match(k.stderr, /(frame|protocol|256 ?KiB)/i)
  } finally {
    try {
      k.child.kill()
    } catch {
      // already dead
    }
    await k.exit.catch(() => {})
  }
})


test('M2 Issue#3: a control-character query rejection is a typed query error with truncated=true and no protocol kill', async () => {
  const runtime = rt({ timeout: 5000 })
  try {
    const seed = await runtime.eval('qerr-ctrl', { code: 'import os\npid = os.getpid()\nmarker = 9\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    await assert.rejects(
      runtime.eval('qerr-ctrl', {
        code: 'await rlm_query("q")',
        onQuery: async () => {
          const err = new Error('\u0001'.repeat(64 * 1024))
          ;(err as { detail?: string }).detail = '\u0001'.repeat(64 * 1024)
          throw err
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError, 'expected a typed RlmError, got ' + String(err))
        const r = err as RlmError
        assert.equal(r.kind, 'query', 'a query rejection must surface as RlmError kind=query')
        assert.equal(r.truncated, true, 'wire-fitted query error must be marked truncated')
        assert.ok(Buffer.byteLength(r.message, 'utf8') <= 64 * 1024, 'error message not bounded')
        assert.ok(Buffer.byteLength(r.detailed ?? '', 'utf8') <= 64 * 1024, 'error detailed not bounded')
        assert.ok(!r.message.includes('\uFFFD'), 'error message contains U+FFFD')
        assert.ok(!(r.detailed ?? '').includes('\uFFFD'), 'error detailed contains U+FFFD')
        return true
      },
    )
    const cont = await runtime.eval('qerr-ctrl', { code: 'marker' })
    assert.equal(cont.result, '9')
    const pidAgain = await runtime.eval('qerr-ctrl', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: host onError surfaces frame.truncated and stable JSON text for structured detail', async () => {
  const runtime = rt()
  try {
    const seed = await runtime.eval('onerr', { code: 'import os\npid = os.getpid()\nmarker = 5\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    await assert.rejects(
      runtime.eval('onerr', {
        code: 'e = RuntimeError("x" * (64 * 1024 + 1))\ne.detail = [1, 2, 3]\nraise e',
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError)
        const r = err as RlmError
        assert.equal(r.truncated, true, 'frame.truncated must propagate to RlmError')
        assert.equal(r.detailed, '[1,2,3]', 'structured detail must keep stable JSON text')
        return true
      },
    )
    await assert.rejects(
      runtime.eval('onerr', {
        code: 'e = RuntimeError("boom")\ne.detail = {"code": "x"}\nraise e',
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError)
        assert.equal((err as RlmError).detailed, '{"code":"x"}', 'object detail must keep stable JSON text')
        return true
      },
    )
    const cont = await runtime.eval('onerr', { code: 'marker' })
    assert.equal(cont.result, '5')
    const pidAgain = await runtime.eval('onerr', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: rlm_eval tool failure carries the bounded detailed and a truncation hint', async () => {
  const m = makeMockCtx()
  const hostile = Object.assign(new Error('\u0001'.repeat(64 * 1024)), {
    detail: '\u0001'.repeat(64 * 1024),
  })
  m.run.result = Promise.reject(hostile)
  // The real kernel round-trip attaches the await on `run.result` only after
  // the query frame arrives, so mark the rejection handled immediately to keep
  // it from surfacing as an unhandled rejection; the awaited rejection is
  // unaffected because a promise can serve any number of consumers.
  m.run.result.catch(() => {})
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  try {
    await assert.rejects(
      tool.execute({ code: 'await rlm_query("q")' }, makeExec('sess-tool-qerr')),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        const msg = err.message
        assert.match(msg, /rlm_eval failed \((query|eval)\):/, 'tool error must keep the typed kind')
        assert.ok(msg.includes('Detail:'), 'tool error must include the bounded query detailed')
        assert.ok(
          msg.includes('[query error truncated]') || msg.includes('[truncated]'),
          'tool error must include a truncation hint',
        )
        assert.ok(
          Buffer.byteLength(msg, 'utf8') <= 64 * 1024 + 256,
          'tool error message is not bounded: ' + Buffer.byteLength(msg, 'utf8') + ' bytes',
        )
        return true
      },
    )
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#3: hostile query rejection with throwing detail getters still yields a typed error promptly', async () => {
  const runtime = rt({ timeout: 4000 })
  try {
    const seed = await runtime.eval('hostile-q', { code: 'import os\npid = os.getpid()\nmarker = 4\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    // Variant A: detail/detailed getters throw on access.
    const evil = new Error('boom-getter')
    Object.defineProperty(evil, 'detail', { get() { throw new Error('detail getter boom') } })
    Object.defineProperty(evil, 'detailed', { get() { throw new Error('detailed getter boom') } })
    const startA = Date.now()
    await assert.rejects(
      runtime.eval('hostile-q', {
        code: 'await rlm_query("q")',
        onQuery: async () => {
          throw evil
        },
      }),
      (err: unknown) => err instanceof RlmError && /boom-getter/.test(err.message),
    )
    assert.ok(Date.now() - startA < 4000, 'hostile getter must not hang until the cell timeout')
    // Variant B: toString throws, no detail attributes at all.
    const evilB = new Error('boom-tostring')
    ;(evilB as { toString: () => string }).toString = () => {
      throw new Error('toString boom')
    }
    await assert.rejects(
      runtime.eval('hostile-q', {
        code: 'await rlm_query("q")',
        onQuery: async () => {
          throw evilB
        },
      }),
      (err: unknown) => err instanceof RlmError && /boom-tostring/.test(err.message),
    )
    const cont = await runtime.eval('hostile-q', { code: 'marker' })
    assert.equal(cont.result, '4')
    const pidAgain = await runtime.eval('hostile-q', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#3: oversized lone-surrogate detail keeps real U+D800 code units after truncation', async () => {
  const runtime = rt()
  try {
    const seed = await runtime.eval('sur-detail', { code: 'import os\npid = os.getpid()\nmarker = 2\npid' })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    await assert.rejects(
      runtime.eval('sur-detail', {
        code: 'e = RuntimeError("boom")\ne.detail = chr(0xD800) * (64 * 1024 + 1)\nraise e',
      }),
      (err: unknown) => {
        assert.ok(err instanceof RlmError, 'expected a typed RlmError')
        const r = err as RlmError
        const d = r.detailed ?? ''
        assert.ok(d.includes('\uD800'), 'detail must keep real U+D800 code units, not literal \\ud800 text')
        assert.ok(!d.includes('\\ud800'), 'detail must not degrade to literal \\ud800 fragments')
        assert.ok(!d.includes('\uFFFD'), 'detail must not contain U+FFFD')
        assert.equal(r.truncated, true, 'truncated surrogate detail must be marked truncated')
        assert.ok(
          Buffer.byteLength(d, 'utf8') <= 64 * 1024 + 512,
          'surrogate detail is not bounded: ' + Buffer.byteLength(d, 'utf8') + ' bytes',
        )
        return true
      },
    )
    const cont = await runtime.eval('sur-detail', { code: 'marker' })
    assert.equal(cont.result, '2')
    const pidAgain = await runtime.eval('sur-detail', { code: 'import os\nos.getpid()' })
    assert.equal(pidAgain.result, String(pid))
  } finally {
    runtime.dispose()
  }
})

// ---- M2 Issue #4: one-shot child lifecycle, cleanup barrier, late-event isolation ----

/** A manually-settled promise (deterministic latch: no wall-clock sleeps for control). */
class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (reason: unknown) => void
  private settled = false
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (value: T) => { if (!this.settled) { this.settled = true; res(value) } }
      this.reject = (reason: unknown) => { if (!this.settled) { this.settled = true; rej(reason) } }
    })
  }
  isSettled(): boolean { return this.settled }
}

/** Event-pump microtask/macrotask queues without wall-clock sleeps. */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Poll a condition on the event loop (bounded wall clock only as a safety net). */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition was not met within the bound')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

interface LifecycleRun {
  result: Deferred<{ output: { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>
  disposed: boolean
  signal: AbortSignal
}

interface LifecycleMock {
  ctx: any
  registered: any[]
  starts: { provider: string; request: any; run: LifecycleRun }[]
  teardown: (() => void) | undefined
}

/**
 * Plugin mock whose subagent provider follows the published dsh-subagent
 * contract: the request signal is the canonical cancellation channel, so an
 * abort settles the run with `stopReason: 'aborted'`, and `dispose` is the
 * holder's idempotent release. This makes lifecycle failures deterministic
 * without any real model call.
 */
function makeLifecycleMockCtx(options: {
  /** Pre-resolve each started run with this terminal result (e.g. empty text). */
  autoResult?: { output: { type: string; text?: string }[]; stopReason: string; diagnostic?: string }
  /** Make dispose settle after one macrotask hop so a missing cleanup barrier is observable. */
  disposeAsync?: boolean
} = {}): LifecycleMock {
  const registered: any[] = []
  const starts: { provider: string; request: any; run: LifecycleRun }[] = []
  const m: LifecycleMock = { ctx: undefined as any, registered, starts, teardown: undefined }
  m.ctx = {
    tools: {
      register(def: any) {
        registered.push(def)
        return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1) }
      },
    },
    subagents: {
      async start(provider: string, request: any) {
        const result = new Deferred<{ output: { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>()
        const run: LifecycleRun = { result, disposed: false, signal: request.signal }
        request.signal.addEventListener('abort', () => {
          if (!result.isSettled()) result.resolve({ output: [], stopReason: 'aborted', diagnostic: 'cancelled' })
        }, { once: true })
        if (options.autoResult && !result.isSettled()) result.resolve(options.autoResult)
        starts.push({ provider, request, run })
        return {
          result: result.promise,
          dispose: async () => {
            if (options.disposeAsync) await new Promise<void>((resolve) => setImmediate(resolve))
            run.disposed = true
          },
        }
      },
    },
    effect(execute: () => () => void, effectLabel: string) {
      m.teardown = execute()
    },
  }
  return m
}

test('M2 Issue#4: a cell timeout aborts and disposes the active one-shot child before the tool settles', async () => {
  const m = makeLifecycleMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, timeout: 1500 })
  const tool = m.registered[0]
  try {
    const pending = tool.execute(
      { code: 'x = await rlm_query("q")\nx' },
      makeExec('sess-timeout-child'),
    )
    await until(() => m.starts.length === 1)
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /timeout/.test(err.message),
    )
    assert.equal(m.starts[0].run.signal.aborted, true, 'child signal must be aborted by the cell timeout')
    assert.equal(m.starts[0].run.disposed, true, 'child must be disposed before the tool settles after a timeout')
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: plugin teardown aborts and disposes the active one-shot child before the tool settles', async () => {
  const m = makeLifecycleMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  try {
    const pending = tool.execute(
      { code: 'x = await rlm_query("q")\nx' },
      makeExec('sess-teardown-child'),
    )
    await until(() => m.starts.length === 1)
    const unload = m.teardown! as unknown as () => Promise<void>
    const barrier = unload()
    assert.equal(barrier instanceof Promise, true, 'plugin unload must return an awaitable disposal barrier')
    await barrier
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /cancel/.test(err.message),
    )
    assert.equal(m.starts[0].run.signal.aborted, true, 'child signal must be aborted by plugin teardown')
    assert.equal(m.starts[0].run.disposed, true, 'child must be disposed before the tool settles after teardown')
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: a kernel protocol fault leaves no active one-shot child behind', async () => {
  const m = makeLifecycleMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, timeout: 8000 })
  const tool = m.registered[0]
  try {
    const code = [
      'import asyncio, sys',
      'async def corrupt():',
      '    sys.__stdout__.write("this is not json\\n")',
      '    sys.__stdout__.flush()',
      'asyncio.create_task(corrupt())',
      'x = await rlm_query("q")',
      'x',
    ].join('\n')
    await assert.rejects(
      tool.execute({ code }, makeExec('sess-protocol-child')),
      (err: unknown) => err instanceof Error && /protocol/.test(err.message),
    )
    await tick(10)
    assert.ok(
      m.starts.every((s) => s.run.disposed),
      'a one-shot child survived the protocol fault (token leak)',
    )
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: kernel exit aborts and disposes the active one-shot child', async () => {
  const m = makeLifecycleMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, timeout: 8000 })
  const tool = m.registered[0]
  try {
    const code = [
      'import asyncio, os',
      'async def bye():',
      '    await asyncio.sleep(0)',
      '    os._exit(1)',
      'asyncio.create_task(bye())',
      'x = await rlm_query("q")',
      'x',
    ].join('\n')
    const pending = tool.execute({ code }, makeExec('sess-exit-child'))
    await until(() => m.starts.length === 1)
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /(closed|protocol|kernel exited)/.test(err.message),
    )
    assert.equal(m.starts[0].run.signal.aborted, true, 'child signal must be aborted by kernel exit')
    assert.equal(m.starts[0].run.disposed, true, 'child must be disposed after kernel exit')
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: caller cancel disposes the active one-shot child before the tool settles', async () => {
  const m = makeLifecycleMockCtx({ disposeAsync: true })
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  const ctl = new AbortController()
  try {
    const exec = { agent: { id: 'sess-cancel-child' }, signal: ctl.signal }
    const pending = tool.execute({ code: 'x = await rlm_query("q")\nx' }, exec)
    await until(() => m.starts.length === 1)
    ctl.abort('user-cancel')
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /cancel/.test(err.message),
    )
    assert.equal(m.starts[0].run.signal.aborted, true, 'child signal must observe the caller cancel')
    assert.equal(m.starts[0].run.disposed, true, 'child must be disposed before the tool settles after cancel')
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: a completed child with no visible text is a typed query error (kind=query phase=query)', async () => {
  const m = makeLifecycleMockCtx({ autoResult: { output: [], stopReason: 'completed' } })
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  try {
    await assert.rejects(
      tool.execute(
        { code: 'x = await rlm_query("q")\n"got:" + x' },
        makeExec('sess-empty-text'),
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected the tool call to fail')
        assert.equal((err as { kind?: string }).kind, 'query', 'external query error must keep kind=query')
        assert.equal((err as { phase?: string }).phase, 'query', 'external query error must keep phase=query')
        assert.match(err.message, /no visible text/)
        return true
      },
    )
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#4: a late background query result cannot wake a terminated cell or kill the reused kernel', async () => {
  let bg: Deferred<string> | null = null
  const runtime = rt({ timeout: 8000 })
  try {
    const seed = await runtime.eval('late-bg', { code: 'import os\nmarker = 1\npid = os.getpid()\npid', timeout: 8000 })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    const pending = runtime.eval('late-bg', {
      code: [
        'import asyncio, sys',
        'async def ghost():',
        '    s = await rlm_query("bg")',
        '    sys.__stdout__.write("GHOST:" + s)',
        'asyncio.create_task(ghost())',
        'a = await rlm_query("main")',
        'a',
      ].join('\n'),
      timeout: 8000,
      onQuery: async (prompt: string, signal?: AbortSignal) => {
        if (prompt === 'bg') {
          const d = new Deferred<string>()
          bg = d
          signal?.addEventListener('abort', () => d.reject(new Error('bg cancelled')), { once: true })
          return d.promise
        }
        throw new Error('main fail')
      },
    })
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'query' && /main fail/.test(err.message),
    )
    // The background answer arrives only after the cell's terminal error.
    bg?.resolve('LATE')
    await tick(10)
    const cont = await runtime.eval('late-bg', { code: 'marker + 1', timeout: 8000 })
    assert.equal(cont.result, '2', 'late background query polluted the next cell')
    const pidAgain = await runtime.eval('late-bg', { code: 'import os\nos.getpid()', timeout: 8000 })
    assert.equal(pidAgain.result, String(pid), 'late background query killed the reused kernel')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#4: the kernel drops a late response for a terminated cell query instead of waking an orphan', async () => {
  const k = new Kernel()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-ghost-'))
  const ghostFile = path.join(dir, 'ghost.txt')
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'import asyncio',
        'async def ghost():',
        '    s = await rlm_query("bg")',
        '    open(' + JSON.stringify(ghostFile) + ', "w").write("GHOST:" + s)',
        'asyncio.create_task(ghost())',
        'x = await rlm_query("main")',
        'x',
      ].join('\n'),
    })
    const q1 = await k.next()
    assert.equal(q1.type, 'query')
    const q2 = await k.next()
    assert.equal(q2.type, 'query')
    k.send({ type: 'error', id: k.id(q1), phase: 'query', kind: 'query_error', message: 'main boom' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    assert.equal(e.phase, 'query')
    // Late answer for the terminated cell's background query: must be dropped.
    k.send({ type: 'query_result', id: k.id(q2), text: 'LATE' })
    // The next eval result is the deterministic synchronization point: FIFO on
    // the kernel side guarantees the late frame was consumed before the next
    // cell ran, so the ghost-file check below is not a timing race.
    k.send({ type: 'eval', id: 2, code: 'marker = 1\n2 + 2' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, '4')
    assert.ok(!existsSync(ghostFile), 'late response woke an orphan background query into the namespace')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await k.close()
  }
})

test('M2 Issue#4: a concurrent eval during a fatal child-settlement window is rejected and the next eval is clean', async () => {
  const runtime = rt({ timeout: 8000 })
  const ctl = new AbortController()
  try {
    await runtime.eval('fatal-window', { code: 'import os\nmarker = 1\npid = os.getpid()\npid', timeout: 8000 })
    let started = false
    const gate = new Deferred<string>()
    const pending = runtime.eval('fatal-window', {
      code: 'x = await rlm_query("q")\nx',
      timeout: 8000,
      signal: ctl.signal,
      onQuery: async (_prompt: string, signal?: AbortSignal) => {
        started = true
        signal?.addEventListener('abort', () => {
          // Keep the cleanup barrier open for one macrotask so the settlement
          // window is observable from the test.
          setImmediate(() => gate.reject(new Error('child aborted')))
        }, { once: true })
        return gate.promise
      },
    })
    await until(() => started)
    ctl.abort('window-cancel')
    // Attach the cell-rejection expectation before the window probe so an
    // early rejection can never surface as an unhandled rejection that masks
    // the real assertion below.
    const pendingRejection = assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
    )
    // The terminal transition ran synchronously (settling), but the child
    // cleanup barrier is still open: a concurrent eval must NOT be admitted to
    // a replacement kernel while the old child quiesces.
    await assert.rejects(
      runtime.eval('fatal-window', { code: '2 + 2', timeout: 8000 }),
      (err: unknown) => err instanceof RlmError && (err.kind === 'closed' || err.kind === 'busy'),
    )
    await pendingRejection
    // After quiescence the evicted session gets a clean namespace.
    await assert.rejects(
      runtime.eval('fatal-window', { code: 'marker', timeout: 8000 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
    const clear = await runtime.eval('fatal-window', { code: '2 + 2', timeout: 8000 })
    assert.equal(clear.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M2 Issue#4: a concurrent eval during a live-kernel settlement window is rejected busy', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    await runtime.eval('live-settle', { code: 'marker = 1', timeout: 8000 })
    let mainStarted = false
    let bgStarted = false
    let bgAborted = false
    let settleBg: (() => void) | null = null
    const mainGate = new Deferred<string>()
    const pending = runtime.eval('live-settle', {
      code: [
        'import asyncio',
        'async def bg():',
        '    await rlm_query("bg")',
        'asyncio.create_task(bg())',
        'x = await rlm_query("main")',
        'x',
      ].join('\n'),
      timeout: 8000,
      onQuery: async (prompt: string, signal?: AbortSignal) => {
        if (prompt === 'main') {
          mainStarted = true
          return mainGate.promise
        }
        bgStarted = true
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            bgAborted = true
            // Hold the settlement window open until the test releases it.
            settleBg = () => reject(new Error('bg released'))
          }, { once: true })
        })
      },
    })
    await until(() => mainStarted && bgStarted)
    mainGate.reject(new Error('main fail'))
    // The cell error frame starts the live-kernel settlement with an open child
    // barrier; the window is observable via bgAborted.
    await until(() => bgAborted)
    await assert.rejects(
      runtime.eval('live-settle', { code: '2 + 2', timeout: 8000 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'busy',
    )
    settleBg?.()
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'query' && /main fail/.test(err.message),
    )
    const cont = await runtime.eval('live-settle', { code: 'marker + 1', timeout: 8000 })
    assert.equal(cont.result, '2', 'the live kernel must keep its globals after the settlement window')
  } finally {
    runtime.dispose()
  }
})



test('M2 Issue#4: reasoning-only output is a typed query error while whitespace text stays valid', async () => {
  const m1 = makeLifecycleMockCtx({ autoResult: { output: [{ type: 'reasoning', text: 'thinking' }], stopReason: 'completed' } })
  registerRlmPlugin(m1.ctx, { enabled: true })
  try {
    await assert.rejects(
      m1.registered[0].execute({ code: 'x = await rlm_query("q")\nx' }, makeExec('sess-reason-only')),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { kind?: string }).kind, 'query')
        assert.match(err.message, /no visible text/)
        return true
      },
    )
  } finally {
    m1.teardown?.()
  }
  const m2 = makeLifecycleMockCtx({ autoResult: { output: [{ type: 'text', text: '   ' }], stopReason: 'completed' } })
  registerRlmPlugin(m2.ctx, { enabled: true })
  try {
    const out = await m2.registered[0].execute(
      { code: 'x = await rlm_query("q")\n"got:" + x' },
      makeExec('sess-ws-text'),
    )
    assert.equal(out.result, 'got:   ', 'pure whitespace text remains ordinary visible text')
  } finally {
    m2.teardown?.()
  }
})

test('M2 Issue#4: a detached task from a retired cell cannot open a query into a later cell', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    // Cell 1 creates a detached task that only calls rlm_query AFTER cell 2
    // starts; ownership is fixed at create_task time (task-local token), so the
    // retired-cell token must reject the query without ever emitting a frame.
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'import asyncio',
        'async def late():',
        '    await asyncio.sleep(0.01)',
        '    try:',
        '        return await rlm_query("late")',
        '    except Exception:',
        '        return "retired"',
        'asyncio.create_task(late())',
        '"cell1"',
      ].join('\n'),
    })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    assert.equal(r1.result, 'cell1')
    k.send({
      type: 'eval',
      id: 2,
      code: 'await asyncio.sleep(0.05)\n"cell2"',
    })
    const r2 = await k.next()
    assert.equal(r2.type, 'result', 'the retired task must not emit a query frame into cell 2')
    assert.equal(r2.result, 'cell2')
  } finally {
    await k.close()
  }
})

test('M2 Issue#4: unknown, future, duplicate, and non-integer reply ids stay fatal protocol faults', async () => {
  const cases: { label: string; act: (k: Kernel) => Promise<void> | void }[] = [
    {
      label: 'non-integer string id',
      act: (k) => {
        k.send({ type: 'query_result', id: 'x', text: 'y' })
      },
    },
    {
      label: 'boolean id',
      act: (k) => {
        k.send({ type: 'query_result', id: true, text: 'y' })
      },
    },
    {
      label: 'unknown id',
      act: (k) => {
        k.send({ type: 'query_result', id: 999, text: 'y' })
      },
    },
    {
      label: 'future id',
      act: async (k) => {
        k.send({ type: 'eval', id: 1, code: 'x = await rlm_query("q")\nx' })
        const q = await k.next()
        assert.equal(q.type, 'query')
        k.send({ type: 'query_result', id: k.id(q) + 5, text: 'future' })
      },
    },
    {
      label: 'duplicate id of a retired cell',
      act: async (k) => {
        k.send({ type: 'eval', id: 1, code: 'x = await rlm_query("q")\nx' })
        const q = await k.next()
        assert.equal(q.type, 'query')
        k.send({ type: 'query_result', id: k.id(q), text: 'ok' })
        const r = await k.next()
        assert.equal(r.type, 'result')
        // The cell is retired now; a second response for the same qid is still
        // a protocol fault (duplicate), never a silent drop.
        k.send({ type: 'query_result', id: k.id(q), text: 'dup' })
      },
    },
  ]
  for (const c of cases) {
    const k = new Kernel()
    try {
      await ready(k)
      await c.act(k)
      const code = await Promise.race([
        k.exit,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('kernel did not fatal for ' + c.label)), 5000),
        ),
      ])
      assert.notEqual(code, 0, c.label + ' must terminate the kernel')
      assert.match(k.stderr, /(query id|response|duplicate|non-integer)/i)
    } finally {
      try {
        k.child.kill()
      } catch {
        // already dead
      }
      await k.exit.catch(() => {})
    }
  }
})

test('M2 Issue#4: a caught main query error keeps the cell active and a queued sibling reply still applies', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'import asyncio',
        'async def bg():',
        '    return await rlm_query("bg")',
        'task = asyncio.create_task(bg())',
        'try:',
        '    x = await rlm_query("main")',
        'except Exception:',
        '    x = "caught"',
        'await asyncio.sleep(0.02)',
        'x + "-" + task.result()',
      ].join('\n'),
    })
    const qMain = await k.next()
    assert.equal(qMain.type, 'query')
    const qBg = await k.next()
    assert.equal(qBg.type, 'query')
    // The main query fails; the user cell catches it. The sibling background
    // query is a legitimate response of the still-active cell and must apply.
    k.send({ type: 'error', id: k.id(qMain), phase: 'query', kind: 'query_error', message: 'main boom' })
    k.send({ type: 'query_result', id: k.id(qBg), text: 'TEXT' })
    const r = await k.next()
    assert.equal(r.type, 'result', 'a caught query error must not retire the cell or cancel sibling queries')
    assert.equal(r.result, 'caught-TEXT')
  } finally {
    await k.close()
  }
})

test('M2 Issue#4: after a caught first query error the same cell can issue and complete a second query', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'try:',
        '    first = await rlm_query("first")',
        'except Exception:',
        '    first = "caught"',
        'second = await rlm_query("second")',
        'second',
      ].join('\n'),
    })
    const q1 = await k.next()
    assert.equal(q1.type, 'query')
    assert.equal(q1.prompt, 'first')
    // The cell catches the first query error and proceeds: the kernel MUST
    // still emit the second query of the same cell (no eager retirement).
    k.send({ type: 'error', id: k.id(q1), phase: 'query', kind: 'query_error', message: 'first boom' })
    const q2 = await k.next()
    assert.equal(q2.type, 'query', 'the kernel must continue after a caught query error')
    assert.equal(q2.prompt, 'second')
    k.send({ type: 'query_result', id: k.id(q2), text: 'TWO' })
    const r = await k.next()
    assert.equal(r.type, 'result')
    assert.equal(r.result, 'TWO')
  } finally {
    await k.close()
  }
})
