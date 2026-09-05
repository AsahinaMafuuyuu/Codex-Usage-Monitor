# Phase 23：Usage Diagnostics 技术实现文档

**状态：** Implemented / Verified
**日期：** 2026-09-01
**设计事实源：** [DESIGN-USAGE-DIAGNOSTICS.md](DESIGN-USAGE-DIAGNOSTICS.md)
**架构决策：** [ADR-0026](decisions/0026-deterministic-usage-diagnostics-projection.md)

## 1. 实现目标

在不改变 schema v14、projection v2、Request Ledger accounting 和 pricing policy 的前提下，引入一个独立深模块，对 canonical Request 序列执行确定性 Usage 异常诊断。

V1 代码路径：

```text
MonitorDatabase
  -> getDiagnosticFacts(scope)
  -> UsageMonitor enrich request-level cost/task metadata
  -> analyzeUsageDiagnostics(facts, policy)
  -> DiagnosticReport
  -> read-only HTTP endpoint
  -> lazy frontend rendering
```

## 2. 模块与文件所有权

建议新增：

```text
src/diagnostics.js
test/diagnostics.test.js
```

预计修改：

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

职责必须保持：

| Module | 职责 |
|---|---|
| `database.js` | 定向读取 canonical diagnostic facts，不实现统计算法 |
| `pricing.js` | 唯一 request cost / long-context / Fast pricing 解释 |
| `diagnostics.js` | rolling baseline、finding、severity、breakpoint、summary |
| `monitor.js` | 组织 scope、cost enrichment、policy 调用 |
| `server.js` | 参数校验、认证后的只读 diagnostics route |
| `public/**` | 展示结构化 finding，并定位现有 Task / Request audit |

## 3. Diagnostics Module Interface

建议外部 seam 保持单一：

```js
export function analyzeUsageDiagnostics(facts, policy = USAGE_DIAGNOSTICS_POLICY)
```

返回：

```js
{
  summary,
  findings,
  policy: {
    version,
    baselineWindow,
  }
}
```

内部 helper（median、comparable cohort、cache breakpoint、severity）不暴露为业务 interface；测试优先通过 `analyzeUsageDiagnostics` 验证行为，只有纯统计 helper 具有足够复杂度时才做内部定向测试。

## 4. Policy 对象

阈值全部集中，不散落在 UI / DB / route：

```js
export const USAGE_DIAGNOSTICS_POLICY = Object.freeze({
  version: "usage-diagnostics-v1",
  baselineWindow: 5,
  minimumBaselineSamples: 3,
  contextInflation: {
    warningRatio: 1.35,
    warningAbsoluteTokens: 32_768,
    highRatio: 2.0,
    highAbsoluteTokens: 65_536,
  },
  cacheRegression: {
    minimumInputTokens: 8_192,
    warningDrop: 0.20,
    highDrop: 0.40,
  },
  costSpike: {
    warningRatio: 1.75,
    warningAbsoluteUsd: 0.05,
    highRatio: 3.0,
  },
});
```

阈值变化必须同时变更 `version` 或通过可审计 policy revision 表达，避免同一版本在不同时间产生不同 finding。

这里的“冻结”指 **implementation contract freeze**：进入代码实现后，同一个 `policyVersion` 的阈值、scope 语义、finding shape、baseline comparator 和 pricing eligibility 不允许被实现者临时改变。未来可以调整，但必须显式修改 policy version；涉及长期架构语义时同时更新 ADR。

## 5. Diagnostic Facts 查询

建议 `MonitorDatabase` 新增一个只读 query：

```js
getDiagnosticFacts(rootSessionId, { range = null } = {})
```

一次 SQL 读取 V1 所需字段，避免每个 Task / Request 发一条查询：

```text
canonical_requests
  request_id
  root_session_id
  thread_id
  turn_id
  observed_at
  classification
  quality
  input/cached/cache-write/output/reasoning/total
  model
  service_tier
  pricing_context_quality

LEFT JOIN tasks
  effort
  sequence
```

排序固定：

```sql
ORDER BY observed_at, request_id
```

Day scope 复用现有严格本地日期解析得到 UTC `[startAt,endAt)`，但查询不能只读取该时间窗。为了保证同一 Request 在 Session / Day scope 下诊断一致：

```text
Session scope: read all canonical facts for rootSessionId
Day scope:     read canonical facts where observedAt < endAt
               analyze with pre-day history intact
               return findings whose current observedAt is within [startAt,endAt)
```

不得根据 Task startedAt 切日，也不得在 `startAt` 重置 baseline。

## 6. Fact Enrichment

数据库返回的是 canonical fact，不应该持久化第二份 cost。`UsageMonitor` 将 DB row 规范化为当前 `estimateRequestCost()` 所需 event：

```js
const costEstimate = estimateRequestCost(requestEvent);
```

然后生成只供 diagnostics 使用的 immutable fact：

```js
{
  requestId,
  threadId,
  turnId,
  observedAt,
  model,
  effort,
  serviceTier,
  usage,
  costEstimate,
}
```

这样 pricing 变化只发生在一个 module；Diagnostics 不知道 rate card 细节。

## 7. Comparable Sequence

V1 先在同一 Task 内形成序列：

```text
(threadId, turnId)
```

只有样本不足时才允许使用 Session fallback。建议 fallback comparator：

```text
same model
AND same effort when effort is known
AND observedAt < current observedAt
```

每个 finding 必须输出：

```text
baseline.kind = task_rolling_median | session_model_effort_rolling_median
```

禁止隐式混合 cohort。

## 8. Rolling Median 实现

Analyzer 采用 single-pass rolling state：

1. 按 `(observedAt, requestId)` 顺序遍历一次 facts；
2. 以 task key / session fallback cohort key 维护最多 `window` 个前序有效值；
3. **先从 state 计算当前 Request baseline，再 append 当前值**，从结构上禁止 future leakage；
4. median 对最多 5 个值 copy 后排序，奇数取中位、偶数取两中值平均；
5. null / invalid 不进入样本计数。

V1 window 最大只有 5，不需要复杂平衡树。禁止对每个 Request 调用 `facts.filter(...)` 或重新扫描全部历史；否则长 Session 会退化到 O(N²)。

## 9. Context Inflation Detector

伪代码：

```js
const baseline = rollingMedian(previousInputs);
if (baseline.sampleCount < policy.minimumBaselineSamples) return null;

const absoluteGrowth = current - baseline.value;
const ratio = current / baseline.value;

if (ratio >= highRatio && absoluteGrowth >= highAbsoluteTokens) high;
else if (ratio >= warningRatio && absoluteGrowth >= warningAbsoluteTokens) warning;
```

`baseline <= 0` 时不可比较，不生成 finding。

## 10. Cache Regression Detector

先复用现有语义计算 cache hit：

```js
cachedInputTokens / inputTokens
```

要求：

- current `inputTokens >= 8192`；
- cached/input 字段一致；
- baseline 只使用同样满足 minimum input 的前序 Request。

Finding evidence 至少包含 baseline/current/drop 和 breakpoint candidate。

Breakpoint V1 可通过“某 Request 首次超过 warning drop”确定；后续如果至少两个可比较 Request 继续低于旧 baseline，可增加 `sustained=true`，但不能因此创造额外 accounting identity。

## 11. Cost Spike Detector

只比较可证明的 request-level cost：

```text
costEstimate.amountUsd
```

V1 规则正式冻结为：

- `estimated`：可作为 current candidate，并可进入 baseline；
- `partial`：仅作为 pricing evidence 展示，不参与 spike warning/high，也不进入 baseline；
- `unavailable`：不比较。

不能因为 `partial.amountUsd` 非空就把它静默视为完整可比较金额。

Cost Spike finding 的 `evidence` 从当前/基线 Request 已有事实计算：

```text
inputDelta
cacheHitDelta
longContextStatus
serviceTier
pricingStatus
```

不要实现一个“rootCause”字符串；V1 只提供 causes/factors 列表。

## 12. Long Context Detector

阈值必须与 pricing module 的实际 policy 保持同一事实。Phase 23 实施时先把 pricing interface 补成稳定 feature evidence，例如：

```js
costEstimate.longContextCandidate
costEstimate.longContextStatus
```

或者导出等价的单一 pricing helper。Diagnostics 只消费该 seam；如果内部保留 input threshold comparison，只能是 `pricing.js` 内部的一致性断言。

不能在 Diagnostics 独立维护第二份“272K pricing implementation”。即使历史 rate unavailable，pricing seam 也应能返回 `candidate/unknown` feature evidence，使 Diagnostics 无需复制阈值。未来 pricing policy 变化时 Diagnostics 自动跟随。

## 13. Finding Identity

V1 finding 不持久化，但仍需要前端 stable key。建议 deterministic id：

```text
hash(policyVersion + type + requestId)
```

同一个 policy 下重新计算应生成同一 finding id；policy 变化允许 identity 改变。

Finding 同时返回：

```js
locator: {
  requestOrdinalInScope,
}
```

ordinal 基于目标 Task 在当前业务 scope 下的 canonical Request 稳定顺序 `(observedAt, requestId)`，从 1 开始。它不是 finding identity 的组成部分，只用于前端分页定位。

## 14. Monitor / API

`UsageMonitor` 建议新增：

```js
diagnostics(sessionId, scope = { type: "session" })
```

与 `selectSession()` 一样只消费已经建立的 cached canonical projection。如果 session dirty：

- 当前请求可以使用上一完整 generation；
- 后台 indexer 继续更新；
- 不得为了 Diagnostics 请求同步解析 rollout。

HTTP：

```text
GET /api/sessions/:id/diagnostics
GET /api/sessions/:id/diagnostics?day=YYYY-MM-DD
```

响应建议同时包含：

```js
{
  projectionGeneration,
  stale: boolean,
  summary,
  findings,
  policy,
}
```

`stale` 只说明当前结果来自上一完整 canonical projection；不能因此同步 replay rollout。

继续复用现有 ID / day validator、Cookie、Host、Origin、CSP、GET-only 边界。

## 15. SSE 策略

V1 不新增高频 finding SSE payload。推荐：

- 常规 snapshot **不带 `diagnosticSummary`，也不执行 diagnostics analyzer**；
- Session 初次展示后单独 lazy GET diagnostics；
- Diagnostics panel 已加载时，收到现有 session `projectionGeneration` 更新后按需重新 GET diagnostics；
- 保持 Agent/Task/Request DOM stable key 和现有 visual anchor 规则。

这样不会把 finding 数量乘到每次 SSE snapshot 上。

## 16. 前端实现

建议在 Session overview 增加低噪声入口：

```text
Usage Diagnostics   1 High · 4 Warning
```

Panel 内按：

```text
severity DESC -> observedAt DESC
```

排序。每条 finding 显示：

- 类型；
- 当前值 → baseline；
- delta；
- Request 时间；
- evidence factors；
- “定位 Request”操作。

定位时复用现有 Task drawer / Canonical Requests 机制，不实现第二套 Request 查看器。

精确定位流程冻结为：

```text
finding(threadId, turnId, requestId, requestOrdinalInScope)
  -> 打开对应 Task Request drawer
  -> ordinal / currentPageSize 计算目标页
  -> 请求该页 canonical Requests
  -> 通过 data-request-id 找到目标 row
  -> scrollIntoView + 短暂轻量 highlight
```

因此现有 Request row 需要增加稳定 `data-request-id`，但不改变 Request accounting 或分页接口语义。

## 17. 测试计划

### Unit

`test/diagnostics.test.js` 至少覆盖：

- baseline 样本不足不报警；
- median 抗单个极端值；
- Context 34% 不报、35% + absolute gate 报；
- Cache drop 19pp 不报、20pp 报；
- 小于 minimum input 的 cache 波动不报；
- 首个 cache breakpoint 精确定位；
- Cost Spike 使用 request cost，不重新算价格；
- unavailable cost 不参与 baseline；
- Long Context finding 与 pricing evidence 一致；
- inherited/raw duplicate 不进入输入 facts；
- finding id 对同 policy deterministic。

### DB / API

- full session 与 day scope finding 输出只包含对应 scope 的 current Request；Day analyzer 可以读取 dayStart 之前的 comparable canonical Request 作为 baseline；
- 同一 request/policy 在 Session 与 Day scope 下的 metric、baseline、severity 完全一致；
- SQL 排序稳定；
- diagnostics endpoint 只接受合法 GET / ID / day；
- dirty session diagnostics 不同步 replay rollout；
- API 不泄露 source absolute path / prompt / response / credentials。

### Regression

- `npm test`；
- `npm run check`；
- `git diff --check`；
- `.codex` before/after SHA-256 不变；
- Request/Token/Cost reconciliation 前后完全一致。

### Browser

- 1440×900 与 720×900；
- Diagnostics lazy load；
- finding 能自动打开正确 Task、计算分页并精确定位 `requestId`；
- locating Request 保持父/子横向滚动语义；
- SSE 后 panel/focus/Task expansion/visual anchor 保持；
- `prefers-reduced-motion` 仍可用。

## 18. Shadow Validation

在 UI 默认显示 warning 前，先用真实历史执行只读 shadow report：

```text
finding type
severity
finding count
findings / 100 requests
top affected sessions
top delta distribution
```

目标不是人为追求“报警少”，而是确认阈值没有把正常序列变化当成大规模异常。若误报明显，应修改 policy version/threshold，再进入用户可见交付。

## 19. V2 技术方向

当 V1 稳定后再实现 Historical Baseline：

```text
projectPath + model + effort
  -> minimum sample count >= 20
  -> median
  -> MAD
  -> robust Z-score
```

建议：

```text
robustZ = 0.6745 * (x - median) / MAD
```

但 MAD=0、模型切换、Fast/standard cohort、时间衰减等问题必须单独设计；不得提前塞进 V1。
