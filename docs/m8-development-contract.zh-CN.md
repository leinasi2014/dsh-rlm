# M8 交付契约

> [English（权威）](m8-development-contract.md) | 简体中文

本契约约束 Issue #39 的 [M8 可继续 Spawn](m8-continuable-spawn.md)，前提是 M7 已在
`main` 接受；继承仓库的 upstream、权限、TDD、记忆、审查、Git、CI 与干净 Profile
门禁。

1. 先核验已安装类型和新鲜官方源码在 continuable / inbox 操作上兼容，并独立审查契约。
2. 在已接受 M7 上写 kernel/Profile RED，证明 helper 确实缺失。
3. 为不可快照的 opaque 同 Session capability、无效/跨 Session 无 dispatch、cell 后继续、follow-up
   FIFO、官方 inbox report/settlement、M4、M5/M6 和 unload drain 写 RED。
4. 只实现私有 helper 与既有 host bridge 必需的最小帧；禁止新 DSH tool 或自定义 manager。
5. 全量门禁、独立审查、CI、remote-main 回读和干净安装 smoke 后才接受。

每次改生产或测试前运行 `pnpm check:upstream`。mock 只能补充，不能代替真实 Python
JSON-lines 与官方 parent/child Session 证据。每位贡献者在 Issue #39 memory 中写自己的
记录；发现行为问题先建立 successor RED。
