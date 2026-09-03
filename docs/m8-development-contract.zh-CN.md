# M8 交付契约

> [English（权威）](m8-development-contract.md) | 简体中文

本契约约束 Issue #39 的 [M8 可继续 Spawn](m8-continuable-spawn.md)，前提是 M7 已在
`main` 接受；继承仓库的 upstream、权限、TDD、记忆、审查、Git、CI 与干净 Profile
门禁。

1. 记录 continuable / inbox 操作的精确已加载 Profile runtime 与新鲜官方源码；二者是不同的兼容性权威：当前 upstream runtime 暴露 host 专用的 `Symbol.for('dsh.subagent.deliverPrompt')` adapter，而随包的 `0.1.1-rc.2` 声明描述旧 public surface，且不导出该 internal entry。冻结 runtime capability gate 并独立审查契约。
2. 在已接受 M7 上写 kernel/Profile RED，证明 helper 确实缺失。
3. 为不可快照的 opaque 同 Session capability、无效/跨 Session 无 dispatch、cell 后继续、follow-up
   FIFO、官方 inbox report/settlement、M4、M5/M6 和 unload drain 写 RED。
4. 只实现私有 helper 与既有 host bridge 必需的最小帧；禁止新 DSH tool 或自定义 manager。
5. 全量门禁、独立审查、CI、remote-main 回读和干净安装 smoke 后才接受。

每次改生产或测试前运行 `pnpm check:upstream`。mock 只能补充，不能代替真实 Python
JSON-lines 与官方 parent/child Session 证据。每位贡献者在 Issue #39 memory 中写自己的
记录；发现行为问题先建立 successor RED。runtime 必须在路由 spawn 或 follow-up 前检测官方
host-delivery Symbol；缺失时以既有的类型化 `kind=query, phase=query` 路径失败，且不 admission child / dispatch。M8 只兼容提供该
Symbol 的已加载 DSH runtime；只暴露旧 public declarations 的 `0.1.1-rc.2` host 明确不受 M8
支持。已安装声明包只是编译期证据，不能证明此 host capability。
