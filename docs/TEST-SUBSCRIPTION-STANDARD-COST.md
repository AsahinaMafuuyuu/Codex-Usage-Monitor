# Subscription Standard-Rate Cost 测试方案

**状态：** Planned / implementation gate

**设计依据：** [DESIGN-SUBSCRIPTION-STANDARD-COST.md](DESIGN-SUBSCRIPTION-STANDARD-COST.md)

**关联 ADR：** [ADR-0019](decisions/0019-request-level-subscription-standard-cost.md)

## 1. 测试原则

本文件是 Phase 17 的开发门槛，不是实现后的补充检查。

固定失败闭环：

```text
测试失败
  -> 读取失败断言和最小 fixture
  -> 回读 DESIGN-SUBSCRIPTION-STANDARD-COST.md / ADR-0019
  -> 判断实现偏离、测试偏离或设计歧义
  -> 若设计无歧义，优先修实现
  -> 定向测试
  -> npm test
  -> npm run check
  -> git diff --check
  -> 真实历史只读 reconciliation / 浏览器验收
```

禁止通过放宽 272K 边界、把 unknown 当 default、套最近模型价或把 partial 当 complete 来让测试变绿。

## 2. Fixture 基线

至少准备四组脱敏 fixture：

1. **Historical price fixture**：同一模型跨价格有效期。
2. **Long-context fixture**：`272000`、`272001`、多 request 同 Task。
3. **Fast fixture**：`default`、`fast`、`priority`、missing tier。
4. **Migration fixture**：v12 event 已有 usage/observedAt，但没有 event-level pricing context。

所有费用测试都必须断言：

- input tokens
- cached input tokens
- output tokens
- selected historical rate
- feature multiplier
- final amount
- cost coverage/status

不能只断言最终 `$`。

## 3. Unit：Historical Rate Catalog

### T-COST-001 GPT-5.6 launch standard rates

- 2026-07-09 的 Sol 解析为 `$5/$0.50/$30`。
- Terra 解析为 `$2.50/$0.25/$15`。
- Luna 解析为 `$1/$0.10/$6`。

### T-COST-002 Terra/Luna 2026-07-30 切价

- 2026-07-29 23:59:59 与 2026-07-30 生效边界使用不同 rate record。
- Terra 新价 `$2/$0.20/$12`。
- Luna 新价 `$0.20/$0.02/$1.20`。

### T-COST-003 Sol 2026-08-21 promotion exclusion

- subscription-standard policy 在 8/20、8/21、8/26 均选择 `$5/$0.50/$30`。
- API/token-based `$4/$0.40/$20` 不能被该 policy 选中。

### T-COST-004 历史 GPT-5.5 / GPT-5.4

- 在有官方有效期覆盖时按对应历史 model rate 计费。
- 日期早于 catalog 能证明的有效期时返回 unavailable，不把当前价回填到未知历史。

### T-COST-005 alias 有效期

- alias 只在明确 `effectiveFrom/effectiveUntil` 内映射。
- 区间外同名 alias 返回 unsupported/unavailable。

### T-COST-006 catalog overlap/gap

- 同一 model/policy 的两个 rate interval 重叠时测试失败。
- 没有覆盖目标时间的 gap 返回 unavailable，不选最近记录。

## 4. Unit：普通 Request Cost

### T-COST-010 cached input 作为 input 子集

fixture：

```text
input = 1,000,000
cached = 800,000
output = 100,000
```

断言只对 `200K uncached + 800K cached + 100K output` 计费，不把 cached 再叠加到 input。

### T-COST-011 reasoning 不重复收费

- `reasoningOutputTokens` 可以非零。
- 最终费用只使用 `outputTokens` 一次。
- 改变 reasoning 明细但保持 output 不变时，费用不变。

### T-COST-012 subscription policy 不使用 API cache-write surcharge

- `cacheWriteInputTokens > 0` 时仍属于非 cached input 审计明细。
- 不额外应用 GPT-5.6 API 1.25× cache-write surcharge。
- cached + uncached 拆分守恒，不出现 cache-write 双重收费。

### T-COST-013 usage 不一致

- `cachedInputTokens > inputTokens`、负数、缺 input/output 等返回 unavailable。
- 不生成伪精确金额。

## 5. Unit：Long Context

### T-COST-020 272K 边界

- `inputTokens = 272000`：normal。
- `inputTokens = 272001`：long-context（前提是 request-boundary evidence 已通过）。

### T-COST-021 full-request multiplier

对 `input=300K, cached=250K, output=10K`：

- 全部 `50K uncached input` 使用 2× input rate。
- 全部 `250K cached input` 使用 2× cached rate。
- 全部 `10K output` 使用 1.5× output rate。
- 不仅对超过 272K 的 28K input 加价。

### T-COST-022 Task 累计超过 272K 但每个 request 未超过

同一 Task：

```text
request A input=200K
request B input=200K
```

Task total=400K，但两个 request 都按 normal；必须防止 Task-level false positive。

### T-COST-023 混合 Task

同一 Task：

```text
100K normal
180K normal
300K long
```

最终 Task cost 必须等于三个 request cost 求和，只有第三个应用 long-context。

### T-COST-024 request boundary 尚未证明

- `input >272K` 但 pricing unit 与 billing request 的证据门槛未通过时，只能标 `longContextCandidate`。
- 不得静默把 multiplier 计入 complete cost。
- coverage reason 为 `long_context_request_boundary_unproven`。

### T-COST-025 不支持 long-context 的模型

- 对 catalog 明确不支持 long-context 的模型，即使 usage input 数字很大也不能套 GPT-5.6/5.5/5.4 规则。
- 返回对应 feature unavailable/unsupported evidence。

## 6. Unit：Fast / Service Tier

### T-COST-030 service tier normalization

- `default -> standard`。
- `fast -> fast`。
- `priority -> fast`。
- missing/未知值 -> unknown。

### T-COST-031 Fast multiplier by model family

- GPT-5.6 Fast = 2.5× standard request-token charge。
- GPT-5.5 Fast = 2.5×。
- GPT-5.4 Fast = 2×。

### T-COST-032 missing tier

- 没有 event-level service tier 时不得猜 Fast。
- base model cost 可作为已知组成，但 feature coverage 必须披露 tier unknown；聚合状态按设计降为 partial 或相应 coverage 状态。

### T-COST-033 settings as-of ordinal

同一 thread：

```text
ordinal 10 service_tier=default
ordinal 20 request A
ordinal 30 service_tier=fast
ordinal 40 request B
```

- request A 使用 standard。
- request B 使用 fast。
- 不能把 thread 最终 tier 回写给历史 request A。

### T-COST-034 Fast + long-context 冲突

- 同一 request 同时 `serviceTier=fast/priority` 且已证明 `input>272K` 时，不叠乘。
- 返回 `unsupported_feature_combination`。

## 7. Unit：Request → Task → Agent → Session

### T-COST-040 Request first

- `estimateTaskCost` 的实现结果必须来自 `Σ requestCost`。
- 禁止先 `sumTaskUsage()` 后重新跑 threshold/multiplier。

### T-COST-041 partial Task

- 一个 Task 有 2 个 estimated requests + 1 个 unavailable request 时，Task 为 partial。
- `amountUsd` 只表示两个已知 request 的下限。

### T-COST-042 Agent subtree

- own cost 只含自身 Task。
- subtree cost 递归加全部 descendant request-cost summaries。
- unavailable count 递归守恒。

### T-COST-043 Session total/subagent-only

- total 覆盖 root + descendants。
- subagent-only 排除 root。
- 两者都只聚合 request-derived cost。

## 8. Unit：Day Scope / Timeline

### T-COST-050 同 Task 跨日

- day 1 只聚合 day 1 observedAt 的 request cost。
- day 2 只聚合 day 2 request cost。
- full session = day 1 + day 2（在相同 coverage 范围内）。

### T-COST-051 历史切价跨日

- 一个 session 跨 2026-07-29 / 07-30 时，两个日期的 Terra/Luna request 分别使用各自有效历史价。
- 不能由 Task model 的一个最终 rate 覆盖两天。

### T-COST-052 Timeline/detail parity

- `timeline session/day cost == day snapshot summary cost`。
- model/rate/feature coverage 也一致。

## 9. Parser / Database / Migration

### T-COST-060 event model attribution

- event 获取其所属 turn 当时有效 model。
- model 切换不能污染旧 event。

### T-COST-061 event service-tier attribution

- parser 能按 ordinal 绑定最近有效 `thread_settings_applied.service_tier`。
- 仅保存最小枚举值，不持久化整个 settings payload。

### T-COST-062 v12 -> v13 token evidence invariant

- migration 前后所有 `model_usage_events` 的 classification 和六字段 usage 完全相同。
- 不因 pricing migration 改写 Request Ledger token 数。

### T-COST-063 historical metadata enrichment

- rollout 存在：只读重放可补 event pricing context。
- enrichment 不重新分类/重算已有 token usage。
- rollout SHA-256 前后相同。

### T-COST-064 rollout 缺失

- rollout 已删除且 DB 无 service tier 时保持 unknown。
- 不默认 standard，也不伪造 Fast 历史。

### T-COST-065 privacy

- 新 schema 不保存 prompt、response、消息正文、完整 thread settings。
- 只持久化 model/service-tier/evidence 等 pricing metadata。

## 10. API / Frontend contract

### T-COST-070 basis 文案

- API `basis` 改为 `subscription-standard-equivalent` 或最终冻结的同义常量。
- 不再声称 `openai-standard-api-short-context`。

### T-COST-071 Request/Task coverage

- response 能解释 historical rate、long-context、service-tier coverage。
- partial 金额的 UI title/辅助文案明确“已知下限”。

### T-COST-072 USD 主显示

- 继续显示 `$xx.xx` 时，不在数值前恢复 `>=`。
- coverage 状态不因主显示简化而丢失。

### T-COST-073 历史模型显示

- GPT-5.5 / GPT-5.4 / GPT-5.6 历史 Task 显示实际 recorded model 和对应 rate version。
- 不把历史模型全部改写成当前模型。

## 11. Reconciliation / Real History

### T-COST-080 旧 estimator 对照

输出只读报告，至少分离：

```text
old current-price API-equivalent
historical base-rate adjustment
subscription-policy adjustment
long-context adjustment
fast adjustment
unavailable/unknown adjustment coverage
new subscription-standard-equivalent
```

不能只给“新金额比旧金额大多少”，否则无法审计差异来源。

### T-COST-081 long-context candidate inventory

- 统计真实历史中 `input >272K` 的 verified usage units。
- 正式启用 multiplier 前确认 request-boundary evidence gate 结果。

### T-COST-082 service-tier inventory

- 统计 default / fast / priority / unknown 的 event 数和 token 覆盖。
- unknown 不能被合并到 default。

### T-COST-083 source read-only

- 真实 rollout 验证前后 SHA-256 不变。

## 12. 执行顺序

开发必须按以下阶段推进：

1. `T-COST-001~013`：Historical Catalog + 普通 request cost。
2. `T-COST-020~025`：long-context 及 request-boundary gate。
3. `T-COST-030~034`：Fast/service tier。
4. `T-COST-040~052`：Task/Agent/Session/Day 聚合。
5. `T-COST-060~065`：parser/schema/migration。
6. `T-COST-070~073`：API/UI contract。
7. `T-COST-080~083`：真实历史 reconciliation。
8. `npm test`。
9. `npm run check`。
10. `git diff --check`。
11. 真实浏览器桌面/窄屏验收（如果实现触及 UI）。

任何阶段失败都回到设计文档核对，不允许跳过前置 gate 后继续累加功能。

## 13. 完成门槛

Phase 17 测试验收至少要求：

- [ ] Historical rate boundary 全部通过。
- [ ] Sol promotion 不污染 subscription-standard policy。
- [ ] Request-level long-context 边界和 full-request multiplier 通过。
- [ ] Task-level 272K false positive 被回归测试锁死。
- [ ] Fast as-of-ordinal attribution 通过。
- [ ] Fast + long-context 不发生未证明的倍率叠乘。
- [ ] cache-write 不按 API surcharge 双重收费。
- [ ] Token Ledger migration invariant 逐字段通过。
- [ ] Full/Day/Timeline cost 守恒。
- [ ] 真实历史报告能解释新旧费用差异来源。
- [ ] `.codex` 源文件哈希不变。
- [ ] 全量测试、语法检查、diff check 通过。
