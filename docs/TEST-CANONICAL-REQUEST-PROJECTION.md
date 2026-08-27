# Canonical Request Ownership / Projection 测试方案

**状态：** Phase 18 implementation gate

## 测试 seam

1. `Rollout → Canonical Ownership`：legacy fork history 不能产生新 Task/Request。
2. `Canonical Request → Projection`：Project 汇总完整 Task；Time 按 Request observed day 切片并按 Task 分组。
3. `Projection → HTTP/UI`：Timeline/session 查询只读取持久化 projection，点击不承担索引。

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
- `T-PERF-001`：真实历史 warm Timeline 不扫描全部 model events，目标 <200ms；warm day detail <300ms。
- `T-PERF-002`：点击已缓存 session 不进行 rollout parse；dirty session 由 background indexer 消费。

## 完成门槛

- 全部 ownership / request-day / zero / projection 测试 Green。
- 真实污染 session reconciliation 无 verified evidence 静默丢失。
- 真实 `.codex` SHA-256 前后不变。
- `npm test`、`npm run check`、`git diff --check` 通过。
- 桌面/窄屏 Time 模式验证：日期切换不显示 inherited history，Project/Time 数值语义清晰。

