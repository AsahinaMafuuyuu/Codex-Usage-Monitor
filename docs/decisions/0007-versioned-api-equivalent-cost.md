# ADR-0007：使用版本化官方 API 价目估算任务、智能体和会话美元等值

- **Status:** Accepted
- **Date:** 2026-08-24

> 2026-08-26 更新：价目、公式与覆盖语义继续有效；schema v10 起传给定价器的主 `deltaUsage` 已由 [ADR-0015](0015-request-ledger-primary-aggregation.md) 切换为 verified Request Ledger 派生值，SQLite 中保留的 Boundary `delta_usage` 不再作为费用 fallback。

## Context

任务已经持久化模型、effort 和六类累计 token 边界差分，但用户还需要逐任务、每个智能体及完整会话的美元计费效果。Codex Desktop 的本地 rollout 和账号级 `rate_limits` 不提供逐任务实际账单金额；订阅额度百分比也不能换算成美元。官方模型页提供标准 API 的 input、cached input、output 单价，GPT-5.6 还明确给出 cache write 为普通 input 的 1.25 倍。

Rollout 的任务边界差分聚合一个 turn 内的多次响应，不能证明每次请求的上下文长度、服务层级、区域处理或收费工具调用。因此它不能重建实际 API 发票，也不能判断超过 272K input 的长上下文加价。

## Decision

- 将美元值定义为“当前标准 API、短上下文等值估算”，不称为实际花费、账单或 Codex 订阅扣费。
- `src/pricing.js` 保存带 `version`、`capturedAt`、`reviewAfter`、来源 URL 和限制列表的本地只读价目表；运行时不联网。
- 支持有官方价目证据的 GPT-5.4、GPT-5.5、GPT-5.6 Sol/Terra/Luna，以及可确定映射的 alias/日期 snapshot。未知内部模型不猜测价格。
- 计算时从 input 中扣除 cached input；GPT-5.6 再扣除 cache write 并按 1.25 倍 input 价单独计算。reasoning tokens 已包含在 output 中，不重复计费。
- 费用由持久化 `model` 与 API snapshot 的当前主 `deltaUsage` 确定性重算，不新增 SQLite 金额列。响应携带价目版本、匹配模型、分项、来源、限制和过期状态。
- 任一必需 token 明细缺失或互相矛盾时返回 `unavailable`，不生成伪精确金额。
- 智能体自身费用仅汇总该线程的任务；含后代费用沿现有 `parentThreadId` 拓扑递归汇总。会话总额覆盖根智能体和全部后代，并另给出子智能体专属合计。
- 汇总保留已估算与不可估算任务数。只要两者并存就标为 `partial`，已知金额只能解释为下限；全部不可估算时金额为 `null`。

2026-08-24 核验的官方来源：

- [GPT-5.6 Sol：$4 input、$0.40 cached input、$20 output / 1M tokens；cache write 1.25×](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5.6 Terra：$2 input、$0.20 cached input、$12 output / 1M tokens；cache write 1.25×](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 Luna：$0.20 input、$0.02 cached input、$1.20 output / 1M tokens；cache write 1.25×](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-5.5：$5 input、$0.50 cached input、$30 output / 1M tokens](https://developers.openai.com/api/docs/models/gpt-5.5)
- [GPT-5.4：$2.50 input、$0.25 cached input、$15 output / 1M tokens](https://developers.openai.com/api/docs/models/gpt-5.4)

## Alternatives considered

- **从 `rate_limits` 百分比反推美元：** 拒绝，它是账号级额度快照，没有单任务或账单语义。
- **把当前估算金额写入 SQLite：** 拒绝，金额会在价目更新后失去可解释性；持久化模型和 token 后按明确版本重算更可审计。
- **对未知模型采用同系列最近价格：** 拒绝，内部 alias、service tier 和模型能力不能可靠推断。
- **逐请求精确重放收费：** 暂不采用，当前任务边界数据不足以证明长上下文、工具费和服务层级。
- **版本化标准 API 等值估算：** 采用，满足美元效果展示，同时保留来源和不确定性。

## Consequences

- 页面能显示逐任务、智能体自身、智能体含后代及会话总计 USD 等值和模型强度，但这些值不代表用户因 Codex 订阅实际支付了相同金额。
- 价格变更时更新独立价目表、测试、ADR/CHANGELOG，并保留新的版本日期；到 `reviewAfter` 后页面会提示价目待复核。
- 工具调用费、Fast/Batch/Flex/Priority、区域加价和不可识别的长上下文加价被明确排除，金额可能低于某些 API 场景的真实费用。
- SQLite 仍只保存派生 token/定位元数据，不新增账单或内容数据；原 rollout 删除后仍可用已存模型和 token 重算。
