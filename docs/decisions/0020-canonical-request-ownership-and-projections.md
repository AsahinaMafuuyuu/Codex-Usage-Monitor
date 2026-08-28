# ADR-0020：Canonical Request Ownership 与 Request-Day Projection

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Codex `history_mode=legacy` 子智能体 rollout 可复制祖先历史；新版文件可能缺少 `subagent_history_start_ordinal` 和 ordinal，并重写复制记录 envelope timestamp。现 parser 因此把 inherited history 当 child-local Task/Request，造成 Token/Cost/date 重复。与此同时，Timeline 和 selected-session 查询仍承担全历史 JS 定价/同步成本。

## Decision

- Request Ledger 继续是唯一计量事实，但在其运行时投影前增加 canonical ownership resolution。
- Request identity 采用 native-first：仅接受 `token_count` 上可证明的 `request_id/model_request_id/response_id`。当前真实 legacy 样本未提供这些字段，因此 fallback 为 `turnId + generation + cumulative verified usage + last verified usage` 的确定性 reconstruction；thread/source/line/timestamp 不参与 identity，`call_id` 明确排除。
- reconstructed identity 一旦从持久化 Request Ledger 生成并保存，在 restore/rebuild 路径中就是 authoritative derived evidence；schema v13→v14 可以从已有 ledger backfill identity，不能要求重新读取缺失 source 才保持 identity 稳定。
- 同一 root session 的 Task 以 `turnId` 为 identity evidence，通过 agent lineage 选 canonical owner；descendant copy 只保留 provenance。
- verified Request 只有在 event thread 与 canonical Task owner 一致且 request identity 可证明时进入正式聚合；同 identity 的 copied/rebroadcast evidence 标记 `inherited_copy` 并指向 `canonicalRequestId`；冲突/无 owner/identity 不足进入 unresolved。
- Cross-root legacy history 同样不能重新取得 accounting ownership：Task 明确早于 root session 创建时间时只保留 inherited provenance；即使未来 copied Task 时间戳被改写，只要 request identity 已由其他 root 的 `canonical_requests` 占有，当前 verified evidence 仍降级为 `inherited_copy`。全局 `request_id` 唯一约束继续作为重复计量的最后一道防线。
- Time 模式按 canonical Request `observedAt` 本地日切片，再按 Task/Agent/Session 分组；Task lifecycle 不再决定日期用量。
- schema v14 保留 `model_usage_events` raw evidence，同时建立 `canonical_requests`、Task/Event ownership provenance 和 versioned day/cost projection；Timeline/日视图不再每次扫描全历史 Request Event 重新定价。
- session 同步改为 background indexer；点击只消费已有 projection。
- parser semantics version 与 SQLite schema version 分离：仅 record 分类/allowlist 语义变化时，通过 parser-version stale gate 后台 reindex cursor diagnostics，不通过 SQL schema migration 或手工清零 warning 冒充重新验证。
- projection rebuild 在单一 SQLite transaction 内更新并推进 `projection_generation`；graceful shutdown 先取消 queued job，再等待 active parse/write，最后才允许关闭 SQLite。
- projection semantics 也独立版本化：cross-root ownership hardening 提升 projection version，但 SQLite schema 仍保持 v14；发现旧 projection version 时只用已持久化 raw Request evidence 重建，不要求 replay rollout。
- migration/cutover 必须做 evidence reconciliation，禁止无法解释的 verified Token 丢失。
- 无 Request Task 只有在 cumulative 前后严格相等且无异常时才可 `verified_zero`。

## Alternatives considered

- **按 Task 开始日归属全部 Token/Cost：** 拒绝；一个 Task 可跨日产生多个 Request，会扭曲真实发生时间。
- **继续依赖 `subagent_history_start_ordinal`：** 拒绝；真实新版 rollout 已证明该字段可缺失。
- **按 `(turnId)` 简单 DISTINCT 删除：** 拒绝；需要保留 lineage/provenance、处理 nested ancestor 与 unresolved，且 Request ownership 不能由 SQL DISTINCT 猜测。
- **把 `call_id` 当 Request ID：** 拒绝；真实调查中 `call_id` 只属于 MCP/patch/web-search/function/custom-tool call，13,593 条 `token_count` 中没有一条携带 `call_id`。
- **把 envelope timestamp/source locator 纳入 fallback identity：** 拒绝；legacy fork 会重写 timestamp/文件/线程，使用这些字段会把同一 copied Request 重新变成多个业务 Request。
- **直接清空污染 Task：** 拒绝；无法证明真实 verified evidence 没有被一起删除。

## Consequences

- ADR-0018 的“Request observed-day”方向保留，但 lifecycle-only day slice 被本 ADR 收紧：Time ledger 由 canonical Request 决定，Task 只是分组。
- schema/projection 需要版本升级与历史重建；旧 raw rows 可作为审计证据保留，但不再直接作为 runtime aggregate。
- 页面首次点击不应承担 parser/repricing；后台同步完成后通过 SSE 更新。
- source present 时按 present source 做 authoritative replace：只删除并重建该 source 的 stale Task/Event；source missing 时保留上一次已验证 raw/canonical 历史，不因当前文件集合缩小而删除已验证用量。Agent aggregate、Timeline unattributed fallback 与 full/day snapshot 都必须消费 canonical ownership。
- 在当前已验证的 legacy 格式（copied Task 保留原 `startedAt`）下，Cross-root provenance 不依赖索引先后：copy 先索引时可暂时保持 inherited 且无 pointer；原始 canonical Request 后续出现后必须 backfill `canonical_request_id`。全量 projection rebuild 按 session 创建时间稳定排序，减少 first-seen 顺序对 ownership 的影响；若未来格式同时改写 Task 时间且原始 root 尚未建立 canonical identity，则必须继续按 unresolved/新证据规则演进，不能猜 owner。
- `patch_apply_end`、`user_message`、`thread_rolled_back`、`web_search_end` 经真实样本审计后属于 non-accounting record：不生成 model Request，也不直接增加 Task usage；未知的新 record/event 仍继续触发 `unknownRecords` warning。

