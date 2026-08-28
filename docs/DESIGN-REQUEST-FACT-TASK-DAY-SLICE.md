# Phase 19：Request Fact / Task Day Slice 技术实现设计

**状态：** Design Ready / Implementation Pending
**日期：** 2026-08-28
**依赖：** ADR-0018、ADR-0019、ADR-0020、Phase 18.1 cross-root ownership hardening

## 1. 目标

本阶段不重做 Request Ledger，也不改变已经确认的 Token 事实链。目标是把当前容易混淆的三个概念彻底冻结，并让数据库、API 与 UI 使用同一套语义：

1. **Request 是计量原子。** Token / Cost / 日期归属只能从 verified canonical Request 得到。
2. **Task 是业务工作单元。** Project / Session 视图以完整 Task 作为最小主要展示单位，一个 Task 可以包含多个 Request。
3. **Task Day Slice 是时间视图展示单位。** Time 模式先按 Request `observedAt` 切日，再把当日 Request 聚合回 Task；不得把完整 Task Token 粗放放入某一天。

因此最终领域模型固定为：

```text
Rollout raw evidence
  -> Request Identity
  -> Canonical Request Fact
  -> Ownership / Provenance
      -> Session Projection: Session -> Agent -> Full Task -> Request
      -> Time Projection: Day -> Session -> Agent -> Task Day Slice -> Request
```

## 2. 术语与不变量

### 2.1 Request Fact

一条真实模型 sampling usage 的唯一计量事实。至少包含：

- `request_id`
- canonical `observedAt`
- 六字段 usage
- model / service tier / pricing context
- canonical owner locator：root session / thread / turn
- origin evidence locator

同一个 Request 可以被多个 rollout 观察到，但只能存在一个 accounting fact。

### 2.2 Task

`Agent thread + turn` 对应的一段完整工作单元。Task 负责回答“这段 Agent 工作在做什么”，不负责决定 Token 属于哪一天。

### 2.3 Task Day Slice

Task Day Slice 不是新 Task，也不能持久化成第二个 Task identity。它只是查询/展示投影：

```text
Task Day Slice(task, day)
= 该 Task 在 day 内的 canonical Request 子集
```

同一个 Task 可以在多个日期出现多个 slice，但 Session 全量视图仍只有一个 Task。

### 2.4 必须长期保持的守恒关系

对 verified raw evidence，六字段逐项满足：

```text
Raw Verified Usage
= Canonical Usage
+ Inherited-copy Usage
+ Unresolved Usage
```

对 canonical accounting：

```text
Full Session Usage = Σ Full Task Usage = Σ Canonical Request Usage owned by Session
```

对时间投影：

```text
Full Canonical Usage = Σ All Local-Day Request Usage
```

任何一项守恒失败都属于数据正确性故障，不能通过 `INSERT OR IGNORE`、补偿系数或 UI 隐藏绕过。

## 3. Cross-root history copy 修复边界

Phase 18.1 已开始补齐同一 Request 被 legacy history 复制到新 root session 的情况。本阶段继续把该语义作为正式前置不变量：

- `canonical_requests.request_id` 保持全局唯一；不得改成 `(root_session_id, request_id)` 联合唯一来掩盖重复 accounting。
- 同 identity 在其他 root 已有 canonical owner 时，当前 evidence 必须为 `inherited_copy`。
- copy-first / original-later 时，copy evidence 可以先保留 provenance，原 owner 出现后 backfill `canonical_request_id`。
- 同一个 turn 同时含 inherited Request 与真实新 Request 时，只剔除 inherited Request；新 Request 与 Task 必须保留。
- copied envelope timestamp 不得改变 canonical Request 的 accounting day。

`model_usage_events` 继续保存 raw evidence；`event_ownership` 负责说明该 evidence 是 `canonical / inherited_copy / unresolved`。Evidence 可重复出现，Accounting 不能重复。

## 4. Session / Project Projection

Project 或 Session 模式读取完整生命周期：

```text
Session
  -> Agent
    -> Full Task
      -> canonical Request 1..N
```

Task usage、cache、request count、cost 均为该 Task 所有 canonical Request 的汇总。日期不参与 Full Task 切分。

示例：

```text
Task A
R1  08-27 23:55  100K
R2  08-28 00:05  200K
R3  08-28 00:20  150K

Project / Session:
Task A = 450K / 3 Requests
```

## 5. Time / Day Projection

Time 模式严格执行：

```text
canonical Request
  -> localDate(observedAt)
  -> group by owner Task
  -> Task Day Slice
  -> Agent Day Slice
  -> Session Day Slice
```

同一示例：

```text
08-27:
Task A Day Slice = R1 = 100K / 1 Request

08-28:
Task A Day Slice = R2 + R3 = 350K / 2 Requests
```

禁止使用以下字段决定 Token 日期：

- `task.startedAt`
- `task.completedAt`
- `session.createdAt`
- copied rollout envelope timestamp

只有 canonical Request 的 `observedAt` 可以决定日期。

## 6. API / Snapshot 契约

### 6.1 Full Task

Session scope Task 保持现有主要字段，并明确其语义为完整生命周期：

- `threadId / turnId / sequence`
- `status / startedAt / completedAt / durationMs`
- `deltaUsage`
- `requestCount`
- `costEstimate`
- `quality`

### 6.2 Task Day Slice

Day scope 不创建新 Task ID，但应补充只描述当日 Request 子集的展示元数据：

- `scopeKind: "day_slice"`
- `scopeDay`
- `requestCount`
- `firstRequestAt`
- `lastRequestAt`
- `deltaUsage`
- `costEstimate`
- `quality`

`startedAt / completedAt / durationMs` 仍可作为原 Task metadata 保留，但 UI 不得把它们误标为“当日开始/当日耗时”。

### 6.3 Request drill-down

初始 snapshot **不内嵌全部 Request 明细**，避免 Session 或长 Task 造成大 payload。Task 展开时按需读取：

```text
GET /api/sessions/:sessionId/tasks/:threadId/:turnId/requests
GET /api/sessions/:sessionId/tasks/:threadId/:turnId/requests?day=YYYY-MM-DD
```

返回 canonical Request，按 `(observed_at, request_id)` 排序。建议首批 `limit=200`，超过时使用稳定 cursor 分页；Time scope 的 `day` 与当前 selected day 必须一致。

Request 明细至少展示：时间、Input、Cached Input、Cache Write、Output、Reasoning、Total、Model、Service Tier、USD/coverage。Raw copied evidence 不进入默认 Request 明细，只在未来诊断视图需要时通过 provenance 查询。

## 7. UI 设计

### 7.1 Project / Session 模式

标题继续使用“任务记录”。一行代表完整 Task，当前 `开始 / 耗时 / 模型 / 强度 / usage / cost / quality` 语义保持不变，并增加或明确 `Requests` 数量。

### 7.2 Time 模式

标题改为“当日任务活动”，摘要中的 `任务` 改为“活动任务”，并把 `Requests` 提升为显式计量指标。

Time 表格不要机械复用 Full Task 的“开始 / 耗时”列，因为跨日 Task 会造成误读。推荐列：

```text
Task | 状态 | 当日首请求 | 当日末请求 | Requests | 模型 | 输入 | 缓存 | 命中率 | 输出 | 总计 | USD | 质量
```

其中 usage / cost / cache hit 全部来自当日 Request 子集。Task 名称和状态仍来自原 Task identity/lifecycle，时间列明确标注“当日 Request”，不能伪造 Task lifecycle。

### 7.3 Task 展开

点击 Task 后懒加载 Request 列表：

```text
Task A · 08-28
350K · 2 Requests · $x.xx
  00:05  Request  ... 200K
  00:20  Request  ... 150K
```

Project 模式展开显示完整 Task 的全部 canonical Request；Time 模式只显示当天 Request。

### 7.4 实时更新稳定性

继续遵守 ADR-0017：

- Task DOM key 仍使用稳定 `threadId + turnId`；Time 模式 slice key 在状态缓存中使用 `(threadId, turnId, day)`。
- SSE 更新不得重建整个任务树。
- 已展开 Request 明细按 `projection_generation` 失效后重新拉取，不在每个 SSE tick 主动刷新所有展开项。
- 保持横向滚动、Agent 展开、Task 展开、焦点和 visual anchor。

## 8. SQLite / 后端性能设计

### 8.1 热路径

初始 Session / Day snapshot 继续只消费 canonical projection，不扫描全库 raw evidence。Raw evidence 只用于 index/rebuild/reconciliation。

已有索引：

```text
canonical_requests(root_session_id, observed_at, turn_id)
```

为 Task Request drill-down 建议增加：

```text
canonical_requests(root_session_id, thread_id, turn_id, observed_at, request_id)
```

如 provenance backfill/诊断查询需要按 canonical id 反查 evidence，再增加：

```text
event_ownership(canonical_request_id, status)
```

索引只服务明确查询路径，不为“可能以后会用”创建冗余索引。

### 8.2 写路径

ownership -> canonical request -> day projection -> generation 继续在一个 SQLite transaction 内完成。跨 root 解析不得为每条 Request 执行无界全表扫描；优先批量收集 identity，再通过临时集合/批量 SQL 查已存在 canonical identity。

### 8.3 性能门槛

- warm Timeline P95 `< 200ms`
- warm day/session detail P95 `< 300ms`
- Task Request drill-down 首批 P95 `< 100ms`（本地 SQLite，warm cache）
- cached Project <-> Time 切换不得触发 rollout replay
- 初始 snapshot payload 不随 Request 明细线性膨胀
- projection rebuild 可在后台超过上述交互门槛，但必须保持 UI 读取上一完整 generation

性能测试属于集成/benchmark，不塞进业务单元测试。

## 9. Migration / Cutover

本阶段 UI/snapshot 语义原则上不要求改变 `canonical_requests` 的全局 Request identity，也不要求重新解析 `.codex`。

若仅新增查询索引和 day-slice metadata：

- schema 可继续保持 v14；
- projection accounting 语义保持 Phase 18.1 v2；
- derived day slice metadata 可查询时计算；
- 不得为了 UI 字段人为触发全历史 rollout replay。

如果实现中发现必须改变 persisted projection 语义，则应单独提升 projection version，并先更新 ADR/TEST；不得顺手改变 schema/accounting 口径。

## 10. 明确禁止的“快速修复”

- `INSERT OR IGNORE` 吞掉 canonical collision。
- 把 `request_id` 改成 root-local identity。
- Time 按 `task.startedAt` 归整 Task Token。
- 为了页面方便把 Task 拆成多个持久化 Task。
- 从 Task total 反推某日 Request Token。
- copied envelope timestamp 覆盖 canonical Request day。
- 初始 Session snapshot 携带所有 Request 明细。
- 为测试方便放宽六字段 conservation。

## 11. 实施顺序

1. 先锁定业务单元测试：Full Task / Task Day Slice / cross-root copy / mixed-turn / 六字段守恒。
2. 补充 Task Day Slice snapshot metadata，不改变 canonical accounting。
3. 增加 Task Request drill-down SQL/API 与针对性索引。
4. 改造 Project / Time 两套任务表头和摘要文案，加入懒加载 Request 明细。
5. 执行 DB/API/性能与浏览器验收。
6. 最后更新交付文件为 Implemented；任何业务单元测试失败都先回到本设计检查，不通过削弱断言绕过。
