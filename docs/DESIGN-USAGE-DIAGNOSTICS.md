# Phase 23：Usage Diagnostics 设计方案

**状态：** Implemented / Verified
**日期：** 2026-09-01
**依赖：** ADR-0015、ADR-0019、ADR-0020、ADR-0021、ADR-0023、ADR-0026

## 1. 目标

当前 Codex Usage Monitor 已经能可靠回答“发生了多少 Request、消耗了多少 Token、缓存命中率是多少、订阅标准价等值是多少”。Phase 23 的目标是进一步回答：

- 为什么某次 Request / Task / Session 明显变贵；
- 从哪一个 Request 开始出现上下文膨胀；
- 从哪一个 Request 开始出现缓存命中率断崖式下降；
- 哪些 Request 触发了已知的长上下文计价条件；
- 异常结论由哪些 canonical Request 事实支持。

本阶段不把监控器改造成 LLM 分析器，也不读取 Prompt / Response 正文。诊断必须是**确定性、可解释、可重建、可审计**的派生结果。

## 2. 核心领域模型

事实层与解释层必须严格分离：

```text
Rollout raw evidence
  -> verified Request Ledger evidence
  -> canonical_requests                # 发生了什么：唯一计量事实
  -> request-level pricing result       # 现有 pricing policy
  -> Diagnostic Fact Builder
  -> Usage Diagnostics Engine           # 这些事实意味着什么
  -> Diagnostic Findings
      -> Session diagnostics summary
      -> Task finding
      -> Request evidence locator
```

长期不变量：

1. `canonical_requests` 继续是 Token / Request / Cost projection 的唯一业务事实源；Diagnostics 不得修改其 accounting 语义。
2. Diagnostics 只消费 canonical Request，不把 `inherited_copy` 当成新的异常样本。
3. Diagnostics 不重新实现 pricing；Cost Spike 必须消费 `src/pricing.js` 的 request-level cost 结果。
4. Diagnostics 不读取、不持久化 Prompt、Response、消息正文或会话标题。
5. Diagnostics 不调用模型、不访问新的远端接口；账号 Usage 网络例外仍只受 ADR-0025 约束。
6. 诊断算法变化只能改变派生 finding，不能改变历史 Token / Cost / Request accounting。

## 3. 为什么不能只使用固定阈值

固定阈值可以表达明确产品事实，例如 `inputTokens > 272000`；但不能单独判断“异常”。同一个 200K Input Request 在长上下文任务中可能正常，在常规 coding session 中则可能是明显膨胀。

因此诊断分三层：

| 层级 | 用途 | V1 |
|---|---|---|
| Explicit Rule | 表达已有明确业务/计价事实 | 启用 |
| Local Baseline | 与同一 Task / Session 前序 Request 比较 | 启用 |
| Historical Cohort Baseline | 与同项目、模型、effort 历史比较 | 后续阶段 |

V1 优先解决“当前 Request 序列何时发生结构性变化”，而不是提前建立复杂的全局统计模型。

## 4. V1 诊断类型

第一阶段只冻结四类高价值诊断：

| Type | Scope | 主要事实 | 目的 |
|---|---|---|---|
| `context_inflation` | Request | `inputTokens` | 检测上下文输入异常增长 |
| `cache_regression` | Request | `cachedInputTokens / inputTokens` | 检测缓存效率显著下降和 breakpoint |
| `cost_spike` | Request | request-level USD equivalent | 检测单 Request 成本相对近期基线异常升高 |
| `long_context_trigger` | Request | `inputTokens > 272000` + pricing evidence | 显示已知长上下文计价条件 |

以下方向明确延期：

- Project historical baseline / percentile / MAD cohort；
- Reasoning-heavy；
- Request burst；
- Subagent amplification；
- 跨 Session regression；
- 自动通知和预算阈值。

## 5. Local Baseline

### 5.1 顺序

诊断序列必须使用 canonical Request 的稳定顺序：

```text
(observed_at ASC, request_id ASC)
```

不得使用 rollout line number、source path 或复制后的 envelope timestamp 作为业务顺序。

### 5.2 基线窗口

V1 默认使用前序 `5` 个可比较 Request 的 rolling median：

```text
baseline(x_i) = median(x_(i-5) ... x_(i-1))
```

至少存在 `3` 个有效前序样本后才允许生成基于 Local Baseline 的 warning；样本不足时保持 `insufficient_baseline`，不能把首批 Request 判成异常。

Median 优先于 mean，因为 token / cost 序列具有明显长尾，单个超大 Request 不应永久污染后续基线。

### 5.3 Scope invariant 与 Day baseline 连续性

同一个 canonical Request 在相同 `policyVersion` 下必须得到相同诊断结论，不得因为调用方选择 Session scope 或 Day scope 而改变 baseline 语义。

因此 Day diagnostics **只限制 finding 的输出范围，不截断历史 baseline**：

```text
analysis input: canonical requests with observedAt < dayEnd
baseline: may consume comparable requests before dayStart
output: findings whose current request is within [dayStart, dayEnd)
```

禁止在本地午夜把 rolling baseline 重置为零。否则当天第一个 Request 会在 Session 查询下有充分 baseline、在 Day 查询下却变成 `insufficient_baseline`，并破坏 deterministic finding identity。

## 6. Context Inflation

### 6.1 指标

只比较 `inputTokens`，不使用 `totalTokens` 代替上下文规模：

```text
baselineInput = median(previous comparable request inputTokens)
absoluteGrowth = currentInput - baselineInput
growthRatio = currentInput / baselineInput
```

### 6.2 V1 初始 policy

产生 `warning` 必须同时满足：

```text
growthRatio >= 1.35
AND absoluteGrowth >= 32768
AND baselineSampleCount >= 3
```

产生 `high`：

```text
growthRatio >= 2.0
AND absoluteGrowth >= 65536
```

这些数值属于 `DIAGNOSTIC_POLICY_VERSION`，必须通过 fixture 和真实历史 shadow report 验证后才能视为稳定 policy；未来调整 policy 不得修改 canonical accounting。

### 6.3 Evidence

finding 至少保存/返回：

- current input；
- baseline input；
- absolute / relative delta；
- baseline sample count；
-当前 request locator；
-前序 baseline window 的 request ids（可只在 detail 响应返回）。

## 7. Cache Regression / Cache Breakpoint

### 7.1 指标

统一沿用现有 cache-hit 定义：

```text
cacheHitRate = cachedInputTokens / inputTokens
```

仅在 `inputTokens > 0`、cached 字段有效且 `cachedInputTokens <= inputTokens` 时计算。

### 7.2 噪声门槛

小 Request 的比例波动没有足够意义。V1 默认只对：

```text
inputTokens >= 8192
```

的 Request 做 cache regression 判断。

### 7.3 V1 初始 policy

```text
baseline = median(previous comparable cacheHitRate)
drop = baseline - current

warning:
drop >= 0.20
AND baselineSampleCount >= 3

high:
drop >= 0.40
AND baselineSampleCount >= 3
```

这里的 `0.20 / 0.40` 是 percentage-point drop，不是相对百分比。

### 7.4 Breakpoint

第一个满足 warning/high 的 Request 记为候选 breakpoint。若其后连续 Request 仍明显低于前序基线，则报告可升级为稳定 `cache_breakpoint` evidence；V1 UI 至少应能明确定位首次显著下降 Request。

Diagnostics 不尝试从 token 数值猜测“具体哪段 Prompt 被改了”。没有正文 evidence 时只能报告缓存现象，不能虚构根因。

## 8. Cost Spike

### 8.1 唯一费用来源

每条 canonical Request 必须继续调用现有：

```text
estimateRequestCost(request)
```

Diagnostics 只读取其 `status / amountUsd / feature evidence`。不得复制历史价目、Fast multiplier、long-context multiplier 或 cache pricing 逻辑。

### 8.2 比较条件

V1 明确冻结为：**只有 `costEstimate.status === "estimated"` 的 Request 才能作为当前 Cost Spike 判定对象并进入 baseline。**

`partial` 可以保留 `amountUsd` 作为 pricing evidence 展示，但不得参与 warning/high 判定或完整 baseline；`unavailable` 同样不参与。原因是 `partial` 可能表示 feature combination、boundary 或模型支持证据不足，此时金额不能被当作完整可比较事实。

V1 建议：

```text
costGrowthRatio >= 1.75
AND absoluteCostGrowth >= $0.05
AND baselineSampleCount >= 3
```

判定 warning；`>= 3.0` 可判 high。

### 8.3 解释因子

Cost Spike finding 应同时给出可证明的伴随变化：

- input token delta；
- cache-hit delta；
- long-context status；
- service tier / Fast status；
- request-level pricing status。

这些是 evidence factors，不应在 V1 中强行生成“唯一根因”。例如 Cache 降低和 Input 增长同时出现时，应并列展示。

## 9. Long Context Trigger

该 finding 是显式事实，不依赖历史基线，但 **Diagnostics 不维护第二份 272K pricing policy**。

`pricing.js` 必须作为唯一 feature-policy seam 暴露 long-context candidate / status；Diagnostics 只消费该结果。当前阈值语义仍为：

```text
inputTokens > 272000
```

但 UI 必须使用现有 pricing evidence 区分：

- `long`：已有 request boundary + model support，可证明应用 long-context policy；
- `candidate/unknown/partial`：满足 token 阈值但 pricing evidence 不足或组合不支持；
- 不得仅因 Input >272K 就宣称“已实际扣费 X 倍”。

如果 pricing 无法形成完整历史价格，仍应由 pricing seam 暴露 `candidate/unknown`，而不是让 Diagnostics 自己重新实现 `inputTokens > 272000` 判断逻辑。

## 10. Severity 与 Finding 数据模型

V1 severity：

```text
info | warning | high
```

建议结构：

```js
{
  findingId,
  type: "cache_regression",
  severity: "warning",
  scope: "request",
  rootSessionId,
  threadId,
  turnId,
  requestId,
  observedAt,
  metric: {
    name: "cache_hit_rate",
    current: 0.478,
    baseline: 0.912,
    absoluteDelta: -0.434,
    relativeDelta: null
  },
  baseline: {
    kind: "task_rolling_median",
    sampleCount: 5
  },
  locator: {
    requestOrdinalInScope: 17
  },
  evidence: {},
  policyVersion: "usage-diagnostics-v1"
}
```

后端返回结构化 reason/evidence；中文标题和解释由 UI 根据 `type + evidence` 渲染，不把整段展示文本持久化。

`locator.requestOrdinalInScope` 用于复用现有 Canonical Request 分页器进行精确定位。前端可以由 ordinal 与当前 page size 计算目标页，再使用 `requestId` 滚动并高亮目标行；不得为 Diagnostics 再实现第二套 Request viewer。

## 11. Scope 与 baseline 隔离

V1 Local Baseline 优先按同一 Task 的 Request 序列建立。如果 Task 样本不足，可回退到同 Session、同 model、同 effort 的前序 Request；回退必须通过 `baseline.kind` 显式说明。

禁止：

- 把不同 model 的 token/cost 序列无条件混合；
- 把 Fast 与 standard cost 无条件混合作为费用基线；
- 把不同项目的历史混成全局 baseline；
- 使用未来 Request 参与当前 Request 的实时异常判断。

Historical cohort 的推荐 key 为：

```text
projectPath -> model -> effort
```

但该能力不进入 V1。

## 12. API / UI 设计

Diagnostics 不进入初始大型 Session snapshot 的完整 detail，避免再次放大 SSE payload。

建议只读接口：

```text
GET /api/sessions/:id/diagnostics
GET /api/sessions/:id/diagnostics?day=YYYY-MM-DD
```

响应：

```json
{
  "summary": { "high": 1, "warning": 4, "info": 2 },
  "policy": { "version": "usage-diagnostics-v1" },
  "findings": []
}
```

V1 **不把 `diagnosticSummary` 加入常规 Session/SSE snapshot**。由于 V1 diagnostics 是 compute-on-read，如果 snapshot 为了 summary 每次执行完整分析，就会把 O(N) diagnostics 带入现有 SSE 热路径。

Session 页面在初始 snapshot 完成后异步读取 diagnostics；panel 已加载时，在 `projectionGeneration` 变化后按需刷新 diagnostics。finding detail 与 summary 都走同一个 lazy diagnostics read path。

UI 推荐链路：

```text
Usage Diagnostics summary
  -> finding list
  -> Task
  -> canonical Request
  -> existing Request audit detail
```

Request 行只使用轻量 badge（如 warning count / severity），不能用大面积红色覆盖既有审计表。

## 13. Persistence 策略

### V1

**不新增 SQLite schema。** Diagnostics 按需从已持久化 canonical Request projection 计算：

- 算法处于初始验证期，避免 schema v15 被实验性阈值绑定；
- policy 可以快速版本化；
- 删除 Diagnostics module 后不会影响 accounting 数据；
- 不需要重新读取 rollout。

### 后续

当真实历史证明规则稳定且诊断查询成为明确热路径后，可新增 rebuildable `diagnostic_findings` projection。即使持久化，也必须由 `canonical_requests + pricing evidence` 重建，并独立保存 `policy_version`。

## 14. 性能约束

- cached Session 点击不得触发 rollout replay；
- Diagnostics 查询只读 SQLite canonical projection；
- V1 session diagnostics 应避免 N+1 Task/Request SQL；一次读取有界 facts 后在内存线性分析；
- Analyzer 必须使用 single-pass rolling state；不得为每个 Request 重新扫描全部历史或 `filter(previousFacts)`，避免大 Session 退化为 O(N²)；
- UI 初始 snapshot 不随 findings 数线性膨胀；
- 常规 Session/SSE snapshot 不计算 diagnostics summary；
- 建议 warm diagnostics API P95 `<150ms`（常规 session）；大历史 session 必须记录 benchmark，而不是通过丢弃 Request 偷换语义。

## 15. 明确禁止的实现

- 从 raw copied evidence 直接计算异常并重复报警；
- 修改 Request Ledger classification 来表达“异常”；
- 把 Diagnostics finding 写回 `.codex`；
- 调用 LLM 解释异常并把模型输出当成事实；
- 在 `database.js` 中堆叠 rolling median、severity、breakpoint 算法；
- 为 Cost Spike 复制一份 pricing rate card；
- 用未来 Request 建立实时基线；
- 在没有正文 evidence 时声称“Prompt 某一段变化导致缓存失效”；
- 为了首版方便把全部 finding 塞入常规 SSE snapshot。

## 16. 分阶段交付

### V1

1. 冻结 diagnostics policy / finding interface。
2. 实现 Context Inflation。
3. 实现 Cache Regression / breakpoint locator。
4. 实现 Cost Spike，并复用现有 request pricing。
5. 实现 Long Context Trigger。
6. 增加 lazy diagnostics API。
7. 增加 Session summary + finding list + Request 定位 UI。
8. 真实历史 shadow report 调参，确认误报率后完成交付。

### V2 候选

引入 project/model/effort historical cohort、Median + MAD / robust Z-score、Reasoning anomaly、Request burst、Subagent amplification 和跨 Session comparison。
