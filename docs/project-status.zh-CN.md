# 项目状态

> [English](project-status.md) | 简体中文

本文记录首次公开发布时的实现边界。后续缺陷和验收进度以 GitHub Issues、
`docs/milestones.md` 与代码测试共同为准。

## 目标

交付 DeepSeek Harness 中最小、可验证的 RLM 闭环：

```text
DSH Agent -> rlm_eval(code) -> Session Python kernel
  -> await rlm_query(prompt) -> one-shot DSH Subagent
  -> text returns to Python -> cell continues
  -> next rlm_eval reuses globals
```

目标边界是：DSH Session log 仍是模型可见历史的权威；Provider 和凭据留在
Host；Python kernel 只执行代码、维护 Session 内 globals，并通过宿主发起一次性
子智能体查询。

## 发布基线

- 审查基线：`e1ce33e0d984a340e949768975e2397d8b62bd0b`
- 审查日期：2026-09-02
- 固定参考：`ref/rlm` 与 `ref/prime-agent`，只作为设计证据，不作为逐字兼容目标
- 当前阶段：M1 主闭环已实现并做过真实干净 Profile 验证；M2 可靠性基线未完成

## 已完成

### M1A：Python kernel

- 持久 globals
- top-level `await`
- 尾表达式结果
- `stdout`/result UTF-8 字节截断
- 类型化 cell 错误

### M1B：TypeScript runtime

- JSON-lines 子进程协议
- 每 Session 一个 kernel
- eval、result、error、timeout、cancel 和 dispose 主路径
- timeout 后杀进程树并按需重建 kernel

### M1C / M1D：DSH 集成与查询桥

- 唯一公开工具 `rlm_eval`
- Session 作用域隔离
- `await rlm_query(prompt)` 到 one-shot DSH Subagent 的往返
- 子智能体通过 `toolFilter` 禁止递归调用 `rlm_eval`
- 子智能体完成后释放

### M1E：真实 Profile 冒烟

真实干净 DSH Profile 已验证以下路径：插件安装/加载、中文 UTF-8 文件读取、
`rlm_query` 返回后 Python 继续执行、第二个 cell 复用变量、官方 Session log
出现有界工具结果，并且子智能体没有递归获得 `rlm_eval`。

活体测试默认由 `RLM_LIVE_SMOKE=1` 设门，避免普通单元测试意外调用模型。

## 未完成

M2 仍有以下确认缺口。首次发布后按这 7 组修正任务登记，并以公开 GitHub
Issues 作为 live authority：

1. kernel 生命周期：协议故障孤儿、ready deadline，以及 dispose 终态；
2. Session 串行队列：同 Session 并发 cell 不应直接返回 `busy`；
3. 有界协议：stderr、未换行缓冲、query 与 error 等载荷的统一字节上限；
4. query/child 生命周期：timeout、取消、故障和卸载时取消并等待 child，拒绝
   completed 但无可见文本，并保持 query 错误 taxonomy；
5. scaffold 与结果隔离：`repr()`、内部结果槽和 `rlm_query` binding 的 cell
   级失败隔离；
6. 配置与 system prompt：公开完整 V1 runtime 配置并注册简短使用提示；
7. Python 环境隔离：不默认继承可能包含 Provider 凭据的宿主环境变量。

因此当前准确状态是：**M1 核心闭环已交付，M1 收口与 M2 可靠性仍开放**。

## 有条件的未来工作

以下能力尚未开始，而且不是 M1 缺陷：snapshot/restore、Storage Domain、run
record、continuable spawn、递归 RLM、批量查询、第二种 kernel、跨 Host
恢复、费用账本、UI、Workflow、Jobs 与 swarm。只有在真实需求和验收证据出现后
才会进入里程碑。
