# Day-scoped Snapshot 测试方案

**状态：** Planned / implementation gate  
**设计依据：** [DESIGN-DAY-SCOPED-SNAPSHOT.md](DESIGN-DAY-SCOPED-SNAPSHOT.md)  
**关联 ADR：** [ADR-0018](decisions/0018-day-scoped-request-ledger-snapshot.md)

## 1. 测试原则

本文件不是“实现完成后补测试”的清单，而是 Phase 16 的验收门槛。开发必须按设计文档实现，再用本文件验证。

出现失败时执行固定闭环：

```text
测试失败
  -> 读取失败断言和最小复现证据
  -> 重新核对 DESIGN-DAY-SCOPED-SNAPSHOT.md / ADR-0018
  -> 判断：实现偏离 / 测试偏离 / 设计存在歧义
  -> 优先修正实现
  -> 定向测试通过
  -> 全量测试
  -> npm run check
  -> git diff --check
  -> 浏览器验收（涉及 UI 时）
```

禁止为了让测试变绿而直接放宽核心断言。如果测试与设计冲突，必须先指出冲突并以设计/ADR 为依据修改测试；如果设计本身有歧义，必须先更新设计与 ADR，再修改实现和测试。

## 2. 测试 fixture 基线

新增一个完全脱敏、可重复的跨午夜 fixture。至少包含：

- 1 个 root session。
- root task 与 1 个 subagent task。
- 至少一个 task 跨本地午夜。
- day 1 verified usage。
- day 2 verified usage。
- `duplicate`、`unverified` 或 `anomaly` 至少各覆盖一个关键分支。
- 同一 session 在 Timeline 中生成至少两个日期节点。

示例期望（数字仅用于 fixture 设计，最终测试固定后不得随实现漂移）：

```text
Day 1 verified total = 100
Day 2 verified total = 200
Full session total   = 300
```

必须同时断言六个 normalized usage 字段，而不是只看 `totalTokens`。

## 3. Unit：日期边界

### T-DAY-001 合法日期

- `YYYY-MM-DD` 可解析为本地 `[dayStart, nextDayStart)`。
- round-trip 后日期不变。

### T-DAY-002 非法日期

- `2026-02-31`、缺位数字、附加时间等输入被拒绝。
- API 返回 400，不自动纠正。

### T-DAY-003 DST 边界

- 使用存在 DST 的时区运行定向测试时，spring-forward / fall-back 日期按本地下一个 00:00 计算。
- 测试不得假设每日固定 24 小时。

## 4. Unit：Request Ledger 日切片

### T-DAY-010 跨午夜 verified usage

- 前一日只累计前一日 `observedAt` 的 verified events。
- 后一日只累计后一日 verified events。
- 两日逐字段之和等于 full-session verified usage。

### T-DAY-011 duplicate

- duplicate 计入 coverage，但 usage 增量恒为 0。

### T-DAY-012 unresolved evidence

- `unverified` / `anomaly` 不进入精确 usage。
- 同日已有 verified usage 时 slice quality 降为 `partial`。

### T-DAY-013 未归属 event

- 无法匹配已知 task 的 event 不进入 Task / Agent / Session 主 usage。
- 诊断/health evidence 仍可见，不静默改归属。

## 5. Unit：Task Day Slice

### T-DAY-020 生命周期跨日

- 一个 23:50 -> 00:20 的 task 在两个日期都存在 slice。
- 两个 slice 保留同一个 `threadId + turnId`。
- `startedAt/completedAt` 仍为完整 task 原始时间。
- `deltaUsage/requestCount/coverage/cost` 分别按日不同。

### T-DAY-021 当日无 verified usage

- task 生命周期与日期相交但当日没有 verified usage 时仍可出现。
- 不补造 token，quality 保持 `partial/unknown` 的设计允许状态。

### T-DAY-022 event 补充归属

- 即使 task 时间字段不足，只要 event 可证明归属到该 task 且 `observedAt` 在当天，task slice 仍进入该日。

## 6. Unit：Agent Day Slice

### T-DAY-030 own usage

- Agent `ownUsage` 只累计自身当日 task slices。

### T-DAY-031 subtree usage

- descendant usage 自底向上汇入祖先的 `subtreeUsage`。
- 祖先无 own usage 时仍可因 lineage 被保留，`ownUsage=0`、`subtreeUsage>0`。

### T-DAY-032 无关 Agent 不出现

- 当日无 task slice 且不是必要祖先的历史 Agent 不进入 day snapshot。

### T-DAY-033 request/cost 同 scope

- own/subtree model request count、tokens/request、cost 与 token 使用同一日期切片，不能读取完整 session aggregate。

## 7. Database / Migration

### T-DAY-040 `session_day_usage` 跨日物化

- 同一 root session 生成两个 `(day, root_session_id)` rows。
- token/request count 按 event `observedAt` 分桶。
- task count 按 Task Day Slice 规则分桶。

### T-DAY-041 v11 -> v12 no replay

- 构造已包含 Request Ledger 的 v11 数据库。
- 升级后 `session_day_usage` 被按新语义重建。
- `replayedFiles = 0`；不能只为日语义变化重读 `.codex`。

### T-DAY-042 新索引

- schema 中存在 `(root_session_id, observed_at, classification)` 查询索引。
- hot day snapshot 不触发全历史 rollout replay。

### T-DAY-043 重启一致性

- 关闭并重开数据库后，同一 session/day 的 usage、task count、request count 不漂移。

## 8. Monitor / API

### T-DAY-050 full snapshot 无回归

`GET /api/sessions/:id`：

- 返回 `scope.type = session`。
- 完整 token/task/agent/cost 与迁移前 fixture 基线一致。

### T-DAY-051 day snapshot

`GET /api/sessions/:id?day=YYYY-MM-DD`：

- 返回 `scope.type = day`、day、timezone。
- summary/task/agent/cost 只含当天数据。

### T-DAY-052 同 session 不同 day

- 连续请求同一个 id 的 day 1 / day 2，返回不同 slice。
- 不能因 session id 相同复用错误 snapshot。

### T-DAY-053 非法 day

- 非法日期 400。
- 不修改 session 选择状态或数据库。

### T-DAY-054 Timeline / Detail 一致

对每个 fixture `session + day`：

- `timeline day.sessions[n].usage == day snapshot.summary.totalUsage`。
- request count 一致。
- cost 在相同 pricing coverage 下逐项一致。

## 9. SSE

### T-DAY-060 scope 保持

连接：

```text
/api/sessions/:id/events?day=DAY1
```

后续 DAY2 rollout append 不得把 DAY2 usage 混入 DAY1 snapshot。

### T-DAY-061 当前日增量

- 当天新增 verified event 后，当天 scoped snapshot 增长一次。
- duplicate append 不增加 usage。

### T-DAY-062 full listener 保持完整

- 同一 append 对 full-session listener 仍反映完整 session 总量。

## 10. Frontend contract

### T-DAY-070 selection identity

- 时间模式按钮同时包含 `sessionId + day`。
- active 状态比较二元组，不仅比较 id。

### T-DAY-071 同 session 跨日点击

- 点击同一 session 的另一天会重新请求 `?day=...`。
- 页面标题/范围标识明确当前日期。

### T-DAY-072 模式切换

- Time -> Project：重新得到 full snapshot，并清空 `selectedDay`。
- Project -> Time：恢复该 session 上次 day；没有则选择该 session 最新可用 day。
- 不允许时间导航仍显示 full-session detail。

### T-DAY-073 实时交互稳定性

沿用 ADR-0017 验收：

- task table `scrollLeft` 不因 scoped SSE 更新归零。
- Agent `<details>` 展开状态不被覆盖。
- navigator month/day 展开和滚动位置保持。
- 同日结构新增时可见 anchor 不跳动。

## 11. Browser E2E

至少验证桌面和窄屏：

1. 工程模式打开跨日 session，看到完整总量。
2. 时间模式 day 1 打开同一 session，只看到 day 1 的 task/agent/token/cost。
3. 点击 day 2，同一 session 的 active 项正确切换，看到 day 2 数值。
4. 切回工程模式，总量恢复为完整 session。
5. 在任务表水平滚动、手动折叠 Agent/日期后触发 scoped live update，交互状态不丢失。

## 12. 性能与只读边界

### T-DAY-080 no all-history replay

- 已建立 v12 索引后，选择 day scope 不读取全部 rollout 历史。
- 重复选择同一已同步 session/day 走 SQLite/内存派生热路径。

### T-DAY-081 source hash

- 使用真实只读样本执行验收时，前后 SHA-256 不变。

### T-DAY-082 persistence privacy

- schema v12 不新增 prompt、response、消息正文或 session title 之外的内容字段。

## 13. 执行顺序

开发阶段按以下门槛推进：

1. 日期 + Request Ledger + Task Day Slice unit tests。
2. Agent/summary unit tests。
3. database v12 migration / Timeline tests。
4. monitor/API/SSE integration tests。
5. frontend contract tests。
6. `npm test`。
7. `npm run check`。
8. `git diff --check`。
9. desktop + narrow browser E2E。
10. 若配置真实 fixture，再执行 read-only hash regression；未配置必须明确 `skipped`，不能声称执行过。

## 14. 失败处理规则

每一个失败必须归类：

| 类型 | 处理 |
|---|---|
| 实现偏离设计 | 回到设计对应章节，修实现；不得弱化断言 |
| 测试偏离设计 | 给出设计依据后修测试；不得顺便改变产品语义 |
| 设计歧义 | 先更新 DESIGN + ADR，经确认后再改测试和实现 |
| 历史兼容回归 | 保留 full-session 契约，修迁移/adapter，不用 day 语义覆盖 project 语义 |
| 数据无法证明 | 保持 partial/unknown/diagnostic，不补数 |

任何定向测试修复后，都必须重新执行完整 `npm test` 与 `npm run check`，避免“只修当前断言”的局部通过。

## 15. 最终验收记录

功能开发完成后，在 `docs/VERIFICATION.md` 记录：

- schema 迁移版本和 no-replay 证据；
- unit / integration / UI / browser 实际执行结果；
- 跨午夜 fixture 的 day1/day2/full 六字段对账；
- Timeline vs day snapshot 对账；
- SSE scope 隔离结果；
- source hash（若真实样本实际执行）；
- skipped 项及原因。

