# 里程碑

> [English](milestones.md) | 简体中文

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

## M3：托管上下文

**结果**：`rlm_eval(code, contextPath?)` 把一个有界的绝对 UTF-8 文件原子加载
到受保护的 Session 本地 `context`，不经模型可见工具输入复制正文。

**退出条件**：

1. 省略 `contextPath` 与 M1/M2 向后兼容；
2. 当前 cell 立即看到上下文，后续 cell 可复用；
3. 其他 Session 不可见，cell 代码不能永久替换受保护的 `context`/
   `context_meta`；
4. 非法路径、目标类型、大小、UTF-8 与读取竞态错误类型化且具有原子性，旧
   内核/上下文保持存活；
5. 协议版本不匹配显式失败；文件正文不出现在宿主帧、模型可见工具输入或
   工具结果中；
6. 单元/集成测试、独立审查、CI、远端 main 回读和干净 DSV4-FVE Profile
   冒烟全部通过。

见 [M3 架构](m3-managed-context.zh-CN.md)。

## M4：递归子 RLM

**结果**：`rlm_query` 通过官方 DSH Session/Subagent 创建受深度限制的子节点；
上限以下的子节点拥有自己的 `rlm_eval` 内核，上限处叶子保持 one-shot 禁用。

**退出条件**：

1. `maxDepth=1` 保持 M1/M2 已交付行为；
2. 深度 2/3 路径经官方 API 完成，并将可见文本返回父 Python cell；
3. 官方深度上限阻止更深子节点，Provider 缺少能力时在部分递归工作开始前失败；
4. 父、子、兄弟和后代 Python 命名空间隔离，官方 Session 元数据/日志保留谱系；
5. 超时、取消、协议失败和插件卸载使整个所属后代分支静止，不影响无关 Session；
6. 单元/集成测试、独立审查、CI、远端 main 回读和干净 DSV4-FVE 深度 2/3
   Profile 冒烟全部通过。

见 [M4 架构](m4-recursive-child-rlm.zh-CN.md)。

## M5：会话快照恢复

**结果**：显式开启时，既有 `rlm_eval` 路径在所属 timeout、crash 或致命协议丢失后，
在下一 cell 执行前恢复同一 Session 最近有效且受支持的 checkpoint。

**退出条件**：

1. `snapshotRecovery=false` 完全保持 M2 namespace-loss 行为；
2. 合格的致命丢失创建新 PID，只恢复同一 Session 的有界 JSON-safe globals 与受保护 M3 context；
3. checkpoint 发布原子化；损坏、超大或半写候选不能替换有效 checkpoint，失效恢复 fail closed；
4. 取消、reset、卸载、宿主重启、sibling 与 recursive child 边界不能恢复无关或陈旧 checkpoint；
5. 值与 context 文本不进入模型可见协议数据或 recovery metadata；跳过项只以有界摘要报告；
6. 单元/集成测试、独立审查、CI、远端 main 回读和干净已安装插件 DSV4-FVE Profile smoke 均通过。

见 [M5 架构](m5-session-snapshot-recovery.zh-CN.md) 与
[M5 交付契约](m5-development-contract.zh-CN.md)。

## M5 之后的条件里程碑

以下里程碑没有预定顺序。只有
[后续扩展架构](future-extensions.zh-CN.md) 中对应触发条件成立才启动。

| 里程碑 | 完成结果 |
|---|---|
| F4 Batched query | 有界并发、顺序稳定、可取消的批量查询 |
| F5 第二内核实现 | 第二实现与本地实现通过同一端到端闭环 |
| F6 外部 Consumer | Jobs、UI 或 swarm 复用现有 runtime，不产生第二权威循环 |
