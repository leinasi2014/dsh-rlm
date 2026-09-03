# M5 交付契约

> [English（权威版本）](m5-development-contract.md) | 简体中文

本契约只约束在已接受 M4 `main` 基线上完成
[M5 会话快照恢复](m5-session-snapshot-recovery.md)。它继承仓库的 TDD、上游、开发记忆、访问、
Git 和干净 Profile 门禁。

## 交付顺序

1. 保留真实状态丢失复现，独立审计 M5 边界，并合入英文为主契约、中文镜像和已校验架构图。
2. 将复现转为跨进程的失败 RED 恢复测试；为每项契约行为补最小 kernel/runtime 测试。
3. 实现私有 checkpoint 接缝，不改变一工具/一循环的 DSH 权威边界。
4. 完成聚焦测试、全量检查、独立语义审查、GitHub CI、远端 main 回读及新鲜已安装插件的 DSV4-FVE
   Profile smoke。

一个 Issue 负责 M5。dogfood 的偶发发现必须单独复现并建 Issue；除非阻塞恢复，否则不能扩大本 Candidate。

## 必需证据

- 每次生产或测试修改前立即通过官方 DSH upstream gate。
- M5 代码存在前，新 PID 缺失状态的 RED 证据。
- 合格致命故障恢复、context 完整性、原子失败、取消/卸载删除与 Session/递归隔离的 GREEN 证据。
- 断言 checkpoint 行为时，测试必须走真实 Python 进程/协议边界；mock 只能补充，不能替代。
- 真实验收使用一次性 DSH home、安装本地包、开启 `snapshotRecovery`、固定配置的
  `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC 路由，并确认环境 settings/credentials 未被改动。

## Candidate 边界

允许的生产面仅为 `src/runtime.ts`、`python-runtime/rlm_kernel.py`，若 tool-result/config 接线必需
才允许修改 `src/index.ts`。测试仍在既有两个测试文件中。M5 Candidate 禁止引入框架、公开 service、
Storage Domain、新模型可见工具、Provider abstraction、UI、job 或 DSH API shortcut。

每位实质参与者必须在 `docs/development-memory/records/2026/issue-31.jsonl` 记录语义指针与精确证据。
独立审查者只读；任何行为性发现都必须先创建 successor RED，之后才能修正。

