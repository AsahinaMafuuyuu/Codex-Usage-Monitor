# Canonical Request Ownership / Projection 测试方案

**状态：** Phase 18 implementation gate

## 测试 seam

1. `token_count → Request Identity`：native identity 优先；缺失时 deterministic reconstruction，不允许 timestamp/source 参与 identity。
2. `Rollout → Canonical Ownership`：legacy fork history 不能产生新 Task/Request。
3. `Canonical Request → Projection`：Project 汇总完整 Task；Time 按 Request observed day 切片并按 Task 分组。
4. `Projection → HTTP/UI`：Timeline/session 查询只读取持久化 projection，点击不承担索引。

## T-ID

- `T-ID-001`：只从 `token_count` 接受 `request_id/model_request_id/response_id`；`call_id` 不能作为模型 Request identity。
- `T-ID-002`：同一 native Request 的重复 broadcast identity 一致。
- `T-ID-003`：fork copy 在 thread/source/timestamp 改变后 reconstructed identity 仍一致。
- `T-ID-004`：缺 native identity 时进入 deterministic reconstruction；不同累计 Request evidence 必须生成不同 identity。
- `T-ID-005`：envelope timestamp、source key/path、line number 不参与 reconstructed identity。
- `T-ID-006`：persisted reconstructed identity 在 restore/attach 时是 authoritative，不因局部 evidence 重算成不同 ID。
- `T-ID-007`：v13→v14 仅凭持久化 Request Ledger evidence 可 backfill durable request identity，不需要重放或改写 rollout。
- 真实调查必须报告 `token_count` 数量及候选字段出现次数；不能只依据 fixture 宣称 native identity 不存在。

## T-OWN

- `T-OWN-001`：Root Task 被 2 个 child legacy rollout 复制，canonical Task 仍为 1，copied Task 不进入 own usage。
- `T-OWN-002`：Root → A → B，A 的真实 Task 被 B 复制时 owner=A。
- `T-OWN-003`：同 turn 出现在 sibling 且无法形成 ancestor 证据时必须 unresolved，不猜 owner。
- `T-OWN-004`：raw verified = canonical + inherited + unresolved；六字段 Token reconciliation 守恒。
- `T-OWN-005`：缺 `subagent_history_start_ordinal` / ordinal 的 legacy fixture 仍能正确归属。

## T-DAY2

- `T-DAY2-001`：跨午夜 Task 的 Request1 属于 day1、Request2 属于 day2；Project=两者总和。
- `T-DAY2-002`：Time day2 只展示 day2 有 canonical Request 的 Task slice，不因 lifecycle overlap 携带 day1-only Task。
- `T-DAY2-003`：inherited-copy envelope timestamp 改成 day2 时不得污染 day2 Token/Cost。
- `T-DAY2-004`：Full = Σ request-day，六字段 Token、Request count、USD 在相同 coverage 下守恒。

## T-ZERO

- `T-ZERO-001`：Task 前后 cumulative 六字段完全相同且中间无异常 → `verified_zero`, `0 token`, `$0.00`。
- `T-ZERO-002`：缺后快照、generation reset 或 anomaly → 仍为 unknown/partial，禁止猜零。

## T-PROJ / PERF

- `T-PROJ-001`：schema migration 重建 canonical/day projection，不修改 rollout。
- `T-PROJ-002`：rebuild 后 stale copied Task 不再进入 runtime projection，但 raw evidence 可审计。
- `T-PROJ-003`：Timeline cost 直接来自 persisted day projection，不调用全历史 `getTimelineCostTasks()`。
- `T-PROJ-004`：pricing policy/projection version 变化会使 projection stale 并重建。
- `T-PROJ-005`：仍存在 source 被重写/收缩时，只删除该 source 的 stale Task/Event 并 authoritative replace；不能留下幽灵 Task。
- `T-PROJ-006`：Timeline legacy `unattributed` fallback 与持久化 Agent aggregate 同样只消费 canonical ownership，不得把 raw fork copy 加回业务统计。
- `T-PROJ-007`：旧 root 已有 canonical Request，新 root legacy copy 同 identity 时不得触发 UNIQUE；copy Task/Request 只保留 provenance，全局 Token/Request 只计一次。
- `T-PROJ-008`：copy root 先索引、原始 root 后索引时，copy 先保持 inherited；原始 canonical Request 出现后自动 backfill `canonical_request_id`，统计仍只计一次。
- `T-PROJ-009`：即使 copied Task `startedAt` 被改写到新 root 创建之后，只要 request identity 已由其他 root 占有，也必须作为 duplicate-accounting guard 降级为 inherited，而不是崩溃或重复计量。
- `T-PROJ-010`：projection semantics 版本落后时，在 schema 仍为 v14 的前提下仅从持久化 raw evidence 重建 projection；不得通过 schema bump 或 rollout replay 假装完成语义升级。
- `T-PROJ-011`：同一个 turn 同时包含 cross-root inherited Request 与当前 root 新 Request 时，只排除 inherited Request；新 Request、Task 可见性与 Token/Request count 必须保留。
- `T-PERF-001`：真实历史 warm Timeline 不扫描全部 model events，目标 <200ms；warm day detail <300ms。
- `T-PERF-002`：点击已缓存 session 不进行 rollout parse；dirty session 由 background indexer 消费。

## T-INDEX / source authority

- `T-INDEX-001`：无 projection 的首次启动允许等待首轮后台构建；已有 cached projection 的启动立即可读。
- `T-INDEX-002`：append 后只消费 dirty session，Timeline 本身不承担 parser。
- `T-INDEX-003`：portable source relocation 继续复用 source key/cursor，不因绝对路径变化 replay。
- `T-INDEX-004`：source missing 时保留历史 verified canonical Task/Request，preview 可降级但业务 usage 不删除。
- `T-INDEX-005`：graceful close 等待 active index job，并取消 queued dirty sessions；SQLite 只能在 close Promise 完成后关闭。
- `T-PROJ-004`：`canonical_requests` 与 day/cost projection、`projection_generation` 在同一 transaction 中切换。
- parser-semantics regression：schema 保持 v14 时，旧 parser-version session 必须自动进入后台 reindex；旧 `unknown_records` 只能由重新解析结果修正，不能手工清零。
- 真实 unknown-record audit：对污染 session 聚类所有 unknown record，确认已审计 non-accounting allowlist 后 `unknownRecords=0`，同时 Request/Token reconciliation 不变。

## 完成门槛

- 全部 ownership / request-day / zero / projection 测试 Green。
- 真实污染 session reconciliation 无 verified evidence 静默丢失。
- 真实 `.codex` SHA-256 前后不变。
- `npm test`、`npm run check`、`git diff --check` 通过。
- HTTP API 内部异步 projection/index 错误必须被请求级 error boundary 捕获并返回 500，不能形成悬挂请求或逃逸为未处理 Promise rejection。
- 桌面/窄屏 Time 模式验证：日期切换不显示 inherited history，Project/Time 数值语义清晰。

