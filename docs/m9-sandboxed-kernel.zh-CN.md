# M9 沙箱内核架构（后继版）

> [English (authoritative)](m9-sandboxed-kernel.md) | 简体中文 | [交互图](m9-sandboxed-kernel.html)

## 结果

M9（A 路线，经独立审查修订）让 Session Python 内核在 DSH 进程沙箱内启动，而不再是宿主裸
spawn：复用 `ctx.sandbox`（bwrap / Landlock / Seatbelt / Windows ACL 受限令牌）与
`ctx.sandboxPolicy` 的按会话策略。每个 Session 仍只有一个同世界进程，文件效果与 DSH 其他
受限能力一样遵循 `read-only` / `workspace-write` / `danger-full-access` 阶梯。不引入容器、
microVM、远程执行器或公开 `KernelDriver` 接口。

作为 M9 明确意图而冻结的新可观察行为：

- 新增 `kernelSandbox` 选项：`auto`（默认）、`require`、`off`。
- 在 base-backed Profile（总是挂载 sandbox + sandboxPolicy）中，`auto` 默认约束内核；
  这是相对 M1-M8“可信本地执行”的刻意变更，并已记录。
- 受约束内核以会话工作区根目录作为工作目录，Python 相对路径解析落在工作区内。
- 受约束时 M5 checkpoint 保持宿主私有：字节经有界分块协议帧传输，由宿主原子写入自己的
  私有临时文件；内核不再写任何沙箱可见的 checkpoint 文件。
- `read-only` 依然支持 M5，因为 checkpoint 不再需要可写文件路径。

## 权威与 API

可执行权威是实际加载的 DSH Profile runtime。插件用 `ctx.get("sandbox")` 与
`ctx.get("sandboxPolicy")` 惰性获取服务；不加入 `inject`（那是必选服务列表）。
`@deepseek-ai/dsh-sandbox` 与 `@deepseek-ai/dsh-sandbox-policy` 仅是编译期类型权威。

- `ctx.sandbox.confine(argv, policy)` 返回 `ConfinedArgv`
  （`argv`、`enforcement` - `full`/`partial`、`denialSignatures`、`runnerFailureRules`）。
  仅当无可用 runner 链时抛 `SandboxUnavailableError`；win32 唯一候选不探测，不可用会以
  spawn 后 runner 失败形式出现，必须用 `runnerFailureRules` 归类，不得当作拒绝。
- `ctx.sandboxPolicy.resolve({ session })` 返回 `{ mode, workspaceRoot, sessionId? }`：
  显式批准模式 > 折叠的会话 `sandbox/mode` 事件 > 部署默认（base 为 `workspace-write`，
  兜底 `read-only`）。`workspaceRoot` 取自会话不可变 `cwd`。
- `danger-full-access` 原样返回调用方 argv = 旧的非约束路径；M9 将其视为 confined=false。

内核 cwd 契约（不依赖 runner 继承）：宿主以 `cwd: resolved.workspaceRoot` 启动受约束 argv，
并在 init 帧下发同一路径；内核在首个 cell 前自行 `chdir`。因此 bwrap、Seatbelt、Landlock、
Windows ACL runner 下相对写都落在工作区内。

M5 传输契约：协议升至 v4，新增有界分块帧用于 checkpoint 发布与恢复。内核发送每块
<= MAX_FRAME_BYTES 的块（含序号与最终 SHA-256），宿主校验后原子写宿主私有临时文件
（temp + rename）。恢复反向进行：宿主读私有文件并向新内核分块发送。`off` 与
`danger-full-access` 保持旧文件路径机制不变。

## 状态与失败语义

1. 首次 `rlm_eval` 解析一次策略、恰好调用一次 `confine`、启动返回的 argv，内核在 ready 前
   确认 cwd。出生模式钉定：之后的会话级模式切换仅对下一个内核（M6 reset）生效。
2. `require`：链不可用（`SandboxUnavailableError`）或任一帧前的 runner 失败归类成功，都是
   类型化失败；内核不被准入、子工作不被准入、禁止非约束回退。
3. `auto`：runner 失败同样失败关闭（坏沙箱绝不静默绕过）；仅在组合缺少沙箱服务时回退旧路径。
4. `off`：完全旧路径，不解析策略、不调用 `confine`。
5. `partial`（Windows ACL、旧 Landlock ABI）在内核启动时表面化，不当作完全隔离；Windows
   对 Everyone 授权或硬链接别名目标仍可能可写。
6. 运行期拒绝表现为普通 Python `OSError`（EROFS / EACCES / EPERM），即类型化 cell 错误；
   `denialSignatures` 仅用于宿主诊断。
7. M3 上下文读取在所有模式允许；M6 reset 重新解析并重新约束；M7 批次与 M8 延续子会话为宿主侧。
8. 受约束时 POSIX 内核环境把 `TMPDIR` 钉到 `/tmp`（bwrap/Landlock 临时根），保证 `tempfile`
   可写；Windows ACL runner 已重写 `TMP`/`TEMP`。M2 白名单本身不变。
9. 进程清理：宿主看到的 PID 可能是 runner；既有树杀路径必须终止 runner 及其后代
   （bwrap `--die-with-parent`、ACL 子进程终止）——归属仍为一个 Session，并作为验收项。

## 限制与非目标

仅同世界约束：共享宿主内核与文件系统，读与网络不约束，Windows 不隐藏宿主进程可见性
（partial）。无容器/microVM/远程执行器（B 路线仍是独立条件扩展，须有自己契约）、无公开
`KernelDriver`、无 Provider 抽象、无自定义 runner、无对活跃内核的逐调用升级、无 CPU/内存
上限、无网络出站控制。M5 checkpoint 仍有界（<= 8 MiB）、仅进程生命周期内（不承诺宿主重启）。

## TDD 验收契约（后继版）

1. **RED（仅测试）：** 构造带录制 `sandbox` + `sandboxPolicy` 服务的 `ctx` 桩，已验收 M8
   runtime 对其零次咨询；断言每次内核启动恰好一次 `confine` 因“缺失”这一预期原因失败，
   且不编辑生产代码。
2. **GREEN：** runtime 解析一次策略、每次内核启动恰好一次 `confine`、以
   `cwd = workspaceRoot` 启动返回的 argv，内核在首个 cell 前证明 `os.getcwd() == workspaceRoot`。
3. **行为：** `workspace-write` 下工作区内相对写成功、工作区外（Windows 用封闭 ACL 目标）
   写失败为 `OSError`；`read-only` 拒绝写；`danger-full-access` 绕过；`require` 对 runner
   失败类型化失败；`auto` 对 runner 失败关闭、仅在无服务时回退；`off` 与旧路径逐字节一致。
4. **受约束下的 M5：** 分块 checkpoint 发布恢复同样支持状态；宿主文件在宿主私有临时目录；
   值与上下文文本不出现在协议可见或模型可见数据；`read-only` 仍无需内核写文件即可发布。
5. **生命周期：** reset 与恢复重新解析；dispose 杀掉本属树；M2 串行/限额与 M4/M6/M7/M8
   边界保持绿。
6. **协议：** v4 版本协商；不匹配显式失败（M3 门禁）。
7. **干净 Profile：** 一次性安装 Profile 端到端证明受约束内核、工作区 cwd、相对写规则与 M5
   恢复。优先 DSV4-FVE；故障期记录 GLM 回退并在恢复后重跑。
