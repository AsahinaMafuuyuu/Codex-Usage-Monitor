# ADR-0018：时间视图使用 Request Ledger observedAt 构造 Session Day Slice

- **Status:** Accepted
- **Date:** 2026-08-26
- **Updates:** ADR-0012 的 task-startedAt 日归属；ADR-0015 的 Timeline 日期语义

## Context

现有 Timeline 已经按 `month -> day -> session` 展示 `session_day_usage`，但用户点击时间视图中的 session 后，前端仍只携带 `sessionId`，后端返回完整 session snapshot。因此左侧 session 卡片代表某一天，右侧 Task / Agent / Session / Cost 却代表整个 session 生命周期。

此外，ADR-0012/0015 仍规定 Timeline token 按 task `startedAt` 的本地日期归属。一个 23:50 开始、00:20 结束的跨午夜 task，即使 Request Ledger usage 分别发生在午夜两侧，其全部 usage 仍被放入开始日。这与“时间筛选只统计该日记录”的产品语义冲突。

Request Ledger 已持久化每个可验证模型 usage 单元的 `observedAt`，因此本地数据已经具备比 task-start bucket 更精细且可审计的自然日切片能力。

## Decision

- 工程视图继续使用 **Full Session Snapshot**：Task / Agent / Usage / Cost 均覆盖 session 完整生命周期。
- 时间视图使用 **Session Day Snapshot**，selection identity 为 `(sessionId, local day)`，所有详情聚合限定到该 scope。
- token 的日归属改为 Request Ledger event `observedAt` 所在监控器本地自然日；只累计 `verified_increment` / `generation_start` usage。
- Task 在某日与其生命周期相交或该日存在可归属 Request Ledger event 时形成 Task Day Slice。task 身份和原始时间元数据不伪造，usage/request/coverage/quality/cost 按日重算。
- Agent Day Slice 从当天 Task Day Slice 重建 own/subtree usage、model usage unit count 和 cost；只显示当天相关 Agent 和维持 lineage 所需祖先。
- `session_day_usage` 保留 `(day, root_session_id)` 结构，但语义切换为 event-observed day，并在 schema v12 从已持久化 tasks + Request Ledger 重建；Request-ready v11 session 不因迁移重读 rollout。
- 新增适合 day-scope 查询的 `(root_session_id, observed_at, classification)` 索引。
- `GET /api/sessions/:id?day=YYYY-MM-DD` 与对应 `/events?day=...` 返回同一 day scope；无 `day` 时完整 session 契约不变。
- SSE 后续更新必须按 listener scope 重新生成 snapshot，不能把 full-session snapshot 推给 day-scoped listener。
- 日期边界必须用本地日历午夜的半开区间处理，支持 DST，不允许固定加 24 小时。
- Timeline 与右侧 day snapshot 必须复用同一日期/Task Day Slice 语义，防止导航与详情再次漂移。

完整实现契约见 [Day-scoped Snapshot 设计说明](../DESIGN-DAY-SCOPED-SNAPSHOT.md)，验收门槛见 [测试方案](../TEST-DAY-SCOPED-SNAPSHOT.md)。

## Alternatives considered

- **仅在点击后按 `task.startedAt` 过滤 task：** 拒绝。能隐藏其他日 task，但跨午夜 task 的全部 token 仍归开始日，不能满足严格当日统计。
- **保留 Timeline startedAt 语义，只让右侧按 event day：** 拒绝。同一 `session + day` 会出现左侧和右侧数值不一致。
- **把完整 session snapshot 下载到前端再裁剪：** 拒绝。Agent subtree、quality、cost、未验证 coverage 都会在浏览器复制后端领域逻辑，形成第二套事实实现。
- **新增一张 task_day_usage 持久化表：** 暂不采用。现有 tasks + model_usage_events 足以生成 Task Day Slice，`session_day_usage` 已足够承担导航热聚合；额外持久化会增加一致性状态。
- **按 UTC 日期分桶：** 拒绝。页面日期语义是用户本地自然日。

## Consequences

- 同一 session 可以在多个日期中分别打开，时间视图的 token、task、agent 和 cost 与左侧日期严格一致。
- 跨午夜 task 会在多个日期形成 slice；完整 session 仍只保留一个完整 task 身份，不复制持久化 task。
- schema v12 需要一次 SQLite 内部 calendar rebuild 和新索引，但不需要因本决策重放已持久化 Request Ledger 的历史 rollout。
- 前端不能再只用 `selectedId` 表示时间模式选择，必须保存 `selectedDay` 并按二元组判断 active 状态。
- 实时更新需要按订阅 scope 物化 snapshot；实现必须继续遵守 ADR-0017 的稳定 DOM/滚动/展开状态不变量。
- ADR-0012 的 month -> day -> session 信息架构、ADR-0013 的增量 SQLite 索引方向和 ADR-0015/0016 的 Request Ledger 唯一事实源继续有效；仅日期归属和 time-detail scope 被本 ADR 更新。

