# Canonical Request Ownership / Request-Day Projection 设计

**状态：** Accepted for Phase 18 implementation

## 1. 问题

新版 Codex `history_mode=legacy` 的子智能体 rollout 可能复制祖先线程历史，并且不再稳定提供 `subagent_history_start_ordinal` / record ordinal。复制记录会保留原 Task `started_at`，但 envelope `timestamp` 可能改为 fork 时刻。现 parser 因而把 inherited history 重新归属到 child thread，造成 Task、Request、Token、USD 和日期统计重复。

同时，当前 Timeline 每次请求会把全部 Task / Request Event 拉回 JS 重新定价；selected session 首次点击还承担 restore/tail/parse 工作，导致秒级延迟。

## 2. 核心不变量

1. **Rollout 是证据源；Request Ledger 是唯一计量事实。** Token / Cost 永远属于 canonical Request。
2. **Task / Agent / Session / Day 都是 Request Ledger 的投影。** Task 只负责业务分组，不决定 Request 的日期。
3. **fork history 只能形成 provenance，不能形成新的 canonical Request。**
4. **任何 verified evidence 都不能静默消失。** rebuild 后每条 verified evidence 必须归入 `canonical / inherited_copy / unresolved` 之一。
5. **Time 模式按 Request `observedAt` 本地日过滤，再按 Task 分组。** Project 模式展示完整 Task。
6. **未知 ownership 不猜、不删除、不进入精确主统计。** 在 health/reconciliation 中显式披露。
7. `.codex` 永远只读；所有 canonical/projection 数据均为可重建派生数据。

## 3. Request Identity Resolver

Request identity 必须先于 ownership。优先读取 `token_count` 本身可证明的稳定原生字段：`request_id`、`model_request_id`、`response_id`；`call_id` 仅属于 tool/function call，不得冒充模型 Request identity。原生 identity 缺失时，使用可从 Request Ledger 重建的确定性证据生成 `reqr_*`：`turnId + generation + cumulative verified usage + last verified usage`。`threadId`、source path/key、line number 与 envelope timestamp 都不得进入 identity，因此 fork copy 即使换线程、换文件或改写 timestamp，仍映射到同一 Request。

2026-08-27 对真实污染 session 的 20 个 rollout 调查得到 13,593 条 `token_count`：`request_id/response_id/model_request_id/trace_id/span_id/generation_id` 在计量事件上均不存在，`token_count` 携带 `call_id` / `turn_id` 也均为 0；`call_id` 只出现在 MCP/patch/web-search/function/custom-tool call 链。因此当前 wire format 必须走 deterministic reconstruction，但 resolver 保留 native-first 分支以兼容未来格式。

## 4. Ownership Resolver

### 4.1 Task owner

同一 root session 内 `turnId` 是 Task identity evidence。若同一 `turnId` 出现在多个 lineage thread：

- 优先选择这些 thread 中的最浅 ancestor；
- 若候选不构成 ancestor 链，则选择最早已证明的 Task source，并把冲突标记 `unresolved`；
- descendant 中同 turn 的 Task 视为 inherited copy，不形成第二个业务 Task。

这个规则支持 Root → Agent A → Agent B：A 的真实 turn 被 B legacy history 复制时，owner 仍为 A。

### 4.2 Request owner

Request Event 先解析 request identity，再按 `(rootSessionId, turnId)` 找 canonical Task owner。同一 request identity 只允许一条 owner-thread verified evidence 成为 canonical Request；同 identity 的重复广播与 descendant copied event 都标记 `inherited_copy`，并通过 `canonicalRequestId` 指向该 canonical Request。

没有 `turnId`、owner 冲突或无法证明 lineage 的 verified event 标记 unresolved，禁止静默吸收到某个 Task。

### 4.3 安全对账

每次 shadow rebuild 必须满足：

```text
raw verified evidence
= canonical verified evidence
+ inherited-copy verified evidence
+ unresolved verified evidence
```

并记录 token 数量级的 reconciliation。只有该恒等式成立才允许切换 projection。

## 5. Request-Day Projection

Time 模式：

```text
canonical Request
  → localDate(observedAt)
  → group by Task owner
  → group by Agent / Session / Day
```

一个跨午夜 Task 可以同时出现在多个日期，但每个日期只显示该日发生的 Request / Token / Cost；完整 Task 仍只在 Project 模式汇总。

没有 Request 的 Task 不进入 Time ledger；Project 模式仍可展示。若前后累计快照严格相等，可将该 Task 标记 `verified_zero`，显示 `0 token / $0.00`。

## 6. Zero-usage proof

Task 内无 verified Request 时，仅在以下条件同时成立才标记 `verified_zero`：

- Task 开始前存在可信 cumulative usage baseline；
- Task 完成后的第一条 cumulative snapshot 与 baseline 六字段完全相等；
- 中间无 generation reset / anomaly / discontinuity。

`verified_zero` 只证明“没有新增量”，不会恢复已退役的 Boundary Ledger，也不会用边界差分生成正 Token。

## 7. Projection / SQL

Phase 18 将运行时查询从“全历史 JS 重算”改为 versioned projection：

- raw evidence：`model_usage_events` 保留所有观测证据；
- canonical request：`canonical_requests` 只保存唯一业务 Request，并保留 origin evidence locator；
- canonical ownership：`task_ownership` / `event_ownership` 持久化 owner、status 与 `canonical_request_id` provenance；
- Task projection：canonical Request 聚合后的 usage/request count/quality/cost；
- session-day projection：按 canonical Request observed day 聚合 Token、Request、Task、Cost、coverage；
- projection 带 `projection_version` / `pricing_policy_version`，版本变化时后台重建。

`/api/timeline` 只读取 `session_day_usage` projection，不再读取全部 Task/Event 现场定价。

投影在同一 SQLite transaction 内完成 ownership → canonical request → day/cost → `projection_generation` 更新；读请求只能观察事务前或事务后的完整 generation。

## 8. 后台 Indexer

启动后先返回 SQLite 已有 projection，同时将 stale/dirty session 放入低并发后台队列。文件 watcher 只标记 dirty；Indexer 完成：

```text
tail/parse → ownership resolve → canonical projection → day/cost projection → SSE
```

点击 session 不再是索引触发器。若 projection 正在更新，页面先显示现有快照并通过 SSE 接收新版本。

`monitor.close()` 必须先停止接收新 job、取消 queued dirty session，再等待 active parse/write 后关闭 watcher；HTTP server 只有在 `await monitor.close()` 完成后才能关闭 SQLite。

## 9. Migration / Cutover

不对污染数据做不可审计的原地删除。schema migration 建立新的 ownership/projection 语义，并对已有 session 执行 shadow rebuild。已有 raw Task/Event 证据可保留用于 reconciliation；运行时只消费 canonical projection。

源 rollout 缺失时不得凭旧 Task 猜 ownership；保留已有可验证历史并标记 source missing/unresolved。

source present 时当前 rollout 是 authoritative source，可替换该 source/session 的派生投影；source missing 时不得删除已有 verified historical canonical evidence。后台 parser restore 必须读取 raw session，而不是只读取 canonical UI projection，否则 incremental tail 会丢失 inherited provenance。

authoritative replace 的粒度固定为 **present source**，不是整个 root session：当前仍存在 source 的旧 Task/Event 先删除再由新 parse 结果重建；当前缺失 source 的 historical raw/canonical evidence 保留。这样同时避免“source 收缩留下 stale Task”和“source missing 被误当删除”两类相反错误。persisted Agent aggregate 与 Timeline unattributed fallback 也必须从 canonical ownership 计算，raw fork evidence 只能进入审计/重建 seam。

parser semantics version 与 SQLite schema version 独立演进。仅事件分类/allowlist 语义变化时不得伪装成 SQL schema migration；旧 session 通过 parser-version stale gate 进入 background reindex，由真实 rollout 重新生成 cursor diagnostics。Phase 18 已审计 `patch_apply_end/user_message/thread_rolled_back/web_search_end` 为 non-accounting record；它们不构造 model Request，也不直接增加 Task usage。

## 10. 性能目标

- Warm `/api/timeline`：不扫描 `model_usage_events`，目标 < 200 ms（真实开发机）。
- Warm day/session detail：只查询该 session/day 所需 canonical rows，目标 < 300 ms。
- 点击 session 不触发全量 rollout replay；dirty parse 由后台 Indexer 承担。

