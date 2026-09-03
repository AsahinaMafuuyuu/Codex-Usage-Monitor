# Phase 26：Reconstructed Input Context 设计方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**前置基线：** Phase 25 Request Content Inspector；Phase 25.1 Semantic Refinement  
**架构决策：** [ADR-0031：Reconstructed Input Context evidence boundary](decisions/0031-reconstructed-input-context-evidence.md)

## 1. 背景

Request Inspector 顶部已经能够显示：

```text
Input Tokens       21.11万
Cached Input       20.26万
Cache Hit Rate     96.0%
```

但当前 Observed Interaction Slice 可能只直接出现一条很短的 User message。

因此用户自然会问：

> “这 21.11 万 Input Tokens 具体是什么内容？”

本地 rollout 的事实能力是：当前及历史 thread 中存在明确 message/tool/context records；同线程可能跨多个 rollout source；compaction 可能存在明确 replacement/history evidence；当前 Request 有 canonical `token_count` end boundary；当前 slice 可以通过第一条明确 model-output evidence 构造保守 pre-model cut。

但 rollout **没有证明最终 Provider HTTP/Responses serialization**，也不能证明所有 system/developer/harness 注入内容都以稳定公开 record 逐项存在。

因此 Phase 26 的产品名称必须是：

> **Reconstructed Input Context / 重建输入上下文**

不能命名为 `Provider Request`、`Complete Prompt` 或 `Exact Input Body`。

## 2. 核心目标

Phase 26 回答：

> “基于当前本地 rollout 中可证明的同线程历史、compaction snapshot、runtime context 与当前 pre-model evidence，在这次 Request 出现可观察模型输出之前，可以重建出哪些输入上下文？”

目标：

1. 为 Request Inspector 增加独立 `Input Context` 视图；
2. 重建同线程中当前 Request 之前的**可观察上下文**；
3. 正确处理同线程多 source continuity；
4. 正确处理显式 compaction replacement evidence；
5. 将当前 slice 的 pre-model evidence 合并到 context tail；
6. 每个 context item 携带 provenance/evidence level；
7. 官方 Input/Cached token 作为 accounting 对照，但不分配到 item；
8. source missing / unsupported / bounded truncation 明确形成 coverage gap；
9. 全部内容 lazy、bounded、ephemeral；
10. 不改变 accounting/schema，也不冒充 Provider serialization。

## 3. 非目标

Phase 26 V1 不做：

- 不捕获真实 Provider HTTP body；
- 不保证 reconstructed items 与 Provider 最终 serialization item 一一对应；
- 不保证 item 顺序等于 provider SDK 最终 serialization；
- 不推断未记录的 system/developer prompt；
- 不把 Input Tokens 精确拆给各 message/tool item；
- 不用字符数/tokenizer估算结果冒充官方 token；
- 不解密 reasoning；
- 不展示 Raw JSON；
- 不把 reconstructed context 写 SQLite；
- 不提供正文全文索引/搜索；
- 不把完整 context 放进 Session snapshot/SSE；
- 不跨 unrelated thread/source 猜历史。

## 4. Evidence model

Phase 26 必须把“内容是什么”和“为什么认为它属于当前重建上下文”分开。

### 4.1 Evidence levels

建议固定：

```text
direct_current
historical_rollout
compaction_snapshot
runtime_context
coverage_gap
```

- `direct_current`：当前 Request slice pre-model cut 之前的明确 record。
- `historical_rollout`：当前 thread 在目标 cut 之前、原始 rollout 中明确记录的 message/tool semantic record。
- `compaction_snapshot`：明确 compaction record 中可安全语义化的 replacement/history snapshot。
- `runtime_context`：明确 `turn_context` allowlist metadata。
- `coverage_gap`：source missing、bounded truncation、unsupported shape、ambiguous ordering 等无法证明的历史段。

### 4.2 两个独立 completeness 轴

不能只返回一个 `complete=true/false`。

需要：

```js
evidence: {
  rolloutCoverage: "complete_observed_history" | "partial" | "unavailable",
  providerPayloadReconstructed: false,
  providerSerializationKnown: false
}
```

即使 `rolloutCoverage=complete_observed_history`，也**永远不等于** Provider Input complete。

## 5. Reconstruction cut

Phase 26 不能直接“扫描到当前 token_count”为 Input，因为当前 token_count 之前还包含当前模型的 reasoning/assistant/tool call 等输出。

因此使用 Phase 25.1 的 pre-model evidence cut：

```text
previous request boundary
  -> user/tool input/runtime evidence
  -> [CUT: before first observed model output]
  -> reasoning/assistant/tool call/...
  -> current token_count
```

重建目标时点正式称为：

> **Reconstruction Cut: before first observed model output**

禁止称为 Provider request start。

若当前 slice 找不到明确 cut：仍可展示历史 context overview，但当前 turn input section 标记 `cut_unavailable`，不把整个 slice 合并为 current input。

## 6. Reconstruction algorithm

### 6.1 Thread-local only

V1 默认只重建当前 `rootSessionId + threadId` 的可证明历史。

不从 sibling/parent/child thread 自动拼接正文。如果 subagent creation/history copy 未来存在可证明专用 evidence，再单独扩展。

### 6.2 Source chain

DB/Repository 需要提供目标 Request 所在线程的有序 source chain：

```text
source A
source B
source C (current)
```

每个 segment 至少：

```js
{
  sourceKey,
  threadId,
  firstKnownLine,
  lastKnownLine,
  current: boolean
}
```

排序必须来自已持久化 thread/source evidence 和可证明 chronological source metadata，不能由客户端传 path。

### 6.3 Context state machine

概念流程：

```text
state = empty

for record in proven thread history before reconstruction cut:
  message/tool/context record -> semantic append
  explicit compaction -> replace/rebase state using explicit compaction snapshot
  unsupported relevant record -> coverage gap
  lifecycle/accounting record -> ignore for body

apply current pre-model evidence

return bounded reconstructed context
```

### 6.4 Compaction

若明确 `compacted` record 提供 `replacement_history`：

1. 不 Raw JSON dump；
2. 使用专用 semantic projector；
3. 标记 `compaction_snapshot` provenance；
4. context state 从该 snapshot 重新建立；
5. snapshot 之前历史移入 superseded summary，不与当前 retained context 重复展示；
6. encrypted/opaque reasoning 仍不解码。

如果只有 `context_compacted` signal、没有可读 replacement snapshot：

```text
coverage = partial
gap = compaction_snapshot_unavailable
```

不能假设 compaction 前所有历史仍完整保留。

## 7. Item model

建议 public context item：

```js
{
  id: "deterministic-ephemeral-id",
  kind: "message" | "tool_call" | "tool_result" | "context_signal",
  role: "user" | "assistant" | "developer" | "system" | null,
  text: "...",
  fields: [],
  provenance: {
    level: "historical_rollout",
    sourceKey: "sessions/...",
    lineStart: 120,
    lineEnd: 120
  },
  truncated: false
}
```

ephemeral id 只用于当前 payload DOM identity；不写数据库；sourceKey 是 portable evidence；absolute path 不公开。

## 8. UI 设计

Request Inspector 建议使用顶层 tab：

```text
[ Interaction ] [ Input Context ]
```

### 8.1 Input Context Header

```text
Reconstructed Input Context

Input Tokens          211.1K
Cached Input Tokens   202.6K

Evidence
Reconstructed from local rollout history.
Provider payload/serialization unavailable.
Token accounting is not allocated to individual items.
```

### 8.2 Context sections

```text
Current Input Evidence
Runtime Context
Retained / Reconstructed History
Compaction Evidence
Coverage Gaps
```

### 8.3 Provenance badge

每个历史 item 必须可见 provenance：`Observed current / Historical rollout / Compaction snapshot / Runtime metadata / Coverage gap`。

不能只通过颜色表达；必须有文本/ARIA label。

### 8.4 大上下文 UX

不能一次把数百个 Card 全部展开。

推荐：当前 input 默认展开；history 按 request/turn/context segment 分组；older groups 默认折叠；Tool Result 默认折叠；compaction 前 superseded history 只显示 summary/count；使用稳定 keyed DOM，展开某 group 时不重建整个 Dialog。

## 9. Token accounting 展示

Phase 26 **不做 item-level token allocation**。

UI 可以展示官方 `Input Tokens / Cached Input Tokens / Cache Hit Rate`，同时固定说明这些 token counts 描述 provider-accounted request，无法从现有 rollout evidence 精确分配到 reconstructed item。

禁止显示类似：

```text
User message = 35 tokens
History = 202,600 cached tokens
Tool result = 8,465 new tokens
```

除非未来有官方 serialization/token attribution evidence。

## 10. Deep module seam

Phase 26 建议新增：

```text
src/request-input-context.js
```

外部 interface 保持窄：

```js
readReconstructedInputContext({
  requestLocator,
  sourceChain,
  resolveSource,
  limits
})
```

multi-source history、compaction state machine、pre-model cut、semantic projection、provenance、truncation/coverage 都留在模块内部。

如果实现时发现 Phase 25 与 Phase 26 明确重复 bounded line locator，可抽取一个真实共享 internal seam；但禁止为了“看起来抽象”提前制造 pass-through module。

## 11. Database / Repository seam

建议新增只读 interface：

```js
getCanonicalRequestInputContextLocator(rootSessionId, requestId)
```

数据来源优先复用现有 `canonical_requests`、`tasks`、`ingest_cursors`、`agents` 与 portable source locator。

V1 第一选择是**不升级 schema**。只有真实 query plan/benchmark 证明现有 metadata 无法 bounded 定位时，才能另立 migration 方案。

## 12. HTTP interface

建议：

```text
GET /api/sessions/:sessionId/requests/:requestId/input-context
HEAD /api/sessions/:sessionId/requests/:requestId/input-context
```

V1 不接受 path/source/line/byte 或任意 filesystem location。

是否分页由 benchmark 决定。首选一次 bounded payload + server-side grouping；若真实历史证明 payload/DOM 过大，再使用**服务端生成并验证的 opaque cursor**，不能让客户端直接提交 line/byte locator。

## 13. Frozen limits

Phase 26 已先运行真实 audit 再冻结实现上限。最终值为：

```js
{
  maxSourceSegments: 16,
  maxHistoryScanBytes: 32 * 1024 * 1024,
  maxContextItems: 800,
  maxItemCharacters: 64 * 1024,
  maxProjectedCharacters: 1 * 1024 * 1024
}
```

300 个真实 canonical Request 的均匀样本中，source/thread P99=`2`、max=`4`；history scan P99=`25,614,241` bytes、max 达到 `32 MiB` hard bound；context items P99=`699`、max=`800`；projected visible chars P99=`778,549`、max=`822,132`。因此保留 `16 sources / 32 MiB scan / 800 items / 64 KiB item / 1 MiB projected body` 作为正式 V1 hard limits。超限不会扩大 scan，而是返回 `partial_bounded_truncation`。

## 14. Coverage states

至少：

```text
complete_observed_history
partial_source_missing
partial_compaction_snapshot_unavailable
partial_unsupported_shape
partial_bounded_truncation
current_cut_unavailable
source_rebind_failed
boundary_ambiguous
```

UI 必须区分“重建历史不完整”和“Provider payload 本来就不可恢复”。

## 15. Privacy / Security

保持 loopback/Strict Cookie/Host/Origin/CSP/no-store。

Phase 26 读取比单 Request slice 更长的历史正文，因此必须额外约束：用户主动打开 `Input Context` 才读取；不 background preload；不写日志/SQLite/browser persistence；close/scope switch 清空；stale generation 只提示 refresh；source key 可公开但 absolute path 不公开；raw history/replacement JSON 不直接进入 DOM；所有正文 escape。

## 16. 性能目标

Phase 26 是用户主动 deep drill-down，可比 Phase 25 慢，但必须 bounded。

正式 Gate：common reconstructed context warm P95 `<150ms`；large/near-limit context P95 `<500ms`；endpoint 不阻塞 Session/SSE hot path；browser 首次 render 不产生不可接受长任务；close 后 payload/DOM 释放。最终 20 轮 production-equivalent benchmark 为 common P95=`9.427ms`、large P95=`39.421ms`，两档均满足冻结门槛。

## 17. 与 Phase 26B 的 seam

Phase 26 只回答“重建出了哪些上下文”。未来 Context Delta / Cache Explanation 可以消费 Phase 26 的 metadata/provenance projection，但不能反向要求 Phase 26 V1 做 cache root-cause 推断。

## 18. 验收标准

只有满足以下条件才允许交付：

- 用户明确看到 `Input Context` 是 reconstructed；
- 当前 User/Tool input 与历史上下文分区清楚；
- compaction 有明确 provenance；
- source gap 不静默忽略；
- Input/Cached Tokens 不错误分配给 item；
- Provider payload 始终 unavailable/not reconstructed；
- multi-source same-thread continuity、compaction replacement、source missing/truncation/unknown shape 均有 fixture；
- no schema/no persistence/no accounting regression；
- performance/browser/read-only/accounting Gate 全部通过。

