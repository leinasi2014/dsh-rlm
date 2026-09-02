# 目录结构与语言

> [English](directory-structure.md) | 简体中文

## 语言边界

- **TypeScript/Node.js**：注册 DSH 工具、按 Session 管理进程、调用 one-shot
  Subagent、处理取消和插件 dispose。
- **Python 3.11+**：保存 globals、执行 cell，并通过宿主回调实现
  `await rlm_query()`。

V1 是一个 npm 包和一个 Python 脚本，不拆 Service、Provider 或协议包。

## V1 目录

```text
dsh-rlm/
├─ package.json
├─ src/
│  ├─ index.ts             # 配置、system prompt、rlm_eval 注册与 dispose
│  └─ runtime.ts           # Session 内核表、进程协议、one-shot query bridge
├─ python-runtime/
│  └─ rlm_kernel.py        # persistent globals、top-level await、rlm_query
├─ tests/
│  ├─ rlm-loop.test.ts     # Python/query/跨 cell 闭环
│  ├─ profile-smoke.test.ts# 真实 DSH Profile 组合
│  └─ development-memory-gate.test.ts # 仓库证据门禁
├─ docs/
│  └─ development-memory/
│     └─ records/<年份>/   # append-only Issue/workstream 智能体轨迹
├─ scripts/                # 小型仓库治理检查
├─ .githooks/              # 本地快速门禁；CI 为权威
└─ ref/
```

这些治理文件不改变 V1 runtime 边界。在 runtime 单个文件接近项目行数限制、
出现第二个独立 Consumer，或第二个真实内核实现
开始编码之前，不继续拆文件。届时按
[后续扩展架构](future-extensions.zh-CN.md) 的触发条件做最小拆分。
