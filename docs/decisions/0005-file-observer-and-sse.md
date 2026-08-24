# ADR-0005：使用文件观察、轮询与 SSE 实时更新

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

监控器不控制 Codex 进程，实时数据只能在 rollout 落盘后获得。Windows 文件通知延迟低但可能丢失或合并事件；只做全量轮询会增加 I/O。页面主要需要服务器单向推送，无需双向 WebSocket。

## Decision

- 对 `sessions` 和 `archived_sessions` 使用递归 `fs.watch` 获取快速提示。
- 对当前选择的文件每 1 秒检查 stat，补偿丢失通知；每 10 秒 reconciliation 发现新增、轮转或归档移动。
- 每个文件保存最后完整换行处的字节 offset、行号、大小、mtime、ordinal、坏行数、partial bytes、unknown/skipped/discontinuity 诊断和线程最新累计 usage。
- 重启时从 SQLite 恢复任务/线程状态；只有大小与 mtime 满足 append-only 校验且具备完整行号/累计 usage 状态的文件才从 offset 续读，其余文件按线程安全全量回放。这样任务之间出现的累计快照仍能成为下一任务的正确 baseline。
- 未完成尾行不报坏 JSON，等待下一次追加后继续。
- 只完整 tail 当前选择根会话及其递归子智能体；切换会话时改变监听解析范围。
- 页面使用 SSE：`snapshot`、`quota`、`health`，并每 15 秒发送 heartbeat。
- 新完整记录写入后页面刷新目标为 2 秒内；这是可测性能目标，不是系统级硬实时保证。

## Alternatives considered

- **只用 `fs.watch`：** 拒绝，无法可靠补偿 Windows 丢事件。
- **只轮询所有 rollout：** 拒绝，数据量增长后 I/O 成本不必要。
- **WebSocket：** 拒绝，当前只有服务器单向推送，SSE 更小且浏览器原生支持。
- **文件通知 + 有界轮询 + SSE：** 采用，在简单性、延迟和恢复能力间平衡。

## Consequences

- 相比纯事件驱动会有固定的轻量 stat 开销。
- 进程重启后可通过 SQLite cursor 恢复派生状态；同路径、同或更大尺寸且更新 mtime 的整文件替换无法仅凭当前元数据与正常追加完全区分，因此仍依赖 append-only rollout 假设、reconciliation 和幂等测试。
- 未来更改间隔或推送协议应附带延迟、CPU/I/O 和丢事件证据。
