import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { createRlmRuntime } from '../src/runtime.ts'

const MiB = 1024 * 1024
const iterations = Math.max(3, Number.parseInt(process.env.RLM_SNAPSHOT_BENCH_ITERATIONS ?? '8', 10) || 8)
const sizes = [0.5, 2, 6]

type Sample = {
  mode: 'ephemeral' | 'durable'
  stateMiB: number
  p50Ms: number
  p95Ms: number
  eventLoopP95Ms: number
  peakHeapMiB: number
  durableRootBytes: number
  iterations: number
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

function directoryBytes(root: string | undefined): number {
  if (!root) return 0
  let total = 0
  for (const name of readdirSync(root)) {
    const info = statSync(path.join(root, name))
    if (info.isFile()) total += info.size
  }
  return total
}

async function run(mode: Sample['mode'], stateMiB: number): Promise<Sample> {
  const durableRoot = mode === 'durable' ? mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-bench-durable-')) : undefined
  const runtime = createRlmRuntime(undefined, {
    snapshotRecovery: true,
    ...(durableRoot ? { durableRoot } : {}),
    timeout: 60_000,
  })
  const delay = monitorEventLoopDelay({ resolution: 10 })
  const timings: number[] = []
  let peakHeap = process.memoryUsage().heapUsed
  try {
    const chars = Math.floor(stateMiB * MiB)
    const seed = await runtime.eval(`bench-${mode}-${stateMiB}`, { code: `state = 'x' * ${chars}` })
    if (seed.recovery?.checkpointCommitted !== true) throw new Error(`seed checkpoint failed for ${mode}/${stateMiB} MiB`)

    delay.enable()
    for (let i = 0; i < iterations; i++) {
      const started = performance.now()
      const out = await runtime.eval(`bench-${mode}-${stateMiB}`, { code: '1 + 1' })
      timings.push(performance.now() - started)
      if (out.result !== '2' || out.recovery?.checkpointCommitted !== true) throw new Error('benchmark cell failed')
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
    }
    delay.disable()

    return {
      mode,
      stateMiB,
      p50Ms: Number(percentile(timings, 0.5).toFixed(2)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(2)),
      eventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(2)),
      peakHeapMiB: Number((peakHeap / MiB).toFixed(2)),
      durableRootBytes: directoryBytes(durableRoot),
      iterations,
    }
  } finally {
    delay.disable()
    await runtime.dispose()
    if (durableRoot) rmSync(durableRoot, { recursive: true, force: true })
  }
}

const results: Sample[] = []
for (const stateMiB of sizes) {
  results.push(await run('ephemeral', stateMiB))
  results.push(await run('durable', stateMiB))
}

console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  results,
}, null, 2))
