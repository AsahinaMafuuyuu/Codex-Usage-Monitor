# Codex Usage Monitor：智能体协作说明

本文件适用于整个仓库。所有智能体在开始修改前都必须先阅读本文件；更深目录若新增 `AGENTS.md`，以离目标文件最近的规则为补充。

## 项目目标与事实来源

本项目只读观察本机 `.codex` rollout，按子智能体任务展示 token 差分和账号级额度快照。发生冲突时，事实来源优先级如下：

1. 可重复的测试与脱敏 fixture。
2. 用户明确批准的产品计划与 `docs/decisions/` 中已接受的 ADR。
3. 当前 Codex 官方源码或官方文档；必须记录链接和被验证的版本。
4. 本仓库实现和说明文档。

不要凭经验猜测未公开的 rollout 字段、订阅额度换算或账单价格。发现新格式时，保留未知记录并降低数据质量标签，然后用脱敏样本和文档证据推进适配。

## 不可破坏的不变量

- `.codex` 是只读数据源：不得改写 rollout、`session_index.jsonl`、最新的 `state_*.sqlite` 或 `config.toml`。
- 监控器不得启动或 resume Codex App Server，不得启用 Hooks/OTel，不得调用模型或联网补全数据。
- 主任务用量必须来自经相邻 `total_token_usage` 逐字段证明的 Request Ledger 事件；`last_token_usage` 只能作为候选新增量接受累计快照验证，严禁裸累加。任务边界 `total_token_usage` 差分继续作为独立 Boundary Ledger 审计器，不得删除或覆盖。
- 必须尊重 `subagent_history_start_ordinal`，防止分页复制的父历史被重复归因。
- 累计值倒退、缺 baseline、字段缺失、unverified/anomaly 或 total-only 增长时必须保留对应质量/coverage 状态；只有已验证 Request Ledger 部分可以进入主用量，不得用 Boundary Ledger 或补偿系数填平缺口。
- SQLite 只保存派生用量和定位元数据；不得保存 prompt、response、消息正文或会话标题。指令预览只能在已认证请求时从原日志按需读取，不落库、不缓存。
- 服务只能监听 loopback。一次性启动令牌、Strict Cookie、Host/Origin 校验、CSP 和只读 HTTP 方法属于安全边界，不得无 ADR 和测试地弱化。
- 额度是账号级 `rate_limits` 快照，不得换算成单任务百分比、美元价格或账单级精度。
- 任务美元值只能按持久化的模型和 Request Ledger 派生的规范化 token 字段套用版本化官方标准 API 价目，并明确标为等值估算；不得称为 Codex 订阅实际扣费，也不得静默包含无法从 rollout 证明的长上下文、服务层级、区域或工具费用。

## 多智能体角色与所有权

协调智能体在派工前为每项任务指定唯一文件 owner。所有参与者都应假设工作区非独占：不要撤销、覆盖、stash、reset 或重排其他智能体的改动；发现重叠时先通知协调者。

| 角色 | 默认所有权 | 主要职责 |
|---|---|---|
| 协调与集成 | `package.json`、`.git*`、`AGENTS.md`、Git 操作、跨模块契约 | 拆分任务、冻结接口、集成、最终验收与提交 |
| 采集与归因 | `src/repository.js`、`src/rollout-parser.js`、`src/usage.js`、`test/parser.test.js` | 会话发现、事件兼容、差分算法和数据质量 |
| 运行时与安全 | `src/database.js`、`src/monitor.js`、`src/server.js`、`test/database-server.test.js` | SQLite、增量监听、认证、HTTP/SSE 和安全边界 |
| 前端体验 | `public/**` | 信息架构、可访问性、响应式布局和浏览器验证 |
| 文档与审查 | `docs/**`、`README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`tasks/**`、`test/documentation.test.js` | ADR、交付证据、运维说明和只读复核 |

默认所有权不是永久锁定；协调者可以重新分配，但同一时间同一文件只能有一个写入 owner。审查角色默认只读，只有收到明确的文件所有权后才能修改。

## 并行工作规则

- 只把相互独立、边界清楚的工作交给子智能体；简单的单文件修改由一个智能体直接完成。
- parser snapshot、HTTP API、SQLite schema 等共享契约要先由协调者冻结，再让各 owner 并行实现。
- 任务说明必须包含：目标、拥有的文件、验收命令、依赖契约，以及“你不是唯一工作者，不得撤销他人修改”。
- schema、API、安全或隐私不变量发生变化时，必须同时更新测试和相关 ADR；公共行为变化还要更新 README、API/运维文档和 CHANGELOG。
- 子智能体不得自行执行 `git add`、commit、rebase、tag 或 push；这些操作由协调者统一完成。
- 需要跨所有权修改时，先向协调者提出最小接口变更，不要顺手编辑别人的文件。

## 开发与验证

需要 Node.js 24 或更高版本。常用命令：

```powershell
npm test
npm run check
npm run start:no-open
```

提交前至少运行 `npm test` 和 `npm run check`。涉及页面时还要在真实浏览器验证桌面和窄屏；涉及监听时要验证追加、尾行、重启续读和两秒内 SSE 更新；涉及真实历史时先后比较源文件哈希。

真实五任务样本存在于指定开发机时，期望总 token 依次为：`1,081,772`、`765,891`、`2,230,918`、`1,144,641`、`482,917`。样本不存在时测试必须明确标记为 skipped，不能把它表述为已执行。

## Git 约定

- 主分支为 `main`；功能工作优先使用短生命周期分支。
- 提交消息使用简洁的 Conventional Commit 风格，如 `feat: ...`、`fix: ...`、`docs: ...`、`chore: ...`。
- 只 stage 已审查的明确路径，不使用不加检查的 `git add .`。
- 不提交 `data/*.sqlite*`、`.impeccable/`、日志、真实 rollout、会话正文或任何凭证。
- 禁止用 `git reset --hard`、`git checkout --` 或强制推送清理共享工作区。

### 前端视觉迭代版本控制

- `public/**` 的视觉、排版、交互密度、信息层级或响应式方案属于可反复比较的产品决策；每完成一个独立且可验收的决策，都必须形成单独 Git commit，不把多个尚未验证的视觉方向混在同一个提交中。
- 在开始下一项前端视觉决策前，前一项必须至少完成静态检查、相关测试和 `git diff --check`，并确认工作区中仅保留下一项尚未提交的改动。
- 视觉决策若改变长期设计契约，应同步记录到 `tasks/plan.md` 和相关 ADR；纯微调可只在提交消息中明确范围，但仍必须独立提交。
- 前端提交优先使用可定位的 Conventional Commit，例如 `feat(ui): ...`、`fix(ui): ...`、`refactor(ui): ...`；需要回退时使用正常的 `git revert` 或新提交修正，不重写已共享历史。
- 协调者在每个前端视觉 commit 后记录 commit hash，再开始下一轮实验，确保能够按决策粒度进行截图比较、回滚和二分定位。

## 交接格式

每个子智能体的最终交接至少包含：

- 目标和已完成内容。
- 改动文件清单。
- 新增或变化的接口/不变量。
- 精确验证命令及结果（通过、失败或 skipped 数量）。
- 风险、假设和未完成项。

协调者在提交前核对交接、查看 diff、运行全量验证，并确保文档描述与实际证据一致。
