# M7 有界有序批量查询架构

> [English（权威版本）](m7-batched-query.md) | 简体中文 | [交互式架构图](m7-batched-query.html)

## 结果

M7 只向现有持久 RLM Python kernel 注入一个便利 helper：

```python
answers = await rlm_query_batched(["第一个提示", "第二个提示"])
```

它对这一次 batch 最多同时启动四个普通 one-shot DSH 子代理查询，并按输入原顺序
返回 `list[str]`。它不新增模型可见工具、第二 Agent loop、全局 scheduler、Provider
batch API、Service、Storage、Job 或 UI。

## 冻结 API 与兼容性

`rlm_query_batched(prompts)` 会注入每个 RLM Python namespace，并由既有受保护 helper
scaffold 在每个 cell 和 M5 restore 后恢复。它仅接受每一项都是 `str` 的 `list` 或
`tuple`。

- 空输入返回 `[]`，不会发出 `query` 协议帧或 child 请求（外层普通 `eval` frame 仍存在）。
- 容器或元素不合法会在 child 启动前产生既有类型化 query failure；单个 `str` 本身不是 batch 容器。
- 相同 prompt 是独立位置；即便子代理乱序完成，返回列表长度和顺序仍与输入完全一致。
- 既有 `await rlm_query(prompt)`、`rlm_eval` 输入、Session FIFO、限制、日志与唯一工具公开面不变。

并发上限固定为 `4`，M7 不把它做成用户配置。该限制只作用于一次调用；不同 Session
仍保持既有独立 runtime，M7 不创建跨 Session pool 或公平性机制。

## 准入、有序与失败

helper 按输入 index 跟踪 prompt，每个获准项目都复用既有 `_rlm_query` bridge。因此
既有 prompt/result 字节限制、官方 DSH Subagent 所有权、M4 depth/tool policy 和每 cell
`maxQueries` 计数全部保留。官方 M4 depth cap 以下 child 保留自己的 RLM kernel 与
`rlm_eval`；只有到达精确 depth 的 leaf 禁用 `rlm_eval`。

1. 任一时刻最多准入四个未完成项目；仅在未观察到失败时才以完成的 slot 填补新项目。
2. 成功结果写入自身 index slot；最终成功按输入顺序返回，而非按完成顺序。
3. 非法输入不启动任何查询。任一已准入 query 失败即停止后续准入，但不取消已发往宿主的 child。
4. helper 必须先 drain 所有已准入 child，再抛出一个类型化 query failure；若多个失败，抛出最小输入 index 的失败，保证确定性。
5. 达到既有每 cell `maxQueries` 后，超限项不得启动 DSH child；已启动项目仍须 drain，再返回类型化 limit failure。M7 不改变也不预留新的 query budget。

drain 是协议正确性的要求：若 Python 取消仍在宿主执行的 `_rlm_query` waiter，后续
`query_result` 会成为未知协议响应。正常失败路径因此由既有宿主 cleanup 保持 child work 的完整所有权。

直接 Python task cancellation 是独立的强制规则。用户以 `Task.cancel()` 或
`asyncio.wait_for()` 取消运行 `rlm_query_batched` 的任务时，helper 必须停止新准入，
在所属 cell 仍存活时 shield/drain 每个已准入 `_rlm_query` waiter，随后才重新抛出
`CancelledError`；绝不能让 caller cancellation 在 host reply 被消费前移除 pending
query ID。终止性的 cell cancellation、timeout 或 fatal kernel/protocol loss 则走既有
host-owned cell cleanup path。

## 生命周期与边界

取消、timeout、kernel crash、fatal protocol loss 和插件 unload 继续使用既有 per-cell
abort controller 与 child-disposal barrier：在 cell 结算前 abort/dispose 所有已准入 child，绝不让 batch 结果泄漏到下一个 cell。M5 在这些合格 fatal loss path 上保留既有 checkpoint/recovery 规则。

M6 reset 不是 cell cancellation：它仍在同一 Session FIFO 中排在已接受 batch 之后。
batch 必须先按自身 success、item-failure 或 direct-Python-cancellation drain 语义结算，
之后 reset 才拥有既有 kernel/child cleanup barrier。同一 Session 的 FIFO 仍串行 cell。

helper、worker bookkeeping 和 partial result 都是临时状态，不得进入 user global、M5
snapshot、managed `context`、host protocol、Session metadata 或 tool result。只有用户
Python 在成功后赋值的 `list[str]` 才可按既有 M5 规则成为普通 snapshot 候选。

M7 完全复用 M4 recursion：获准 query 可在 M4 允许时走官方 recursive-child route；
child RLM 在权威 cap 以下可用，只有 exact-depth leaf 禁用 RLM tool。M7 不引入第二套
递归策略或第二 kernel。

## 限制与非目标

- 每次调用固定最多四个 active child；既有 cell `timeout` 包含 drain。
- 没有 per-item timeout/retry/streaming/partial-success/background continuation。
- 不允许 native provider batch endpoint、可配置 worker 数、全局 scheduler、back-pressure service、cost accounting、durable batch record 或新 DSH API 面。

## TDD 验收契约

1. **接受的 M6 main 上 RED：** kernel 只有 `rlm_query`，没有 `rlm_query_batched`；新安装插件的 Profile 无法使用它。
2. **Kernel/protocol GREEN：** 六个 prompt 首先准入四个 `query` frame；乱序 `query_result` 填补 slot，输出仍为输入顺序（含重复 prompt）。
3. **Failure GREEN：** 非法输入不发 query；项目失败停止新准入、drain 已启动工作、抛确定性类型化 query error，kernel 仍可用于下一 cell。还必须让两个已准入项目以反向完成顺序失败，同时 drain 全部已准入工作；最终 error 必须是较小输入 index 的 failure。显式 mixed-batch 用例覆盖空输入和剩余 `maxQueries` budget 耗尽。
4. **Runtime/lifecycle GREEN：** 观测到的 active child 永不超过四；`maxQueries`、direct Python task cancellation、cell cancellation、timeout、kernel exit、fatal protocol loss、reset、unload 后，所属 cell 结算时无已准入 child 或 protocol waiter 存活。直接 Python cancellation 必须 drain 后重抛，且不得产生 unknown late reply；reset 必须先 FIFO 等待 batch。合格 M5 fatal path 保持恢复行为。
5. **M4 depth 边界：** 权威 cap 以下的 batch child 可使用自己的 RLM path；exact leaf cap 的 batch 证明 `rlm_eval` 在该处被拒绝。
6. **M5 scaffold 边界：** helper 在执行/restore 后重新注入，不被当作 checkpoint user global 序列化。
7. **干净 Profile：** disposable DSH Home 安装本包，证明多 prompt batch 产生可见、有序、child-backed 文本及有界官方 Session log 证据。DSV4-FVE vLLM/PTC 可用时优先使用；服务不可用期间可暂用并记录 `zai-coding-cn / glm-5.2`，恢复后须回归 DSV4-FVE。
