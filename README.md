# dsh-rlm

`dsh-rlm` 是 DeepSeek Harness 的最小 RLM 插件：模型通过一个 `rlm_eval`
工具使用当前 Session 的持久 Python namespace，并能在 Python 中
`await rlm_query(prompt)` 调用官方 one-shot Subagent。

V1 只实现 RLM 与自我迭代闭环。它不包含公共 Service、Storage、snapshot、
spawn、Provider 框架、Workflow、Jobs、Team 或 UI。

当前仍是禁用的可构建脚手架；核心 kernel/query 闭环实现前，启用插件会明确
失败。

## 文档

- [核心架构](docs/architecture.md)
- [里程碑](docs/milestones.md)
- [后续扩展架构](docs/future-extensions.md)
- [目录结构与语言](docs/directory-structure.md)
- [参考项目取舍](docs/reference-analysis.md)
- [交互式架构图](docs/dsh-rlm-architecture.html)

## 固定参考源

- `PrimeIntellect-ai/prime-agent@6179a608f394d0858d463e40d648df0def6dbb7a`
- `alexzhang13/rlm@854e688fbba9d8f8989e3da9989812e4b6dfe270`
