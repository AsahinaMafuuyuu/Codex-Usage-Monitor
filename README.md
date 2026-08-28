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
| `npm run reconcile:subscription-cost` | 只读扫描本机 rollout，输出旧 API→订阅标准价的可审计费用差异与 coverage |
| `npm run audit:unknown-records -- --session <id>` | 只读聚类一个 session 的未知/已审计非计量 record，不改变 Request/Token 事实 |
| `npm run reconcile:phase18 -- --session <id>` | 只读对账一个 legacy fork session 的 canonical/inherited/unresolved Request、六字段守恒与 projection 性能 |
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

从 schema v8 起，数据库不再用 `C:\Users\...\.codex\...` 绝对路径作为 cursor/任务来源身份，而持久化 `.codex` 相对 source key。schema v9–v13 建立并完善 verified Request Ledger、event-observed day 与 request-level pricing；schema v14 再把 raw evidence 与业务事实分开：`model_usage_events` 保留全部 observed evidence，`canonical_requests` 保存唯一 Token/Cost Request，ownership 表保留 inherited/unresolved provenance，`session_day_usage` 只由 canonical Request observed-day 生成。projection 使用 version/generation 原子切换。

旧 Boundary Ledger 实现没有被改写历史：annotated tag `usage-boundary-ledger-v1` 固定在 commit `4a38ba6`，仅用于历史复核或回归比较；完成退役后的 Request-only 基线使用 annotated tag `usage-request-ledger-v1`。主线不再提供旧统计模式开关。

根 session 的 `projectPath` 仍会保留旧会话当时的工程 `cwd`，用于历史分组和审计；它不是 rollout locator，不影响迁移恢复。非标准 `.codex` 位置请设置 `CODEX_MONITOR_HOME`，程序不会扫描所有盘符猜测数据目录。完整步骤见 [运行与故障处理](docs/OPERATIONS.md) 和 [ADR-0014](docs/decisions/0014-portable-source-locators.md)。

## 页面能力

- 按根 `session_meta.cwd` 的完整工程目录分组、搜索并选择会话；已有 SQLite projection 时点击只读 cached canonical snapshot，不在请求路径同步解析 rollout。新增/变化 session 由后台 indexer 处理；目录缺失时明确归入“未归类”。
- 左侧可切换“工程”和“时间”两种导航；工程模式打开完整 session，并以“任务记录”展示完整 Task lifecycle；时间模式以 `(sessionId, local day)` 为选择身份，直接展示当天真正发生的 canonical Request，再按 Task Day Slice 分组。Time 表显示“当日首请求 / 当日末请求 / Requests / 推理强度”，不会把完整 Task 的开始时间或耗时冒充为当天计量时间。
- Task 可按需展开 canonical Request 审计表，查看每个 Request 的时间、Input/Cached/Cache Write/Output/Reasoning/Total、模型、所属 Task 推理强度、service tier 与 USD。Project 展开完整 Task Request；Time 只展开当天 Request。每个智能体的 Task 不再分页，而是在约 5 行高的独立纵向视口中连续滚动：内部仍有剩余滚动距离时优先滚 Task，到顶/到底或没有纵向 overflow 时把滚轮继续交给整体 workspace。Request 默认 10 条/页并可切 5/10，少于 10 条时不显示分页条；长分页最多保留 5 个语义槽位（边界页 / 当前页 / 省略号），外侧只保留前后翻页。前后导航使用居中的 Lucide chevron，并给页码与翻页内容加入轻量过渡。Request drawer 同时只展开最近一个，其余原位收起但保留已加载缓存。Request 明细继续拥有独立横向滚动区和三横线收起把手，父任务表横向滚动不会带动 Canonical Requests 标题或明细。初始 snapshot/SSE 仍不内嵌全部 Request。
- 使用可折叠工程索引、编辑式会话账页和连续父子谱系轨；`reviewer`、`test-worker` 等角色以独立语义标签优先呈现。
- 展示智能体树、每个智能体自身/含后代的 token 与 USD 等值合计，以及逐任务 token 字段。
- 会话概览展示根智能体与全部后代的输入、输出和总缓存命中率；智能体与任务也显示各自的缓存命中率。
- 逐任务费用只汇总其 verified Request Ledger usage unit 的 request cost：按事件发生时间选择历史模型价，并按单 Request 处理 `input >272K` 长上下文。Fast 只有在原始 `service_tier` 明确为 `fast` 时启用；`default/standard/priority/缺失/其他值` 全部按标准层级计费。未知历史价格或其他冲突 evidence 仍显式降低 coverage。
- Request Ledger 任务质量只区分 `complete`、`provisional`、`partial` 和 `unknown`。
- 通过文件观察与 1 秒轮询把变化 session 放入后台 dirty queue；Indexer 执行 parse/tail → Request identity/ownership → canonical projection → generation commit，并用 SSE 刷新页面。
- 实时 snapshot 使用 session/Agent/Task 稳定 key 原位 reconcile：常规 token/费用/状态更新不会替换任务表滚动容器、已展开 Request drawer 或 Agent `<details>`；横向滚动、键盘焦点和用户展开状态保持，结构新增时以当前可见 Agent/Task 做视觉锚点补偿。Request drawer 收起/展开保留原 DOM 并使用可降级到 `prefers-reduced-motion` 的过渡动画。
- 任务表不显示指令正文；受认证的旧 preview API 暂时保留，供后续完整对话功能重新设计。
- 任务表固定 14 列宽度和数字对齐；窄屏保留独立横向滚动，不隐藏当前审计字段。可见表标题保持在滚动容器视口左侧，横向移动只作用于数据列。
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
- schema v14 中 token 仍只来自经相邻 `total_token_usage` 逐字段验证的 Request Ledger；`last_token_usage` 只作为候选新增量被验证，绝不裸累加。业务聚合进一步只消费 `canonical_requests`，fork copied history 不会形成新的 Token/Cost。
- `user_message`、`patch_apply_end`、`web_search_end`、`thread_rolled_back` 等已审计 record 只是消息/工具/会话状态证据，不生成 model Request，也不直接增加 Task usage。2026-08-27 的真实污染 session 中这四类共 1,978 条，已从 `unknownRecords` 收敛为显式 non-accounting allowlist；重新审计后 `unknownRecords=0`，Request/Token reconciliation 完全不变。
- Request identity 优先使用 `token_count` 可证明的原生 `request_id/model_request_id/response_id`；当前真实 legacy 样本没有这些字段，因此确定性使用 `turnId + generation + cumulative usage + last usage` 重建。`thread/source/timestamp/call_id` 不参与 identity。
- cross-root legacy history 也只保留 provenance：Task 明确早于 root session 创建时间时不会重新取得 accounting ownership；即使 copied Task 时间戳被改写，只要相同 request identity 已由其他 root 占有，也不会重复生成 canonical Request。该修复使用 projection v2，SQLite schema 仍保持 v14，旧 projection 只从已持久化 raw evidence 重建，不回放 `.codex`。
- `modelRequestCount` 表示 canonical verified model usage Request；这是本地 rollout 可证明的 model-sampling Request identity，仍不宣称与服务端 invoice/HTTP 请求一一对应。
- Task Day Slice 只是 Time 查询 projection，同一 Task 可以出现在多个日期但仍只有一个 Task identity；day-scope API 提供 `scopeDay/firstRequestAt/lastRequestAt/requestCount` 描述当日 Request 子集。
- 缓存命中率为 `cachedInputTokens / inputTokens`；缺少有效输入或字段矛盾时显示不可用。
- 额度卡是账号级快照，不能证明某个任务消耗了多少订阅额度；页面显示的是剩余比例，底层仍保留 Codex 原始 `used_percent` 语义。只有 `resetsAt + windowMinutes` 能确认处于同一窗口时才做单调收敛，进入新 reset 后允许比例重新降低。
- 美元值是 **Subscription Standard-Rate Equivalent**：逐 verified usage unit 使用事件发生时的历史订阅标准价，并仅对可证明的长上下文/Fast feature 应用规则。它不是 Plus 实际扣费，也不能从 5 小时/周额度反推。Regional processing、web/image/voice/tool fee 仍不在当前 policy；partial 金额只表示当前可证明部分。
- Request Ledger task 的 `complete` 表示其已归属事件均可验证且六类字段完整；若同 task 仍有 unverified/anomaly，只累计已验证下限并降为 `partial`，不从其他统计口径补值。
- Request Ledger `observedAt` 以规范化 UTC ISO-8601 持久化；页面按监控器/浏览器本地时区解释自然日。
- 按日总量来自所有已发现 session 的 canonical Request projection；日期严格按 canonical Request 原始 `observedAt` 的本地自然日归属。跨午夜 Task 只有在对应日期实际发生 Request 时才出现；lifecycle-only Task 不污染 Time 页面，fork copy 的重写 timestamp 也不能移动日期。
- 按日总量是本机 rollout 审计汇总，不等同 Codex 个人资料中的订阅额度或账单 token；两者可能因日期边界和服务端口径不同而不相等。

实现依据和证据链接记录在 [架构说明](docs/ARCHITECTURE.md) 与 [ADR 索引](docs/decisions/README.md)。

## 隐私与安全

- 不修改 `config.toml`，不启动 App Server，不启用 Hooks/OTel，不调用模型，不联网。
- Codex 的 SQLite 和 rollout 文件始终只读。
- 监控 SQLite 只保存工程目录等历史元数据、`.codex` 相对 source key、任务定位元数据、raw Request evidence、canonical Request/provenance、cursor 和可重算 projection；数据库不保存 prompt、response、消息正文或会话标题。rollout 的绝对机器路径只在当前进程中作为运行 locator 使用。
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
