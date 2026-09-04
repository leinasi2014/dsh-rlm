import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.equal(frame.version, 4)
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

test('M8 Issue#39 RED: a live opaque handle routes only a later follow-up', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'h = await rlm_spawn("first child turn")\nrepr(h)' })
    const spawn = await k.next()
    assert.equal(spawn.type, 'spawn')
    assert.equal(spawn.prompt, 'first child turn')
    assert.equal(typeof spawn.capability, 'string')
    assert.ok(String(spawn.capability).length >= 32)
    assert.equal(spawn.child_id, undefined)
    k.send({ type: 'spawn_result', id: k.id(spawn) })
    const created = await k.next()
    assert.equal(created.type, 'result')
    assert.equal(created.result, '<rlm child handle>')
    k.send({ type: 'eval', id: 2, code: 'await rlm_followup(h, "second child turn")\n"parent continued"' })
    const followup = await k.next()
    assert.equal(followup.type, 'followup')
    assert.equal(followup.capability, spawn.capability)
    assert.equal(followup.child_id, undefined)
    assert.equal(followup.prompt, 'second child turn')
    k.send({ type: 'followup_result', id: k.id(followup) })
    const completed = await k.next()
    assert.equal(completed.type, 'result')
    assert.equal(completed.result, 'parent continued')
  } finally {
    await k.close()
  }
})

test('M8 Issue#39 successor RED: a cross-kind live response is a fatal protocol violation', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'await rlm_query("must remain text")' })
    const request = await k.next()
    assert.equal(request.type, 'query')
    k.send({ type: 'spawn_result', id: k.id(request), child_id: 'forged-child-id' })
    const exit = await Promise.race([
      k.exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('cross-kind response did not terminate kernel')), 2_000)),
    ])
    assert.notEqual(exit, 0)
  } finally {
    await k.close()
  }
})

test('M8 Issue#39 successor RED: Python introspection cannot read a raw child id', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    const rawChildId = 'raw-child-id-must-not-leak'
    k.send({ type: 'eval', id: 1, code: 'h = await rlm_spawn("conceal id")\nrepr(h)' })
    const spawn = await k.next()
    assert.equal(spawn.type, 'spawn')
    // Current candidate accepts this legacy raw-id reply; the successor must
    // ignore it and retain only a local opaque capability token.
    k.send({ type: 'spawn_result', id: k.id(spawn), child_id: rawChildId })
    const created = await k.next()
    assert.equal(created.type, 'result')
    k.send({ type: 'eval', id: 2, code: 'rlm_spawn.__self__._child_handles[h]' })
    const inspected = await k.next()
    assert.equal(inspected.type, 'result')
    assert.notEqual(inspected.result, rawChildId)
  } finally {
    await k.close()
  }
})

test('M7 Issue#36 RED: a batch admits four queries and returns ordered text', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    const prompts = ['zero', 'one', 'two', 'three', 'four', 'five']
    k.send({
      type: 'eval',
      id: 1,
      code: `await rlm_query_batched(${JSON.stringify(prompts)})`,
    })
    const first = await k.next()
    assert.equal(first.type, 'query')
    assert.equal(first.prompt, prompts[0])
    const initial = [first, await k.next(), await k.next(), await k.next()]
    assert.deepEqual(initial.map((frame) => frame.prompt), prompts.slice(0, 4))

    for (const index of [3, 2, 1, 0]) {
      k.send({ type: 'query_result', id: k.id(initial[index]), text: 'answer-' + index })
    }
    const tail = [await k.next(), await k.next()]
    assert.deepEqual(tail.map((frame) => frame.type), ['query', 'query'])
    assert.deepEqual(tail.map((frame) => frame.prompt), prompts.slice(4))
    for (const [offset, frame] of tail.entries()) {
      k.send({ type: 'query_result', id: k.id(frame), text: 'answer-' + (offset + 4) })
    }
    const result = await k.next()
    assert.equal(result.type, 'result')
    assert.equal(result.result, "['answer-0', 'answer-1', 'answer-2', 'answer-3', 'answer-4', 'answer-5']")
  } finally {
    await k.close()
  }
})

test('M7 Issue#36 successor: duplicate prompts retain distinct ordered result slots', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'await rlm_query_batched(["repeat", "repeat"])' })
    const queries = [await k.next(), await k.next()]
    assert.deepEqual(queries.map((frame) => frame.prompt), ['repeat', 'repeat'])
    assert.notEqual(k.id(queries[0]), k.id(queries[1]), 'equal prompt text must still create independent bridge requests')
    k.send({ type: 'query_result', id: k.id(queries[1]), text: 'second' })
    k.send({ type: 'query_result', id: k.id(queries[0]), text: 'first' })
    const result = await k.next()
    assert.equal(result.type, 'result')
    assert.equal(result.result, "['first', 'second']")
  } finally {
    await k.close()
  }
})

test('M7 Issue#36: caller cancellation drains admitted batch queries before re-raising', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'batch = asyncio.create_task(rlm_query_batched(["left", "right"]))',
        'await asyncio.sleep(0)',
        'batch.cancel()',
        'try:',
        '    await batch',
        'except asyncio.CancelledError:',
        '    outcome = "cancelled after drain"',
        'outcome',
      ].join('\n'),
    })
    const queries = [await k.next(), await k.next()]
    assert.deepEqual(queries.map((frame) => frame.type), ['query', 'query'])
    for (const frame of queries) k.send({ type: 'query_result', id: k.id(frame), text: 'late reply' })
    const result = await k.next()
    assert.equal(result.type, 'result')
    assert.equal(result.result, 'cancelled after drain')
    k.send({ type: 'eval', id: 2, code: '6 * 7' })
    const next = await k.next()
    assert.equal(next.type, 'result')
    assert.equal(next.result, '42')
  } finally {
    await k.close()
  }
})

test('M7 Issue#36 successor: asyncio.wait_for cancellation drains admitted queries before the timeout is caught', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({
      type: 'eval',
      id: 1,
      code: [
        'batch = asyncio.create_task(rlm_query_batched(["left", "right"]))',
        'await asyncio.sleep(0)',
        'try:',
        '    await asyncio.wait_for(batch, timeout=0.01)',
        'except asyncio.TimeoutError:',
        '    outcome = "wait_for after drain"',
        'outcome',
      ].join('\n'),
    })
    const queries = [await k.next(), await k.next()]
    assert.deepEqual(queries.map((frame) => frame.type), ['query', 'query'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (const frame of queries) k.send({ type: 'query_result', id: k.id(frame), text: 'late reply' })
    const result = await k.next()
    assert.equal(result.type, 'result')
    assert.equal(result.result, 'wait_for after drain')
    k.send({ type: 'eval', id: 2, code: '7 * 6' })
    const next = await k.next()
    assert.equal(next.type, 'result')
    assert.equal(next.result, '42')
  } finally {
    await k.close()
  }
})

test('M7 Issue#36: reverse-completion failures drain and surface the lowest input index', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'await rlm_query_batched(["0", "1", "2", "3", "not-admitted"])' })
    const initial = [await k.next(), await k.next(), await k.next(), await k.next()]
    assert.deepEqual(initial.map((frame) => frame.prompt), ['0', '1', '2', '3'])
    k.send({ type: 'error', id: k.id(initial[3]), phase: 'query', kind: 'query_error', message: 'failure-3' })
    k.send({ type: 'error', id: k.id(initial[1]), phase: 'query', kind: 'query_error', message: 'failure-1' })
    k.send({ type: 'query_result', id: k.id(initial[2]), text: 'two' })
    k.send({ type: 'query_result', id: k.id(initial[0]), text: 'zero' })
    const error = await k.next()
    assert.equal(error.type, 'error')
    assert.equal(error.phase, 'query')
    assert.equal(error.kind, 'query_error')
    assert.equal(error.message, 'failure-1')
    k.send({ type: 'eval', id: 2, code: '3 * 9' })
    const next = await k.next()
    assert.equal(next.type, 'result')
    assert.equal(next.result, '27')
  } finally {
    await k.close()
  }
})

test('M7 Issue#36: invalid batch input dispatches no query and the helper scaffold is restored', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    k.send({ type: 'eval', id: 1, code: 'await rlm_query_batched(["ok", 7])' })
    const invalid = await k.next()
    assert.equal(invalid.type, 'error')
    assert.equal(invalid.phase, 'query')
    assert.equal(invalid.kind, 'query_error')
    assert.match(String(invalid.message), /list or tuple of strings/)
    k.send({ type: 'eval', id: 2, code: 'del rlm_query_batched\nraise ValueError("restore batch scaffold")' })
    const erased = await k.next()
    assert.equal(erased.type, 'error')
    k.send({ type: 'eval', id: 3, code: 'await rlm_query_batched([])' })
    const empty = await k.next()
    assert.equal(empty.type, 'result')
    assert.equal(empty.result, '[]')
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

import { createRlmRuntime, RlmError, type RlmEvalInput } from '../src/runtime.ts'
import type { Context } from '@deepseek-ai/cordis'

function rt(config: Record<string, unknown> = {}) {
  return createRlmRuntime(undefined, config)
}

/** M6 RED seam: the accepted M5 input type has not admitted reset yet. */
function manualReset(signal?: AbortSignal): RlmEvalInput {
  return { reset: true, ...(signal ? { signal } : {}) } as unknown as RlmEvalInput
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

test('M7 Issue#36: a batch respects remaining maxQueries and drains admitted children', async () => {
  const runtime = rt({ maxQueries: 2 })
  const gates = [new Deferred<string>(), new Deferred<string>()]
  let started = 0
  try {
    const pending = runtime.eval('m7-query-limit', {
      code: 'await rlm_query_batched(["0", "1", "2", "3"])',
      onQuery: async () => {
        const gate = gates[started++]
        return gate.promise
      },
    })
    await until(() => started === 2)
    gates[0].resolve('zero')
    gates[1].resolve('one')
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'query' && /query limit exceeded: 2/.test(err.message),
    )
    assert.equal(started, 2, 'only budgeted batch items may start DSH children')
    const next = await runtime.eval('m7-query-limit', { code: '8 * 5' })
    assert.equal(next.result, '40')
  } finally {
    await runtime.dispose()
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



test('M9 Issue#42 RED: a sandbox-enabled runtime confines each kernel start exactly once', async () => {
  const confineCalls: { argv: string[]; policy: unknown }[] = []
  const sandbox = {
    confine(argv: string[], policy: unknown) {
      confineCalls.push({ argv, policy })
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const policyService = {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: process.cwd() }
    },
  }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return policyService
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, {})
  try {
    await runtime.eval('m9-red', { code: 'x = 1' })
    assert.equal(confineCalls.length, 1, 'expected exactly one confine call per kernel start')
    assert.deepEqual(confineCalls[0]!.policy, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  } finally {
    runtime.dispose()
  }
})


test('M9 Issue#42: a confined kernel starts in the sandbox workspace root and relative writes land there', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m9-ws-'))
  let policy: { mode: string; workspaceRoot: string } | undefined
  let confineCount = 0
  const sandbox = {
    confine(argv: readonly string[], p: { mode: string; workspaceRoot: string }) {
      confineCount += 1
      policy = p
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const policyService = { resolve() { return { mode: 'workspace-write', workspaceRoot: ws } } }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return policyService
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, {})
  try {
    const cwdOut = await runtime.eval('m9-cwd', { code: 'import os\nos.getcwd()' })
    assert.equal(cwdOut.result, ws)
    const writeOut = await runtime.eval('m9-cwd', { code: "open('rel.txt', 'w').write('ok')\n'written'" })
    assert.equal(writeOut.result, 'written')
    assert.equal(readFileSync(path.join(ws, 'rel.txt'), 'utf8'), 'ok')
    assert.equal(confineCount, 1, 'one kernel start must call confine exactly once')
    assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: ws })
  } finally {
    await runtime.dispose()
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(ws, { recursive: true, force: true }); break } catch { await new Promise((res) => setTimeout(res, 100)) }
    }
  }
})

test('M9 Issue#42: require fails closed when the sandbox services are absent', async () => {
  const runtime = createRlmRuntime(undefined, { kernelSandbox: 'require' })
  try {
    await assert.rejects(
      runtime.eval('m9-require', { code: '1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'sandbox',
    )
  } finally {
    runtime.dispose()
  }
})

test('M9 Issue#42: auto keeps the legacy trusted spawn when services are absent', async () => {
  const runtime = createRlmRuntime(undefined, {})
  try {
    const out = await runtime.eval('m9-auto-absent', { code: '2 + 2' })
    assert.equal(out.result, '4')
  } finally {
    runtime.dispose()
  }
})

test('M9 Issue#42: off never consults a present sandbox service', async () => {
  let confineCount = 0
  const sandbox = {
    confine(argv: readonly string[]) { confineCount += 1; return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } },
  }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return { resolve() { return { mode: 'workspace-write', workspaceRoot: process.cwd() } } }
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, { kernelSandbox: 'off' })
  try {
    const out = await runtime.eval('m9-off', { code: '6 * 7' })
    assert.equal(out.result, '42')
    assert.equal(confineCount, 0, 'off must not consult the sandbox service')
  } finally {
    runtime.dispose()
  }
})

test('M9 Issue#42: a present but unusable sandbox fails closed for auto and require', async () => {
  for (const kernelSandbox of ['auto', 'require'] as const) {
    const sandbox = {
      confine() { throw new Error('chain unavailable') },
    }
    const fakeCtx = {
      get(name: string) {
        if (name === 'sandbox') return sandbox
        if (name === 'sandboxPolicy') return { resolve() { return { mode: 'workspace-write', workspaceRoot: process.cwd() } } }
        return undefined
      },
    } as unknown as Context
    const runtime = createRlmRuntime(fakeCtx, { kernelSandbox })
    try {
      await assert.rejects(
        runtime.eval('m9-unusable-' + kernelSandbox, { code: '1' }),
        (err: unknown) => err instanceof RlmError && err.kind === 'sandbox',
      )
    } finally {
      runtime.dispose()
    }
  }
})

test('M9 Issue#42: a classified sandbox runner failure is a typed sandbox error', async () => {
  const sandbox = {
    confine(argv: readonly string[]) {
      return { argv: ['dsh-rlm-no-such-runner'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return { resolve() { return { mode: 'workspace-write', workspaceRoot: process.cwd() } } }
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, {})
  try {
    await assert.rejects(
      runtime.eval('m9-runner-fail', { code: '1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'sandbox',
    )
  } finally {
    runtime.dispose()
  }
})


test('M9 Issue#42: a confined M5 kernel restores a host-private chunked checkpoint', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m9-m5-'))
  let confineCount = 0
  const sandbox = {
    confine(argv: readonly string[]) { confineCount += 1; return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } },
  }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return { resolve() { return { mode: 'workspace-write', workspaceRoot: ws } } }
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, { snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m9-m5', { code: 'keep = 41' })
    // Force a timeout so the kernel is evicted and M5 recovery starts a fresh one.
    await assert.rejects(
      runtime.eval('m9-m5', { code: 'import time\ntime.sleep(30)' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
    const restored = await runtime.eval('m9-m5', { code: 'keep + 1' })
    assert.equal(restored.result, '42')
    assert.equal(restored.recovery?.restored, true)
    assert.equal(confineCount, 2, 'the recovery kernel must also be confined')
  } finally {
    await runtime.dispose()
  }
})

test('M9 Issue#42: confined M5 never writes the checkpoint into the sandbox workspace', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m9-m5-priv-'))
  const sandbox = {
    confine(argv: readonly string[]) { return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] } },
  }
  const fakeCtx = {
    get(name: string) {
      if (name === 'sandbox') return sandbox
      if (name === 'sandboxPolicy') return { resolve() { return { mode: 'workspace-write', workspaceRoot: ws } } }
      return undefined
    },
  } as unknown as Context
  const runtime = createRlmRuntime(fakeCtx, { snapshotRecovery: true, timeout: 10_000 })
  try {
    const out = await runtime.eval('m9-m5-priv', { code: 'x = 7' })
    assert.equal(out.recovery?.checkpointCommitted, true)
    const leaked = readdirSync(ws)
    assert.deepEqual(leaked, [], 'checkpoint must not be written into the sandbox-visible workspace')
  } finally {
    await runtime.dispose()
  }
})


test('M10 Issue#44 RED: a durableRoot is not consulted on the accepted M9 base', async () => {
  const durable = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-red-'))
  const runtime = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m10-red', { code: 'x = 7' })
    const files = readdirSync(durable).filter((f) => f.endsWith('.checkpoint.json'))
    assert.equal(files.length, 1, 'a committed checkpoint must publish one durable reference')
  } finally {
    runtime.dispose()
  }
})


test('M10 Issue#44: a new runtime with the same durableRoot restores the same Session after a timeout', async () => {
  const durable = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-'))
  const runtime = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m10-sess', { code: 'keep = 99' })
    await assert.rejects(
      runtime.eval('m10-sess', { code: 'import time\ntime.sleep(30)' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
  } finally {
    await runtime.dispose()
  }
  const runtimeB = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 10_000 })
  try {
    const restored = await runtimeB.eval('m10-sess', { code: 'keep + 1' })
    assert.equal(restored.result, '100')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await runtimeB.dispose()
  }
})

test('M10 Issue#44: reset deletes the durable reference for that Session only', async () => {
  const durable = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-reset-'))
  const runtime = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m10-a', { code: 'va = 1' })
    await runtime.eval('m10-b', { code: 'vb = 2' })
    assert.equal(readdirSync(durable).filter((f) => f.endsWith('.checkpoint.json')).length, 2, 'two sessions must publish two durable refs')
    await runtime.eval('m10-a', { reset: true })
    const files = readdirSync(durable).filter((f) => f.endsWith('.checkpoint.json'))
    assert.equal(files.length, 1, 'only the reset Session reference must be removed')
  } finally {
    await runtime.dispose()
  }
})

test('M10 Issue#44: a durable version mismatch fails closed without restoring stale state', async () => {
  const durable = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m10-ver-'))
  const runtime = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true, timeout: 3_000 })
  try {
    await runtime.eval('m10-ver', { code: 'x = 1' })
  } finally {
    await runtime.dispose()
  }
  const metaFile = path.join(durable, readdirSync(durable).find((f) => f.endsWith('.meta.json'))!)
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
  meta.schemaVersion = 999
  writeFileSync(metaFile, JSON.stringify(meta))
  const runtimeB = createRlmRuntime(undefined, { durableRoot: durable, snapshotRecovery: true })
  try {
    const out = await runtimeB.eval('m10-ver', { code: 'y = 2' })
    // Mismatch must not restore; a fresh kernel namespaces x as absent.
    assert.equal(out.recovery?.restored, false)
  } finally {
    await runtimeB.dispose()
  }
})


test('M12 Issue#48: registerRlmPlugin attaches the rlm job controller when jobs exist', async () => {
  const controllers: string[] = []
  const m = makeMockCtx()
  m.ctx.jobs = {
    attachController(name: string) { controllers.push(name); return () => {} },
    start() { throw new Error('unused') },
  }
  registerRlmPlugin(m.ctx, { enabled: true })
  try {
    assert.ok(controllers.includes('rlm'), 'rlm job controller must be attached')
    assert.equal(m.registered.length, 1, 'tool registration unchanged')
  } finally {
    await m.teardown?.()
  }
})

test('M12 Issue#48: createRlmJobSpec runs one cell and reports bounded output', async () => {
  const m = makeMockCtx({ queryText: '4' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  const exec = makeExec('m12-job')
  // Build a runtime-backed job spec via the tool's runtime import path: use createRlmRuntime directly.
  const { createRlmRuntime } = await import('../src/runtime.ts')
  const { createRlmJobSpec } = await import('../src/runtime.ts')
  const runtime = createRlmRuntime(undefined, {})
  const spec = createRlmJobSpec(exec.agent, '2 + 2', runtime)
  assert.equal(spec.kind, 'rlm')
  assert.equal(typeof spec.run, 'function')
  const hooks = spec.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(hooks.readOutput?.() ?? '', /4/, 'job output must carry the cell result')
  await runtime.dispose()
  try { await m.teardown?.() } catch {}
})

test('M12 Issue#48: the public package entry re-exports the M12 host-consumer API', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  for (const name of ['createRlmRuntime', 'createRlmJobSpec', 'startRlmJob', 'TOOL_NAME']) {
    assert.match(source, new RegExp('\\b' + name + '\\b'), 'index.ts must re-export ' + name)
  }
  assert.match(source, /export \{/, 'index.ts must contain an export block')
})

test('M12 Issue#48: startRlmJob dispatches through ctx.jobs.start with the rlm kind', async () => {
  const started: any[] = []
  const m = makeMockCtx()
  m.ctx.jobs = {
    attachController(name: string) { return () => {} },
    start(spec: any) { started.push(spec); return 'rlm-1' },
  }
  const { createRlmRuntime, startRlmJob } = await import('../src/runtime.ts')
  const runtime = createRlmRuntime(undefined, {})
  const id = startRlmJob(m.ctx, makeAgent('m12-start'), '1 + 1', runtime)
  assert.equal(id, 'rlm-1')
  assert.equal(started.length, 1)
  assert.equal(started[0].kind, 'rlm')
  assert.equal(typeof started[0].run, 'function')
  await runtime.dispose()
})

test('M12 Issue#48: an inert spec does not start the cell until run() is called', async () => {
  const { createRlmRuntime, createRlmJobSpec } = await import('../src/runtime.ts')
  const runtime = createRlmRuntime(undefined, {})
  const spec = createRlmJobSpec(makeAgent('m12-inert'), '1 + 1', runtime)
  const hooks = spec.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  await runtime.dispose()
})

test('M12 Issue#48: a job kill settles as killed and disposes the kernel', async () => {
  const { createRlmRuntime } = await import('../src/runtime.ts')
  const { createRlmJobSpec } = await import('../src/runtime.ts')
  const runtime = createRlmRuntime(undefined, {})
  const exec = makeExec('m12-kill')
  const spec = createRlmJobSpec(exec.agent, 'import time\ntime.sleep(30)', runtime)
  const hooks = spec.run()
  await new Promise((res) => setTimeout(res, 200))
  hooks.cancel('test kill')
  const outcome = await hooks.done
  assert.equal(outcome.status, 'killed', 'job must settle killed after cancel')
  await runtime.dispose()
})

// ---- M1C/M1D: DSH tool registration and rlm_query -> one-shot Subagent bridge ----

import { registerRlmPlugin } from '../src/runtime.ts'

interface FakeExec { agent: any; signal: AbortSignal }

function makeAgent(agentId: string, delegationDepth = 0): any {
  return { id: agentId, options: {}, session: { header: { delegationDepth } } }
}

function makeExec(agentId: string): FakeExec {
  return { agent: makeAgent(agentId), signal: new AbortController().signal }
}

interface MockCtx {
  ctx: any
  registered: any[]
  starts: { provider: string; request: any }[]
  continuableStarts: any[]
  followups: any[]
  drained: any[]
  run: any
  teardown: (() => void) | undefined
  label: string | undefined
  sections: any[]
}

function makeMockCtx(options: {
  queryText?: string
  providerCapabilities?: { depthLimit: boolean; toolFilter: boolean }
  enforceDepthLimit?: boolean
} = {}): MockCtx {
  const registered: any[] = []
  const starts: { provider: string; request: any }[] = []
  const continuableStarts: any[] = []
  const followups: any[] = []
  const drained: any[] = []
  const sections: any[] = []
  const run: any = {
    disposed: false,
    result: Promise.resolve({ output: [{ type: 'text', text: options.queryText ?? '4' }], stopReason: 'completed' }),
    dispose: async () => { run.disposed = true },
  }
  // Build the mutable mock first; ctx.effect writes straight onto it (not a
  // closure local, which the returned object would capture as stale undefined).
  const m: MockCtx = { ctx: undefined as any, registered, starts, continuableStarts, followups, drained, run, teardown: undefined, label: undefined, sections }
  m.ctx = {
    tools: {
      register(def: any) {
        registered.push(def)
        return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1) }
      },
    },
    subagents: {
      getProvider() {
        return {
          capabilities: options.providerCapabilities ?? { depthLimit: true, toolFilter: true },
          prepareContinuable: async () => ({ seed: undefined }),
        }
      },
      async start(provider: string, request: any) {
        if (options.enforceDepthLimit) {
          const attemptedDepth = (request.parent.session.header.delegationDepth ?? 0) + 1
          if (attemptedDepth > request.maxDepth) {
            throw new Error(`subagent depth ${attemptedDepth} exceeds maxDepth ${request.maxDepth}`)
          }
        }
        starts.push({ provider, request })
        return run
      },
      async startContinuable(spec: any) {
        continuableStarts.push(spec)
        return { childId: 'm8-continuable-child', messageId: 'm8-initial-message' }
      },
      [Symbol.for('dsh.subagent.deliverPrompt')](parent: any, childId: string, content: any[], source: any, signal: AbortSignal, delivery: string) {
        assert.equal(delivery, 'queue', 'M8 uses the official FIFO host-prompt adapter')
        followups.push({ parent, childId, content, options: { source, signal } })
        return Promise.resolve('m8-followup-message')
      },
      async drainContinuableDescendants(parents: any[]) {
        drained.push(parents)
      },
    },
    // Issue #6: real Context augmentation from @deepseek-ai/dsh-system-prompt
    // (section registers a PromptSection and returns the effect disposer).
    systemPrompt: {
      section(def: any) {
        sections.push(def)
        return () => { const i = sections.indexOf(def); if (i >= 0) sections.splice(i, 1) }
      },
    },
    effect(execute: () => () => void, effectLabel: string) {
      m.label = effectLabel
      m.teardown = execute()
    },
  }
  return m
}


test('M11 Issue#46 RED: a token guard consults recorded measure on the accepted M10 base', async () => {
  const measureCalls: unknown[] = []
  const m = makeMockCtx({ queryText: 'ok' })
  m.ctx.tokenMeter = { measure(session: unknown) { measureCalls.push(session); return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', guardQueryTokens: true, maxQueryTokensPerCell: 100 })
  const tool = m.registered[0]
  try {
    const out = await tool.execute({ code: 'await rlm_query("x")' }, makeExec('m11-red'))
    assert.ok(out, 'tool executed')
    assert.equal(measureCalls.length, 1, 'guard must record exactly one measure call per query admission')
  } finally {
    await m.teardown?.()
  }
})


test('M11 Issue#46: over-budget observed tokens reject before child dispatch', async () => {
  const measureCalls: unknown[] = []
  const m = makeMockCtx({ queryText: 'ok' })
  m.ctx.tokenMeter = { measure(session: unknown) { measureCalls.push(session); return { baseline: { kind: 'usage', tokens: 501, usage: { inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totalTokens: 501 } } }
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', guardQueryTokens: true, maxQueryTokensPerCell: 100 })
  const tool = m.registered[0]
  try {
    await assert.rejects(
      tool.execute({ code: 'await rlm_query("x")' }, makeExec('m11-over')),
      (err: unknown) => err instanceof Error && /token budget exceeded/i.test(err.message),
    )
    assert.equal(measureCalls.length, 1, 'guard must read the meter exactly once')
    assert.equal(m.starts.length, 0, 'over-budget must not dispatch a child')
  } finally {
    await m.teardown?.()
  }
})

test('M11 Issue#46: under-budget observed tokens allow admission and dispatch', async () => {
  const m = makeMockCtx({ queryText: 'ok' })
  m.ctx.tokenMeter = { measure() { return { baseline: { kind: 'usage', tokens: 11, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }, totalTokens: 11 } } }
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', guardQueryTokens: true, maxQueryTokensPerCell: 100 })
  const tool = m.registered[0]
  try {
    const out = await tool.execute({ code: 'await rlm_query("x")' }, makeExec('m11-under'))
    assert.ok(out, 'under-budget must admit')
    assert.equal(m.starts.length, 1, 'exactly one child dispatched')
  } finally {
    await m.teardown?.()
  }
})

test('M11 Issue#46: the official TokenMeasurement shape must reject over budget (not a no-op)', async () => {
  const m = makeMockCtx({ queryText: 'ok' })
  m.ctx.tokenMeter = { measure() {
    return {
      logRevision: 1,
      baseline: { kind: 'usage', tokens: 120, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      surfaceDeltaTokens: 0,
      totalTokens: 120,
      surfaceTokens: 120,
      nodes: [],
    }
  } }
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', guardQueryTokens: true, maxQueryTokensPerCell: 100 })
  const tool = m.registered[0]
  try {
    await assert.rejects(
      tool.execute({ code: 'await rlm_query("x")' }, makeExec('m11-authority')),
      (err: unknown) => err instanceof Error && /token budget exceeded/i.test(err.message),
    )
    assert.equal(m.starts.length, 0, 'authoritative over-budget must not dispatch a child')
  } finally {
    await m.teardown?.()
  }
})

test('M11 Issue#46: guard is off by default (no measurement, no rejection)', async () => {
  const measureCalls: unknown[] = []
  const m = makeMockCtx({ queryText: 'ok' })
  m.ctx.tokenMeter = { measure(session: unknown) { measureCalls.push(session); return { baseline: { kind: 'usage', tokens: 19998, usage: { inputTokens: 9999, outputTokens: 9999 } }, totalTokens: 19998 } } }
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  try {
    const out = await tool.execute({ code: 'await rlm_query("x")' }, makeExec('m11-off'))
    assert.ok(out, 'default-off guard must not reject')
    assert.equal(measureCalls.length, 0, 'default-off guard must not call measure')
  } finally {
    await m.teardown?.()
  }
})

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
    // M6 keeps one tool but exposes the two strict-union branches. defineTool
    // normalizes `parameters` to JSON Schema ({ type, properties, required });
    // the execute boundary enforces the cross-field exclusivity.
    assert.equal(enabled.registered[0].parameters.type, 'object')
    assert.deepEqual(Object.keys(enabled.registered[0].parameters.properties), ['code', 'contextPath', 'reset'])
    assert.equal(enabled.registered[0].parameters.properties.code.type, 'string')
    assert.equal(enabled.registered[0].parameters.properties.reset.type, 'boolean')
    const required: string[] = enabled.registered[0].parameters.required ?? []
    assert.ok(!required.includes('code'))
    assert.ok(!required.includes('contextPath'))
    assert.ok(!required.includes('reset'))
    // The runtime teardown effect is mounted.
    assert.equal(typeof enabled.teardown, 'function')
    assert.equal(enabled.label, 'rlm runtime teardown')
  } finally {
    enabled.teardown?.()
  }
})

test('M6 Issue#33: the registered tool accepts reset alone and rejects mixed or empty union inputs', async () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  const tool = m.registered[0]
  try {
    const reset = await tool.execute({ reset: true }, makeExec('m6-tool-reset'))
    assert.equal(reset.result, 'RLM state reset')
    await assert.rejects(
      tool.execute({ code: '1 + 1', reset: true }, makeExec('m6-tool-mixed')),
      (err: unknown) => err instanceof Error && /reset input must not include code/i.test(err.message),
    )
    await assert.rejects(
      tool.execute({}, makeExec('m6-tool-empty')),
      (err: unknown) => err instanceof Error && /requires either code or reset/i.test(err.message),
    )
  } finally {
    await m.teardown?.()
  }
})

test('M1D: the one-shot child request filters out rlm_eval and uses the calling agent', async () => {
  const ctl = new AbortController()
  const m = makeMockCtx({ queryText: 'four' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  const exec = { agent: makeAgent('sess-a'), signal: ctl.signal }

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

test('M8 Issue#39: the existing tool routes an opaque handle through official continuable inbox calls', async () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  const exec = { agent: makeAgent('m8-parent'), signal: new AbortController().signal }
  try {
    const spawned = await tool.execute({ code: 'h = await rlm_spawn("initial")\nrepr(h)' }, exec)
    assert.equal(spawned.result, '<rlm child handle>')
    assert.equal(m.continuableStarts.length, 1)
    assert.equal(m.continuableStarts[0].provider, 'spawn')
    assert.equal(m.continuableStarts[0].request.parent, exec.agent)
    assert.deepEqual(m.continuableStarts[0].request.prompt, [{ type: 'text', text: 'initial' }])
    assert.deepEqual(m.continuableStarts[0].request.toolFilter, { deny: ['rlm_eval'] })

    const followed = await tool.execute({ code: 'await rlm_followup(h, "later")\n"parent continued"' }, exec)
    assert.equal(followed.result, 'parent continued')
    assert.equal(m.followups.length, 1)
    assert.equal(m.followups[0].parent, exec.agent)
    assert.equal(m.followups[0].childId, 'm8-continuable-child')
    assert.deepEqual(m.followups[0].content, [{ type: 'text', text: 'later' }])
    assert.deepEqual(m.followups[0].options.source, {
      kind: 'coordinator', form: 'relay', senderSessionId: 'm8-parent',
    })
  } finally {
    await m.teardown?.()
  }
  assert.deepEqual(m.drained, [[exec.agent]])
})

test('M8 Issue#39 successor RED: an adapter-less host rejects spawn before child admission', async () => {
  const m = makeMockCtx()
  delete m.ctx.subagents[Symbol.for('dsh.subagent.deliverPrompt')]
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  const tool = m.registered[0]
  try {
    await assert.rejects(
      tool.execute({ code: 'await rlm_spawn("must not admit")' }, makeExec('m8-adapterless')),
      (err: unknown) => err instanceof Error
        && (err as Error & { kind?: string; phase?: string }).kind === 'query'
        && (err as Error & { kind?: string; phase?: string }).phase === 'query'
        && /official continuable inbox adapter/i.test(err.message),
    )
    assert.equal(m.continuableStarts.length, 0)
  } finally {
    await m.teardown?.()
  }
})

test('M8 Issue#39: foreign handles dispatch nothing and M5 never checkpoints a live capability', async () => {
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000 })
  let spawned = 0
  let followed = 0
  try {
    const created = await runtime.eval('m8-snapshot', {
      code: 'h = await rlm_spawn("snapshot child")\n"created"',
      onSpawn: async () => {
        spawned += 1
        return 'm8-snapshot-child'
      },
    })
    assert.equal(created.result, 'created')
    assert.equal(spawned, 1)
    assert.ok(created.recovery?.skipped?.some((entry) => /h: unsupported _RlmChildHandle/.test(entry)))
    await assert.rejects(
      runtime.eval('m8-snapshot', {
        code: 'await rlm_followup(object(), "must not send")',
        onFollowup: async () => { followed += 1 },
      }),
      (err: unknown) => err instanceof RlmError && err.kind === 'query' && /live child handle/.test(err.message),
    )
    assert.equal(followed, 0)
    await assert.rejects(runtime.eval('m8-snapshot', { code: 'import os\nos._exit(1)' }))
    const restored = await runtime.eval('m8-snapshot', { code: '"h" in globals()' })
    assert.equal(restored.result, 'False')
  } finally {
    await runtime.dispose()
  }
})

test('M4 Issue#25: maxDepth defaults to one and makes the first child a structurally denied leaf', async () => {
  const m = makeMockCtx({ queryText: 'leaf text' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn' })
  try {
    const out = await m.registered[0].execute(
      { code: 'await rlm_query("leaf")' },
      { agent: { id: 'm4-root', options: {}, session: { header: { delegationDepth: 0 } } }, signal: new AbortController().signal },
    )
    assert.equal(out.result, 'leaf text')
    assert.equal(m.starts.length, 1)
    assert.equal(m.starts[0].request.maxDepth, 1)
    assert.deepEqual(m.starts[0].request.toolFilter, { deny: ['rlm_eval'] })
  } finally {
    m.teardown?.()
  }
})

test('M4 Issue#25: a child below maxDepth keeps rlm_eval available while retaining the absolute DSH cap', async () => {
  const m = makeMockCtx({ queryText: 'recursive text' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  try {
    const out = await m.registered[0].execute(
      { code: 'await rlm_query("recursive")' },
      { agent: { id: 'm4-root-under-cap', options: {}, session: { header: { delegationDepth: 0 } } }, signal: new AbortController().signal },
    )
    assert.equal(out.result, 'recursive text')
    assert.equal(m.starts.length, 1)
    assert.equal(m.starts[0].request.maxDepth, 2)
    assert.equal(m.starts[0].request.toolFilter, undefined)
  } finally {
    m.teardown?.()
  }
})

test('M4 Issue#25: an exact-depth recursive child is structurally denied rlm_eval', async () => {
  const m = makeMockCtx({ queryText: 'leaf text' })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  try {
    const out = await m.registered[0].execute(
      { code: 'await rlm_query("exact leaf")' },
      { agent: makeAgent('m4-depth-one-leaf', 1), signal: new AbortController().signal },
    )
    assert.equal(out.result, 'leaf text')
    assert.equal(m.starts[0].request.maxDepth, 2)
    assert.deepEqual(m.starts[0].request.toolFilter, { deny: ['rlm_eval'] })
  } finally {
    m.teardown?.()
  }
})

test('M4 Issue#25: a depth request beyond the official cap publishes no child run', async () => {
  const m = makeMockCtx({ enforceDepthLimit: true })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  try {
    await assert.rejects(
      m.registered[0].execute(
        { code: 'await rlm_query("beyond cap")' },
        { agent: makeAgent('m4-beyond-cap', 2), signal: new AbortController().signal },
      ),
      (err: unknown) => err instanceof Error && /subagent depth 3 exceeds maxDepth 2/.test(err.message),
    )
    assert.equal(m.starts.length, 0)
  } finally {
    m.teardown?.()
  }
})

test('M4 Issue#25: missing DSH recursion capability fails before a child is started', async () => {
  const m = makeMockCtx({ providerCapabilities: { depthLimit: true, toolFilter: false } })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  try {
    await assert.rejects(
      m.registered[0].execute(
        { code: 'await rlm_query("must not start")' },
        { agent: makeAgent('m4-capability'), signal: new AbortController().signal },
      ),
      (err: unknown) => err instanceof Error && /must support depthLimit and toolFilter/.test(err.message),
    )
    assert.equal(m.starts.length, 0)
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
    const exec = { agent: makeAgent('sess-sig'), signal: ctl.signal }
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
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('silent kernel pid marker did not publish a valid PID in time')
}

test('Issue#26 RED: pid marker wait ignores an empty file until a positive PID is published', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-pid-marker-'))
  const pidFile = path.join(dir, 'pid.txt')
  writeFileSync(pidFile, '')
  const timer = setTimeout(() => writeFileSync(pidFile, '4242'), 50)
  try {
    assert.equal(await waitForPidFile(pidFile, 1000), 4242)
  } finally {
    clearTimeout(timer)
    rmSync(dir, { recursive: true, force: true })
  }
})

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
sys.stdout.write(json.dumps({"type": "ready", "version": 4}) + "\\n")
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
        'payload = json.dumps({"type": "ready", "version": 2, "python": "x"}).encode("utf-8")',
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
      getProvider() {
        return { capabilities: { depthLimit: true, toolFilter: true } }
      },
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
    // Real-shape systemPrompt service stub: Issue #6 registers one section on
    // every enabled plugin; these lifecycle tests do not assert section content.
    systemPrompt: {
      section(_def: any) {
        return () => {}
      },
    },
    effect(execute: () => () => void, effectLabel: string) {
      m.teardown = execute()
    },
  }
  return m
}

test('M7 Issue#36: the runtime never starts more than four batch children before a reply', async () => {
  const m = makeLifecycleMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', timeout: 8000 })
  try {
    const pending = m.registered[0].execute(
      { code: 'await rlm_query_batched(["0", "1", "2", "3", "4", "5"])' },
      makeExec('m7-runtime-concurrency'),
    )
    await until(() => m.starts.length === 4)
    assert.equal(m.starts.length, 4)
    m.starts[3].run.result.resolve({ output: [{ type: 'text', text: 'answer-3' }], stopReason: 'completed' })
    await until(() => m.starts.length === 5)
    assert.equal(m.starts.length, 5)
    m.starts[2].run.result.resolve({ output: [{ type: 'text', text: 'answer-2' }], stopReason: 'completed' })
    await until(() => m.starts.length === 6)
    for (const [index, start] of m.starts.entries()) {
      if (!start.run.result.isSettled()) {
        start.run.result.resolve({ output: [{ type: 'text', text: 'answer-' + index }], stopReason: 'completed' })
      }
    }
    const out = await pending
    assert.equal(out.result, "['answer-0', 'answer-1', 'answer-2', 'answer-3', 'answer-4', 'answer-5']")
  } finally {
    m.teardown?.()
  }
})

test('M7 Issue#36: a batch preserves M4 recursion policy for every admitted child', async () => {
  const root = makeLifecycleMockCtx({ autoResult: { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' } })
  const leaf = makeLifecycleMockCtx({ autoResult: { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' } })
  registerRlmPlugin(root.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  registerRlmPlugin(leaf.ctx, { enabled: true, provider: 'spawn', maxDepth: 2 })
  try {
    await root.registered[0].execute(
      { code: 'await rlm_query_batched(["0", "1", "2", "3"])' },
      { agent: makeAgent('m7-m4-root', 0), signal: new AbortController().signal },
    )
    assert.equal(root.starts.length, 4)
    for (const start of root.starts) assert.equal(start.request.toolFilter, undefined, 'a below-cap child remains recursion-capable')

    await leaf.registered[0].execute(
      { code: 'await rlm_query_batched(["0", "1", "2", "3"])' },
      { agent: makeAgent('m7-m4-leaf', 1), signal: new AbortController().signal },
    )
    assert.equal(leaf.starts.length, 4)
    for (const start of leaf.starts) assert.deepEqual(start.request.toolFilter, { deny: ['rlm_eval'] }, 'an exact-depth child is a leaf')
  } finally {
    root.teardown?.()
    leaf.teardown?.()
  }
})

test('M7 Issue#36: caller cancellation quiesces every admitted batch child before settlement', async () => {
  const m = makeLifecycleMockCtx({ disposeAsync: true })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', timeout: 8000 })
  const controller = new AbortController()
  try {
    const pending = m.registered[0].execute(
      { code: 'await rlm_query_batched(["0", "1", "2", "3", "not-started"])' },
      { agent: makeAgent('m7-batch-cancel'), signal: controller.signal },
    )
    await until(() => m.starts.length === 4)
    controller.abort('cancel batch')
    await assert.rejects(pending, (err: unknown) => err instanceof Error && /cancel/.test(err.message))
    for (const start of m.starts) {
      assert.equal(start.run.signal.aborted, true, 'every admitted child signal must be aborted')
      assert.equal(start.run.disposed, true, 'every admitted child must be disposed before the tool settles')
    }
    assert.equal(m.starts.length, 4, 'caller cancellation may not admit another child')
  } finally {
    m.teardown?.()
  }
})

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

test('M4 Issue#25: cancelling a recursively admissible branch aborts and disposes its DSH-owned run before settlement', async () => {
  const m = makeLifecycleMockCtx({ disposeAsync: true })
  registerRlmPlugin(m.ctx, { enabled: true, provider: 'spawn', maxDepth: 3 })
  const ctl = new AbortController()
  try {
    const pending = m.registered[0].execute(
      { code: 'await rlm_query("recursive branch")' },
      { agent: makeAgent('m4-cancel', 1), signal: ctl.signal },
    )
    await until(() => m.starts.length === 1)
    assert.equal(m.starts[0].request.maxDepth, 3)
    assert.equal(m.starts[0].request.toolFilter, undefined, 'depth-2 child remains recursion-capable')
    ctl.abort('cancel recursive branch')
    await assert.rejects(pending, (err: unknown) => err instanceof Error && /cancel/.test(err.message))
    assert.equal(m.starts[0].run.signal.aborted, true)
    assert.equal(m.starts[0].run.disposed, true)
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
      '    await asyncio.sleep(0.1)',
      '    sys.__stdout__.write("this is not json\\n")',
      '    sys.__stdout__.flush()',
      'asyncio.create_task(corrupt())',
      'await rlm_query_batched(["0", "1", "2", "3"])',
    ].join('\n')
    await assert.rejects(
      tool.execute({ code }, makeExec('sess-protocol-child')),
      (err: unknown) => err instanceof Error && /protocol/.test(err.message),
    )
    await tick(10)
    assert.equal(m.starts.length, 4, 'the fatal must clean every admitted batch child')
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
      '    await asyncio.sleep(0.1)',
      '    os._exit(1)',
      'asyncio.create_task(bye())',
      'await rlm_query_batched(["0", "1", "2", "3"])',
    ].join('\n')
    const pending = tool.execute({ code }, makeExec('sess-exit-child'))
    await until(() => m.starts.length === 4)
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof Error && /(closed|protocol|kernel exited)/.test(err.message),
    )
    for (const start of m.starts) {
      assert.equal(start.run.signal.aborted, true, 'every admitted child signal must be aborted by kernel exit')
      assert.equal(start.run.disposed, true, 'every admitted child must be disposed after kernel exit')
    }
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
    const exec = { agent: makeAgent('sess-cancel-child'), signal: ctl.signal }
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

test('M2 Issue#4: a concurrent eval during a fatal child-settlement window is queued and the next eval uses a fresh kernel', async () => {
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
    // cleanup barrier is still open: a concurrent eval must be QUEUED, never
    // admitted to a replacement kernel while the old child quiesces.
    const queued = runtime.eval('fatal-window', { code: '2 + 2', timeout: 8000 })
    let queuedDone = false
    queued.then(() => { queuedDone = true }, () => { queuedDone = true })
    await pendingRejection
    assert.equal(queuedDone, false, 'the queued eval must not run inside the fatal settlement window')
    // Issue #2 FIFO: the queued eval starts only after the old kernel was
    // evicted, on the fresh (empty) namespace.
    const fresh = await queued
    assert.equal(fresh.result, '4')
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

test('M2 Issue#4: a concurrent eval during a live-kernel settlement window is queued until settlement completes', async () => {
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
    // Issue #2 FIFO: the concurrent eval queues instead of failing busy; it may
    // start only after the live kernel's settlement completes.
    const queued = runtime.eval('live-settle', { code: '2 + 2', timeout: 8000 })
    let queuedDone = false
    queued.then(() => { queuedDone = true }, () => { queuedDone = true })
    settleBg?.()
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof RlmError && err.kind === 'query' && /main fail/.test(err.message),
    )
    assert.equal(queuedDone, false, 'the queued eval must not run before the settlement window closes')
    const out = await queued
    assert.equal(out.result, '4', 'the queued eval runs on the same live kernel after settlement')
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

test('M2 Issue#4: a duplicate response for a qid answered two cells earlier still fatals', async () => {
  const k = new Kernel()
  try {
    await ready(k)
    // Cell 1: one query answered normally; the cell ends.
    k.send({ type: 'eval', id: 1, code: 'x = await rlm_query("q")\nx' })
    const q = await k.next()
    assert.equal(q.type, 'query')
    const qid = k.id(q)
    k.send({ type: 'query_result', id: qid, text: 'ok' })
    const r1 = await k.next()
    assert.equal(r1.type, 'result')
    // Two more cells, so the answered qid is outside any current/previous
    // answered-id rotation window.
    k.send({ type: 'eval', id: 2, code: '1 + 1' })
    const r2 = await k.next()
    assert.equal(r2.result, '2')
    k.send({ type: 'eval', id: 3, code: '2 + 2' })
    const r3 = await k.next()
    assert.equal(r3.result, '4')
    // The duplicate for the two-cells-old answered qid must still be fatal.
    k.send({ type: 'query_result', id: qid, text: 'dup' })
    const code = await Promise.race([
      k.exit,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('kernel did not fatal on an old duplicate qid')), 5000),
      ),
    ])
    assert.notEqual(code, 0, 'a two-cells-old duplicate response must terminate the kernel')
    assert.match(k.stderr, /(duplicate|query id|response)/i)
  } finally {
    try {
      k.child.kill()
    } catch {
      // already dead
    }
    await k.exit.catch(() => {})
  }
})

test('M2 Issue#4: a second late reply for a retired unanswered query fatals after the first was dropped', async () => {
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
        'asyncio.create_task(bg())',
        'x = await rlm_query("main")',
        'x',
      ].join('\n'),
    })
    const qMain = await k.next()
    assert.equal(qMain.type, 'query')
    const qBg = await k.next()
    assert.equal(qBg.type, 'query')
    // The main query fails -> the cell reaches its terminal; the bg query was
    // never answered (retired-unanswered).
    k.send({ type: 'error', id: k.id(qMain), phase: 'query', kind: 'query_error', message: 'boom' })
    const e = await k.next()
    assert.equal(e.type, 'error')
    // A live cell proves the kernel survived the terminal.
    k.send({ type: 'eval', id: 2, code: '1 + 1' })
    const r2 = await k.next()
    assert.equal(r2.result, '2')
    // First late reply for the retired-unanswered qid: correctly dropped.
    k.send({ type: 'query_result', id: k.id(qBg), text: 'LATE1' })
    k.send({ type: 'eval', id: 3, code: '2 + 2' })
    const r3 = await k.next()
    assert.equal(r3.result, '4', 'first late reply must be dropped without affecting the kernel')
    // The second identical reply is a duplicate and must be fatal.
    k.send({ type: 'query_result', id: k.id(qBg), text: 'LATE2' })
    const code = await Promise.race([
      k.exit,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('kernel did not fatal on a second late reply')), 5000),
      ),
    ])
    assert.notEqual(code, 0, 'a second late reply for the same retired qid must terminate the kernel')
    assert.match(k.stderr, /(duplicate|query id|response)/i)
  } finally {
    try {
      k.child.kill()
    } catch {
      // already dead
    }
    await k.exit.catch(() => {})
  }
})

// ---- M2 Issue #2: per-session FIFO queue (serialize same-session evals) ----

test('M2 Issue#2: same-session evals run FIFO by submission order and the later cell sees earlier globals', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    const latch = new Deferred<string>()
    const order: string[] = []
    // The first cell parks on rlm_query so the second eval is provably queued.
    const first = runtime.eval('issue2-fifo', {
      code: 'v = await rlm_query("hold")\nvalue = 40\nvalue + len(v)',
      timeout: 8000,
      onQuery: async () => {
        order.push('query')
        return latch.promise
      },
    })
    first.then(() => { order.push('first-done') }, () => { order.push('first-failed') })
    const second = runtime.eval('issue2-fifo', { code: 'value * 2', timeout: 8000 })
    second.then(() => { order.push('second-done') }, () => { order.push('second-failed') })
    await until(() => order.includes('query'))
    assert.equal(order.includes('second-done'), false, 'FIFO: the second eval must wait for the first')
    latch.resolve('ok')
    const [out1, out2] = await Promise.all([first, second])
    assert.equal(out1.result, '42')
    assert.equal(out2.result, '80')
    assert.deepEqual(order, ['query', 'first-done', 'second-done'])
  } finally {
    await runtime.dispose()
  }
})

test('M2 Issue#2: different sessions run concurrently and keep isolated namespaces', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    const gateA = new Deferred<string>()
    const gateB = new Deferred<string>()
    const seen: string[] = []
    const a = runtime.eval('issue2-par-a', {
      code: 'mineA = await rlm_query("ga")\nmineA',
      timeout: 8000,
      onQuery: async (prompt: string) => {
        seen.push(prompt)
        return gateA.promise
      },
    })
    const b = runtime.eval('issue2-par-b', {
      code: 'mineB = await rlm_query("gb")\nmineB',
      timeout: 8000,
      onQuery: async (prompt: string) => {
        seen.push(prompt)
        return gateB.promise
      },
    })
    // Both cells are live at the same time: each session is parked on its own query.
    await until(() => seen.length === 2)
    assert.deepEqual([...seen].sort(), ['ga', 'gb'])
    gateA.resolve('A')
    gateB.resolve('B')
    assert.equal((await a).result, 'A')
    assert.equal((await b).result, 'B')
    // Namespace isolation: neither session sees the other session's variable.
    await assert.rejects(
      runtime.eval('issue2-par-a', { code: 'mineB', timeout: 8000 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
    await assert.rejects(
      runtime.eval('issue2-par-b', { code: 'mineA', timeout: 8000 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
  }
})

test('M2 Issue#2: aborting a queued eval rejects immediately and keeps the running same-session kernel alive', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    const seed = await runtime.eval('issue2-cancel', { code: 'import os\nos.getpid()', timeout: 8000 })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    const latch = new Deferred<string>()
    const first = runtime.eval('issue2-cancel', {
      code: 'v = await rlm_query("hold")\nv',
      timeout: 8000,
      onQuery: async () => latch.promise,
    })
    void first.catch(() => {})
    const ctl = new AbortController()
    const queued = runtime.eval('issue2-cancel', { code: '1 + 1', timeout: 8000, signal: ctl.signal })
    let queuedDone = false
    const queuedRejection = assert.rejects(queued, (err: unknown) => {
      assert.ok(err instanceof RlmError)
      assert.equal(err.kind, 'cancel')
      return true
    }).then(() => { queuedDone = true })
    ctl.abort('user-cancel')
    await Promise.race([
      queuedRejection.then(() => undefined, () => undefined),
      until(() => queuedDone),
    ])
    assert.equal(queuedDone, true, 'a queued abort must reject promptly, not wait for dequeue')
    // The queued cancel never touched the running kernel: it still parks on its query.
    latch.resolve('ok')
    assert.equal((await first).result, 'ok')
    // Same kernel PID: neither the queued abort nor the queue evicted the session kernel.
    const pidAgain = await runtime.eval('issue2-cancel', { code: 'import os\nos.getpid()', timeout: 8000 })
    assert.equal(pidAgain.result, String(pid), 'queued abort must not kill the running session kernel')
    await queuedRejection
  } finally {
    await runtime.dispose()
  }
})

test('M2 Issue#2: dispose rejects every queued eval, awaits kernel teardown, and no queued work starts', async () => {
  const runtime = rt({ timeout: 8000 })
  let queryStarted = false
  try {
    const first = runtime.eval('issue2-dispose', {
      code: 'v = await rlm_query("hold")\nv',
      timeout: 8000,
      onQuery: async (_prompt: string, signal?: AbortSignal) => {
        queryStarted = true
        // The cell-bound child settles only when the cell's controller aborts
        // (dispose), so the Kernel cleanup barrier can complete deterministically.
        const pending = new Deferred<string>()
        signal?.addEventListener('abort', () => pending.reject(new Error('cell disposed')), { once: true })
        return pending.promise
      },
    })
    // Wait until the kernel is live and the cell is provably running, so the
    // queued evals below would fail `busy` on the pre-queue implementation.
    await until(() => queryStarted)
    const queuedA = runtime.eval('issue2-dispose', { code: '1 + 1', timeout: 8000 })
    const queuedB = runtime.eval('issue2-dispose', { code: '2 + 2', timeout: 8000 })
    const firstRejection = assert.rejects(first, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    const queuedARejection = assert.rejects(queuedA, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    const queuedBRejection = assert.rejects(queuedB, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    const barrier = runtime.dispose()
    await Promise.all([firstRejection, queuedARejection, queuedBRejection])
    // The disposal barrier settles only after the running kernel's teardown barrier.
    await barrier
    // Terminal: a post-dispose eval rejects without starting any kernel.
    await assert.rejects(
      runtime.eval('issue2-dispose', { code: '1' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'closed' && /disposed/.test(err.message),
    )
  } finally {
    await runtime.dispose() // idempotent
  }
})

test('M2 Issue#2: after a kernel crash the queued successors run on a fresh kernel only after eviction (namespace loss observable)', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    const seed = await runtime.eval('issue2-crash', { code: 'import os\npid = os.getpid()\nmarker = 1\npid', timeout: 8000 })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    const latch = new Deferred<string>()
    const fatal = runtime.eval('issue2-crash', {
      code: 'x = await rlm_query("go")\nimport os\nos._exit(1)',
      timeout: 8000,
      onQuery: async () => latch.promise,
    })
    const failed = runtime.eval('issue2-crash', { code: 'marker + 1', timeout: 8000 })
    const pidAgain = runtime.eval('issue2-crash', { code: 'import os\nos.getpid()', timeout: 8000 })
    void failed.catch(() => {})
    void pidAgain.catch(() => {})
    // The successors are queued while the fatal cell is parked; releasing it
    // crashes the kernel so the queue must advance only after eviction.
    latch.resolve('go')
    await assert.rejects(
      fatal,
      (err: unknown) => err instanceof RlmError && (err.kind === 'closed' || err.kind === 'protocol'),
    )
    // Namespace loss is observable: the old `marker` is gone on the fresh kernel.
    await assert.rejects(
      failed,
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
    const out = await pidAgain
    const newPid = Number(out.result)
    assert.ok(Number.isInteger(newPid) && newPid > 0)
    assert.notEqual(newPid, pid, 'the successor must run on a fresh kernel, not reuse the dead one')
    const clear = await runtime.eval('issue2-crash', { code: '2 + 2', timeout: 8000 })
    assert.equal(clear.result, '4')
  } finally {
    await runtime.dispose()
  }
})

test('M2 Issue#2: a queued eval whose budget expires before dequeue is rejected timeout without starting a kernel', async () => {
  const runtime = rt({ timeout: 8000 })
  try {
    const seed = await runtime.eval('issue2-deadline', { code: 'import os\nos.getpid()', timeout: 8000 })
    const pid = Number(seed.result)
    assert.ok(Number.isInteger(pid) && pid > 0, 'expected a valid kernel pid, got ' + seed.result)
    const latch = new Deferred<string>()
    const first = runtime.eval('issue2-deadline', {
      code: 'v = await rlm_query("hold")\nv',
      timeout: 8000,
      onQuery: async () => latch.promise,
    })
    void first.catch(() => {})
    const queued = runtime.eval('issue2-deadline', { code: '1 + 1', timeout: 150 })
    let queuedDone = false
    const queuedRejection = assert.rejects(queued, (err: unknown) => {
      assert.ok(err instanceof RlmError)
      assert.equal(err.kind, 'timeout', 'budget exhaustion while queued must be a timeout')
      return true
    }).then(() => { queuedDone = true })
    await Promise.race([
      queuedRejection.then(() => undefined, () => undefined),
      until(() => queuedDone),
    ])
    assert.equal(queuedDone, true, 'the queued eval must expire against its own deadline, not after dequeue')
    latch.resolve('ok')
    await first
    // The running kernel was never disturbed, and no second kernel was spawned.
    const pidAgain = await runtime.eval('issue2-deadline', { code: 'import os\nos.getpid()', timeout: 8000 })
    assert.equal(pidAgain.result, String(pid), 'a queued deadline expiry must not kill or replace the kernel')
    await queuedRejection
  } finally {
    await runtime.dispose()
  }
})

// ---- M2 Issue #7: Python environment isolation (RED contract tests) ----

/**
 * Run `fn` with the given host environment keys set to fixed fake strings,
 * then restore every key to its previous value (or delete it) in `finally`.
 * Only booleans cross back from Python; values are never logged.
 */
function withHostEnvMap<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  return fn().finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test('M2 Issue#7: synthetic credential/proxy sentinels are visible in Host but absent from Python', async () => {
  const sentinels: Record<string, string> = {
    DSH_RLM_TEST_SECRET_7: 'not-a-real-secret',
    DEEPSEEK_API_KEY: 'not-a-real-secret',
    HTTPS_PROXY: 'not-a-real-secret',
  }
  await withHostEnvMap(sentinels, async () => {
    const runtime = rt()
    try {
      const names = Object.keys(sentinels)
      const out = await runtime.eval('issue7-sentinels', {
        code: 'import os\n[' + names.map((n) => JSON.stringify(n) + ' in os.environ').join(', ') + ']',
      })
      // Host must see the fake sentinels; Python must not inherit them.
      for (const name of names) {
        assert.ok(process.env[name] !== undefined, 'host must see the fake sentinel ' + name)
      }
      assert.equal(out.result, '[' + names.map(() => 'False').join(', ') + ']')
    } finally {
      runtime.dispose()
    }
  })
})

test('M2 Issue#7: unknown locale-looking LC_RLM_SECRET_7 is absent while safe startup variables remain usable', async () => {
  const standard = [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  ]
  await withHostEnvMap({ LC_RLM_SECRET_7: 'not-a-real-secret' }, async () => {
    const runtime = rt()
    try {
      const hostStandard = standard.filter((n) => process.env[n] !== undefined)
      const out = await runtime.eval('issue7-locale', {
        code: [
          'import os, sys, tempfile',
          "unknown_absent = 'LC_RLM_SECRET_7' not in os.environ",
          'path_ok = bool(os.environ.get("PATH"))',
          'temp_ok = bool(tempfile.gettempdir())',
          'encoding_ok = bool(sys.getfilesystemencoding())',
          'host_standard = ' + JSON.stringify(hostStandard),
          'standard_ok = all(n in os.environ for n in host_standard)',
          '[unknown_absent, path_ok, temp_ok, encoding_ok, standard_ok]',
        ].join('\n'),
      })
      assert.equal(out.result, '[True, True, True, True, True]')
    } finally {
      runtime.dispose()
    }
  })
})

test('M2 Issue#7: explicit custom python command obeys the same filtered env', async () => {
  await withHostEnvMap({ DSH_RLM_TEST_SECRET_7: 'not-a-real-secret' }, async () => {
    const runtime = createRlmRuntime(undefined, { python: pythonCmd })
    try {
      const out = await runtime.eval('issue7-custom', {
        code: "import os\n['DSH_RLM_TEST_SECRET_7' in os.environ, 1 + 1]",
      })
      assert.equal(out.result, '[False, 2]')
    } finally {
      runtime.dispose()
    }
  })
})

// ---- M2 Issue #6: runtime config schema, propagation, and system prompt lifecycle ----

test('M2 Issue#6 / M3 Issue#24: Config schema defaults and range-validates runtime settings', async () => {
  const rt = (await import('../src/runtime.ts')) as { ConfigSchema?: any }
  assert.equal(typeof rt.ConfigSchema, 'function', 'Issue #6 ConfigSchema must be exported from runtime.ts')
  const S: any = rt.ConfigSchema
  const parsed = S({ enabled: true, provider: 'spawn' })
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.provider, 'spawn')
  assert.equal(parsed.python, 'python')
  assert.equal(parsed.timeout, 30000)
  assert.equal(parsed.maxStdout, 65536)
  assert.equal(parsed.maxResult, 65536)
  assert.equal(parsed.maxQueries, 16)
  assert.equal(parsed.maxDepth, 1)
  assert.equal(parsed.maxContextBytes, 67108864)
  assert.equal(parsed.snapshotRecovery, false)
  assert.equal(S({ snapshotRecovery: true }).snapshotRecovery, true)
  assert.throws(() => S({ python: '' }))
  assert.throws(() => S({ timeout: 999 }))
  assert.throws(() => S({ timeout: 3600001 }))
  assert.equal(S({ timeout: 3600000 }).timeout, 3600000)
  assert.throws(() => S({ maxStdout: 1023 }))
  assert.throws(() => S({ maxStdout: 262145 }))
  assert.equal(S({ maxStdout: 262144 }).maxStdout, 262144)
  assert.throws(() => S({ maxResult: 1023 }))
  assert.throws(() => S({ maxQueries: 0 }))
  assert.throws(() => S({ maxQueries: 4097 }))
  assert.equal(S({ maxQueries: 4096 }).maxQueries, 4096)
  assert.throws(() => S({ maxContextBytes: 1048575 }))
  assert.throws(() => S({ maxContextBytes: 1073741825 }))
  assert.equal(S({ maxContextBytes: 1073741824 }).maxContextBytes, 1073741824)
  assert.throws(() => S({ maxDepth: 0 }))
  assert.throws(() => S({ maxDepth: 9 }))
  assert.equal(S({ maxDepth: 8 }).maxDepth, 8)
})

test('M2 Issue#6: parsed runtime settings propagate end to end (maxQueries limit observable)', async () => {
  const rt = (await import('../src/runtime.ts')) as { ConfigSchema?: any }
  assert.equal(typeof rt.ConfigSchema, 'function', 'Issue #6 ConfigSchema must be exported from runtime.ts')
  const config = rt.ConfigSchema({ enabled: true, maxQueries: 1, timeout: 20000, maxStdout: 4096, maxResult: 4096 })
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, config)
  try {
    assert.equal(m.registered.length, 1)
    const tool = m.registered[0]
    const ctl = new AbortController()
    await assert.rejects(
      tool.execute(
        { code: 'a = await rlm_query("one")\nb = await rlm_query("two")' },
        { agent: makeAgent('issue6-prop'), signal: ctl.signal },
      ),
      (err: unknown) => err instanceof Error && /query limit/.test(err.message),
    )
  } finally {
    m.teardown?.()
  }
})

test('M2 Issue#6: enabled registers the tool:rlm_eval system prompt section; disabled registers neither', () => {
  const enabled = makeMockCtx()
  registerRlmPlugin(enabled.ctx, { enabled: true })
  try {
    assert.equal(enabled.sections.length, 1, 'enabled must register exactly one system prompt section')
    const section = enabled.sections[0]
    assert.equal(section.name, 'tool:rlm_eval')
    assert.equal(section.order, 150)
    assert.equal(typeof section.text, 'string')
    assert.match(section.text, /persistent globals|persistent variables/i)
    assert.match(section.text, /absolute (file )?paths?/i)
    assert.match(section.text, /top[- ]level await/i)
    assert.match(section.text, /rlm_query/i)
    assert.match(section.text, /rlm_query_batched/i)
    assert.match(section.text, /four|4/i)
    assert.match(section.text, /input order|ordered/i)
    assert.match(section.text, /(subsequent|later|next) rlm_eval/i)
    assert.match(section.text, /iterat|reuse/i)
  } finally {
    enabled.teardown?.()
  }
  const disabled = makeMockCtx()
  registerRlmPlugin(disabled.ctx, { enabled: false })
  assert.equal(disabled.registered.length, 0)
  assert.equal(disabled.sections.length, 0)
})

test('M2 Issue#6: teardown removes the prompt section with the tool and releases the runtime', () => {
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true })
  assert.equal(m.sections.length, 1, 'enabled must register the prompt section before teardown')
  assert.equal(typeof m.teardown, 'function')
  const released = m.teardown!()
  assert.equal(m.registered.length, 0)
  assert.equal(m.sections.length, 0)
  assert.ok(released != null && typeof (released as any).then === 'function', 'teardown must return the runtime dispose barrier')
})

// ---- M3 Issue #24: kernel-owned managed file context ----

test('M3 Issue#24: a contextPath loads once into one session kernel and persists there', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-context-'))
  const contextPath = path.join(dir, 'context.txt')
  const contents = 'managed context\n'
  writeFileSync(contextPath, contents, 'utf8')
  const runtime = rt({ maxContextBytes: 1024 * 1024 })
  try {
    const first = await runtime.eval('m3-managed', {
      code: 'context',
      contextPath,
    })
    assert.equal(first.result, contents)

    const later = await runtime.eval('m3-managed', { code: 'context_meta["bytes"]' })
    assert.equal(later.result, String(Buffer.byteLength(contents, 'utf8')))

    await assert.rejects(
      runtime.eval('m3-other-session', { code: 'context' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: invalid sources are typed and atomic, and cell mutation cannot poison managed context', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-atomic-'))
  const contextPath = path.join(dir, 'context.txt')
  const nonUtf8Path = path.join(dir, 'not-utf8.bin')
  writeFileSync(contextPath, 'trusted context', 'utf8')
  writeFileSync(nonUtf8Path, Buffer.from([0xff, 0xfe]))
  const runtime = rt({ maxContextBytes: 1024 * 1024 })
  try {
    await runtime.eval('m3-atomic', { code: 'context', contextPath })
    await runtime.eval('m3-atomic', { code: 'context = "poison"\ncontext_meta["bytes"] = 0' })
    const restored = await runtime.eval('m3-atomic', { code: 'context + ":" + str(context_meta["bytes"])' })
    assert.equal(restored.result, 'trusted context:15')

    for (const rejectedPath of ['relative.txt', nonUtf8Path, dir]) {
      await assert.rejects(
        runtime.eval('m3-atomic', { code: 'context', contextPath: rejectedPath }),
        (err: unknown) => err instanceof RlmError && err.kind === 'context' && err.phase === 'context',
      )
      const preserved = await runtime.eval('m3-atomic', { code: 'context' })
      assert.equal(preserved.result, 'trusted context')
    }
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: tool forwards contextPath and reports source-limit rejection without replacing prior context', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-tool-'))
  const contextPath = path.join(dir, 'context.txt')
  const tooLargePath = path.join(dir, 'too-large.txt')
  writeFileSync(contextPath, 'safe', 'utf8')
  writeFileSync(tooLargePath, 'oversized', 'utf8')
  const m = makeMockCtx()
  registerRlmPlugin(m.ctx, { enabled: true, maxContextBytes: 4 })
  try {
    const tool = m.registered[0]
    const first = await tool.execute({ code: 'context', contextPath }, makeExec('m3-tool'))
    assert.equal(first.result, 'safe')
    await assert.rejects(
      tool.execute({ code: 'context', contextPath: tooLargePath }, makeExec('m3-tool')),
      (err: unknown) => err instanceof Error && /rlm_eval failed \(context\)/.test(err.message),
    )
    const preserved = await tool.execute({ code: 'context' }, makeExec('m3-tool'))
    assert.equal(preserved.result, 'safe')
  } finally {
    m.teardown?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: a FIFO is rejected before opening and preserves the live kernel', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows has no portable filesystem FIFO for this black-box regression')
    return
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-fifo-'))
  const contextPath = path.join(dir, 'context.txt')
  const fifoPath = path.join(dir, 'source.fifo')
  writeFileSync(contextPath, 'stable', 'utf8')
  const fifo = spawnSync(pythonCmd, ['-c', 'import os, sys; os.mkfifo(sys.argv[1])', fifoPath], { encoding: 'utf8' })
  assert.equal(fifo.status, 0, 'could not create FIFO: ' + fifo.stderr)
  const runtime = rt({ timeout: 500 })
  try {
    const before = await runtime.eval('m3-fifo', { code: 'import os\nos.getpid()', contextPath })
    await assert.rejects(
      runtime.eval('m3-fifo', { code: 'context', contextPath: fifoPath }),
      (err: unknown) => err instanceof RlmError && err.kind === 'context',
    )
    const after = await runtime.eval('m3-fifo', { code: 'import os\nstr(os.getpid()) + ":" + context' })
    assert.equal(after.result, String(before.result) + ':stable')
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: an in-read source mutation is rejected before atomic publication', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-race-'))
  const contextPath = path.join(dir, 'context.txt')
  writeFileSync(contextPath, 'before', 'utf8')
  const script = [
    'import importlib.util, os, sys',
    'spec = importlib.util.spec_from_file_location("rlm_kernel_under_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'assert spec.loader is not None',
    'spec.loader.exec_module(module)',
    'path = sys.argv[2]',
    'original_fstat = os.fstat',
    'calls = 0',
    'def raced_fstat(fd):',
    '    global calls',
    '    calls += 1',
    '    if calls == 2:',
    '        with open(path, "ab") as source: source.write(b"!")',
    '    return original_fstat(fd)',
    'os.fstat = raced_fstat',
    'try:',
    '    module.RlmKernel._read_context(path, 1024)',
    'except module.RlmContextError:',
    '    raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n')
  try {
    const result = spawnSync(pythonCmd, ['-c', script, kernelPath, contextPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'read-race must be a typed context failure; stderr: ' + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: a short descriptor read is rejected instead of publishing partial context', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-short-read-'))
  const contextPath = path.join(dir, 'context.txt')
  writeFileSync(contextPath, 'complete source', 'utf8')
  const script = [
    'import importlib.util, os, sys',
    'spec = importlib.util.spec_from_file_location("rlm_kernel_under_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'assert spec.loader is not None',
    'spec.loader.exec_module(module)',
    'path = sys.argv[2]',
    'original_read = os.read',
    'calls = 0',
    'def short_read(fd, size):',
    '    global calls',
    '    calls += 1',
    '    if calls == 1: return original_read(fd, 1)',
    '    return b""',
    'os.read = short_read',
    'try:',
    '    module.RlmKernel._read_context(path, 1024)',
    'except module.RlmContextError:',
    '    raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n')
  try {
    const result = spawnSync(pythonCmd, ['-c', script, kernelPath, contextPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'short read must be a typed context failure; stderr: ' + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3 Issue#24: a post-read pathname identity change is rejected before publication', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m3-path-race-'))
  const contextPath = path.join(dir, 'context.txt')
  const replacementPath = path.join(dir, 'replacement.txt')
  writeFileSync(contextPath, 'original', 'utf8')
  writeFileSync(replacementPath, 'replacement', 'utf8')
  const script = [
    'import importlib.util, os, sys',
    'spec = importlib.util.spec_from_file_location("rlm_kernel_under_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'assert spec.loader is not None',
    'spec.loader.exec_module(module)',
    'path, replacement = sys.argv[2], sys.argv[3]',
    'original_lstat = os.lstat',
    'calls = 0',
    'def replaced_lstat(target):',
    '    global calls',
    '    calls += 1',
    '    if calls == 2: return original_lstat(replacement)',
    '    return original_lstat(target)',
    'os.lstat = replaced_lstat',
    'try:',
    '    module.RlmKernel._read_context(path, 1024)',
    'except module.RlmContextError:',
    '    raise SystemExit(0)',
    'raise SystemExit(1)',
  ].join('\n')
  try {
    const result = spawnSync(pythonCmd, ['-c', script, kernelPath, contextPath, replacementPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'path replacement must be a typed context failure; stderr: ' + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M5 Issue#31: an owned timeout restores JSON-safe globals and checkpointed managed context in a new kernel', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m5-context-'))
  const contextPath = path.join(dir, 'context.txt')
  writeFileSync(contextPath, 'checkpointed context', 'utf8')
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000, maxContextBytes: 1024 * 1024 })
  try {
    const first = await runtime.eval('m5-recover', {
      code: 'm5_value = {"items": [1, True], "label": "saved"}\nimport os\nos.getpid()',
      contextPath,
    })
    const firstPid = Number(first.result)
    assert.ok(first.recovery?.checkpointCommitted, 'successful cell must publish the private checkpoint')
    await assert.rejects(
      runtime.eval('m5-recover', { code: 'import time\ntime.sleep(1)', timeout: 100 }),
      (err: unknown) => err instanceof RlmError && err.kind === 'timeout',
    )
    writeFileSync(contextPath, 'changed source', 'utf8')
    const restored = await runtime.eval('m5-recover', {
      code: '[m5_value, context, context_meta["bytes"], await rlm_query_batched([]), __import__("os").getpid()]',
    })
    assert.match(restored.result ?? '', /^\[\{'items': \[1, True\], 'label': 'saved'\}, 'checkpointed context', 20, \[\], \d+\]$/)
    assert.ok(restored.recovery?.restored, 'replacement kernel must report recovery')
    const restoredPid = Number(restored.result!.match(/(\d+)\]$/)?.[1])
    assert.ok(Number.isInteger(restoredPid) && restoredPid > 0 && restoredPid !== firstPid, 'timeout must use a fresh PID')
    await assert.rejects(
      runtime.eval('m5-recover', { code: 'm5_value["label"] = "after-restore"\nraise RuntimeError("keep live mutation")' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
    const later = await runtime.eval('m5-recover', { code: 'm5_value["label"]' })
    assert.equal(later.result, 'after-restore', 'restore must be consumed once, not replayed before every cell')
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M5 Issue#31: caller cancellation deletes the private checkpoint instead of restoring it', async () => {
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000 })
  try {
    await runtime.eval('m5-cancel', { code: 'm5_cancel_value = "must disappear"' })
    const controller = new AbortController()
    const running = runtime.eval('m5-cancel', { code: 'import time\ntime.sleep(5)', signal: controller.signal })
    setTimeout(() => controller.abort('test cancellation'), 50)
    await assert.rejects(running, (err: unknown) => err instanceof RlmError && err.kind === 'cancel')
    await assert.rejects(
      runtime.eval('m5-cancel', { code: 'm5_cancel_value' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
  }
})

// ---- M6 Issue #33: Session-local manual reset ----

test('M6 Issue#33 RED: reset replaces one Session kernel and drops its M3 context and M5 checkpoint', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m6-reset-'))
  const contextPath = path.join(dir, 'context.txt')
  writeFileSync(contextPath, 'M6 managed context', 'utf8')
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000, maxContextBytes: 1024 * 1024 })
  try {
    const before = await runtime.eval('m6-reset', {
      code: 'm6_marker = "discard me"\n__import__("os").getpid()',
      contextPath,
    })
    const oldPid = Number(before.result)
    assert.ok(Number.isInteger(oldPid) && oldPid > 0, 'expected a live pre-reset kernel PID')
    assert.ok(before.recovery?.checkpointCommitted, 'the pre-reset state must be checkpointed for the M5 boundary')

    const acknowledgement = await runtime.eval('m6-reset', manualReset())
    assert.equal(acknowledgement.stdout, '')
    assert.equal(acknowledgement.result, 'RLM state reset')
    assert.equal(acknowledgement.truncated, false)

    const fresh = await runtime.eval('m6-reset', {
      code: '[__import__("os").getpid(), "m6_marker" in globals(), "context" in globals()]',
    })
    assert.match(fresh.result ?? '', /^\[\d+, False, False\]$/)
    const freshPid = Number((fresh.result ?? '').match(/^\[(\d+),/)?.[1])
    assert.ok(Number.isInteger(freshPid) && freshPid > 0 && freshPid !== oldPid, 'reset must lazily use a new Python PID')

    await assert.rejects(runtime.eval('m6-reset', { code: 'import time\ntime.sleep(1)', timeout: 100 }))
    await assert.rejects(
      runtime.eval('m6-reset', { code: 'm6_marker' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M6 Issue#33 RED: reset is FIFO within one Session and never resets a sibling Session', async () => {
  const runtime = rt({ timeout: 8_000 })
  try {
    await runtime.eval('m6-a', { code: 'm6_a = "discard"' })
    await runtime.eval('m6-b', { code: 'm6_b = "keep"' })
    const gates = Array.from({ length: 4 }, () => new Deferred<string>())
    const started: string[] = []
    const first = runtime.eval('m6-a', {
      code: 'await rlm_query_batched(["hold-0", "hold-1", "hold-2", "hold-3"])\nm6_first_finished = True',
      onQuery: async (prompt) => {
        started.push(prompt)
        return gates[Number(prompt.slice(-1))].promise
      },
    })
    await until(() => started.length === 4)
    assert.deepEqual(started, ['hold-0', 'hold-1', 'hold-2', 'hold-3'])
    const reset = runtime.eval('m6-a', manualReset())
    const afterReset = runtime.eval('m6-a', { code: 'm6_a' })
    void afterReset.catch(() => {})
    let resetSettled = false
    reset.then(() => { resetSettled = true }, () => { resetSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(resetSettled, false, 'reset must wait behind the accepted same-Session cell')
    assert.equal((await runtime.eval('m6-b', { code: 'm6_b' })).result, 'keep', 'a sibling Session must remain independent')
    for (const [index, gate] of gates.entries()) gate.resolve('released-' + index)
    await first
    await reset
    await assert.rejects(
      afterReset,
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
  }
})

test('M6 Issue#33 RED: pre-aborted and queued reset cancellation leave the existing Session state untouched', async () => {
  const runtime = rt({ timeout: 8_000 })
  try {
    await runtime.eval('m6-cancel', { code: 'm6_marker = "keep"' })
    const preAborted = new AbortController()
    preAborted.abort('before reset')
    await assert.rejects(
      runtime.eval('m6-cancel', manualReset(preAborted.signal)),
      (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
    )
    assert.equal((await runtime.eval('m6-cancel', { code: 'm6_marker' })).result, 'keep')

    const gate = new Deferred<string>()
    let running = false
    const first = runtime.eval('m6-cancel', {
      code: 'await rlm_query("hold")',
      onQuery: async () => {
        running = true
        return gate.promise
      },
    })
    await until(() => running)
    const queuedAbort = new AbortController()
    const reset = runtime.eval('m6-cancel', manualReset(queuedAbort.signal))
    queuedAbort.abort('while queued')
    await assert.rejects(
      reset,
      (err: unknown) => err instanceof RlmError && err.kind === 'cancel',
    )
    gate.resolve('released')
    await first
    assert.equal((await runtime.eval('m6-cancel', { code: 'm6_marker' })).result, 'keep')
  } finally {
    await runtime.dispose()
  }
})

test('M6 Issue#33: an active reset completes its owned cleanup barrier after caller cancellation', async () => {
  const runtime = rt({ timeout: 8_000 })
  try {
    await runtime.eval('m6-active-reset', { code: 'm6_marker = "discard"' })
    const kernel = (runtime as any).kernels.get('m6-active-reset') as { dispose: () => Promise<void> }
    assert.ok(kernel, 'seed must create the owned Session kernel')
    const originalDispose = kernel.dispose.bind(kernel)
    const barrier = new Deferred<void>()
    let cleanupStarted = false
    kernel.dispose = async () => {
      cleanupStarted = true
      await barrier.promise
      await originalDispose()
    }
    const controller = new AbortController()
    const reset = runtime.eval('m6-active-reset', manualReset(controller.signal))
    await until(() => cleanupStarted)
    controller.abort('after reset activation')
    barrier.resolve()
    assert.equal((await reset).result, 'RLM state reset')
    await assert.rejects(
      runtime.eval('m6-active-reset', { code: 'm6_marker' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
  }
})

test('M5 Issue#31: unsupported globals are omitted and reported without exposing their values', async () => {
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000 })
  try {
    const first = await runtime.eval('m5-skipped', { code: 'm5_supported = "kept"\nm5_unsupported = lambda: "secret"' })
    assert.ok(first.recovery?.checkpointCommitted)
    assert.ok(first.recovery?.skipped?.some((item) => item.startsWith('m5_unsupported: unsupported function')))
    await assert.rejects(runtime.eval('m5-skipped', { code: 'import time\ntime.sleep(1)', timeout: 100 }))
    const restored = await runtime.eval('m5-skipped', { code: 'm5_supported' })
    assert.equal(restored.result, 'kept')
    await assert.rejects(
      runtime.eval('m5-skipped', { code: 'm5_unsupported' }),
      (err: unknown) => err instanceof RlmError && err.kind === 'eval',
    )
  } finally {
    await runtime.dispose()
  }
})

test('M5 Issue#31 RED: a lone-surrogate global is skipped without crashing checkpoint publication', async () => {
  const runtime = rt({ snapshotRecovery: true, timeout: 5_000 })
  try {
    await runtime.eval('m5-surrogate', { code: 'm5_prior = "kept"' })
    const out = await runtime.eval('m5-surrogate', { code: 'm5_surrogate = "\\ud800"\nm5_surrogate_key = {"\\ud800": 1}' })
    assert.equal(out.recovery?.checkpointCommitted, true)
    assert.ok(out.recovery?.skipped?.some((item) => item.startsWith('m5_surrogate: invalid UTF-8 string')))
    assert.ok(out.recovery?.skipped?.some((item) => item.startsWith('m5_surrogate_key: invalid UTF-8 dictionary key')))
    await assert.rejects(runtime.eval('m5-surrogate', { code: 'import time\ntime.sleep(1)', timeout: 100 }))
    assert.equal((await runtime.eval('m5-surrogate', { code: 'm5_prior' })).result, 'kept')
  } finally {
    await runtime.dispose()
  }
})

test('M5 Issue#31 RED: corrupt checkpoint context metadata and deep JSON fail closed as typed snapshot errors', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-m5-corrupt-'))
  const metadataPath = path.join(dir, 'metadata.json')
  const deepPath = path.join(dir, 'deep.json')
  const surrogatePath = path.join(dir, 'surrogate.json')
  const nonStringPath = path.join(dir, 'non-string-path.json')
  writeFileSync(metadataPath, JSON.stringify({
    version: 1,
    variables: {},
    context: { text: 'abc', meta: { kind: 'file', path: path.join(dir, 'source.txt'), bytes: 999 } },
  }))
  writeFileSync(deepPath, '{"version":1,"variables":{"x":' + '['.repeat(1200) + '0' + ']'.repeat(1200) + '},"context":null}')
  writeFileSync(surrogatePath, '{"version":1,"variables":{},"context":{"text":"\\ud800","meta":{"kind":"file","path":"' + path.join(dir, 'source.txt').replaceAll('\\', '\\\\') + '","bytes":1}}}')
  writeFileSync(nonStringPath, JSON.stringify({ version: 1, variables: {}, context: { text: 'x', meta: { kind: 'file', path: 7, bytes: 1 } } }))
  const script = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("rlm_kernel_under_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'assert spec.loader is not None',
    'spec.loader.exec_module(module)',
    'for checkpoint in sys.argv[2:]:',
    '    try:',
    '        module.RlmKernel()._restore_checkpoint(checkpoint, 1024 * 1024)',
    '    except module.RlmSnapshotError:',
    '        continue',
    '    raise SystemExit(1)',
  ].join('\n')
  try {
    const result = spawnSync(pythonCmd, ['-c', script, kernelPath, metadataPath, deepPath, surrogatePath, nonStringPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'corrupt checkpoints must become typed snapshot errors; stderr: ' + result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
