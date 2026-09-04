# M10 跨主机持久会话持久化架构

> [English (authoritative)](m10-cross-host-persistence.md) | 简体中文 | [交互图](m10-cross-host-persistence.html)

## 结果

M10 让 M5 checkpoint 的**有界引用**在插件重启或换机后仍可恢复：runtime 只把宿主私有
checkpoint 字节加版本化清单持久化到宿主指定的根目录，绝不写入 DSH Session 日志、模型可见
工具数据或公开服务。同一官方 Session 的下一次 `rlm_eval` 可找到持久引用并喂给既有 M9
恢复通道；版本不匹配显式失败，绝不静默恢复过期状态。

M10 不创建 Storage、Jobs、Workflow、Provider 框架或任务队列；只是新增一个私有宿主文件边界，
复用既有 `rlm_eval` 路径。

## 权威与 API

- 新配置：`durableRoot?: string`（绝对路径，可选；缺省/空 = 禁用毒持久发布，既有临时
  M5/M9 路径不变）。
- 根目录宿主持有。布局为每官方 Session 一个文件：`<durableRoot>/<sha256(sessionId)>.checkpoint.json`
  和 `<durableRoot>/<sha256(sessionId)>.meta.json`（schemaVersion、publishedAt、字节数、内容
  sha-256）。Session id、checkpoint 路径、值一概模型不可见。
- 发布原子：写临时 + fsync + rename，与 M9 宿主侧 checkpoint 组装相同；残缺/损坏文件
  绝不替换好的。
- 恢复一次性且失败关闭：找到持久引用时校验清单与字节及冻结 schemaVersion；不匹配返回类型化
  `snapshot` 失败，Session 从新开始，绝不猜测状态。

## 状态与失败语义

1. M5/M9 提交宿主私有 checkpoint 后，配置了 `durableRoot` 时 runtime 同时发布持久引用；两种
   写入共享同一上限（每 Session <= 8 MiB，根预留 <= 64 MiB）。
2. 新 runtime 实例（重启、同根另一主机、新 DSH 进程）解析同一 Session key，通过既有 M9
   分块通道一次性恢复；内核永不见持久路径。
3. M6 reset 与 M5 恢复互动：reset 同时删除临时 checkpoint 与其持久引用；恢复从 runtime
   能读到的有效源（先私有、再持久回退）进行，不双重发布。
4. 取消、超时、卸载：卸载保留持久引用；恢复期间的属主取消不发布任何东西。
5. 跨 Session/兄弟隔离：持久 key 按官方 Session；某 Session 的损坏文件绝不能被恢复进另一个。

## 限制与非目标

M10 持久化的是引用而非活内存；不是第二 Session 存储、不是 Storage Domain、不是 Service、
不做静态加密（仅宿主权限模型），也不保证跨 OS 路径一致。刻意不持久化 Python 对象身份、
凭据、DSH 对象、子进程状态或 M8 延续句柄。

## TDD 验收契约

1. **RED：** 已验收 M9 无持久根读写；配置 `durableRoot` 的测试证明零持久文件（或选项被拒）。
2. **GREEN：** 受限 M5 提交成功后配 `durableRoot`，持久清单存在、原子、且不含 Session id/值/上下文文本。
3. **GREEN：** 同根的新 runtime 实例经 M9 通道为同一 Session 恢复相同支持全局；版本不匹配返回类型化
   `snapshot` 失败且下一 cell 全新运行。
4. **边界：** M6 reset 删除持久引用；兄弟 Session 不能互相恢复；无模型可见路径/值过协议。
5. **干净 Profile：** 一次性安装 Profile 证明配置持久根上重启续跑端到端（优先 DSV4-FVE；GLM 回退记录）。
