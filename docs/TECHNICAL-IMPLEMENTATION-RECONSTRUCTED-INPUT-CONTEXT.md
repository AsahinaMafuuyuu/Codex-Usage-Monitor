# Phase 26：Reconstructed Input Context 技术实施方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**设计事实源：** [DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md](DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md)  
**架构决策：** [ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

## 1. 实施原则

Phase 26 新增一个历史 context reconstruction 深模块，但保持与 canonical accounting 解耦。

数据流：

```text
Request Inspector -> Input Context tab
  -> lazy GET /requests/:requestId/input-context
  -> DB request/thread/source locator
  -> portable source rebind
  -> bounded thread-history scan
  -> compaction-aware context state machine
  -> current pre-model evidence cut
  -> provenance projection
  -> ephemeral grouped UI
```

禁止从 Input Tokens 生成正文、从 cachedInputTokens 推断具体历史 item、读取 unrelated thread 猜上下文、raw `replacement_history` JSON 直返、provider payload claim、eager Session/SSE preload 或 content persistence。

## 2. 预计文件范围

### 新增

```text
src/request-input-context.js
test/request-input-context.test.js
scripts/audit-request-input-context.js
scripts/benchmark-request-input-context.js
docs/DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md
docs/TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md
docs/DELIVERY-RECONSTRUCTED-INPUT-CONTEXT.md
docs/decisions/0031-reconstructed-input-context-evidence.md
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
package.json
docs/API.md                 # 实现后
docs/ARCHITECTURE.md        # 实现后
docs/ROADMAP.md
docs/VERIFICATION.md        # 仅真实验证后
README.md                   # 实现后
CHANGELOG.md                # 实现后
tasks/plan.md
```

## 3. Database seam

新增：

```js
getCanonicalRequestInputContextLocator(rootSessionId, requestId)
```

第一步必须证明 Request 属于 route session；不存在/foreign -> null/404。

返回当前 `rootSessionId + threadId` 的 source segment metadata。候选来源为 `ingest_cursors`、`tasks`、`agents.rollout_key` 与 canonical Request origin source。

必须验证 source belongs to same root/thread、current request source 在 chain 中、source ordering 可证明、同 source line ordering 无冲突；无法证明时返回 `boundary_ambiguous`，不要按 filesystem order 猜。

## 4. Source ordering

实现前先验证 portable `source_key` 的 chronological property 与 ingest metadata。

推荐优先级：已持久化 parser/thread chronology evidence -> source key 中 rollout filename 时间/id metadata -> 明确受测试约束的 deterministic fallback。

不能使用文件 mtime 作为唯一历史顺序事实，因为复制/恢复会修改 mtime。

## 5. `src/request-input-context.js`

### 5.1 External interface

```js
export async function readReconstructedInputContext({
  locator,
  resolveSource,
  limits = REQUEST_INPUT_CONTEXT_LIMITS,
})
```

caller 只负责 server-resolved locator 和 portable source resolver。

### 5.2 Internal pipeline

```text
validate locator
  -> resolve source segments
  -> find current request interaction slice
  -> derive pre-model cut
  -> choose reconstruction start
  -> scan historical segments
  -> project semantic records
  -> apply compaction state transitions
  -> append current pre-model evidence
  -> group/provenance projection
  -> enforce response bounds
```

## 6. Reconstruction start strategy

为了避免从 thread 文件头无界 replay，V1 优先寻找当前 Request 前**最近一次可用 compaction snapshot**。

```text
latest usable compaction before cut exists
    -> start from compaction snapshot
else
    -> bounded thread history start
```

若无 compaction 且完整历史超出 hard limit，返回 `partial_bounded_truncation`，不能无界扫描。

最终实现对历史 reader 做了两项 bounded 优化：同 Task forward reader 使用分段 buffer，只在跨 chunk 的单条 JSONL record 完整时合并一次；历史 source/prefix tail 直接在 Buffer 上逆向逐行解析，并在遇到最近一次 explicit `compacted + replacement_history` 后停止继续语义解析。两项优化均不改变 scan hard limit、coverage 或 provenance，只减少超长 record 的重复复制与已被最新 compaction supersede 的对象分配。

## 7. Compaction state machine

内部状态至少包含 `items/runtimeContext/compactionCount/gaps/supersededItemCount`。

遇到 explicit compaction：project replacement snapshot -> validate supported shape -> replace `state.items` -> provenance=`compaction_snapshot`。

遇到只有 signal 没有 snapshot：增加 `compaction_snapshot_unavailable` gap，coverage=partial。

不要把 compaction 前后两份 history 同时当 retained context 展示。

## 8. Semantic projector

支持 message、assistant message、tool call、tool result、context/compaction signal、runtime context。

Reasoning：encrypted reasoning 不进入 reconstructed input；明确 summary 也不默认认为进入下一 Request provider input，除非 Codex history/replacement shape 明确把它作为 context item；V1 可以显示 reasoning-presence/context signal，但不要把 CoT 当 input transcript item。

## 9. Current pre-model evidence

必须复用 Phase 25.1 定义，不复制第二套 cut 规则。

优先从 `src/request-content.js` 提取真正共享的 internal semantic helper，或由两个深模块共同依赖 `src/request-evidence-semantics.js`。只有在 Phase 25/26 两个真实消费者都需要时再建立这个 seam；不能 HTTP 调 HTTP，也不能形成 circular dependency。

## 10. Public projection

建议：

```js
{
  version: 1,
  projectionGeneration,
  request: { requestId, observedAt, model, effort, serviceTier, usage, costEstimate },
  evidence: {
    kind: "reconstructed_input_context",
    providerPayloadReconstructed: false,
    providerSerializationKnown: false,
    rolloutCoverage,
    sourceSegmentCount,
    compactionCount,
    truncated
  },
  reconstructionCut: { status, kind, sourceKey, lineNumber },
  sections: {
    currentInput: [],
    runtimeContext: [],
    historyGroups: [],
    compaction: [],
    gaps: []
  },
  summary: { itemCount, visibleCharacters, sourceSegmentCount, missingSourceCount, compactionCount, truncatedItemCount }
}
```

## 11. History grouping

为了 DOM 性能，server 直接返回 group，而不是 browser 自己按 raw line 重组。候选 group key 为 turnId / canonical request interval / compaction segment，最终由真实 audit 决定。

每组包含稳定 ephemeral id、label、observedAt、provenance、itemCount 与 items；older history 默认折叠。

## 12. Limits audit

先实现独立只读 audit：

```bash
npm run audit:request-input-context
```

输出 canonical request sample count、sources/thread P50/P95/P99/max、bytes since latest compaction、semantic items、projected chars、source missing、compaction snapshot coverage、cut unavailable 与 unsupported relevant shape。

最终 300 Request 真实 audit 冻结 `REQUEST_INPUT_CONTEXT_LIMITS` 为 `16 source segments / 32 MiB history scan / 800 context items / 64 KiB per item / 1 MiB projected characters`。实测 source/thread P99=`2`、max=`4`；history scan P99=`25,614,241` bytes；context items P99=`699`；visible chars P99=`778,549`。3/300 样本达到 bounded truncation，4/300 当前内容不可用，293/300 为 `complete_observed_history`。

## 13. Benchmark

新增：

```bash
npm run benchmark:request-input-context
npm run benchmark:request-input-context -- --request <requestId>
```

计时必须包含 production-equivalent DB locator + source chain resolution + source rebind + reconstruction + semantic projection + grouping，不能只 benchmark parser。

最终 20 轮 warm benchmark：common P50/P95/max=`8.501/9.427/9.853ms`；large P50/P95/max=`36.693/39.421/40.272ms`。两组源文件 SHA-256 前后不变，满足 `<150ms / <500ms` Gate。

## 14. HTTP / Security

新增：

```text
GET/HEAD /api/sessions/:sessionId/requests/:requestId/input-context
```

复用现有 ID validator；foreign session 404；query 参数默认拒绝；若后续 pagination，只接受 server-generated opaque cursor；其他 methods 405；`Cache-Control: no-store`；response 不含 absolute path；source missing 返回 metadata + partial/unavailable。

## 15. Frontend

Request Inspector 增加 `activeTab: interaction | input_context`。

打开 Dialog 默认只加载 Interaction；第一次点击 Input Context 才 GET，禁止 background prefetch。

避免一次驻留多个 Request 的 Input Context。切换 tab 时是否释放非 active 大 payload由 benchmark 决定，但 close/session/day switch 必须清空全部正文。

Renderer 分为 Input Context summary、Current Input Evidence、Runtime Context、History Groups、Compaction Evidence、Coverage Gaps，所有正文继续统一 escape。

## 16. Stale / SSE

SSE snapshot 不替换已打开 payload；projection generation 变化只标 stale；用户显式 refresh 才 reread；session/day switch 立即 abort+clear；close abort+clear；focus restore 不回归。

## 17. Tests

### Unit

- one-source user history；
- tool result before current cut；
- current output excluded；
- multi-source same-thread continuity；
- latest compaction snapshot rebase；
- signal-only compaction -> partial gap；
- source missing / unsupported / bounded truncation；
- no CoT/encrypted leakage；
- provenance correctness；
- official token metrics not allocated to item。

### DB/API/UI/Chrome

- correct source chain；foreign session 404；path/source/line injection blocked；no-store；HEAD；no absolute path；no schema/persistence；Input Context tab lazy；provenance/provider disclaimer；HTML/script escape；200K+ Input Tokens Request；compaction Request；large history collapse；SSE stale；1440×900 / 720×900；close/focus restore。

## 18. Accounting / Read-only Gate

实施前后运行 `npm run fingerprint:phase23`，证明 canonical/calendar request count、六字段 token、cost、projection accounting 与 `.codex` manifest 不因 Input Context read 改变。

## 19. 实施顺序

1. 写 unit fixtures 和 audit script；
2. 审计真实 source-chain/compaction/context size；
3. 冻结 limits；
4. DB narrow locator；
5. `request-input-context.js` state machine；
6. API integration/security；
7. Input Context tab + lazy state；
8. browser memory/DOM optimization；
9. benchmark + Chrome/CDP；
10. accounting/read-only fingerprint；
11. 全量 tests/check/diff；
12. 最后更新 delivered docs。

