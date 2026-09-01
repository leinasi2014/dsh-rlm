# Python runtime boundary

V1 使用一个 Python 3.11+ 脚本，而不是第二套 DSH runtime。

Python 只负责：

- 为一个 DSH Session 保存持久 `globals`；
- 串行执行支持 top-level `await` 的 cell；
- 通过宿主回调暴露 `await rlm_query(prompt)`；
- 缓冲并限制 stdout、stderr 和结果；
- 处理 `ready/eval/query/query_result/result/error` JSON-lines 消息。

模型 Provider、凭据、Subagent 生命周期、Session 日志、取消和进程所有权都在
TypeScript/DSH 宿主。V1 没有 snapshot 或 restore；超时、取消、协议错误或
进程崩溃会终止该 Session 的内核并明确丢失 namespace。
