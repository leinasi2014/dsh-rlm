# M9 Sandbox-Backed Kernel Architecture (Successor)

> English (authoritative) | [简体中文](m9-sandboxed-kernel.zh-CN.md) | [Interactive diagram](m9-sandboxed-kernel.html)

## Outcome

M9 (route A, revised after independent review) runs the Session Python kernel
inside the DSH process sandbox instead of a bare host spawn. It reuses
`ctx.sandbox` (bwrap / Landlock / Seatbelt / Windows ACL restricted-token) and
the per-session policy from `ctx.sandboxPolicy`. The kernel stays one
same-world process per Session; its file effects follow the same
`read-only` / `workspace-write` / `danger-full-access` ladder as every other
confined DSH capability. No container, microVM, remote executor, or public
`KernelDriver` interface is introduced.

New observable behavior, ratified as intentional M9 change:

- `kernelSandbox` option: `auto` (default), `require`, `off`.
- In base-backed profiles (which always mount sandbox + sandboxPolicy),
  `auto` confines the kernel by default; this is a deliberate change from
  the accepted M1-M8 trusted-local behavior and is recorded as such.
- The confined kernel starts with the session workspace root as its working
  directory, so relative Python paths resolve inside the workspace.
- Under confinement, the M5 checkpoint stays host-private: bytes go over
  bounded chunked protocol frames and the host atomically writes its own
  private temp file. The kernel never writes a sandbox-visible checkpoint.
- `read-only` still supports M5 because checkpointing no longer needs a
  writable file path.

## Authority and API

The executable authority is the exact loaded DSH Profile runtime. The plugin
obtains the services lazily with `ctx.get("sandbox")` and
`ctx.get("sandboxPolicy")`; they are NOT added to the `inject` list, which is
a required-service list. `@deepseek-ai/dsh-sandbox` and
`@deepseek-ai/dsh-sandbox-policy` are compile-time type authorities only.

- `ctx.sandbox.confine(argv, policy)` returns `ConfinedArgv`
  (`argv`, `enforcement` - `full` / `partial`, `denialSignatures`,
  `runnerFailureRules`). `SandboxUnavailableError` is thrown only when no
  runner chain is usable; on win32 the sole candidate is selected without a
  probe, so an unusable runner surfaces as a post-spawn runner failure that
  must be classified with `runnerFailureRules`, never as a denial.
- `ctx.sandboxPolicy.resolve({ session })` returns
  `{ mode, workspaceRoot, sessionId? }`: explicit approved mode, then the
  folded session `sandbox/mode` event, then the deployment default
  (base: `workspace-write`; fail-safe `read-only`). `workspaceRoot` is the
  session immutable `cwd`.
- `danger-full-access` returns the original argv unchanged = legacy
  unconfined path; M9 treats it as confined=false for publication semantics.

Kernel cwd contract (does not depend on runner inheritance): the host
spawns the confined argv with `cwd: resolved.workspaceRoot` and also sends
`workspaceRoot` in the init frame; the kernel changes its own working
directory before the first cell. Relative writes therefore land inside the
workspace under bwrap, Seastbelt, Landlock, and the Windows ACL runner alike.

M5 transport contract: protocol bump to v4 adds bounded chunked frames for
checkpoint publication and restore. Kernel emits chunks (each
<= MAX_FRAME_BYTES) with sequence numbers and a final SHA-256; the host
assembles, verifies, and atomically writes the host-private temp file
(temp + rename). Recovery reverses it: the host reads its private file and
sends chunks to the new kernel. `off` and `danger-full-access` keep the
legacy file-path mechanism unchanged.

## State and failure semantics

1. First `rlm_eval` resolves the policy once, calls `confine` exactly once,
   spawns the returned argv, and the kernel confirms its cwd before ready.
   Birth-mode pinning: a later session mode switch applies to the next
   kernel (M6 reset), never to a running one.
2. `require`: an unusable chain (`SandboxUnavailableError`) or a classified
   runner failure before any frame is a typed failure; the kernel is never
   admitted, no child work is admitted, and unconfined fallback is forbidden.
3. `auto`: same fail-closed behavior on runner failure (a broken sandbox is
   never silently bypassed); it falls back to the legacy unconfined path only
   when the sandbox services are absent from the composition.
4. `off`: exact legacy path, no policy resolution and no confine call.
5. `partial` enforcement (Windows ACL rung, older Landlock ABIs) is surfaced
   at kernel start and never presented as full isolation; Windows writes to
   Everyone-granted or hard-link-aliased targets remain possible.
6. Runtime denials surface as ordinary Python `OSError` (EROFS / EACCES /
   EPERM) and therefore as typed cell errors; `denialSignatures` are used
   only for host diagnostics.
7. M3 context reading is allowed in every mode. M6 reset re-resolves and
   re-confines. M7 batches and M8 continuable children are host-side.
8. When confined, a POSIX kernel env pins `TMPDIR` to `/tmp` (bwrap/Landlock
   temp root) so `tempfile` stays writable; the Windows ACL runner already
   rewrites `TMP`/`TEMP`. The M2 allowlist itself is unchanged.
9. Process cleanup: the PID the host sees may be the runner; the existing
   tree-kill path must terminate runner plus descendants (bwrap
   `--die-with-parent`, ACL child termination) — ownership stays one
   Session, and dispose/docs state it as acceptance.

## Limits and non-goals

Same-world confinement only: host kernel and filesystem are shared; reads and
network are not confined; Windows does not hide host process visibility
(partial). No container/microVM/remote executor (route B stays a separate
conditional extension with its own contract), no public `KernelDriver`
interface, no provider abstraction, no custom runner, no per-call escalation
of a live kernel, no CPU/memory limits, no network egress control. M5
checkpoint remains bounded (<= 8 MiB), in-process-lifetime only (no
host-restart promise).

## TDD acceptance contract (successor)

1. **RED (test-only):** with a constructible `ctx` stub exposing recording
   `sandbox` + `sandboxPolicy` services, the accepted M8 runtime consults
   them zero times; the assertion of exactly-one `confine` call per kernel
   start fails for the intended absence reason, with no production edits.
2. **GREEN:** runtime resolves policy once, calls `confine` exactly once per
   kernel start, spawns the returned argv with `cwd = workspaceRoot`, and the
   kernel proves `os.getcwd() == workspaceRoot` before the first cell.
3. **Behavior:** under `workspace-write`, a relative write inside `workspaceRoot`
   succeeds and a write outside (workspace root or closed-ACL target on
   Windows) fails with `OSError`; `read-only` denies writes;
   `danger-full-access` bypasses; `require` fails typed on runner failure;
   `auto` fails closed on runner failure and falls back only when services
   are absent; `off` is byte-for-byte legacy.
4. **M5 under confinement:** chunked checkpoint publication restores the same
   supported state; the host file lives in host-private temp; values and
   context text never appear in protocol-visible or model-visible data;
   `read-only` still publishes without any file write by the kernel.
5. **Lifecycle:** reset and recovery re-resolve; dispose kills the owned tree;
   M2 serialization/limits and M4/M6/M7/M8 boundaries stay green.
6. **Protocol:** v4 version negotiation; mismatch fails explicitly (M3 gate).
7. **Clean Profile:** a disposable installed profile proves confined kernel,
   workspace cwd, relative-write rules, and M5 restore end to end. Prefer
   DSV4-FVE; during outage record the GLM fallback and re-run after recovery.
