# 后续扩展架构

> [English](future-extensions.md) | 简体中文

本文件不是 V1 待办清单。只有 [核心架构](architecture.zh-CN.md) 的真实 Profile
闭环通过后，且下表触发条件已经出现，才添加对应能力。

托管上下文、递归子 RLM、快照恢复与手动 reset 已成为有序的
[M3–M6](milestones.zh-CN.md) 契约。下表从 M6 之后仍需证据触发的能力开始。

## 不变边界

无论增加什么功能，都保持：

- DSH Agent Loop 和 Session log 是模型交互权威；
- Python 只执行代码，不持有模型凭据或 DSH 私有对象；
- 一个 Session 的内核和变量不会泄漏给另一个 Session；
- 新功能复用 `rlm_eval` 主路径，不复制第二套 RLM runtime；
- 只有出现第二个 Consumer 才考虑公共 Service；
- 只有出现第二个真实实现才考虑 Provider 接口。

## 按证据添加

| 能力 | 触发条件 | 最小增加 | 验收结果 |
|---|---|---|---|
| Continuable spawn | 一个任务必须在父 cell 结束后继续工作 | 使用官方 continuable Subagent 和 inbox；不把答案塞进 handle | 父 cell 结束后子 Session 继续，并由官方 Session 路径交付结果 |
| 跨宿主持久 Session | 用户要求插件重启后继续同一 RLM 会话 | 只持久化恢复所需元数据和 snapshot 引用 | 重启后同一 Session 能恢复；版本不匹配明确失败 |
| M7 Batched query | 顺序 query 的实测延迟成为瓶颈 | 一个有并发上限的 `rlm_query_batched` | 批量结果保持输入顺序，取消能终止全部子调用 |
| 第二个内核实现 | container 或 remote kernel 已开始实现 | 从现有 runtime 抽取最小 `KernelDriver` 接口 | 本地与第二实现通过同一闭环场景 |
| Token/费用护栏 | 实际 Provider 暴露可靠用量，且发生可复现的费用控制问题 | 在 query 准入点读取已观测用量并拒绝后续调用 | 达到限制后停止新 query，不伪造未观测 token |
| Jobs、UI、swarm | 有点名 Consumer 和端到端场景 | 作为现有 runtime 的 Consumer，不进入 Python core | 新 Consumer 不改变 `rlm_eval` 和 Session 权威 |

## 添加新功能时的最小决策

每次只回答四个问题：

1. 哪个已运行场景证明当前 V1 不够？
2. 最小改动落在现有哪一个文件或边界？
3. 哪条现有闭环必须保持不变？
4. 什么端到端结果证明功能完成？

如果没有可运行触发场景，答案就是“不添加”。

M5 已用可选、每个已加载 runtime 的 checkpoint 满足 timeout/crash 的已观测触发条件；
M6 通过既有 `rlm_eval` 路径拥有显式清理状态的触发条件。跨主机或宿主重启持久化
仍是单独条件扩展，未经新契约不得复用 M5 私有映射。

M7 现由其[有界有序批量契约](m7-batched-query.zh-CN.md)约束。它仍只是既有 bridge
上的私有 Python helper；provider-native batching、全局调度和 durable batch work
仍是条件扩展。
