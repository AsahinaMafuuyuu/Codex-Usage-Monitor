# ADR-0024：Task 连续滚动与 Request 自适应分页

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

ADR-0022 为长列表统一引入 Task/Request 编号分页。实际使用表明两类数据的浏览语义不同：一个 Agent 的 Task 数通常较少，分页会人为切断连续工作轨迹；单个 Task 的 Request 数却可能很大，仍需要有界分页。Request 只有少量结果时显示完整分页条也会制造无效 UI。

## Decision

- Agent Task 不再分页。每个 Agent 的 Task 表保持全部 Task DOM，使用约 5 行高的纵向滚动视口；超过 5 个 Task 后由该视口独立滚动，同时继续保留横向审计滚动与 sticky 表头。
- Task 纵向滚动采用 **edge chaining**：只要当前 Task 视口在滚动方向仍有剩余距离，就消费该次滚轮；没有纵向 overflow，或已经到达顶部/底部边界时，把该方向的 wheel delta 交给外层 `.workspace`，禁止出现“滚轮被内层空吃掉”的停顿。
- Canonical Requests 默认 10 条/页，可切换 5/10 条。总数少于 10 时完全隐藏分页条；达到分页 UI 阈值后显示每页数量控制，需要多页时才显示页码、前后导航和跳页。
- Request 页码导航最多保留 5 个语义槽位：总页数不超过 5 时全部展示；长分页在首段显示 `1 2 3 … 尾页`，尾段显示 `1 … 尾页-2 尾页-1 尾页`，中段显示 `1 … 当前页 … 尾页`。外侧只保留上一页/下一页，不再重复首/末页双箭头。
- 分页条整体水平居中；前后导航使用项目现有 Lucide chevron 图标并做严格几何居中；跳页输入使用单个纯数字文本框，不暴露浏览器 number spinner。页码导航与翻页内容均有短时 opacity/translate 过渡，并继续服从 `prefers-reduced-motion`。
- 页码按钮、每页数量按钮和跳页输入的文字均在父控件中水平/垂直居中，并沿用现有 parchment/clay 主题。
- Canonical Requests drawer 采用 single-open accordion 语义：同一时刻整个会话只保持最近展开的一个 Task Request drawer 为 open；展开新 Task 时旧 drawer 原位动画收起，但保留已加载缓存，重新展开不要求重新取数。
- Request 的 API `page + limit` 协议保持不变，不新增 schema 或 accounting 语义。

## Alternatives considered

- **Task 继续 10 条分页：** 拒绝。常规 Agent 的 Task 数量不足以证明分页收益，且会损失连续浏览感。
- **Task 全量无高度限制：** 拒绝。极端 session 会把 Agent card 拉得过长，并重新产生页面级滚动负担。
- **Request 固定 5 条或固定 10 条：** 未采用。5 条适合精细审计，10 条适合快速扫描，因此提供 5/10 两档。
- **所有 Request 都显示分页条：** 拒绝。少量结果没有导航价值。
- **允许多个 Request drawer 同时保持展开：** 拒绝。多个大表同时展开会破坏 Task→Request 的视觉焦点，也会显著拉长 Agent 区域。

## Consequences

- Task DOM 数量随单 Agent Task 数增长，但典型数量较低；视觉高度被 5 行视口严格限制。
- Request 网络/DOM 仍受 5/10 页大小约束，长 Request 列表不会一次性加载。
- SSE 更新必须继续保留 `.task-table-wrap` 的水平和垂直滚动状态；浏览器回归同时验证 Task 纵向 overflow、底部/无 overflow wheel chaining、Request single-open、5/10 切换、Lucide icon 几何居中及分页动画。
