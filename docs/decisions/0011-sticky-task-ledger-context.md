# ADR-0011：固定任务审计上下文并强化横向浏览

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Phase 8 将逐任务审计统一为固定宽度账页，以保证模型、effort、输入、缓存、输出、总量、费用和质量字段不会因窄屏而被隐藏。Phase 9 Decision 2 又减少了深层 Agent 谱系的横向损失，但任务表本身仍只有原生横向滚动：用户一旦向右查看模型、token 或费用，最左侧的 Task 与 Status 会离开视野，行上下文需要依赖记忆；同时细滚动条对“这里还有更多列”的提示不足。

该问题属于审计浏览上下文，而不是数据密度问题。按设备删除字段或把审计列压缩到无法读取都会破坏 ADR-0009 已冻结的完整审计契约。后续产品决策允许删除对主扫描路径重复度较高的独立 reasoning 展示列，但底层 `reasoningOutputTokens` 仍保留在审计数据与费用计算中。

## Decision

- 任务账页展示 13 列并使用 `1314px` 固定表格宽度；独立“推理”展示列被移除，但 `outputTokens`、`totalTokens`、费用估算以及底层 reasoning 数据契约不变，不引入按屏幕尺寸继续隐藏列的行为。
- 所有表头与对应数据单元格统一居中对齐；数字仍使用 monospace + tabular numerals，因此居中不会牺牲同列纵向比较能力。
- 将 Task 与 Status 设为同一横向滚动容器内的 sticky context：Task 固定在 `left: 0`，Status 固定在 `left: 160px`，与既有两列宽度严格对齐。
- sticky 区域使用不透明 paper / paper-deep 背景，Status 右侧增加 hairline 与轻微阴影，使冻结上下文与可滚动数据形成明确边界，同时保留整行 hover 状态。
- `.task-table-wrap` 继续作为唯一横向 overflow 边界；横向 scrollbar 使用 8px 的 muted-clay thumb 与暖灰 track，在保持可发现性的同时减少视觉重量，并设置 `overscroll-behavior-x: contain`，避免任务表横向浏览扩散为页面级滚动。
- 将 `.task-table-wrap` 暴露为可键盘聚焦的 `region`，提供说明“任务与状态列固定，可横向滚动查看完整 13 列”，并复用 clay `:focus-visible` 焦点环。

## Alternatives considered

- **按屏幕尺寸隐藏 token / model / cost / quality 列：** 拒绝。会把完整审计表退化为设备依赖摘要表。
- **保留独立 reasoning 列：** 未采用。reasoning 已包含在输出语义与费用明细中，作为高频浏览列会增加横向成本；原始字段继续保留在 API/内部审计链路中。
- **仅保留浏览器默认横向滚动条：** 拒绝。滚动后缺少任务身份与状态上下文，且滚动 affordance 仍偏弱。
- **冻结 Task、Status、Start、Model 等更多列：** 拒绝。会在 390px 窄屏中占据大部分可视宽度，使真正需要横向检查的数据只剩极窄窗口。
- **只冻结 Task 一列：** 可用但未采用。Status 是判断任务活动/完成状态的首要语义，与 Task 一起固定仍能在 339px 典型窄屏容器中留下约 103px 的滚动数据窗口。
- **冻结 Task + Status 并强化 scrollbar：** 采用。横向滚动条维持明确的主题色对比，但从旧的 10px 高度收敛到 8px，避免抢占账页视觉层级。

## Consequences

- 横向滚动到模型、token、USD 或质量区域时，任务序号/turn ID 与状态仍持续可见，减少跨行误读。
- 表格从 14 列缩减为 13 列，固定宽度由 1390px 收敛到 1314px；表头和值统一居中，减少“标题右对齐、内容结构不一致”的视觉噪声。
- 典型窄屏容器中固定两列约占 236px，因此可滚动数据窗口更窄；这是完整上下文与数据可见性的显式权衡，不应继续增加 sticky 列。
- 后续若调整 Task 或 Status 列宽，必须同步修改 sticky `left` 偏移和静态 UI 契约，避免冻结列重叠或产生空隙。
- 后续 Overview 重组与 Agent 展开策略不得在本决策中混入；它们继续作为独立 Phase 9 视觉提交处理。
