# ADR-0011：固定任务审计上下文并强化横向浏览

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Phase 8 将逐任务审计统一为 14 列、1390px 的固定宽度账页，以保证模型、effort、输入、缓存、输出、推理、总量、费用和质量字段不会因窄屏而被隐藏。Phase 9 Decision 2 又减少了深层 Agent 谱系的横向损失，但任务表本身仍只有原生横向滚动：用户一旦向右查看模型、token 或费用，最左侧的 Task 与 Status 会离开视野，行上下文需要依赖记忆；同时细滚动条对“这里还有更多列”的提示不足。

该问题属于审计浏览上下文，而不是数据密度问题。隐藏列、按设备删除字段或把 14 列压缩到无法读取都会破坏 ADR-0009 已冻结的完整审计契约。

## Decision

- 保留全部 14 个审计字段和 `1390px` 固定表格宽度，不引入按屏幕尺寸隐藏列的行为。
- 将 Task 与 Status 设为同一横向滚动容器内的 sticky context：Task 固定在 `left: 0`，Status 固定在 `left: 160px`，与既有两列宽度严格对齐。
- sticky 区域使用不透明 paper / paper-deep 背景，Status 右侧增加 hairline 与轻微阴影，使冻结上下文与可滚动数据形成明确边界，同时保留整行 hover 状态。
- `.task-table-wrap` 继续作为唯一横向 overflow 边界；提高横向 scrollbar 的可见性，并设置 `overscroll-behavior-x: contain`，避免任务表横向浏览扩散为页面级滚动。
- 将 `.task-table-wrap` 暴露为可键盘聚焦的 `region`，提供说明“任务与状态列固定，可横向滚动查看完整 14 列”，并复用 clay `:focus-visible` 焦点环。

## Alternatives considered

- **隐藏低优先级 token / model / cost / quality 列：** 拒绝。会把完整审计表退化为摘要表，并直接违反 Phase 8 的字段可见性契约。
- **仅保留浏览器默认横向滚动条：** 拒绝。滚动后缺少任务身份与状态上下文，且滚动 affordance 仍偏弱。
- **冻结 Task、Status、Start、Model 等更多列：** 拒绝。会在 390px 窄屏中占据大部分可视宽度，使真正需要横向检查的数据只剩极窄窗口。
- **只冻结 Task 一列：** 可用但未采用。Status 是判断任务活动/完成状态的首要语义，与 Task 一起固定仍能在 339px 典型窄屏容器中留下约 103px 的滚动数据窗口。
- **冻结 Task + Status 并强化 scrollbar：** 采用。在不改变审计字段和表格宽度的前提下最大化行上下文保持。

## Consequences

- 横向滚动到模型、token、USD 或质量区域时，任务序号/turn ID 与状态仍持续可见，减少跨行误读。
- 典型窄屏容器中固定两列约占 236px，因此可滚动数据窗口更窄；这是完整上下文与数据可见性的显式权衡，不应继续增加 sticky 列。
- 后续若调整 Task 或 Status 列宽，必须同步修改 sticky `left` 偏移和静态 UI 契约，避免冻结列重叠或产生空隙。
- 后续 Overview 重组与 Agent 展开策略不得在本决策中混入；它们继续作为独立 Phase 9 视觉提交处理。
