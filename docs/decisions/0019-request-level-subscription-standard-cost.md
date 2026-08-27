# ADR-0019：以 Request Ledger usage unit 计算订阅标准价等值费用

- **Status:** Accepted / implementation pending
- **Date:** 2026-08-26

## Context

ADR-0007 建立了版本化标准 API 短上下文等值估算，但当前实现仍有三个结构性问题：

1. 所有历史任务使用当前 rate card，无法表达模型历史价格。
2. 费用在 Task usage 汇总后计算，无法正确处理以单次请求 input `>272K` 判断的 long-context multiplier。
3. GPT-5.6 Sol 当前 token-based USD/API 促销并不改变 included plan usage、5-hour/weekly limits 或 legacy metering；项目主要用于订阅用户，因此 API 促销价不是用户希望比较的标准等值口径。

Request Ledger 已保存逐 verified model-usage unit 的六字段 usage 和 `observedAt`。真实 rollout 还存在 `thread_settings_applied.thread_settings.service_tier`，因此历史模型、历史标准价、long context 和 Fast 都可以在不改变 Token Ledger 基本算法的前提下建立独立 Pricing 层。

## Decision

- 页面 USD 的业务语义改为 **Subscription Standard-Rate Equivalent**，不是 API invoice，也不是 Plus 实际 quota/账单。
- Token Ledger 不变；费用改为逐 verified Request Ledger usage unit 派生，再向 Task / Agent / Session / Day / Timeline 求和。
- 价目目录按 `policy + model + effective interval` 版本化；使用 event `observedAt` 选历史价格，不允许当前价重算全部历史。
- GPT-5.6 Terra/Luna 从 2026-07-30 起采用官方已反映到付费订阅 usage 的新标准价；Sol 2026-08-21 的临时 token-based USD 促销不作为本 subscription-standard policy 的切价点。
- long context 只能在 request-level evidence 可证明时应用；`input >272K` 时整个 request 的 input/cached input 2×、output 1.5×。不得使用 Task 累计 input 判断。
- Fast 只使用 event 当时可证明的 `service_tier`；`fast` 和 `priority` 规范化为 Fast，unknown 不猜测。
- 当前官方说明 Fast 不支持 long context，因此二者同时出现时作为不支持/冲突 evidence，禁止盲目叠乘。
- subscription-standard policy 不沿用 GPT-5.6 API cache-write 1.25× surcharge；`cacheWriteInputTokens` 继续用于审计，但属于非 cached input 的标准计价组成，除非后续获得明确的 subscription/legacy metering 证据。
- 最终美元金额不持久化；仅持久化 event-level 最小 pricing context，以便未来价目更新后仍能确定性重算。

## Evidence boundary

现有 Request Ledger 的 verified usage unit 虽由 `last_token_usage` 和累计快照逐字段证明，但项目尚不把它宣称为 HTTP/billing request 一一映射。

因此在正式启用 long-context multiplier 前，实现必须先通过官方源码/文档或可重复 fixture 证明该 usage unit 可以作为 272K threshold 的请求边界。未通过时只报告 long-context candidate，并降低 cost coverage。

## Alternatives considered

- **继续 Task-level pricing：** 拒绝。多个普通 request 的 Task 累计 input 可以超过 272K，造成 long-context false positive。
- **所有历史使用当前价：** 拒绝。会让历史费用随今天的价格漂移。
- **直接采用 Sol 当前 `$4/$0.40/$20`：** 拒绝作为本 policy 的 Sol 标准等值。官方说明该临时促销不改变 included-plan / legacy metering。
- **从 quota 百分比反推美元：** 拒绝。没有官方一一换算关系。
- **Fast/long-context evidence 缺失时按最可能值猜测：** 拒绝。与项目审计边界冲突。
- **Fast 与 long-context 直接相乘：** 拒绝。当前官方 Fast FAQ 说明 Fast 不支持 long context。

## Consequences

- `src/pricing.js` 将从 Task-level current rate card 演化为 historical catalog + request-cost engine + feature policy。
- `model_usage_events` 预计需要保存 event-level model/service-tier/evidence metadata，schema 预计升级为 v13。
- v12 历史 service tier 未持久化，若原 rollout 仍存在，需要一次只读 metadata enrichment；rollout 不存在时该 feature coverage 保持 unknown。
- Task/Agent/Session/Timeline 的 token 数不应因本 ADR 变化；变化只发生在 cost basis、coverage 和金额。
- ADR-0007 的“API-equivalent”费用方向在 Phase 17 实现完成后将被本 ADR 替代；实现前仍可作为当前代码行为的历史说明。

## Official references

- https://openai.com/index/previewing-gpt-5-6-sol/
- https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
- https://help.openai.com/en/articles/20001415
- https://help.openai.com/en/articles/11647665
- https://developers.openai.com/api/docs/models/gpt-5.6-sol
