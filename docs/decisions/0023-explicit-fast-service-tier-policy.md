# ADR-0023：仅显式 `fast` 启用 Fast 定价

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

ADR-0019 最初把 `priority` 视为 Fast alias，并在 service tier 缺失或未知时降低 pricing coverage。当前产品计费口径已明确调整为更严格、也更容易审计的业务规则：**只有 Request 的原始 `service_tier` 明确标明为 `fast`，才允许应用 Fast multiplier；其余任何值都按标准层级计费。**

该规则影响 Request cost、Task/Agent/Session 汇总、Timeline 持久化 cost projection 以及 UI 的“服务层级”显示，但不改变 Request identity、Token accounting、long-context 判定或历史模型价。

## Decision

- Pricing normalization 固定为：`trim(lower(rawServiceTier)) === "fast" -> fast`；其他所有情况，包括 `default`、`standard`、`priority`、缺失值和未知字符串，统一为 `standard`。
- 原始 `serviceTier` 继续保留在 canonical Request / raw evidence 中用于审计；只改变 pricing interpretation，不改写源 evidence。
- 不再因为 service tier 缺失或未知而生成 `service_tier_unknown` partial cost。只要模型、历史价、Request usage 等其他证据完整，该 Request 按 standard 得到 `estimated` cost。
- Fast multiplier 仍由模型族 pricing policy 决定；只有规范化结果为 `fast` 才应用。Fast + long-context 的既有冲突规则保持不变。
- UI 只显示 `fast · N 倍率` 或 `standard`；`priority` 不再显示为 Fast。
- Subscription pricing policy 升级为 `subscription-standard-v2 / 2026-08-28-explicit-fast`。数据库启动时若检测到持久化 `pricing_policy_version` 不一致，从已持久化 canonical/raw projection 重新生成 cost/calendar projection；不得通过回放或修改 `.codex` 修复旧金额。

## Alternatives considered

- **继续把 `priority` 当作 Fast alias：** 拒绝。与当前产品规则“只有明确 fast 才是 Fast”冲突。
- **缺失 service tier 时维持 unknown/partial：** 拒绝。当前业务规则已经给出默认解释：非显式 fast 即 standard。
- **只改 UI，不改 pricing engine：** 拒绝。会造成页面标签与实际 USD 计算口径不一致。
- **覆盖已有 calendar cost 而不记录 policy version：** 拒绝。无法保证重启后历史 Timeline 与当前 pricing policy 一致。

## Consequences

- 历史 `priority`、missing、unknown service tier Request 会按标准价重新计算；其中原本仅因 tier 缺失而 partial 的 Request 将恢复为 estimated。
- Fast 使用更保守：任何非字面 `fast` evidence 都不会触发 Fast multiplier。
- Token、Request count、日期归属和 canonical ownership 完全不变；变化只发生在 pricing interpretation 与其派生 USD/coverage。
- 本 ADR 修订 ADR-0019 与 ADR-0022 中关于 `priority -> fast` 和 missing-tier coverage 的旧约定。
