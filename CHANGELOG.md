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

### Changed

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
- 日期账页 API 使用与逐任务会话相同的累计边界差分，覆盖未被选中的 session；日期按本地时区归类，质量不完整时不生成伪精确总量。

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
