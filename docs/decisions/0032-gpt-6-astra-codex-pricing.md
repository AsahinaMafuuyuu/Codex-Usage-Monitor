# ADR-0032：GPT-6 Astra Codex / Work 定价口径

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

GPT-6 Astra 已进入 Codex / Work rollout，模型 ID 为 `gpt-6-astra`。本项目的主费用口径是 **Subscription Standard-Rate Equivalent**，因此不能直接把 OpenAI API model page 的 feature pricing 原样套到 Codex usage。

OpenAI 当前 ChatGPT Work / Codex rate card 给出的 Astra 标准价为每 1M token：Input `$10`、Cached Input `$1`、Output `$50`；Codex Fast 为 `2.5x`。同一 rate card 还明确给出 Astra 的 Codex 例外：`input >272K` 不增加 long-context multiplier，且 Codex 不对 cache write 单独收费。

OpenAI API model page 使用另一套 feature 规则：标准价仍为 `$10 / $1 / $50`，cache write `$12.50`，API long context 与 Fast 规则也与 Codex subscription 口径不同。仓库仍保留旧 API-equivalent estimator 供 reconciliation，因此两套语义必须显式分开。

## Decision

- Subscription historical catalog 从 2026-09-03 起识别 `gpt-6-astra`，标准价固定为 `$10 / $1 / $50`。
- Astra 在 Codex subscription estimator 中使用 `Fast=2.5x`。
- Astra 的 `input >272K` 仍保留为可审计 long-context candidate，但 pricing status 标记为 `exempt`，不应用 `2x input / 1.5x output` multiplier。
- Subscription estimator 继续不对 cache write 单独加价。
- 旧 API-equivalent catalog 同时加入 Astra，并按 API model page 保留 `cacheWriteMultiplier=1.25`；该旧 estimator 仍只表示 standard short-context API reconciliation，不替代 Subscription estimator。
- Subscription pricing catalog 升级为 `subscription-standard-v3 / 2026-09-04-astra-codex`，使已有 Astra canonical Request 的持久化 cost projection 能在启动时从现有 evidence 确定性重建。

## Alternatives considered

- **直接复用 Astra API model page 的 Fast/long/cache-write 规则到 Codex。** 拒绝；会把 API feature pricing 冒充 Work/Codex subscription rate。
- **只增加 `$10/$1/$50`，不提升 pricing policy version。** 拒绝；已有 Astra Request 可能继续保留旧的 `historical_rate_unavailable` projection，直到其他原因触发 rebuild。
- **把 Astra `>272K` 当作 unsupported long context。** 拒绝；官方 Codex rate card 已明确这是免 surcharge，而不是不支持。

## Consequences

- Astra Request 可以进入与其他模型相同的 request-level cost / Task / Agent / Session / Day 汇总。
- Astra Fast 与 long-context candidate 同时出现时不再触发现有 `Fast + long` unsupported combination；long-context 部分明确显示 `exempt`。
- Diagnostics 仍可把 `>272K` 作为显式 pricing feature evidence 展示，但不能将 Astra 的该状态描述为 surcharge。
- Pricing 与 API reconciliation 继续保持两套明确的事实口径，未来任一官方 rate card 变化都必须分别版本化。

## Sources

- https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://openai.com/index/gpt-6-astra/
