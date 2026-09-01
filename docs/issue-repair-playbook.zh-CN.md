# GitHub Issue 修复操作规范

> [English authority](issue-repair-playbook.md) | 简体中文

本规范用于公开 `dsh-rlm` 仓库的缺陷修复，目标是让每次修复保持小、可追踪、
可独立审查，并由可执行证据闭环。它不授权 Issue 范围之外的新功能、发布、破坏性
清理或外部变更。

## 1. 修复目标

只有修复已经进入权威 `main`、目标分支 CI 通过、所需真实边界验证通过，并且
任务拥有的进程与 workspace 已清理后，才能关闭 Issue。

M2 修复必须保持 V1 架构：唯一工具 `rlm_eval`、每 Session 一个 Python kernel、
一个 one-shot `rlm_query` bridge、官方 DSH Agent Loop 与 Session log 作为权威；
不引入公共 Service、Storage、snapshot、递归子 RLM 或第二 Agent Loop。

## 2. 思考强度策略

思考强度按语义风险分配，不按代理名称或任务长短分配。每次派发必须显式记录，
执行者不得静默降级。

| 强度 | 使用范围 | 禁止用于 |
|---|---|---|
| `max` | 架构/契约；并发、顺序、取消、超时、进程生命周期；协议/对抗边界；凭据安全；未解决根因；真实 Profile 故障分类；M2 最终集成审查 | 轮询、格式整理、普通状态更新 |
| `high` | 有明确边界的代码实现、测试 oracle 设计、代码审查、集成冲突、插件与配置行为；这是代码任务默认值 | 无语义选择的纯机械维护 |
| `medium` | oracle 已确定后的测试编码、文档、Issue/PR 证据评论、已知机械修正 | 架构、安全、生命周期、并发、验收结论 |
| `low` | 等待/轮询、格式、标签、逐字转录等非语义事务 | 任何生产代码、测试设计、根因判断、审查、QA 结论、集成判断或真实验收 |

项目默认：

- 代码任务默认 `high`。
- Issue #1、#2、#3、#4、#7 的根因/契约决策与独立语义审查使用 `max`；方案冻结后，
  有界代码实现默认使用 `high`。
- Issue #5、#6 使用 `high`；如果触及生命周期/权威边界，或第一次语义修正失败，
  提升为 `max`。
- M2 最终组合审查和真实干净 Profile 验收使用 `max`。
- 同一语义面的 reviewer 强度不得低于 author。
- 一次意外语义失败，下一轮提升一级；连续两次没有新证据的失败则停止写入，由
  coordinator 使用 `max` 重新执行 reference-first 定界。
- 只有把已经完成的语义工作与新的纯机械包拆开，才能降级；进行中的语义任务
  不得降级。

如果 `DeepSeek-V4-Flash-Vision-Exp` 不可用，不切换模型、不降低强度。停止依赖
派发，保存任务和 Candidate 身份，检测等待恢复后以原强度继续缺失工作。

## 3. 一个 Issue 对应一个修复流水线

```text
OPEN -> REPRODUCED -> IMPLEMENTING -> CANDIDATE
     -> REVIEWED -> ACCEPTED -> INTEGRATED -> VERIFIED -> CLOSED
```

`CANDIDATE`、`REVIEWED`、`ACCEPTED` 都不是完成。内容改变会产生新 Candidate。
通过验收后必须立即集成，否则要记录精确 `INTEGRATION_BLOCKED`。

## 4. 开工门禁

写代码前绑定：

```yaml
issue: "#编号"
base: "origin/main 完整 SHA"
branch: "codex/issue-编号-简名"
model: "DeepSeek-V4-Flash-Vision-Exp"
runtime: "vLLM/PTC"
reasoning: "medium | high | max"
writer: "唯一写入者"
reviewer: "非作者"
owned_paths: []
forbidden_scope: []
acceptance_tests: []
first_material_event: "失败复现或精确 blocker"
```

Issue 结果和非目标必须可测试；base、工作树、依赖、writer/reviewer、集成容量必须
已知；同一可变语义面不能存在第二个 writer。

## 5. DSH/PTC 控制面规则

- 只通过内置浏览器真实操作 `http://127.0.0.1:49321/`。
- 禁止调用页面 API 代替 UI 操作。
- 只保留一个标签页，用完关闭，需要时再开。
- 首次派发前回读 Candidate/base、workspace、团队/Session、模型、vLLM/PTC 和
  reasoning 强度。
- 每个 Candidate 使用隔离的模型开发/验收状态。
- 模型报告不等于代码、审查、集成或验收证据。

## 6. 修复循环

### 6.1 先复现

修改生产代码前，至少获得一个当前 base 必然失败的回归测试、确定性最小复现、
PID/状态证据、类型化错误/终态偏差，或绑定 Candidate 的真实 DSH 观察。

没有复现就不实现。真实失败 attempt 是证据，不能在原运行状态上修补成绿色。

### 6.2 Reference-first

先检查受影响代码与测试，再检查 `ref/rlm` 和 `ref/prime-agent` 的相同机制，
并在 Issue 记录：

```text
直接复用 | 通过小适配器复用 | 与当前架构冲突 | 参考中不存在
```

只有本地和固定 ref 仍留下关键不确定性时才查上游权威来源。不能因为症状类似就
复制 daemon、Storage、旧帧名或第二权威。

### 6.3 最小修复

- 只修改 Issue 拥有的边界和验收行为。
- 优先直接代码和小型 private helper，禁止先建 framework/registry。
- 禁止放宽断言、删除测试、隐藏失败或延长 timeout 制造通过。
- 无关问题另开 Issue。
- 不提交 `lib/`、`node_modules/`、Profile、Session log、凭据、coverage、日志或
  `ref/*/source/`。

### 6.4 作者自证

每个 Candidate 至少运行：

```bash
pnpm typecheck
pnpm build
node --test tests/rlm-loop.test.ts tests/profile-smoke.test.ts
```

并运行对应正向/负向定向测试：生命周期检查 PID/进程树；协议检查巨帧、无换行、
UTF-8；query 检查 timeout/cancel/迟到结果；kernel 检查保留名称与异常
`repr()`；环境隔离检查 sentinel secret；配置检查 schema 和 prompt 生命周期。

结果统一记录为 `PASS | FAIL | FLAKY | NOT_RUN | NOT_CONFIGURED`。

### 6.5 冻结和审查

Candidate packet 包含 Issue、base SHA、Candidate SHA、变更文件、定向/完整测试、
文档影响和已知限制。Reviewer 只读审查精确 Candidate，不得边审边修。

阻塞问题形成 successor Candidate。架构和安全边界未改变时只做 delta review；
改变时重新完整审查。

## 7. Git 与 PR

- 分支：`codex/issue-编号-简名`。
- 使用 Conventional Commits。
- 每个 commit 是小型可工作的切片；禁止把所有 M2 Issue 合成一个提交/PR。
- 保留无关改动；未经用户明确授权不得重写已发布历史。
- 原则上一个 Issue 一个 PR，正文包含 `Closes #N`，并说明问题、根因、ref 决策、
  实现、验收映射、测试、安全/生命周期影响和剩余限制。

## 8. 并发和集成

`runtime.ts`、`rlm_kernel.py` 和共享测试采用 shared-authority 模式：移动中的语义面
只有一个 writer；QA/oracle、只读 ref 分析和审查准备可以并行。Worktree 不能让
两个 writer 同时修改同一语义权威。

PR 串行集成。证据和审查通过后的下一步必须是按预期 `main` 集成、远端回读和
目标 CI，不能先拉取依赖修复。

建议顺序：#1 → #5 → #3 → #4 → #2 → #7 → #6。

## 9. 关单条件

同时满足以下条件才关闭 Issue：

- 每项验收条件都有证据；
- 回归测试在 base 失败、Candidate 通过；
- 所需独立审查通过；
- PR 已合并，远端 `main` 已回读；
- 目标 CI 和所需干净 Profile 验证通过；
- 没有遗留 Python、Subagent、worktree 或 dirty state；
- 公开/安全/架构文档已更新或明确 `not-needed`。

最终 Issue 评论：

```text
Integrated candidate: <SHA>
Main result: <SHA>
CI: <URL>
Focused tests: PASS
Full offline suite: PASS
Live Profile smoke: PASS | NOT_REQUIRED
Process/resource cleanup: PASS
Documentation: updated | not-needed
Residual risk: none | <精确限制>
```

只有 7 个 Issue 均在 `main` 验证，并且全新 Profile 加载精确构建 Candidate、完成
RLM 闭环并证明隔离、边界、清理和配置后，才能关闭 M2 milestone。
