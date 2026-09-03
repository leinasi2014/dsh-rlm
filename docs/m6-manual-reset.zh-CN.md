# M6 手动重置架构

> [English（权威版本）](m6-manual-reset.md) | 简体中文

## 结果

M6 为 Agent 提供唯一的显式方式，以丢弃**当前** DSH Session 的 RLM 状态：

```text
rlm_eval({ reset: true })
```

同一 Session 的下一次普通 `rlm_eval` 将启动新的 Python PID，不带先前
globals、managed `context` 或 M5 checkpoint。它不新增第二工具、Agent loop、
Service、Storage Domain、后台任务或 UI。

## 公开输入与兼容性

`rlm_eval` 仍是唯一模型可见的 RLM 工具，输入变为严格联合：

```ts
{ code: string; contextPath?: string } | { reset: true }
```

`reset: true` 与 `code`、`contextPath` 和操作专属 timeout 互斥。已有携带
code 的调用及其 timeout/cancel 语义完全不变。成功结果只返回有界确认，绝不
泄露被丢弃的值、路径、context 文本、checkpoint 数据或 PID。

## 所有权与顺序

TypeScript runtime 继续拥有所有进程生命周期决定。reset 是按当前精确 DSH
Session key 排队的内部队列项：

```text
同一 Session：已接受的 eval -> reset -> 后续 eval
其他 Session：不受影响且可独立运行
```

它等待同一 Session 已接受 cell 完成；激活后等待现有 kernel
dispose/child-cleanup barrier，驱逐该 kernel，并删除该 Session 的 M5
checkpoint reservation 与文件。reset 本身不会启动 Python kernel，也不能
执行 `rlm_query`。

之后 eval 才能懒启动新 kernel。由于 reset 在启动前已删除私有 checkpoint，
M5 不得向新命名空间恢复旧状态。M3 context 也不存在，直到后续 code 调用
通过现有原子 loader 提供新的 `contextPath`。

## 失败与取消语义

| 条件 | 必须结果 |
|---|---|
| reset signal 已预先取消 | 类型化 `cancel`；不排队、不动 kernel/checkpoint |
| reset 等待 cell 时调用者取消 | 类型化 `cancel`；运行中的 cell 与 live state 不变 |
| reset 已激活后调用者取消 | reset 拥有 cleanup barrier，继续完成删除并以 success 结算；同 Session 后续 eval 必须等其完成 |
| 插件 runtime 卸载 | 既有 terminal dispose 优先；reset 之后不得开始 |
| kernel dispose 失败 | 类型化失败；reset 不启动新 kernel，也不跨 Session 操作 |
| 其他 Session 的 reset/eval | 不影响当前 Session 的 kernel、context 或 checkpoint |

reset 是用户显式删除，不是 M5 故障恢复；它不恢复状态、不持久化元数据、不修改
DSH Session history，也不跨递归父/子/兄弟 Session 边界。

## 限制与非目标

- checkpoint 或 M3 context 字节不得进入工具结果、host protocol、日志或 reset metadata。
- 不增加新的字节、并发或深度设置；已有队列、timeout、cancel、环境和 child-dispose 限制继续生效。
- 它不是宿主重启 reset、全 Session cleanup、递归分支 cancel 或持久数据删除 API。
- reset 在工具边界同步：成功即代表所属 kernel cleanup barrier 已完成。

## TDD 验收契约

1. **接受的 M5 main 上的 RED：** 新安装插件的干净 DSH Profile 能跨 cell 保持 marker，但不接受 `reset:true`。
2. **本地进程 GREEN：** globals 与 managed context 后的 reset 处置旧 PID；下一 cell 有新 PID，读不到旧 globals/context。
3. **隔离/顺序：** 排队 reset 不触碰运行 cell 或兄弟 Session；激活后的 abort 不得留下半状态，同 Session 后续 eval 只在 cleanup barrier 完成后看到干净命名空间。
4. **M5 边界：** `snapshotRecovery=true` 时 reset 删除 checkpoint，之后 owned timeout 也不能复活 reset 前状态。
5. **干净 Profile：** disposable DSH Home 安装本包、启用 M5、固定 DSV4-FVE vLLM/PTC，执行 set -> reset -> read，并证明官方 Session log 记录 reset 调用但不泄露被删除内容。
