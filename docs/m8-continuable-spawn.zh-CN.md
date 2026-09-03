# M8 可继续 Spawn 架构

> [English（权威）](m8-continuable-spawn.md) | 简体中文 | [交互图](m8-continuable-spawn.html)

## 结果

M8 为必须在发起 RLM cell 结束后继续的工作提供最小路径：
`rlm_spawn(prompt)` 在官方 DSH continuable manager 接受初始 inbox 消息后返回
不透明的稳定 child Session id；`rlm_followup(child_id, prompt)` 向同一 child 的
官方 FIFO inbox 投递后续消息。二者都不返回 child 答案。

child 的报告和最终结算只经 `reportFrom` 与官方 parent inbox / Session log 回到
直接父 Agent；Python 不决定何时把 inbox 消息变成 parent turn。

## 边界

执行权威是已安装 `@deepseek-ai/dsh-subagent` 的
`startContinuable`、`followup`、`reportFrom` 类型；官方 upstream 是新鲜度权威。
M8 复用既有 `rlm_eval`、按 Session 的 kernel、host lifecycle、M4 深度策略和
Session lineage。helper 是私有 Python scaffold，不是 DSH tool。

handle 仅是同 Session 已成功 spawn 返回的受校验 opaque id，不含结果、可运行对象、
凭据、parent Agent 或跨 Session 权限。错误输入在 child 准入前失败。

## 状态、失败与非目标

- 成功 spawn 仅表示官方 inbox 已接受初始消息；cell 可结束，child 由官方 durable
  identity / inbox 继续并支持 cold resume。
- follow-up 仅在官方 manager 接受后成功；插件不自建队列。
- report/settlement 不回灌旧或后续 Python cell，只以官方归因进入 parent inbox。
- M6 reset 仅丢弃 parent Python state/handles；不暗中销毁已接受 child。unload 用
  官方 continuable descendant drain，失败必须显式暴露。
- M5 不快照 live handle、child id、inbox 或 bookkeeping，恢复不能伪造 child 权限。
- 不做自定义队列、scheduler、后台任务、轮询、Storage、第二 Agent loop、UI、Service、
  provider client、answer-await/callback 或跨 parent 查询。

## TDD 验收

在接受的 M7 上先证明 helper 缺失；随后证明 spawn 后 parent cell 结束 child 仍存在，
后续 cell 的 follow-up 依官方 FIFO 到达，报告经 parent inbox 归因。还必须覆盖无效/跨
Session handle、取消、M4、M5、M6、unload，并在干净安装 Profile 中读取官方 Session
记录。DSV4-FVE 可用时优先；故障期间记录 GLM-5.2 fallback，恢复后回归 DSV4-FVE。
