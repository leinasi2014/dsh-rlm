# M9 沙箱内核架构（复用 DSH 沙箱后端）

> [English (authoritative)](m9-sandboxed-kernel.md) | 简体中文 | [交互图](m9-sandboxed-kernel.html)

## 结果

M9 将 Session Python 内核从宿主裸 spawn 改为在 DSH 进程沙箱下启动：复用官方
`ctx.sandbox` 后端（Linux bwrap / Landlock、macOS Seatbelt、Windows ACL 受限令牌）
以及 `ctx.sandboxPolicy` 的按会话策略。这是"第二内核"条件扩展选定的 **A 路线**修订：
每个 Session 仍只有一个同世界（same-world）进程，但其文件效果与 DSH 其他受限能力一样
遵循 `read-only` / `workspace-write` / `danger-full-access` 阶梯。不引入容器、microVM、
远程执行器或公开 `KernelDriver` 接口。

新增 `kernelSandbox` 插件选项：

- `auto`（默认）：加载的 runtime 提供官方沙箱服务且后端可用时启用约束；否则沿用已
  验收的非约束 argv 并表面化一次 `sandbox: none`。
- `require`：沙箱不可用时在任何 Python 启动前以类型化错误失败；绝不静默非约束执行。
- `off`：完全保留 M1-M8 行为（可信本地执行）。

## 权威与 API

可执行权威是实际加载的 DSH Profile runtime，对照已安装的 `@deepseek-ai/dsh-sandbox*`
类型与最新官方 checkout 校验。上游事实：

- `ctx.sandbox.confine(argv, policy)`（`@deepseek-ai/dsh-sandbox` seam，
  `@deepseek-ai/dsh-sandbox-local` 后端）返回 `ConfinedArgv`：包装后的 argv、
  `enforcement`（`full`/`partial`）、`denialSignatures`、`runnerFailureRules`。
  消费者 spawn 该 argv，其派生的一切进程同样受约束；无后端可用时抛
  `SandboxUnavailableError`——命令绝不非约束运行。
- `ctx.sandboxPolicy.resolve({ session })`（`@deepseek-ai/dsh-sandbox-policy`）返回
  `{ mode, workspaceRoot, sessionId? }`：部署默认（base 默认 `workspace-write`，
  兜底 `read-only`）+ Session 不可变 `cwd` 作为工作区根 + 从 Session 日志折叠的
  `sandbox/mode` 覆盖（重启后回放保持）。
- `danger-full-access` 跳过约束原样返回调用方 argv——即当前验收行为。

插件将 `sandbox` 与 `sandboxPolicy` 声明为可选服务注入，并从持有内核的同一 Session
解析策略；M2 固定环境白名单不变（Windows 已含 `TEMP`/`TMP`，供 ACL runner 为受限
子进程重写）。

## 状态与失败语义

1. Session 首次 `rlm_eval` 解析一次当前策略并调用一次 `confine`，runtime 启动返回的
   argv；超时、取消、协议帧、销毁与进程树清理语义不变（包装后仍是一个子进程）。
2. **出生模式钉定**：沙箱配置在启动时固定（挂载/ACL 令牌）。之后的会话级模式切换
   不会重新约束运行中的内核，只在下一次内核（M6 reset）生效；想让运行中内核变严格是
   明确限制：建议 reset。
3. `require` + 后端不可用：在子代理/子会话准入前失败关闭；`auto` + 不可用：回退旧行为
   并在内核启动时报告 `sandbox: none`，绝不在未强制时声称已约束。
4. `partial`（Windows ACL、旧 Landlock ABI）按内核启动表面化，绝不当作完全隔离。
5. 运行期拒绝表现为普通 Python `OSError`（EROFS / EACCES / EPERM），即类型化 cell 错误；
   `denialSignatures` 仅用于宿主诊断，不改变 cell 语义。
6. M3 上下文加载是只读操作，任何模式都允许；M5 checkpoint 文件与发布停留在宿主侧，
   不进入内核约束；M5 恢复与 M6 reset 都会重新解析并重新约束；M7 批查询、M8 延续子会话均为
   宿主侧，不受影响。

## 限制与非目标

M9 仅同世界约束：共享宿主内核与文件系统，读与网络不约束，Windows 不隐藏宿主进程可见性
（partial）。不引入容器/远程执行器、microVM、Provider 抽象、自定义 runner、对活跃内核的
逐调用升级、资源上限（CPU/内存）、网络出站控制或公开 `KernelDriver` 接口。容器/远程内核
仍为独立条件扩展（B 路线），只能从自己的架构契约与图开始。

## TDD 验收契约

1. **RED：** 已验收 M8 的 runtime 不咨询任何沙箱服务即启动内核 argv（注入的沙箱桩观察到
   零次 `confine` 调用）。
2. **GREEN：** 挂载官方服务后，runtime 为持有内核的 Session 解析策略，每次内核启动恰好调用
   一次 `confine`，并启动返回的 argv；进程事实可证明约束。
3. **GREEN：** `require` + 无后端：spawn 前类型化失败、无内核、无子会话准入；`auto` 回退并
   表面化 `none`；`off` 与旧路径逐字节一致。
4. **行为：** `workspace-write` 下，写 `workspaceRoot` 内成功、写外 `OSError`；`read-only`
   拒绝写；`danger-full-access` 保持不约束。
5. **生命周期：** reset 与恢复重新解析并重新约束；dispose 只杀本属约束树；M2 串行/限额与
   M5/M6/M7/M8 边界保持绿；沙箱元数据非机密且不把策略文本带入 Python。
6. **干净 Profile：** 一次性安装 Profile（base/headless bundle、本机后端）端到端证明受约束内核：
   工作区内写入 OK、`workspace-write` 下工作区外写入被拒、类型化错误、Session 日志有界结果。
   优先 DSV4-FVE；故障期记录 GLM 回退并在恢复后重跑 DSV4-FVE。
