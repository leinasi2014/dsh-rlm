# M4 递归子 RLM 架构

> [English (authoritative)](m4-recursive-child-rlm.md) | 简体中文

## 结果

M4 允许 `rlm_query` 委派给受深度限制的 DSH 子 Session；子 Session 可以使用
自己的 `rlm_eval` 和 Session Python 内核。实现复用官方 DSH Subagent 与
Session 权威，不创建第二套 Agent Loop，也不直接调用模型客户端。

```text
根 DSH Agent（深度 0）
  -> rlm_eval / 根内核
  -> rlm_query
  -> 子 DSH Session（深度 1；depth < maxDepth 时可递归）
       -> 自己的 rlm_eval / 自己的内核
       -> rlm_query
       -> 叶子 DSH Subagent（depth == maxDepth，禁用 rlm_eval）
  -> 子节点可见文本返回并恢复父 Python cell
```

## 深度契约

- 新增 `maxDepth`，默认 `1`，整数范围 `1..8`。
- 根委派深度为 `0`；子深度始终为 `parentDepth + 1`。
- 当 `childDepth < maxDepth` 时，启动可使用 `rlm_eval` 的官方 DSH 子
  Session；其 Agent 可迭代并拥有隔离内核。
- 当 `childDepth == maxDepth` 时，保持现有 one-shot 叶子行为，并通过官方
  tool filter 禁用 `rlm_eval`。
- 超出上限的请求由官方 DSH 深度权威拒绝。
- `maxDepth=1` 与 M1/M2 向后兼容：所有 `rlm_query` 都是不能调用
  `rlm_eval` 的 one-shot 叶子。

运行时从官方 DSH Session/运行时元数据推导深度，并把上限传给
`ctx.subagents.start`；不信任模型提供的深度，也不维护平行计数器。在首次
分支准入前，它取得所选官方 Provider，并同时要求 `depthLimit` 与
`toolFilter`：前者授权绝对上限，后者保证叶子结构性禁用。因此缺少能力时会
在创建任何递归子节点前失败；每个子节点仍由 `start()` 作为权威执行点。

## 所有权与隔离

- 每个递归子节点都有官方子 Session，并持久记录父 Session 与委派深度。
- 每个子 Session key 选择独立 Python 内核和全局变量；父、兄弟、后代之间
  从不共享命名空间。
- 父 cell 拥有其 `rlm_query` 创建的子分支；只有分支完成并释放后，可见文本
  才返回父 Python cell。
- 官方 DSH Session 日志仍是唯一模型交互历史；插件不保存平行 transcript
  或递归 run 记录。

## 生命周期契约

超时、调用方取消、协议错误、内核退出和插件卸载会关闭该分支准入，将 abort
传播到全部后代，并在父 cell 结算前等待后代/释放静止。迟到结果不得发布到已
退役或后续 cell。无关 Session 不受影响。

查询文本/结果字节限制与每 cell 查询次数限制在每个内核边界独立适用。每个子
Session 有自己的 cell 预算；M4 不提供共享 token/成本账本。

## 非目标

- 可继续/后台 spawn 或 inbox 投递；
- 自定义递归调度器、第二 Agent Loop 或直接 Provider 客户端；
- 跨递归层共享 Python 全局变量；
- 重启后持久化或恢复递归树；
- 批量查询、每次调用动态深度或模型选择 Provider；
- 全局 token/成本核算。

## 验收示例

1. `maxDepth=1` 保持当前 one-shot 行为和叶子工具禁用。
2. `maxDepth=2` 时，深度 1 子节点使用自己的 `rlm_eval`、调用深度 2 叶子，
   并把可见文本返回根 Python cell。
3. `maxDepth=3` 时完成两层递归子节点，且不能创建深度 4 Session。
4. 根、子、兄弟、叶子的谱系在官方 DSH Session 元数据/日志中可见；Python
   全局变量保持隔离。
5. Provider 缺少能力时在开始部分递归工作前显式失败。
6. 超时、取消和插件卸载后无后代 Agent 或 Python 进程存活，且不影响无关
   Session。
7. 干净 Profile 使用 `DeepSeek-V4-Flash-Vision-Exp` 和已安装插件，经官方
   Subagent API 真实证明深度 2 与深度 3 路径，并留下有界 Session 日志证据。
