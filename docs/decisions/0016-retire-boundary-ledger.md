# ADR-0016：退役 Boundary Ledger，统一为 Request Ledger

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** ADR-0002 的运行时任务边界差分实现，以及 ADR-0015 中“迁移期继续持久化 Boundary Ledger/API 审计字段”的决定。

## Context

Phase 13 先把逐 `token_count` 的 verified Request Ledger 与旧 Task Boundary Ledger 并行运行，再对真实历史做 reconciliation。412 个 rollout / 267 个 session / 2,347 个 task 的迁移证据中，1,335 个旧 Boundary `complete` task 与 Request Ledger 逐字段完全一致，`mismatch=0`；另有 4 个跨 generation reset 的 Boundary `discontinuity` task 可以由 Request Ledger 恢复。Task 5 因而在 schema v10 将 Request Ledger 提升为主聚合事实源，但仍保留旧 parser 差分、`tasks.delta_usage/quality`、baseline/end、API boundary 字段和 reconciliation CLI。

迁移期结束后，继续维护两套实现没有产品收益：页面、费用、缓存命中率、Agent/Session/Timeline 已全部消费 Request Ledger；旧账本只增加 schema、parser 状态、测试和 API 认知负担。与此同时，Git 已经能完整保存旧实现和迁移证据，不需要为了历史复核长期保留一套不参与产品统计的运行时代码。

## Decision

- schema v11 起，verified Request Ledger 是 **唯一运行时 token 事实源**。Task / Agent / Session / Timeline、缓存命中率和 USD 等值估算均只消费它。
- parser 不再计算 task baseline/end/boundary delta，也不再维护 Boundary task quality；它只保留任务定位元数据、Request Ledger event 分类所需的相邻累计状态，以及 anomaly/格式健康诊断。
- SQLite `tasks` 只保存任务身份、状态、时间、模型/effort、portable source key、ordinal/line/byte 定位；删除 `quality`、`baseline_usage`、`end_usage`、`delta_usage` 和所有 `delta_*` token 列。
- `session_day_usage` 只保留 Request Ledger 的 `complete/provisional/partial/unknown` 质量计数，删除旧 Boundary 专属 `estimated_count` / `discontinuity_count`。
- API 删除 `boundaryDeltaUsage` / `boundaryQuality`；任务 `deltaUsage` / `quality` 由 Request Ledger 在运行时物化。
- 删除双账本 reconciliation 运行时代码和 `npm run reconcile:request-ledger`。只读 Request Ledger audit/benchmark 继续保留。
- v10→v11 迁移在监控 SQLite 内重建 task/calendar 表并从既有 `model_usage_events` 重算派生 aggregate；对于已经 `requestLedgerReady` 的 session，不因为退役 Boundary Ledger 重读 `.codex`。
- cursor 的 `last_usage` 继续保留，因为它是跨重启、跨同线程 rollout 验证下一条 Request Ledger event 所需的前序累计快照；这不是 Boundary task baseline。
- 旧 Boundary Ledger 的可执行历史固定为 annotated Git tag `usage-boundary-ledger-v1`，指向 commit `4a38ba6`。ADR-0002、Phase 13 reconciliation 证据和历史提交保留，不改写历史。
- 完成 schema v11 退役、验证并提交后的 Request-only 基线使用 annotated Git tag `usage-request-ledger-v1`，用于和历史 Boundary tag 做版本级比较。
- `last_token_usage` 继续禁止裸累加；只有被相邻 `total_token_usage` 逐字段证明的 `verified_increment` / `generation_start` 才能进入 usage。unverified/anomaly 不从旧算法、Profile 或补偿系数补值。

## Alternatives considered

- **继续永久保留双账本但只展示 Request Ledger：** 拒绝。旧实现已不参与产品决策，却持续扩大 parser、schema、API 和测试面。
- **提供 UI/启动参数在两套算法间切换：** 拒绝。会重新引入两个事实源，并使同一字段的语义取决于运行模式。
- **只隐藏 Boundary API 字段，保留 SQLite/parser 计算：** 拒绝。这只是表面删除，不能降低维护成本，也容易在后续代码中被误当 fallback。
- **删除历史 ADR、reconciliation 记录和旧实现历史：** 拒绝。迁移证据仍有审计价值；Git tag 能以更低运行时成本保存可复现基线。

## Consequences

- 产品与代码只有一个 token 事实源，task quality 也只剩 `complete/provisional/partial/unknown` 四种 Request Ledger 语义。
- v11 task 表更小，旧 Boundary delta 不再占用数据库或 API 带宽；旧数据库第一次打开时会完成一次 schema-only 迁移和派生重建。
- 不再能在当前进程中做实时双账本 reconciliation；如需复核旧算法，应从 `usage-boundary-ledger-v1` 创建独立 worktree，与当前 Request Ledger 版本做离线比较。
- 已验证的历史一致性证据仍保存在 ADR、验证文档和 Git 历史中；退役旧算法不等于删除其决策记录。
- 未来若要重新引入第二套统计源、fallback 或模式开关，必须新建 ADR，并重新证明真实历史、增量 tail、重启与 schema 迁移行为。
