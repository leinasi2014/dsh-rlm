# 开发记忆总档案

> [English authority](README.md) | 简体中文

本目录保存每个人类或智能体的开发、修复、测试和审查轨迹。GitHub Issues 仍是实时
任务状态权威；这里是不可变历史证据，不是第二套 backlog 或智能体管理系统。

## 记录分流

按“可独立验收的工作流”建立 JSONL，不按智能体、prompt、单次编辑或 commit 拆分：

```text
records/<创建年份>/issue-<N>.jsonl       # 有 Issue 的工作
records/<创建年份>/task-<slug>.jsonl     # 有界的非 Issue 工作
```

同一开放 Issue 的开发、修复、测试和审查都追加在同一流；新产品范围或关单后发现的
缺陷必须建立新 Issue 流。年份目录自然区分新旧记忆，不移动已关闭证据，也不复制
GitHub 状态。

文件路径本身就是一级索引，通过 `rg` 查询 work item、智能体、文件、symbol 或记录 ID：

```bash
rg --files docs/development-memory/records
rg '"issue":1|src/runtime.ts|Kernel.evalCell' docs/development-memory/records
```

禁止向 Git 添加人工维护的逐记录索引、数据库、向量库或生成缓存。单个工作流达到
2 MiB 或 1000 条记录时，才续写 `issue-<N>-part-02.jsonl` 或
`task-<slug>-part-02.jsonl`。

## 记录归属和粒度

每个实质参与的智能体都写自己的记录。谁实现功能或修复 bug，谁负责对应实现记录；
测试设计者、reviewer 和真实环境验证者分别记录自己的贡献，不合并到 implementer 名下。

每个智能体对每个冻结 Candidate 或交接点最多写一条；Candidate 冻结前的多轮修改合并
记录。阻塞发现产生 successor Candidate 时再新增记录。协调者可以追加其他智能体返回
的记录，但必须保留其声明身份，不得冒领。

每行紧凑 JSON 包含：

- `schemaVersion`、唯一 `recordId`、带时区的 `recordedAt`；
- 智能体身份、模型、角色和声明的思考强度；
- `issue` 或有界 `workItem`、`baseCommit`、`candidateRef`；
- 摘要和关键 `files`，每个文件附 symbol、test name、heading 或 `deleted` 等耐久语义
  `pointers`；行号只能补充；
- 实现、诊断、测试或审查 `steps`；
- 测试、review 或 live `evidence`，包含 target、规范化结果和说明；
- 已知 `limitations`；append-only 纠错时可加 `correctsRecordId`。

禁止保存 prompt、chain-of-thought、凭据、Session log、Profile 内容或私有模型输出。

## 智能体工作流

1. 实质工作前绑定 Issue、base、Candidate 和本人身份。
2. 只处理已分配边界，并运行适用检查。
3. 本人追加带语义指针和真实证据的记录；不得修改、删除或重排旧行，纠错只能追加。
4. 将记录与实质变更一起 stage；Candidate packet 和 Issue/PR 证据列出所有参与者
   `recordId`。

## Hook 与门禁

每个 clone 执行一次：

```bash
git config --local core.hooksPath .githooks
```

可直接运行：

```bash
pnpm check:memory
pnpm check:memory:staged
node scripts/check-development-memory.mjs --range <base>..<head>
```

门禁校验 schema、单行/单流大小、ID 唯一、真正 append-only、仓库相对语义指针、实质
变更证据及 `codex/issue-N-*` 分支绑定；CI 重复检查提交区间。它刻意不记录每个机械动作，
也不要求把所有文档路径重复抄进 JSON。

身份由贡献者声明；自动化不能用密码学证明身份，也不能发现被隐瞒的参与者。该社会边界
仍由独立审查和 Candidate 证据负责。
