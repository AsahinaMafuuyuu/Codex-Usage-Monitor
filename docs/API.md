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

`q` 可选，按当前只读索引中的标题、session ID 和 source 做本地包含搜索。数据库不持久化标题。

### `GET /api/sessions/:id`

选择并解析根会话，返回一个 snapshot：

```json
{
  "session": {},
  "agents": [{
    "tasks": [],
    "ownCostEstimate": {},
    "subtreeCostEstimate": {}
  }],
  "summary": {
    "agentCount": 0,
    "taskCount": 0,
    "activeTasks": 0,
    "totalUsage": {},
    "subagentUsage": {},
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

每个 `agents[].tasks[]` 任务包含 rollout 的 `model`、`effort` 以及运行时派生的 `costEstimate`：

```json
{
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

`costEstimate.status` 为 `estimated` 或 `unavailable`；不可估算时 `amountUsd=null` 并给出 `reason`。`pricing` 返回本地价目表版本、抓取/复核日期、官方来源、支持模型和是否待复核。金额是当前标准 API 短上下文等值，不是 Codex 订阅扣费，也不包含无法从 rollout 证明的长上下文、服务层级、区域或工具费用。

每个智能体的 `ownCostEstimate` 只合计自己的任务，`subtreeCostEstimate` 递归包含全部后代。`summary.totalCostEstimate` 合计主智能体和所有后代，`summary.subagentCostEstimate` 只合计非根智能体。四类摘要均返回 `estimatedTasks` 和 `unavailableTasks`：全部可计算为 `estimated`，混合覆盖为 `partial`，没有可计算任务为 `unavailable`。`partial.amountUsd` 只是已知任务的下限；页面用 `≥` 显示，不把它冒充完整总额。

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

按数据库中保存的来源位置读取原始 rollout，并返回最多 120 字的确定性指令预览。响应区分 `available`，源日志消失时不会回退到数据库内容，因为正文从未被持久化。

客户端不能传入文件路径；路径只能从已存在任务记录解析。

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
