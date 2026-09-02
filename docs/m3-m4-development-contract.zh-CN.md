# M3/M4 开发契约

> [English (authoritative)](m3-m4-development-contract.md) | 简体中文

本契约约束先实现 [M3 托管上下文](m3-managed-context.zh-CN.md)，再实现
[M4 递归子 RLM](m4-recursive-child-rlm.zh-CN.md)。共享
[架构图](dsh-rlm-architecture.html) 由受版本管理的
[Archify 源文件](dsh-rlm-architecture.archify.json) 生成。

## 交付顺序与 WIP

1. 对照最新官方 DSH 源码和固定 `ref/` 证据冻结并独立审查契约。
2. 在修改 M3 生产代码前先集成文档切片。
3. M3 必须经过 TDD、审查、CI、远端 main 回读和干净 Profile 验收。
4. 之后才按同样门禁启动 M4。

在制里程碑限制为一个。可以提前设计 M4 测试，但 M4 生产代码不得进入 M3
Candidate。

## TDD 契约

每个可观察行为都执行：

1. **RED：**增加最小聚焦测试/复现，并保存其因目标契约原因失败的证据；
2. **GREEN：**只做最小因果生产修改；
3. **REFACTOR：**仅在聚焦测试和代表性测试保持绿色时改进结构；
4. **FULL GATE：**运行 `pnpm check:upstream`、类型检查、构建、聚焦与全量
   测试、开发记忆门禁、独立语义审查、GitHub CI、远端 main 回读及里程碑
   干净 Profile 冒烟。

若行为跨越真实进程/协议/Session 边界，测试也必须跨越该边界；仅 mock 通过
不能关闭验收项。

## DSH dogfood 与问题流入

开发持续使用最新已完成插件、最新已接受官方 DSH checkout，以及配置的
`DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC 路由。适合时用真实 `rlm_eval`
完成源码/上下文分析。

偶然发现不得扩张当前里程碑：

1. 记录观察、准确 Profile/模型/插件 revision 和证据；
2. 尽可能在 Candidate 之外复现；
3. 分类为插件缺陷、DSH 兼容变化、环境问题或预期行为；
4. 合并重复项后创建一个独立范围的 GitHub Issue；
5. 除非阻塞验收，否则安排在当前里程碑之后修复。

没有冻结契约和 RED 测试，不得顺手修复。

## 智能体、记忆与审查门禁

- 统筹者拥有集成、`main` 和最终验收权。
- 每个智能体获得一个有界写范围、当前 TDD 阶段、base SHA、架构链接、权限
  模式及必跑检查。
- 架构、递归、生命周期、安全和最终语义审查使用最大思考强度；边界明确的
  实现通常使用 high。
- 可能写文件、跑测试、生成产物或操作进程的任务以 Full Access 开始；真正
  无修改的审查可用 Read Only。
- 每位实质贡献者在 `docs/development-memory/` 追加自己的不可变记录；实现者
  也负责记录其 Candidate 后续修正。
- 独立审查者不得修改 Candidate；改变行为的发现必须先形成后继 RED。

## Git 与 Issue 门禁

- 一个 GitHub Issue 对应一份验收契约和一条开发记忆流；不按文件或微步骤拆分。
- 可行时单独提交 RED 证据；GREEN/REFACTOR 提交必须关联 Issue 且可审查。
- 不能仅凭模型报告合并 Candidate；必须先记录检查、审查发现和真实验收证据。
- 合并后 fetch 远端 `main`，核对合并 SHA/内容/CI，再从已接受 revision 运行
  干净 Profile 验收。
- dogfood 新缺陷创建独立 Issue，不得隐藏在 M3/M4 中。

## 兼容性权威

任何生产/测试修改前，所选 DSH checkout 必须通过 `pnpm check:upstream`。
已安装 `@deepseek-ai/*` 类型和实际加载的 Profile 运行时是可执行权威；
`ref/` 只作为只读先验设计证据。如有冲突，先停止修改、记录差异并解决契约。
