# 本地 API

API 由同一个 loopback HTTP 服务提供，前缀为 `/api`。它不是公开或远程 API；仅供随服务启动的本地页面使用。

## 认证和通用行为

1. 服务只在精确 loopback endpoint 提供 API；默认根地址为 `http://127.0.0.1:47832/`，启动输出不含 credential query。
2. 浏览器授权通过 `codex-usage-monitor open` 与匿名的 `/auth/challenge`、`/auth/bootstrap` 两个 bootstrap route 建立：CLI 使用本机 private secret 对 60 秒 one-shot challenge 生成 origin-bound proof，成功后服务设置 `codex_monitor` HttpOnly、SameSite=Strict Cookie并重定向回无 credential 的 `/`。
3. 除 challenge/bootstrap 外，静态页面和所有 API 均必须携带有效 Cookie，并继续通过 exact Host 与 Origin 校验；有效 Cookie 可跨 monitor 进程重启使用。

默认接口只接受 `GET`（`HEAD` 在服务层允许）。Phase 24B2 仅为 Diagnostic Alerts operational state 开放三个明确 allowlist 的 `POST` 路由：policy、Ack、Snooze；不存在通配写路由，其他 POST 仍返回 `405`。所有写路由继续要求同一 Strict Cookie、Host 与 Origin 校验。响应使用 `Cache-Control: no-store`；SSE 使用 `no-cache, no-transform`。session/thread/turn/alert ID 必须匹配 8–128 位字母、数字、下划线或连字符。

常见错误：

| 状态 | 含义 |
|---|---|
| `400` | ID 格式无效，`day` 不是合法 `YYYY-MM-DD` 本地日期，Request drill-down 参数无效，或 alert policy 参数越界 |
| `401` | 缺少或错误的会话 Cookie |
| `403` | Host 或 Origin 不受信任 |
| `404` | 会话、任务或接口不存在 |
| `405` | 使用了该 route 不允许的方法，或 POST 不在明确 operational allowlist 中 |
| `500` | 本地解析或服务异常；正文不泄露内部错误细节 |

## 接口

### `GET /api/sessions?q=<text>`

返回可见根会话列表：

```json
{ "sessions": ["session summary objects"] }
```

每个会话摘要包含 nullable `projectPath`，值来自根线程 `session_meta.cwd`。`q` 可选，按当前只读索引中的标题、session ID、source 和工程目录做本地包含搜索。数据库不持久化标题；schema v8 继续把 `projectPath` 作为历史工程元数据保留，但 rollout/cursor 身份已经改为 `.codex` 相对 source key，`projectPath` 不参与文件定位。

### `GET /api/timeline`

返回全部已发现根 session 的本地日期用量账页。Phase 18/schema v14 起该 endpoint **只读取已有 SQLite projection**，不会因为一次 HTTP Timeline 请求同步解析 rollout 或现场重算历史费用；当前 schema 为 v15，但 v15 只新增 Diagnostic Alerts operational tables，不改变该 projection。启动与文件 watcher 把 stale/dirty session 交给 background indexer；已有 projection 立即返回，首次没有任何 projection 时才允许等待首轮后台构建形成可用基线。Indexer 使用 portable `source_key` + cursor 执行 restore/tail/replay，并在单一 transaction 内生成 ownership、`canonical_requests`、request-day/cost projection 与新的 `projection_generation`。

cross-root ownership hardening 继续使用 projection v2；SQLite schema 当前为 v15，其中 accounting/projection 表语义仍沿用 v14。相同 request identity 已由其他 root canonicalize 时，当前 session 的 copied evidence 不会再次进入 Timeline/Session accounting。内部异步 projection/index 错误由请求级 error boundary 转成 HTTP 500，不应形成悬挂请求或未处理 Promise rejection。

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
    "policyVersion": "2026-08-28-explicit-fast",
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

`costEstimate` 先逐 verified Request Ledger usage unit 计算，再在 Task 层求和。状态为 `estimated | partial | unavailable`；`partial.amountUsd` 是当前可证明金额，不代表完整 Plus 扣费。`pricing.basis` 固定为 `subscription-standard-equivalent`。Historical Rate Resolver 使用 event `observedAt` 选择历史价；GPT-5.4/5.5/5.6 的 `input >272K` long-context multiplier 仍按 Request 证据判定，GPT-6 Astra 的 Codex pricing 则将该状态标记为 `exempt` 且不追加 surcharge。Fast 采用显式规则：只有原始 `service_tier` 明确为 `fast` 才应用 Fast multiplier，其余值全部按 standard；因此 service tier 缺失本身不再降低 cost coverage。

每个智能体的 `ownCostEstimate` 只合计自己的任务，`subtreeCostEstimate` 递归包含全部后代。`summary.totalCostEstimate` 合计主智能体和所有后代，`summary.subagentCostEstimate` 只合计非根智能体。摘要同时返回 task 与 request 级 `estimated/partial/unavailable` 数量及 `featureCoverage`。所有金额都来自 request cost 求和，不能重新对 Task aggregate 套 272K/Fast 规则；页面继续直接显示 `$xx.xx`，partial 状态通过 coverage/title 解释，不在主数值前加 `≥`。

页面从 request-derived `summary.totalUsage` 计算完整会话输入、输出和缓存命中率，从 `agents[].ownUsage` 与 `tasks[].deltaUsage` 计算对应层级命中率。统一公式为 `cachedInputTokens / inputTokens`；费用估算也消费同一套 request-derived 六字段 token。`requestCount` / `modelRequestCount` 和 `tokensPerModelRequest` 只由 verified model usage units 派生。

这是有状态选择操作，但不写 `.codex`；它只更新监控器自身的解析范围和派生 SQLite。

### `GET /api/sessions/:sessionId/tasks/:threadId/:turnId/requests[?day=YYYY-MM-DD&limit=N&page=N|cursor=...]`

按 Task 懒加载其 **canonical Request audit detail**。无 `day` 时读取完整 Task 的 canonical Request；带 `day` 时只读取该本地自然日 `[dayStart,nextDayStart)` 内的 Request。初始 session/day snapshot 不内嵌这些明细，因此长 Task 的 Request 数量不会线性放大常规 SSE payload 或 DOM。

查询只读 `canonical_requests`，不会返回 `inherited_copy` raw evidence。结果稳定按 `(observed_at, request_id)` 升序；默认 `limit=200`，允许 `1..500`。接口同时保留两种只读分页协议：历史 cursor 模式继续通过不透明 `nextCursor` 顺序读取；传 `page=N` 时按同一稳定顺序做编号分页，并返回 `pagination.page/pageSize/totalItems/totalPages`。`page` 与 `cursor` 互斥。当前页面默认使用 `limit=10&page=N`，并允许用户切换为 `limit=5`；总 Request 数少于 10 时不渲染分页导航。非法 day、limit、page 或 cursor 返回 `400`；Task 不属于指定 root session 时返回 `404`。

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
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "totalItems": 24,
    "totalPages": 3
  },
  "nextCursor": null,
  "projectionGeneration": 42
}
```

Request cost 继续严格使用该 Request 自身 event-level pricing evidence。缺 model、历史价、usage breakdown 或其他必要证据时仍返回 `partial/unavailable`，不会从 Task aggregate 反向猜值；但 service tier 采用 ADR-0023 的业务默认：**仅字面 `fast` 为 Fast，其余均为 standard**。Request 表的“推理强度”来自所属 Task 的 `turn_context.effort`，不是伪造的 Request 独立字段。服务层级 UI 只显示 `standard` 或 `fast · N 倍率`；倍率直接使用该 Request 已计算的 pricing evidence（当前 GPT-6 Astra/GPT-5.6/GPT-5.5 Fast 为 2.5×、GPT-5.4 为 2×），不会把 long-context output multiplier 混入 Fast。Astra 的 Codex `>272K` exemption 与 API model page 的 feature pricing 分开维护。前端缓存展开明细时使用 `projectionGeneration`；SSE generation 变化只使已展开项按需失效并重新读取，不对所有 Task 主动 eager refresh。

### `GET /api/sessions/:sessionId/requests/:requestId/content`

按 canonical Request 懒加载其本地 rollout **Observed Interaction Slice**。该接口不是 Provider request-body recorder：`evidence.providerPayloadReconstructed` 固定为 `false`，UI/API 只能把结果描述为本地 rollout 中可观察到的交互记录，不能称为完整 Prompt、Responses payload 或 HTTP wire body。

服务端先用 `(sessionId, requestId)` 查询 `canonical_requests.origin_source_key + origin_line_number`，并解析所属 Task 与同 Task、同 source 的前一 canonical Request。客户端不能提交 `source/path/line/byte`；该 endpoint 也不接受任何 query 参数。Request 不属于指定 session 时返回 `404`。Request 存在但 source 已不存在、portable source key 无法绑定、Task boundary 不可证明或 source locator 已变化时，仍返回 `200` 与 Request metadata，同时使用 `available=false` 和结构化 `reason/coverage` 说明正文证据不可用。

```json
{
  "version": 2,
  "projectionGeneration": 8329,
  "available": true,
  "request": {
    "requestId": "reqr_...",
    "observedAt": "2026-09-02T18:00:00.000Z",
    "model": "gpt-5.6-sol",
    "effort": "xhigh",
    "serviceTier": "default",
    "quality": "complete",
    "usage": {},
    "costEstimate": {}
  },
  "evidence": {
    "kind": "rollout_observed_interaction",
    "providerPayloadReconstructed": false,
    "sourceKey": "sessions/.../rollout-....jsonl",
    "startLine": 101,
    "endLine": 108,
    "complete": true,
    "truncated": false,
    "coverage": "complete",
    "locateBytes": 262144,
    "sliceBytes": 14821,
    "anchor": "reverse"
  },
  "preModelCut": {
    "status": "observed",
    "kind": "before_first_observed_model_output",
    "lineNumber": 104,
    "recordKind": "reasoning"
  },
  "items": [
    { "kind": "message", "section": "observed_input", "role": "user", "text": "..." },
    { "kind": "runtime_context", "section": "runtime_context", "fields": [] },
    { "kind": "tool_call", "section": "observed_interaction", "tool": "exec_command", "fields": [] },
    { "kind": "reasoning_summary", "section": "observed_interaction", "text": "...", "occurrenceCount": 2, "opaqueContentPresent": true }
  ],
  "summary": {
    "observedItemCount": 4,
    "observedInputItemCount": 1,
    "runtimeContextItemCount": 1,
    "observedInteractionItemCount": 2,
    "messageCount": 1,
    "toolCallCount": 1,
    "reasoningRecordCount": 2,
    "reasoningCardCount": 1
  }
}
```

Slice 起点为前一条同 Task/同 source canonical Request `token_count` boundary 的下一行；第一条 Request 只在 Task `sourceKey/startLine/startByte` 与当前 canonical locator 可证明对齐时回退到 Task 起点。终点严格是当前 `origin_line_number`，不会因为后面紧邻另一条 `token_count` 而扩大范围。

读取分为两个 bounded 阶段：locator 以 Task `start_byte/start_line/end_byte/end_line` 为双端 anchor，只统计 JSONL 换行来定位目标 line 的精确 byte range，单侧最多 `12 MiB`、双侧总预算 `24 MiB`；随后只解析真实 Observed Interaction Slice，slice 上限 `4 MiB`。投影层另有 `500 records / 64 KiB per item / 512 KiB public body` 上限。任何阶段超限都显式返回 `content_truncated`，不会从文件头 replay、无界读取或为了定位大 Task 把沿途 JSON 全部解析。`evidence.locateBytes/sliceBytes/anchor` 只描述本次只读证据定位，不是 Provider request metadata。

`version=2` 增加 `preModelCut` 与 server-assigned `section`。cut 只表示当前 slice 中第一条明确 reasoning / assistant / tool-call model-output evidence 之前的本地记录顺序，不能称为 Provider request start。cut 可证明时，明确的 message/tool-result input evidence 进入 `observed_input`；`turn_context` 只按 model/effort/date/timezone/cwd/workspace/sandbox/approval/personality/collaboration 等固定 allowlist 投影到 `runtime_context`；其余可读模型/工具交互进入 `observed_interaction`。cut 不可证明时不会把整个 slice 强行命名为 Input。

`items` 是稳定语义 projection，不返回原始 JSON envelope。Message/Tool/Tool Result 都按不可信文本处理；Reasoning 只显示 rollout 中明确存在的 public summary，opaque/encrypted reasoning 不返回密文、不解码也不推断 chain-of-thought。相邻且公开 summary 完全一致的 reasoning 由 server projector 合并为一张 semantic item，并用 `occurrenceCount` 保留 evidence；连续无公开 summary 的 reasoning 只能聚合为 `reasoning_activity` record count，不能称为 equivalent。Compaction 只投影为事实性 context signal，不返回 replacement history。若 Tool Result 的 Tool Call 落在前一 Request boundary 之外，仍不跨 boundary 回读旧正文来补工具名，而保留 `callId` 供 UI 识别。响应使用 `Cache-Control: no-store`，正文不写 SQLite、server cache、Session/Day snapshot、SSE 或浏览器持久化存储。

### `GET /api/sessions/:sessionId/requests/:requestId/input-context`

按需返回 **Reconstructed Input Context**。它重建的是本地 rollout 可以证明的同线程历史、explicit compaction snapshot、allowlisted runtime metadata 与当前 Request pre-model evidence，不是 Provider request serialization。`evidence.providerPayloadReconstructed=false` 与 `evidence.providerSerializationKnown=false` 固定保留，即使 `rolloutCoverage="complete_observed_history"` 也不能解释为 Provider Input complete。

客户端只提交 session/request ID，不能提交 path/source/line/byte；任何 query 参数返回 `400`，foreign session 返回 `404`。支持 `GET/HEAD`，响应 `Cache-Control: no-store`。该 path 不进入 Session/Day snapshot、SSE、Timeline 或 Diagnostics，也不触发同步 parser replay。

```json
{
  "version": 1,
  "projectionGeneration": 8330,
  "available": true,
  "request": {
    "requestId": "reqr_...",
    "usage": {},
    "costEstimate": {}
  },
  "evidence": {
    "kind": "reconstructed_input_context",
    "providerPayloadReconstructed": false,
    "providerSerializationKnown": false,
    "rolloutCoverage": "complete_observed_history",
    "sourceSegmentCount": 1,
    "sourceOrdering": "rollout_filename_timestamp",
    "compactionCount": 1,
    "truncated": false
  },
  "reconstructionCut": {
    "status": "observed",
    "kind": "before_first_observed_model_output",
    "sourceKey": "sessions/.../rollout-....jsonl",
    "lineNumber": 481
  },
  "sections": {
    "currentInput": [],
    "runtimeContext": [],
    "historyGroups": [],
    "compaction": [],
    "gaps": []
  },
  "summary": {
    "itemCount": 0,
    "visibleCharacters": 0,
    "sourceSegmentCount": 1,
    "missingSourceCount": 0,
    "compactionCount": 1,
    "truncatedItemCount": 0,
    "historyScanBytes": 0
  }
}
```

source chain 仅来自相同 `rootSessionId + threadId` 的已持久化 portable source evidence，并按 rollout filename timestamp chronology 排序；无法证明唯一顺序时返回 `boundary_ambiguous`，不会使用文件 mtime 猜历史。每个公开 context item 都带 `direct_current / historical_rollout / compaction_snapshot / runtime_context / coverage_gap` provenance。explicit `replacement_history` 会语义化后执行 context rebase；signal-only compaction、source missing、unsupported shape 或 hard-limit truncation 都形成显式 gap，旧历史不会静默补回。

正式 V1 hard limits 为 `16 source segments / 32 MiB history scan / 800 context items / 64 KiB per item / 1 MiB projected characters`。Input/Cached Input Tokens 只作为 Request accounting 对照，不拆分或反推到具体 history/message/tool item。历史正文只在用户第一次点击 Inspector 的 `Input Context` tab 时 lazy fetch，并在 close/session/day switch 时清除。

### `GET /api/sessions/:sessionId/requests/:requestId/context-delta`

按需返回 **Context Delta & Cache Correlation**。默认 comparison pair 固定为当前 canonical Request 与**同 thread immediate previous canonical Request**；顺序由 portable rollout filename timestamp chronology + canonical `origin_line_number` 证明，不能由客户端提交 predecessor，也不按 UI 顺序、mtime 或最近 timestamp 猜测。first Request 返回 `200` + `pair.status="no_predecessor"`；无法唯一证明 chronology 时返回 explicit coverage state，不构造假 pair。

previous/current context 都调用 Phase 26 `readReconstructedInputContext()`；Phase 27 不维护第二套 rollout reconstruction。semantic diff 只比较 message/tool input context 与 Phase 25.1 allowlisted runtime fields，支持 duplicate-aware sequence matching、explicit compaction supersede、signal-only compaction gap、source transition 与 coverage change。Reasoning CoT/encrypted content 不进入 diff。

```json
{
  "version": 1,
  "policyVersion": "request-context-delta-v1",
  "projectionGeneration": 8330,
  "pair": {
    "previousRequestId": "reqr_previous",
    "currentRequestId": "reqr_current",
    "threadId": "thread-id",
    "status": "complete_pair"
  },
  "evidence": {
    "kind": "context_delta_cache_correlation",
    "providerCacheKeyKnown": false,
    "providerSerializationKnown": false,
    "exactCacheCausalityKnown": false,
    "comparisonCoverage": "complete_pair",
    "diffTruncated": false
  },
  "accounting": {
    "previous": { "inputTokens": 100000, "cachedInputTokens": 90000, "cacheHitRate": 0.9, "coverage": "complete" },
    "current": { "inputTokens": 110000, "cachedInputTokens": 85000, "cacheHitRate": 0.772727, "coverage": "complete" },
    "delta": { "inputTokens": 10000, "cachedInputTokens": -5000, "cacheHitRatePoints": -12.7273 }
  },
  "contextDelta": {
    "summary": { "retainedItems": 60, "addedItems": 2, "removedOrSupersededItems": 0, "visibleCharactersDelta": 541 },
    "added": [],
    "removedOrSuperseded": [],
    "runtimeChanges": [],
    "compaction": [],
    "sourceTransitions": [],
    "coverageChanges": []
  },
  "correlationSignals": [],
  "limitations": ["Exact provider cache causality unavailable."]
}
```

Cache Hit Rate 仅按 canonical `cachedInputTokens / inputTokens` 计算，delta 单位固定为 **percentage points (`pp`)**；字段缺失或 `cached > input` 时保持 null/coverage，不补零。correlation signal 只表示同一个 Request pair 上两类证据同时变化，不做 item-level token attribution，也不输出 causal confidence/ranking。`providerCacheKeyKnown=false`、`providerSerializationKnown=false`、`exactCacheCausalityKnown=false` 是固定 truthfulness invariant。

Phase 27 diff hard limits 为 `800 comparable items/side / 200 detailed delta items / 512 KiB projected detail characters / 250,000 diff work units`；超过 work/detail budget 时 `diffTruncated=true`，不会无界 LCS/DOM 展开。接口支持 `GET/HEAD`、`Cache-Control: no-store`，拒绝任何 query 参数；foreign session/request 返回 `404`。response 不包含 absolute path、Raw JSON、replacement history、encrypted reasoning，也不写 SQLite/server cache/browser persistence，不进入 Session/Day snapshot 或 SSE。

### `GET /api/sessions/:id/diagnostics[?day=YYYY-MM-DD]`

按需读取 canonical Request 的确定性 Usage Diagnostics。无 `day` 时分析完整 Session；带 `day` 时仍读取该日之前的同 Session Request 维持 rolling baseline 连续性，但只返回 `observedAt` 落在目标本地自然日的 finding。同一 `requestId + policyVersion` 在 Session/Day scope 下必须保持相同 metric、baseline 与 severity。

该接口只读 SQLite canonical projection，不调用 `selectSession()`、不同步解析 rollout，也不读取 Prompt/Response。若后台已发现 session dirty，接口可以返回上一完整 projection，并通过 `stale=true` 明确 freshness；`projectionGeneration` 可供前端判断已加载 panel 是否需要重新 GET。常规 Session snapshot / SSE 不携带 finding 或 diagnostics summary。

```json
{
  "scope": { "type": "session" },
  "projectionGeneration": 42,
  "stale": false,
  "summary": { "high": 1, "warning": 2, "info": 1 },
  "policy": { "version": "usage-diagnostics-v1", "baselineWindow": 5 },
  "findings": [{
    "findingId": "deterministic-id",
    "type": "cache_regression",
    "severity": "warning",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "requestId": "reqr_...",
    "observedAt": "2026-09-01T08:05:00.000Z",
    "locator": { "requestOrdinalInScope": 25 },
    "metric": {
      "name": "cache_hit_rate",
      "current": 0.5,
      "baseline": 0.9,
      "absoluteDelta": -0.4,
      "relativeDelta": null
    },
    "baseline": {
      "kind": "task_rolling_median",
      "sampleCount": 5,
      "value": 0.9,
      "requestIds": ["reqr_..."]
    },
    "evidence": { "drop": 0.4, "breakpointCandidate": true },
    "policyVersion": "usage-diagnostics-v1"
  }]
}
```

V1 detector 为 Context Inflation、Cache Regression/Breakpoint、Cost Spike 和 Long Context Trigger。Cost Spike 只比较 `estimateRequestCost()` 返回的 `estimated` 金额；`partial/unavailable` 不进入 baseline。Long Context finding 只消费 pricing module 暴露的 `longContextCandidate/longContextStatus`，Diagnostics 不维护第二份 272K 或 rate-card 逻辑。

### `GET /api/sessions/:id/advanced-diagnostics[?day=YYYY-MM-DD]`

按需读取 Phase 24A Historical Robust Diagnostics。该 endpoint 与 Phase 23 `/diagnostics` 完全独立：不修改 `usage-diagnostics-v1` contract，不调用 `selectSession()`，不触发同步 rollout replay，也不进入常规 Session/SSE snapshot。

Historical Request baseline 只比较 exact `projectPath + model + known effort`，最多回看 30 天 / 每 cohort 200 个样本，最少 20 个样本；Cost 还要求同 `serviceTier + rateVersion` 且 pricing `status=estimated`。Cross-session baseline 按 Session Cohort Slice 比较最多 60 天 / 20 个 prior slices，至少 10 个 prior slices；每个 prior Session 同 cohort 只贡献一个 sample。

`day` scope 只返回目标本地自然日内 current Request 的 Historical finding；historical baseline 仍可读取 dayStart 之前的历史，且不会返回 Session-level Cross-session finding。相同 canonical Request 在 Session/Day 下保持同一 finding identity、baseline、metric 与 severity。

```json
{
  "scope": { "type": "session" },
  "projectionGeneration": 42,
  "stale": false,
  "policy": { "version": "advanced-usage-diagnostics-v1", "frozen": true },
  "coverage": {
    "strictCohortSamples": 200,
    "insufficientHistory": 0,
    "unknownEffort": 0,
    "degenerateMad": 0,
    "costIneligible": 0
  },
  "summary": { "high": 1, "warning": 0, "info": 0 },
  "findings": [{
    "findingId": "advanced-diagnostic-...",
    "policyVersion": "advanced-usage-diagnostics-v1",
    "family": "historical",
    "type": "historical_context_inflation",
    "severity": "high",
    "subject": { "kind": "request", "rootSessionId": "...", "requestId": "reqr_..." },
    "cohort": { "projectPath": "...", "model": "gpt-5.6-sol", "effort": "xhigh" },
    "baseline": {
      "kind": "historical_request_robust",
      "sampleCount": 200,
      "median": 136900,
      "mad": 14274.5,
      "robustZ": 5.2,
      "status": "ready"
    },
    "metric": { "name": "input_tokens", "current": 275000 },
    "effect": { "absolute": 138100, "ratio": 2.008, "percentagePoints": null },
    "locator": {
      "threadId": "...",
      "turnId": "...",
      "requestId": "reqr_...",
      "requestOrdinalInScope": 12
    }
  }]
}
```

Robust-Z production threshold 为 warning `|Z|>=3.5`、high `|Z|>=5.0`，但任何 finding 还必须同时通过 detector-specific practical-effect gate；`MAD=0` 返回 `degenerate / robustZ=null`，不会用 epsilon 或 mean/stddev 伪造统计显著性。Cross-session finding 的 `supportingLocator` 只负责进入现有 Canonical Request audit，不参与 finding identity。

### `GET /api/sessions/:id/behavioral-diagnostics[?day=YYYY-MM-DD]`

按需读取 Phase 24B1 Behavioral Diagnostics。该 endpoint 只消费 cached canonical Request projection、Task effort、Agent lineage 与 bounded historical metadata；不调用 `selectSession()`、不同步 replay rollout、不读取 Prompt/Response，也不进入常规 Session/SSE snapshot。

生产 policy 为 `behavioral-usage-diagnostics-v1`，包含三类 detector：

- `reasoning_anomaly`：`reasoningOutputTokens / outputTokens` 相对 exact `projectPath + model + effort` 历史异常；输出过小、effort 未知或历史不足时只计 coverage。
- `request_burst`：同 Session cohort 的 canonical Request 最密集 60 秒窗口，相对 prior Session Slice 的 Robust Baseline；120 秒 idle gap 只作为 episode evidence。
- `subagent_amplification`：同 Session descendant/root canonical total-token ratio，相对 exact-project prior multi-agent Session 历史异常。

`day` scope 只返回目标本地自然日的 request-level Reasoning finding；Burst 与 Amplification 是 Session-level finding，不在 Day scope 返回。相同 Request 在 Session/Day scope 下保持同一 finding identity、baseline、metric 与 severity。

```json
{
  "scope": { "type": "session" },
  "projectionGeneration": 42,
  "stale": false,
  "policy": { "version": "behavioral-usage-diagnostics-v1", "frozen": true },
  "coverage": {
    "reasoningIneligible": 0,
    "unknownEffort": 0,
    "insufficientReasoningHistory": 0,
    "insufficientBurstHistory": 0,
    "insufficientAmplificationHistory": 0,
    "noLineage": 0,
    "degenerateMad": 0
  },
  "summary": { "high": 0, "warning": 1, "info": 0 },
  "findings": [{
    "findingId": "behavioral-diagnostic-...",
    "policyVersion": "behavioral-usage-diagnostics-v1",
    "family": "behavioral_session",
    "type": "request_burst",
    "severity": "warning",
    "baseline": {
      "kind": "historical_session_burst_robust",
      "sampleCount": 13,
      "median": 8,
      "mad": 2,
      "robustZ": 3.71,
      "status": "ready"
    },
    "metric": { "name": "max_requests_in_60_seconds", "current": 19 },
    "effect": { "absolute": 11, "ratio": 2.375, "percentagePoints": null },
    "supportingLocator": {
      "threadId": "...",
      "turnId": "...",
      "requestId": "reqr_...",
      "requestOrdinalInScope": 4
    }
  }]
}
```

Behavioral finding 的 `requestOrdinalInScope` 与 Phase 23/24A 一致，按所属 Task 内 canonical Request 顺序编号，而不是整个 Session 全局编号；因此定位按钮可以复用现有 Task-scoped Canonical Request 分页和 drawer。

### `GET /api/sessions/:id/diagnostic-alerts`

按需物化 Phase 24B2 本机 Alerts。该 endpoint 聚合已经冻结的 Local / Advanced / Behavioral findings，并可追加 Session cost budget alert。它不会发送邮件、Webhook 或任何外部通知，也不会修改 deterministic finding 或 canonical accounting。

默认 policy：Budget disabled、`minimumSeverity="high"`、`cooldownMinutes=60`。Budget 只在 Session `totalCostEstimate.status="estimated"` 且 `amountUsd >= sessionCostBudgetUsd` 时产生 high alert；这里的 USD 始终是 **Subscription Standard-Rate Equivalent**，不是 Plus 实际扣费。

```json
{
  "sessionId": "...",
  "projectPath": "D:\\project",
  "projectionGeneration": 42,
  "stale": false,
  "policy": {
    "sessionCostBudgetUsd": null,
    "minimumSeverity": "high",
    "cooldownMinutes": 60,
    "snoozedUntil": null,
    "updatedAt": null
  },
  "snoozed": false,
  "alerts": [],
  "suppressedBySnooze": 0,
  "acknowledgedCount": 0
}
```

Alerts 使用 `projectionGeneration` scoped deterministic cache；generation 改变会自然 miss，policy/Ack/Snooze 写入会主动失效，内存最多保留 32 个 Session。`stale=true` 仍表示当前 session 有待后台 indexer 收口，不会在 GET 路径同步 replay rollout。

### `POST /api/sessions/:id/diagnostic-alert-policy`

这是 Phase 24B2 明确 allowlist 的本地 operational write。请求体：

```json
{
  "sessionCostBudgetUsd": 25.0,
  "minimumSeverity": "warning",
  "cooldownMinutes": 60
}
```

- `sessionCostBudgetUsd`: `null`/空值表示关闭；否则必须位于 `(0, 1000000]` USD。
- `minimumSeverity`: 仅 `warning` 或 `high`。
- `cooldownMinutes`: `5..1440` 的整数。

policy 按工程 `projectPath` 持久化。该写入只修改 `diagnostic_alert_policies`，不会重算或改写 Token/Cost accounting。

### `POST /api/sessions/:id/diagnostic-alerts/:alertId/ack`

确认当前 Session 中实际存在的 alert。Ack 按 `(rootSessionId, alertId)` 写入 `diagnostic_alert_acknowledgements`；默认 GET 会过滤已 Ack alert，但 `acknowledgedCount` 仍保留。不存在的 alert 返回 `404`。

### `POST /api/sessions/:id/diagnostic-alerts/snooze`

把当前工程 policy 的 `snoozedUntil` 设置为 `now + cooldownMinutes`。Snooze 期间 GET 返回空 `alerts`，并通过 `suppressedBySnooze` 报告被抑制数量；它不删除 finding 或 acknowledgement。

上述三个 POST route 仍受 loopback、Strict Cookie、Host/Origin 校验和 JSON body 限制保护。除此之外的 POST 不被接受。

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

有数据时 `quota` 包含 limit ID/name、plan type、primary/secondary 窗口、观测时间、`source=official-usage-api`、`ageMs` 和 `stale`。超过 5 分钟或时间不可解析时 `stale=true`。若同一 `limitId`、plan、`windowMinutes` 与 `resetsAt` 下的连续官方观测出现 `usedPercent` 回退，运行时 current quota 对该窗口取已观测最大 `usedPercent`，并附加 `reconciled=true`；`resetsAt` 变化后不继承旧窗口最大值。额度不与任务 token 换算；前端把 `usedPercent` 转成 `100 - usedPercent` 的剩余比例展示。

传入 `GET /api/quota?refresh=1` 会立即读取当前 Codex home 的全局配置/ChatGPT file auth，并查询 Codex 官方 Usage endpoint。默认 ChatGPT 基址规范化为 `https://chatgpt.com/backend-api/wham/usage`；非 `/backend-api` 的自定义 Codex 基址使用 `/api/codex/usage`。服务启动时查询一次，之后每 60 秒自动查询；手动刷新与后台查询共享同一个 in-flight 请求。该请求不是模型调用，也不会制造 Task/Token 用量。认证或网络不可用时显式刷新返回 `503` 与脱敏错误；后台失败不阻断本地用量监控，并保留最后一次成功的官方额度。

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
