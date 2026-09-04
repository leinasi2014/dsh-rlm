# M12 Jobs / UI / Swarm 架构（RLM 作为 Job 消费者）

> [English (authoritative)](m12-jobs-ui-swarm.md) | 简体中文 | [交互图](m12-jobs-ui-swarm.html)

## 结果

M12 消费既有官方 DSH job 面（`ctx.jobs`、`@deepseek-ai/dsh-jobs-local`、`@deepseek-ai/dsh-tool-jobs`）：RLM
cell 可以作为 DSH 拥有的后台 job 运行——插件按 Session 注册一个 job producer，其 spec 运行同一持久
内核/cell 并把有界输出写入官方 job 记录。不添加第二 Agent loop、自定义调度器、Workflow 引擎、
Storage Domain 或 UI。DSH 工具 `jobs`/`job_read`/`job_kill` 仍为 UI/控制面；插件只注册面向 job
控制器的 producer。

“swarm” 行仍为条件：需要具名外部消费者与端到端场景后才添加多代理编排。M12 不创建 swarm。

## 权威与 API

- 权威：官方 `ctx.jobs`（`start/wait/read/kill/list`），由 DSH base 挂载；插件为它拥有的 Session
  注册一个 `attachController` producer。
- producer 包装既有 RLM runtime：`createRlmJobSpec` 返回**惰性** spec；`run()`（由官方 job registry
  调用）才懒启动 `runtime.eval(sessionKey, cell)`，把有界 stdout/result 流入 job 输出；`kill` 映射到既有
  Session 内核 dispose。`startRlmJob(ctx, parent, code, runtime)` 是消费者路径 helper，调用
  `ctx.jobs.start` 传入该 spec；从未 start 的 spec 不泄漏任何内核/工作。
- 无插件队列/调度器：DSH 决定 job 准入/生命周期；插件只就自身 Session 内核回答
  `start/wait/read/kill`。

## 状态与失败语义

1. 每 Session 同时至多一个 job（内核单一）；同一 Session 第二个 start 在首个运行中时被拒绝。
2. job 取消映射到既有内核取消/dispose 屏障：属主进程树被杀、Session 内核被驱逐、job 以取消与
   既有类型化错误文本结算。
3. job 驱动的 cell 内仍适用 M5 恢复；M10 持久引用不受 job 生命周期影响；job 内 M6 reset 行为与
   经 `rlm_eval` 完全一致。
4. 插件卸载排空自身 job producer；插件外的 DSH 拥有 job 不受影响。
5. DSH job 记录而非插件是模型可见历史权威；插件从不写重复历史。

## 限制与非目标

无自定义 Workflow/Job 引擎、无队列/调度器、无跨 Session job 路由、无新 Agent loop、无 UI 标记、
无 swarm 编排。UI 仍属 DSH；插件只按 Session 暴露一个官方 job producer。

## TDD 验收契约

1. **RED：** 已验收 M11 无 job producer；某 Session key 启动 job 时因无挂载 job 控制器失败
   （观察为 RED）。
2. **GREEN：** 插件挂载一个控制器；`start` 返回有界 job 并等待同一内核 cell，把
   `stdout/result` 流入官方 job 输出；`wait` 完成；`read` 返回有界文本；`kill` 结算为取消。
3. **边界：** 同一 Session 并发二次 start 拒绝第二个；卸载排空；M5/M6/M10 行为保持绿；不写第二历史。
4. **干净 Profile：** 一次性安装 Profile 经官方 job 工具运行 job 并读取有界输出（优先 DSV4-FVE；
   GLM 回退记录）。
