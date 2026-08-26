# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 的结构；版本号从 MVP 的 `0.1.0` 开始。

## [Unreleased]

### Added

- 逐任务模型和 reasoning effort 展示。
- 基于版本化官方标准 API 价目的 USD 短上下文等值估算、分项、覆盖状态与价目复核提示。
- 每个智能体自身/含后代费用，以及完整会话/仅子智能体费用汇总；部分覆盖显示已知下限。
- 根会话 `cwd` 工程目录持久化与按完整路径分组的会话导航。
- 会话输入/输出/总缓存命中率，以及智能体和任务级缓存命中率。
- 全部已发现 session 的本地日期用量账页；时间导航按月、日和 session 展开，并保留质量覆盖计数。
- 时间账页为 month/day/session 增加即时 API 等值费用汇总；费用从已持久化 task 模型和 verified Request Ledger 用量按当前价目计算，不把金额写入 SQLite。
- Windows portable source locator：以 `.codex` 相对 source key 持久化 rollout 身份，并在当前用户/自定义 Codex home 下运行时重绑定。
- Verified model-usage event classifier 与内部 Request Ledger：逐字段用累计快照验证 `last_token_usage`，区分 verified increment、duplicate、generation start、unverified 和 anomaly，并以 portable source identity 幂等持久化。
- Phase 13 双账本 reconciliation 迁移证据与 verified model usage unit 指标；Task / Agent / Session / Timeline 可报告 request count 与 tokens/request，同时明确这些单元不等价于 HTTP 请求。

### Changed

- 额度刷新按钮的手写 SVG 替换为本地安装的 Lucide `refresh-cw` 图标；Lucide UMD 资源由 loopback 服务固定映射并受现有 `script-src 'self'` CSP 约束，不引入 CDN 或外部运行时请求。
- 额度卡右上角不再显示“最新/可能过期”文字，改为可点击的刷新图标；点击时调用本地 `GET /api/quota?refresh=1` 重新发现并扫描最近 rollout，按钮在请求期间旋转并禁用重复点击，完成后直接更新 5 小时/1 周剩余额度。该操作不会调用模型或远端服务；Codex 尚未产生新 `rate_limits` 时会明确提示没有新快照。
- 账号额度 current state 对同一 reset 窗口的并发 `rate_limits` 回退做保守 reconciliation：窗口内 `usedPercent` 只向最大已观测值收敛，reset 变化后重新开始；解决并发快照中 `100%` 被更晚的 `97%` 覆盖的问题。额度卡同时从“已使用”改为“剩余”，显示 `100 - usedPercent`，因此满额耗尽显示 `剩余 0%`。
- 任务 API 增加 `costEstimate`，智能体增加 `ownCostEstimate` / `subtreeCostEstimate`，session snapshot 增加 `pricing`、`summary.totalCostEstimate` 和 `summary.subagentCostEstimate`；未知模型或不完整 token 明细不再生成伪精确费用。
- SQLite 升级到 schema v6，以 nullable `project_path` 保存根会话定位元数据；列表与 snapshot API 增加 `projectPath`。
- 任务表移除指令预览列及其前端读取逻辑；受认证的 preview API 暂时保留供后续完整对话功能重新设计。
- 前端从深色卡片仪表盘重构为 Claude 启发的暖色编辑式账页，工程组改为可折叠索引；会话概览进一步按 Activity / Token Flow / Cost 三组重排，费用组使用克制的 clay 标记而不是恢复卡片堆叠。
- 智能体拓扑改为真实递归的连续谱系轨，角色使用显式语义 badge；任务表通过固定 `colgroup` 和 tabular numerals 跨智能体对齐。
- 字体体系按实体标题、UI 正文/标签和机器数据重新分工，移除 8–9px 文本并收敛过大的会话/章节标题；新增可复用 typography tokens 约束后续视觉迭代。
- 深层智能体谱系将每级桌面横向占用从 54px 收敛到 32px、窄屏收敛到 18px；连续父子竖轨/肘线与任务表独立横向滚动边界保持不变。
- 任务审计表将 Task / Status 固定为横向滚动上下文；主账页移除独立 reasoning 展示列后为 13 列 / 1314px，表头和值统一居中。底层 reasoning 字段及费用计算契约继续保留。
- 会话总计 USD 不再用 `≥` 前缀改写金额本身，直接显示汇总对象中的已知金额；覆盖文案和悬停说明仍披露不可估算任务与“已知下限”语义。
- 页面、会话导航和任务表滚动条统一为更轻的 8px 暖 taupe / muted-clay 主题；展开/折叠使用原生 `details` 过渡，会话与导航状态切换在支持时使用 View Transitions API，并继续服从 reduced-motion。
- 实时 session snapshot 从整棵 Agent/Task DOM 重建改为按 `threadId` / `turnId` keyed reconcile；保留任务表横向滚动、焦点和 Agent 展开状态，并在结构新增时用可见 Agent/Task 锚点补偿页面位置。selected-session 更新同时不再重建左侧导航。
- 日期账页 API 覆盖未被选中的 session；当前由 verified Request Ledger 统一聚合，日期按本地时区归类，质量不完整时只报告已验证下限。
- SQLite 升级到 schema v7：任务增加六个正规化 delta 字段，并新增轻量 `session_day_usage` 物化索引；Timeline 从“任意更新后全历史回放”改为 dirty-session + cursor 增量同步，无变化请求只读取 SQL 聚合。
- Timeline 后台补齐不再归档各历史 rollout 中的全部 quota 快照；SQLite page cache 固定约 2 MiB，禁用 mmap 扩张，并使用 256 页 WAL auto-checkpoint 与正常关闭 truncate checkpoint 控制常态内存和 WAL 大小。
- SQLite 升级到 schema v8：`ingest_cursors` 以 `source_key` 为主键，session/agent/task/quota 的 rollout locator 改为 portable key；旧 `.codex` 绝对 locator 在迁移后清空，quota payload 同步去除 `sourcePath`。
- SQLite 升级到 schema v9：新增 privacy-safe `model_usage_events` 双账本；旧 v8 session 在首次迁移时安全 replay 一次补建事件账本，完成后继续复用 cursor。Request Ledger 在 reconciliation 门槛通过前不替换现有 Task Boundary Ledger 聚合。
- SQLite 升级到 schema v10：verified Request Ledger 成为 Task / Agent / Session / Timeline、缓存命中率和费用估算的主用量来源；`tasks.delta_usage/quality` 继续保留 Boundary Ledger 审计证据。`session_day_usage` 增加 `model_request_count`，v9→v10 只重建派生 Agent/Calendar aggregate，不因事实源切换重放 rollout。
- SQLite 升级到 schema v11：结束双账本迁移期，删除 Boundary Ledger parser 计算、`tasks` 中的 baseline/end/delta/quality 与全部 `delta_*` 列、Timeline 的 Boundary 专属质量列、API boundary 审计字段和 `reconcile:request-ledger` CLI；已有 Request Ledger 的 v10 session 迁移时不重读 rollout。旧方案实现固定在 annotated tag `usage-boundary-ledger-v1`（`4a38ba6`），退役完成后的 Request-only 基线标记为 `usage-request-ledger-v1`。
- 默认数据库和相对 `CODEX_MONITOR_DB` 都从工程根解析；工程外绝对 `CODEX_MONITOR_DB` 环境变量会回退项目默认数据库并提示，失效的 `CODEX_MONITOR_HOME` 则回退当前 Windows 用户 `.codex`。任务 preview 通过当前 Codex home 重新绑定 source key，不再依赖数据库中的旧绝对路径。

## [0.1.0] - 2026-08-24

### Added

- `.codex` 根会话、递归子智能体和归档 rollout 发现。
- 以 `total_token_usage` 累计快照边界差分为基础的逐任务归因。
- SQLite WAL schema v5 持久化、可恢复 cursor、跨重启累计 baseline/解析诊断、增量文件观察、额度快照和健康状态。
- 原始 rollout 消失后继续保留已导入任务及汇总；预览明确降级为不可用。
- 仅本机认证 HTTP/SSE API 和无框架中文仪表盘。
- 按需且不持久化的任务指令预览。
- 可证明父→子路由的预览过滤、未知/跳过格式告警和 CSP 无内联样式页面。
- 脱敏结构测试、开发机真实五任务回归和源文件只读哈希校验。
- 项目级多智能体协作规范、交付文档和架构决策记录。

[Unreleased]: docs/ROADMAP.md
[0.1.0]: docs/DELIVERY.md
