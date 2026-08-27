# ADR-0012：按本地日期建立全量用量账页

- **Status:** Accepted
- **Date:** 2026-08-25

> 后续实现说明：本 ADR 的日期口径和覆盖范围继续有效；“内存缓存失效后全量回放全部 rollout”的实现策略已由 [ADR-0013](0013-incremental-calendar-index.md) 替换为持久化 session-day 索引和 cursor 增量同步。
>
> 2026-08-26 更新：本 ADR 的 `startedAt` 本地日期归属和 month → day → session 契约继续有效；token 聚合来源已由 [ADR-0015](0015-request-ledger-primary-aggregation.md) 切换为 verified Request Ledger，并由 [ADR-0016](0016-retire-boundary-ledger.md) 在 schema v11 确认为唯一运行时统计源。
>
> 2026-08-26 后续更新：month → day → session 信息架构继续有效，但 `startedAt` 日归属已由 [ADR-0018](0018-day-scoped-request-ledger-snapshot.md) 更新。时间视图的 usage 按 verified Request Ledger event `observedAt` 所在本地自然日切片，详情 scope 为 `session + day`；工程视图仍为完整 session。

## Context

当前页面以根 session 和智能体谱系为入口。它适合审计单个工作，但用户无法直接回答“某一天全部 Codex 工作合计用了多少 token”，因为启动时只索引 session 元数据，只有用户选择某个 session 后才完整解析其 rollout。按会话更新时间或 rollout 目录日期聚合也会漏掉未选择的 session，并且不能明确日期时区。

本机 2026-08-24 的真实 rollout 审计显示，四个根 session、35 个任务的可计算 `total_tokens` 为 `170,393,639`，其中 34 个边界完整、1 个累计值倒退。这个量级接近 Codex 个人资料展示的约 1.8 亿，但个人资料的服务端时间边界和请求级口径不在本地 rollout 可证明范围内。

## Decision

- 新增只读 `GET /api/timeline`，为所有已发现根 session 创建临时 `SessionRolloutParser`，复用 `total_token_usage` 的任务边界差分和 `subagent_history_start_ordinal` 排除规则。
- 按任务 `startedAt` 转换到监控器运行环境的本地时区，生成 `month -> day -> session` 层级；月份和日期降序展示，同一天的 session 按已知 total token 降序展示。
- 月份、日期和 session 均返回六类 token、任务数和质量计数。只有有 `deltaUsage` 的任务进入 token 合计；`partial`、`estimated`、`discontinuity`、`unknown` 任务仍进入任务数和质量计数，不补造精确 token。
- 日期缺失的任务进入 `unattributed`，不静默丢弃。聚合仅存在于监控器内存缓存；rollout 追加、发现或重新索引后缓存失效，下一次请求全量重建。
- 前端保留工程模式，增加时间模式，用原生可访问 `details` 从月展开到日，再展开当天 session；两种模式共享搜索和现有 session 选择流程。

## Alternatives considered

- **只对已打开的 session 做日期汇总：** 拒绝，会重复当前“按 session 浏览”的范围缺陷，无法解释个人资料的账号级总量。
- **按 rollout 文件夹 `YYYY/MM/DD` 分组：** 拒绝，文件夹是记录落盘位置，不能证明任务开始的本地日期，也不能正确处理跨时区或跨午夜任务。
- **按 UTC 日期字符串截取：** 拒绝，用户在本地时区工作；日期键必须与页面显示时区一致。
- **把日期汇总持久化为 SQLite 表：** 暂不采用。它是可由当前派生任务重算的查询缓存，会引入迁移、失效和与源文件状态不一致的额外状态；内存缓存已满足本地观察规模。
- **把个人资料 1.8 亿作为校准值补齐本地差额：** 拒绝，个人资料不是本地 rollout 的事实来源，差额可能来自时间边界、服务端记录或未知字段。

## Consequences

- 时间视图可以覆盖从未被用户打开过的 session，能直接查看某天的本地 rollout 总量和贡献 session。
- 第一次请求时间账页需要回放全部发现的 rollout，读取成本高于选择单个 session；缓存会避免重复成本，源文件变化后再重建。
- 日期 total 是本地可审计 delta 的已知合计，不是 Codex 订阅额度、账单 token 或个人资料字段的保证复刻。质量计数必须和总量一起展示。
- 该功能不新增 prompt、response、消息正文或标题持久化，不修改 `.codex`，不联网，也不改变当前 session 的增量恢复和 SSE 行为。
