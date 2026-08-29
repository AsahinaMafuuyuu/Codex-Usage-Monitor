# 架构决策记录（ADR）

ADR 记录已经做出的、会约束后续实现的重要选择。`Accepted` 表示当前实现必须遵循；被替代时保留原文件并标记 `Superseded by ADR-NNNN`，不得删除历史。

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-read-only-rollout-observer.md) | Accepted | 使用本地只读 rollout observer |
| [0002](0002-cumulative-boundary-delta.md) | Superseded by ADR-0016 | 历史 Boundary Ledger：用任务边界累计快照做差分 |
| [0003](0003-metadata-only-persistence.md) | Accepted | SQLite 仅持久化派生元数据 |
| [0004](0004-loopback-session-security.md) | Accepted | 采用 loopback 和启动会话安全边界 |
| [0005](0005-file-observer-and-sse.md) | Accepted | 使用文件观察、轮询与 SSE 实时更新 |
| [0006](0006-node-builtins-and-vanilla-ui.md) | Accepted | 使用 Node 内置模块和无框架页面 |
| [0007](0007-versioned-api-equivalent-cost.md) | Superseded by ADR-0019 | 历史标准 API 短上下文等值 estimator |
| [0008](0008-project-directory-session-grouping.md) | Accepted | 按根会话工程目录分组并统一缓存命中率口径 |
| [0009](0009-editorial-lineage-interface.md) | Accepted | 使用编辑式账页、连续谱系轨和显式角色标签 |
| [0010](0010-typography-hierarchy.md) | Accepted | 建立实体、正文、辅助与机器数据分离的字体职责和可读字号层级 |
| [0011](0011-sticky-task-ledger-context.md) | Accepted | 固定任务与状态上下文并强化 13 列审计表的横向浏览可发现性 |
| [0012](0012-calendar-usage-ledger.md) | Accepted | 用本地日期聚合全部 rollout，并以月→日→session 展开 |
| [0013](0013-incremental-calendar-index.md) | Accepted | 用 SQLite session-day 物化索引和 cursor 增量同步替代 Timeline 全历史回放 |
| [0014](0014-portable-source-locators.md) | Accepted | 用 `.codex` 相对 source key 解耦 Windows 用户名、盘符和持久化 cursor 身份 |
| [0015](0015-request-ledger-primary-aggregation.md) | Accepted | 以累计快照验证后的 Request Ledger 作为 Task / Agent / Session / Timeline 主聚合事实源 |
| [0016](0016-retire-boundary-ledger.md) | Accepted | 退役 Boundary Ledger 运行时/存储/API，以 Request Ledger 作为唯一统计事实源 |
| [0017](0017-live-interaction-stable-rendering.md) | Accepted | 用稳定 DOM key、局部 reconcile 与视觉锚点保护实时更新期间的滚动、展开和焦点状态 |
| [0018](0018-day-scoped-request-ledger-snapshot.md) | Accepted | 时间视图按 Request Ledger `observedAt` 构造 `session + day` slice，工程视图保留完整 session |
| [0019](0019-request-level-subscription-standard-cost.md) | Accepted | 逐 Request Ledger usage unit 按历史订阅标准价、长上下文与 Fast evidence 计算 USD 等值 |
| [0020](0020-canonical-request-ownership-and-projections.md) | Accepted | 以 lineage 解析 canonical Request ownership，Time 按 Request-day 投影，并用后台 versioned SQL projection 替代点击时全历史重算 |
| [0021](0021-task-business-request-accounting-scope.md) | Accepted | Task 作为业务分组、Request 作为计量与日期原子；Time 使用 Task Day Slice 并按需展开 Request |
| [0022](0022-independent-task-request-audit-navigation.md) | Accepted | 将 Canonical Requests 移出父表 overflow，建立独立滚动与稳定 drawer；Task 分页交互后由 ADR-0024 替代 |
| [0023](0023-explicit-fast-service-tier-policy.md) | Accepted | 只有原始 service tier 明确为 `fast` 才应用 Fast；其余值统一按 standard 定价 |
| [0024](0024-task-scroll-request-pagination-ergonomics.md) | Accepted | Task 使用约 5 行纵向滚动视口；Request 使用自适应 5/10 条分页与居中导航 |
| [0025](0025-official-codex-usage-polling.md) | Accepted | 账号额度只读查询 Codex 官方 Usage，并以 60 秒周期刷新；Task/Token/Cost 继续保持本地事实源 |

## 新增 ADR

文件名使用 `NNNN-short-name.md`。最少包含：

- `Status`
- `Date`
- `Context`
- `Decision`
- `Alternatives considered`
- `Consequences`

ADR 描述“为何作出选择”和长期后果，不替代具体实现文档或任务清单。格式变化、隐私、安全、API 或 schema 决策必须引用可复核的测试或官方证据。
