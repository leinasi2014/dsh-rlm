/**
 * M12 official Jobs consumer (Issue #84): one bounded RLM background job per
 * Session with the same query bridge as foreground rlm_eval. Private boundary.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RlmError, type RlmCodeEvalInput, type RlmPluginConfig } from './model.ts'
import { buildRlmCodeEvalInput, continuableParentsFor } from './bridge.ts'
import type { RlmRuntime } from './session.ts'


export type RlmJobsLike = {
  attachController(name: string): () => void
  start(spec: RlmJobStartInput): unknown
}
export type RlmJobHooks = {
  cancel(reason?: string): void
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
  readOutput?(): string
}
export type RlmJobStartInput = {
  kind: string
  label: string
  outputLimitBytes?: number
  owner?: unknown
  run(): RlmJobHooks
}

/** Issue #86: at most one active RLM job per Session on one runtime. */
export const activeJobLocks = new WeakMap<RlmRuntime, Map<string, number>>()

/** Release every per-Session job slot of a runtime on disposal (Issue #86). */
export function releaseRuntimeJobSlots(runtime: RlmRuntime): void {
  activeJobLocks.delete(runtime)
}

export function acquireJobSlot(runtime: RlmRuntime, sessionKey: string): void {
  let locks = activeJobLocks.get(runtime)
  if (locks === undefined) {
    locks = new Map()
    activeJobLocks.set(runtime, locks)
  }
  const active = locks.get(sessionKey) ?? 0
  if (active > 0) {
    throw new RlmError('busy', 'one RLM job is already active for this Session: ' + sessionKey)
  }
  locks.set(sessionKey, active + 1)
}

export function releaseJobSlot(runtime: RlmRuntime, sessionKey: string): void {
  const locks = activeJobLocks.get(runtime)
  const active = locks?.get(sessionKey)
  if (locks === undefined || active === undefined) return
  if (active <= 1) locks.delete(sessionKey)
  else locks.set(sessionKey, active - 1)
}


/** One official DSH background job running one RLM cell through the same runtime. */
export interface RlmJobSpecOptions {
  /** True when the caller already reserved this Session's job slot. */
  preReserved?: boolean
  /** Builds the full cell input sharing the foreground query/spawn bridge (Issue #78). */
  buildInput?: (signal: AbortSignal) => RlmCodeEvalInput
}

export function createRlmJobSpec(
  parent: Agent,
  code: string,
  runtime: RlmRuntime,
  options: RlmJobSpecOptions = {},
): RlmJobStartInput {
  const key = String(parent.id)
  let hooks: RlmJobHooks | undefined
  return {
    kind: 'rlm',
    label: 'rlm_eval job: ' + code.slice(0, 80),
    outputLimitBytes: 64 * 1024,
    owner: parent,
    run() {
      if (hooks !== undefined) return hooks
      const controller = new AbortController()
      let captured = ''
      let slotAcquired = options.preReserved === true
      const done: RlmJobHooks['done'] = Promise.resolve()
        .then(() => {
          if (!slotAcquired) {
            acquireJobSlot(runtime, key)
            slotAcquired = true
          }
          return runtime.eval(key,
            options.buildInput ? options.buildInput(controller.signal) : { code, signal: controller.signal })
        })
        .then(
          (out) => {
            captured = (out.stdout ?? '') + (out.result === undefined ? '' : '\n' + out.result)
            return { status: 'completed' as const, output: captured }
          },
          (err: unknown) => ({
            status: err instanceof RlmError && err.kind === 'cancel' ? 'killed' as const : 'failed' as const,
            detail: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => {
          if (slotAcquired) releaseJobSlot(runtime, key)
        })
      hooks = {
        cancel(reason?: string) {
          if (!controller.signal.aborted) controller.abort(reason ?? 'job cancelled')
        },
        done,
        readOutput() {
          const out = captured
          captured = ''
          return out
        },
      }
      return hooks
    },
  }
}

/** Start one official DSH background job running this RLM cell (M12 consumer path). */
export function startRlmJob(
  ctx: Context,
  parent: Agent,
  code: string,
  runtime: RlmRuntime,
): unknown {
  const jobs = readJobsService(ctx)
  if (!jobs || typeof jobs.start !== 'function') {
    throw new RlmError('eval', 'background jobs unavailable: no ctx.jobs service is mounted')
  }
  // Issue #86: reserve the per-Session slot before the official registry admits
  // the job, so a second same-Session start is rejected before any misleading
  // running record can persist. The slot is released when the job settles.
  const sessionKey = String(parent.id)
  acquireJobSlot(runtime, sessionKey)
  try {
    const config = (runtime.runtimeConfig?.() ?? {}) as RlmPluginConfig
    const spec = createRlmJobSpec(parent, code, runtime, {
      preReserved: true,
      // Issue #78: a background RLM job gets the same query/spawn/followup
      // bridge, per-cell token guard, and Session identity as foreground
      // rlm_eval instead of a bare Python cell.
      buildInput: (signal) => buildRlmCodeEvalInput(ctx, config, parent, signal, continuableParentsFor(ctx), code),
    })
    const wrapped: RlmJobStartInput = {
      ...spec,
      run() {
        const hooks = spec.run()
        return { ...hooks, done: hooks.done.finally(() => releaseJobSlot(runtime, sessionKey)) }
      },
    }
    return jobs.start(wrapped)
  } catch (err) {
    releaseJobSlot(runtime, sessionKey)
    throw err
  }
}

/** Register the 'rlm' job controller when the DSH jobs surface is mounted (M12). */
export function readJobsService(ctx: Context): RlmJobsLike | undefined {
  // Non-strict lazy read first: cordis throws on undeclared property access,
  // so a missing jobs service must never break a jobs-less profile.
  const accessor = ctx as unknown as { get?: (key: string, strict?: boolean) => unknown; jobs?: RlmJobsLike } | undefined
  let jobs: RlmJobsLike | undefined
  if (typeof accessor?.get === 'function') {
    try { jobs = accessor.get('jobs', false) as RlmJobsLike | undefined } catch { jobs = undefined }
  }
  if (!jobs) {
    try { jobs = accessor?.jobs } catch { jobs = undefined }
  }
  return jobs && typeof jobs.attachController === 'function' ? jobs : undefined
}

export function attachRlmJobController(ctx: Context): (() => void) | undefined {
  const jobs = readJobsService(ctx)
  if (!jobs) return undefined
  return jobs.attachController('rlm')
}

