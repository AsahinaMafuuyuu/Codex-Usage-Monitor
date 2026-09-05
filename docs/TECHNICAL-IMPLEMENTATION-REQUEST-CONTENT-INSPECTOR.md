# Phase 25：Request Content Inspector 技术实施方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**设计事实源：** [DESIGN-REQUEST-CONTENT-INSPECTOR.md](DESIGN-REQUEST-CONTENT-INSPECTOR.md)  
**架构决策：** [ADR-0030](decisions/0030-read-through-request-content-inspector.md)

## 1. 实施原则

Phase 25 必须以“新增只读深模块 + lazy endpoint + 单一 Dialog”实现，不重构 canonical Request accounting。

目标数据流：

```text
Canonical Request row
  -> durable origin locator
  -> resolve active source path
  -> determine previous/current request boundary
  -> bounded JSONL scan
  -> semantic content projector
  -> GET /requests/:requestId/content
  -> ephemeral Request Inspector Dialog
```

实施期间禁止：

- 给 `canonical_requests` 新增正文列；
- 把 rollout record JSON 直接返回 UI；
- 在初始 Session/Day payload 中 eager load content；
- 通过浏览器持久化缓存正文；
- 修改 Request Ledger、ownership、pricing、diagnostics detector。

## 2. 预计修改范围

### 新增

```text
src/request-content.js
test/request-content.test.js
docs/DESIGN-REQUEST-CONTENT-INSPECTOR.md
docs/TECHNICAL-IMPLEMENTATION-REQUEST-CONTENT-INSPECTOR.md
docs/DELIVERY-REQUEST-CONTENT-INSPECTOR.md
docs/decisions/0030-read-through-request-content-inspector.md
```

### 修改

```text
src/database.js
src/monitor.js
src/server.js
public/app.js
public/styles.css
scripts/verify-live-ui.js
test/database-server.test.js
test/ui-security.test.js
docs/API.md
docs/ARCHITECTURE.md
docs/ROADMAP.md
docs/VERIFICATION.md        # 仅实施并真实验证后写 delivered evidence
CHANGELOG.md                # 仅用户可见实现完成后更新
tasks/plan.md
```

V1 不应修改 `src/request-ledger.js`、`src/request-identity.js`、`src/request-ownership.js`、`src/pricing.js` 的核心语义。

## 3. Database seam

### 3.1 新增只读 locator query

建议在 `MonitorDatabase` 增加窄 interface：

```js
getCanonicalRequestContentLocator(rootSessionId, requestId)
```

一次查询返回：

```js
{
  requestId,
  rootSessionId,
  threadId,
  turnId,
  observedAt,
  sourceKey,          // canonical_requests.origin_source_key
  lineNumber,         // canonical_requests.origin_line_number
  eventOrdinal,
  model,
  serviceTier,
  pricingContextQuality,
  usage,
  identityKind,
  nativeField,
  previousBoundary: {
    requestId,
    sourceKey,
    lineNumber
  } | null,
  task: {
    sequence,
    effort,
    startLine,
    endLine,
    sourceKey
  }
}
```

`previousBoundary` 只允许从**同 root + thread + turn + origin_source_key** 的前一 canonical Request 获取。排序优先使用当前业务稳定顺序 `(observed_at, request_id)`，同时要求 previous origin line `< current origin line`；出现排序/line 冲突时返回 `boundary_ambiguous`，不猜。

### 3.2 不新增 schema

读取只使用已有：

- `canonical_requests`；
- `tasks`；
- `idx_canonical_requests_task_observed` 或等价现有索引。

如果 query plan 证明需要额外**只读索引**，必须先 benchmark 再决定；第一选择是不升级 schema。

## 4. Source resolution

Monitor 层通过既有：

```js
this.repository.resolveSourceKey(locator.sourceKey)
```

重新绑定当前机器的 rollout path。

客户端永远不能传：

- source path；
- source key；
- line number；
- byte offset。

这些全部由 `requestId` 的 canonical evidence 在服务端解析，避免形成任意文件读取 interface。

## 5. `src/request-content.js` 深模块

### 5.1 External interface

建议：

```js
export async function readRequestContent({
  sourcePath,
  locator,
  limits = REQUEST_CONTENT_LIMITS,
})
```

返回 immutable/plain projection；异常文件状态转为结构化 unavailable reason，只有真正程序错误才 throw。

### 5.2 Limits

Draft policy：

```js
export const REQUEST_CONTENT_LIMITS = Object.freeze({
  maxWindowBytes: 12 * 1024 * 1024,
  maxScanBytes: 24 * 1024 * 1024,
  maxSliceBytes: 4 * 1024 * 1024,
  maxRecords: 500,
  maxItemCharacters: 64 * 1024,
  maxPayloadCharacters: 512 * 1024,
});
```

最终值已由真实 rollout coverage audit + benchmark 冻结。`maxWindowBytes` 是单侧 locator window；`maxScanBytes` 是 start/end locator 总读取预算；`maxSliceBytes` 才是真正进入 JSON parse/projector 的 Observed Interaction Slice 上限。

### 5.3 Boundary calculation

```text
same-source previous canonical request exists
    startLine = previous.lineNumber + 1

otherwise task.sourceKey == current.sourceKey && task.startLine known
    startLine = task.startLine

otherwise
    boundary coverage degraded / unavailable

endLine = current canonical origin_line_number
```

Scanner 必须验证 end record 确实是与当前 locator 相容的 `event_msg/token_count` evidence；若 source 已被重写导致 locator 不再成立，返回 `source_changed`，不能悄悄读取别的行。

### 5.4 Scan strategy

实际实现利用 schema v15 已有 Task locator：`tasks.start_byte/start_line/end_byte/end_line`，但把“定位”和“正文解析”分开：

1. 以 `256 KiB` 小块从 Task start 或 Task end 读取，**只搜索 `\n`**，将目标 `origin_line_number`、previous canonical boundary 与 Task anchor 映射成精确 byte range；沿途不做 `JSON.parse`。
2. 第一条 Request 只能使用 Task start anchor；后续 Request 可使用 start/end 双 anchor。优先顺序由 line distance 决定，首侧窗口无法覆盖时在 `maxScanBytes` 总预算内尝试另一侧。
3. locator 成功后，只读取 `previousBoundary.endByte -> currentBoundary.endByte` 的真实 Observed Interaction Slice；若 slice 超过 `maxSliceBytes=4 MiB`，直接返回 `content_truncated`，不把巨型 Tool Result/记录交给 JSON parser。
4. Task anchor、previous/current `token_count` line 单独重读并验证，source 已被改写时返回 `source_changed`。

因此大 Task 中“目标 Request 距 Task 起点很远”不再等价于正文不可读，也不会为了定位目标行把 12–24 MiB 沿途 JSON 全部解析。正式 coverage audit：`30,201` canonical Requests 中 source-present=`29,807`、boundary ambiguous=`0`、按当前 policy 可读=`29,801`（`99.97987%` of source-present）；6 条 oversized slice 显式 truncate，394 条历史 source missing。production-equivalent benchmark：最终 default common P95=`1.683ms`、真实最重双-anchor fallback P95=`63.370ms`、3.865 MiB 可投影 slice P95=`49.776ms`，全部低于 `<100ms / <250ms` Gate。

## 6. Record projector

所有 record parser 都放在 `request-content.js` 内部，避免 `public/app.js` 理解 rollout wire shape。

建议内部 dispatcher：

```js
projectRecord(record)
  -> projectMessage(...)
  -> projectToolCall(...)
  -> projectToolResult(...)
  -> projectReasoningSummary(...)
  -> projectContextSignal(...)
  -> null
```

### 6.1 Messages

支持已经在真实 fixture/rollout 中证明的 `response_item/message`、`agent_message` 等文本 content shape。多段 `input_text/output_text/text` 合并时保留原顺序。

### 6.2 Tool Call

不要返回 `argumentsJson` 字符串作为主 UI contract。Server projector 尝试把已知 arguments 解为 plain object，然后转换为：

```js
fields: [
  { label: "Command", value: "git log ...", format: "code" },
  { label: "Working directory", value: "D:\\...", format: "text" }
]
```

未知字段使用原 key 作为 label，但值只允许 JSON primitive / bounded text / nested summary。前端不需要实现通用 JSON viewer。

### 6.3 Tool Result

尽可能解析已有 tool name / call id relation，但 `call_id` 只用于当前内容展示关联，**不得升级为 model Request identity**。

输出字段可包含：

```js
{
  kind: "tool_result",
  tool,
  callId,
  status,
  exitCode,
  text,
  lineCount,
  truncated
}
```

### 6.4 Reasoning

只投影明确存在的 summary 文本字段。opaque/encrypted/no-text 只生成 metadata signal，不返回内部二进制/密文，也不做解码尝试。

## 7. Monitor interface

新增：

```js
async requestContent(sessionId, requestId)
```

步骤：

1. DB 验证 request 属于 session；
2. 获取 request + task + previous boundary locator；
3. repository resolve source；
4. 调 `readRequestContent()`；
5. 复用 `estimateRequestCost()` 给 header metadata；
6. 返回 projection。

Monitor 不维护正文 LRU cache。

## 8. HTTP interface

新增：

```text
GET /api/sessions/:sessionId/requests/:requestId/content
```

### 8.1 Success

```js
{
  request: {...},
  evidence: {...},
  summary: {...},
  items: [...]
}
```

### 8.2 Unavailable source

Request 存在但源内容不可读时建议仍返回 `200`：

```js
{
  available: false,
  reason: "source_missing",
  request: {...},
  items: []
}
```

原因是“Request 存在”与“正文证据当前可读”是两个事实。只有 request 不属于 session 才 `404`。

### 8.3 Validation

- 仅 GET/HEAD；
- session/request ID 继续使用现有 ID validator；
- 不接受 path/line/source query；
- no-store；
- 统一 error boundary；
- response 不包含绝对 source path。

## 9. Frontend state

建议在 `state` 增加：

```js
requestInspector: {
  open: false,
  requestId: null,
  loading: false,
  error: null,
  payload: null,
  selectionVersion: 0,
  projectionGeneration: null
}
```

这是**单对象临时状态**，不是 `Map<requestId, content>`。

关闭 Dialog 时：

```js
state.requestInspector.payload = null;
state.requestInspector.requestId = null;
```

切换 session/day 同样清空。

## 10. Frontend event flow

Request row：

```html
<button data-request-inspect="reqr_...">查看</button>
```

事件：

```text
click 查看
  -> open Dialog skeleton immediately
  -> fetch content
  -> selectionVersion guard
  -> render semantic items

close / Escape / session switch
  -> abort or ignore stale fetch
  -> drop payload
```

可以使用 `AbortController` 取消已经无意义的 read response；即使取消失败，selectionVersion 也必须阻止旧 payload 写入新 Dialog。

## 11. Dialog DOM 设计

推荐一个静态 `<dialog id="request-inspector">` 放在 `index.html`，内容由 `app.js` patch。

必须支持：

- `showModal()` / `close()`；
- Escape；
- close button；
- focus restore 到触发“查看”的按钮；
- `aria-labelledby` / `aria-describedby`；
- body 内独立纵向滚动；
- Tool output 内部可折叠，不制造 nested horizontal page scroll；
- 720px 下近 full-screen；
- `prefers-reduced-motion`。

Dialog 打开期间 SSE reconcile 不应替换 dialog root DOM。

## 12. Rendering contract

新增 renderer 建议：

```js
renderRequestInspector(payload)
renderRequestInspectorHeader(request, evidence)
renderRequestContentItem(item)
renderToolCallCard(item)
renderToolResultCard(item)
renderReasoningSummary(item)
```

所有动态字符串都经过 `escapeHtml()`；code block 也只是 escaped `<pre><code>`。

不得：

- `innerHTML = rawToolOutput`；
- Markdown 的 raw HTML passthrough；
- 根据 Tool output 自动创建 `<a href>`；
- 把 unknown object `JSON.stringify()` 后作为默认 UI。

## 13. 测试实施顺序

### P25-1：Evidence boundary fixture

先写 `test/request-content.test.js`：

- first Request boundary；
- second Request 从 previous token_count 后开始；
- message + assistant + tool call + result；
- duplicate/non-canonical raw event 不改变 canonical slice locator；
- source mismatch / line mismatch；
- unknown record；
- large output truncation；
- opaque reasoning；
- malformed JSON line partial coverage。

### P25-2：DB locator

覆盖：

- request/session ownership；
- previous same-source boundary；
- first request fallback task boundary；
- cross-source ambiguity；
- query 不返回正文/absolute path。

### P25-3：Monitor/API

覆盖：

- authenticated GET；
- request 不属于 session -> 404；
- source missing -> 200 unavailable；
- POST -> 405；
- no path injection；
- no-store；
- payload bounded；
- server 不记录正文。

### P25-4：UI

覆盖：

- `详情/查看` 列；
- one global dialog；
- loading/error/unavailable/truncated；
- Tool Card semantic fields；
- no raw JSON viewer；
- XSS escape fixture；
- close clears content；
- session/day switch clears content；
- focus restore；
- SSE keeps open dialog stable；
- 1440×900 / 720×900。

### P25-5：Read-only / performance

- `.codex` manifest before/after identical；
- SQLite schema/user_version unchanged；
- canonical Request count / six token fields / known cost unchanged；
- common P95 / near-limit P95；
- Inspector endpoint 不调用 `selectSession()` / parser replay / diagnostics analyzer。

## 14. 实施阶段

### Phase 25A：Content Projection Core（已完成）

1. ADR/design freeze；
2. request-content fixtures；
3. DB locator query；
4. source resolve + bounded scanner；
5. semantic projector；
6. Monitor/API；
7. unit/API/security/read-only gates。

### Phase 25B：Request Inspector UI（已完成）

1. Canonical Requests `详情` column；
2. static dialog shell；
3. ephemeral state/fetch lifecycle；
4. semantic cards；
5. loading/error/truncation/evidence states；
6. SSE/focus/scroll stability；
7. desktop/narrow browser QA。

### Phase 25C：Delivery Freeze（已完成）

1. real rollout representative audit；
2. performance benchmark；
3. accounting + source manifest reconciliation；
4. API/Architecture/README/CHANGELOG/VERIFICATION 更新；
5. Delivery checklist 全部实际通过后，才能把状态改为 `Implemented / Verified`。

## 15. 风险与控制

| 风险 | 控制 |
|---|---|
| 把 Observed Slice 错称 Provider Request | UI/API evidence label + ADR 禁止该表述 |
| 大 Tool Result 导致页面卡顿 | bounded scan、单 item/总 payload 截断、折叠渲染 |
| rollout 正文 XSS | 全量 escape，不执行 HTML/链接 |
| source path 任意读取 | endpoint 只接 sessionId/requestId，source locator 服务端解析 |
| 正文泄漏到 SQLite/缓存 | no schema、no LRU、close clear、no browser persistent storage |
| SSE 把 modal 刷掉 | static dialog root + independent inspector state |
| legacy/cross-source boundary 猜错 | ambiguity -> unavailable/coverage degraded，不猜 |
| reasoning 误作完整 CoT | 只展示明确 summary，opaque record 只显示存在性 |

