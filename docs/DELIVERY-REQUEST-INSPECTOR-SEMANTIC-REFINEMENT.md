# Phase 25.1：Request Inspector Semantic Refinement 交付契约

**状态：** Implemented / Verified  
**日期：** 2026-09-02

## 交付目标

在不改变 Phase 25 read-through 架构与 canonical accounting 的前提下，修正 Request Inspector 对 Input/Reasoning/Runtime Context 的展示语义，消除“User Card = 完整 Input”的误导，并消除 identical reasoning summary 的重复 Card。

设计事实源：

- [设计方案](DESIGN-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)
- [技术实施方案](TECHNICAL-IMPLEMENTATION-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)
- [ADR-0030](decisions/0030-read-through-request-content-inspector.md)
- [ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

> 本文已转为已验证交付记录。下列勾选项均有 unit/API/security、真实 rollout audit/benchmark、Chrome/CDP 或 accounting/read-only evidence 支持。

## 25.1A：Semantic Projection

- [x] Request Content public contract 升级到 v2 或等价明确版本。
- [x] 实现 pre-model evidence cut。
- [x] server projector 负责 `observed_input/runtime_context/observed_interaction` section assignment。
- [x] Runtime Context 只使用明确 allowlist。
- [x] identical reasoning summary 在 projector 层 coalesce。
- [x] reasoning merge 保留 `occurrenceCount` evidence。
- [x] opaque-only reasoning 聚合为 activity count，不宣称内容相同。
- [x] distinct reasoning summary 不被误合并。
- [x] strict-slice Tool Result callId fallback 不回归。
- [x] 不跨 canonical boundary 补正文/工具名。

## 25.1B：UI Semantics

- [x] `Input` -> `Input Tokens`。
- [x] `Cached` -> `Cached Input Tokens`。
- [x] `Output` -> `Output Tokens`。
- [x] `Total` -> `Total Tokens`。
- [x] Token accounting 与正文 evidence 的区别有固定提示。
- [x] 增加 `Observed Input Evidence / 本轮可观察输入证据`。
- [x] 增加折叠 `Runtime Context`。
- [x] 保留独立 `Observed Interaction` chronology。
- [x] no-input-evidence 有可读 empty state。
- [x] reasoning duplicate 使用 occurrence 文案，不显示重复 Card。
- [x] opaque reasoning 不使用“equivalent”文案。
- [x] 720px 下所有 section 可达。

## Truthfulness Gate

- [x] UI 不把 pre-model cut 称为 Provider request start。
- [x] UI 不把 User Card 称为完整 Input。
- [x] Input Tokens 不按 item 拆分/反推。
- [x] Runtime Context 不称为 system/developer prompt。
- [x] Tool Result 不因位置被无证据宣称为 Provider Input。
- [x] reasoning dedupe 只基于完全一致的公开 summary。
- [x] opaque reasoning 不推断正文等价。

## Privacy / Security / Accounting Gate

- [x] SQLite 无正文/schema 变化。
- [x] server/browser 无正文持久化或多 Request cache。
- [x] Session/Day snapshot 与 SSE 不携带正文。
- [x] close/session/day switch 清除正文。
- [x] Runtime Context/Reasoning 全量 escape，CSP 不放宽。
- [x] canonical Request count 与六字段 token 完全一致。
- [x] calendar cost / identity / ownership / diagnostics 不变。
- [x] schema v15 / projection v2 accounting 不变。

## Performance / Automation Gate

- [x] locator/slice hard limits 不放宽。
- [x] common warm P95 `<100ms`。
- [x] slow/near-limit P95 `<250ms`。
- [x] semantic dedupe 不触发额外 source I/O。
- [x] `test/request-content.test.js` 覆盖 cut/runtime/dedupe。
- [x] DB/API/UI security tests Green。
- [x] Chrome/CDP 覆盖真实 duplicate reasoning Request。
- [x] `npm test` Green。
- [x] `npm run check` Green。
- [x] `git diff --check` Green。
- [x] `audit:request-content` / benchmark / fingerprint Green。

## Documentation Gate

- [x] 实现后更新 `docs/API.md` / `docs/ARCHITECTURE.md`。
- [x] 真实验证后更新 `docs/VERIFICATION.md`。
- [x] 用户可见完成后更新 `README.md` / `CHANGELOG.md`。
- [x] Delivery 只在全部 Gate 实际 Green 后改为 `Implemented / Verified`。

## Delivered evidence（2026-09-02）

- `test/request-content.test.js` 最终 focused suite=`16/16 passed`；全量最终回归见 `docs/VERIFICATION.md`。
- `audit:request-content`：canonical Requests=`30,201`，source-present=`29,807`，boundary ambiguous=`0`，bounded policy 可读=`29,801`；6 条 oversized slice 显式 `content_truncated`，394 条历史 source missing 保持 unavailable。
- 20 轮 production-equivalent benchmark：common P95=`0.967ms`，near-limit P95=`0.892ms`，源文件 SHA-256 前后不变。
- Chrome/CDP：1440×900 与 720×900 Green；真实 duplicate reasoning Request `reqr_dd179…cd09` 返回 `occurrenceCount=2`，浏览器 renderer 只生成 1 张 Reasoning Card 并保留 occurrence 文案；opaque-only activity 不使用 equivalent 语义。
- accounting/read-only：canonical/calendar 六字段与 Phase 25 基线完全一致，schema v15 / projection v2 保持；`.codex` manifest 仍为 450 rollout、SHA-256=`8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`。

