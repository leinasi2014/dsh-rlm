# 参考项目取舍

## 固定来源

| 参考项目 | Commit | 对 V1 的直接价值 |
|---|---|---|
| `PrimeIntellect-ai/prime-agent` | `6179a608f394d0858d463e40d648df0def6dbb7a` | Python 持有执行状态，宿主持有凭据和模型调用 |
| `alexzhang13/rlm` | `854e688fbba9d8f8989e3da9989812e4b6dfe270` | RLM 核心是持久命名空间、代码循环和普通模型调用函数 |

精确来源身份记录在 `ref/*/SOURCE_POINTER.json`，两个 checkout 都是只读证据。

## V1 采用

- context 成为 Python 变量；
- 同一会话复用一个持久 namespace；
- Python 代码可以循环、分支并调用模型；
- TypeScript 宿主持有 Provider、凭据、Subagent 和取消权；
- Python 只接收 prompt 和可见文本结果；
- cell 串行、有硬超时和输出上限；
- DSH Agent Loop 代替参考实现自己的外层 `answer.ready` 循环。

参考 RLM 默认 `max_depth = 1`。因此 V1 的 `rlm_query` 是 one-shot 叶调用，
无需先实现递归子 RLM。

## V1 不采用

- Prime Agent 的 daemon、TUI、安装器和完整故障恢复；
- RLM 的 Markdown REPL block 解析和第二个 Agent Loop；
- Python 侧模型客户端与凭据；
- 公共 `RlmService`、Provider registry 和 conformance suite；
- run/context/checkpoint Storage Domain；
- snapshot/restore、continuable spawn、batching 和深层递归；
- Workflow、Jobs、Team、UI 或 observability runtime。

这些能力不是永久禁止；只有出现
[后续扩展架构](future-extensions.md) 中的真实触发条件才添加。

## DSH 适配

- 一个 `rlm_eval` 工具通过当前 `exec.agent` 确定 Session；
- 运行时以 Session 为键保存 Python 进程，不接受模型提供的 run ID；
- `rlm_query` 使用官方 one-shot Subagent，并在子调用中禁用 RLM 工具；
- 工具调用和结果进入官方 Session log；
- 插件卸载负责释放所有 Python 进程和 one-shot runs。

首个实现不以行数为目标。唯一进度标准是
[M1 端到端闭环](milestones.md#m1rlm-与自我迭代闭环)是否在真实 Profile 中通过。
