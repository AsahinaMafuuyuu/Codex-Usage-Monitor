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
| `400` | ID 格式无效 |
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

返回全部已发现根 session 的本地日期用量账页。schema v10 会先按 portable `source_key` 匹配各 root session 的持久化 task/cursor/Request Ledger 状态：从未导入或尚未完成 schema v9 Request Ledger backfill 的历史才完整解析；可信的 append-only cursor 只读取新增字节；无变化的 session 不读取 rollout 正文。同步完成后，接口从 SQLite `session_day_usage` 物化索引生成 request-derived 响应。v9→v10 只重建已有 Request Ledger 的 Agent/Calendar 派生 aggregate，不因事实源切换重新读取 rollout。

该同步只写监控器自己的派生 SQLite（task、cursor、session-day aggregate），从不修改 `.codex`。Timeline 后台补齐不会把历史 rollout 中的全部 quota 快照批量归档；账号额度仍由现有 latest-quota/实时路径维护。cursor 不可信、文件收缩或持久化状态不足时，parser 会回退到原有安全 replay 规则。

```json
{
  "generatedAt": "2026-08-25T03:22:56.706Z",
  "timezone": "Asia/Shanghai",
  "usage": { "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0, "totalTokens": 0 },
  "modelRequestCount": 0,
  "tokensPerModelRequest": null,
  "qualityCounts": { "complete": 0, "provisional": 0, "estimated": 0, "partial": 0, "discontinuity": 0, "unknown": 0 },
  "months": [{
    "key": "2026-08",
    "usage": {},
    "modelRequestCount": 0,
    "tokensPerModelRequest": null,
    "taskCount": 0,
    "activeTaskCount": 0,
    "qualityCounts": {},
    "days": [{
      "key": "2026-08-24",
      "usage": {},
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

`months` 和 `days` 均按 key 降序排列；页面用原生 `details` 展开月份、日期和当天 session。日期 key 仍按任务 `startedAt` 的本地时区生成。`usage` 只累加 Request Ledger 中已验证且已归属 task 的 usage；同 task 存在 unverified/anomaly 时只保留已验证部分并以 `partial` 披露，不使用 Boundary delta 补齐。`modelRequestCount` 只统计 verified model usage units，`tokensPerModelRequest=usage.totalTokens/modelRequestCount`；它们不保证与 HTTP 请求或服务端计费请求一一对应。没有可归入本地日期的任务进入 `unattributed`。

该接口的 total token 是本地 rollout 的审计汇总，不是 Codex 个人资料的订阅账单字段。个人资料可能采用不同的服务端时间边界、未公开的请求级计费口径或包含本地无法证明的记录；二者只应比较量级和质量覆盖，不应要求逐字相等。

### `GET /api/sessions/:id`

选择并解析根会话，返回一个 snapshot：

```json
{
  "session": { "projectPath": "C:\\workspace\\example" },
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

每个 `agents[].tasks[]` 任务的主 `deltaUsage` 来自 Request Ledger，并保留 Boundary Ledger 审计字段；同时包含 rollout 的 `model`、`effort` 以及运行时派生的 `costEstimate`：

```json
{
  "usageSource": "request_ledger",
  "requestCount": 1,
  "tokensPerModelRequest": 12345,
  "requestLedgerCoverage": { "verified": 1, "duplicate": 0, "unverified": 0, "anomaly": 0 },
  "boundaryQuality": "complete",
  "boundaryDeltaUsage": {},
  "model": "gpt-5.6-terra",
  "effort": "xhigh",
  "costEstimate": {
    "status": "estimated",
    "amountUsd": 0.012345,
    "currency": "USD",
    "basis": "openai-standard-api-short-context",
    "catalogVersion": "2026-08-24",
    "catalogStale": false,
    "pricedModel": "gpt-5.6-terra",
    "ratesPerMillion": {},
    "components": {},
    "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    "limitations": [],
    "reason": null
  }
}
```

`boundaryDeltaUsage` / `boundaryQuality` 是迁移期审计证据，不参与页面主汇总、费用或缓存命中率 fallback。若 task 同时包含 verified 与 unverified/anomaly 事件，主 `deltaUsage` 只保留 verified 部分并以 `partial` 标记；Boundary 值即使看似完整也不会被混入。

`costEstimate.status` 为 `estimated` 或 `unavailable`；不可估算时 `amountUsd=null` 并给出 `reason`。`pricing` 返回本地价目表版本、抓取/复核日期、官方来源、支持模型和是否待复核。金额是当前标准 API 短上下文等值，不是 Codex 订阅扣费，也不包含无法从 rollout 证明的长上下文、服务层级、区域或工具费用。

每个智能体的 `ownCostEstimate` 只合计自己的任务，`subtreeCostEstimate` 递归包含全部后代。`summary.totalCostEstimate` 合计主智能体和所有后代，`summary.subagentCostEstimate` 只合计非根智能体。四类摘要均返回 `estimatedTasks` 和 `unavailableTasks`：全部可计算为 `estimated`，混合覆盖为 `partial`，没有可计算任务为 `unavailable`。`partial.amountUsd` 只是已知任务的下限；页面用 `≥` 显示，不把它冒充完整总额。

页面从 request-derived `summary.totalUsage` 计算完整会话输入、输出和缓存命中率，从 `agents[].ownUsage` 与 `tasks[].deltaUsage` 计算对应层级命中率。统一公式为 `cachedInputTokens / inputTokens`；费用估算也消费同一套 request-derived 六字段 token。`requestCount` / `modelRequestCount` 和 `tokensPerModelRequest` 只由 verified model usage units 派生。

这是有状态选择操作，但不写 `.codex`；它只更新监控器自身的解析范围和派生 SQLite。

### `GET /api/sessions/:id/events`

为已选择的会话打开 `text/event-stream`。连接后立即发送 `snapshot`，随后可能发送：

| SSE event | data |
|---|---|
| `snapshot` | 当前会话完整 snapshot |
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

有数据时 `quota` 包含 limit ID/name、plan type、primary/secondary 窗口、观测时间、来源路径、`ageMs` 和 `stale`。超过 5 分钟或时间不可解析时 `stale=true`。额度不与任务 token 换算。

### `GET /api/health`

```json
{ "health": { "status": "healthy", "observerMode": "rollout-file-observer" } }
```

完整对象还包含当前选择、监听状态、最后更新时间、repository 摘要、storage 统计、parser 健康及最近最多 5 条错误。Parser 健康会报告坏行、unknown/skipped records、discontinuity、partial bytes，以及本次恢复/全量回放的文件数。路径信息只对已认证本地用户可见。

## 兼容性

API 当前随 `0.x` 版本演进，不承诺跨次要版本稳定。增加字段视为兼容；重命名、删除字段或改变安全/隐私语义必须更新 ADR、测试、README、本文档和 CHANGELOG。
