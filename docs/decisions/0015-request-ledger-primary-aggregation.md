# ADR-0015：以验证后的 Request Ledger 作为主聚合事实源

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** ADR-0002 中“任务边界差分作为正式聚合来源”的部分。
- **Updated by:** [ADR-0016](0016-retire-boundary-ledger.md) 已在 schema v11 结束迁移期并删除 Boundary Ledger 运行时/存储/API；本 ADR 的 Request Ledger 主事实源、验证规则、日期和 request-unit 语义继续有效。
- **Date semantics updated by:** [ADR-0018](0018-day-scoped-request-ledger-snapshot.md) 将时间视图从 task `startedAt` 日归属更新为 verified Request Ledger event `observedAt` 的本地自然日切片；Request Ledger 主事实源和 request-unit 语义不变。

## Context

ADR-0002 使用 `task_started/task_complete` 两侧的累计 `total_token_usage` 做任务差分，能避免重复广播与分页复制，但它隐含了“一个任务内累计计数不会跨 generation 重置”的条件。真实历史审计证明该条件并不总成立：已验证的累计 generation reset 会让 Boundary Ledger 正确拒绝伪精确 delta，却也因此遗漏可由相邻累计快照独立证明的模型用量。

Phase 13 建立了逐 `token_count` 的 Request Ledger：`last_token_usage` 只作为候选新增量，必须由前后 `total_token_usage` 逐字段验证后，才能成为 `verified_increment` 或 `generation_start`。完整历史双账本回放中，1,335 个 Boundary `complete` task 全部逐字段一致，0 mismatch；另有 4 个 Boundary `discontinuity` task 可由 Request Ledger 恢复。duplicate、unverified 和 unattributed event 都能独立计数而不混入精确 task totals。

## Decision

- schema v10 起，Task / Agent / Session / Timeline 的展示与费用、缓存命中率计算以 **verified Request Ledger** 派生 usage 为主事实源。
- schema v10 的迁移版本曾原样保留 `tasks.delta_usage`、`tasks.quality`、baseline/end 与 API boundary 字段；该迁移期保留决定已由 ADR-0016 在 schema v11 结束。
- 只有 `verified_increment` 与 `generation_start` 进入主 usage。`duplicate` 增量恒为 0；task 内若仍有 `unverified` 或 `anomaly`，不得退回 Boundary delta 冒充主事实源，`deltaUsage` 只保留已验证部分并将质量降为 `partial`，明确表示这是可审计下限而非完整 task total。
- `last_token_usage` 永远不独立累加；它必须由累计快照验证。无法证明的 generation 起点继续保留为 unverified。
- Timeline 仍按 task `startedAt` 的监控器本地日期归属，以保持既有日期 API 语义；Request Ledger event 的 `observedAt` 只用于审计，不把 Timeline 改成事件日口径。
- `modelRequestCount` / `tokensPerModelRequest` 只统计已验证且归属 task 的模型 usage units。这里的“model request”是 rollout 中可验证的模型用量单元，**不保证与 HTTP 请求、Codex 服务端计费请求一一对应**。
- Profile / 订阅额度继续与本地 ledger 分离。不得用 Profile 数字校准、补偿或反推本地 token。

## Alternatives considered

- **继续以 Boundary Ledger 为主、Request Ledger 只做诊断：** 拒绝。已验证 generation reset 会永久留下可恢复的精确用量缺口。
- **直接累加所有 `last_token_usage`：** 拒绝。重复广播、缺 baseline 和 generation 重置都会产生双计或错误计量。
- **在 schema v10 迁移期直接用 Request Ledger 覆盖 `tasks.delta_usage`：** 当时拒绝，因为会销毁双账本迁移证据；schema v11 在证据完成后选择彻底删除旧字段而不是覆盖它们。
- **Timeline 改按 token event 日期：** 拒绝。会改变现有“任务开始日”契约，并造成跨午夜任务的历史日期漂移。
- **遇到 Request Ledger 缺口时 fallback Boundary Ledger：** 拒绝。会让同一个 `deltaUsage` 字段混合两个事实源，隐藏 coverage 缺口。

## Consequences

- 已验证 reset / missing-boundary 场景可以恢复为精确 request-derived task usage；schema v10 迁移期曾支持进程内双账本复核，schema v11 起历史复核改由 Git tag `usage-boundary-ledger-v1` 提供。
- schema v10 的 `session_day_usage` 增加 verified model request count；旧 v9 数据库升级时重建日物化索引与 Agent aggregate，但无需仅因聚合语义变化重读 `.codex`。
- API 在 schema v10 新增 `usageSource`、`requestCount`、`requestLedgerCoverage` 和 Session/Timeline 的 `modelRequestCount` / `tokensPerModelRequest`；迁移期 `boundaryDeltaUsage` / `boundaryQuality` 已由 ADR-0016 删除。`deltaUsage`/aggregate 的事实源保持 Request Ledger。
- 费用估算和缓存命中率继续消费同一套六字段 normalized usage，因此 cached input、reasoning output 不会被额外叠加到 total。
- Boundary Ledger 的迁移保留期已经完成；ADR-0016 根据历史 reconciliation 证据决定在 schema v11 退役它。
