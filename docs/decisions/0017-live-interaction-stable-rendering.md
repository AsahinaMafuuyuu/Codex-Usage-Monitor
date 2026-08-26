# ADR-0017：实时快照必须保持交互容器身份稳定

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

ADR-0005 采用完整 session snapshot 的 SSE 推送，使页面可以在 rollout 增量到达后快速反映 token、费用、状态和新任务。此前无框架前端把每个 snapshot 都当成一次完整页面重绘：`renderDashboard()` 会重新生成左侧会话导航和整棵 Agent tree，任务表也随 `<details>` 一起通过 `innerHTML` 被替换。

这种实现的数据结果正确，但破坏浏览器正在持有的交互状态。用户将 `.task-table-wrap` 横向滚到模型或费用列后，下一次 snapshot 会删除原滚动容器并创建新节点，使 `scrollLeft` 回到起点；同样的问题还会影响手工展开/折叠的 Agent、键盘焦点、左侧导航滚动和分组展开状态。结构新增发生在当前视口上方时，即使 DOM 不被整体替换，也可能因为页面高度变化把用户正在阅读的任务推离原位置。

问题的根因不是 SSE 频率，而是“数据更新”和“DOM 生命周期”绑定。降低刷新频率只能降低跳动次数，不能消除交互被重置。

## Decision

- 将“**实时数据更新不得销毁仍然存在的用户交互容器**”设为前端不变量。SSE 仍传输完整 snapshot，但浏览器端不再把完整 snapshot 等同于 destructive render。
- 使用现有稳定身份作为 reconcile key：session 使用 `session.id`，Agent 使用 `threadId`，Task 使用 `turnId`。已有实体继续复用原 DOM；新增、删除或排序变化只移动、插入或移除对应 key 的节点。
- 将 snapshot 更新分为两类：
  - **Value update**：token、费用、状态、耗时、模型、effort、汇总数字等只更新现有节点内容，不替换 `.task-table-wrap`、Agent `<details>` 或 Agent branch。
  - **Structural update**：新 Agent、新 Task、删除或重排才修改 DOM 结构，并继续复用所有未变化 key 的节点。
- Agent `<details>` 的 `open` 在节点首次创建时可由数据决定默认值；节点存在以后，展开/折叠属于 UI 状态，实时 snapshot 不得覆盖用户选择。
- 结构更新前捕获当前 `#agent-tree` 中第一个真正可见的稳定元素：Agent 使用 `<summary data-agent-anchor-id>`，Task 使用 `<tr data-task-id>`。结构 patch 后若该元素仍存在，根据 `getBoundingClientRect().top` 差值调用 `window.scrollBy()`，保持它在视口中的视觉位置；锚点本身被删除时不强制滚动。
- 已选 session 的常规 snapshot 不再重建 `#session-list`。工程视图中的标题、更新时间、Agent 数和 active 状态原位更新；只有工程归属真的变化，或用户主动搜索/切换工程与时间视图时才允许重建导航。主动重建前后保存并恢复导航滚动、分组 `<details>` 状态和可恢复的焦点。
- 不改变后端 SSE 协议、220ms 文件事件合并、1 秒 stat 轮询或完整 snapshot 契约。后续可以独立增加客户端 coalescing 作为性能优化，但不能用节流替代交互稳定性。
- 新增无第三方运行时依赖的 Chrome/CDP 回归脚本。脚本只在浏览器内捕获并回放真实 snapshot listener，构造临时 DOM/内存结构变化验证节点身份、横向滚动、焦点、折叠状态和视觉锚点；不得写入真实 rollout。

## Alternatives considered

- **降低 SSE / 页面刷新频率：** 拒绝。只会把“每次更新都跳”变成“更少次数地跳”，DOM 身份仍然被销毁。
- **完整重绘前保存 `scrollLeft`，重绘后恢复：** 拒绝作为长期方案。随后还必须继续保存 `scrollTop`、`details.open`、focus、导航展开状态等，形成不断扩张的现场恢复补丁，而不是消除破坏来源。
- **检测用户滚动/悬停时暂停实时刷新：** 拒绝。会制造数据滞后和复杂的恢复时机，而且用户停止滚动后的第一次完整重绘仍会打断阅读。
- **为解决状态保持引入 Vue/React 等框架：** 拒绝。稳定 key reconcile 在当前页面规模下可以由一个局部前端模块实现，不需要违反 ADR-0006 的轻量无框架运行时选择。
- **所有结构变化都保持绝对 `window.scrollY`：** 拒绝。绝对像素位置不能表达用户正在阅读的实体；上方内容变化时应保持具体 surviving Agent/Task 的视觉位置。

## Consequences

- 实时 token、状态和费用变化不再重建任务表容器，因此浏览器原生维护的横向滚动位置和键盘焦点可以持续存在；Agent 的手工展开/折叠同样不被 snapshot 改写。
- 新任务或 Agent 插入到当前阅读区域上方时，若原可见锚点仍存在，页面通过等量滚动补偿保持该实体原 viewport offset；如果锚点被删除，则不猜测用户下一阅读目标。
- 左侧导航在常规 selected-session snapshot 中保持节点身份和滚动；搜索、视图切换等明确导航行为仍可进行完整重建，但必须恢复可识别的交互状态。
- 前端 reconcile 实现比单次 `innerHTML` 更复杂，需要稳定 key、局部结构管理和真实浏览器回归覆盖；该复杂度集中在一个渲染 seam，换取调用方不再承担滚动/折叠/focus 恢复逻辑。
- Task `<tr>` 本身保持稳定，但当前实现仍会替换该行内部 cell 内容以更新值；因此不承诺实时数字变化期间保留单元格内部的文本选择。若未来需要编辑型单元格，再将 value patch 下沉到 cell 级即可。
- 完整 snapshot 的网络体积没有因此减少；本 ADR 解决的是交互稳定性，而不是传输增量化。
