# 后续扩展架构

本文件不是 V1 待办清单。只有 [核心架构](architecture.md) 的真实 Profile
闭环通过后，且下表触发条件已经出现，才添加对应能力。

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
| 手动 reset | 用户需要主动清空变量或释放内核 | 给 `rlm_eval` 增加 `reset` 操作，或增加一个 `rlm_reset` 工具 | 只清理当前 Session，其他 Session 不受影响 |
| Snapshot/restore | 一个被接受的用例要求在超时、崩溃或宿主重启后保留变量 | Python 序列化支持的 globals；临时文件原子替换；失败时明确丢失 | kill 后重启能恢复支持的变量，并报告跳过项 |
| 递归子 RLM | one-shot query 无法完成一个已复现的复杂子问题 | 允许子 Session 拥有自己的内核和 `rlm_eval`；按血缘限制深度 | `max_depth > 1` 的子 RLM 能独立迭代并向父 cell 返回文本 |
| Continuable spawn | 一个任务必须在父 cell 结束后继续工作 | 使用官方 continuable Subagent 和 inbox；不把答案塞进 handle | 父 cell 结束后子 Session 继续，并由官方 Session 路径交付结果 |
| 受管上下文来源 | 官方提供通用文本附件或工作区句柄，或本地路径不满足真实用例 | 在现有 runtime 前增加一个来源解析器，不建立 Context Domain | 大文本由稳定句柄进入 Python，不经过模型复制全文 |
| 跨宿主持久 Session | 用户要求插件重启后继续同一 RLM 会话 | 只持久化恢复所需元数据和 snapshot 引用 | 重启后同一 Session 能恢复；版本不匹配明确失败 |
| Batched query | 顺序 query 的实测延迟成为瓶颈 | 一个有并发上限的 `rlm_query_batched` | 批量结果保持输入顺序，取消能终止全部子调用 |
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
