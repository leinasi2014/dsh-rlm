import test from 'node:test'
import assert from 'node:assert/strict'
import { createRlmRuntime, RlmError } from '../src/runtime.ts'

test('Issue#64: rejected oversized eval does not consume pending snapshot restore', async () => {
  const runtime = createRlmRuntime(undefined, { snapshotRecovery: true, timeout: 8_000 })
  try {
    const saved = await runtime.eval('issue64-restore-admit', { code: 'keep = 41' })
    assert.equal(saved.recovery?.checkpointCommitted, true)

    await assert.rejects(
      runtime.eval('issue64-restore-admit', { code: 'import os\nos._exit(13)' }),
      (error: unknown) => error instanceof RlmError && error.kind === 'closed',
    )

    await assert.rejects(
      runtime.eval('issue64-restore-admit', { code: '#' + 'x'.repeat(300_000) }),
      (error: unknown) => error instanceof RlmError && error.kind === 'protocol',
    )

    const restored = await runtime.eval('issue64-restore-admit', { code: 'keep + 1' })
    assert.equal(restored.result, '42')
    assert.equal(restored.recovery?.restored, true)
  } finally {
    await runtime.dispose()
  }
})
