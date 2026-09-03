# M9 Sandbox-Backed Kernel Architecture

> English (authoritative) | [简体中文](m9-sandboxed-kernel.zh-CN.md) | [Interactive diagram](m9-sandboxed-kernel.html)

## Outcome

M9 replaces the bare host spawn of a Session Python kernel with a spawn that runs
under the DSH process sandbox, reusing the official `ctx.sandbox` backends
(bwrap / Landlock on Linux, Seatbelt on macOS, ACL restricted-token on Windows)
and the per-session policy from `ctx.sandboxPolicy`. This is the selected route
**A** revision of the conditional second-kernel extension: the kernel stays one
same-world process per Session, but its file effects now follow the same
`read-only` / `workspace-write` / `danger-full-access` ladder as every other
confined DSH capability. No container, microVM, remote executor, or public
`KernelDriver` interface is introduced.

A new `kernelSandbox` plugin option selects the behavior:

- `auto` (default): confine the kernel when the loaded runtime exposes the
  official sandbox services and a backend is usable; otherwise keep the accepted
  unconfined argv and surface `sandbox: none` once.
- `require`: fail with a typed error before any Python starts when the sandbox
  is unavailable; unconfined execution is never silently allowed.
- `off`: preserve the accepted M1-M8 behavior exactly (trusted local execution).

## Authority and API

The executable authority is the exact loaded DSH Profile runtime, checked
against the installed `@deepseek-ai/dsh-sandbox*` types and the fresh official
upstream checkout. Relevant upstream facts:

- `ctx.sandbox.confine(argv, policy)` (`@deepseek-ai/dsh-sandbox` seam,
  `@deepseek-ai/dsh-sandbox-local` backend) returns `ConfinedArgv` containing
  the wrapped argv plus `enforcement` (`full` / `partial`),
  `denialSignatures`, and `runnerFailureRules`. The consumer spawns that argv;
  everything the launched process spawns remains confined. If no backend is
  usable it throws `SandboxUnavailableError` - a command never runs unconfined.
- `ctx.sandboxPolicy.resolve({ session })` (`@deepseek-ai/dsh-sandbox-policy`)
  returns `{ mode, workspaceRoot, sessionId? }`. The deployment default mode
  (base default `workspace-write`; fail-safe `read-only`) plus the session
  immutable `cwd` as the workspace root, with a session `sandbox/mode`
  override folded from the Session log so it survives restart.
- `danger-full-access` bypasses confinement and returns the caller argv
  unchanged, which is exactly the accepted behavior.

The plugin adds `sandbox` and `sandboxPolicy` as optional service injections
and resolves the policy from the same Session that owns the kernel. The M2
fixed environment allowlist is unchanged; Windows already allowlists
`TEMP`/`TMP`, which the ACL runner rewrites for confined children.

## State and failure semantics

1. The first `rlm_eval` in a Session resolves the current policy once and calls
   `confine` once; the returned argv is what the runtime spawns. Timeout,
   cancellation, protocol frames, disposal, and process-tree kill semantics are
   unchanged because the wrapped argv still yields one child process.
2. **Birth-mode pinning.** The sandbox profile is fixed at spawn (mounts, ACL
   token). A later session-wide mode switch does not re-confine a running
   kernel; it takes effect on the next kernel (M6 reset). A switch intended to
   stiffen a running kernel is an explicit limitation: advise reset.
3. `require` plus an unusable backend fails closed before child admission or
   subagent dispatch. `auto` plus an unusable backend falls back to the legacy
   spawn and reports `sandbox: none` on kernel start; it never invents
   confinement that is not enforced.
4. `partial` enforcement (Windows ACL rung, older Landlock ABIs) is surfaced per
   kernel start and never presented as full isolation.
5. Runtime denials surface as ordinary Python `OSError` (EROFS / EACCES /
   EPERM) and therefore as typed cell errors; `denialSignatures` are used only
   for host diagnostics and never change cell semantics.
6. M3 context loading is a read-only operation and remains allowed in every
   mode. M5 checkpoint files and publication remain host-side and stay outside
   the kernel confinement. M5 recovery starts a new kernel, which re-resolves
   the current policy; M6 reset likewise. M7 batches and M8 continuable
   children are host-side and unaffected.

## Limits and non-goals

M9 is same-world confinement only: the host kernel and filesystem are shared,
reads and network are not confined, and Windows does not hide host process
visibility (partial). It adds no container/remote executor, microVM, provider
abstraction, custom runner, per-call escalation of a live kernel, resource
limits (CPU/memory), network egress control, or public `KernelDriver`
interface. A container/remote kernel remains a separate conditional extension
(route B) and starts only from its own architecture contract and diagram.

## TDD acceptance contract

1. **RED:** the accepted M8 runtime spawns the kernel argv without consulting any
   sandbox service (an injected sandbox stub observes zero confine calls).
2. **GREEN:** with the official services mounted, the runtime resolves the owning
   Session policy, calls `confine` exactly once per kernel start, and spawns
   the returned argv; the spawned process facts prove confinement.
3. **GREEN:** `require` with no usable backend fails typed before spawn with no
   kernel and no child admission; `auto` falls back and surfaces `none`;
   `off` keeps the legacy path byte-for-byte.
4. **Behavior:** under resolved `workspace-write`, a cell write under
   `workspaceRoot` succeeds and a write outside it fails with `OSError`;
   `read-only` denies writes; `danger-full-access` remains unconfined.
5. **Lifecycle:** reset and recovery re-resolve and re-confine; dispose kills only
   the owned confined tree; M2 serialization/limits and M5/M6/M7/M8 boundaries
   remain green; sandbox metadata is non-secret and never carries policy text
   into Python.
6. **Clean Profile:** a disposable installed Profile (base/headless bundle, this
   host backend) proves a confined kernel end to end: in-workspace write OK,
   out-of-workspace write denied under `workspace-write`, typed error, and the
   Session log records the bounded result. Prefer DSV4-FVE; during outage record
   the GLM fallback and re-run DSV4-FVE after recovery.
