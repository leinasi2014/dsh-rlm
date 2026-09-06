import test from 'node:test'
import assert from 'node:assert/strict'
import { createRlmJobSpec, RlmError, type RlmEvalInput, type RlmEvalOutput, type RlmRuntime } from '../src/runtime.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

function parent(id: string): Agent {
  return { id } as unknown as Agent
}

class ControlledRuntime implements RlmRuntime {
  readonly calls: Array<{
    sessionKey: string
    input: RlmEvalInput
    resolve: (out: RlmEvalOutput) => void
    reject: (error: unknown) => void
  }> = []
  disposeCalls = 0

  eval(sessionKey: string, input: RlmEvalInput): Promise<RlmEvalOutput> {
    return new Promise<RlmEvalOutput>((resolve, reject) => {
      this.calls.push({ sessionKey, input, resolve, reject })
      input.signal?.addEventListener('abort', () => {
        reject(new RlmError('cancel', String(input.signal?.reason ?? 'cancelled')))
      }, { once: true })
      if (input.signal?.aborted) reject(new RlmError('cancel', String(input.signal.reason ?? 'cancelled')))
    })
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1
    return Promise.resolve()
  }
}

test('Issue#60/#74: createRlmJobSpec is inert until the official registry calls run()', async () => {
  const runtime = new ControlledRuntime()
  const spec = createRlmJobSpec(parent('job-inert'), '40 + 2', runtime)
  assert.equal(runtime.calls.length, 0, 'spec construction must not start or queue the RLM cell')

  const hooks = spec.run()
  await Promise.resolve()
  assert.equal(runtime.calls.length, 1, 'run() is the first point allowed to call runtime.eval')
  runtime.calls[0]!.resolve({ stdout: '', result: '42', truncated: false })
  assert.deepEqual(await hooks.done, { status: 'completed', output: '\n42' })
})

test('Issue#59/#74: killing one job aborts only that cell and never disposes the shared runtime', async () => {
  const runtime = new ControlledRuntime()
  const hooks = createRlmJobSpec(parent('job-cancel'), 'await something()', runtime).run()
  await Promise.resolve()
  assert.equal(runtime.calls.length, 1)
  assert.ok(runtime.calls[0]!.input.signal, 'job cell must receive an owned AbortSignal')

  hooks.cancel('user killed job')
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'user killed job' })
  assert.equal(runtime.disposeCalls, 0, 'job cancellation must not terminate sibling Session kernels')
})

test('Issue#59/#74: cancelling one job leaves a sibling job on the same runtime alive', async () => {
  const runtime = new ControlledRuntime()
  const a = createRlmJobSpec(parent('job-a'), '1', runtime).run()
  const b = createRlmJobSpec(parent('job-b'), '2', runtime).run()
  await Promise.resolve()
  assert.equal(runtime.calls.length, 2)

  a.cancel('stop a')
  assert.equal((await a.done).status, 'killed')
  assert.equal(runtime.disposeCalls, 0)
  assert.equal(runtime.calls[1]!.input.signal?.aborted, false, 'sibling job signal must stay live')

  runtime.calls[1]!.resolve({ stdout: 'b', result: '2', truncated: false })
  assert.deepEqual(await b.done, { status: 'completed', output: 'b\n2' })
})
