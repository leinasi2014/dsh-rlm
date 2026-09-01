# Contributing to dsh-rlm

Thank you for helping improve the smallest useful RLM loop for DeepSeek Harness.

## Scope first

The accepted V1 boundary is defined by [docs/architecture.md](docs/architecture.md).
Please do not add a second Agent Loop, public service, storage framework,
checkpoint system, recursive child RLM, UI, Workflow, Jobs, or Provider registry
without a reproduced use case and an accepted architecture change.

Open reliability defects are tracked in GitHub Issues. Work on P1 lifecycle and
bounded-protocol issues takes priority over conditional future extensions.

## Development setup

Requirements:

- Node.js `^22.19.0` or `>=24`;
- pnpm `9.15.9`;
- Python 3.11+ available as `python` on `PATH`.

Install and run the default engineering checks:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node --test tests/rlm-loop.test.ts tests/profile-smoke.test.ts
```

The default test run is offline. The two Profile tests require an explicitly
configured DSH home and make real model calls; do not enable them casually.

## Change rules

- Keep the source layout small until a demonstrated responsibility boundary
  makes a split useful.
- Preserve official DSH Session, Agent, Tool, and Subagent authority.
- Keep Provider objects and credentials out of Python.
- Treat cancellation, timeout, process exit, protocol failure, and dispose as
  first-class state transitions.
- Add a focused regression test for every lifecycle or protocol defect.
- Preserve unrelated work and never modify `ref/*/source/`.
- Do not commit `lib/`, `node_modules/`, logs, coverage, Profiles, Session logs,
  credentials, or local reference checkouts.

## Pull requests

A pull request should include:

1. the user-visible or reliability outcome;
2. the issue it closes;
3. the affected architecture invariant;
4. tests run and their results;
5. documentation impact;
6. any limitation that remains.

Small working commits and narrowly scoped fixes are preferred over framework
scaffolding.
