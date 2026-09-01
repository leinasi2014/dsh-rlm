# 里程碑

里程碑只记录能力顺序和退出条件，不记录实时状态、日期或人员。工作是否完成以
可执行结果为准，不以文件数、设计完成度或实现行数为准。

## M1：RLM 与自我迭代闭环

**结果**：在真实 DSH Profile 中，一个 Agent 能通过 `rlm_eval` 读取本地文件、
从 Python 调用 one-shot Subagent、继续计算，并在第二个 cell 复用已有变量后
输出最终答案。

**包含**：

- Host-only 函数插件和唯一工具 `rlm_eval`；
- 每 Session 一个持久 Python kernel；
- top-level `await`、`rlm_query` 和有界输出；
- one-shot query 的可见文本返回；
- 简短 system prompt；
- 一个自动化闭环测试和一个真实 Profile smoke。

**退出条件**：

1. 插件能构建并在目标 Profile 加载、卸载；
2. 第一个 cell 从绝对路径读取 UTF-8 文件并保存 `context`；
3. cell 内至少一次 `rlm_query` 返回后，Python 继续执行；
4. 第二个 `rlm_eval` 能读取第一个 cell 留下的变量；
5. Agent 输出基于修订结果的最终答案；
6. 两次工具调用和结果进入官方 Session log；
7. 子智能体和 Python 进程在测试结束后均被 dispose。

M1 通过前，不实现 snapshot、spawn、Storage、公共 Service 或第二 Provider。

## M2：本地可靠性基线

**结果**：核心闭环在常见失败下明确停止，不泄漏进程或跨 Session 状态。

**退出条件**：

1. 两个 Session 的 globals 相互隔离；
2. 同一 Session 的并发 cell 被串行化；
3. cell 超时或取消只杀死所属 Session 的进程树，并报告 namespace 丢失；
4. 下一次 `rlm_eval` 创建干净内核；
5. 输出和协议帧超过上限时明确失败或截断；
6. query 超过每 cell 次数上限时拒绝新调用；
7. 插件卸载后没有插件拥有的 Python 进程存活。

## 条件里程碑

以下里程碑没有预定顺序。只有
[后续扩展架构](future-extensions.md) 中对应触发条件成立才启动。

| 里程碑 | 完成结果 |
|---|---|
| F1 Snapshot 恢复 | kernel 被杀后恢复支持的变量，并报告跳过项 |
| F2 递归子 RLM | 子 Session 拥有自己的内核，可在深度限制内迭代并返回文本 |
| F3 受管上下文来源 | 稳定文件/附件句柄直接加载大文本，不复制全文进模型参数 |
| F4 Batched query | 有界并发、顺序稳定、可取消的批量查询 |
| F5 第二内核实现 | 第二实现与本地实现通过同一端到端闭环 |
| F6 外部 Consumer | Jobs、UI 或 swarm 复用现有 runtime，不产生第二权威循环 |
