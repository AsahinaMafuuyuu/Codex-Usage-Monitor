# Phase 25.1：Request Inspector Semantic Refinement 设计方案

**状态：** Implemented / Verified  
**日期：** 2026-09-02  
**前置基线：** Phase 25 Request Content Inspector 已实现并验证  
**相关决策：** [ADR-0030](decisions/0030-read-through-request-content-inspector.md)、[ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

## 1. 背景

Phase 25 已经能够把 canonical Request 对应的本地 rollout **Observed Interaction Slice** 投影成可读 Dialog，并严格保持：

- `Observed Interaction != Provider Request Body`；
- 正文 read-through、ephemeral、no-store；
- SQLite metadata-only；
- Request / Token / Cost / Diagnostics accounting 不变。

真实使用后暴露出两个语义层问题：

1. 顶部指标写作 `Input` / `Cached`，下方又直接出现 `User` Card，用户容易把“21.11 万 Input Tokens”误解为“当前 User Card 就是完整模型输入”；
2. rollout 可能在同一 Request slice 中记录多个不同 reasoning item，但公开 `summary` 文本完全相同。当前 projector 一条 record 对应一张 Card，会产生视觉重复。

此外，`turn_context` 已在真实 rollout 中明确记录 model、effort、cwd、workspace roots、timezone、approval/sandbox/personality/collaboration 等运行时上下文，但 Phase 25 V1 目前不展示这些事实。

Phase 25.1 的目标不是重建完整输入，而是**修正 Inspector 的阅读语义，让“计量指标、当前可观察输入、运行时上下文、模型/工具交互”彼此不再混淆**。

## 2. 核心目标

Phase 25.1 必须完成：

1. 将顶部 `Input / Cached / Output / Total` 明确改为 Token accounting 语义；
2. 在当前 Request slice 中识别一个保守的 **pre-model evidence cut**；
3. 单独展示 **Observed Input Evidence / 本轮可观察输入证据**；
4. 单独展示 **Runtime Context / 运行时上下文**；
5. 其余 reasoning / assistant / tool interaction 保持可读 chronology；
6. identical reasoning summary 在 semantic projection 层去重，但保留 occurrence evidence；
7. Tool Result 无法在当前 slice 内关联 Tool Call 时，只使用 callId fallback，不跨 canonical boundary 回读；
8. 不新增正文持久化、schema、Provider payload claim 或 token 猜测。

## 3. 非目标

Phase 25.1 **不**做：

- 不重建完整历史上下文；
- 不声称获得 Provider Input；
- 不根据 `inputTokens - cachedInputTokens` 估算“本轮新增正文 token”；
- 不从 model 行为反推 system/developer prompt；
- 不把 Tool Result 自动宣称为当前 Request 的真实 provider input；
- 不解密 reasoning；
- 不提供 Raw JSON；
- 不修改 canonical Request identity / ownership / pricing / diagnostics；
- 不新增 Request Content 正文缓存。

完整历史输入的可读重建属于 [Phase 26 Reconstructed Input Context](DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md)。

## 4. 术语

### 4.1 Input Tokens

`canonical_requests.input_tokens` 是计量事实，表示该 canonical Request 的 input token accounting。

它可能包含历史会话上下文、cached context、当前 user/tool input、harness/provider 注入但 rollout 未逐项复制的上下文，以及最终 serialization 的其他细节。

因此 UI 必须写作 **Input Tokens**，不能通过当前 slice 的一张 User Card解释全部 Input Tokens。

### 4.2 Observed Input Evidence

Phase 25.1 把当前 slice 中、位于第一条明确 model-output evidence 之前的可读 record 称为：

> **Observed Input Evidence / 本轮可观察输入证据**

它是“在本地 rollout 中可证明先于本轮可观察模型输出出现的输入/上下文信号”，不是完整 Provider Input。

### 4.3 Pre-model evidence cut

在当前 Observed Interaction Slice 内，第一条下列 model-output evidence 定义为 cut：

- `response_item/reasoning`；
- assistant/agent model message；
- `custom_tool_call` / `function_call`。

cut 之前的可公开 evidence 可以进入 `Observed Input Evidence`；cut 本身及之后进入 `Observed Interaction`。

该 cut 只能说明**本地记录顺序**。它不能被命名为“Provider request start”。

若当前 slice 没有可证明的 model-output evidence，则 `preModelCut.status=unavailable`，UI 不把整个 slice 强行标成 Input。

## 5. UI 信息架构

Dialog 建议固定为四层：

```text
Request Header
  └─ Rollout observed interaction · Provider payload unavailable / not reconstructed

Request Metrics
  ├─ Input Tokens
  ├─ Cached Input Tokens
  ├─ Cache Hit Rate
  ├─ Output Tokens
  ├─ Total Tokens
  └─ USD

Observed Input Evidence
  ├─ User / Developer / System message（仅明确记录）
  ├─ Tool Result（仅在 cut 之前且明确记录）
  └─ evidence note

Runtime Context
  └─ collapsed allowlisted fields

Observed Interaction
  ├─ Reasoning summary/activity
  ├─ Assistant
  ├─ Tool Call
  ├─ Tool Result / Environment return
  └─ Context Signal
```

### 5.1 Metrics 文案

必须改为：

```text
Input Tokens
Cached Input Tokens
Cache Hit Rate
Output Tokens
Total Tokens
USD
```

Metrics 下增加固定说明：

> Token 指标表示本次 Request 的计量规模；下方只展示 rollout 中直接可观察的输入/交互证据，不等于完整 Provider Input。

### 5.2 Observed Input Evidence

此区默认展开。

支持：

- `message(role=user)`；
- 明确存在的 `developer/system` message；
- cut 之前的 Tool Result；
- cut 之前其他安全语义化 input-like context signal。

不支持：

- 根据 token 数生成伪 input；
- 从上一 Request 偷读 Tool Call/Result；
- 把 cut 之后的 Tool Result 自动归入当前 Request Input。

若没有直接 input evidence，显示：

> 当前 slice 未记录可直接展示的 pre-model input；完整输入可能来自历史上下文或未在此处逐项记录的 provider/harness context。

### 5.3 Runtime Context

Runtime Context 使用折叠 Card，来源只允许当前 slice 中明确 `turn_context` record。

首版 allowlist：

- model；
- effort；
- current date；
- timezone；
- cwd；
- workspace roots；
- approval policy；
- sandbox policy；
- active permission profile；
- personality；
- collaboration mode。

不直接公开 raw `turn_context` JSON、未知字段、encrypted/opaque body 或被误解为 prompt 的内部 hash。

Runtime Context Card 必须注明：

> Observed runtime metadata; not a system/developer prompt dump.

## 6. Reasoning semantic dedupe

### 6.1 问题

真实 Request 已观测到：同一 slice 中存在两条不同 reasoning record，record id 不同，但公开 summary 的 normalized text 完全一致。

这种情况下逐 record 渲染会出现两个相同 `Reasoning summary` Card，用户无法判断是前端 bug 还是不同 reasoning 阶段。

### 6.2 去重规则

去重必须发生在 server semantic projector，而不是 DOM 层。

只合并**相邻 semantic reasoning items**，其中允许中间跨过不产生用户可见 item 的 lifecycle record。

规则：

1. 两个 item 都有公开 summary text；
2. normalized summary 完全一致；
3. 两者之间没有其他用户可见 semantic item；
4. `opaqueContentPresent` 不用于推断正文等价，只作为存在性 metadata；
5. 合并后保留 `occurrenceCount >= 2`。

建议 shape：

```js
{
  kind: "reasoning_summary",
  text: "...",
  opaqueContentPresent: true,
  occurrenceCount: 2
}
```

UI 显示：

```text
Reasoning summary                     2 equivalent summary records
```

不能静默删除 evidence。

### 6.3 无公开 summary 的 opaque reasoning

多个连续 opaque reasoning record 没有公开 summary 时，不能声称其内容相同。

可聚合为：

```text
Reasoning activity                    2 opaque records
```

但文案不得写 `2 equivalent summaries`。

## 7. Public projection contract

Phase 25.1 建议将 Request Content response `version` 从 `1` 升为 `2`，因为 item grouping/section 语义、reasoning occurrence semantics 与 runtime context 都发生了公开 contract 变化。

建议：

```js
{
  version: 2,
  request: { ... },
  evidence: { ... },
  preModelCut: {
    status: "observed" | "unavailable",
    kind: "before_first_observed_model_output" | null,
    lineNumber: 481 | null
  },
  items: [
    {
      kind: "message",
      section: "observed_input",
      role: "user",
      text: "..."
    },
    {
      kind: "runtime_context",
      section: "runtime_context",
      fields: [ ... ]
    },
    {
      kind: "reasoning_summary",
      section: "observed_interaction",
      text: "...",
      occurrenceCount: 2
    }
  ]
}
```

`section` 由 server projector 决定，避免 `public/app.js` 理解 rollout record type 或自行推断 pre-model cut。

## 8. Tool Result 关联

Phase 25 已冻结 strict slice：当前 slice 内 Tool Result 对应的 Tool Call 若位于上一 canonical boundary 之前，不跨 boundary 回读。

Phase 25.1 保持该规则。

Tool Result public shape 可保留 `tool="unknown_tool" + callId`，UI label fallback 使用：

```text
Result · call_abc…123
```

而不是把 `unknown_tool` 当成有意义的工具名展示。

## 9. Privacy / Persistence

Phase 25.1 不改变 ADR-0030：

- 不新增正文 DB 列/table；
- 不记录 runtime context/body 到日志；
- 不进入 Session/Day snapshot 或 SSE；
- 浏览器只保留当前 Dialog payload；
- close/scope switch 后清理；
- absolute rollout path 不进入 public response；
- workspace/cwd 仅来自本地 explicit `turn_context` 且只在用户主动打开 Inspector 时 ephemeral 返回。

## 10. 性能

Phase 25.1 不改变 Phase 25 两阶段 bounded reader：

- locator：`12 MiB/侧`；
- total locator：`24 MiB`；
- interaction slice：`4 MiB`；
- max records：`500`；
- per item：`64 KiB`；
- projected body：`512 KiB`。

新增 runtime context / dedupe 必须只在已经读取的当前 slice 上做 O(n) semantic pass，不触发第二次历史 scan。

性能 Gate：common Request P95 仍 `<100ms`；slow-path / near-limit P95 仍 `<250ms`；dedupe 不增加额外 source I/O；UI 不复制正文 payload。

## 11. Failure / Coverage

沿用 Phase 25 的 source/boundary/parse/truncation coverage。

新增 pre-model cut 状态只是 presentation evidence state：

```text
preModelCut.status = observed | unavailable
```

它不替代 Request Content coverage。

## 12. 验收标准

Phase 25.1 交付时以下条件均已满足，状态因此为 `Implemented / Verified`：

- `Input` 改为 `Input Tokens`；
- User Card 明确位于 `Observed Input Evidence`，且有“不是完整 Provider Input”提示；
- Runtime Context 只展示 allowlist；
- identical reasoning summary 不再生成重复 Card，并显示 occurrence evidence；
- 不同 reasoning summary 保持独立；
- opaque-only reasoning 只聚合 record count，不宣称内容相同；
- Tool Result 跨 boundary 时继续 callId fallback；
- no schema / no persistence / no accounting regression；
- unit / DB/API / UI security / Chrome/CDP / performance / fingerprint 全部 Green。

