# M8 可继续 Spawn 架构

> [English（权威）](m8-continuable-spawn.md) | 简体中文 | [交互图](m8-continuable-spawn.html)

## 结果

M8 为必须在发起 RLM cell 结束后继续的工作提供最小路径：
`rlm_spawn(prompt)` 在官方 DSH continuable manager 接受初始 inbox 消息后返回
不可快照的不透明 child capability；`rlm_followup(handle, prompt)` 向同一 child 的
官方 FIFO inbox 投递后续消息。二者都不返回 child 答案。

直接父 Agent 仍处于 live 状态时，child 的报告和最终结算只经官方 parent inbox /
Session log 回到该父 Agent。若父 Agent 已离开 DSH live registry，则不能接收迟到
通知，此时 durable child Session 是记录。Python 不决定何时把 inbox 消息变成 parent
turn。

## 边界

执行权威是实际加载的 DSH Profile runtime，并同时以已安装
`@deepseek-ai/dsh-subagent` 类型和最新官方 upstream 交叉核验。
`startContinuable` 仍是公开创建操作。当前 upstream 对 host-protocol FIFO
follow-up 有意通过其 `internal` entry 的官方 `queueHostSubagentPrompt` adapter
提供，不再使用旧的公开 `ctx.subagents.followup`。插件只使用这一确切、进程稳定的
host adapter：不创建队列，也不冒充 Agent sender。child admission 和 follow-up 前都会检查
adapter：只暴露旧 `0.1.1-rc.2` public declarations 的 host 明确不受 M8 支持，并且不会创建
continuable child。M8 复用既有 `rlm_eval`、按
Session 的 kernel、host lifecycle、M4 深度策略和 Session lineage。helper 是私有
Python scaffold，不是 DSH tool。

handle 是仅 live kernel 可用的私有 Python capability，对用户代码不暴露 child id，且
其类型故意不受 M5 snapshot 支持。follow-up 只接受同一 live kernel 的该 capability；
复制、恢复或跨 Session 值在 child 准入前失败，不含结果、可运行对象、凭据、parent
Agent 或跨 Session 权限。

## 状态、失败与非目标

- 成功 spawn 仅表示官方 inbox 已接受初始消息，不承诺消息此刻已写入 Session log；
  child/log 的 durable 可见性由 DSH 异步发布后核验。cell 可结束，child 由官方
  identity / inbox 继续并支持 cold resume。
- follow-up 仅在官方 manager 接受后成功；插件不自建队列。
- report/settlement 不回灌旧或后续 Python cell，只以官方归因进入 parent inbox。
- M6 reset 仅丢弃 parent Python state/handles；不暗中销毁已接受 child。unload 用
  官方 continuable descendant drain，失败必须显式暴露。
- M5 将 capability type 作为不支持值跳过，不快照 live handle、child id、inbox 或
  bookkeeping，恢复不能伪造 child 权限。
- 不做自定义队列、scheduler、后台任务、轮询、Storage、第二 Agent loop、UI、Service、
  provider client、answer-await/callback 或跨 parent 查询。

## TDD 验收

在接受的 M7 上先证明 helper 缺失；随后证明 spawn 后 parent cell 结束 child 仍存在，
后续 cell 的 follow-up 依官方 FIFO 到达，报告经 parent inbox 归因。还必须覆盖无效/跨
Session handle、取消、M4、M5、M6、unload，并在干净安装 Profile 中读取官方 Session
记录。DSV4-FVE 可用时优先；故障期间记录 GLM-5.2 fallback，恢复后回归 DSV4-FVE。
