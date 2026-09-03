# dsh-rlm 核心与 M3/M4/M5/M6 架构

> [English](architecture.md) | 简体中文

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

已交付的 V1 基线不包含公共 Service、Storage Domain、run ID、checkpoint、
restore、`rlm_spawn`、Provider 框架、后台任务、UI、Workflow 或 Team。托管
上下文、递归子 RLM、可选故障恢复与显式重置现由有序 M3、M4、M5、M6 契约约束，
但不属于已交付的 V1 行为。

## 2. DSH 边界

| DSH 能力 | V1 用法 |
|---|---|
| Tools | 注册唯一模型工具 `rlm_eval` |
| Agent Loop | 拥有外层“执行、观察、再执行或回答”循环 |
| Subagent | 为 `rlm_query` 执行一次 one-shot 调用 |
| Session log | 保存官方工具调用、结果和最终模型消息 |
| System Prompt | 一段短 `tool:rlm_eval` section：持久变量、绝对路径、顶层 await 与迭代 |

启用时插件恰好注册一个名为 `tool:rlm_eval`、order `150` 的 system-prompt
section：说明持久 globals/variables、按绝对路径读取文件、顶层 `await`、
`await rlm_query(prompt)`，以及后续 `rlm_eval` 复用同一批变量继续迭代。
禁用或卸载其 fiber 时，该 section 与工具和 runtime 一起移除；这里没有
registry、public service 或 Provider framework。

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
  recovery?: { restored: boolean; checkpointCommitted: boolean }
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
DSH Agent 或 Session 转录复制进 Python。子进程只接收固定安全名环境白名单，
而不是宿主 `process.env`：Windows 保留 `PATH`、`SystemRoot`、`WINDIR`、
`COMSPEC`、`PATHEXT`、`SYSTEMDRIVE`、`USERPROFILE`、`TEMP`、`TMP`（大小写
不敏感匹配，按规范名输出）；POSIX 保留 `PATH`、`HOME`、`TMPDIR`、`TEMP`、
`TMP`、`LANG` 和精确的标准 `LC_*` 类目名；两个平台都保留公共 Python 启动项
`PYTHONIOENCODING`、`PYTHONUTF8`、`PYTHONUNBUFFERED`、`PYTHONPATH`。不提供
环境变量透传；自定义 `python` 命令同样使用该白名单，因此必须能通过白名单内
`PATH` 或绝对路径解析。代理变量、`VIRTUAL_ENV`/`CONDA_*`、`PYTHONHOME`、
`LD_LIBRARY_PATH`、`DSH_*` 与凭据类变量一律不转发。最初的环境继承缺口已在
[Issue #7](https://github.com/leinasi2014/dsh-rlm/issues/7) 审计并修复。这属于
凭据卫生，不是文件系统/进程/网络 sandbox：受信任的 Python 仍可读取宿主用户
可读文件、使用网络、启动进程，也可能读取磁盘上的凭据文件。

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

#### 可选恢复状态（M5）

`snapshotRecovery=true` 时，符合条件的 timeout、process exit 或致命协议故障会保留该
runtime/Session 的最近私有 checkpoint；替换 kernel 会在下一 cell 前恢复它。取消与卸载会删除
checkpoint，宿主重启不存在可复用映射。checkpoint 是有界 JSON-safe globals 加受保护 M3 context，
在私有 runtime 临时根中原子保存；其值不进入模型可见 frame 或 tool result，只可返回有界恢复状态。
见 [M5 架构](m5-session-snapshot-recovery.zh-CN.md)。

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

#### Session 串行化（Issue #2）

同一 Session 的并发 `rlm_eval` 不再被 `busy` 拒绝，而是由最小 per-Session
FIFO 队列串行化：

- 每个 Session key 拥有一队列与一个 drain worker，至多一个 active cell；
  请求按提交顺序执行，后一个 cell 能在同一 kernel 上读取前一个成功写入的 globals。
- 总 deadline 在 `eval()` 提交时冻结：排队等待与启动消耗同一预算。在出队前
  预算耗尽的请求以 `timeout` 拒绝且从不启动 kernel；一旦 active，由 Kernel
  接管剩余预算（启动 + cell 共享一个 deadline）。
- 排队请求立即观察自己的 `AbortSignal`：abort（或排队期超时）只以 `cancel`
  （或 `timeout`）结算该 entry，绝不触碰正在运行的 kernel，因此取消排队项
  不会驱逐同 Session kernel。
- kernel 只在 dequeue 时 lookup/create；前序 fatal（timeout、cancel、协议
  故障、崩溃）后旧 kernel 通过 identity-check 的 `onExit` 驱逐，下一 entry
  出队前驱逐已完成，后继只能使用新 kernel，且 namespace 丢失可观察
  （旧 globals 消失、新 PID）。
- `runtime.dispose()` 为终态：同步以 `cancel` 拒绝所有尚未 active 的排队项，
  active 项经由既有 `Kernel.dispose` child cleanup barrier 结算；返回的
  barrier 同时等待 kernels 与 drain workers；dispose 后不得再启动排队工作。
- 队列按 Session 隔离：不同 Session 仍并行、kernel 与 globals 相互隔离；
  不存在全局 scheduler 或跨进程队列。`RlmError kind='busy'` 仅作为
  `Kernel.evalCell` 不可达的内部防御保留。

#### 有界协议契约（Issue #3）

- 总帧预算 `MAX_FRAME_BYTES = 256 * 1024` 按**实际序列化后的 JSONL 行**计，
  包含唯一的行尾 LF（wire 上若存在 CR，也算作该行字节）。Python 协议 stdout
  强制 LF-only（`newline="\n"`）；Host 按**未 trim 的原始行**计数，超预算的
  行在解析前即拒绝。
- 内容预算均为 `64 * 1024` UTF-8 字节：`prompt`、`query result`、
  `query error message/detail`、`stdout`、`result` 与 `stderr`。若内容未超
  内容预算、但 JSON 转义使序列化帧超过 `MAX_FRAME_BYTES`，则按真实序列化
  wire 字节再次拟合，并标记 `truncated`。
- 所有截断/切割均 UTF-8 / code point 安全：不切半个字符、不产生 U+FFFD，
  孤立 surrogate 保留原始 U+D800 code-unit 语义。
- 超长帧、超预算的无换行 buffer、无法继续缩减的帧以及协议错误会终止并
  evict 内核（namespace 丢失）；可恢复的 typed error 或有界的截断帧则保持
  内核存活。
- query 错误携带 `phase='query'`、`kind='query_error'`；`frame.truncated`
  传播到公开 `RlmError.truncated`；`detail` 以稳定文本呈现（字符串原样、
  数组/对象保留 JSON 结构）；面向模型的工具错误保持
  `kind + message + Detail + [truncated]` 且总字节 ≤ 64 KiB。
   M3 将 `PROTOCOL_VERSION` 升至 `2`，从而避免旧内核静默忽略托管上下文描述符；
   未新增公开 Service 或框架。

### Query/child 生命周期（Issue #4）

一次 `rlm_query` 调用在发出它的 cell 生命周期内恰好拥有一个 one-shot
Subagent：

- 每个 cell 创建自己的 `AbortController`；child 的请求信号是该控制器与调用方
  `exec.signal` 的合并。超时、调用方取消、协议故障、kernel 退出或插件
  dispose 都会中止该控制器，使 provider 取消 child 剩余轮次的工作。
- cell 的工具 Promise 只在其在飞 child 工作结算后结算：每个 query 任务在
  解析前都包含 `run.dispose()`，所有终态路径在拒绝或解析 cell 前等待该
  cleanup barrier。没有任何 one-shot child 会越过其 cell 的终态帧存活。
- 终态转换使用显式的 `active -> settling -> settled` 形态：首个终态边沿
  同步阻断路由与 child 发布，Session map 驱逐与公开的 cell Promise 结算只在
  child 静默完成后发生。并发同 Session eval 由 Issue #2 的 per-Session FIFO
  排队——它无法穿过结算窗口，只能在窗口关闭后启动：live 结算后在同一个
  kernel 上运行，fatal 结算后在新 kernel 上运行。`Kernel.busy` 只是不可达的
  内部防御，不是契约。
- 插件卸载返回可等待的 disposal barrier：`runtime.dispose()` 同步置为
  terminal（后续 eval 拒绝 `closed`），并在每个 kernel 的 child cleanup
  barrier 完成后 resolve，使 Cordis teardown 可以真正等待 child 静默。
- 迟到的 child 结果不会进入后续 cell：宿主丢弃任何不再属于当前 cell 的响应
  （pending-cell 身份守卫），Python kernel 在事件循环上执行回复投递，并使用
  任务本地 cell-owner token（`contextvars`）：归属在 detached task 创建时
  固定，已退休 cell 的任务不可能在后续 cell 中打开新 query。响应在其 cell
  仍活动时正常投递（即使已在终态边沿前排队），只有 owner 实际退休后才丢弃
  （低于当前 cell 单调 floor 的 id，或刚终结 cell 的 id）；未知、未来、重复
  与非整数 reply id 仍是致命协议故障（Issue #1 契约）。reader 从不 pop 回复
  （投递在事件循环上并再次检查 owner/future），因此不存在 reader/loop
  InvalidStateError 竞态；用户代码仍可 catch query 错误并继续运行 cell 及其
  兄弟查询。
- `completed` 但没有可见 `text` 块的 query 是类型化的 `query` 错误
  （`phase='query'`），绝不是空字符串成功。
- Query 失败在模型可见的工具边界保持 `kind='query'` / `phase='query'`，
  同时遵守 Issue #3 的有界 detail/truncation 契约。

## 8. 最小配置

V1 通过一个 `Config` schema（`src/runtime.ts` 中的 `ConfigSchema`，由插件入口
别名引用）配置，默认值与范围如下：

- `enabled`（默认 `false`）与 `provider`（默认 `spawn`）；
- `python`（默认 `python`）：非空解释器命令；
- `timeout`（默认 `30000`）：整数 `1000..3600000` ms（每次 eval）；
- `maxStdout`（默认 `65536`）：整数 `1024..262144` UTF-8 字节（cell stdout）；
- `maxResult`（默认 `65536`）：整数 `1024..262144` UTF-8 字节（cell 结果）；
- `maxQueries`（默认 `16`）：整数 `1..4096`（每 cell 的 `rlm_query` 次数）。
- `maxContextBytes`（默认 `67108864`）：整数 `1048576..1073741824`（一个由内核
  托管的 UTF-8 文件上下文的源字节数）。
- `snapshotRecovery`（默认 `false`）：开启固定限制的私有 M5 故障 checkpoint，
  它不是持久 Session storage。

校验后的 config 对象直接传给 `createRlmRuntime`；插件不提供环境变量透传，
也没有 registry 或 Provider/framework 表面。未知 Provider、Python 启动失败
或 Provider 无法禁用 RLM 工具时，插件在首次使用时明确失败，不静默切换实现。

## 9. 有序 M3、M4、M5 与 M6 目标

M3、M4、M5、M6 在不改变 DSH 权威边界的前提下扩展同一条单工具路径：

```text
M3: rlm_eval(code, contextPath?)
      -> 内核从绝对 UTF-8 文件原子加载受保护 context

M4: kernel -> rlm_query(prompt)
      -> 受深度限制的官方 DSH 子 Session
      -> 上限以下子节点拥有自己的 rlm_eval 内核
      -> 上限处叶子禁用 rlm_eval

M5: 成功 cell -> 私有原子 checkpoint
      -> 合格 kernel 故障 -> 下一 cell 前恢复

M6: rlm_eval({ reset: true })
      -> FIFO 当前 Session cleanup
      -> 删除 kernel、M3 context 与 M5 checkpoint
      -> 后续携带 code 的 eval 从干净状态开始
```

- [M3 托管上下文架构](m3-managed-context.zh-CN.md) 冻结加载、原子性、限制、
  错误与 Session 隔离；
- [M4 递归子 RLM 架构](m4-recursive-child-rlm.zh-CN.md) 冻结官方深度权威、
  每 Session 内核与后代静止；
- [M5 会话快照恢复架构](m5-session-snapshot-recovery.zh-CN.md) 冻结可选
  checkpoint 的范围、原子性与恢复边界；
- [M6 手动重置架构](m6-manual-reset.zh-CN.md) 冻结既有工具 reset 输入、FIFO
  所有权、cleanup barrier 与 Session 隔离；
- [M3/M4 开发契约](m3-m4-development-contract.zh-CN.md) 冻结文档先行、
  M3→M4、TDD、审查、Git、dogfood 与活体验收门禁；
- [M5 交互式验收架构图](m5-session-snapshot-recovery.html) 与
  [M6 reset 边界图](m6-manual-reset.html) 由受版本管理 Archify 源生成；
- [交互式目标架构图](dsh-rlm-architecture.html) 由受版本管理的
  [Archify 源](dsh-rlm-architecture.archify.json) 生成。

Storage、宿主重启持久化、continuable spawn、批量查询和第二 runtime 仍不在范围内，
直至其有序契约被接受。M5 必须被接受后才开始 M6；M6 在 M7 前，M7 在 M8 前。

## 10. 首个验收场景

在真实 DSH Profile 中：

1. 用户给出一个本地 UTF-8 文件路径并要求分析；
2. Agent 调用 `rlm_eval`，Python 读取文件并保存为 `context`；
3. 同一 cell 至少完成一次 query 往返并继续执行；
4. Agent 再次调用 `rlm_eval`，成功读取上一 cell 的变量并完成修订；
5. Agent 根据修订结果输出最终答案；
6. Session log 中能看到两次工具调用及其有界结果。

被门禁的 clean-Profile smoke 只在可弃置副本上钉住显式模型路由：读取 ambient
`settings.yaml` 字节，在副本文本中把顶层 `agent-default-model` 块改写为
provider `vllm`、model `DeepSeek-V4-Flash-Vision-Exp`（可用
`RLM_LIVE_PROVIDER` / `RLM_LIVE_MODEL` 覆盖），原样复制 `.credentials.yaml`，
并在运行后断言两个 ambient 文件逐字节未变。ambient DSH settings 从不被改写。
可选的 `RLM_DSH_REPO_ROOT` 覆盖用于外部 worktree 定位 harness checkout；
smoke 在启动前会校验该根下的 `apps/cli/src/bin.ts` 存在。

只有这条路径通过，才能宣称 RLM 闭环和自我迭代闭环成立。

后续能力及其触发条件见 [后续扩展架构](future-extensions.zh-CN.md)，交付顺序和退出
条件见 [里程碑](milestones.zh-CN.md)。
