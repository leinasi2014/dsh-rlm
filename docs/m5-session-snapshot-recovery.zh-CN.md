# M5 会话快照恢复架构

> [English（权威版本）](m5-session-snapshot-recovery.md) | 简体中文

## 目标

M5 为既有 `rlm_eval` 路径提供可选、仅运行期的恢复能力。因硬超时、进程退出或致命协议错误而
丢失受管 Python kernel 后，同一 DSH Session 的下一次 `rlm_eval` 可在执行 cell 前恢复最近一份
有效 checkpoint。

```text
成功 cell -> 私有原子 checkpoint
受控 timeout / crash / protocol-fatal -> 淘汰 kernel
下一次 rlm_eval -> 新 kernel 恢复 checkpoint -> 执行 cell
```

checkpoint 只属于一个已加载插件运行期和一个官方 DSH Session。它不是 Session 持久化：取消、
手动 reset、插件卸载、宿主重启与跨主机使用均不恢复。

验收架构图由[受版本控制的 Archify 图源](m5-session-snapshot-recovery.archify.json)生成。

## 公开表面与配置

M5 只增加一个向后兼容配置：

```ts
snapshotRecovery?: boolean // 默认 false
```

关闭时 M2 的 namespace-loss 行为完全不变。开启时，runtime 为自己的生命周期创建一个私有
临时 checkpoint 根目录，并以不可伪造的 Session-key 到不透明文件名映射进行访问；模型不能看见
checkpoint 路径、载荷或操作。

固定限制不形成新的存储配置表面：单份 checkpoint 最多 `8 MiB` UTF-8 编码；同一私有根目录最多
`64 MiB`；恢复元数据最多公开 64 个跳过名称/原因，绝不公开值、路径、context 文本、凭据、stderr
或原始 checkpoint 字节。根目录无法准入时，当前成功 cell 仍正常返回，旧有效 checkpoint 保留，
且受限恢复元数据会说明新 checkpoint 没有提交。

## checkpoint 内容

Python kernel 负责验证、序列化、恢复和原子发布。带版本的 envelope 只包含：

- 有限 JSON 树形式的用户 globals：`null`、布尔、有限安全范围数字、字符串、list 与 string-key dict；
- 存在 M3 managed context 时，受保护的精确 `context` 文本和已验证 `context_meta`；
- 有界状态元数据（版本、字节数、跳过名称/原因）。

对象 identity/alias 不保证保留。函数、class、module、bytes、handle、task、generator、自定义对象、
循环引用、非有限数字、超出 JavaScript 安全范围整数及内部/保留 globals 都会跳过并记录原因。
`__builtins__`、`asyncio`、`rlm_query`、`context`、`context_meta` 绝不进入用户 globals 段。

M3 context 保存的是已验证文本与元数据，而非仅保存源路径，因此恢复不会静默使用已变更、删除或替换
的源文件。context 文本只留在本地私有 checkpoint 中，不经过模型可见 tool input、tool result、
Session log 或 host/kernel JSON-lines 载荷。

## 原子性、协议与所有权

`RlmRuntimeImpl` 拥有私有根目录、Session 映射、准入和清理。kernel 仅在既有私有 `eval` frame
中收到 `snapshotPath`、恢复开关和 `maxSnapshotBytes`；协议版本由 2 升为 3。快照字节不会经过 frame。

kernel 在发布前会完整验证并在内存编码候选内容，写入私有同级临时文件、flush 和 fsync 后原子替换
旧 checkpoint。验证、尺寸、写入、flush 或替换失败都不会覆盖旧有效 checkpoint。

合格致命故障后，新 kernel 会在可选新 `contextPath` 加载和用户代码前恢复。它先把完整 envelope
验证到新结构、重装 scaffold，随后一次性发布恢复 namespace 和 M3 状态。恢复成功后，提供的新
`contextPath` 仍可通过现有 M3 原子加载器替换恢复的 context。

缺失、损坏或版本不匹配 checkpoint 会以类型化 `snapshot`/`recovery` 错误 fail closed，并被作废，
下一次调用从干净状态开始。符合条件的致命故障保留 checkpoint；取消、手动 reset、runtime dispose/
插件卸载会删除它。宿主重启不会复用 runtime 映射，是明确非目标。

终端 tool result 可以提供有界 `recovery` 元数据（是否恢复、是否提交新 checkpoint、字节数、
跳过名称摘要），不提供任何 checkpoint 值。checkpoint 失败不把已成功执行的 cell 变成 Python
失败，只表示仍以旧有效 checkpoint 作为恢复点。

## 生命周期矩阵

| 事件 | Kernel | Checkpoint | 下一次同 Session eval |
|---|---|---|---|
| 成功 cell | 保持 | 原子替换旧有效 checkpoint | 复用 live namespace |
| Python/query cell 错误 | 保持 | 不替换 | 复用旧 live namespace/checkpoint |
| Timeout、process exit、protocol-fatal | 淘汰 | 保留 | 恢复后再执行 |
| 调用者取消 | 淘汰 | 删除 | 干净 kernel |
| 手动 reset | 淘汰 | 删除 | 干净 kernel |
| 插件卸载/runtime dispose | 停止所有自有 kernel | 删除根目录 | runtime 不存在 |
| 宿主重启 | 旧进程消失 | 不复用映射 | 干净 runtime |

M4 递归 child 因官方 child Session 使用不同 runtime key，按相同规则独立处理；parent、sibling 和
descendant 不能读取或恢复彼此 checkpoint。

## 非目标

- 新的模型可见 restore/reset tool、run ID、公开 service、registry 或第二 Agent loop；
- DSH Storage Domain、Session-record 持久化、宿主重启恢复、复制、跨主机恢复或 checkpoint UI；
- 任意 Python 对象序列化、`pickle`、自定义 serializer hook 或用户控制 checkpoint path；
- 后台 checkpoint、持久 jobs、Provider 改动或递归 scheduler 改动。

## TDD 验收契约

1. RED runtime/kernel 测试在成功 cell 后强制 timeout 或进程退出，证明新的 PID 与 scalar/nested JSON globals 恢复。
2. 不支持值恢复后不存在，只以有界跳过名称/原因元数据报告。
3. M3 context 源被修改或删除后，仍恢复 checkpoint 中的精确文本和元数据，且内容不进入模型可见协议数据。
4. 超大、半写、损坏或版本不匹配候选不能替换旧有效 checkpoint；无效恢复 fail closed 后从干净状态开始。
5. 取消、reset、卸载、sibling 和递归 child Session 都不能恢复其它 Session 的 checkpoint。
6. 使用已安装插件和配置的 `DeepSeek-V4-Flash-Vision-Exp` vLLM/PTC 路由的干净 Profile，通过真实
   DSH tool calls 和有界官方 Session-log 证据证明 timeout/crash 恢复。

