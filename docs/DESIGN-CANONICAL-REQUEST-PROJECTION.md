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

## 3. Ownership Resolver

### 3.1 Task owner

同一 root session 内 `turnId` 是 Task identity evidence。若同一 `turnId` 出现在多个 lineage thread：

- 优先选择这些 thread 中的最浅 ancestor；
- 若候选不构成 ancestor 链，则选择最早已证明的 Task source，并把冲突标记 `unresolved`；
- descendant 中同 turn 的 Task 视为 inherited copy，不形成第二个业务 Task。

这个规则支持 Root → Agent A → Agent B：A 的真实 turn 被 B legacy history 复制时，owner 仍为 A。

### 3.2 Request owner

Request Event 先按 `(rootSessionId, turnId)` 找 canonical Task owner。只有 `event.threadId == ownerThreadId` 的 verified event 进入 canonical Request Ledger；descendant copied event 保留为 provenance，不进入统计。

没有 `turnId`、owner 冲突或无法证明 lineage 的 verified event 标记 unresolved，禁止静默吸收到某个 Task。

### 3.3 安全对账

每次 shadow rebuild 必须满足：

```text
raw verified evidence
= canonical verified evidence
+ inherited-copy verified evidence
+ unresolved verified evidence
```

并记录 token 数量级的 reconciliation。只有该恒等式成立才允许切换 projection。

## 4. Request-Day Projection

Time 模式：

```text
canonical Request
  → localDate(observedAt)
  → group by Task owner
  → group by Agent / Session / Day
```

一个跨午夜 Task 可以同时出现在多个日期，但每个日期只显示该日发生的 Request / Token / Cost；完整 Task 仍只在 Project 模式汇总。

没有 Request 的 Task 不进入 Time ledger；Project 模式仍可展示。若前后累计快照严格相等，可将该 Task 标记 `verified_zero`，显示 `0 token / $0.00`。

## 5. Zero-usage proof

Task 内无 verified Request 时，仅在以下条件同时成立才标记 `verified_zero`：

- Task 开始前存在可信 cumulative usage baseline；
- Task 完成后的第一条 cumulative snapshot 与 baseline 六字段完全相等；
- 中间无 generation reset / anomaly / discontinuity。

`verified_zero` 只证明“没有新增量”，不会恢复已退役的 Boundary Ledger，也不会用边界差分生成正 Token。

## 6. Projection / SQL

Phase 18 将运行时查询从“全历史 JS 重算”改为 versioned projection：

- canonical ownership：持久化 Task owner / ownership status；
- Task projection：canonical Request 聚合后的 usage/request count/quality/cost；
- session-day projection：按 canonical Request observed day 聚合 Token、Request、Task、Cost、coverage；
- projection 带 `projection_version` / `pricing_policy_version`，版本变化时后台重建。

`/api/timeline` 只读取 `session_day_usage` projection，不再读取全部 Task/Event 现场定价。

## 7. 后台 Indexer

启动后先返回 SQLite 已有 projection，同时将 stale/dirty session 放入低并发后台队列。文件 watcher 只标记 dirty；Indexer 完成：

```text
tail/parse → ownership resolve → canonical projection → day/cost projection → SSE
```

点击 session 不再是索引触发器。若 projection 正在更新，页面先显示现有快照并通过 SSE 接收新版本。

## 8. Migration / Cutover

不对污染数据做不可审计的原地删除。schema migration 建立新的 ownership/projection 语义，并对已有 session 执行 shadow rebuild。已有 raw Task/Event 证据可保留用于 reconciliation；运行时只消费 canonical projection。

源 rollout 缺失时不得凭旧 Task 猜 ownership；保留已有可验证历史并标记 source missing/unresolved。

## 9. 性能目标

- Warm `/api/timeline`：不扫描 `model_usage_events`，目标 < 200 ms（真实开发机）。
- Warm day/session detail：只查询该 session/day 所需 canonical rows，目标 < 300 ms。
- 点击 session 不触发全量 rollout replay；dirty parse 由后台 Indexer 承担。

