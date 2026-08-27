# ADR-0020：Canonical Request Ownership 与 Request-Day Projection

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Codex `history_mode=legacy` 子智能体 rollout 可复制祖先历史；新版文件可能缺少 `subagent_history_start_ordinal` 和 ordinal，并重写复制记录 envelope timestamp。现 parser 因此把 inherited history 当 child-local Task/Request，造成 Token/Cost/date 重复。与此同时，Timeline 和 selected-session 查询仍承担全历史 JS 定价/同步成本。

## Decision

- Request Ledger 继续是唯一计量事实，但在其运行时投影前增加 canonical ownership resolution。
- 同一 root session 的 Task 以 `turnId` 为 identity evidence，通过 agent lineage 选 canonical owner；descendant copy 只保留 provenance。
- verified Request 只有在 event thread 与 canonical Task owner 一致时进入正式聚合；冲突/无 owner 进入 unresolved。
- Time 模式按 canonical Request `observedAt` 本地日切片，再按 Task/Agent/Session 分组；Task lifecycle 不再决定日期用量。
- 建立 versioned SQL projection，Timeline/日视图不再每次扫描全历史 Request Event 重新定价。
- session 同步改为 background indexer；点击只消费已有 projection。
- migration/cutover 必须做 evidence reconciliation，禁止无法解释的 verified Token 丢失。
- 无 Request Task 只有在 cumulative 前后严格相等且无异常时才可 `verified_zero`。

## Alternatives considered

- **按 Task 开始日归属全部 Token/Cost：** 拒绝；一个 Task 可跨日产生多个 Request，会扭曲真实发生时间。
- **继续依赖 `subagent_history_start_ordinal`：** 拒绝；真实新版 rollout 已证明该字段可缺失。
- **按 `(turnId)` 简单 DISTINCT 删除：** 拒绝；需要保留 lineage/provenance、处理 nested ancestor 与 unresolved，且 Request ownership 不能由 SQL DISTINCT 猜测。
- **直接清空污染 Task：** 拒绝；无法证明真实 verified evidence 没有被一起删除。

## Consequences

- ADR-0018 的“Request observed-day”方向保留，但 lifecycle-only day slice 被本 ADR 收紧：Time ledger 由 canonical Request 决定，Task 只是分组。
- schema/projection 需要版本升级与历史重建；旧 raw rows 可作为审计证据保留，但不再直接作为 runtime aggregate。
- 页面首次点击不应承担 parser/repricing；后台同步完成后通过 SSE 更新。

