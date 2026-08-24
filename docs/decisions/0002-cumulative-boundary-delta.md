# ADR-0002：用累计快照边界差分做任务归因

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Rollout 中的 `token_count.info.total_token_usage` 是线程累计值，而 `last_token_usage` 可能在重复事件中出现或重置。官方 [`TokenUsageInfo`](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2078-L2138) 定义了字段和累计语义；[`task_started/task_complete` 与 turn ID](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2008-L2049) 提供任务边界。

同一子智能体可连续执行多个任务，分页子智能体历史还可能复制父线程事件。直接累加事件会重复计数。

## Decision

- 任务主键为 `thread_id + turn_id`。
- 开始边界取任务开始前最近累计快照；结束边界取完成、终止或活跃任务的最新累计快照。
- 六个字段逐项计算 `end - baseline`，相同累计快照去重。
- 永远不累加 `last_token_usage`。
- 存在 `subagent_history_start_ordinal` 时，忽略它之前的继承历史。
- 累计倒退返回 `discontinuity` 且不构造 delta；边界/字段缺失使用 `partial/unknown`；活跃任务使用 `provisional`；total-only 增长使用 `estimated`。
- `complete` 只表示客户端可见边界完整且单调，不表示账单级精确。

## Alternatives considered

- **累加每个 `last_token_usage`：** 拒绝，因为可能重复或重置。
- **用相邻任意 `token_count` 做增量并求和：** 拒绝，因为重复、分页复制和 compaction 会污染归因。
- **只显示线程累计值：** 拒绝，因为无法满足同一智能体多任务明细。
- **边界累计快照差分：** 采用，因为可审计、可回放并能与任务事件对应。

## Consequences

- 只要 baseline/end 可见且单调，任务结果可确定性重算。
- 缺历史时可能无法给出精确任务 delta；页面必须显示质量状态。
- parser 需要保留 ordinal、边界位置、累计快照和不连续性证据。
- 五任务开发机样本成为附加回归基准，但不能代替脱敏 fixture。
