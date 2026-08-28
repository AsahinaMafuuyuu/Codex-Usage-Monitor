# ADR-0024：Task 连续滚动与 Request 自适应分页

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

ADR-0022 为长列表统一引入 Task/Request 编号分页。实际使用表明两类数据的浏览语义不同：一个 Agent 的 Task 数通常较少，分页会人为切断连续工作轨迹；单个 Task 的 Request 数却可能很大，仍需要有界分页。Request 只有少量结果时显示完整分页条也会制造无效 UI。

## Decision

- Agent Task 不再分页。每个 Agent 的 Task 表保持全部 Task DOM，使用约 5 行高的纵向滚动视口；超过 5 个 Task 后由该视口独立滚动，同时继续保留横向审计滚动与 sticky 表头。
- Canonical Requests 默认 10 条/页，可切换 5/10 条。总数少于 10 时完全隐藏分页条；达到分页 UI 阈值后显示每页数量控制，需要多页时才显示页码、首末/前后导航和跳页。
- 分页条整体水平居中；导航符号提高字号；跳页输入使用单个纯数字文本框，不暴露浏览器 number spinner。
- 页码按钮、每页数量按钮和跳页输入的文字均在父控件中水平/垂直居中，并沿用现有 parchment/clay 主题。
- Request 的 API `page + limit` 协议保持不变，不新增 schema 或 accounting 语义。

## Alternatives considered

- **Task 继续 10 条分页：** 拒绝。常规 Agent 的 Task 数量不足以证明分页收益，且会损失连续浏览感。
- **Task 全量无高度限制：** 拒绝。极端 session 会把 Agent card 拉得过长，并重新产生页面级滚动负担。
- **Request 固定 5 条或固定 10 条：** 未采用。5 条适合精细审计，10 条适合快速扫描，因此提供 5/10 两档。
- **所有 Request 都显示分页条：** 拒绝。少量结果没有导航价值。

## Consequences

- Task DOM 数量随单 Agent Task 数增长，但典型数量较低；视觉高度被 5 行视口严格限制。
- Request 网络/DOM 仍受 5/10 页大小约束，长 Request 列表不会一次性加载。
- SSE 更新必须继续保留 `.task-table-wrap` 的水平和垂直滚动状态；浏览器回归同时验证 Task 纵向 overflow、Request 5/10 切换及分页居中。
