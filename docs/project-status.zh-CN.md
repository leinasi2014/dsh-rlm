# 项目状态

> [English](project-status.md) | 简体中文

本文记录已接受实现边界和下一批有序里程碑。实时进度以 GitHub Issues、
[里程碑](milestones.zh-CN.md) 与可执行测试共同为准。

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

- 已接受 M1/M2 基线：`260484d7d92e43fcb99c54ab987436d494501845`
- 状态日期：2026-09-03
- 固定参考：`ref/rlm` 与 `ref/prime-agent`，只作为设计证据，不作为逐字兼容目标
- 当前阶段：M1/M2 已通过本地、审查、CI、远端 main 回读及真实干净 Profile
  门禁；M3 架构/契约正在集成

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

## 已接受的 M2 可靠性

公开 M2 修复 Issues 均已关闭。已接受基线包含 Session FIFO 串行化、有界协议帧
和错误、query/child 静止、scaffold/result 隔离、配置与系统提示校验，以及
Python 安全名称环境白名单。完整基线共有 138 项测试（136 通过，2 项按设计
由 live 开关设门），并通过 DSV4-FVE 干净 Profile 路径。

## 有序待办

1. [M3 托管上下文](m3-managed-context.zh-CN.md)：有界、原子、受保护的绝对
   文件加载，正文不经模型可见输入复制；
2. [M4 递归子 RLM](m4-recursive-child-rlm.zh-CN.md)：官方深度限制子 Session、
   隔离内核和整分支静止。

[开发契约](m3-m4-development-contract.zh-CN.md) 要求文档先行、WIP=1、TDD、
独立审查、CI、远端 main 回读，并为每个里程碑完成真实 DSH/Profile 验收。
dogfood 发现先复现、汇总并独立提 Issue，不静默扩张 M3/M4。

## 有条件的未来工作

以下能力尚未开始，而且不是 M1 缺陷：snapshot/restore、Storage Domain、run
record、continuable spawn、批量查询、第二种 kernel、跨 Host
恢复、费用账本、UI、Workflow、Jobs 与 swarm。只有在真实需求和验收证据出现后
才会进入里程碑。
