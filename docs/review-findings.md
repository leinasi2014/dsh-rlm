# 实现与架构审查结论

## 结论

当前实现与两个固定参考项目的核心方向基本一致：持久 Python namespace、Host
侧模型权威、one-shot 子智能体、按 Session 隔离，并且没有引入第二 Agent Loop。
M1 的代表性真实闭环成立，算法选择总体克制且正确。

它还不能被描述为“完全符合全部退出条件”：system prompt 尚未接入，M2 的
串行化、有界协议、故障终止和子工作生命周期仍有真实缺口。

## 已确认的高优先级问题

1. 非法 JSON、未知帧等协议错误只走 `handleExit()`，没有确保终止进程树；随后
   runtime 已无法通过 Map 找到该进程。
2. 同 Session 并发 eval 被 `busy` 拒绝，而 M2 要求按提交顺序串行化。
3. stderr、无换行 stdout 缓冲、query prompt/result、error detail 和 JSONL 行
   没有覆盖完整的 UTF-8 字节上限。
4. cell timeout、协议故障和插件卸载没有把活跃 one-shot Subagent 完整绑定到
   cell 生命周期；子工作可能继续消耗资源。
5. `Runtime.dispose()` 不是终态，之后仍能创建新 kernel。
6. ready 握手发生在 cell timer 和 abort listener 建立前，静默解释器可无限等待。
7. Python 子进程默认继承 `process.env`，与当前项目的凭据隔离目标不符。

## 已确认的正确性与契约问题

- 最终值的 `repr()` 位于 cell 异常边界之外，异常时会让 kernel fatal，而不是只
  失败当前 cell。
- `rlm_query` 可被用户 cell 持久覆盖或删除；内部结果槽也可能与用户 namespace
  冲突或在失败后残留。
- completed 但没有可见文本的子智能体被接受为空字符串，当前架构要求 typed
  query error。
- 公开配置 schema 没有暴露 runtime 已支持的 Python command、timeout、输出
  上限和 query 上限；简短 RLM system prompt 也未注册。
- `RlmError kind='query'` 在当前桥接路径上不可达，错误 taxonomy 与行为不完全一致。

## 算法质量复核

以下核心算法已经成立：

- reader thread 通过线程安全唤醒与 asyncio future 协作，query 以 ID 关联回复；
- AST 尾表达式变换兼容普通 cell 与 top-level `await`；
- stdout/result 的现有截断按 UTF-8 字节预算执行，不切坏多字节字符；
- result/error/timeout/cancel/dispose 主路径大体遵循单次结算纪律；
- 子智能体通过构造时 deny `rlm_eval`，而不是依赖提示词阻止递归。

但“没有算法性缺陷”的结论过强：异常 `repr()`、协议进程孤儿、残留结果槽和
后台 query 越过 cell 终态，都是可复现的状态机/隔离缺陷。

## 与用户提供审查的一致项

以下判断得到确认：query 结果缺少宿主侧统一字节上限；Python 环境没有清洗；
timeout 没有可靠取消子工作；stderr 无界；scaffold 可被破坏；busy 路径缺少目标
行为；Windows Host 突然崩溃时缺少 kill-on-close 级别兜底。

其中 Windows Job Object 属于 hardening 建议，不是当前架构已经承诺的 M1/M2
退出条件。

## 不适用于当前权威架构的旧判断

以下说法来自旧版或不同设计，不能作为当前缺陷建 Issue：

- V1 应有 6 个工具；当前权威架构明确只有 `rlm_eval`。
- 应建立八操作 `RlmService`；当前 V1 明确不建立公共 Service。
- Storage Domain、run record、checkpoint 是当前必需；它们属于条件扩展。
- 当前应拆为 9 个 TypeScript 文件；目录契约明确保持两个 TS 源文件。
- 协议必须使用 `hello/evaluate/host_reply/done` 等旧帧；当前协议就是
  `ready/eval/query/query_result/result/error`。
- 必须存在 `protocol.ts` / `protocol.py` 镜像或达到约 1,600 行；当前文档没有
  这些要求，代码行数也不是完成标准。

两个 `ref` 是 prior art。应采用其生命周期、资源治理和 namespace 防护经验，
不应复制其 daemon、Storage、协议命名、自动快照或更大的框架边界。

## 修正顺序

1. 先收口进程、deadline、dispose 和 child 生命周期，避免孤儿与迟到副作用。
2. 再完成同 Session 队列和所有协议/诊断通道的字节上限。
3. 修复 Python scaffold、结果格式化和空查询结果的 cell 级隔离。
4. 完成环境变量白名单、公开配置和 system prompt 契约。
5. 所有修正用本地测试验证，最后再次运行隔离的真实 Profile 冒烟。
