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

任何变更开始前绑定：

```yaml
issue: "#编号"
base: "origin/main 完整 SHA"
dsh_authority: "https://github.com/deepseek-ai/deepseek-harness.git"
dsh_branch: "master"
dsh_local_sha: "选定 DSH checkout 的完整 SHA"
dsh_upstream_sha: "刚获取的官方完整 SHA"
dsh_relation: "ahead=<n> behind=0"
dsh_artifact_target: "已安装/发布的 @deepseek-ai/* 版本或已测试 source-workspace SHA"
dsh_runtime_target: "真实验收所加载的精确 DSH/Profile build"
branch: "codex/issue-编号-简名"
workspace: "绝对路径的自有 worktree 或受控环境"
session: "DSH workspace/team/Session 身份"
model: "DeepSeek-V4-Flash-Vision-Exp"
runtime: "vLLM/PTC"
reasoning: "medium | high | max"
access: "Read Only | Full Access"
access_basis: "整个任务为何无变更，或为何需要完整执行能力"
writer: "唯一写入者"
reviewer: "非作者"
owned_paths: []
mutable_scope: [] # 任务授权的 Git/配置/Profile/进程/端口/外部资源
forbidden_scope: []
acceptance_tests: []
memory_stream: "docs/development-memory/records/<年份>/issue-<编号>.jsonl"
first_material_event: "失败复现或精确 blocker"
```

Issue 结果和非目标必须可测试；base、工作树、访问模式与可变范围必须覆盖整个
任务，依赖、writer/reviewer、集成容量必须已知；同一可变语义面不能存在第二个
writer。

### 4.1 DSH 官方上游权威门禁

`ref/rlm` 与 `ref/prime-agent` 是固定的设计参考，不是 DSH 最新性证据。任何生产
代码或测试变更之前，先选定要检查最新性的 DSH source checkout，并运行：

```powershell
$env:RLM_DSH_REPO_ROOT = 'C:\path\to\deepseek-harness'
pnpm check:upstream
```

生产命令固定 `origin` 为官方仓库、固定分支为 `master`，环境变量和 CLI 参数都不能
改写该权威。命令在不改变 tracked 文件的前提下 fetch 当前 tip，并且只输出规范化
权威、分支、本地/上游 SHA 与 ahead/behind。选定 checkout 不能有 tracked index/
worktree 改动，且只有 `behind=0` 才通过；untracked 文件不改变 HEAD 源码，因此忽略。
隔离 checkout 可以包含额外提交，但必须包含刚获取的官方 tip。

如果结果为 stale、diverged 或 wrong authority，必须先使用/创建位于最新 tip 的
隔离 DSH checkout；若上游不可达，则记录 `NOT_VERIFIED`，不得声称或开始“面向最新
DSH”的开发。门禁禁止自动 pull、reset 或 rebase 用户的 DSH 工作树。

官方 `master` 是最新源码权威，不会自动成为插件的可执行兼容性目标。已安装/发布
package 类型与实际加载的 Profile runtime 才是可执行权威。PASS 后检查所有受影响
`@deepseek-ai/*` 边界，并把 source SHA 映射到已发布版本或明确测试的 source
workspace；契约变化时进入 RED 前对该 artifact 完成 typecheck/build。源码或类型
通过不能替代 runtime、Session、tool、Subagent 或生命周期的干净 Profile 验证。

Issue 与 development-memory 必须记录 source SHA、artifact/version 映射、精确 runtime
目标与结果。Git 以非交互模式运行，失败诊断限长并清除 URL 凭据。本检查只属于开工
门禁，不进入普通 commit hook/CI。若最终真实验收前官方 tip 可能移动，则重新检查并
显式评估漂移，不能静默扩大 Candidate。

## 5. DSH/PTC 控制面规则

- 只通过内置浏览器真实操作 `http://127.0.0.1:49321/`。
- 禁止调用页面 API 代替 UI 操作。
- 只保留一个标签页，用完关闭，需要时再开。
- 只有预先确认整个任务不会修改文件、Git、配置、Profile、进程、端口、构建/
  测试产物或外部状态时，才使用 `Read Only`。
- 实现、修复、测试/构建、集成、真实验收和任务自有产物清理，从会话开始即使用
  `Full Access`；禁止先用受限模式启动可写任务，再依赖反复的中途审批升级。
- `Full Access` 只扩大执行能力，不扩大任务授权；允许路径、非目标、破坏性操作
  保护、凭据边界以及 push/merge/release 限制保持不变。
- 只读任务发现必须写入时，停止并以明确写域和 `Full Access` 重新派发；reviewer
  一旦成为 fixer，就失去该 Candidate 的独立审查身份。
- 首次派发前回读 Candidate/base、workspace、团队/Session、模型、vLLM/PTC 和
  reasoning 强度、访问模式与写入范围。
- 每个 Candidate 使用隔离的模型开发/验收状态。
- 模型报告不等于代码、审查、集成或验收证据。

## 6. 修复循环

Issue 修复默认采用“架构契约优先”的 TDD 循环：

```text
契约 -> RED -> GREEN -> REFACTOR -> 完整门禁 -> CANDIDATE
```

进入 RED 前先冻结可观察行为、状态/所有权边界、失败语义、限制、兼容性和非目标。
RED 与 GREEN 可以由不同轮次执行，但必须属于同一个 Issue 和同一 Candidate 血统。

### 6.1 RED：先复现

修改生产代码前，至少获得一个当前 base 必然失败的回归测试、确定性最小复现、
PID/状态证据、类型化错误/终态偏差，或绑定 Candidate 的真实 DSH 观察。

回归必须在已接受 base 或当前前序 Candidate 上因目标原因失败。原本就通过、因环境
噪声失败，或真实缺陷跨越进程/协议边界却只测 mock 的用例，都不算 RED。

没有复现就不实现。真实失败 attempt 是证据，不能在原运行状态上修补成绿色。暂时
无法自动化时，先保存确定性命令、进程/状态探针或绑定 Candidate 的真实观察；契约
可执行后立即补上最近的有效自动回归。

### 6.2 Reference-first

先检查受影响代码与测试，再检查 `ref/rlm` 和 `ref/prime-agent` 的相同机制，
并在 Issue 记录：

```text
直接复用 | 通过小适配器复用 | 与当前架构冲突 | 参考中不存在
```

只有本地和固定 ref 仍留下关键不确定性时才查上游权威来源。不能因为症状类似就
复制 daemon、Storage、旧帧名或第二权威。

### 6.3 GREEN：最小修复

- 只修改 Issue 拥有的边界和验收行为。
- 优先直接代码和小型 private helper，禁止先建 framework/registry。
- 禁止放宽断言、删除测试、隐藏失败或延长 timeout 制造通过。
- 无关问题另开 Issue。
- 不提交 `lib/`、`node_modules/`、Profile、Session log、凭据、coverage、日志或
  `ref/*/source/`。

生产修改后先运行 RED 用例。GREEN 只证明被冻结且被测试覆盖的行为，不授权顺带
重构相邻架构。

### 6.4 REFACTOR：不改变契约

- 只有已有定向 GREEN 证据后才能重构。
- 每次结构调整后保持定向回归和邻近代表性检查绿色。
- 禁止为了“更整洁”引入 framework、公共抽象或未来功能脚手架。
- 重构若改变可观察行为或发现另一个缺陷，停止并建立 successor RED，不能混入
  当前证明。

### 6.5 完整门禁：作者自证

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
每个实质参与的智能体都要在该 Issue 的 development-memory 流中追加本人记录，写明
相关文件和语义指针、步骤、证据与限制；协调者不得冒充作者。

### 6.6 冻结和审查

Candidate packet 包含 Issue、base SHA、Candidate SHA、变更文件、DSH 权威分支/SHA
与兼容性证据、定向/完整测试、development-memory record IDs、文档影响和已知限制。Reviewer 只读审查精确
Candidate，不得边审边修。

阻塞问题形成 successor Candidate。架构和安全边界未改变时只做 delta review；
改变时重新完整审查。

阻塞性语义发现必须先形成新的失败回归或等价可重复观察，再由作者执行 successor
GREEN；reviewer 不得一边修改 Candidate 一边保留独立审查身份。

## 7. Git 与 PR

- 分支：`codex/issue-编号-简名`。
- 使用 Conventional Commits。
- 每个 commit 是小型可工作的切片；禁止把所有 M2 Issue 合成一个提交/PR。
- 保留无关改动；未经用户明确授权不得重写已发布历史。
- 原则上一个 Issue 一个 PR，正文包含 `Closes #N`，并说明问题、根因、ref 决策、
  实现、验收映射、测试、安全/生命周期影响和剩余限制。
- PR 还必须列出所有实质参与者的 development-memory `recordId`；review 期间不得
  重写既有 JSONL 行。

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
- 每个实质贡献者的 development-memory 记录均存在，且 ID 已链接到 Candidate/PR 证据。

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
