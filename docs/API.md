# 本地只读 API

API 由同一个 loopback HTTP 服务提供，前缀为 `/api`。它不是公开或远程 API；仅供随服务启动的本地页面使用。

## 认证和通用行为

1. 启动时服务输出 `http://127.0.0.1:<port>/?token=<random>`。
2. 第一次访问 `/` 时，一次性 token 被置空并换取 `codex_monitor` HttpOnly、SameSite=Strict Cookie。
3. 后续 API 请求必须携带该 Cookie，并通过 Host 和 Origin 校验。

所有接口只接受 `GET`（`HEAD` 在服务层允许）。响应使用 `Cache-Control: no-store`；SSE 使用 `no-cache, no-transform`。session/thread/turn ID 必须匹配 8–128 位字母、数字、下划线或连字符。

常见错误：

| 状态 | 含义 |
|---|---|
| `400` | ID 格式无效，`day` 不是合法 `YYYY-MM-DD` 本地日期，或 Request drill-down 的 `limit/cursor` 无效 |
| `401` | 缺少或错误的会话 Cookie |
| `403` | Host 或 Origin 不受信任 |
| `404` | 会话、任务或接口不存在 |
| `405` | 尝试写方法 |
| `500` | 本地解析或服务异常；正文不泄露内部错误细节 |

## 接口

### `GET /api/sessions?q=<text>`

返回可见根会话列表：

```json
{ "sessions": ["session summary objects"] }
```

每个会话摘要包含 nullable `projectPath`，值来自根线程 `session_meta.cwd`。`q` 可选，按当前只读索引中的标题、session ID、source 和工程目录做本地包含搜索。数据库不持久化标题；schema v8 继续把 `projectPath` 作为历史工程元数据保留，但 rollout/cursor 身份已经改为 `.codex` 相对 source key，`projectPath` 不参与文件定位。

### `GET /api/timeline`

返回全部已发现根 session 的本地日期用量账页。Phase 18/schema v14 起该 endpoint **只读取已有 SQLite projection**，不会因为一次 HTTP Timeline 请求同步解析 rollout 或现场重算历史费用。启动与文件 watcher 把 stale/dirty session 交给 background indexer；已有 projection 立即返回，首次没有任何 projection 时才允许等待首轮后台构建形成可用基线。Indexer 使用 portable `source_key` + cursor 执行 restore/tail/replay，并在单一 transaction 内生成 ownership、`canonical_requests`、request-day/cost projection 与新的 `projection_generation`。

cross-root ownership hardening 使用 projection v2、SQLite schema 仍为 v14。相同 request identity 已由其他 root canonicalize 时，当前 session 的 copied evidence 不会再次进入 Timeline/Session accounting。内部异步 projection/index 错误由请求级 error boundary 转成 HTTP 500，不应形成悬挂请求或未处理 Promise rejection。

该同步只写监控器自己的派生 SQLite（task、cursor、session-day aggregate），从不修改 `.codex`。Timeline 后台补齐不会把历史 rollout 中的全部 quota 快照批量归档；账号额度仍由现有 latest-quota/实时路径维护。cursor 不可信、文件收缩或持久化状态不足时，parser 会回退到原有安全 replay 规则。

```json
{
  "generatedAt": "2026-08-25T03:22:56.706Z",
  "timezone": "Asia/Shanghai",
  "projection": { "version": 2, "generation": 42 },
  "usage": { "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0, "totalTokens": 0 },
  "modelRequestCount": 0,
  "tokensPerModelRequest": null,
  "qualityCounts": { "complete": 0, "provisional": 0, "partial": 0, "unknown": 0 },
  "months": [{
    "key": "2026-08",
    "usage": {},
    "costEstimate": { "status": "estimated", "amountUsd": 0.0, "currency": "USD", "estimatedTasks": 0, "unavailableTasks": 0 },
    "modelRequestCount": 0,
    "tokensPerModelRequest": null,
    "taskCount": 0,
    "activeTaskCount": 0,
    "qualityCounts": {},
    "days": [{
      "key": "2026-08-24",
      "usage": {},
      "costEstimate": { "status": "estimated", "amountUsd": 0.0, "currency": "USD", "estimatedTasks": 0, "unavailableTasks": 0 },
      "modelRequestCount": 0,
      "tokensPerModelRequest": null,
      "taskCount": 0,
      "activeTaskCount": 0,
      "qualityCounts": {},
      "sessions": [{
        "id": "session-id",
        "title": "未命名会话",
        "projectPath": "C:\\workspace\\example",
        "date": "2026-08-24",
        "usage": {},
        "costEstimate": { "status": "estimated", "amountUsd": 0.0, "currency": "USD", "estimatedTasks": 0, "unavailableTasks": 0 },
        "modelRequestCount": 0,
        "tokensPerModelRequest": null,
        "taskCount": 0,
        "activeTaskCount": 0,
        "qualityCounts": {}
      }]
    }]
  }],
  "unattributed": { "taskCount": 0, "usage": {}, "qualityCounts": {} }
}
```

`months` 和 `days` 均按 key 降序排列；页面用原生 `details` 展开月份、日期和当天 session。Phase 18 起日期 key 只由 **canonical Request** 的原始 `observedAt` 所在监控器本地自然日决定；Task lifecycle 本身不再创建 Time slice。跨午夜 Task 只有在对应日期确实存在 canonical Request 时才出现，并且该日 `usage/request/coverage/quality/cost` 只聚合该日 Request。fork copy 的重写 envelope timestamp 不会改变 canonical Request 日期。`modelRequestCount` 对应 canonical verified Request Ledger units；`tokensPerModelRequest=usage.totalTokens/modelRequestCount`。

该接口的 total token 是本地 rollout 的审计汇总，不是 Codex 个人资料的订阅账单字段。个人资料可能采用不同的服务端时间边界、未公开的请求级计费口径或包含本地无法证明的记录；二者只应比较量级和质量覆盖，不应要求逐字相等。

### `GET /api/sessions/:id[?day=YYYY-MM-DD]`

选择根会话并返回一个显式 scope 的 **cached canonical snapshot**。已有 projection 时点击不会启动 parser；若 source 比 projection 新，响应先使用当前缓存并把 session 标记进后台 dirty queue，完成后由 SSE 推送新 generation。无 `day` 时保持完整 session 契约；带合法 `day` 时只返回该 session 在该本地自然日的 canonical Request / Task / Agent / Usage / Cost slice。日期使用监控器本地时区的 `[dayStart, nextDayStart)` 日历边界，支持 DST；非法或不存在的日历日期返回 `400`。

```json
{
  "session": { "projectPath": "C:\\workspace\\example" },
  "scope": { "type": "session" },
  "agents": [{
    "tasks": [],
    "ownCostEstimate": {},
    "subtreeCostEstimate": {},
    "ownModelRequestCount": 0,
    "subtreeModelRequestCount": 0,
    "ownTokensPerModelRequest": null,
    "subtreeTokensPerModelRequest": null
  }],
  "summary": {
    "agentCount": 0,
    "taskCount": 0,
    "activeTasks": 0,
    "totalUsage": {},
    "subagentUsage": {},
    "modelRequestCount": 0,
    "tokensPerModelRequest": null,
    "subagentModelRequestCount": 0,
    "subagentTokensPerModelRequest": null,
    "qualityCounts": {},
    "totalCostEstimate": {
      "status": "unavailable",
      "amountUsd": null,
      "currency": "USD",
      "estimatedTasks": 0,
      "unavailableTasks": 0
    },
    "subagentCostEstimate": {
      "status": "unavailable",
      "amountUsd": null,
      "currency": "USD",
      "estimatedTasks": 0,
      "unavailableTasks": 0
    }
  },
  "pricing": {},
  "quota": null,
  "health": {}
}
```

day scope 的 metadata 形如：

```json
{ "scope": { "type": "day", "day": "2026-08-26", "timezone": "America/Los_Angeles" } }
```

day snapshot 不修改 task 的 `startedAt` / `completedAt` 身份元数据；同一跨午夜 task 可以出现在相邻两天，但前提是两天都实际发生 canonical Request。`deltaUsage`、`requestCount`、`requestLedgerCoverage`、`quality` 和 `costEstimate` 都按目标日 Request 重新计算；生命周期跨日但当天无 Request 的 Task 不进入 Time 页面。Agent 只保留当天相关节点及维持 lineage 所需祖先。Phase 19 起每个 day-scope Task 还返回 `scopeKind="day_slice"`、`scopeDay`、`firstRequestAt`、`lastRequestAt`，用于明确表达当日 Request window；这些字段是查询 projection metadata，不创建第二个 Task identity。

每个 `agents[].tasks[]` 任务的 `deltaUsage` 都在运行时由 Request Ledger 物化，并同时包含 rollout 的 `model`、`effort` 以及运行时派生的 `costEstimate`：

```json
{
  "usageSource": "request_ledger",
  "requestCount": 1,
  "tokensPerModelRequest": 12345,
  "requestLedgerCoverage": { "verified": 1, "duplicate": 0, "unverified": 0, "anomaly": 0 },
  "quality": "complete",
  "deltaUsage": {},
  "model": "gpt-5.6-terra",
  "effort": "xhigh",
  "costEstimate": {
    "status": "estimated",
    "amountUsd": 0.012345,
    "currency": "USD",
    "basis": "subscription-standard-equivalent",
    "policyVersion": "2026-08-26",
    "requestCount": 1,
    "estimatedRequests": 1,
    "partialRequests": 0,
    "unavailableRequests": 0,
    "rateVersions": ["gpt-5.6-terra@2026-07-30"],
    "featureCoverage": {
      "historicalRate": "verified",
      "requestBoundary": "verified",
      "serviceTier": "verified"
    },
    "limitations": [],
    "reasons": []
  }
}
```

若 task 同时包含 verified 与 unverified/anomaly 事件，`deltaUsage` 只保留 verified 部分并以 `partial` 标记；没有可证明 usage 的完成任务保持 `partial`，活跃任务保持 `unknown`。旧 `boundaryDeltaUsage` / `boundaryQuality` API 字段已在 schema v11 删除；需要复核旧实现时使用 Git tag `usage-boundary-ledger-v1`。

`costEstimate` 先逐 verified Request Ledger usage unit 计算，再在 Task 层求和。状态为 `estimated | partial | unavailable`；`partial.amountUsd` 是当前可证明金额，不代表完整 Plus 扣费。`pricing.basis` 固定为 `subscription-standard-equivalent`。Historical Rate Resolver 使用 event `observedAt` 选择历史价；`input >272K` 的 long-context multiplier 与 Fast 只在 request-level evidence 可证明时应用，unknown service tier 不默认 standard。`featureCoverage` 明确披露 historical rate、request boundary 与 service tier 证据状态。

每个智能体的 `ownCostEstimate` 只合计自己的任务，`subtreeCostEstimate` 递归包含全部后代。`summary.totalCostEstimate` 合计主智能体和所有后代，`summary.subagentCostEstimate` 只合计非根智能体。摘要同时返回 task 与 request 级 `estimated/partial/unavailable` 数量及 `featureCoverage`。所有金额都来自 request cost 求和，不能重新对 Task aggregate 套 272K/Fast 规则；页面继续直接显示 `$xx.xx`，partial 状态通过 coverage/title 解释，不在主数值前加 `≥`。

页面从 request-derived `summary.totalUsage` 计算完整会话输入、输出和缓存命中率，从 `agents[].ownUsage` 与 `tasks[].deltaUsage` 计算对应层级命中率。统一公式为 `cachedInputTokens / inputTokens`；费用估算也消费同一套 request-derived 六字段 token。`requestCount` / `modelRequestCount` 和 `tokensPerModelRequest` 只由 verified model usage units 派生。

这是有状态选择操作，但不写 `.codex`；它只更新监控器自身的解析范围和派生 SQLite。

### `GET /api/sessions/:sessionId/tasks/:threadId/:turnId/requests[?day=YYYY-MM-DD&limit=N&cursor=...]`

按 Task 懒加载其 **canonical Request audit detail**。无 `day` 时读取完整 Task 的 canonical Request；带 `day` 时只读取该本地自然日 `[dayStart,nextDayStart)` 内的 Request。初始 session/day snapshot 不内嵌这些明细，因此长 Task 的 Request 数量不会线性放大常规 SSE payload 或 DOM。

查询只读 `canonical_requests`，不会返回 `inherited_copy` raw evidence。结果稳定按 `(observed_at, request_id)` 升序；默认 `limit=200`，允许 `1..500`。存在后续页时返回不透明 `nextCursor`，客户端只应原样回传。非法 day、limit 或 cursor 返回 `400`；Task 不属于指定 root session 时返回 `404`。

```json
{
  "task": { "threadId": "thread-id", "turnId": "turn-id", "sequence": 1, "status": "completed" },
  "scope": { "type": "session" },
  "requests": [{
    "requestId": "reqr_...",
    "observedAt": "2026-08-28T08:05:00.000Z",
    "usage": {
      "inputTokens": 100,
      "cachedInputTokens": 80,
      "cacheWriteInputTokens": 0,
      "outputTokens": 20,
      "reasoningOutputTokens": 5,
      "totalTokens": 120
    },
    "model": "gpt-5.6-terra",
    "serviceTier": "default",
    "pricingContextQuality": "verified",
    "quality": "complete",
    "costEstimate": { "status": "estimated", "amountUsd": 0.0 }
  }],
  "nextCursor": null,
  "projectionGeneration": 42
}
```

Request cost 继续严格使用该 Request 自身 event-level pricing evidence。若 canonical Request 缺 model/service-tier 等证据，detail 会返回既有 `partial/unavailable` 状态，而不会从 Task aggregate 反向猜值。`partial.amountUsd` 仍是可证明的基础金额，例如 service tier 缺失时保留已知历史标准价金额、但不猜 Fast/priority multiplier；前端会显示该金额并通过 USD 悬停说明披露 evidence 缺口。Request 表的“推理强度”来自所属 Task 的 `turn_context.effort`，不是伪造的 Request 独立字段。前端缓存展开明细时使用 `projectionGeneration`；SSE generation 变化只使已展开项按需失效并重新读取，不对所有 Task 主动 eager refresh。

### `GET /api/sessions/:id/events[?day=YYYY-MM-DD]`

为已选择的会话打开 `text/event-stream`。scope 规则与 snapshot endpoint 完全相同。连接后立即发送该 scope 的 `snapshot`；后续 session 更新会在最新持久化状态上按 listener 原始 scope 重新物化，day listener 不会收到其他日期 usage，full listener 仍获得完整 session。

| SSE event | data |
|---|---|
| `snapshot` | 当前 listener scope 的 session snapshot |
| `quota` | 最新账号级额度对象或 `null` |
| `health` | 最新解析器/仓库/存储健康对象 |

服务每 15 秒发送 SSE 注释 heartbeat；它不是业务事件。

### `GET /api/tasks/:threadId/:turnId/preview`

按数据库中保存的 `sourceKey` 绑定当前 Codex home 后读取原始 rollout，并返回最多 120 字的确定性指令预览。响应区分 `available`，源日志消失或 key 无法绑定时不会回退到数据库内容，因为正文从未被持久化。

当前页面不调用此接口。它暂时保留现有认证和内容最小化契约，等待后续“查看完整对话”功能另行设计。

客户端不能传入文件路径；运行时绝对路径只能由已存在任务的 source key 与当前 Codex home 解析。

### `GET /api/quota`

```json
{ "quota": null }
```

有数据时 `quota` 包含 limit ID/name、plan type、primary/secondary 窗口、观测时间、来源路径、`ageMs` 和 `stale`。超过 5 分钟或时间不可解析时 `stale=true`。若同一 `limitId`、plan、`windowMinutes` 与 `resetsAt` 下的并发快照出现 `usedPercent` 回退，运行时 current quota 对该窗口取已观测最大 `usedPercent`，并附加 `reconciled=true`；`resetsAt` 变化后不继承旧窗口最大值。持久化的 quota snapshot 仍保存各条规范化原始观测。额度不与任务 token 换算；前端把 `usedPercent` 转成 `100 - usedPercent` 的剩余比例展示。

传入 `GET /api/quota?refresh=1` 会立即重新发现本机 rollout、重新读取最近修改的额度来源并返回新的 current quota。该刷新只读取本机 `.codex` 数据，不调用模型、不请求 OpenAI 服务端，也不会为了取得额度主动产生 Codex 用量；如果 Codex 尚未写入新的 `rate_limits`，返回值会保持不变。

### `GET /api/health`

```json
{
  "health": {
    "status": "healthy",
    "observerMode": "rollout-file-observer",
    "projectionVersion": 2,
    "projectionGeneration": 42,
    "canonicalRequests": 100,
    "inheritedRequestCopies": 20,
    "unresolvedRequests": 0,
    "canonicalTasks": 10,
    "inheritedTaskCopies": 4,
    "unresolvedTasks": 0,
    "timeline": { "projectionDirtySessions": 0, "indexQueueLength": 0, "activeIndexJobs": 0 }
  }
}
```

完整对象还包含当前选择、监听状态、最后更新时间、repository 摘要、storage 统计、parser 健康及最近最多 5 条错误。Phase 18 明确暴露 canonical/inherited/unresolved Request 与 Task 数、projection version/generation、dirty queue/active index jobs 和 pricing projection version；`unresolvedRequests > 0` 时整体 `status` 不得显示为完全 healthy。Parser 健康继续报告坏行、unknown/skipped records、discontinuity、partial bytes，以及本次恢复/全量回放的文件数。路径信息只对已认证本地用户可见。

## 兼容性

API 当前随 `0.x` 版本演进，不承诺跨次要版本稳定。增加字段视为兼容；重命名、删除字段或改变安全/隐私语义必须更新 ADR、测试、README、本文档和 CHANGELOG。
