# Codex Usage Monitor

一个只在本机运行、只读观察 `.codex` 数据的 Codex 子智能体用量面板。它把 rollout 中的累计 token 快照按 `thread_id + turn_id` 做边界差分，记录同一个子智能体执行的每次任务，并显示模型、推理强度、标准 API 美元等值估算和独立的账号级额度快照。

当前版本：`0.1.0`（MVP）。它提供可审计的客户端归因结果，不把本地估算伪装成账单级精度。

## 快速开始

需要 Windows、Node.js 24 或更高版本。

```powershell
cd C:\path\to\codex-usage-monitor
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

schema v8 不再用 `C:\Users\...\.codex\...` 绝对路径作为 cursor/任务来源身份，而持久化 `sessions/.../rollout-*.jsonl` 形式的 `.codex` 相对 source key。新电脑用户名、工程盘符或 `.codex` 根目录改变后，启动时会把这些 key 绑定到当前 Codex home；文件本身未变化时可以继续原 byte cursor，而不是仅因为路径变化重扫历史。首次创建全新数据库仍需要一次性建立历史索引。

根 session 的 `projectPath` 仍会保留旧会话当时的工程 `cwd`，用于历史分组和审计；它不是 rollout locator，不影响迁移恢复。非标准 `.codex` 位置请设置 `CODEX_MONITOR_HOME`，程序不会扫描所有盘符猜测数据目录。完整步骤见 [运行与故障处理](docs/OPERATIONS.md) 和 [ADR-0014](docs/decisions/0014-portable-source-locators.md)。

## 页面能力

- 按根 `session_meta.cwd` 的完整工程目录分组、搜索并选择会话，只完整解析当前选择及其递归子智能体；目录缺失时明确归入“未归类”。
- 左侧可切换“工程”和“时间”两种导航；时间视图按本地时区从月展开到日，再列出当天 session 和已审计 total token。历史只在首次导入时建立 task/cursor ledger，之后按变化 session 增量 tail，并直接查询轻量 SQLite session-day 索引。
- 使用可折叠工程索引、编辑式会话账页和连续父子谱系轨；`reviewer`、`test-worker` 等角色以独立语义标签优先呈现。
- 展示智能体树、每个智能体自身/含后代的 token 与 USD 等值合计，以及逐任务 token 字段。
- 会话概览展示根智能体与全部后代的输入、输出和总缓存命中率；智能体与任务也显示各自的缓存命中率。
- 逐任务展示 rollout 记录的模型、effort 和当前标准 API 短上下文 USD 等值估算；会话概览汇总主智能体及全部后代。未知模型或明细不足时明确显示不可估算。
- 区分 `complete`、`provisional`、`estimated`、`partial`、`discontinuity` 和 `unknown` 数据质量。
- 通过文件观察与 1 秒轮询实时增量更新，并用 SSE 刷新页面。
- 任务表不显示指令正文；受认证的旧 preview API 暂时保留，供后续完整对话功能重新设计。
- 任务表固定 14 列宽度和数字对齐；窄屏保留独立横向滚动，不隐藏审计字段。
- 展示独立的账号级 `rate_limits` 快照；超过 5 分钟标为可能过期。

## 数据口径

- `history.jsonl` 不用于 token 统计，因为它没有 token 字段。
- 用量来源是 `.codex/sessions/**/rollout-*.jsonl` 和 `.codex/archived_sessions`。
- 任务 token 来自 `total_token_usage` 的任务边界差分；绝不累加可能重复或重置的 `last_token_usage`。
- 缓存命中率为 `cachedInputTokens / inputTokens`；缺少有效输入或字段矛盾时显示不可用。
- 额度卡是账号级快照，不能证明某个任务消耗了多少订阅额度。
- 美元值使用版本化官方标准 API 价目计算，不是 Codex 订阅实际扣费；不包含无法从任务汇总证明的长上下文、服务层级、区域或工具费用。部分任务不可估算时，任务数量和 coverage 文案仍被保留，显示金额只是已知部分。
- `complete` 仅表示可见边界完整且累计值单调，不等同服务端账单的逐请求 usage。
- 时间以 UTC ISO-8601 存储，页面按浏览器本地时区显示。
- 按日总量来自所有已发现 rollout 的任务边界差分，包含未被用户打开过的 session；有 `partial`、`estimated`、`discontinuity` 或 `unknown` 的日期会保留质量标记。
- 按日总量是本机 rollout 审计汇总，不等同 Codex 个人资料中的订阅额度或账单 token；两者可能因日期边界和服务端口径不同而不相等。

实现依据和证据链接记录在 [架构说明](docs/ARCHITECTURE.md) 与 [ADR 索引](docs/decisions/README.md)。

## 隐私与安全

- 不修改 `config.toml`，不启动 App Server，不启用 Hooks/OTel，不调用模型，不联网。
- Codex 的 SQLite 和 rollout 文件始终只读。
- 监控 SQLite 只保存工程目录等历史元数据、`.codex` 相对 source key、派生 task/cursor、token delta 和可重算的日期聚合；不保存 prompt、response、消息正文或会话标题。rollout 的绝对机器路径只在当前进程中作为运行 locator 使用。
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
