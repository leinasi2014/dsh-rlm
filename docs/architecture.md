# dsh-rlm 核心架构

## 1. V1 结果

`dsh-rlm` 只给 DeepSeek Harness 增加一条能力：模型通过一个
`rlm_eval` 工具在持久 Python 命名空间中执行代码，并能从代码里
`await rlm_query(prompt)` 调用模型。查询结果返回 Python 后，当前代码继续
计算；DSH Agent 也可以再次调用 `rlm_eval`，继续使用同一批变量。

V1 的完成标准不是“基础设施齐全”，而是以下路径在真实 DSH Profile 中跑通：

```text
DSH Agent Loop
  -> rlm_eval(code)
  -> 当前 Session 的 Python kernel
  -> await rlm_query(prompt)
  -> DSH one-shot Subagent
  -> visible text 返回 Python
  -> cell 继续计算并返回结果
  -> Agent 再次 rlm_eval 或输出最终答案
```

V1 不包含公共 Service、Storage Domain、run ID、checkpoint、restore、
`rlm_spawn`、递归子 RLM、Provider 框架、后台任务、UI、Workflow 或 Team。

## 2. DSH 边界

| DSH 能力 | V1 用法 |
|---|---|
| Tools | 注册唯一模型工具 `rlm_eval` |
| Agent Loop | 拥有外层“执行、观察、再执行或回答”循环 |
| Subagent | 为 `rlm_query` 执行一次 one-shot 调用 |
| Session log | 保存官方工具调用、结果和最终模型消息 |
| System Prompt | 说明持久变量、文件读取和迭代方式 |

插件是一个 Host-only 函数插件。只有一个工具、一个实现和一个 Consumer，
因此不建立 `RlmService`。运行时是插件内部对象，按当前 `exec.agent` 的
Session 身份选择内核；模型不能提交可伪造的 `runId`。

## 3. 唯一工具

概念契约如下：

```ts
interface RlmEvalInput {
  code: string
}

interface RlmEvalResult {
  stdout: string
  result?: string
  truncated: boolean
}
```

- `code` 是普通 Python，支持顶层 `await`。
- `stdout` 和最终表达式结果都有字节上限。
- Python 异常、查询失败、超时和取消作为明确工具错误返回，不伪装成
  `"Error: ..."` 文本。
- 同一 Session 同时只执行一个 cell；不同 Session 使用不同内核和 globals。

上下文不需要单独的加载工具。V1 的本地执行是受信任执行而不是 sandbox，
Python 可以直接读取用户提供的绝对路径：

```python
context = open(path, encoding="utf-8").read()
```

这使大文本直接进入 Python 变量，而不要求模型把整份内容复制进工具参数。

## 4. Session Python kernel

第一次 `rlm_eval` 为当前 Session 惰性启动一个 Python 进程。进程只负责：

1. 保存一个持续存在的 `globals`；
2. 串行执行支持顶层 `await` 的 cell；
3. 暴露 `await rlm_query(prompt)`；
4. 缓冲并截断 stdout、stderr 和结果；
5. 通过一条小型 JSON-lines 协议与 TypeScript 宿主通信。

同一 Session 的后续 `rlm_eval` 复用该进程。插件不把凭据、Provider 对象、
DSH Agent 或 Session 转录复制进 Python。

## 5. `rlm_query` 往返

一个活跃 cell 调用 `await rlm_query(prompt)` 时：

1. Python 发出带 `queryId` 的 `query` 消息；
2. TypeScript 使用配置的官方 one-shot Subagent Provider；
3. 子智能体禁用 `rlm_eval`，所以 V1 等价于参考 RLM 默认的
   `max_depth = 1`；
4. 宿主按顺序拼接可见 `text` blocks，忽略 `reasoning` blocks；
5. 没有可见文本、非完成 stop reason 或基础设施失败均返回明确错误；
6. one-shot run 被 dispose，文本通过 `query_result` 恢复当前 cell。

每个 cell 只有一个简单的 query 次数上限和一个总超时。V1 不维护 token
预算账本，也不做预留或结算事务。

## 6. 自我迭代闭环

V1 同时支持两个迭代层：

### Cell 内迭代

```python
draft = await rlm_query("根据 context 写一份草稿")
critique = await rlm_query(f"找出这份草稿的问题：\n{draft}")
revised = await rlm_query(
    f"根据批评修订草稿。\n草稿：{draft}\n批评：{critique}"
)
```

Python 代码可以循环、分支、拆分数据，并用前一次查询结果决定下一次查询。

### 跨 cell 迭代

DSH Agent 收到工具结果后可以再次调用 `rlm_eval`。第二个 cell 能直接读取
第一个 cell 留下的 `context`、`draft`、`critique` 和 `revised`。官方 Agent
Loop 决定继续迭代还是给出最终答案；插件不创建第二个 Agent Loop。

## 7. 最小协议与生命周期

V1 协议只有六种消息：

```text
ready, eval, query, query_result, result, error
```

`ready` 携带整数版本。每个 `eval` 和 `query` 有局部 ID，帧和输出都有字节
上限。一个 cell 只产生一个终态 `result` 或 `error`。

- 正常完成：返回有界结果，内核继续存活。
- Python 异常或 query 错误：当前 cell 失败，内核继续存活。
- 取消、硬超时、协议错误或进程崩溃：终止该 Session 的进程树，明确报告
  namespace 已丢失；下一次 `rlm_eval` 创建全新内核。
- 插件卸载：停止接收新 cell，终止全部插件拥有的 Python 进程。

V1 不承诺故障后恢复变量。恢复能力只有在真实使用需要时才添加。

#### 取消状态机（M2）

`rlm_eval` 的 `RlmEvalInput` 增加可选 `signal?: AbortSignal`，取自调用工具的
`exec.signal`。父工具取消只终止所属 Session 的 kernel 进程树，立即以
`RlmError kind=cancel` 拒绝当前 cell；其它 Session 的 kernel 与 globals 不变。

- pre-abort（进入 `eval` 时 `signal.aborted`）：不启动 kernel，立即以 cancel 拒绝。
- active abort（cell 运行中）：移除该 Session kernel 引用、标记不可复用、杀进程树，
  以 cancel 拒绝当前 cell；下一次同 Session `eval` 新建干净 kernel。
- abort handler 在 pending settle 前/后都竞态安全：仅当该 cell 仍是当前 pending 时生效
  （先判 `this.pending === p` 再 settle），timeout/result/error/exit 四条 settle 路径都
  `removeEventListener`，避免迟到的 abort 误杀已空闲的 kernel。
- 取消复用 `Kernel` 的 kill/evict 路径，不新建抽象。

## 8. 最小配置

V1 只需要：

- one-shot Subagent Provider 名称；
- Python 命令；
- cell 总超时；
- 最大输出字节数；
- 每 cell 最大 query 次数。

未知 Provider、Python 启动失败或 Provider 无法禁用 RLM 工具时，插件在首次
使用时明确失败，不静默切换实现。

## 9. 首个验收场景

在真实 DSH Profile 中：

1. 用户给出一个本地 UTF-8 文件路径并要求分析；
2. Agent 调用 `rlm_eval`，Python 读取文件并保存为 `context`；
3. 同一 cell 至少完成一次 query 往返并继续执行；
4. Agent 再次调用 `rlm_eval`，成功读取上一 cell 的变量并完成修订；
5. Agent 根据修订结果输出最终答案；
6. Session log 中能看到两次工具调用及其有界结果。

只有这条路径通过，才能宣称 RLM 闭环和自我迭代闭环成立。

后续能力及其触发条件见 [后续扩展架构](future-extensions.md)，交付顺序和退出
条件见 [里程碑](milestones.md)。
