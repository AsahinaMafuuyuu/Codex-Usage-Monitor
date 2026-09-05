# Phase 24：Advanced Usage Diagnostics 设计方案

**状态：** Phase 24A Implemented / Verified；Phase 24B1 Implemented / Verified；Phase 24B2 Budget / In-app Notification Implemented / Verified；LLM Root-Cause Explanation Pending
**日期：** 2026-09-02
**前置基线：** Phase 23 `usage-diagnostics-v1` 已实现并验证
**相关决策：** [ADR-0026](decisions/0026-deterministic-usage-diagnostics-projection.md)；[ADR-0027](decisions/0027-historical-robust-usage-diagnostics.md)；[ADR-0028](decisions/0028-deterministic-behavioral-usage-diagnostics.md)；[ADR-0029](decisions/0029-local-diagnostic-budget-notification-state.md)

## 1. 背景

Phase 23 已经建立 canonical Request 之上的确定性 Local Baseline Diagnostics：

- Context Inflation；
- Cache Regression / Breakpoint；
- Cost Spike；
- Long Context Trigger。

V1 的优势是简单、可解释、完全确定性，并且只依赖当前 Session 内已经发生的 Request。但它回答的是：

> “相对于这个 Session 最近几次可比较 Request，现在是否出现显著变化？”

它还不能稳定回答：

> “相对于这个工程过去几天/几十个 Session 的正常模式，现在是不是异常？”

也不能区分“当前 Session 本来就在逐步变大”和“当前 Session 相对于长期历史已经整体退化”。Phase 24 的核心目标因此不是替换 V1，而是在 V1 之上增加 **Historical Robust Baseline**。

## 2. 总体目标

Phase 24 采用两阶段交付：

### Phase 24A：Historical Robust Diagnostics

优先实现统计上可验证、仍然 metadata-only / deterministic 的能力：

1. Historical Cohort；
2. Median + MAD；
3. Robust Z-Score；
4. Historical Context Inflation；
5. Historical Cache Regression；
6. Historical Cost Spike；
7. Cross-session Regression；
8. Shadow Validation、threshold freeze 与解释 UI。

### Phase 24B：Behavioral / Operational Diagnostics

在 24A 稳定后再独立设计并实施：

1. Reasoning Anomaly；
2. Request Burst；
3. Subagent Amplification；
4. Budget / Notification；
5. 可选 LLM Root-Cause Explanation。

24B 不允许为了赶进度直接塞进 24A analyzer。尤其 LLM explanation 会首次突破 ADR-0026 的 no-model-call 边界，实施前必须另写 ADR 并重新评估隐私、网络、费用和用户授权。

## 3. 不变量

Phase 24 必须继承 Phase 23 已验证的不变量：

- `canonical_requests` 仍是 Request-level Usage/Cost 的唯一业务事实；
- inherited/raw copied history 不产生新的业务 sample/finding；
- 不修改 Request identity、ownership、classification、Token 或 Cost accounting；
- pricing 仍只由 `pricing.js` 解释，Advanced Diagnostics 不复制 rate card / long-context / Fast policy；
- 默认不读取或持久化 Prompt、Response、消息正文；
- Advanced Diagnostics 不能进入常规 Session/SSE 热路径；
- Day scope 只过滤 current finding 的输出，不改变历史 baseline；
- 同一 subject + 同一 policy version 必须产生确定性相同结果；
- 样本不足时宁可返回 `insufficient_history`，不能通过放宽 cohort 猜相似样本。

## 4. 为什么不直接修改 `src/diagnostics.js`

Phase 23 的 `diagnostics.js` 是一个深模块，interface 很小：

```js
analyzeUsageDiagnostics(facts, policy)
```

它的实现假设是“当前 Session、单次顺序遍历、bounded local state”。Historical baseline 引入了不同的事实读取方式、cohort identity、跨 Session 窗口、MAD 退化、session-level sample weighting 和更大的性能预算。

如果直接把 V2 全塞进原 module，会让一个调用者必须理解两套完全不同的 baseline 生命周期。因此 Phase 24 建议新增独立深模块：

```text
Local Diagnostics       -> src/diagnostics.js
Historical Diagnostics  -> src/advanced-diagnostics.js
```

V1 不改变；V2 可以失败、shadow、调 policy，而不影响已经验证的 Local Diagnostics。

## 5. Historical Cohort 定义

### 5.1 基础 cohort identity

Phase 24A 的 Request historical cohort 固定从以下维度开始：

```text
exact projectPath
+ exact recorded model
+ exact known effort
```

设计原则是 **precision before coverage**。

明确禁止：

- 跨工程合并；
- 为了增加样本把不同 model 自动归为“差不多”；
- `effort=null` 与 `low/medium/high/xhigh` 混合；
- effort 缺失时仅凭 model/project 猜 baseline；
- 当前 Session 的 Request 进入 Historical baseline。

如果 effort 不可证明，V2 Historical finding 不生成；V1 Local finding 仍照常可用。

### 5.2 detector-specific qualifier

不是所有 detector 都使用完全相同的 cohort qualifier。

| Detector | 必须同 cohort | 额外 qualifier |
|---|---|---|
| Historical Context Inflation | project + model + effort | 无 |
| Historical Cache Regression | project + model + effort | current/historical 都满足 minimum input |
| Historical Cost Spike | project + model + effort | `serviceTier + pricing rateVersion` 必须一致 |
| Cross-session Context | project + model + effort | 每个 prior Session 只贡献一个 slice sample |
| Cross-session Cache | project + model + effort | 每个 prior Session 使用 weighted cache rate |
| Cross-session Cost | project + model + effort | 同 service tier / rate version 的 session slice |

Cost 不允许把历史价格变化或 Fast/standard 切换伪装成 Usage anomaly。若 service tier / rate version 变化，可作为 evidence factor 展示，但不进入同一 Robust-Z baseline。

## 6. Historical Request Window

Phase 24A 的候选窗口设计：

```text
source sessions: 当前 rootSessionId 之外的历史 Session
time horizon:    current observedAt 往前最多 30 days
sample cap:      每个 request cohort 最近最多 200 个有效样本
minimum samples: 20
ordering:        observedAt ASC, rootSessionId ASC, requestId ASC
```

这三个限制分别解决：

- **30 days**：避免非常旧的项目阶段永久影响当前 baseline；
- **200 samples**：保持历史分析 bounded；
- **20 samples**：避免 MAD/median 在极少样本上产生伪统计精度。

如果 30 天内不足 20 个严格可比较样本，Phase 24A 不自动扩大到 60/90 天，也不跨 model/effort fallback。未来若真实 shadow 证明需要更长 horizon，应修改 policy version。

## 7. Robust Statistics

对于历史样本：

```text
median = median(x_i)
MAD    = median(|x_i - median|)
```

Robust Z-Score：

```text
robustZ = 0.67448975 * (x - median) / MAD
```

### 7.1 MAD = 0

`MAD=0` 时严禁：

- 填一个 epsilon 后继续计算；
- 返回 Infinity 并直接 high；
- 自动切换 mean/stddev 而不改变 finding semantics。

V1 规则：

```text
historical baseline status = degenerate
robustZ = null
不生成 statistical warning/high
```

当前 Request 仍可以被 Phase 23 Local detector 命中。这使“统计 baseline 不可用”和“当前值没有异常”保持不同语义。

## 8. Statistical Threshold Strategy

Phase 24A 已完成真实历史 shadow review，并冻结 `advanced-usage-diagnostics-v1`：

```text
warning |robustZ| >= 3.5
high    |robustZ| >= 5.0
```

所有 user-visible detector 同时要求 **statistical significance + practical effect gate**：

```text
Historical Context:
  warning: robustZ >= 3.5 AND ratio >= 1.35 AND absolute >= 32,768 tokens
  high:    robustZ >= 5.0 AND ratio >= 2.00 AND absolute >= 65,536 tokens

Historical Cache:
  current/history input >= 8,192 tokens
  warning: robustZ <= -3.5 AND drop >= 20pp
  high:    robustZ <= -5.0 AND drop >= 40pp

Historical Cost:
  warning: robustZ >= 3.5 AND ratio >= 1.75 AND absolute >= $0.05
  high:    robustZ >= 5.0 AND ratio >= 3.00 AND absolute >= $0.05
```

最终 shadow 对 `242` 个 Session、`30,198` 个 canonical Request 产生 `4,490` 个 production-equivalent findings（`14.87 / 100 Requests`），涉及 `3,668` 个 Request（`12.15 / 100`）。阈值邻近样本和 high-tail 均经过脱敏 aggregate 审查：接近 `Z=3.5` 的 warning 仍满足明确的 absolute/ratio effect gate，而 high-tail 主要对应显著 Cache collapse 或 Cost/Context 放大，因此没有为了降低 finding 数量额外抬阈值。

## 9. Cross-session Regression

Cross-session 不能直接把过去所有 Request 当成同等权重，否则一个 1,000-Request Session 会比一个 20-Request Session 对 baseline 贡献 50 倍。

Phase 24A 引入 **Session Cohort Slice**：

```text
rootSessionId
+ projectPath
+ model
+ effort
[+ cost qualifier when applicable]
```

每个 Session slice 先聚合为一个 sample：

```text
medianInputTokensPerRequest
weightedCacheHitRate = ΣcachedInput / Σinput
medianEstimatedCostUsd
longContextRequestRate
requestCount
```

再对 prior session slice 做 median/MAD。

候选窗口：

```text
history horizon:       60 days
max prior slices:      20
min current requests:  3
min prior slices:      10
```

这样一个 Session 只对长期 baseline 贡献一个样本，避免“大 Session 支配统计”。

Cross-session finding 的 subject 是当前 Session Cohort Slice，而不是单个 Request；finding 可以附带当前 slice 中最偏离 baseline 的 top supporting Request locator 作为审计入口。

## 10. Session / Day Scope

### Session scope

返回：

- request-level historical findings；
- session cohort regression findings。

### Day scope

返回：

- current Request 位于目标 local day 的 historical findings；
- 不返回完整 Session-level regression finding。

Historical baseline 仍允许读取 dayStart 之前、甚至前几个 Session 的历史；Day 只负责最终输出过滤。

因此同一 canonical Request 的 Historical finding 不能因为从 Project 切到 Time 页面而改变 baseline/metric/severity。

## 11. Finding Model

Phase 24A finding 建议独立命名，避免与 V1 local finding 混淆：

```js
{
  id,
  policyVersion,
  family: "historical" | "cross_session",
  type,
  severity,
  subject,
  cohort: {
    projectPath,
    model,
    effort,
    serviceTier?,
    rateVersion?,
  },
  baseline: {
    kind,
    sampleCount,
    median,
    mad,
    robustZ,
    horizonStart,
    horizonEnd,
    status,
  },
  metric,
  effect,
  evidence,
  locator,
}
```

Finding identity：

```text
hash(policyVersion + family + type + subjectIdentity + cohortIdentity)
```

不得把 UI 排序、当前页码或数据库 rowid 放进 identity。

## 12. V1 与 V2 共存

Phase 24 不替换 `usage-diagnostics-v1`。

页面解释建议明确区分：

```text
Local baseline       最近几次 Request 的局部变化
Historical baseline  同工程/同模型/同 effort 的长期历史变化
Cross-session        当前 Session slice 相对过去 Session 的整体退化
```

同一 Request 可以同时出现 Local 和 Historical finding，因为它们回答不同问题。V1 不应因为 V2 启用而改变 finding id、severity 或 threshold。

后续若需要视觉去重，只能在 presentation layer 做 grouping，不得在 analyzer 中删除其中一套 evidence。

## 13. Shadow-first Lifecycle

Phase 24A 必须按照：

```text
Draft policy
  -> deterministic fixtures
  -> real-history shadow report
  -> edge-case review
  -> threshold revision if justified
  -> policy freeze
  -> public API/UI
```

Shadow report 至少输出：

- cohort coverage；
- insufficient-history / unknown-effort / degenerate-MAD 数量；
- robustZ p50/p90/p95/p99/max；
- effect-size distribution；
- findings / 100 Requests；
- affected Requests / 100；
- affected sessions；
- top high findings；
- project/model/effort 分布；
- V1 Local 与 Historical finding 的 overlap ratio。

必须人工抽查阈值附近与 high tail 的代表性样本，而不是只看总报警数量。

## 14. Phase 24B Behavioral Diagnostics 冻结边界

### Reasoning Anomaly

只允许消费 metadata：`reasoningOutputTokens`、`outputTokens`、model、effort、Task/Request identity。不能因为 reasoning token 很高就声称“模型思考错误”。

Phase 24B1 冻结 metric 为：

```text
reasoningShare = reasoningOutputTokens / outputTokens
```

其中 `outputTokens` 必须至少达到 policy 的 minimum output gate；historical baseline 继续使用 exact `projectPath + model + known effort`、prior Session only、Median/MAD/Robust-Z。报警必须同时通过：

```text
upper-tail Robust-Z
AND reasoningShare increase
AND absolute reasoningOutputTokens gate
```

finding 只表示“reasoning token 占比相对同 cohort 历史显著升高”，不得解释成推理质量下降、模型错误或思维链异常。

生产 policy 已冻结：minimum output `128`；warning/high Robust-Z `3.5/5.0`，share increase `20pp/35pp`，absolute reasoning tokens `512/1024`。

### Request Burst

分析同 Session 内 canonical model Request 的时间密度。Phase 24B1 使用 60 秒 sliding window；120 秒 idle gap 只用于把 supporting evidence 切成 activity episode，不参与把 tool-use event 误计成 Request。一个模型 turn 内的 tool batch 不会制造额外计量单元，因为 detector 只消费 `canonical_requests`。

每个 `rootSessionId + projectPath + model + effort` Session Cohort Slice 计算：

```text
maxRequestsIn60Seconds
supportingWindowStart/End
requestCount
```

再与 prior Session slices 做 robust baseline。必须同时通过 Robust-Z、minimum current count 和相对历史增长 gate；Day scope 不返回 Session-level Burst finding。

生产 policy 已冻结为 60 天 / 最近 20 slices / 最少 10 slices；current slice 至少 10 Requests。warning 为 `Z>=3.5 && >=15 Requests/60s && >=1.5x median`，high 为 `Z>=5 && >=30 && >=2x`。

### Subagent Amplification

消费 canonical Request + Agent lineage，分析 descendant Request/Token 相对于 root work 的放大。Session sample 定义：

```text
tokenRatio = descendantCanonicalTokens / rootCanonicalTokens
requestRatio = descendantCanonicalRequests / rootCanonicalRequests
```

Historical cohort 只使用 exact `projectPath` 的 prior multi-agent Session；不跨工程借样本。样本不足时返回 coverage，不用全局平均值兜底。报警必须同时要求 robust historical deviation、较大的 tokenRatio、相对历史 ratio growth 和绝对 descendant-extra-token gate，从而避免把正常并行探索仅因为“descendant > root”就标成异常。

生产 policy 已冻结为 90 天 / 最近 20 samples / 最少 5；warning 要求 `Z>=3.5`、current ratio `>=1.25`、相对 historical median `>=2x`、descendant extra tokens `>=5M`、descendant Requests `>=50`；high 将 current ratio 提高到 `>=4` 且 `Z>=5`。

### Budget / Notification

该能力已经由 ADR-0029 单独冻结并实现，仍然属于 operational policy，不能回写 accounting：

- SQLite schema `v14 -> v15`，只新增 `diagnostic_alert_policies` 与 `diagnostic_alert_acknowledgements`；
- policy 按 `projectPath` 持久化，Ack 按 `rootSessionId + alertId` 持久化；
- Session budget 只消费已经存在的 `Subscription Standard-Rate Equivalent`，且仅在 `costEstimate.status=estimated` 时触发；
- diagnostic finding alert 复用 deterministic finding ID；budget alert ID 由 session/project/budget/pricing policy version 确定性派生；
- 最低提醒等级只支持 `warning/high`，默认 `high`；cooldown 为 5..1440 分钟整数，默认 60；
- Snooze 在当前工程 policy 上写入 `snoozedUntil`，Ack 不改变 finding 或 accounting；
- 通知只进入本机页面，不发送邮件、Webhook、系统通知或其他外部消息；
- HTTP 仅为 policy/Ack/Snooze 开放明确 POST allowlist，其他 POST 继续 `405`，Host/Origin/Strict Cookie 不弱化。

Alerts read path 会聚合 Local + Advanced + Behavioral frozen findings 与 Session cost budget，但用 `projectionGeneration` scoped deterministic cache 隔离这部分较重的组合计算；generation、policy、Ack、Snooze 变化时失效，最多保存 32 个 Session。服务刚启动且 background indexer 正在推进 projection generation 时 cache 会自然失效，这属于 indexing state，不计入 steady-state warm SLA。

### LLM Root-Cause Explanation

不属于 24A，也不能默认加入 24B。实施前至少要重新冻结：

- 是否只用结构化 metadata，还是允许用户显式选择 Prompt/Response；
- 是否本地/远端模型；
- 哪些字段可以出站；
- 是否每次都需要用户主动触发；
- model-call 费用和 Usage 是否必须独立标识；
- 非确定性 explanation 如何与 deterministic finding 分离；
- 网络失败时 deterministic diagnostics 是否完全不受影响。

默认设计倾向：**LLM explanation 是显式 opt-in adapter，只解释已经存在的 deterministic finding，不参与 finding 是否成立的判定。**

### Phase 24B1 真实验证结果

正式历史 `242 Sessions / 30,198 canonical Requests` 上，Behavioral final shadow 共 `26` findings（约 `0.09 / 100 Requests`）：Reasoning `24`、Request Burst `1`、Subagent Amplification `1`；`3 high / 23 warning`。20 轮 warm benchmark common P95 `85.607ms`，最大真实工程最新 Session P95 `381.353ms`。页面使用独立 `Behavioral · Request / Behavioral · Session` family，并继续复用 Canonical Request audit。

## 15. 性能目标

Phase 24A 不允许把“跨工程历史统计”变成无界查询。

目标：

```text
common warm advanced diagnostics P95 < 200ms
largest real project/session benchmark     < 500ms
常规 Session/SSE snapshot                  不执行 Advanced analyzer
历史 query                                 bounded by horizon + per-cohort cap
```

如果现有 schema v14 无法满足该目标，优先增加可重建 index；只有 benchmark 证明 compute-on-read 已成为瓶颈后，才讨论持久化 cohort summary/projection。

## 16. Privacy / Security

24A/24B1 与 Phase 23 相同：

- metadata-only；
- no model call；
- no new external network；
- loopback/auth/CSP 边界不变；24B2 只对 ADR-0029 明确 allowlist 的本地 operational POST 开例外；
- SQLite 不新增 prompt/response/message body；
- `.codex` 只读。

24B2 的本地 operational write 已由 ADR-0029 单独批准，但不允许外部通知或模型调用。任何进一步突破 metadata-only / no-model-call / no-new-network 的能力仍必须单独 ADR。

## 17. Phase 24A 冻结状态与后续事项

Phase 24A 已冻结并实现：

1. exact project/model/known-effort cohort；
2. current Session exclusion 与 future-sample exclusion；
3. MAD=0 `degenerate`、无 epsilon fallback；
4. Cost baseline 隔离 service tier / rate version；
5. 30-day / 200-request 与 60-day / 20-session bounded history；
6. Session slice 一 Session 一 sample；
7. `advanced-usage-diagnostics-v1` Robust-Z + practical-effect thresholds；
8. 独立 lazy `/advanced-diagnostics` API；
9. Local / Historical / Cross-session UI 分层与 Canonical Request locator；
10. compute-on-read 性能门槛：20 轮 warm benchmark common P95 `84.298ms`，最大真实工程最新 Session P95 `416.362ms`。

Phase 24B1 的 Reasoning Anomaly、Request Burst、Subagent Amplification 已实现并由 ADR-0028 冻结。Phase 24B2 Budget / In-app Notification 也已由 ADR-0029 实现并验证，steady-state warm 20 轮 P95 为 common `2.208ms`、最大真实工程最新 Session `2.335ms`。仍 Pending 的只有 LLM Root-Cause Explanation；任何会突破 metadata-only / no-model-call / no-new-network 边界的能力必须另立 ADR。
