# Phase 25：Request Content Inspector 设计方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**前置基线：** Phase 18–24 已建立 canonical Request、Request audit、Diagnostics locator 与只读 rollout source locator  
**相关决策：** [ADR-0003](decisions/0003-metadata-only-persistence.md)、[ADR-0014](decisions/0014-portable-source-locators.md)、[ADR-0020](decisions/0020-canonical-request-ownership-and-projections.md)、[ADR-0022](decisions/0022-independent-task-request-audit-navigation.md)、[ADR-0030](decisions/0030-read-through-request-content-inspector.md)

## 1. 背景

当前 `Canonical Requests` 已经能够逐 Request 展示：

- observed time；
- Input / Cached / Cache Write / Output / Reasoning / Total；
- Cache Hit Rate；
- model / effort / service tier；
- Subscription Standard-Rate Equivalent；
- Diagnostics marker 与精确 locator。

这些信息回答了“这次 Request 花了多少、是否异常”，但还不能回答：

> “这一次 Request 在会话里实际发生了什么？”

真实 rollout 中，一个 Task 往往包含多次 model Request，并在连续 `token_count` 之间穿插 `message`、`reasoning`、`custom_tool_call`、`custom_tool_call_output` 等 record。因此用户需要一个 **Request-level 内容阅读器**，把原始事件转换成可读的交互过程，而不是要求用户阅读 JSONL。

## 2. 核心目标

Phase 25 提供 **Request Content Inspector**：

1. 在 Canonical Requests 表增加轻量“查看”入口；
2. 点击后按需读取该 canonical Request 对应的原始 rollout；
3. 以相邻 Request 计量边界构造本次 **Observed Interaction Slice**；
4. 将消息、Tool Call、Tool Result、可公开的 reasoning summary、compaction/context signal 转为语义化展示；
5. 使用通用、可访问的 Dialog 展示，而不是 Raw JSON；
6. 不把正文写入 SQLite、日志、浏览器持久化存储或长期内存缓存；
7. 不改变 canonical Request、Token、Cost、Diagnostics 或 Timeline 的任何 accounting 语义。

## 3. 非目标

Phase 25 V1 **不**承诺以下能力：

- 不声称恢复 Codex 最终发送给 Provider 的 HTTP/Responses wire payload；
- 不声称精确重建 system/developer/history/compaction 后的最终序列化上下文；
- 不把 `inputTokens` 拆成“历史继承 token / 本次新增 token”，除非未来存在可证明的 provider serialization evidence；
- 不新增 prompt/response 正文持久化；
- 不提供 Raw JSON 模式；
- 不解密、推断或重建未显式记录的内部 chain-of-thought；
- 不让 Request Content 进入 Session snapshot、Timeline、SSE 或 Diagnostics 热路径；
- 不改变 Request identity / ownership / request-day / pricing projection。

## 4. 术语与证据边界

### 4.1 Canonical Request

`canonical_requests.request_id` 仍是唯一业务 Request identity。它的 `origin_source_key + origin_line_number` 是该 Request 的原始计量 evidence locator。

### 4.2 Observed Interaction Slice

V1 展示的“Request 内容”正式定义为：

> 从上一条同 Task、同 source 的 canonical Request `token_count` 边界之后，到当前 canonical Request origin `token_count` 边界为止，在 rollout 中实际记录到的交互事件集合。

第一条 Request 没有前序 canonical Request 时，起点退化为当前 Task 在同 source 上可证明的开始位置；若 Task locator 与 Request source 无法安全对齐，则使用当前 source 内可证明的最小边界并返回 coverage 降级，禁止跨 source 猜测正文。

这一 slice 可以可靠说明“从上一次计量完成到本次计量完成之间发生了哪些可观察交互”，但它不是 Provider payload。

### 4.3 Provider Payload

UI 与 API 必须明确：

```text
Provider Payload: unavailable / not reconstructed
Evidence: local rollout observed interaction
```

除非未来 Codex 提供官方、稳定、可验证的 serialized request evidence，否则不得把 Inspector 标为“完整模型请求”“完整 prompt”或“Provider Request Body”。

## 5. 为什么使用 Request boundary，而不是单条 message

真实 rollout 已验证存在如下序列：

```text
message / reasoning / assistant message / tool call / tool result
token_count  <-- Request A accounting boundary

reasoning / assistant message / tool call / tool result
token_count  <-- Request B accounting boundary
```

因此：

- Task 太粗：一个 Task 可包含几十次模型 Request；
- 单条 message 太细：一次模型交互可能同时输出 assistant text 与 tool call；
- `token_count` 与当前 canonical Request accounting 已经建立一一计量语义。

相邻 canonical Request boundary 是当前项目中最稳定、最符合既有事实模型的内容切片 seam。

## 6. 数据来源与只读路径

Phase 25 不新增正文表。读取链固定为：

```text
requestId
  -> canonical_requests
       request identity / usage / model / tier
       origin_source_key / origin_line_number
  -> tasks
       turnId / effort / source locator
  -> repository.resolveSourceKey(origin_source_key)
  -> current .codex rollout path
  -> bounded read-only scan
  -> Request Content Projection
  -> authenticated local GET
  -> ephemeral Dialog
```

任何一步无法证明时返回明确 `available=false / coverage`，不能回退为“去数据库找正文”，也不能读取相邻未知 source 猜内容。

## 7. Request Content Projection

建议新增独立深模块：

```text
src/request-content.js
```

外部 interface 保持窄：

```js
readRequestContent({ request, task, previousBoundary, sourcePath, limits })
```

调用者不需要知道 rollout record type、message content shape、tool 参数格式、截断策略或边界扫描细节。

### 7.1 Public projection shape

V1 建议返回：

```js
{
  available: true,
  evidence: {
    kind: "rollout_observed_interaction",
    providerPayloadReconstructed: false,
    sourceKey,
    startLine,
    endLine,
    complete: true,
    truncated: false
  },
  request: {
    requestId,
    observedAt,
    model,
    effort,
    serviceTier,
    usage,
    costEstimate
  },
  items: [
    { kind: "message", role: "user", text: "..." },
    { kind: "tool_call", tool: "exec", fields: [...] },
    { kind: "tool_result", tool: "exec", text: "...", exitCode: 0 },
    { kind: "assistant_message", text: "..." },
    { kind: "reasoning_summary", text: "..." },
    { kind: "context_signal", signal: "compacted", label: "Context compacted" }
  ],
  summary: {
    observedItemCount,
    messageCount,
    toolCallCount,
    toolResultCount,
    reasoningSummaryCount
  }
}
```

`items` 是 UI contract，不暴露整个原始 record envelope。

### 7.2 Unknown record policy

未知但位于 slice 内的 record 不应直接 JSON dump。V1：

- 已知、可安全语义化：投影为对应 item；
- 已知但与用户阅读无价值：忽略并增加内部计数；
- 未知且可能影响解释：返回 `context_signal` 或 coverage warning，例如“1 个未识别交互记录未展示”；
- 永远不把未知 JSON 原封不动塞进 DOM。

## 8. 内容分类与 UI 语义

### 8.1 Message

以角色和正文展示：

```text
User
检查当前 Request 的缓存命中情况……
```

`developer` / `system` 只有在 rollout slice 中明确存在时才显示；不得根据模型行为反推。

### 8.2 Assistant Message

显示本次交互中明确记录的 assistant text。若该 Request 只产生 Tool Call，没有自然语言输出，则显示“本次模型输出为 Tool Call，无独立文本消息”。

### 8.3 Tool Call

使用通用 Card，而不是 JSON：

```text
Tool · exec

Command
git log --oneline -n 20

Working directory
D:\web_project2\codex-usage-monitor
```

通用 projector 将对象参数转换为有序 key/value field；嵌套对象可以折叠显示。未知工具仍可使用：

```text
Tool · <tool-name>
Arguments · 4 fields
```

### 8.4 Tool Result

默认显示结果摘要与首段正文：

```text
Result · exec
Exit 0 · 20 lines
[展开完整结果]
```

超长结果按明确字符/字节上限截断，并显示“内容已截断”，绝不能静默截断。

### 8.5 Reasoning

V1 只显示 rollout 中**明确可公开读取的 reasoning summary / summary text**。对于 opaque、encrypted 或没有公开文本的 reasoning record：

```text
Reasoning
本次记录存在 reasoning，但没有可展示摘要。
```

不得尝试解密或推断内部 chain-of-thought。

### 8.6 Context / Compaction signal

若 slice 中存在 `compacted`、context-related signal，可展示事实性状态：

```text
Context
检测到一次 context compaction 记录
```

但不能因此推导“压缩了多少 token”或“Provider 最终上下文是什么”，除非 record 自身提供可证明字段。

## 9. UI 设计

### 9.1 Request 表入口

`Canonical Requests` 最右侧新增轻量 `详情` 列：

```text
诊断 | 详情
  2  | 查看
```

不要让整行变成点击目标，避免和横向滚动、文本选择、Diagnostics locator 冲突。

### 9.2 Dialog

使用单一全局 Dialog，而不是每行创建一个 modal DOM：

```text
┌──────────────── Request #N ────────────────────────────────┐
│ 时间 · Model · Effort · Tier                              │
│ Input · Cached · Hit Rate · Output · Total · USD          │
│ Evidence: Rollout observed interaction                    │
├────────────────────────────────────────────────────────────┤
│ Interaction                                                │
│                                                            │
│ User / Developer message                                   │
│ Tool Result                                                │
│ Assistant message                                          │
│ Tool Call                                                  │
│ Reasoning summary (collapsed by default)                   │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ Context structure / Evidence                               │
└────────────────────────────────────────────────────────────┘
```

桌面建议约 `min(1120px, 90vw)` 宽、`min(820px, 86vh)` 高；窄屏改为接近 full-screen，不依赖固定像素宽度。

### 9.3 信息层级

默认阅读顺序固定：

1. Request summary；
2. Evidence label；
3. Observed interaction；
4. 折叠 reasoning / large tool output；
5. Context/evidence details。

V1 不提供 Raw JSON tab。

### 9.4 交互状态

- 同一时刻只打开一个 Inspector；
- 打开期间浏览器只在内存持有当前 payload；
- close、切换 session 或切换 day 后立即释放正文对象；
- 不写 `localStorage`、`sessionStorage`、IndexedDB；
- SSE snapshot 不关闭 Dialog；如果当前 `projectionGeneration` 变化，只标记“数据可能已更新”，用户触发 refresh 时重新按 requestId 读取；
- Diagnostics locator 与 Inspector 共用同一 canonical Request row identity，不新增第二套 request list。

## 10. 安全与隐私

### 10.1 Persistence

严格禁止新增：

- Prompt/Response/message body SQLite columns；
- Request content cache table；
- server disk cache；
- browser persistent cache；
- request content telemetry/logging。

允许的唯一正文生命周期是：

```text
source rollout -> bounded server memory -> authenticated response -> open Dialog memory
```

请求结束/Dialog 关闭后不应保留长期副本。

### 10.2 HTTP

新 endpoint 只允许认证后的 local `GET`/`HEAD`，沿用：

- loopback；
- Strict Cookie；
- Host / Origin validation；
- CSP；
- `Cache-Control: no-store`；
- ID allowlist；
- request/response size boundary。

不得因为 Inspector 增加新的 POST、文件路径参数或任意 source path 参数。

### 10.3 XSS

rollout 正文、Tool 参数和 Tool Result 全部视为不可信文本。UI 必须统一 HTML escape；V1 不渲染任意 HTML/Markdown HTML，不执行 tool output 中的链接或 script。

## 11. Bounded read 与性能

Request Inspector 是用户主动 drill-down，不需要进入 `<150ms` 的常规 snapshot 热路径，但必须有硬边界。

V1 已冻结 limits：

- 单侧 locator 窗口：`12 MiB`；
- 双侧 locator 总预算：`24 MiB`；
- 实际 Observed Interaction Slice：`4 MiB`；
- 最大 record：`500`；
- 单个正文 item 最大：`64 KiB`；
- 单次公开 payload 正文总量目标：`<= 512 KiB`；
- 超限返回 `truncated=true` + 明确 omitted counts/bytes。

实现复用了既有 Task `start_byte/start_line/end_byte/end_line` locator：locator 阶段只在 Task 起点/终点的 bounded window 内统计 JSONL 换行并定位目标 line 的精确 byte range，不解析沿途正文；定位成功后只解析相邻 canonical boundary 之间的真实 interaction slice。第一条 Request 只能使用 Task start anchor；后续 Request 可按行距离优先选择 start/end anchor，并在总 locator 预算内使用另一侧 fallback。这样既不从 rollout 文件头 replay，也不需要新增持久化 line-to-byte index 或 schema migration。

正式 `audit:request-content` 对 `30,201` canonical Requests 得到：`29,807` 条原 source 仍存在，`boundaryAmbiguous=0`；其中 `29,801` 条满足当前 locator + `4 MiB` slice policy，占 source-present Request 的 `99.97987%`。其余 `6` 条是明确的 oversized slice（最大 `15,128,752` bytes），按设计返回 `content_truncated`；另有 `394` 条历史 Request 因 source 已不存在返回 `source_missing`。

production-equivalent benchmark 中最终 default common P95=`1.683ms`；真实最重双-anchor fallback P95=`63.370ms`；`3,865,074` bytes 的近上限可投影 slice P95=`49.776ms`。一个 boundary 可定位但 slice=`5,699,680` bytes 的 Request 在 P95=`12.683ms` 内直接 bounded truncate；`15,128,752` bytes 巨型 slice 在 P95=`32.146ms` 内返回 `content_truncated`，不会进入大 JSON parse。

性能目标：

- common Request warm read P95 `<100ms`；
- 大 Tool Result / near-limit Request P95 `<250ms`；
- 打开 Inspector 不触发 parser replay、ownership rebuild、diagnostics recompute 或 Timeline rebuild。

## 12. Failure / Coverage states

至少区分：

```text
available
source_missing
source_rebind_failed
request_locator_missing
task_boundary_unavailable
boundary_ambiguous
record_parse_partial
content_truncated
unsupported_content_shape
```

UI 使用可读提示，例如：

> 原始 rollout 已不存在，因此仍可查看该 Request 的 Token/Cost 元数据，但无法读取交互内容。

不能把“内容不可用”等价成 Request 不存在。

## 13. 与既有架构的关系

Phase 25 是一个只读 presentation projection：

```text
Canonical Request accounting       不变
Request identity / ownership       不变
Request-day projection             不变
Pricing                            不变
Diagnostics                        不变
SQLite schema v15                  不变
Projection v2                      不变

新增：
Canonical Request -> source locator -> ephemeral content projection
```

因此 V1 **不需要 schema migration**。

## 14. 后续可能扩展

只有在 V1 验证稳定后再评估：

- Context Structure 浏览视图；
- 对 message/tool 类型增加搜索与过滤；
- 跨 Request 前后导航；
- provider serialization recorder（需要独立 ADR，且必须明确数据持久化/隐私）；
- 官方 Provider payload evidence 出现后升级 evidence level。

这些都不能反向改变 V1 的基本事实：**Observed Interaction 不等于 Provider Wire Payload**。

