# Day-scoped Snapshot 设计说明

**状态：** Approved for implementation  
**设计日期：** 2026-08-26  
**关联决策：** [ADR-0018](decisions/0018-day-scoped-request-ledger-snapshot.md)

## 1. 目标

当前导航存在两个不同维度，但详情只有一个统计口径：

- **工程模式**按工程目录定位 session，点击后展示完整 session。
- **时间模式**按 `month -> day -> session` 展示日聚合，但点击后仍调用完整 session snapshot，导致左侧是“当日”，右侧却是“整个 session”。

本设计把详情查询明确拆成两个 scope：

| 模式 | Snapshot scope | 统计语义 |
|---|---|---|
| 工程 | `session` | 完整 session 生命周期 |
| 时间 | `session + local calendar day` | 该 session 在指定本地自然日内的记录与 Request Ledger usage |

核心要求是：**时间模式的任务、智能体、token、模型 usage unit、缓存命中率和费用必须全部来自同一个 day scope，不允许混入该 session 其他日期的数据。**

## 2. 事实源和不变量

以下项目级不变量继续有效：

1. `.codex` 只读，不改写 rollout、state、config，不调用模型补数。
2. Request Ledger 是唯一运行时 token 事实源。
3. 只有 `verified_increment` 与 `generation_start` 的 usage 进入精确 token 合计。
4. `duplicate` 为零增量；`unverified` / `anomaly` 只进入 coverage/quality，不补造 token。
5. 未归属到已知 task 的 usage event 不进入 Task / Agent / Session 主统计，只保留为诊断证据。
6. USD 仍然只是版本化标准 API 等值估算，不是 Codex 订阅实际扣费。
7. 时间模式使用监控器运行环境的**本地自然日**，不是 UTC 日期字符串，也不是 rollout 目录日期。

## 3. Scope 模型

后端详情聚合统一接受一个小型 scope interface：

```js
{ type: "session" }
```

或：

```js
{ type: "day", day: "2026-08-26" }
```

响应中显式返回 scope，避免调用方猜测当前数据口径：

```js
scope: {
  type: "day",
  day: "2026-08-26",
  timezone: "America/Los_Angeles"
}
```

工程模式不传 `day`，其既有完整 session 行为必须保持不变。

## 4. 本地日期边界

实现必须提供唯一的日期边界 helper，将合法 `YYYY-MM-DD` 转换为监控器本地时区中的半开区间：

```text
[dayStart, nextDayStart)
```

禁止用固定 `24 * 60 * 60 * 1000` 推导次日，因为 DST 日期可能不是 24 小时。必须按“下一个本地日历日期的 00:00”构造边界，再转换成可比较的 instant。

日期参数必须严格校验并 round-trip；非法日期（例如 `2026-02-31`）返回 HTTP 400，不得自动滚动到下个月。

## 5. Request Ledger 的日归属

时间模式不再用 `task.startedAt` 决定 token 属于哪一天。

每条 `model_usage_events` 按其 `observedAt` 所在本地自然日归属：

```text
23:50 task started
23:58 verified usage = 100
00:10 verified usage = 200

前一天 -> 100
后一天 -> 200
完整 session -> 300
```

这条规则同时用于：

- `session_day_usage` 的 token / request count 物化；
- day-scoped Task usage；
- day-scoped Agent own/subtree usage；
- day-scoped Session summary；
- day-scoped API-equivalent cost；
- Timeline 的 session/day/month cost rollup。

## 6. Task Day Slice

时间模式中的 task 不是完整 task usage，而是一个 **Task Day Slice**。

### 6.1 Task 是否属于某一天

满足以下任一条件即进入该日 slice：

1. task 生命周期与该自然日相交：`[startedAt, completedAt ?? +∞)` 与 `[dayStart, nextDayStart)` 有交集；
2. 有能够归属到该 `threadId + turnId` 的 Request Ledger event，其 `observedAt` 位于该日。

第二条用于容忍任务时间元数据不完整但事件归属仍可证明的情况。

### 6.2 Slice 中哪些字段被裁剪

以下字段必须严格按日重算：

- `deltaUsage`
- `requestCount`
- `tokensPerModelRequest`
- `requestLedgerCoverage`
- `quality`
- `costEstimate`

其中 usage 只累计该日的 verified events；coverage 只计该日落入此 task 的 event classifications。

### 6.3 哪些字段保留 task 原始语义

以下身份/定位字段继续使用原 task 元数据，不伪造“裁剪后的任务”：

- `rootSessionId`
- `threadId`
- `turnId`
- `model`
- `effort`
- `startedAt`
- `completedAt`
- 原始定位 ordinal / line / byte 元数据

第一版不生成假的 `scopedDurationMs`。跨午夜 task 可以在两个日期中出现，但页面上的原始开始/完成时间仍表示完整 task 生命周期；token、request 和 cost 才是 day-scoped。

### 6.4 Quality

沿用 Request Ledger 的质量语义，但只观察当前 day slice 中的事件：

- 有 verified usage，且该 slice 无 unresolved event、六字段完整：`complete`；若 task 当前仍在运行则为 `provisional`。
- 有 verified usage，但该 slice 同时存在 `unverified` / `anomaly` 或 usage 字段不完整：`partial`。
- 只有 unresolved event：`partial`。
- task 与日期相交但该日没有可验证 Request Ledger evidence：不得补数，保持 `partial` 或现有运行态允许的 `unknown`。

## 7. Agent Day Slice

时间模式不得读取 SQLite 中完整 session 的 `agents.own_usage` / `subtree_usage` 直接展示。

步骤固定为：

```text
Task Day Slices
    -> group by threadId
    -> Agent own day usage / request / cost
    -> 按 parentThreadId 自底向上递归
    -> Agent subtree day usage / request / cost
```

Agent 可见性规则：

- 当日有 task slice 的 agent 必须显示。
- 为保持 lineage，从这些 agent 向上的祖先节点直到 root 必须显示，即使祖先当日 `ownUsage = 0`。
- 与该日完全无关且不是必要祖先的 agent 不显示。

因此时间模式中的 `agentCount` 表示**当日活动 lineage 中的非 root agent 数量**，不是完整 session 的历史 agent 总数。

## 8. Session Day Snapshot

Day-scoped session summary 从 Task/Agent Day Slice 重建：

- `totalUsage`：该 session 当日可验证 usage。
- `subagentUsage`：非 root agent 当日 usage。
- `modelRequestCount` / `subagentModelRequestCount`：当日 verified model usage unit 数。
- `tokensPerModelRequest`：对应 day scope 的比值。
- `taskCount`：该日 task slice 数。
- `activeTasks`：这些 slice 中**当前仍为 `in_progress`** 的 task 数；该字段不表示历史并发度。
- `qualityCounts`：该日 task-slice quality。
- `totalCostEstimate` / `subagentCostEstimate`：只根据该日 usage 估算。

完整 session snapshot 继续使用完整历史，不能因 day-scope 改造发生数值变化。

## 9. Calendar 物化索引

`session_day_usage` 保留现有 `(day, root_session_id)` 主键和六类 token 列，不新增第二套日历事实表。

但其语义改为：

> 一个 root session 在该本地自然日内，由 Request Ledger `observedAt` 证明的 usage，以及该日对应的 task slices。

因此实现阶段应升级至 **schema v12**，明确这次物化语义迁移，即使表列本身不需要改变。

v11 -> v12 迁移要求：

1. 从已持久化 `tasks` + `model_usage_events` 重建 `session_day_usage`。
2. Request-ready session **不得仅因本次迁移重读 rollout**。
3. 建议增加索引：

```sql
CREATE INDEX idx_model_usage_events_root_observed
ON model_usage_events(root_session_id, observed_at, classification);
```

4. 跨日 task 的 `task_count` 按 Task Day Slice 规则进入每个相交日期；`active_task_count` 保持“当前仍在运行的 slice task”语义，不解释为历史并发。

## 10. API 契约

### 10.1 Snapshot

完整 session：

```http
GET /api/sessions/:id
```

指定日期：

```http
GET /api/sessions/:id?day=2026-08-26
```

`day` 合法时返回 day-scoped snapshot；非法时 400。

### 10.2 SSE

完整 session：

```http
GET /api/sessions/:id/events
```

指定日期：

```http
GET /api/sessions/:id/events?day=2026-08-26
```

SSE 初始 snapshot 与后续 `snapshot` event 必须使用同一 scope。文件追加后，服务端不得把预先构造的 full-session snapshot 直接推给 day-scoped listener，而应在已更新持久化状态上重新生成对应 scope 的 snapshot。

## 11. 前端状态模型

时间模式下，同一个 session 可以出现在多个日期，因此 selection identity 必须由：

```text
(sessionId, day)
```

共同决定。

前端至少维护：

```js
selectedId
selectedDay // project mode 为 null
```

具体要求：

- 时间列表按钮同时携带 `data-session-id` 与 `data-session-day`。
- 时间模式 active 状态同时比较 id 与 day。
- 点击同一 session 的不同日期必须重新请求 snapshot，不能因 `sessionId` 相同短路。
- 工程模式选择 session 时清空 `selectedDay` 并请求完整 snapshot。
- 从工程切换到时间模式时，若当前 session 有日历记录，优先恢复该 session 上次选择的日期；没有记录则选择该 session 最新可用日期。不得让“时间导航 + 完整 session 详情”继续并存。
- 从时间切回工程模式时，对当前 session 重新请求 full-session snapshot。

## 12. Timeline 与实时一致性

左侧 Timeline 与右侧 day snapshot 必须来自相同日归属规则。禁止出现“左侧 300、右侧 200”这种跨午夜分桶不一致。

实时追加时：

- 当前 day-scoped detail 只接受该 scope 的增量结果。
- Timeline 可重新拉取或做 keyed patch，但必须遵守 ADR-0017 的交互稳定性：不得因实时更新重置导航滚动、month/day 展开状态、任务表横向滚动或 Agent 展开状态。

## 13. 模块 seam 建议

实现时优先形成一个深模块，而不是在 DB、monitor、server、UI 各自复制日期判断：

```text
materializeSnapshot(storedSession, scope)
  ├─ session scope -> full task materialization
  └─ day scope
       ├─ resolveLocalDayRange(day)
       ├─ materializeTaskDaySlices(tasks, events, range)
       ├─ materializeAgentDaySlices(...)
       └─ summarize scoped session
```

日期合法性、事件分桶、Task Day Slice quality 只能有一个事实实现；Timeline 物化和详情 snapshot 应复用同一语义 helper，避免两套“几乎相同”的日期规则再次漂移。

## 14. 明确不做的事情

- 不按 task `startedAt` 把整个 task usage 粗暴归入某一天。
- 不把 Request Ledger `observedAt` 等同于服务端 HTTP 请求时间或计费时间。
- 不用 Profile / quota 数字校准日统计。
- 不创建 prompt/response/标题正文持久化。
- 不在第一版伪造按日裁剪后的 task duration。
- 不把未归属 usage event 塞进某个 Agent 或 Task 以追求总量接近 Profile。
- 不为该功能引入第二套运行时 ledger 或兼容旧 Boundary Ledger。

## 15. Definition of Done

只有同时满足以下条件，B 方案才算实现完成：

1. 同一跨午夜 session：`day1 + day2 == full session`（对可验证 usage 字段逐字段成立）。
2. 时间模式 Task / Agent / Session / Cost 全部只使用指定日期数据。
3. 工程模式完整 session 行为无回归。
4. Timeline 与 day detail 对同一 `session + day` 的 usage/cost 一致。
5. schema v11 -> v12 不因语义迁移重读 Request-ready rollout。
6. 同一 session 在不同日期可独立选中并保持正确 active 状态。
7. day-scoped SSE 不泄漏其他日期 usage，并保留现有交互稳定性。
8. [测试方案](TEST-DAY-SCOPED-SNAPSHOT.md) 全部通过；失败时必须按其中的回退闭环处理。

