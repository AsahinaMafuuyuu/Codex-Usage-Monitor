# Codex Usage Monitor

一个只在本机运行、只读观察 `.codex` 数据的 Codex 子智能体用量面板。它把 rollout 中每条 `token_count` 建模为 Request Ledger 事件，并用相邻累计 `total_token_usage` 逐字段验证候选新增量，再按 `thread_id + turn_id` 聚合任务，同时显示模型、推理强度、订阅标准价美元等值估算和独立的账号级额度快照。

当前版本：`0.1.0`（MVP）。它提供可审计的客户端归因结果，不把本地估算伪装成账单级精度。

## 快速开始

需要 Windows、Node.js 24 或更高版本。

```powershell
cd C:\path\to\codex-usage-monitor
npm install
npm start
```

服务只监听 `127.0.0.1`，默认从 `47832` 开始寻找可用端口，并自动打开带一次性令牌的浏览器地址。若不希望自动打开：

```powershell
npm run start:no-open
```

终端中按 `Ctrl+C` 停止服务。首次访问会把一次性令牌换成 `SameSite=Strict` 会话 Cookie；不要把启动 URL 分享给其他人。

## 命令

| 命令 | 用途 |
|---|---|
| `npm start` | 启动并打开本地页面 |
| `npm run start:no-open` | 启动但不自动打开浏览器 |
| `npm test` | 运行 parser、SQLite、HTTP 和文档契约测试 |
| `npm run check` | 检查关键 JavaScript 文件语法 |
| `npm run verify:live-ui -- "<authenticated URL>"` | 对已启动页面执行 Chrome/CDP 实时交互回归 |

前端保持无框架实现。额度刷新按钮使用本地安装的 `lucide@1.34.0` 图标库，并由本地 HTTP 服务从 `/vendor/lucide.min.js` 提供，不依赖 CDN，也不需要放宽现有 `script-src 'self'` CSP。

可选环境变量：

- `CODEX_MONITOR_HOME`：Codex 数据目录。未设置时自动使用当前 Windows 用户的 `.codex`；若该环境变量仍指向已不存在的旧机器路径，也会回退到当前用户 `.codex` 并给出提示。
- `CODEX_MONITOR_PORT`：首选端口，默认 `47832`；被占用时最多继续尝试 10 个端口。
- `CODEX_MONITOR_DB`：监控数据库路径，默认固定在当前工程根目录的 `data\usage.sqlite`；相对路径也以工程根目录解析，不受启动时所在目录影响。为保证 CLI 的目录级可移植性，指向工程外部的绝对环境变量会被忽略并回退默认项目数据库，同时在终端提示。

### Windows 迁移

默认存储模型支持把工程跨用户名、跨盘移动。建议停止服务后一起迁移：

```text
codex-usage-monitor\
└─ data\usage.sqlite   （以及停止前仍存在的 -wal / -shm）

当前用户或自定义位置\
└─ .codex\
   ├─ sessions\...
   └─ archived_sessions\...
```

从 schema v8 起，数据库不再用 `C:\Users\...\.codex\...` 绝对路径作为 cursor/任务来源身份，而持久化 `sessions/.../rollout-*.jsonl` 形式的 `.codex` 相对 source key。schema v9 新增 `model_usage_events` Request Ledger，schema v10 将其提升为主聚合事实源，schema v11 删除旧 Boundary Ledger，使 Request Ledger 成为唯一运行时统计方案。schema v12 把日期归属改为已归属 Request Ledger event `observedAt` 的本地自然日；schema v13 再为 usage event 增加最小 `model / serviceTier / pricingContextQuality`，用于逐请求历史定价。v12→v13 不改 classification 或六字段 usage；原 rollout 存在时只读补 pricing metadata，缺失时保持 unknown。

旧 Boundary Ledger 实现没有被改写历史：annotated tag `usage-boundary-ledger-v1` 固定在 commit `4a38ba6`，仅用于历史复核或回归比较；完成退役后的 Request-only 基线使用 annotated tag `usage-request-ledger-v1`。主线不再提供旧统计模式开关。

根 session 的 `projectPath` 仍会保留旧会话当时的工程 `cwd`，用于历史分组和审计；它不是 rollout locator，不影响迁移恢复。非标准 `.codex` 位置请设置 `CODEX_MONITOR_HOME`，程序不会扫描所有盘符猜测数据目录。完整步骤见 [运行与故障处理](docs/OPERATIONS.md) 和 [ADR-0014](docs/decisions/0014-portable-source-locators.md)。

## 页面能力

- 按根 `session_meta.cwd` 的完整工程目录分组、搜索并选择会话，只完整解析当前选择及其递归子智能体；目录缺失时明确归入“未归类”。
- 左侧可切换“工程”和“时间”两种导航；工程模式打开完整 session，时间模式以 `(sessionId, local day)` 为选择身份，右侧 Task / Agent / Token / Request / Cost 只统计当天。时间视图按月→日→session 展开，并展示与右侧同口径的 total token 和订阅标准价 USD 等值。
- 使用可折叠工程索引、编辑式会话账页和连续父子谱系轨；`reviewer`、`test-worker` 等角色以独立语义标签优先呈现。
- 展示智能体树、每个智能体自身/含后代的 token 与 USD 等值合计，以及逐任务 token 字段。
- 会话概览展示根智能体与全部后代的输入、输出和总缓存命中率；智能体与任务也显示各自的缓存命中率。
- 逐任务费用只汇总其 verified Request Ledger usage unit 的 request cost：按事件发生时间选择历史模型价，并在 event-level evidence 可证明时处理 `input >272K` 长上下文和 Fast；未知历史价格、service tier 或冲突 evidence 显式降低 coverage，不猜测。
- Request Ledger 任务质量只区分 `complete`、`provisional`、`partial` 和 `unknown`。
- 通过文件观察与 1 秒轮询实时增量更新，并用 SSE 刷新页面。
- 实时 snapshot 使用 session/Agent/Task 稳定 key 原位 reconcile：常规 token/费用/状态更新不会替换任务表滚动容器或 Agent `<details>`；横向滚动、键盘焦点和用户展开状态保持，结构新增时以当前可见 Agent/Task 做视觉锚点补偿。
- 任务表不显示指令正文；受认证的旧 preview API 暂时保留，供后续完整对话功能重新设计。
- 任务表固定 13 列宽度和数字对齐；窄屏保留独立横向滚动，不隐藏当前审计字段。
- 展示独立的账号级 `rate_limits` 快照；同一 reset 窗口内若并发 rollout 返回互相回退的 `used_percent`，运行时按该窗口观测到的最大已用比例保守收敛，避免把 100% 错降成 97%。页面统一显示 `100 - used_percent` 的剩余额度；额度卡右上角使用本地安装的 Lucide `refresh-cw` 图标，点击后立即重新扫描本机最新 rollout，刷新期间图标旋转。

### 额度刷新语义

额度卡右上角刷新按钮调用本地只读接口 `GET /api/quota?refresh=1`。一次手动刷新会重新发现 rollout、重新读取文件修改时间，并扫描最近的 `rate_limits` 记录，然后立即更新 5 小时和 1 周剩余额度。

这个按钮不会主动向 OpenAI/Codex 发起模型请求，也不会为了查询额度生成一条新的远端请求；因此它只能读取 **Codex 已经写入本机 `.codex` 的最新额度快照**。如果 Codex 尚未产生新的 `rate_limits`，页面会保留当前额度并提示“暂未发现新的快照”。

同一个 `windowMinutes + resetsAt` 窗口中，如果不同 rollout 的并发响应出现 `100% → 97%` 这类回退，current quota 会保守采用该窗口已观测到的最大 `used_percent`。只有进入新的 reset 窗口后，已用比例才允许重新降低。前端展示值始终为：

```text
剩余额度 = 100 - used_percent
```

例如底层观测到 `used_percent = 100` 时，页面显示 `剩余 0%`。

## 数据口径

- `history.jsonl` 不用于 token 统计，因为它没有 token 字段。
- 用量来源是 `.codex/sessions/**/rollout-*.jsonl` 和 `.codex/archived_sessions`。
- schema v13 中任务 token 仍只来自经相邻 `total_token_usage` 逐字段验证的 Request Ledger；`last_token_usage` 只作为候选新增量被验证，绝不裸累加。不存在第二套运行时边界差分或 fallback。
- `modelRequestCount` 表示已验证且归属任务的模型用量单元，`tokensPerModelRequest` 只由这些单元计算；它们不保证与 HTTP 请求或 Codex 服务端计费请求一一对应。
- 缓存命中率为 `cachedInputTokens / inputTokens`；缺少有效输入或字段矛盾时显示不可用。
- 额度卡是账号级快照，不能证明某个任务消耗了多少订阅额度；页面显示的是剩余比例，底层仍保留 Codex 原始 `used_percent` 语义。只有 `resetsAt + windowMinutes` 能确认处于同一窗口时才做单调收敛，进入新 reset 后允许比例重新降低。
- 美元值是 **Subscription Standard-Rate Equivalent**：逐 verified usage unit 使用事件发生时的历史订阅标准价，并仅对可证明的长上下文/Fast feature 应用规则。它不是 Plus 实际扣费，也不能从 5 小时/周额度反推。Regional processing、web/image/voice/tool fee 仍不在当前 policy；partial 金额只表示当前可证明部分。
- Request Ledger task 的 `complete` 表示其已归属事件均可验证且六类字段完整；若同 task 仍有 unverified/anomaly，只累计已验证下限并降为 `partial`，不从其他统计口径补值。
- Request Ledger `observedAt` 以规范化 UTC ISO-8601 持久化；页面按监控器/浏览器本地时区解释自然日。
- 按日总量来自所有已发现 rollout 的 request-derived task usage，包含未被用户打开过的 session；日期按已归属 event `observedAt` 的本地自然日归属。跨午夜 task 可在多个日期出现，但每个日期只统计该日 verified usage/request/cost；未归属 event 不进入主统计。
- 按日总量是本机 rollout 审计汇总，不等同 Codex 个人资料中的订阅额度或账单 token；两者可能因日期边界和服务端口径不同而不相等。

实现依据和证据链接记录在 [架构说明](docs/ARCHITECTURE.md) 与 [ADR 索引](docs/decisions/README.md)。

## 隐私与安全

- 不修改 `config.toml`，不启动 App Server，不启用 Hooks/OTel，不调用模型，不联网。
- Codex 的 SQLite 和 rollout 文件始终只读。
- 监控 SQLite 只保存工程目录等历史元数据、`.codex` 相对 source key、任务定位元数据、Request Ledger 事件、cursor 和可重算的日期聚合；task 表不再保存旧 baseline/end/delta。数据库不保存 prompt、response、消息正文或会话标题。rollout 的绝对机器路径只在当前进程中作为运行 locator 使用。
- 页面使用一次性随机令牌、严格 Cookie、Host/Origin 校验、CSP 和只读 HTTP 方法。
- API 的 ID 受固定格式约束，不能传入任意文件路径。

## 项目结构

```text
src/                  会话发现、rollout parser、SQLite、监听和 HTTP/SSE
public/               无框架的本地 Web 页面
test/                 脱敏 fixture、真实样本和安全回归测试
docs/                 架构、API、运维、交付、验证和路线图
docs/decisions/       架构决策记录（ADR）
tasks/                当前实现计划与交付清单
AGENTS.md             多智能体所有权和协作规则
```

## 文档导航

- [交付说明](docs/DELIVERY.md)
- [架构与数据流](docs/ARCHITECTURE.md)
- [本地 API](docs/API.md)
- [运行与故障处理](docs/OPERATIONS.md)
- [验证证据](docs/VERIFICATION.md)
- [前端 Phase 9 接手说明](docs/FRONTEND-HANDOFF.md)
- [后续路线图](docs/ROADMAP.md)
- [参与开发](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 验证

```powershell
npm test
npm run check
```

开发机上的五任务真实样本还会验证五组审计基准及源文件哈希不变；样本不存在时，该项测试会明确显示为 skipped。完整口径见 [验证说明](docs/VERIFICATION.md)。
