# M7 交付契约

> [English（权威版本）](m7-development-contract.md) | 简体中文

本契约只约束已接受 M6 `main` 基线上的 [M7 有界有序批量查询](m7-batched-query.zh-CN.md)。它继承仓库的 upstream、权限、TDD、开发记忆、审查、Git、CI 与干净 Profile 门禁。

## 交付顺序

1. 冻结并独立审查 M7 架构及已检查架构图；保留证明 M6 不具备该 helper 的 kernel/Profile RED。
2. 先写最小 kernel/protocol RED：严格输入、四路准入、乱序回复仍有序、错误 drain、错误后可复用。
3. 再写 runtime lifecycle RED：观测 child work 不超过四，并证明 `maxQueries`、direct Python task cancellation、cell cancellation、timeout、kernel exit、fatal protocol loss、reset、unload cleanup。reset 必须 FIFO 等待 batch；合格 M5 fatal recovery 行为不变。
4. 仅实现最小私有 Python helper 和 protected-scaffold/M5 处理；除非可执行测试证明需要，不扩张 runtime API。
5. 运行全门禁、独立语义审查、GitHub CI、remote-main read-back 与新安装插件 DSH Profile smoke。

一个 Issue 拥有 M7；dogfood 发现默认单独复现、分类、建 Issue，除非阻塞本契约。

## 必须证据

- 每次生产代码或测试修改紧前，针对选定干净 upstream checkout 运行官方 DSH upstream gate。
- RED 必须因预期的缺失 M7 行为失败；mock 可补充，但不能替代 Python process/protocol 或已安装 Profile 证据。
- GREEN 要证明：观测并发上限、乱序回复 index 保序、非法输入不 dispatch、两个反向完成失败后完整 drain 并返回较小 index 的确定性 failure、空输入及 mixed-batch query-cap 行为、既有 query cap、direct-Python-cancellation drain/re-raise 且无 unknown reply、kernel/protocol fatal cleanup finality、M5 scaffold/recovery 边界、M4 child-tool depth 行为与 Session 隔离。
- 干净 Profile 必须在 disposable DSH Home 中安装本地包，结构化证明官方 Session log 的 tool/result，并不留下插件进程。优先 DSV4-FVE vLLM/PTC；服务停用期间允许 `zai-coding-cn / glm-5.2`，但必须明确记录 outage，并在恢复后回归 DSV4-FVE。

## Candidate 边界

生产改动属于 `python-runtime/rlm_kernel.py`；只有已证实 lifecycle defect 才可触碰 `src/runtime.ts`。测试仍在既有两个测试文件。system prompt 只可补充 helper 的可见调用形状。禁止新工具 schema、public Service、Storage Domain、scheduler、provider abstraction、可配置 pool、UI、Job、workflow 或 DSH API shortcut。

每位实质贡献者都要把自己的 Issue #36 record 写进
`docs/development-memory/records/2026/issue-36.jsonl`。独立审查者只读；每个改变行为的发现都必须先创建 successor RED，才能再次修改生产代码。
