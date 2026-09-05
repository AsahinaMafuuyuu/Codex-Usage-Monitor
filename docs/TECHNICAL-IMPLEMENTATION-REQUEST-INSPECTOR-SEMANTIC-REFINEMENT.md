# Phase 25.1：Request Inspector Semantic Refinement 技术实施方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**设计事实源：** [DESIGN-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md](DESIGN-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)  
**前置实现：** [Phase 25 Request Content Inspector](TECHNICAL-IMPLEMENTATION-REQUEST-CONTENT-INSPECTOR.md)

## 1. 实施原则

Phase 25.1 是对现有 `src/request-content.js -> request content endpoint -> single Dialog` 深模块链路的**语义深化**，不是新建第二套 Inspector。

原则：server projector 负责 evidence classification；浏览器不理解 raw rollout shape；pre-model cut 只依据当前 slice 内明确可观察的 model-output record；reasoning dedupe 发生在 semantic item 层；Runtime Context 只使用 allowlist；endpoint 继续 lazy/no-store；不修改 schema v15 / projection v2 / canonical accounting。

## 2. 预计修改范围

### 主要修改

```text
src/request-content.js
src/monitor.js                 # 仅 response version/shape 适配（如需要）
public/app.js
public/styles.css
scripts/verify-live-ui.js
test/request-content.test.js
test/database-server.test.js
test/ui-security.test.js
docs/API.md                    # 实现后
docs/ARCHITECTURE.md           # 实现后
docs/VERIFICATION.md           # 仅真实验证后
README.md                      # 仅用户可见实现后
CHANGELOG.md                   # 仅用户可见实现后
```

不应修改 Request Ledger / identity / ownership / pricing 核心模块，也不应出现 schema migration。

## 3. `src/request-content.js` 深化

继续保留外部 interface：

```js
readRequestContent({ sourcePath, locator, limits })
```

内部 pipeline：

```text
locate exact slice
  -> parse bounded records
  -> classify record semantics
  -> determine pre-model cut
  -> project raw semantic items
  -> assign public section
  -> coalesce reasoning semantics
  -> enforce item/body bounds
  -> public projection v2
```

不要先截断 public items 再 dedupe，否则 occurrence evidence 会失真。

## 4. Pre-model cut detector

新增内部函数：

```js
findPreModelCut(records)
```

返回 `observed` 或 `unavailable`，并带 `lineNumber/kind`。

### 4.1 Model-output evidence allowlist

触发 cut：

```text
response_item/reasoning
response_item/message role=assistant
response_item/agent_message（模型输出语义）
response_item/custom_tool_call
response_item/function_call
```

不触发 cut：

```text
event_msg/item_completed
event_msg/token_count
turn_context
user/developer/system message
tool result
context signal
unknown lifecycle record
```

### 4.2 Section assignment

建议：

```js
assignSection(item, recordIndex, cut)
```

- runtime context -> `runtime_context`；
- cut 可用且 record 在 cut 之前、语义为 input-like -> `observed_input`；
- 其余用户可见 semantic item -> `observed_interaction`；
- cut 不可用时不要把全部 message/tool result 强行归为 input。

## 5. Runtime Context projector

新增：

```js
projectRuntimeContext(payload, limits)
```

严禁 `Object.entries(payload)` 无过滤输出。字段映射必须写死 allowlist：model、effort、current_date、timezone、cwd、workspace_roots、approval_policy、sandbox_policy、active_permission_profile、personality、collaboration_mode。

嵌套值继续使用 semantic summary，不 JSON dump。

## 6. Reasoning coalescer

新增：

```js
coalesceReasoningItems(items)
```

比较 normalization 只允许 Unicode/string normalization、CRLF->LF、outer trim；不 lowercase、不去标点、不 fuzzy similarity。

只有相邻 semantic reasoning item、公开 summary normalized text 完全相同、且中间没有其他 visible semantic item 时才合并。

合并后：

```js
occurrenceCount = left.occurrenceCount + right.occurrenceCount
opaqueContentPresent = left.opaqueContentPresent || right.opaqueContentPresent
```

无 summary 的连续 opaque reasoning 聚合为 `reasoning_activity` + occurrenceCount，不称 equivalent summary。

## 7. Public response v2

`UsageMonitor.requestContent()` 建议返回：

```js
{
  version: 2,
  projectionGeneration,
  request,
  available,
  reason,
  evidence,
  preModelCut,
  items,
  summary
}
```

`summary` 可增加 `observedInputItemCount/runtimeContextItemCount/observedInteractionItemCount/reasoningRecordCount/reasoningCardCount`，用于证明 dedupe 只改变 presentation，不丢 evidence。

## 8. Frontend

不新增第二套正文 state，继续复用 `state.requestInspector.payload`。

建议 renderer：

```js
renderRequestInspectorSummary(payload)
renderObservedInputSection(payload)
renderRuntimeContextSection(payload)
renderObservedInteractionSection(payload)
renderRequestInspectorEvidence(payload)
```

所有 section 使用 server 返回的 `item.section`，不能在 browser 重新推断 cut。

Metrics 静态 label 固定为 `Input Tokens / Cached Input Tokens / Cache Hit Rate / Output Tokens / Total Tokens / USD`。

Reasoning UI：公开 summary 显示 occurrence；opaque-only 显示 `N opaque records`。

## 9. CSS / Layout

保持单一 Dialog 和当前 desktop/narrow viewport contract。Runtime Context 默认折叠；token metrics 不因 label 变长造成 720px 操作区不可达；不新增 nested page scroll trap；reduced-motion 保持现有全局规则。

## 10. Tests

### `test/request-content.test.js`

- user + turn_context + reasoning：cut 在 reasoning 前；
- tool result + reasoning：tool result 属于 observed input；
- assistant/tool call 触发 cut；
- no model output -> cut unavailable；
- runtime context allowlist；
- identical summary x2 -> one card + occurrenceCount=2；
- distinct summary x2 -> two cards；
- opaque x2 -> reasoning_activity occurrenceCount=2；
- reasoning A -> assistant -> reasoning A：不得跨 visible item 合并。

### DB/API/UI

- endpoint version=2；
- `preModelCut` shape；
- runtime context 不含 raw object/source path；
- strict-slice Tool Result callId fallback；
- `Input Tokens`/disclaimer 存在；
- runtime/reasoning 全量 escape；
- no persistent body 不回归。

### Chrome/CDP

真实重复 reasoning Request 只显示一个 summary Card + count；Observed Input 能看到 User；Runtime Context 可折叠；720×900/SSE/focus restore 不回归。

## 11. 性能与 Accounting Gate

实施后复跑：

```bash
npm run audit:request-content
npm run benchmark:request-content -- --iterations 20
npm test
npm run check
git diff --check
npm run fingerprint:phase23
npm run verify:live-ui -- "<authenticated URL>"
```

要求 canonical/calendar 六字段、cost、identity/ownership、`.codex` manifest 不变；common P95 `<100ms`；slow path `<250ms`；无 schema migration。

## 12. 实施顺序

1. 补 projector tests；
2. 实现 pre-model cut + section assignment；
3. Runtime Context allowlist；
4. reasoning coalescer；
5. bump Request Content public version；
6. 更新前端分区与 metrics label；
7. security/UI contract tests；
8. Chrome/CDP；
9. performance/accounting/read-only reconciliation；
10. 最后更新 Verification/README/CHANGELOG 并把 Delivery 改为 Verified。

## 13. 实施结果

最终实现保持原 `readRequestContent({ sourcePath, locator, limits })` 外部 interface，不新增第二套 Inspector。Request Content public contract 升为 v2；server projector 输出 `preModelCut`、`observed_input/runtime_context/observed_interaction` section、allowlisted Runtime Context，以及 reasoning `occurrenceCount`/opaque activity semantics。正式 `audit:request-content` 仍为 source-present `29,807`、当前 bounded policy 可读 `29,801`、boundary ambiguous=`0`；20 轮 warm benchmark common/near-limit P95=`0.967/0.892ms`，没有额外 source I/O。

真实 Chrome/CDP 另外验证了一个真实 duplicate reasoning Request：`occurrenceCount=2` 的公开 summary 在浏览器中只产生一张 Reasoning Card，并保留 `2 equivalent summary records` evidence；720×900、SSE stale refresh、close payload clear/focus restore 同时 Green。

