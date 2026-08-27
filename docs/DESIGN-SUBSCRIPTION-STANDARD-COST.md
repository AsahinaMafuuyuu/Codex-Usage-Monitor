# Subscription Standard-Rate Cost 设计说明

**状态：** Implemented

**设计日期：** 2026-08-26

**关联决策：** [ADR-0019](decisions/0019-request-level-subscription-standard-cost.md)

**测试门槛：** [TEST-SUBSCRIPTION-STANDARD-COST.md](TEST-SUBSCRIPTION-STANDARD-COST.md)

## 1. 目标

当前 `src/pricing.js` 在 Task 已经汇总后，用一张“当前标准 API 短上下文”价目表估算 USD。这种做法无法正确表达以下事实：

1. 用户主要使用 ChatGPT/Codex 订阅，而不是直接按 API 发票结算；GPT-5.6 Sol 的临时 API/token-based 促销不会改变 included plan usage、5 小时/周限额或 legacy metering。
2. 模型价格会随时间变化，例如 GPT-5.6 Terra/Luna 在 2026-07-30 降价，且官方明确说明该变化会反映到 Codex / ChatGPT Work 的付费订阅 usage 计量。
3. 长上下文以**单次请求**的 input 是否 `>272K` 为判定条件，满足后整个请求的 input/cached input 使用 2×、output 使用 1.5×；不能用一个 Task 的累计 input 判定。
4. Fast mode 是按请求生效的附加计费条件，不能只在 Task/Session 汇总层猜测。
5. 当前 Request Ledger 已保存逐 usage-unit 的 input/cached/output，因此 Token 事实层无需推翻；需要重构的是 Cost 的计算粒度和 pricing context。

本阶段把页面中的 USD 重新定义为：

> **Subscription Standard-Rate Equivalent（订阅标准价等值）**：按照事件发生当时可复核的 Codex/ChatGPT Work 标准模型价及可证明的 feature multiplier，对 verified Request Ledger usage 计算的参考美元等值。它用于比较订阅使用价值，不是 Plus 实际账单，也不声称可以从美元反推 5 小时/周额度。

## 2. 官方证据基线

设计冻结时使用以下官方事实：

- GPT-5.6 初始标准价：Sol `$5/$0.50/$30`、Terra `$2.50/$0.25/$15`、Luna `$1/$0.10/$6`，均为每 1M input/cached/output token；GPT-5.6 cache read 为 90% discount。来源：OpenAI 2026-06-26 / 2026-07-09 GPT-5.6 发布资料。
- 2026-07-30 起 Terra 变为 `$2/$0.20/$12`，Luna 变为 `$0.20/$0.02/$1.20`；官方明确说明 Terra/Luna 的降价也会让 Codex / ChatGPT Work 付费订阅消耗更少 credits。
- 2026-08-21 Sol 的 `$4/$0.40/$20` 是临时 token-based USD 促销；官方明确说明 included plan usage、5-hour/weekly limits 和 legacy credit rates 不变。因此本项目的**订阅标准价等值 policy 不把该促销作为 Sol 的切价点**，仍使用 `$5/$0.50/$30` 作为 Sol standard-rate equivalent，直到有官方证据表明 legacy/included-plan 标准发生变化。
- Codex/Work 长上下文 `input > 272K`：input 2×、cached input 2×、output 1.5×；应用于 GPT-5.6、GPT-5.5、GPT-5.4。
- Codex/Work Fast：GPT-5.6 2.5×、GPT-5.5 2.5×、GPT-5.4 2×标准费率。
- 官方 Fast FAQ 当前明确说明 Fast mode 不支持 long context；因此同一 usage unit 同时被证明为 Fast 和 long-context 时，不做倍率叠乘，而作为 pricing evidence 冲突处理。

官方来源：

- https://openai.com/index/previewing-gpt-5-6-sol/
- https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
- https://help.openai.com/en/articles/20001415
- https://help.openai.com/en/articles/11647665
- https://developers.openai.com/api/docs/models/gpt-5.6-sol

任何后续价格、支持模型、threshold 或 multiplier 变化都必须新增有效期记录和回归测试，不允许覆盖历史事实。

## 3. 不变量

以下现有工程不变量继续成立：

1. `.codex` 严格只读，不为了补价格或 feature metadata 修改 rollout/config/state。
2. verified Request Ledger 仍是唯一 Token 事实源；不恢复 Boundary Ledger，不裸累加 `last_token_usage`。
3. `verified_increment` / `generation_start` 才能进入精确 usage；duplicate 不增量；unverified/anomaly 不补数。
4. Pricing 不得反向修改 Token Ledger 的 usage 数字或质量分类。
5. reasoning tokens 已包含在 output token 中，不额外收费一次。
6. 未知模型、未知历史价、无法证明的 feature 或冲突 evidence 必须显式降低 cost coverage，不能选择“最像的价格”。
7. USD 是订阅标准价**等值**，不是 Plus 实际扣款、不是 quota 百分比换算、不是 API invoice。

## 4. 两层账本模型

### 4.1 Token Ledger：保持现状

Request Ledger 继续保存每个 verified usage unit：

```text
model_usage_event
  identity: sourceKey + lineNumber
  attribution: rootSessionId + threadId + turnId
  observedAt
  classification
  usage:
    inputTokens
    cachedInputTokens
    cacheWriteInputTokens
    outputTokens
    reasoningOutputTokens
    totalTokens
```

Token 层只回答：**“这里能证明新增了多少 usage？”**

### 4.2 Pricing Ledger：新增派生职责

Pricing 层回答：**“这个已验证 usage unit 在当时的模型和可证明 feature 条件下，按订阅标准价等值是多少？”**

概念结构：

```text
Verified Request Ledger usage unit
        +
Pricing Context as-of event
  ├─ model
  ├─ observedAt
  ├─ serviceTier
  └─ evidence quality
        +
Historical Rate Resolver
        +
Feature Policy
  ├─ longContext
  └─ fast
        ↓
Request Cost Estimate
        ↓ Σ
Task Cost
        ↓
Agent own/subtree Cost
        ↓
Session / Day / Timeline Cost
```

费用仍然不持久化为一个会过期的最终美元金额；持久化的是重算所需的最小 pricing metadata，金额由当前代码按明确 policy/version 确定性派生。

## 5. “Request”语义与长上下文证据门槛

现有 `model_usage_events` 的 verified unit 来自 `total_token_usage` 与 `last_token_usage` 的逐字段相邻验证。项目当前只承诺它是**verified model usage unit**，不承诺一定与 HTTP request / 服务端 billing request 一一对应。

因此长上下文实现必须分两步：

1. 保留 event 级 usage，不允许先汇总 Task 再判断 272K。
2. 在正式把 `event.usage.inputTokens > 272000` 当作 billing long-context 判据前，必须通过 Codex 官方源码/文档或可重复 fixture 证明 `last_token_usage` 对应一个可用于该阈值的模型请求 usage 单元。

若第二步证据尚未达到门槛：

- 可以暴露 `longContextCandidate=true`；
- 不得把候选倍率静默计入完整 cost；
- cost coverage 必须说明 `long_context_request_boundary_unproven`。

一旦证据门槛通过，规则固定为：

```text
longContext = request.inputTokens > 272_000
```

注意边界是严格 `>`，所以 `272000` 为普通、`272001` 才进入长上下文。

## 6. 长上下文费用算法

长上下文不是新的 token 类型；仍使用同一 request usage 的 input/cached/output，只改变费率。

普通请求：

```text
uncachedInput = inputTokens - cachedInputTokens
cost = uncachedInput × inputRate
     + cachedInput × cachedInputRate
     + outputTokens × outputRate
```

长上下文请求：

```text
cost = uncachedInput × inputRate × 2
     + cachedInput × cachedInputRate × 2
     + outputTokens × outputRate × 1.5
```

这里的 multiplier 作用于**整个该请求**，不是只作用于超过 272K 的部分。

### 6.1 cache-write 的处理

当前 API-equivalent estimator 对 GPT-5.6 `cacheWriteInputTokens` 使用 API 文档的 1.25× uncached-input 规则。本阶段改成 subscription-standard policy 后，不再默认把 API cache-write surcharge 搬进订阅等值。

Codex/Work token rate card 的标准公式只列 `input + cached input + output`。因此第一版 subscription policy：

- `cacheWriteInputTokens` 继续保留用于审计和一致性检查；
- 它作为 `inputTokens` 中非 cached input 的组成部分，按普通 input rate（长上下文时按 long-context input rate）计价；
- 只有未来出现明确的 Codex subscription/legacy metering cache-write surcharge 官方证据，才新增独立 feature rule。

该变化必须通过 fixture 证明不会把 cache-write 既算 input 又再次收费。

## 7. Historical Rate Resolver

价目表从“一个当前 RATE_CARD”升级为**带有效期的不可变历史目录**。

概念数据：

```js
{
  policy: "subscription-standard-equivalent",
  model: "gpt-5.6-terra",
  effectiveFrom: "2026-07-30T00:00:00Z",
  effectiveUntil: null,
  ratesPerMillion: {
    input: 2,
    cachedInput: 0.2,
    output: 12
  },
  sourceUrl: "...",
  evidence: "official"
}
```

Resolver 使用 `model + event.observedAt` 选中唯一有效记录。禁止使用“当前价格回算所有历史”。

### 7.1 已冻结的 GPT-5.6 历史节点

| 有效期 | Sol standard-equivalent | Terra | Luna |
|---|---:|---:|---:|
| 2026-07-09 ～ 2026-07-29 | `$5 / $0.50 / $30` | `$2.50 / $0.25 / $15` | `$1 / $0.10 / $6` |
| 2026-07-30 起 | `$5 / $0.50 / $30` | `$2 / $0.20 / $12` | `$0.20 / $0.02 / $1.20` |

Sol 2026-08-21 的 API/token-based promotion 不切换本 policy 的 Sol standard-equivalent；目录可记录该外部事件用于解释，但不能让 `subscription-standard-equivalent` resolver 选择 `$4/$0.40/$20`。

### 7.2 历史模型

至少覆盖数据库和真实 rollout 已出现、且能取得官方标准价证据的模型：

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.4`

后续可加入当前 Codex rate card 中的 `gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.2`、Daybreak 等，但必须同时给出有效期和官方来源。

内部 alias（例如历史 `codex-auto-review`）不得永久猜映射。只有官方材料/rollout metadata 能证明**该日期**使用某个具体 billed model 时，才用带有效期 alias mapping；当前官方 rate card 说明 Auto Review 使用 GPT-5.4、Code Review 使用 GPT-5.3-Codex，只能从可证明的生效区间开始映射。

## 8. Pricing Context 与 Fast

Fast 是按 request 生效的 feature，因此 `serviceTier` 必须与 usage event 处于相同时间线。

真实 rollout 已观察到 `thread_settings_applied.thread_settings.service_tier = "default"`。实现不能只把 service tier 存在 Task 上，因为同一 thread 的设置可能在运行中改变。

建议为每个新 `model_usage_event` 持久化最小 pricing metadata：

```text
model
service_tier
pricing_context_quality
```

其中 `model` 优先来自该 event 所属 turn 的有效 `turn_context`；`service_tier` 使用该 ordinal 之前最近一次已证明的 `thread_settings_applied` 设置。

规范化：

```text
default          -> standard
fast             -> fast
priority         -> fast   # 官方 Fast FAQ：Priority 已重命名为 Fast
missing/unknown  -> unknown
```

Fast multiplier：

| Model family | Fast multiplier |
|---|---:|
| GPT-5.6 | 2.5× |
| GPT-5.5 | 2.5× |
| GPT-5.4 | 2× |

只在 service tier 被 event-level evidence 证明时应用；unknown 不默认当 Fast，也不默认声称“已完整估算 feature cost”。

## 9. Fast 与 Long Context 的组合

当前官方 Fast FAQ 明确说明 Fast mode **不支持 long context**。因此设计不允许：

```text
long-context multiplier × fast multiplier
```

如果同一个 pricing unit 同时被证明为：

```text
input > 272K
serviceTier = fast/priority
```

则标记：

```text
pricing_status = unavailable/partial
reason = unsupported_feature_combination
```

并保留原始 usage/evidence 供审计。未来只有官方规则明确支持组合后，才新增新的 policy version 和测试；不得静默改变旧历史费用。

## 10. Cost Coverage

建议 Request cost 结果至少包含：

```js
{
  status: "estimated" | "partial" | "unavailable",
  amountUsd,
  basis: "subscription-standard-equivalent",
  policyVersion,
  model,
  rateVersion,
  observedAt,
  serviceTier,
  longContextStatus: "normal" | "long" | "candidate" | "unknown",
  featureCoverage: {
    historicalRate: "verified" | "unavailable",
    requestBoundary: "verified" | "unproven",
    serviceTier: "verified" | "unknown"
  },
  components,
  limitations,
  reason
}
```

Task/Agent/Session 的 aggregation 继续采用“已知金额 + unavailable count”语义：

- 全部 request pricing units 可估算：`estimated`。
- 一部分可估、一部分不可估：`partial`，金额只是已知下限。
- 无任何可估金额：`unavailable`。

页面即使继续只显示 `$xx.xx`，title/coverage 必须能解释当前是否有历史价、长上下文或 Fast evidence 缺口。

## 11. Day Scope 与 Timeline

Phase 16 的 event-observed day 语义保持不变。

费用必须先按 event 计算，再按同一个 `observedAt` 进入日期：

```text
Request Event Cost
  -> Task Day Slice
  -> Session Day
  -> Month
```

不能先把完整 Task cost 算好，再按 `task.startedAt` 或 task 总 token 分摊到日期。

因此：

```text
Σ day request costs == full-session request costs
```

必须在相同 coverage 范围内成立。

## 12. Schema / Migration 方向

预计需要 schema v13，但实现阶段以最小必要字段为准。

推荐新增到 `model_usage_events` 的字段：

- `model`
- `service_tier`
- `pricing_context_quality`

不新增最终 `amount_usd` 持久化列；Historical Rate Catalog 仍是版本控制中的代码/数据事实。

迁移原则：

1. 已持久化 event usage/observedAt 不重算、不改值。
2. event model 若能从 task/turn 身份唯一证明，可直接 backfill。
3. 历史 service tier 当前未落库；若原 rollout 仍存在，可以做一次**只读 metadata enrichment replay**，仅提取 pricing context，不改变 Token Ledger classification/usage。
4. 原 rollout 不存在时，service tier 保持 unknown；不得默认 `default`。
5. enrichment 前后原 rollout SHA-256 必须不变。

## 13. 实施拆分

建议顺序：

1. **冻结 Historical Rate Catalog + policy tests**：先让日期选价和 Sol promotion exclusion 可重复验证。
2. **建立 Request Cost Engine**：以单个 verified event 为输入，不动 Token Ledger 聚合。
3. **验证 long-context request boundary**：先证明 usage unit 与官方 threshold 的适用边界，再启用 multiplier。
4. **采集 event-level pricing context**：model/service tier as-of ordinal；完成 v13 enrichment。
5. **重建 Task/Agent/Session/Day cost aggregation**：只求和 Request Cost，不再从 Task aggregate 直接计费。
6. **UI/API 文案迁移**：从 API-equivalent 改成 subscription-standard-equivalent，并暴露 coverage。
7. **真实历史 reconciliation**：对比旧 estimator、新普通价、历史价、long-context/Fast feature adjustment 各自造成的差额。

## 14. 明确不做

本阶段不做：

- 从 5 小时/周 quota 百分比反推美元。
- 将 `$` 称为 Plus 实际账单。
- 对没有 service tier evidence 的历史请求猜 Fast。
- 对 Task 累计 input `>272K` 直接套长上下文倍率。
- 对未知模型采用同系列最近模型价。
- 把 API Sol 临时促销价混入 subscription-standard policy。
- 在没有官方组合规则时叠乘 Fast + long context。
- 计入 regional processing、web search、image/voice/tool fee；这些可作为后续独立 feature policy 扩展。

## 15. 完成定义

只有同时满足以下条件，Phase 17 才能从“设计完成”进入“实现完成”：

1. 历史价格有效期和历史模型 fixture 全部通过。
2. Request Cost Engine 不改变任何 verified Token Ledger 数值。
3. 长上下文只按单 usage unit/request evidence 判定，272K 边界正确。
4. Fast 只在 event-level service tier 有证据时应用。
5. Fast + long context 不被错误叠乘。
6. Full Session / Day / Timeline 费用守恒。
7. 旧数据库迁移不丢 token evidence，且只读 enrichment 不修改 `.codex`。
8. 页面和 API 不再把结果描述为实际订阅扣费或 API invoice。
