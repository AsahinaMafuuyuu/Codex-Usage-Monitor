# Phase 27：Context Delta & Cache Correlation 技术实施方案

**状态：** Implemented / Verified
**日期：** 2026-09-02
**前置事实源：** [Phase 26 Reconstructed Input Context](TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md)
**长期证据边界：** [ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

**交付证据：** 300 Request audit=`293 comparable / 7 no_predecessor / 0 diff truncation`；20 轮 benchmark common/large P95=`19.777/68.592ms`、diff P95=`1.463/9.351ms`；Chrome/CDP 1440×900/720×900、SSE/stale/focus、200-detail collapse Green；最终全量=`210 tests / 209 passed / 0 failed / 1 existing optional skipped`。schema v15 / projection v2 / canonical accounting / `.codex` fingerprint 未改变。

## 1. 目标

Phase 27 在 Phase 26 已交付的 **Reconstructed Input Context** 之上增加 Request-to-Request 的语义差异与缓存计量关联分析，回答：

1. 当前 canonical Request 相比同 thread 的前一 canonical Request，**本地 rollout 可证明的上下文发生了什么变化**；
2. 同一对 Request 的 `Input Tokens / Cached Input Tokens / Cache Hit Rate` 如何变化；
3. 两组变化是否同时出现，以及有哪些本地 evidence 可以供开发者继续排查。

Phase 27 **不回答** Provider 实际 cache key、prefix hash、序列化 byte stream 或精确因果关系。产品名称固定为：

> **Context Delta & Cache Correlation**

禁止把任何输出命名为 `Exact Cache Root Cause`、`Provider Cache Miss Cause`、`Cache Key Diff` 或其他会暗示 Provider 内部事实已经被恢复的名称。

## 2. 核心原则

### 2.1 两个事实层必须保持分离

```text
Local rollout/context evidence             Canonical accounting evidence
---------------------------------          -----------------------------
Phase 26 reconstructed context             Input Tokens
message/tool/runtime/compaction             Cached Input Tokens
coverage/provenance                         Cache Hit Rate
                 \                         /
                  \                       /
                   -> correlation layer <-
```

Context Delta 只能描述本地可观察 context projection 的变化；Cache Correlation 只能描述 canonical accounting 的同期变化。二者可以并列展示、形成 correlation signal，但不能被合并成未经证明的 Provider causal claim。

### 2.2 不从 Token 反推正文

禁止：

- 用 `Input Tokens delta` 推算“新增了多少历史正文”；
- 用 `Cached Input Tokens delta` 分配 retained/added item 的 token；
- 用 cache hit rate 下降推断某个 message/tool/runtime field 一定改变了 Provider cache key；
- 用可见字符数换算 exact token 数。

### 2.3 不建立第二套 context reconstruction

Phase 27 必须消费 Phase 26 的同一 reconstruction seam。不得重新解析 raw rollout 形成第二套“Delta 专用历史上下文”，否则 compaction、coverage、provenance 与 current pre-model cut 会产生双事实源。

## 3. Request pair identity

### 3.1 Current Request

由现有路由 `(rootSessionId, requestId)` 唯一指定，必须先证明 Request 属于 route session。

### 3.2 Predecessor Request

Phase 27 的默认 comparison predecessor 定义为：

> **同 `rootSessionId + threadId` 中，在可证明 rollout source chronology + origin line ordering 上紧邻当前 Request 的前一 canonical Request。**

这里故意不是“同 Task 前一 Request”。原因是上下文/cache continuity 可以跨 tool loop、跨 turn 持续存在；只按 Task 会在新用户轮次处人为断开最重要的 cache/context 对比。

### 3.3 Ordering evidence

复用 Phase 26 已冻结的 source-chain chronology：

```text
same rootSessionId + threadId
  -> portable rollout source chain
  -> rollout filename timestamp chronology
  -> origin_line_number within source
```

不得只用 filesystem mtime；不得只用 UI row order；不得在 chronology ambiguous 时退回“observedAt 最接近”猜 predecessor。

若：

- 当前 Request 是 thread 第一条 canonical Request；
- source chain 无法证明；
- current/predecessor canonical origin 不在可证明 chain；
- duplicate chronology 使顺序不唯一；

则返回明确 comparison coverage，而不是构造假 predecessor。

候选状态：

```text
complete_pair
no_predecessor
predecessor_unavailable
boundary_ambiguous
current_context_partial
previous_context_partial
both_context_partial
```

## 4. Database seam

建议新增窄接口：

```js
getCanonicalRequestContextDeltaLocator(rootSessionId, requestId)
```

职责：

1. 读取 current canonical Request metadata；
2. 读取同 thread 的 canonical Request origin locators；
3. 使用 Phase 26 source chronology 选择 immediate predecessor；
4. 返回 current/predecessor 的 request identity 与 Phase 26 reconstruction 所需 locator；
5. 不读取正文，不做 context diff，不做 cache diagnosis。

建议返回：

```js
{
  status: "ok" | "no_predecessor" | "boundary_ambiguous",
  rootSessionId,
  threadId,
  current: { requestId, sourceKey, lineNumber, ... },
  previous: { requestId, sourceKey, lineNumber, ... } | null,
  sourceOrdering: "rollout_filename_timestamp"
}
```

如果可以安全复用 `getCanonicalRequestInputContextLocator()`，应提取内部 locator helper，而不是通过 public HTTP endpoint 相互调用。

## 5. 新深模块

建议新增：

```text
src/request-context-delta.js
test/request-context-delta.test.js
```

外部接口建议：

```js
export async function analyzeRequestContextDelta({
  pairLocator,
  reconstructInputContext,
  limits = REQUEST_CONTEXT_DELTA_LIMITS,
})
```

`reconstructInputContext` 应由 monitor 注入 Phase 26 的内部 reconstruction function/seam，避免模块间 HTTP 调用。

## 6. Pipeline

```text
validate pair locator
  -> reconstruct previous Request input context
  -> reconstruct current Request input context
  -> normalize semantic context items
  -> compute retained / added / removed-or-superseded
  -> compute runtime-context changes
  -> compute compaction/source/coverage transitions
  -> read current/previous canonical accounting
  -> compute token/cache deltas
  -> classify correlation signals
  -> bounded public projection
```

若 previous 不存在，Context Delta endpoint 仍可返回 current Request metadata + `no_predecessor`，UI 显示“该 thread 没有可比较的上一 canonical Request”，而不是 404。

## 7. Semantic identity / diff strategy

### 7.1 不做 raw JSON diff

Diff 输入是 Phase 26 semantic items，不是 rollout JSON envelope。至少支持：

- message；
- tool_call；
- tool_result；
- runtime_context；
- compaction_snapshot；
- coverage_gap metadata。

Reasoning encrypted/CoT 继续不进入 context diff。

### 7.2 Stable semantic fingerprint

每个可比较 item 建立 ephemeral fingerprint。建议：

```text
kind
role/tool/callId where applicable
normalized public text/fields digest
provenance level
```

要求：

- digest 只在内存中计算，不落 SQLite；
- 不把 digest 声称为 Provider cache key；
- 不把 source line/absolute path 纳入语义 equality；
- Unicode 先 NFC、CRLF 归一化；
- Tool Result 可优先用 `callId + normalized body digest`；
- runtime context 按 allowlisted field name/value 比较。

### 7.3 Sequence-aware matching

不能仅做 `Set` 差集，因为相同 message/tool item 可能重复出现。V1 建议使用 bounded sequence-aware matching：

1. 对前后 item 生成 semantic fingerprint sequence；
2. 优先 fast path：最长公共 prefix + suffix；
3. 中间区间在 hard item limit 内执行 bounded LCS/Myers 等序列匹配；
4. 超过计算预算时降级为 prefix/suffix + aggregate counts，并标记 `diff_truncated=true`。

不得为了追求完美 diff 引入 O(N²) 无界计算。

## 8. Delta categories

公开分类至少包含：

```text
retained
added
removed_or_superseded
runtime_changed
compaction_rebase
source_transition
coverage_changed
```

`removed_or_superseded` 比简单 `removed` 更诚实：当 explicit compaction 发生时，旧 history 可能被 replacement snapshot 重述，不能把每个未匹配 item 都解释成“Provider 删除了它”。

### 8.1 Compaction precedence

如果 current reconstruction 显示 latest explicit compaction snapshot 位于 pair interval 中：

- 顶层必须产生 `compaction_rebase` signal；
- pre-compaction unmatched history 统一标记为 `superseded_by_compaction`；
- 不把大量 item removal 展示为数百条独立异常；
- snapshot item 使用 `compaction_snapshot` provenance。

signal-only compaction 只能产生 coverage gap，不能推断 replacement 内容。

## 9. Cache accounting delta

只使用 canonical Request 已有六字段 accounting 中与本功能相关的事实：

```js
previous.inputTokens
previous.cachedInputTokens
current.inputTokens
current.cachedInputTokens
```

派生：

```js
inputTokensDelta = current.inputTokens - previous.inputTokens
cachedInputTokensDelta = current.cachedInputTokens - previous.cachedInputTokens
previousCacheHitRate = cached / input
currentCacheHitRate = cached / input
cacheHitRateDeltaPoints = currentRate - previousRate
```

任一字段缺失/矛盾时保持 `null` + coverage reason，不补零。

## 10. Correlation signals

Phase 27 V1 只输出**规则化 correlation evidence**，不输出 causal score。

候选 signal：

```text
cache_hit_drop_with_context_growth
cache_hit_drop_with_compaction
cache_hit_drop_with_runtime_change
cached_input_drop_with_source_transition
context_changed_cache_stable
cache_changed_without_visible_context_change
insufficient_context_coverage
```

每个 signal 必须包含：

- current/previous accounting delta；
- 触发的 local context evidence；
- evidence coverage；
- 固定 limitation：`Exact provider cache causality unavailable.`

### 10.1 禁止 causality rank

V1 不提供：

- `confidence=92%`；
- “最可能原因是 X”；
- 多因素 causal ranking；
- Provider cache key mutation 断言。

除非未来有新的官方 evidence/ADR，否则这些都超出 Phase 27 证据边界。

## 11. Proposed public contract

```js
{
  version: 1,
  projectionGeneration,
  pair: {
    currentRequestId,
    previousRequestId,
    threadId,
    status
  },
  evidence: {
    kind: "context_delta_cache_correlation",
    providerCacheKeyKnown: false,
    providerSerializationKnown: false,
    exactCacheCausalityKnown: false,
    comparisonCoverage,
    diffTruncated
  },
  accounting: {
    previous: { inputTokens, cachedInputTokens, cacheHitRate },
    current: { inputTokens, cachedInputTokens, cacheHitRate },
    delta: { inputTokens, cachedInputTokens, cacheHitRatePoints }
  },
  contextDelta: {
    summary: {
      retainedItems,
      addedItems,
      removedOrSupersededItems,
      previousVisibleCharacters,
      currentVisibleCharacters,
      visibleCharactersDelta
    },
    added: [],
    removedOrSuperseded: [],
    runtimeChanges: [],
    compaction: [],
    sourceTransitions: [],
    coverageChanges: []
  },
  correlationSignals: [],
  limitations: []
}
```

Public response 不返回 absolute path、raw JSON、raw replacement history、encrypted reasoning、Provider payload 或 item-level token allocation。

## 12. Limits

Phase 27 应先做 audit/benchmark，再冻结最终值。初始设计预算：

```js
const REQUEST_CONTEXT_DELTA_LIMITS = {
  maxComparableItemsPerSide: 800,
  maxDetailedDeltaItems: 200,
  maxProjectedCharacters: 512 * 1024,
  maxDiffWorkUnits: 250_000,
};
```

Phase 26 的 `16 sources / 32 MiB / 800 items / 64 KiB / 1 MiB` reconstruction hard limits继续成立；Phase 27 不能为了 diff 放宽 Phase 26 reader。

当 detailed delta 超限：

- summary counts 尽可能保留；
- detailed item 截断；
- `diffTruncated=true`；
- UI 明确显示 bounded partial；
- 不无界计算/渲染。

## 13. Audit

建议新增：

```text
scripts/audit-request-context-delta.js
npm run audit:request-context-delta
```

真实 audit 至少统计：

- same-thread predecessor coverage；
- cross-source pair 比例；
- pair 中 compaction 频率；
- previous/current Phase 26 coverage 组合；
- retained/added/superseded item P50/P95/P99/max；
- visible character delta 分布；
- cache-hit delta 分布；
- `cache_changed_without_visible_context_change` 数量；
- detailed diff truncation rate；
- unsupported/ambiguous pair 数量。

只有 audit 后才能冻结 V1 diff limits 与 signal threshold。

## 14. Threshold policy

不建议直接复用 Phase 23 Cache Regression 的 finding threshold 作为 Phase 27 UI threshold。二者目的不同：

- Phase 23：检测异常，强调低噪声 finding；
- Phase 27：解释用户主动打开的单个 Request pair，可以展示更完整的连续 delta。

因此 Phase 27 accounting delta 默认显示原始值；如果 correlation signal 需要阈值，应通过 audit 冻结，并单独版本化，例如：

```text
request-context-delta-v1
```

## 15. Monitor seam

建议新增：

```js
async requestContextDelta(sessionId, requestId)
```

Monitor：

1. 获取 pair locator；
2. 读取 previous/current canonical accounting；
3. 复用 Phase 26 reconstruction；
4. 调用 `analyzeRequestContextDelta()`；
5. 附加 `projectionGeneration`；
6. 不修改 selected session，不触发 index/replay/diagnostics recompute。

## 16. HTTP interface

建议新增：

```text
GET/HEAD /api/sessions/:sessionId/requests/:requestId/context-delta
```

要求：

- 只接受 session/request identity；
- V1 不接受 user-controlled predecessor Request ID；
- 不接受 source/path/line/byte；
- foreign session/request -> 404；
- current Request 合法但无 predecessor -> `200 + pair.status=no_predecessor`；
- `Cache-Control: no-store`；
- 不进入 Session/Day snapshot；
- 不进入 SSE；
- POST/PUT/PATCH/DELETE 继续 405；
- response 不含 absolute source path。

V1 不允许客户端选择 arbitrary comparison pair，是为了先冻结“immediate same-thread predecessor”这一唯一可审计语义。未来如果开放手动比较，必须使用 canonical request identity 且明确标成 User-selected Comparison，不得与默认 predecessor 混淆。

## 17. Request Inspector UI

Inspector 建议扩展为：

```text
Interaction | Input Context | Context Delta
```

打开 Dialog 仍只加载 Interaction；`Input Context` 和 `Context Delta` 都各自在首次点击时 lazy fetch，不互相预加载。

### 17.1 Summary

顶部显示：

```text
Request N-1 -> Request N

Input Tokens          182K -> 244K    +62K
Cached Input Tokens   171K -> 113K    -58K
Cache Hit Rate        93.9% -> 46.3%  -47.6 pp

Context
Retained 61 · Added 3 · Superseded 14
```

### 17.2 Evidence sections

建议分区：

1. `Context Change Summary`
2. `Added Context`
3. `Removed / Superseded Context`
4. `Runtime Context Changes`
5. `Compaction / Source Evidence`
6. `Cache Correlation Evidence`
7. `Coverage & Limitations`

older/detailed delta 默认折叠；Tool Result 仍折叠正文。

### 17.3 Wording

固定 disclaimer：

> `Context changes are reconstructed from local rollout evidence. Cache metrics are canonical accounting facts. Exact provider cache-key behavior and causal attribution are unavailable.`

UI 不显示“Root Cause Found”“Cache key changed”“This caused the cache miss”。

## 18. Stale / memory lifecycle

沿用 Inspector 单 Request ephemeral model：

- 只缓存当前打开 Request 的当前 tab payload；
- close 清除 Interaction/Input Context/Context Delta；
- session/day switch abort + clear；
- projection generation 变化只标 stale，不自动 background reread；
- refresh 当前 active tab；
- SSE 不替换 Dialog root；
- 不使用 localStorage/sessionStorage/IndexedDB。

如果 Phase 27 为了计算临时读取 previous/current 两份 Input Context，server response 结束后必须释放 reconstruction object；browser 不需要同时持有两份完整 Phase 26 payload，只持有 bounded delta projection。

## 19. Security / privacy / accounting

Phase 27 不需要 schema migration。明确不允许：

- 新正文表/列；
- semantic fingerprint 持久化；
- cache diagnosis cache table；
- raw source path；
- Provider credential/network；
- 模型调用或外部解释服务。

必须保持：

- loopback；
- Strict Cookie；
- Host/Origin；
- CSP；
- HTML escape；
- `.codex` read-only；
- schema v15 / projection v2 accounting 不变。

## 20. Tests

### 20.1 Unit

至少覆盖：

- immediate predecessor in same source；
- predecessor across rollout source boundary；
- first Request -> no predecessor；
- chronology ambiguous -> no guessed pair；
- unchanged context -> retained；
- one added user message；
- tool call/result append；
- duplicate semantic item sequence matching；
- runtime allowlist field changed；
- explicit compaction rebase；
- signal-only compaction gap；
- current/previous Phase 26 partial coverage；
- detailed diff budget truncation；
- encrypted reasoning never enters diff；
- item token allocation absent；
- correlation wording never becomes causality claim。

### 20.2 DB/API/security

- pair locator belongs to route session；
- predecessor 是同 thread immediate canonical Request；
- source chronology tested；
- foreign session 404；
- path/source/line/byte/predecessor query injection rejected；
- GET/HEAD/no-store；
- no absolute path；
- no Session/SSE payload regression；
- endpoint 不触发 replay/rebuild。

### 20.3 UI/Chrome

- third tab lazy fetch；
- previous/current accounting values readable；
- delta signs/percentage points correct；
- compaction/superseded presentation；
- provider/cache-causality disclaimer；
- coverage partial/no predecessor states；
- SSE stale；
- close/focus restore；
- 1440×900 / 720×900；
- large delta detail collapse；
- Interaction/Input Context tabs 不回归。

## 21. Benchmark

建议新增：

```text
scripts/benchmark-request-context-delta.js
npm run benchmark:request-context-delta -- --iterations 20
```

计时必须包含：

```text
DB pair locator
+ previous reconstruction
+ current reconstruction
+ semantic fingerprint/matching
+ accounting delta
+ correlation projection
```

初始设计 Gate：

- common warm P95 `<100ms`；
- large/near-limit pair P95 `<750ms`；
- diff compute 自身 P95 `<100ms`；
- source hash before/after unchanged。

最终门槛必须由真实 audit/benchmark 冻结；如果 large pair 需要更严格的 reconstruction reuse/streaming 优化，应优化实现，不直接扩大 hard limits。

## 22. Documentation / ADR

实现前需要判断是否新增 ADR-0032。以下任一项成立时必须新增 ADR：

- 改变 ADR-0031 的 evidence boundary；
- 引入持久化 fingerprint/delta；
- 允许 arbitrary pair comparison；
- 输出 causal ranking/confidence；
- 引入 Provider/API/网络证据。

如果 V1 严格保持本文定义的 compute-on-read correlation，不改变 ADR-0031 边界，可以先把本文和 Delivery 作为 Phase 27 实施事实源；交付时仍需更新 API/Architecture/Verification/README/CHANGELOG/ROADMAP。

## 23. 实施顺序

1. 写 pair identity / semantic diff unit fixtures；
2. 实现只读 audit，验证 predecessor/source/compaction 分布；
3. 冻结 pair semantics、diff limits、signal policy version；
4. DB narrow pair locator；
5. `src/request-context-delta.js` 深模块；
6. Monitor/API integration；
7. security/no-persistence tests；
8. Inspector `Context Delta` lazy tab；
9. audit + production-equivalent benchmark；
10. Chrome/CDP desktop/narrow/SSE/focus；
11. accounting/read-only fingerprint；
12. 全量 `npm test` / `npm run check` / `git diff --check`；
13. 最后更新用户可见文档并将 Delivery 状态改为 Verified。

## 24. 明确不在 Phase 27 V1

- Exact Provider Request Capture；
- Provider cache key/prefix hash reconstruction；
- Exact cache causal attribution；
- causal confidence/ranking；
- item-level token attribution；
- raw JSON diff；
- reasoning CoT diff/decryption；
- arbitrary two-Request comparison；
- persistent/full-text Context Delta history；
- LLM-generated root-cause explanation。
