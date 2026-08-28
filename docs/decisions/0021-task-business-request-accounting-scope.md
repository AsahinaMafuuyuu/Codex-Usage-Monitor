# ADR-0021：Task 作为业务分组，Request 作为计量与时间原子

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

Request Ledger 已经成为唯一用量事实源，ADR-0018 也规定 Time 按 Request `observedAt` 切日。但 UI 长期仍以 Task 表格展示，因此容易把“Task 是展示单位”误解成“Task 是日期/Token 计量单位”。Cross-root legacy history 又进一步证明：同一 Request evidence 可以在多个 rollout/session 中出现，不能把 evidence、accounting 和 UI grouping 混为一体。

## Decision

- Request 是 Token、Cost、Request count、日期归属的最小 accounting unit。
- Task 是某个 Agent turn 的业务工作单元；Project / Session 视图以完整 Task 为主要展示单位。
- Time 视图先按 canonical Request `observedAt` 切本地自然日，再按 owner Task 聚合成 Task Day Slice；Task Day Slice 只是 projection，不创建第二个 Task identity。
- 同一 Task 可出现在多个日期，但每个日期只统计该日 Request 子集；完整 Session 仍只保留一个 Task。
- UI 必须区分 Full Task 与 Task Day Slice：Time 使用“活动任务/当日 Request”语义，不把 Task lifecycle 时间冒充为日内计量时间。
- Request 明细采用 Task 展开后的懒加载，不让初始 snapshot 随 Request 数量线性膨胀。
- Cross-root copied evidence 可以保留 provenance，但 global canonical Request 只能 accounting 一次。

## Alternatives considered

- **Time 直接平铺全部 Request：** 计量精确但业务可读性差，用户难以理解当天“做了哪些工作”。
- **Time 仍按完整 Task 统计：** 拒绝；跨午夜 Task 会把其他日期的 Request/Token 带入当前日。
- **按 Task 开始日归属全部 usage：** 拒绝；与 Request Ledger observed-day 事实冲突。
- **把 Task Day Slice 持久化成新 Task：** 拒绝；制造重复 identity，并混淆业务 Task 与查询 projection。
- **初始 snapshot 内嵌所有 Request：** 拒绝；Session 越长 payload 与 DOM 越大，破坏热路径性能。

## Consequences

- Session 回答“做了什么”，Time 回答“什么时候发生了消耗”，两者共享同一 canonical Request 事实源。
- 后端 day scope 需要提供 Request window/count 等 slice metadata；UI Time 表头与 Full Task 表头不再完全相同。
- Request audit detail 需要定向 SQL/API 与索引，但不改变 accounting 事实。
- 业务单元测试应围绕 Scope、Ownership、Conservation，而不是 HTTP/CSS/安全样板。
- 本 ADR细化 ADR-0018/0020，不替代它们；Request-level pricing 继续遵守 ADR-0019。
