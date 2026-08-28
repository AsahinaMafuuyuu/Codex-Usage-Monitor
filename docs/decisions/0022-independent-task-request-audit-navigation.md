# ADR-0022：Task / Request 审计采用独立分页与滚动边界

- **Status:** Accepted
- **Date:** 2026-08-28

> 2026-08-28 后续更新：Task 的“10 条编号分页”交互已由 [ADR-0024](0024-task-scroll-request-pagination-ergonomics.md) 替代为约 5 行高的连续纵向滚动；本 ADR 关于 Request 独立 drawer、独立横向滚动、稳定 page API 与交互状态的其余决策继续有效。

## Context

ADR-0011 将 Task 表定义为可横向滚动的完整审计账页，ADR-0017 又要求实时 SSE 更新不能破坏滚动、焦点与展开状态。Phase 19 在 Task 行内加入 Canonical Requests `<tr>` 后产生新的嵌套交互冲突：Request 明细虽然拥有自己的表格，但仍处在父 `.task-table-wrap` 的 overflow 坐标系内，因此父表横向滚动会同时移动 `Canonical Requests` 标题和整个明细区域；长 Task / 多 Task 还会一次性扩张 DOM，降低扫描与定位效率。

这不是 Token/Cost 口径问题。Request Ledger、Task identity、day scope 与 pricing evidence 均保持不变，需要调整的是 UI 容器边界和只读分页协议。

## Decision

- 每个 Agent 的 Task 列表固定按 **10 Task / page** 展示，并提供首/末页、前/后页、最多 5 个相邻页码及数字跳转。分页状态以 `session + day + threadId` 为 key，切换 session/day 时清空。
- Canonical Requests 固定按 **10 Request / page** 展示。现有 cursor API 保留；HTTP 接口新增与 cursor 互斥的 `page` 模式，并返回 `page/pageSize/totalItems/totalPages`。页面使用编号分页，数据库仍按 `(observed_at, request_id)` 稳定排序。
- Request 明细不再作为父 Task `<table>` 内部的 `<tr>`。它作为 Agent card 内、Task 横向滚动容器之外的独立 audit drawer；因此 Task scrollbar 只移动 Task 列，Request drawer 和 `Canonical Requests` 标题保持在 Agent 可视宽度内。
- 每个 Request drawer 自己拥有 `.request-audit-scroll` 横向 overflow；Request 列的移动不得写回或联动父 `.task-table-wrap.scrollLeft`。
- Task 的 `N Requests` 使用明确的 capsule affordance；整个 Task cell button 保持键盘可操作，胶囊补充 hover / active / focus 可见反馈。
- drawer 顶部使用居中的三横线 grip 作为收起入口；收起不销毁 drawer DOM，而是切换稳定 `data-open` 状态并通过 grid-row/opacity/translate 过渡。`prefers-reduced-motion` 继续覆盖动画时长。
- 可见表标题属于滚动容器上下文而不是数据列；任务表 caption 固定在当前容器视口左侧。Request 标题天然位于 Request scrollbar 之外，仅 Request 表列发生横向移动。
- `service_tier` UI 只规范化为 `standard` 或 `fast · N 倍率`。具体 Fast 判定由 ADR-0023 约束：只有原始 `fast` 才进入 Fast；`N` 必须来自 request cost 的实际 `multipliers.fast`。不得把 long-context output 的 `1.5×` 当成 Fast 倍率硬编码。

## Alternatives considered

- **继续把 Request detail 作为 Task table 的 colspan `<tr>`，再依赖 CSS sticky：** 拒绝。Chrome table formatting context 会让 nested sticky 在父 horizontal overflow 中继续随表格位移，无法形成可靠独立坐标系。
- **用 JavaScript 根据父 `scrollLeft` 实时反向 translate Request drawer：** 拒绝。会引入 scroll handler、动态 inline style/CSS 变量和额外 repaint，并违反当前 self-only CSP/UI 静态样式约束。
- **一次加载全部 Request，再仅前端 slice：** 拒绝。会让长 Task 网络 payload 和浏览器内存重新随 Request 数量线性增长，也失去数据库分页性能边界。
- **只保留 cursor 的“加载更多”：** 未采用作为主 UI。它适合流式顺序读取，但用户明确需要“共多少页”和直接跳页；cursor 仍保留 API 兼容性。
- **所有模型统一显示 `fast · 1.5 倍率`：** 拒绝。现行 pricing policy 已冻结 GPT-5.6/GPT-5.5 Fast 2.5×、GPT-5.4 Fast 2×；1.5×属于 long-context output multiplier，硬编码会产生事实错误。

## Consequences

- 父 Task 横向滚动与子 Request 横向滚动完全解耦；`Canonical Requests` 标题不会再随父表位移。
- 每个 Agent 常规 DOM 最多保留当前页 10 个 Task row；每个已展开 Task 最多保留当前页 10 个 Request row，初始 snapshot 仍不携带 Request detail。
- Request detail 从“视觉上紧贴某一 table row”调整为该 Agent 的独立 audit drawer；Task 标题、turn id 与 `N Requests` toggle 保持明确归属，换取可靠的独立 scroll/focus/pagination 边界。
- 编号分页需要一个额外 `COUNT(*)` 查询；它使用与 detail query 相同过滤条件，Request rows 仍走 `idx_canonical_requests_task_observed` 的稳定 task/observed 顺序。现有 cursor 调用方不受影响。
- 浏览器回归必须同时验证：10 条/页、页码跳转、父/子 scrollbar 独立、SSE 后 drawer identity 不变、collapse 保留 DOM 且存在 transition，以及 720px 窄屏任务表滚动状态保持。
