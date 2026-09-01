import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
    await assert.rejects(
      runtime.eval('fresh', { code: 'import time\ntime.sleep(5)\nval = 1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
    await assert.rejects(
      runtime.eval('fresh', { code: 'val' }),
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

