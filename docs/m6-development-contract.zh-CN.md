# M6 交付契约

> [English（权威版本）](m6-development-contract.md) | 简体中文

本契约只治理已接受 M5 `main` 基线上的 [M6 手动重置](m6-manual-reset.md)。它继承
仓库的上游、TDD、memory、权限、Git、审查、CI 和 clean-Profile 门禁。

## 交付顺序

1. 保留真实 Profile RED，证明接受的 M5 main 无法完成预期的
   `rlm_eval({reset:true})` journey；独立审查这个狭窄的 Session-lifecycle
   边界，并合入本契约、中文镜像和已校验 lifecycle 图。
2. 为同 Session 顺序、PID replacement、M3/M5 cleanup、取消及兄弟/递归隔离
   添加 focused RED。
3. 实现最小的 queue-aware reset path，不改变 one-tool、one-loop DSH authority。
4. 完成 full checks、独立语义审查、GitHub CI、remote-main read-back 和新的
   installed-plugin DSV4-FVE Profile smoke。

一个 Issue 拥有 M6。除非阻塞手动 reset 验收，dogfood 的偶发问题必须单独复现并立 Issue。

## 必要证据

- 每次生产或测试编辑前立即运行官方 DSH upstream gate。
- RED 必须证明接受的 Profile 不能完成预期 reset journey；mock 可补充，不能替代 Python process/session 边界。
- GREEN 覆盖 FIFO 顺序、kernel/child cleanup、M3 context 丢失、M5 checkpoint 删除、
  排队与已激活 reset 的取消终态，以及 Session 隔离。
- 真实验收使用 disposable DSH Home、安装本地包、启用 `snapshotRecovery`、固定
  DSV4-FVE vLLM/PTC，并确认 ambient settings/credentials 字节不变。

## Candidate 边界

生产修改只可触及 `src/runtime.ts`，以及确有 tool schema/result plumbing 需要时的
`src/index.ts`。除非出现已证明的 protocol 必要性，`python-runtime/rlm_kernel.py`
保持不变。测试留在现有两个文件。M6 不得引入新模型工具、公共 Service、Storage Domain、
Provider abstraction、UI、job、background task 或 DSH API shortcut。

每个实质参与者都在 `docs/development-memory/records/2026/issue-33.jsonl` 留下
Issue #33 记录。独立 reviewer 只读；行为性发现必须先形成 successor RED 再修正。
