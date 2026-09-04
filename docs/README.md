# dsh-rlm Documentation

> English | [简体中文](README.zh-CN.md)

1. [Project status](project-status.md): goal, delivered milestones, open work, and the publication baseline.
2. [Core and target architecture](architecture.md): the delivered loop and ordered M3/M4 boundary.
3. [Review findings](review-findings.md): implementation, algorithm, architecture, and reference-project audit results.
4. [Milestones](milestones.md): delivered M1-M8; later capabilities stay trigger-gated.
5. [Future extensions](future-extensions.md): capabilities added only after their real trigger exists.
6. [Directory structure](directory-structure.md): the minimal TypeScript/Python source boundary.
7. [Reference analysis](reference-analysis.md): what was adopted from and rejected from the two pinned references.
8. [GitHub Issue repair playbook](issue-repair-playbook.md): reasoning-effort tiers, repair workflow, evidence, review, Git, and closure rules.
9. [Development memory](development-memory/README.md): append-only per-agent implementation, repair, test, and review evidence.
10. [Interactive architecture diagram](dsh-rlm-architecture.html): the English-first core-loop visualization generated from `dsh-rlm-architecture.archify.json`.
11. [M3 Managed Context](m3-managed-context.md): managed file loading, atomicity, limits, and isolation.
12. [M4 Recursive Child RLM](m4-recursive-child-rlm.md): official depth authority, child kernels, and branch lifecycle.
13. [M3/M4 development contract](m3-m4-development-contract.md): TDD, dogfood, review, Issue, Git, and live gates.

14. [M5 Session Snapshot Recovery](m5-session-snapshot-recovery.md): opt-in checkpoint restore after owned kernel loss.
15. [M6 Manual Reset](m6-manual-reset.md): Session-local FIFO reset through the existing `rlm_eval` route.
16. [M7 Batched Query](m7-batched-query.md): bounded ordered concurrent `rlm_query_batched`.
17. [M8 Continuable Spawn](m8-continuable-spawn.md): official continuable child Sessions with parent inbox delivery.
18. [M9 Sandbox-Backed Kernel](m9-sandboxed-kernel.md): policy-confined kernel via `ctx.sandbox`, host-private chunked M5 checkpoint (protocol v4).
19. [M10 Cross-Host Durable Persistence](m10-cross-host-persistence.md): opt-in `durableRoot` references with versioned restore.
20. [M11 Token Guard](m11-token-guard.md): per-cell observed-token guard on official `tokenMeter`.
21. [M12 Job Consumer](m12-jobs-ui-swarm.md): official `ctx.jobs` `rlm` controller; swarm stays trigger-gated.

Each authoritative English document has a `.zh-CN.md` Chinese counterpart.
