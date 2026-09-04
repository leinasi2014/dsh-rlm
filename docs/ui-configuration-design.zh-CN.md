# dsh-rlm GUI 插件配置设计

> [English (authoritative)](ui-configuration-design.md) | 简体中文 | [交互图](ui-configuration-design.html)

## 目标与范围

为 Web UI 的 **Settings > Plugins > Plugin configuration** 提供一个可展开的 `dsh-rlm` 卡片，与 DSH
自带的宿主插件（bash、agent-loop、web-search）以及 `dsh-agent-swarm` 的 Team 设置卡片一致。卡片编辑
DSH 所有的 settings 命名空间；Host 运行时消费与今天 `cordis.patch.yml` 会提供的同一份规范化配置，
因此 CLI 与 UI 共享同一权威。不引入第二套 UI 系统、不复制配置 schema、不新增存储：settings 命名空间
是唯一用户层，部署 composition（cordis patches）仍为回退层。

明确不在范围内：配置 Python 内核内容、provider 凭据、模型选择（已由 DSH Model 设置拥有）、以及任何
逐 Session 行为。

## 配置分层

### A. 用户可配置（渲染为可编辑字段）

这些项具有安全默认值，面向部署级调优，是卡片渲染的字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | 开关 | `false` | 总开关；在任何内核启动前生效 |
| `provider` | 选择（文本） | `spawn` | 一次性查询 Subagent 的 provider |
| `python` | 文本 | `python` | 解释器；允许路径或绝对路径 |
| `timeout` | 数字（ms） | `30000` | 单次 eval 总预算 |
| `maxStdout` | 数字（字节） | `65536` | 单元格 stdout 上界 |
| `maxResult` | 数字（字节） | `65536` | 单元格 result 上界 |
| `maxQueries` | 数字 | `16` | 每单元格 `rlm_query` 次数 |
| `maxContextBytes` | 数字（字节） | `67108864` | 受管 context 上限 |
| `snapshotRecovery` | 开关 | `false` | M5/M10：属主内核丢失后恢复 |
| `kernelSandbox` | 选择 | `auto` | M9：auto/require/off |
| `durableRoot` | 文本（路径） | 无 | M10 宿主机私有持久根 |
| `guardQueryTokens` | 开关 | `false` | M11 观测 token 护栏 |
| `maxQueryTokensPerCell` | 数字 | `0` | M11 上限；0 = 关闭 |
| `maxDepth` | 数字 | `8` | M4 委派深度上限 |

### B. 必须配置（校验，无安全运行时默认值）

- `enabled: true` 是插件做任何事的前提；卡片显式表达，关闭时禁用其余表单。
- `provider` 必须命名已注册的 DSH Subagent provider；针对活动 `ctx.subagents` 目录校验
  （staged 非法值阻止保存）。
- `durableRoot` 非空时必须为绝对宿主目录；提交前由服务端校验 closed-ACL 路径。
- `python` 必须可解析；保存时（Host 侧）校验，而非逐键校验。

### C. 系统托管默认值（无用户字段，不渲染）

- 内核/协议常量：帧上限、`CHECKPOINT_CHUNK_BYTES`、进程树终止策略、env 允许列表、scaffold 重置、
  M2 FIFO/串行化规则。
- 安全不变量：凭据永不进入 Python；checkpoint/context 值永不模型可见；无第二 Agent loop；
  depth/取消语义。
- DSH 所有身份：Session id、provider 路由、userId、模型选择。
- 这些由已验收的 M1–M12 契约与测试冻结；作为 UI 字段暴露将违反契约，是明确非目标。

## UI 布局（与 DSH 一致）

卡片镜像 `dsh-agent-swarm` 与自带宿主卡片：

```text
+--------------------------------------------------------------+
| dsh-rlm                                          [Configured] |
|   Persistent Python RLM loop for a DSH Session               |
+--------------------------------------------------------------+
| [Core] [Bounded I/O] [Recovery & Sandbox] [Guard]           |
|                                                              |
| Core                                                        |
|   [x] Enable dsh-rlm            Provider [spawn          v] |
|   Interpreter [python          ]  Depth [8        ]          |
|                                                              |
| Bounded I/O                                                  |
|   Per-cell queries [16]  Stdout bytes [65536]                |
|   Result bytes [65536]  Context bytes [67108864]             |
|   Timeout ms [30000]                                         |
|                                                              |
| Recovery & Sandbox                                          |
|   [ ] Snapshot recovery   Kernel sandbox [auto          v]   |
|   Durable root (absolute path) [____________________]        |
|                                                              |
| Guard                                                       |
|   [ ] Observed-token guard   Max tokens/cell [0      ]       |
|                                                              |
|   [Save plugin settings]                    [Reset defaults] |
+--------------------------------------------------------------+
```

- 卡片外壳：头部（标记 + 标题 + 描述 + Configured 徽标）、可折叠主体、Tab 导航、staged 草稿、
  每字段 override 徽标、reset-to-composition、底部 Save/Saving/Saved/Save-failed 状态。
- 样式使用 DSH 相同的 CSS 自定义属性（`--dsh-color-border`、`--dsh-color-primary`）与相同的 38px
  输入框；无定制主题。
- 每字段显示有效值 = 用户层 > composition 层 > schema 默认值，并标记用户层是否携带
  （等于默认值也算 override），与 dsh-client-ui-settings-plugins 中的 CardForm 完全一致。
- 保存会围栏命名空间 revision，只写 staged 字段；staged 非法值阻止保存并保留草稿。

## i18n

客户端插件内一个字典命名空间（`rlm.settings`），含 `en` 与 `zh`，通过 `ctx.locale.register`
注册并扩充 LocaleNamespaceMap（与 swarm teamSkillSettingsEn/Zh 相同模式）。标签、提示、校验消息、
Tab 名称、保存状态全部本地化。英文为回退；locale 机制由 DSH 拥有。

## 架构

```text
Host (Node)                                     Browser (web)
+----------------------------------+               +----------------------------+
| dsh-rlm Host plugin              |               | dsh-rlm client plugin      |
|  Config schema (schemastery)     |               |  RlmSettingsCard (React)   |
|  settingsNamespace(rlm)   -------+-- settings --->|  settingsScope.bind(rlm)  |
|  reads user layer only           |   namespace   |  staged Draft + validation|
|  + composition layer (patch)     |               |  slots.settings.plugin.item|
|  runtime consumes normalized     |               |  ctx.locale.register(rlm)  |
+----------------------------------+               +----------------------------+
```

- Host：保持 `ConfigSchema` 作为唯一校验权威（已导出）；通过 `@deepseek-ai/dsh-settings` 增加
  settings 命名空间 `rlm`，使用户层合并到 cordis 组合默认值之上；运行时读取
  `{ ...compositionDefaults, ...userSettings }`。
- Client：新增客户端入口（`exports["./client"]` + `dsh.client` manifest，与 swarm 相同），
  在 `settings.plugin.item` 下按命名空间注册卡片；使用 swarm 相同的客户端包（locale、settings、
  slots、ui-settings-plugins）。
- 不修改已验收的内核/协议；运行时表面保持字节级向后兼容（M1–M12）。

## 全局集成视图（dsh-rlm × dsh-agent-swarm）

两个插件作为 `packages/.external` 下的兄弟项目、被组合进同一 DSH Profile，因此共存是一等设计需求。

### 已验证交叉点（源码证据）

| 维度 | dsh-rlm | dsh-agent-swarm | 结论 |
|---|---|---|---|
| 插件形态 | host 函数插件，`inject = [tools, subagents, systemPrompt]` | bundle 插件（`cordis.patch.yml` + `cordis:group`），`inject = [tools, subagents, agents, sessions, systemPrompt, sessionPersistence, storageDomain]` | 共存；DSH 叠加 bundle + 函数插件 |
| 工具名 | `rlm_eval` | `agent_swarm_*`（26 个工具） | 不相交 |
| Subagent provider | 读 `provider`（默认 `spawn`） | 读 `memberProvider`（默认 `spawn`）以及 scheduler/review provider | 同一官方 `ctx.subagents` 注册表；可共享 `spawn` 或使用不同 key |
| systemPrompt 段 | `name = tool:rlm_eval`，order 150 | `name = agent-swarm:usage`，order 118（可配置） | 不相交（name 唯一、按 order 排序） |
| Jobs | `attachController('rlm')`，`startRlmJob` | `jobsBridge` 只读投影（`agent_swarm_list_jobs`，kind `team-task`） | kind 不相交；共享 DSH Jobs 列表同时显示两类（按 kind 过滤） |
| Settings 命名空间 | 计划 `settingsNamespace('rlm')` | `settingsNamespace('agent-swarm')` | 不相交；`settings.plugin.item` 按命名空间 key（官方外部插件扩展点） |
| 存储 | 无（M10 `durableRoot` 是宿主私有文件） | `ctx.storageDomain` Team aggregate | 不相交；rlm durable 引用永不进入 Storage Domain |
| 客户端 | 今天无 | `dsh.client` web 插件（dashboard + settings 卡片） | 不相交；每张卡片 key 自己的命名空间 |

### DSH 机制调和

- `cordis.patch.yml` 分层先叠加 bundle 层、再叠加用户 patch 层；`cordis:include` / `cordis:group`
  是官方 Loader 内建，单个 Profile 可同时承载两个插件与 base/headless bundle。
- `settings.plugin.item` 被官方文档定义为外部插件卡片扩展点，按贡献插件的 settings 命名空间 key
  （`packages/client/ui-settings-plugins/src/client/slot-contract.ts`），因此新的 rlm 卡片与 swarm
  卡片独立分发。
- `ctx.settings` 命名空间、`ctx.systemPrompt.section` 名、`ctx.tools` 名、`ctx.subagents` provider key
  均按名作用域；除非同名注册，否则不可能跨插件覆盖。

### 共存规范

1. 共享 `spawn` subagent provider 合法（DSH 注册表并发安全）；需要资源隔离时使用不同
   `provider` / `memberProvider` key。
2. 深度叠加：执行 `rlm_eval` 的 Captain 成员会增加 subagent 层；在 DSH 绝对上限 8 之内，让
   `maxDepth`（rlm）保持在 `memberMaxDepth`（swarm）剩余预算内。推荐 `memberMaxDepth=1` +
   `maxDepth=1`（最深观测分支 = 2）。
3. Jobs 列表合并：`rlm` jobs 与 `team-task` 投影行共享 DSH Jobs 表面；两个 bridge 同时开启时按
   kind 过滤。
4. Prompt 段自包含：rlm（order 150）与 swarm usage（order 118）都出现在同一模型上下文中；
   双方都不得假定对方存在。
5. Sandbox：rlm 内核使用 `ctx.sandbox`（Session 策略）；swarm 执行根是同一 DSH sandbox 策略下的
   git-worktrees——当 `kernelSandbox` 为 `require` 时，把 `executionRootsBase` 放在允许的工作区根内。
6. 设置保存语义：两个插件都注册 restart 生效命名空间（`applies: restart`）；rlm 卡片必须显示与
   swarm 卡片相同的 “restart DSH to apply” 提示。

## 多智能体执行计划

由本仓库协调者指挥，使用 `dsh-agent-swarm`（已作为兄弟 `packages/.external` 项目），每个 lane 使用
一个干净的 dsh-rlm worktree：

1. **架构 lane（agent A）：** 冻结本设计 + Archify 图；对照已安装的 `@deepseek-ai/dsh-settings`
   类型验证 settings 命名空间合并。
2. **Host lane（agent B）：** 增加 `settingsNamespace('rlm')` + 合并读取器 + 聚焦测试
   （schema 不变、向后兼容）。
3. **Client lane（agent C）：** 实现 `RlmSettingsCard` + locales + slot 注册；复用 swarm/自带卡片
   脚手架；浏览器测试。
4. **集成 lane（agent D）：** Profile + Web smoke、i18n 检查、memory 记录。
5. **独立复核（agent E，只读）：** 契约/架构 + UI 复核；阻塞性发现先开后继 RED，再修正生产代码。

Swarm lanes 写不相交的作用域；只有协调者触碰共享 `runtime.ts`。至多两个活动 writer；
调查/复核为只读。

## 验收

1. 可加载的 Profile 中 Settings > Plugins 显示 `dsh-rlm` 卡片；enabled 开关与所有用户可配置字段
   可持久化并在 DSH 重启后保留（restart 提示）。
2. 保存只写由 revision 围栏的 staged 字段；staged 非法值阻止保存并保留草稿；reset 回到
   composition 值。
3. 无论经 UI 还是 cordis patch 配置，运行时行为一致（同一规范化配置），M1–M12 离线与 live smoke
   保持绿。
4. zh/en 标签随 DSH 设置 UI 其余部分渲染（locale 对等）。
5. 范围外常量保持非字段，由已验收测试覆盖。

## 风险与缓解

- swarm/worktree 隔离 bug 可能阻塞 lane → 停止并新开干净的 dsh-rlm 修复 worktree，修复后恢复
  （按 PTC）。收集到的 swarm issue 单独提交。
- settings 命名空间注册对宿主加载顺序敏感 → 在 provider 可用后的 `ctx.effect` 中注册，并在
  provider 换代时重新注册（swarm 先例）。
- UI 卡片没有 live model 目录：provider/路径校验在保存时由 Host 侧执行，而非逐键，避免额外模型调用。