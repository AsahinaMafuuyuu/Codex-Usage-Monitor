# ADR-0001：使用本地只读 rollout observer

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

目标是在不干扰 Codex Desktop/CLI 正在运行的会话、不产生额外配置副作用的前提下，监测既有根会话和子智能体任务。`history.jsonl` 的官方 [`HistoryEntry`](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/message-history/src/lib.rs#L61-L66) 只有 `session_id / ts / text`，无法提供 token。官方 [rollout recorder](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/rollout/src/recorder.rs#L77-L84) 把 rollout JSONL 作为可回放、可检查的 session 记录。

App Server 的通知依赖由同一进程 start/resume 并订阅的线程；强行 resume Desktop 正在工作的线程会扩大监控器职责。Hooks 文档同时明确 transcript 格式可能变化。

## Decision

监控器只读以下本机数据：

- `session_index.jsonl`
- 以 SQLite `query_only` 打开的最新 `state_*.sqlite`
- `sessions/**/rollout-*.jsonl`
- `archived_sessions/**/rollout-*.jsonl`

它不修改 `config.toml`，不启动/resume App Server，不启用 Hooks 或 OpenTelemetry，不调用 Codex 子进程或模型。

## Alternatives considered

- **只解析 `history.jsonl`：** 拒绝，因为没有 token 和任务边界。
- **启动独立 App Server 并 resume 现有线程：** 拒绝，因为无法被动订阅所有 Desktop 线程且可能干扰会话所有权。
- **自动修改配置启用 Hooks/OTel：** 拒绝，因为会产生持久配置副作用，且第一版不需要额外数据管道。
- **读取 rollout：** 采用，因为本机已有任务事件和累计用量证据，可保持旁路只读。

## Consequences

- 可以监测既有和归档历史，不影响 Codex 执行。
- 实时性受文件落盘和本地 watcher 影响，目标而非硬保证为 2 秒内。
- Rollout 不是稳定公共 API；parser 必须按 capability/`cli_version` 适配、忽略未知字段并暴露健康/质量状态。
- 未来只有在监控器自身托管 Codex 会话时，才重新评估 App Server 原生通知适配器。
