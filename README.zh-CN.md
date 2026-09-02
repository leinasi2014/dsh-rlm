# dsh-rlm

> [English](README.md) | 简体中文

`dsh-rlm` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的最小 Recursive Language Model（RLM）插件。它只向 DSH Agent 提供一个
`rlm_eval` 工具，并为当前 Session 维护一个持久 Python namespace。

Python cell 支持 top-level `await`，并可调用 `await rlm_query(prompt)`。
宿主通过官方 one-shot DSH Subagent 完成查询，把可见文本返回 Python，然后让
当前 cell 继续执行。

> 状态：M1 端到端核心闭环已经实现并通过真实干净 Profile 冒烟；公开审查发现的
> 生命周期和有界协议问题仍在 M2 修复。参见
> [项目状态](docs/project-status.zh-CN.md)和
> [审查结论](docs/review-findings.zh-CN.md)。

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
- 离线测试和设门的真实干净 Profile 冒烟测试。

## 未实现

以下能力在真实需求触发前不属于 V1：

- snapshot/restore 或跨 Host 持久化；
- 递归子 RLM；
- continuable/background spawn；
- batched query；
- 公共 `RlmService` 或 Kernel Provider 框架；
- Storage Domain、Workflow、Jobs、Team 或 UI；
- container 或 remote kernel。

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

测试会把完整 `settings.yaml`，以及存在时的完整 `.credentials.yaml` 复制进临时
DSH home。临时配置和 Session logs 绝不能提交或上传。

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
```

本仓库尚未发布 npm registry 包；这里是真实本地包安装。

## 示例

```python
context = open(path, encoding="utf-8").read()
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
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## License

[MIT](LICENSE)。本插件源自采用 MIT License 的 DeepSeek Harness checkout，
保留上游版权声明；参见 [NOTICE](NOTICE)。
