# Phase 24：Advanced Usage Diagnostics 技术实现方案

**状态：** Phase 24A Implemented / Verified；Phase 24B1 Implemented / Verified；Phase 24B2 Budget / In-app Notification Implemented / Verified；LLM Root-Cause Explanation Pending
**日期：** 2026-09-02
**设计事实源：** [DESIGN-ADVANCED-USAGE-DIAGNOSTICS.md](DESIGN-ADVANCED-USAGE-DIAGNOSTICS.md)
**架构决策：** [ADR-0027](decisions/0027-historical-robust-usage-diagnostics.md)、[ADR-0028](decisions/0028-deterministic-behavioral-usage-diagnostics.md)、[ADR-0029](decisions/0029-local-diagnostic-budget-notification-state.md)

## 1. 实施原则

Phase 24A 必须作为 Phase 23 之上的新增统计层实施，不重构或改写已经验证的 Local Diagnostics。

目标数据流：

```text
canonical_requests + tasks + sessions
        |
        | bounded historical query
        v
Historical Diagnostic Dataset
        |
        v
Advanced Diagnostics Engine
  - strict cohorting
  - median / MAD
  - robust Z
  - practical effect gates
  - session-slice regression
        |
        v
Advanced Diagnostic Report
        |
        +--> shadow CLI
        +--> lazy read endpoint (policy frozen 后)
        +--> lazy UI panel (policy frozen 后)
```

## 2. Module / Seam 设计

已新增：

```text
src/advanced-diagnostics.js
test/advanced-diagnostics.test.js
scripts/shadow-advanced-usage-diagnostics.js
scripts/benchmark-advanced-usage-diagnostics.js
```

已修改：

```text
src/database.js
src/monitor.js
src/server.js
public/app.js
public/styles.css
test/database-server.test.js
test/ui-security.test.js
docs/*
```

### 2.1 外部 interface

Advanced analyzer 保持单一深 interface：

```js
export function analyzeAdvancedUsageDiagnostics(
  dataset,
  policy = ADVANCED_USAGE_DIAGNOSTICS_POLICY,
)
```

`dataset` 含当前 Session facts 与经过 DB 层 bounded 读取的历史 facts；调用者不需要知道 median、MAD、cohort state 或 session-slice 算法。

不建议把以下 helper 暴露成业务 interface：

```text
median
mad
robustZ
cohortKey
sessionSlice
effectGate
```

这些应留在深 module 内部。测试主要通过 `analyzeAdvancedUsageDiagnostics()` 验证行为；只有纯统计 worked-example 需要非常明确时，才考虑内部窄 seam。

## 3. Frozen Policy

真实历史 shadow 完成后，生产 policy 已冻结为：

```js
export const ADVANCED_USAGE_DIAGNOSTICS_POLICY = Object.freeze({
  version: "advanced-usage-diagnostics-v1",
  frozen: true,
  requestHistory: {
    horizonDays: 30,
    maxSamplesPerCohort: 200,
    minimumSamples: 20,
  },
  sessionHistory: {
    horizonDays: 60,
    maxSlicesPerCohort: 20,
    minimumSlices: 10,
    minimumRequestsPerSlice: 3,
  },
  robustZ: {
    warningCandidate: 3.5,
    highCandidate: 5.0,
  },
  contextInflation: {
    warningAbsoluteTokens: 32_768,
    warningRatio: 1.35,
    highAbsoluteTokens: 65_536,
    highRatio: 2,
  },
  cacheRegression: {
    minimumInputTokens: 8_192,
    warningDrop: 0.20,
    highDrop: 0.40,
  },
  costSpike: {
    warningAbsoluteUsd: 0.05,
    warningRatio: 1.75,
    highRatio: 3,
  },
});
```

Draft → Frozen 已完成以下证据：

- threshold/effect gates 明确；
- fixture 更新；
- shadow evidence 写入 `VERIFICATION.md`；
- Delivery checklist 通过对应 gate。

## 4. Historical Fact Shape

DB adapter 返回 metadata-only fact：

```js
{
  requestId,
  rootSessionId,
  threadId,
  turnId,
  observedAt,
  projectPath,
  model,
  effort,
  serviceTier,
  pricingContextQuality,
  usage,
}
```

`UsageMonitor` 使用现有 `estimateRequestCost()` enrich：

```js
{
  ...fact,
  costEstimate,
}
```

Advanced analyzer 只能消费 `costEstimate` 的公开 pricing evidence；不得自行解析历史 rate card。

## 5. Current Dataset

当前 Session facts 可以复用 Phase 23 `getDiagnosticFacts()` 所需字段，但 Advanced analysis 还需要：

```text
rootSessionId
projectPath
model
effort
```

建议不要让 `advanced-diagnostics.js` 自己查询数据库。DB read 与 statistical analysis 是两个独立 seam：

```text
MonitorDatabase -> facts
Advanced module -> report
```

这样 fixtures 可以完全脱离 SQLite 测算法。

## 6. Historical Query

### 6.1 Request cohort candidates

建议新增只读 method：

```js
getHistoricalDiagnosticFacts(rootSessionId, {
  projectPath,
  before,
  after,
  maxSamplesPerCohort,
})
```

必须满足：

- `root_session_id <> currentRootSessionId`；
- `observed_at < before`；
- `observed_at >= after`；
- exact `project_path`；
- canonical only；
- stable order；
- bounded per cohort；
- 不做 Task/Request N+1。

### 6.2 SQL strategy

优先使用 SQLite window function 做 per-cohort cap，而不是把整个 Project 历史读进 Node 后截断：

```sql
WITH ranked AS (
  SELECT
    cr.*,
    s.project_path,
    t.effort,
    ROW_NUMBER() OVER (
      PARTITION BY cr.model, t.effort
      ORDER BY cr.observed_at DESC, cr.root_session_id DESC, cr.request_id DESC
    ) AS cohort_rank
  FROM canonical_requests cr
  JOIN sessions s ON s.id = cr.root_session_id
  LEFT JOIN tasks t
    ON t.root_session_id = cr.root_session_id
   AND t.thread_id = cr.thread_id
   AND t.turn_id = cr.turn_id
  WHERE s.project_path = ?
    AND cr.root_session_id <> ?
    AND cr.observed_at >= ?
    AND cr.observed_at < ?
)
SELECT ...
FROM ranked
WHERE cohort_rank <= ?
ORDER BY observed_at, root_session_id, request_id;
```

这是实现方向，不是要求直接复制该 SQL；最终应以 `EXPLAIN QUERY PLAN` 和 benchmark 为准。

### 6.3 Index strategy

先 benchmark schema v14 现有索引。若 Project historical read 成为瓶颈，可增加可重建索引，例如：

```text
sessions(project_path, id)
canonical_requests(root_session_id, observed_at, model, request_id)
```

仅新增 index 时不需要引入新的 accounting schema 语义；但必须在 migration/restart tests 中证明旧 SQLite 可安全获得索引。

不要在没有 benchmark 证据前新增 persisted `diagnostic_samples` 表。

## 7. Cohort Builder

内部 cohort key 必须 canonical：

```js
requestCohortKey = stableTuple([
  projectPath,
  model,
  effort,
]);
```

要求：

- `projectPath/model/effort` 任一不可用 => historical statistical detector unavailable；
- 不 trim/alias 成另一个 model family，除非未来独立 model-normalization policy 被冻结；
- Windows path 比较必须复用项目现有 project path normalization 语义，不能 UI 一套、DB 一套。

Cost comparator 再追加：

```js
costCohortKey = stableTuple([
  projectPath,
  model,
  effort,
  normalizedServiceTier,
  costEstimate.rateVersion,
]);
```

只有 `costEstimate.status === "estimated"` 且 amount/rate evidence 完整的历史 sample 可以进入 Cost robust baseline。

## 8. Robust Statistics Implementation

### 8.1 median

每个 cohort 最多 200 个值，简单 copy + numeric sort 即可，不需要复杂 order-statistic tree。

### 8.2 MAD

```js
const center = median(values);
const deviations = values.map((value) => Math.abs(value - center));
const mad = median(deviations);
```

### 8.3 Robust Z

```js
if (!(mad > 0)) {
  return { status: "degenerate", robustZ: null };
}

const robustZ = 0.67448975 * (current - center) / mad;
```

不得为 `mad === 0` 注入 epsilon。

### 8.4 numeric stability

阈值比较应复用 Phase 23 已经遇到的浮点边界经验：对 exact threshold 使用极小 deterministic tolerance，但不能用宽容差改变业务阈值。

## 9. Historical Detector Inputs

### Context

Metric：

```text
inputTokens
```

Historical sample 必须是 finite non-negative input。

### Cache

Metric：

```text
cachedInputTokens / inputTokens
```

current/history 都必须满足：

```text
inputTokens >= minimumInputTokens
0 <= cachedInputTokens <= inputTokens
```

Cache Regression 使用 lower-tail robustZ。

### Cost

Metric：

```text
costEstimate.amountUsd
```

必须：

```text
status === estimated
same normalizedServiceTier
same rateVersion
finite amountUsd
```

`partial/unavailable` 不进入 current statistical candidate，也不进入 history。

## 10. Practical Effect Gate

Advanced detector 不允许只凭 z-score 报警。

实现 interface 建议返回：

```js
effect: {
  absolute,
  ratio,
  percentagePoints?,
}
```

detector policy 决定：

```text
statistical gate
AND practical effect gate
```

在 Draft 阶段，engine 可以计算 robustZ/effect 并输出 shadow candidate；user-visible severity 必须等 policy freeze 后才启用。

## 11. Session Cohort Slice

不要先构造完整“Session 总量”再按 model/effort 拆分，因为一个 Session 可以同时存在多个 model/effort。

按：

```text
rootSessionId + projectPath + model + effort
```

直接把 Request 分组为 slice，然后计算：

```js
{
  rootSessionId,
  projectPath,
  model,
  effort,
  requestCount,
  medianInputTokensPerRequest,
  weightedCacheHitRate,
  medianEstimatedCostUsd,
  longContextRequestRate,
  firstObservedAt,
  lastObservedAt,
}
```

`weightedCacheHitRate` 使用：

```text
Σ cachedInputTokens / Σ inputTokens
```

而不是“Request hit rate 的平均值”，避免大量 tiny Request 与大 Request 权重相同。

每个 prior rootSession slice 只向 cross-session baseline 贡献一个 sample。

## 12. Cross-session Analysis

候选流程：

```text
current session cohort slice
  -> minimum current requests >= 3
  -> previous matching session slices within 60 days
  -> latest <= 20 slices
  -> minimum prior slices >= 10
  -> median/MAD
  -> robustZ + effect gate
  -> cross_session finding
```

Cross-session finding 必须记录 prior slice 数量和时间范围，使用户知道它是基于多少历史得出的。

为了支持 audit，可选取当前 slice 中按相同 metric 偏离最明显的 Request 作为：

```js
supportingLocator
```

但该 Request 不是 cross-session finding 的 identity subject。

## 13. Scope Filtering

Analyzer 接受：

```js
scope = { type: "session" }
// 或
scope = { type: "day", startAt, endAt, day }
```

所有 current facts 先完整分析，Day 最后过滤 request-level finding：

```text
startAt <= current.observedAt < endAt
```

Session-slice finding 仅在 Session scope 返回。

测试必须锁定：同一 Request 在 Session/Day 下 historical baseline、robustZ、effect、severity、finding id 一致。

## 14. Monitor Interface

建议新增：

```js
advancedDiagnostics(sessionId, scope = { type: "session" }, {
  shadow = false,
} = {})
```

Monitor 负责：

1. 从 cached canonical projection 读取 current facts；
2. 读取 bounded historical facts；
3. 调 `estimateRequestCost()` enrichment；
4. 调 advanced analyzer；
5. 附加 projection generation / stale / policy metadata。

不得调用 `selectSession()`；不得因 Advanced Diagnostics 请求同步 replay rollout。

## 15. API Strategy

不要修改 Phase 23 已验证的 `/diagnostics` contract。

建议新增独立 lazy endpoint：

```text
GET /api/sessions/:id/advanced-diagnostics
GET /api/sessions/:id/advanced-diagnostics?day=YYYY-MM-DD
```

在 Draft/Shadow 阶段可以先不把 endpoint 接到 UI，只通过 CLI/内部 monitor test 验证。

Frozen 后响应：

```js
{
  projectionGeneration,
  stale,
  policy,
  scope,
  coverage,
  summary,
  findings,
}
```

`coverage` 至少说明：

```text
strictCohortSamples
insufficientHistory
unknownEffort
degenerateMad
costIneligible
```

## 16. SSE Strategy

Phase 24A 继续禁止把 advanced summary/findings 塞进普通 Session snapshot。

UI 已经加载 Advanced panel 时：

```text
existing SSE projectionGeneration changes
  -> mark advanced report stale
  -> debounce/lazy refetch
```

不能在每次 SSE snapshot 中重新扫描历史 project cohort。

## 17. UI Strategy

建议在现有 Diagnostics 区域增加 baseline source，而不是新增完全独立大页面：

```text
Usage Diagnostics
  Local
  Historical
  Cross-session
```

Advanced finding 显示：

- 当前值；
- historical median；
- MAD；
- robust Z；
- sample count；
- history horizon；
- practical effect；
- cohort dimensions；
- locator/supporting locator。

不要仅显示“Z=5.2”而不解释 metric/effect/sample count。

## 18. Shadow CLI

新增：

```text
npm run shadow:advanced-usage-diagnostics
```

只读正式 SQLite，不扫描 Prompt/Response，不写 `.codex`。

输出建议：

```text
total current requests
eligible historical requests
strict cohort coverage
unknown-effort count
insufficient-history count
degenerate-MAD count
candidate count by detector
robustZ quantiles
effect quantiles
candidate/100 requests
unique affected requests/100
V1 overlap ratio
top project/model/effort cohorts
top outliers
```

Shadow CLI 默认只输出脱敏 aggregate；session/request id 仅在显式 debug 参数下显示，避免把机器历史标识无必要写入复制粘贴报告。

## 19. Performance Benchmark

新增：

```text
npm run benchmark:advanced-usage-diagnostics
```

至少测：

1. common Session；
2. 最大 Request Session；
3. 最大历史 Project；
4. 多 model/effort Project。

目标：

```text
common warm P95 < 200ms
largest real project/session < 500ms
```

如果失败，优先：

1. EXPLAIN QUERY PLAN；
2. index；
3. SQL per-cohort bound；
4. 减少重复 pricing enrichment；

最后才考虑 persisted advanced projection。

## 20. TDD / Test Plan

### Pure analyzer

至少覆盖：

- median worked examples；
- MAD worked examples；
- robustZ worked examples；
- MAD=0 返回 degenerate 而不是 Infinity；
- 19 个历史样本不生成 statistical finding，20 个可以进入候选；
- current Session sample 永不进入 historical baseline；
- future historical sample 永不泄漏；
- project 隔离；
- model 隔离；
- effort 隔离；
- unknown effort 不 fallback；
- Cost service tier 隔离；
- Cost rateVersion 隔离；
- partial/unavailable cost 排除；
- Session slice 一 Session 一 sample；
- 大 Session 不按 Request 数重复加权；
- weighted cache hit 正确；
- Day/Session scope invariance；
- deterministic finding id；
- V1 finding 不因 Advanced analyzer 启用而改变。

### DB / API

- historical query 只读 canonical rows；
- rootSessionId current exclusion；
- project path isolation；
- bounded history；
- stable ordering；
- query plan 无明显全库 N+1；
- dirty session 不 sync replay；
- invalid id/day 仍 400/404；
- API 不泄露 prompt/response/source absolute path/credential。

### Browser

- advanced lazy load；
- sample count/MAD/Z/effect 可读；
- Local/Historical/Cross-session source 明确；
- locator 复用 canonical Request drawer；
- SSE 后 panel/focus/drawer/scroll 稳定；
- 1440×900 / 720×900；
- reduced-motion。

## 21. Phase 24A 实施顺序

严格按依赖图实施：

```text
1. Contract Freeze（结构性契约，不冻结 shadow 阈值）
2. Robust statistics + cohort TDD
3. Historical DB query + query-plan benchmark
4. Shadow-only analyzer/CLI
5. Real-history threshold review
6. Freeze advanced-usage-diagnostics-v1 policy
7. Monitor + lazy API
8. UI vertical slice
9. Browser/performance/security regression
10. Accounting/hash final gate
11. Delivery docs -> Implemented
```

第 5 步之前不能把 Draft Robust-Z threshold 当成用户可见 warning/high。

## 22. Phase 24B 实施状态

Phase 24B1 前三项已经完成设计检查、真实 shadow 与生产实现：

```text
Reasoning anomaly     -> behavioral-usage-diagnostics-v1 ✅
Request burst         -> behavioral-usage-diagnostics-v1 ✅
Subagent amplification-> behavioral-usage-diagnostics-v1 ✅
Budget/notification   -> schema v15 operational state + local in-app Alerts ✅
LLM explanation       -> 独立 ADR + explicit opt-in + data egress contract
```

Behavioral 实现使用独立 `src/behavioral-diagnostics.js`。DB facts 继续来自 canonical Request + Task effort + Agent lineage；`getHistoricalAmplificationSamples()` 只做 project/time/max-sample bounded 历史聚合。Monitor/API 使用独立 lazy `behavioralDiagnostics()` / `/behavioral-diagnostics`，常规 Session/SSE 不执行 analyzer。

性能优化采用 historical cohort pre-index、binary range lookup 与 baseline memoization：最大真实工程 analyzer stage P50 从约 `178ms` 降到约 `28ms`，20 轮 end-to-end P95 `381.353ms`。

Phase 24B2 Budget / Notification 已按 ADR-0029 落地：

- `src/database.js` schema `v14 -> v15`，新增 `diagnostic_alert_policies(project_path PK, session_cost_budget_usd, minimum_severity, cooldown_minutes, snoozed_until, updated_at)` 与 `diagnostic_alert_acknowledgements(root_session_id, alert_id, acknowledged_at)`；两表只保存 operational state，不参与 canonical/accounting projection。
- `UsageMonitor.diagnosticAlerts()` 读取 cached Session snapshot，再组合 Local / Advanced / Behavioral frozen findings；budget 只使用 `summary.totalCostEstimate.status=estimated` 的 Subscription Standard-Rate Equivalent。
- policy 默认 budget disabled、minimum severity=`high`、cooldown=`60`；budget 范围 `(0, 1,000,000]` USD，cooldown 只允许 `5..1440` 分钟整数。
- `updateDiagnosticAlertPolicy()`、`acknowledgeDiagnosticAlert()`、`snoozeDiagnosticAlerts()` 是唯一 operational write seam；HTTP 只允许对应 POST route，其余 POST 继续 `405`。
- finding alert ID=`alert_${findingId}`；budget alert ID 对 `[sessionId, projectPath, budgetUsd, pricingPolicyVersion]` 做 SHA-256 后截取 24 hex，保证 budget/policy 变化自然生成新 identity。
- Alerts cache 以 `sessionId -> {projectionGeneration,...}` 存储，命中前必须 generation 相同；任何 policy 修改、Ack、Snooze 会主动清理 cache，projection generation 变化会自然 miss；最多保存 32 个 Session。
- snooze 期间 API 返回空 `alerts` 与 `suppressedBySnooze`，Ack 默认从可见结果中过滤但保留 `acknowledgedCount`；这些状态不修改 deterministic finding 本身。
- steady-state 20 轮 warm HTTP：common P50/P95=`1.268/2.208ms`，最大真实工程最新 Session P50/P95=`1.071/2.335ms`。新启动服务的 background indexer 推进 generation 时 cache 会按设计失效，因此 indexing period 与 steady-state warm 指标分开记录。
- schema v15 最终 accounting/calendar 六字段仍完全相等；`.codex` rollout manifest 不变。LLM Root-Cause Explanation 仍 Pending。

## 23. Phase 24A 实际实现结果

本节记录最终实现，而不是继续描述候选方案：

- `src/advanced-diagnostics.js` 已作为独立深模块落地；Request-level Historical 与 Cross-session Context/Cache/Cost 共六条统计路径均通过公开 analyzer interface 测试。
- `MonitorDatabase.getHistoricalDiagnosticFacts()` 使用 window function 对 `projectPath + model + effort` 历史 Request 做 per-cohort cap；`getHistoricalDiagnosticSessionFacts()` 先选最近 Session Slice，再一次性回读选中 canonical rows，避免 Task/Request N+1。
- Advanced analyzer 对 historical facts 建立 cohort index，并按时间范围二分定位；相同窗口/metric baseline 使用 memoization，避免一个大 Session 对同一 200-sample cohort 反复 filter/sort。该优化把最大真实工程 analyzer 中位耗时从约 `653ms` 降到约 `60ms`。
- `UsageMonitor.advancedDiagnostics()` 只读取 cached projection；dirty session 下不会调用 `selectSession()` 或同步 replay rollout。
- HTTP 使用独立 `GET /api/sessions/:id/advanced-diagnostics[?day=YYYY-MM-DD]`，Phase 23 `/diagnostics` contract 未改变；常规 SSE 仅通过 `projectionGeneration` 触发已打开 panel 的 lazy refetch。
- UI 使用一个 Usage Diagnostics panel，但明确分为 `Local / Historical / Cross-session` 三个 evidence source。Historical/Cross-session 展示 sample count、median、MAD、Robust-Z 与 effect；Request-level finding 直接定位 canonical Request，Cross-session 使用 supporting Request locator。
- 最终 20 轮 warm benchmark：common P95 `84.298ms`；最大 Request Session P95 `40.158ms`；最大真实工程最新 Session P95 `416.362ms`。未新增 SQLite index 或 persisted diagnostic table。
- Chrome/CDP 实测 1440×900 与 720×900：三层 baseline、Historical evidence、Local/Historical Request locator、SSE 后 panel/drawer/focus/scroll、窄屏 viewport fit 均通过。
