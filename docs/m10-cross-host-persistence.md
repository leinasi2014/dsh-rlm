# M10 Cross-Host Durable Session Persistence Architecture

> English (authoritative) | [简体中文](m10-cross-host-persistence.zh-CN.md) | [Interactive diagram](m10-cross-host-persistence.html)

## Outcome

M10 makes an opted-in subset of the M5 checkpoint survive a plugin restart or
move to another host. The runtime persists **only the bounded checkpoint reference**
(the host-private checkpoint bytes plus a versioned manifest) into a host-designated
durable root, never into the DSH Session log, model-visible tool data, or a public
service. On the next `rlm_eval` for the same official Session, a restored runtime can
find a durable reference and feed it into the existing M9 restore transport; a version
mismatch fails explicitly and never silently restores stale state.

M10 does NOT create Storage, Jobs, Workflow, a provider framework, or a task queue;
it adds one private host-side file boundary and reuses the existing
`rlm_eval` path.

## Authority and API

- New config: `durableRoot?: string` (absolute; optional). Absent or empty disables
  durable publication; the legacy ephemeral M5/M9 path is unchanged.
- The durable root is host-owned. The layout is one file per official Session id:
  `<durableRoot>/<sha256(sessionId)>.checkpoint.json` plus
  `<durableRoot>/<sha256(sessionId)>.meta.json` (schemaVersion, publishedAt, byte count,
  content sha-256). No Session id, checkpoint path, or value is model-visible.
- Publication is atomic: write temp + fsync + rename, exactly like M9 host-side
  checkpoint assembly. A partial or corrupt durable file never replaces a good one.
- Restore is one-shot and fail-closed: a runtime that finds a durable reference
  validates its manifest against the checkpoint bytes and the frozen schemaVersion;
  mismatches are typed `snapshot` failures and the Session starts fresh, never with
  guessed state.

## State and failure semantics

1. After an M5/M9 commit to the host-private checkpoint, the runtime also publishes
   the durable reference when `durableRoot` is configured. Both write paths share the
   same bounded limits (<= 8 MiB per Session, <= 64 MiB reserved root).
2. A new runtime instance (`plugin restart`, another host with the same root, or a
   fresh DSH process) resolves the same Session key and offers one-shot restore
   through the existing M9 chunked transport. The kernel never sees the durable path.
3. M6 reset and M5 recovery interplay: reset drops the ephemic checkpoint AND its
   durable reference; recovery restores from whichever valid source the runtime can
   read (private first, durable as fallback), without double publication.
4. Cancellation, timeout, and unload: unload leaves the durable reference intact;
   owned cancellation during a restore publishes nothing.
5. Cross-Session and sibling isolation: durable keys are per official Session; a
   corrupted file for one Session can never be restored into another.

## Limits and non-goals

M10 persists references, not live memory; it is not a second Session store, not
Storage Domain, not a Service, not encrypted-at-rest (host permission model only),
and not a guarantee of cross-OS path identity. It intentionally does not persist
Python object identity, credentials, DSH objects, spawned child state, or M8
continuable handles.

## TDD acceptance contract

1. **RED:** accepted M9 has no durable-root read/write; a test with `durableRoot`
   configured proves zero durable files (or the option is rejected).
2. **GREEN:** after a successful confined M5 commit with `durableRoot`, the durable
   manifest exists, is atomic, and contains no Session id/value/context text.
3. **GREEN:** a new runtime instance with the same root restores the same supported
   globals through the M9 transport for the same Session; version mismatch returns a
   typed `snapshot` failure and the next cell runs fresh.
4. **Boundaries:** M6 reset deletes the durable reference; sibling Sessions cannot
   restore each other; no model-visible path/value crosses the protocol.
5. **Clean Profile:** disposable installed Profile proves restart-resume end to end on
   the configured durable root (DSV4-FVE preferred; GLM fallback documented).
