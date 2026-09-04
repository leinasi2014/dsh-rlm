# M11 每 cell 查询令牌/成本护栏架构

> [English (authoritative)](m11-token-guard.md) | 简体中文 | [交互图](m11-token-guard.html)

## 结果

M11 为每次查询准入增加可选每-cell 护栏：在 `rlm_query` 或 `rlm_spawn` 子代理准入前，插件读取官方
`ctx.tokenMeter.measure(parent.session)` 观测，当 cell 已观测令牌预算耗尽时拒绝调用。只统计
**已观测**令牌——插件绝不虚构、估算或外推未观测的 Provider 用量。

DSH Agent Loop 与 Session 日志仍是模型交互权威；Provider 与 `dsh-token-meter` 仍是用量权威；
Python 永远看不到令牌数字。

## 权威与 API

- 权威：`@deepseek-ai/dsh-token-meter`（DSH base 已挂载）的 `TokenMeter.measure(session, header?)`
  返回含 Provider 用量面（input、cacheRead、cacheWrite、output）的 `TokenMeasurement`；无表头/未知
  用量视为未观测，护栏把它当作“不计入”，绝不当作零消耗证明。
- 新配置（全部可选，默认关闭）：`maxQueryTokensPerCell?: number` 在 cell 已观测用量超过预算时
  硬停；`guardQueryTokens?: boolean` 启用护栏（默认 false）。
- 护栏运行于宿主桥接层，每个 helper 准入恰好一次，且在创建子代理之前排序（拒绝则不派发）。
  M7 批helper共享一个每-cell 记账周期。

## 状态与失败语义

1. 每-cell 记账从 cell 开始到结算释放；护栏每次准入读取会话已观测用量，而不是插件自建账本。
2. 已观测用量已超预算时，准入以类型化 `query` 错误（phase/kind 均 `query`）失败，不启动子代理，
   cell 仍可做非查询工作。
3. Provider 未报告用量不计入上限；护栏只在“可观测的超出”时关闭，绝不在未观测的不确定性上阻塞。
4. 被拒绝准入的取消是无操作；reset/recovery 重新武装下一 cell。
5. 护栏只读：不写 DSH Session 日志，不变 Provider 状态，除有界拒绝消息外不向 Python 或模型
   工具结果暴露令牌数字。

## 限制与非目标

无 Provider 框架、无价格/成本账本、无配额持久化、无全局/跨 Session 预算、Python 内无令牌计数器、
无估算回退。护栏是有界安全过滤器，不是记账软件。

## TDD 验收契约

1. **RED：** 已验收 M10 不咨询任何令牌观测即准入查询；录制桩观察到零次 `measure` 调用
   （因预期每次准入恰好一次而失败）。
2. **GREEN：** `guardQueryTokens=true` + 超预算桩：首次准入调用一次 `measure`，以类型化 `query`
   错误拒绝，子代理不派发。
3. **GREEN：** 未超预算桩允许准入且不拒绝。
4. **GREEN：** M7 批次超预算在任何子代理前拒绝；cell 仍可用，下一 cell 重新武装记账周期。
5. **干净 Profile：** 一次性安装 Profile 用 DSV4-FVE（或 GLM 回退）证明护栏路径，不虚构令牌数字。
