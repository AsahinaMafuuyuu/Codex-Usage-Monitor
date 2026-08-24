# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 的结构；版本号从 MVP 的 `0.1.0` 开始。

## [Unreleased]

### Added

- 逐任务模型和 reasoning effort 展示。
- 基于版本化官方标准 API 价目的 USD 短上下文等值估算、分项、覆盖状态与价目复核提示。
- 每个智能体自身/含后代费用，以及完整会话/仅子智能体费用汇总；部分覆盖显示已知下限。
- 根会话 `cwd` 工程目录持久化与按完整路径分组的会话导航。
- 会话输入/输出/总缓存命中率，以及智能体和任务级缓存命中率。

### Changed

- 任务 API 增加 `costEstimate`，智能体增加 `ownCostEstimate` / `subtreeCostEstimate`，session snapshot 增加 `pricing`、`summary.totalCostEstimate` 和 `summary.subagentCostEstimate`；未知模型或不完整 token 明细不再生成伪精确费用。
- SQLite 升级到 schema v6，以 nullable `project_path` 保存根会话定位元数据；列表与 snapshot API 增加 `projectPath`。
- 任务表移除指令预览列及其前端读取逻辑；受认证的 preview API 暂时保留供后续完整对话功能重新设计。

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
