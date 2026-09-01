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
