# dsh-rlm

> [English](README.md) | 简体中文

`dsh-rlm` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的最小 Recursive Language Model（RLM）插件。它只向 DSH Agent 提供一个
`rlm_eval` 工具，并为当前 Session 维护一个持久 Python namespace。

Python cell 支持 top-level `await`，并可调用 `await rlm_query(prompt)`。
宿主通过官方 one-shot DSH Subagent 完成查询，把可见文本返回 Python，然后让
当前 cell 继续执行。

> 状态：M1-M12 均已实现、审查并通过 DSV4-FVE 干净 Profile 验证。
> 参见[项目状态](docs/project-status.zh-CN.md)和
> [里程碑](docs/milestones.zh-CN.md)。

![dsh-rlm 英文架构图](docs/dsh-rlm-architecture.visual-check.1440x900.light.png)

交互式英文架构图位于
[docs/dsh-rlm-architecture.html](docs/dsh-rlm-architecture.html)。

## 目标

V1 刻意保持很小：

```text
DSH Agent
  -> rlm_eval(code)
  -> 当前 Session 的持久 Python kernel
  -> await rlm_query(prompt)
  -> one-shot DSH Subagent（禁用 rlm_eval）
  -> 可见文本返回 Python
  -> cell 继续执行
  -> 后续 rlm_eval 复用相同 globals
```

DSH Agent Loop 和官方 Session log 始终是权威。Python 不会成为第二个 Agent
Loop，也不会接收 DSH Provider 或 Session 对象。

## 已实现

- 一个 Host-only 函数插件和唯一模型工具 `rlm_eval`；
- 每个 DSH Session 一个持久 Python 进程和 globals；
- top-level `await` 与尾表达式结果；
- JSON-lines 宿主/kernel 协议；
- 通过 one-shot DSH Subagent 实现 `await rlm_query(prompt)`；
- 通过 `toolFilter: { deny: ['rlm_eval'] }` 阻止子智能体递归；
- 明确的 syntax、runtime、protocol、timeout、cancel 与 process 错误；
- stdout 和尾表达式结果的字节上限；
- 每 cell query 次数限制；
- timeout/cancel 后驱逐 kernel 并重建干净 namespace；
- 插件 teardown 释放所拥有的 Python kernel；
- M3 托管上下文：可选 `contextPath` 由 kernel 读取为一个有界、严格 UTF-8 的
  常规文件，并原子发布为受保护的 `context`；
- M4 递归子 RLM：官方深度有界子会话，内核隔离；
- M5 快照恢复：属主内核丢失后可选恢复（JSON 安全全局 + 上下文）；
- M6 手动重置：经 `rlm_eval({ reset: true })` 的 Session 本地 FIFO 重置；
- M7 批量查询：有界有序并发 `rlm_query_batched`，失败前先排空已准入项；
- M8 延续派生：官方可延续子会话 + 父收件箱投递；
- M9 沙箱内核：`kernelSandbox: auto|require|off`，经 `ctx.sandbox` +
  `ctx.sandboxPolicy`，协议 v4 宿主私有分块 M5 checkpoint，工作区 cwd；
- M10 跨主机持久化：可选 `durableRoot` 原子引用，新 runtime 恢复，版本不匹配类型化失败；
- M11 令牌护栏：`guardQueryTokens` / `maxQueryTokensPerCell` 读取官方
  `tokenMeter.measure(...).baseline.usage` 观测（不发明令牌）；
- M12 Job 消费者：官方 `ctx.jobs` `rlm` 控制器 + `createRlmJobSpec` / `startRlmJob`
  （无第二 Agent loop；swarm 保持触发式）；
- 离线测试和设门的真实干净 Profile 冒烟测试。

## 下一里程碑与未实现

## 里程碑路线

已在 `main` 上验收：M1-M12（见[里程碑](docs/milestones.zh-CN.md)）。
[未来扩展](docs/future-extensions.zh-CN.md) 中的剩余行均为条件触发：

- 公共 `RlmService` 或 Kernel Provider 框架（仅在出现第二个消费者时）；
- container 或 remote kernel（B 路线——独立契约与触发）；
- 超出 M12 Job 消费者的 Jobs/UI/swarm 编排（需具名消费者 + 端到端场景）。

可靠性缺陷与条件扩展已在[项目状态](docs/project-status.zh-CN.md)中分开记录。
GitHub Issues 是实时工作权威。

## 安全模型

当前 Python kernel 是**受信任的本地执行，不是 sandbox**。`rlm_eval` 可以用
DSH 宿主用户权限读取/修改文件并启动进程。不要为不可信用户、prompt 或
workspace 启用本插件。

Python 子进程只接收固定的安全名白名单，而不是完整宿主环境。Windows 保留
`PATH`、`SystemRoot`、`WINDIR`、`COMSPEC`、`PATHEXT`、`SYSTEMDRIVE`、
`USERPROFILE`、`TEMP`、`TMP`；POSIX 保留 `PATH`、`HOME`、`TMPDIR`、`TEMP`、
`TMP`、`LANG` 和精确的标准 `LC_*` 类目名。两个平台都额外保留公共 Python
启动项 `PYTHONIOENCODING`、`PYTHONUTF8`、`PYTHONUNBUFFERED`、`PYTHONPATH`。
不支持任意环境变量透传；自定义 `python` 命令也使用同一过滤环境。代理变量、
`VIRTUAL_ENV`/`CONDA_*`、`PYTHONHOME`、`LD_LIBRARY_PATH`、`DSH_*` 与凭据类
变量一律不转发。这是凭据卫生，不是 sandbox：受信任的 Python 仍可读取宿主
用户可读文件、访问网络、启动进程，也可能读取磁盘上的凭据文件。参见
[SECURITY.md](SECURITY.md) 与 [Issue #7](https://github.com/leinasi2014/dsh-rlm/issues/7)。

从 M9 起，`kernelSandbox` 可将同一可信执行约束到 DSH Session 沙箱策略：`auto`（默认）在加载的
Profile 挂载时使用 `ctx.sandbox` + `ctx.sandboxPolicy`，`require` 失败关闭，`off` 保留旧的
可信本地派生。约束模式下内核在 Session 工作区根目录启动，文件效果与 DSH bash/fs 工具相同
遵循 read-only / workspace-write / danger-full-access 阶梯；Windows ACL 报告部分强制，
读取与网络仍为同世界不约束。

## 环境要求

- Node.js `^22.19.0` 或 `>=24`；
- pnpm `9.15.9`；
- `PATH` 中可用的 Python 3.11+；
- 一个兼容的 DeepSeek Harness checkout/Profile；
- 已配置的 DSH one-shot Subagent Provider，默认名称为 `spawn`。

## 本地开发

```bash
pnpm install --frozen-lockfile
git config --local core.hooksPath .githooks
pnpm check:memory
pnpm typecheck
pnpm build
pnpm test
```

两个真实 Profile 测试会安装新 Profile 并调用真实模型，因此默认设门。当前测试
要求本仓库位于 DeepSeek Harness checkout 的
`packages/.external/dsh-rlm`：

```bash
RLM_LIVE_SMOKE=1 DSH_HOME=/path/to/configured/dsh-home \
  node --test tests/profile-smoke.test.ts
```

不要把 live smoke 指向未验证或用户自有的目标。它会创建并删除一个隔离的临时
DSH home。完整 `settings.yaml` 以及存在时的完整 `.credentials.yaml` 会从给定
`DSH_HOME` 逐字节复制；**仅在可弃置副本中**，顶层 `agent-default-model` 块会被
确定性改写为 provider `vllm`、model `DeepSeek-V4-Flash-Vision-Exp`，使隔离
运行使用显式 vLLM/PTC 路由而非 ambient 默认模型。必要时可用 `RLM_LIVE_PROVIDER`
和 `RLM_LIVE_MODEL` 覆盖。对外部 worktree，可用 `RLM_DSH_REPO_ROOT` 把测试指向
权威 harness checkout（解析为绝对路径）；未设置时沿用包内三上级默认，若该根缺少
`apps/cli/src/bin.ts`，测试会以有界、非机密的信息快速失败。ambient settings 与
凭据从不被改写，运行后会断言其逐字节未变。临时配置和 Session logs 绝不能提交或上传。

## 安装到 DSH Profile

先构建本 checkout，再从兼容的 DeepSeek Harness 根目录执行：

```bash
pnpm dsh plugin --profile <profile> add -w /absolute/path/to/dsh-rlm
```

然后在 Profile 的 Cordis composition 中启用：

```yaml
- insert:
    - id: rlm
      name: dsh-rlm
      config:
        enabled: true
        provider: spawn
        python: python
        timeout: 30000
        maxStdout: 65536
        maxResult: 65536
        maxQueries: 16
        maxContextBytes: 67108864
```

以上即 schema 默认值；`provider` 默认为 `spawn`。六个运行时设置均为可选，
由唯一 `Config` schema 校验：

| 设置 | 默认 | 合法范围/单位 |
|---|---|---|
| `python` | `python` | 非空解释器命令；经白名单 `PATH` 或绝对路径解析 |
| `timeout` | `30000` | 整数 `1000..3600000` ms（每次 eval） |
| `maxStdout` | `65536` | 整数 `1024..262144` UTF-8 字节（cell stdout） |
| `maxResult` | `65536` | 整数 `1024..262144` UTF-8 字节（cell 结果） |
| `maxQueries` | `16` | 整数 `1..4096`（每 cell 的 `rlm_query` 次数） |
| `maxContextBytes` | `67108864` | 整数 `1048576..1073741824`（一个托管 UTF-8 上下文文件的字节数） |
| `snapshotRecovery` | `false` | 布尔；属主内核丢失后恢复 JSON 安全全局 + 上下文（M5） |
| `kernelSandbox` | `auto` | `auto` / `require` / `off`（M9） |
| `durableRoot` | （未设） | 跨重启 checkpoint 引用的宿主绝对目录（M10） |
| `guardQueryTokens` | `false` | 启用每 cell 已观测令牌护栏（M11） |
| `maxQueryTokensPerCell` | `0` | 正整数上限；`0` 禁用（M11） |

本仓库尚未发布 npm registry 包；这里是真实本地包安装。

## M9-M12 操作指南

以下配置在一个 Profile 中启用所有里程碑；所有键均为可选，未注明时即 schema 默认值。

```yaml
- insert:
    - id: rlm
      name: dsh-rlm
      config:
        enabled: true
        provider: spawn
        kernelSandbox: auto        # M9：auto | require | off
        snapshotRecovery: true     # M5/M10：属主内核丢失后 checkpoint
        durableRoot: /absolute/host/durable  # M10：仅引用，宿主持有
        guardQueryTokens: true     # M11：每 cell 已观测令牌护栏
        maxQueryTokensPerCell: 1000000   # M11：已观测上限，0 = 关闭
        timeout: 30000
```

### M9：沙箱内核

`kernelSandbox` 决定 Session Python 进程的启动方式：

- `auto`（默认）：加载的 Profile 挂载 `ctx.sandbox` 与 `ctx.sandboxPolicy`
  时按 Session 策略约束内核（base 默认 `workspace-write`）；否则保留旧的可信
  派生。它绝不静默绕过坏掉的沙箱——runner 失败即失败关闭。
- `require`：官方沙箱服务缺失或不可用时，在任何 Python 启动前失败。
- `off`：可信本地派生，与 M1-M8 完全一致。

约束模式下的可观察行为：

- 内核以 `cwd` = Session 工作区根目录启动，Python 相对路径解析落在工作区内。
- 文件效果与 DSH bash/fs 工具同一阶梯：`workspace-write` 下工作区内写成功、
  工作区外写被拒（Windows 请用封闭 ACL 目标验证）、`read-only` 拒绝写、
  `danger-full-access` 绕过约束。
- M5 checkpoint 以有界分块协议帧（协议 v4）传输并保持宿主私有；内核不写沙箱可见的
  checkpoint。
- Windows 使用 ACL 受限令牌 runner，报告 `partial` 强制（Everyone/硬链接边界仍存在）；
  读取与网络保持同世界不约束。

在 cell 中验证：

```python
import os
open('inside_ws.txt', 'w').write('ok')   # workspace-write 下成功
os.getcwd()                              # == Session 工作区根目录
```

### M10：跨主机持久化

配置 `snapshotRecovery: true` 与绝对 `durableRoot` 后，每次提交 checkpoint 时宿主原子发布引用对：

```
<durableRoot>/<sha256(sessionId)>.checkpoint.json
<durableRoot>/<sha256(sessionId)>.meta.json
```

- 引用有界（每 Session <= 8 MiB，根 <= 64 MiB），不含 Session id、值或上下文文本。
- 新 runtime 实例（插件重启、同根另一主机）可通过既有 M9 传输恢复同一 Session。
- `rlm_eval({ reset: true })` 只删除该 Session 引用；插件卸载保留引用。
- 版本或内容哈希不匹配时以类型化 `snapshot` 错误失败关闭，Session 从新开始——绝不猜测状态。
- 把 `durableRoot` 视为宿主私有：不提交、不镜像、不指向模型可见路径。

### M11：每 cell 令牌护栏

启用 `guardQueryTokens: true` 与正整数 `maxQueryTokensPerCell` 后，每次
`rlm_query` / `rlm_spawn` 准入前先读取官方 `ctx.tokenMeter.measure(parent.session)` 观测：

- 仅 `TokenMeasurement.baseline.usage` 计入（当 `baseline.kind === "usage"`）；
  `estimated` / `none` 基线视为未观测，不阻塞。
- 绝不发明、估算或外推令牌；Python 永不见令牌数字；护栏不写 Session 日志。
- 超预算在子代理派发前以类型化 `query` 错误（phase `query`）拒绝。
  `maxQueryTokensPerCell: 0`（默认）关闭护栏。
- 注意：`measure(session)` 是会话级压力，因此该上限实际是会话级上限，而非严格 per-cell。

### M12：RLM 作为 DSH job 消费者

当加载的 Profile 挂载 `ctx.jobs`（DSH `jobs-local` + `tool-jobs`）时，插件惰性挂载官方
`rlm` job 控制器；没有它的 Profile 正常加载，只是没有 job 表面。

宿主消费者希望把 RLM cell 作为 DSH 拥有的后台 job 运行：

```ts
import { createRlmRuntime, startRlmJob } from 'dsh-rlm'
const runtime = createRlmRuntime(ctx, { enabled: true })
const jobId = startRlmJob(ctx, parent, 'value = 41', runtime)
// 通过官方 DSH job 工具观察/读取：jobs -> job_read -> job_kill。
```

- `createRlmJobSpec` 返回惰性 spec；只有官方 registry 调用 `run()`
  （`ctx.jobs.start`）时才启动 cell。从未 start 的 job 不泄漏内核/工作。
- `cancel` 映射到按 Session 内核 dispose；job 以 `killed` 结算；`readOutput`
  返回有界 stdout/result。
- 无第二 Agent loop、调度器、队列、Workflow 引擎、Storage 或 UI 标记；swarm 保持
  具名消费者 + 端到端场景条件。

### 实时验证前的边界检查

- Profile 冒烟前必须先 `pnpm build`：`package.json` 的 `main` 加载
  `lib/index.mjs` 而非 `src`。
- Cordis 对直接读取的服务要求 `inject`；插件通过非严格 `ctx.get` 读取
  `jobs` / `sandbox` / `sandboxPolicy` / `tokenMeter`，因此缺少任一服务的
  Profile 仍可加载。
- 各里程碑实时验收：

```bash
RLM_LIVE_SMOKE=1 DSH_HOME=/path/to/configured/dsh-home \
  RLM_LIVE_PROVIDER=dsv4f-local RLM_LIVE_MODEL=DeepSeek-V4-Flash-Vision-Exp \
  node --test --test-name-pattern "M9 Issue#42|M10 Issue#44|M11 Issue#46|M12 Issue#48" \
  tests/profile-smoke.test.ts
```

## 示例

调用 Agent 可以带一个绝对 `contextPath`，并运行如下 cell：

```python
draft = await rlm_query("Summarize the key evidence in this context:\n" + context)
draft
```

同一 Session 的后续 cell 可以复用变量：

```python
revision = await rlm_query("Critique and improve this draft:\n" + draft)
revision
```

## 中文文档

- [核心架构](docs/architecture.zh-CN.md)
- [项目状态](docs/project-status.zh-CN.md)
- [审查结论](docs/review-findings.zh-CN.md)
- [GitHub Issue 修复规范](docs/issue-repair-playbook.zh-CN.md)
- [开发记忆总档案](docs/development-memory/README.zh-CN.md)
- [里程碑](docs/milestones.zh-CN.md)
- [目录与语言边界](docs/directory-structure.zh-CN.md)
- [参考项目取舍](docs/reference-analysis.zh-CN.md)
- [后续扩展](docs/future-extensions.zh-CN.md)
- [M3 托管上下文](docs/m3-managed-context.zh-CN.md)
- [M4 递归子 RLM](docs/m4-recursive-child-rlm.zh-CN.md)
- [M3/M4 开发契约](docs/m3-m4-development-contract.zh-CN.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 参考来源

仓库记录的是固定来源身份，而不是上游源码副本：

- `PrimeIntellect-ai/prime-agent@6179a608f394d0858d463e40d648df0def6dbb7a`；
- `alexzhang13/rlm@854e688fbba9d8f8989e3da9989812e4b6dfe270`。

参见 [ref/README.md](ref/README.md)。被忽略的 `ref/*/source/` checkout 是本地、
只读审查证据，不随仓库发布。

## License

[MIT](LICENSE)。本插件源自采用 MIT License 的 DeepSeek Harness checkout，
保留上游版权声明；参见 [NOTICE](NOTICE)。
