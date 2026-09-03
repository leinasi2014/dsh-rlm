# M3 托管上下文架构

> [English (authoritative)](m3-managed-context.md) | 简体中文

## 结果

M3 允许调用方随 `rlm_eval` 提供一个绝对 UTF-8 文件路径。宿主只把该描述符
传入私有内核协议；内核在 Python cell 启动前打开、校验、解码并将文本原子发布为
该 Session 中受保护的 `context` 全局变量。托管加载路径不会把文件字节复制进
模型可见工具参数、宿主/内核帧或工具结果。

```ts
interface RlmEvalInput {
  code: string
  contextPath?: string
}
```

这只是一个小型托管加载边界，不是 Context Domain、附件框架、分块器、索引或
持久化层。Python 仍是受信任的本地执行；不需要托管加载时仍可直接读文件。

## 契约

- `contextPath` 可省略；省略时完全保持 M1/M2 行为。
- 路径必须为绝对路径，并指向现有普通文件。
- 文件必须是严格 UTF-8，且不超过 `maxContextBytes`。
- 宿主只把路径描述传入私有内核协议；内核负责打开、文件类型/大小校验、严格
  解码和发布，不进行第二次宿主读取或宿主侧内容缓存。
- 托管加载不会把文件字节复制进 `rlm_eval` 工具输入、系统提示、宿主/内核协议帧
  或加载器生成的工具结果。用户 Python 仍可主动 print 或 return `context`；这类
  普通、有界 cell 输出会进入官方 Session 日志，不属于本保密声明。
- 当前 cell 立即看到新 `context`；同一 DSH Session 的后续 cell 可复用；
  不同 Session 始终隔离。
- `context_meta` 是受保护映射，包含 `kind`、规范化 `path` 和 UTF-8
  `bytes`。每个 cell 结束后，内核像恢复 `rlm_query` 一样恢复 `context` 与
  `context_meta`，避免用户代码静默替换后续 cell 的托管来源。
- 加载具有原子性：校验和解码完成前不修改任何受保护全局变量。托管上下文
  错误不会破坏存活内核及其旧上下文。
- 内核会在打开前拒绝非常规文件，并在可用时使用 nonblocking/no-follow 保护；它会
  在读前和读后比较已打开描述符的身份。替换或修改竞态是类型化失败，绝不会部分发布
  或留下陈旧的 metadata 记录。
- 非法路径、目标缺失/不是文件、超限、非法 UTF-8 和读取竞态返回类型化
  `context` 错误。取消、硬超时、协议错误或进程故障沿用现有致命命名空间
  丢失规则。
- 私有协议必须升级为版本 `2`。宿主/内核版本不匹配必须显式失败，旧内核
  不得静默忽略 `contextPath`。

## 配置

`maxContextBytes` 默认 `67_108_864`（64 MiB），整数范围为
`1_048_576..1_073_741_824` 字节。限制在解码前按文件字节计算，独立于
stdout、result、query 和帧限制。

## 所有权与生命周期

DSH Session 继续拥有内核身份；内核在生命周期内拥有加载后的文本和元数据。
不新增重复宿主缓存。内核驱逐、插件卸载或进程崩溃会丢弃托管上下文；M3 不
承诺跨重启恢复。

## 非目标

- 相对路径、glob、目录、URL 或远程来源；
- 自动解析附件（当前官方 DSH 附件 API 面向图像，并非稳定文本来源权威）；
- 分块、摘要、向量、检索、监听重载或 mmap；
- 快照/恢复或跨宿主持久化；
- 新的模型可见工具或公共 Service。

## 验收示例

1. 先 RED 后 GREEN：同一 cell 通过 `contextPath` 获得 `context` 并计算结果，
   工具输入和托管加载协议帧中均不嵌入文件正文。
2. 后续 cell 可复用；另一 Session 不可见。
3. cell 内覆盖 `context` 或 `context_meta` 不影响下一 cell 的受保护值。
4. 缺失、相对、目录、超限和非法 UTF-8 来源返回 `context` 错误，同时旧
   上下文和内核 PID 保持不变。
5. 取消与超时遵守现有致命生命周期契约。
6. 干净 DSH Profile 使用 `DeepSeek-V4-Flash-Vision-Exp` 经
   `contextPath` 加载大型 UTF-8 夹具、完成一次 `rlm_query`，并从官方
   Session 日志证明加载器未把正文复制进模型可见工具参数或工具结果。
