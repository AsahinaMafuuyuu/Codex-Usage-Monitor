# 架构与数据流

## 系统边界

Codex Usage Monitor 是 `.codex` 的旁路只读观察器，不参与 Codex 会话执行。它不 resume 线程、不修改配置，也不向 OpenAI 服务发请求。

```text
.codex/session_index.jsonl ----┐
.codex/state_*.sqlite (只读) --+--> CodexRepository --> SessionRolloutParser
.codex/sessions/**/*.jsonl ----+                         |
.codex/archived_sessions/** ---┘                         v
                                                MonitorDatabase (SQLite/WAL)
                                                          |
                     fs.watch + 1 秒轮询 --> UsageMonitor |
                                                          v
                                                HTTP JSON + SSE
                                                          |
                                                本地无框架 Web UI
```

## 组件职责

| 组件 | 职责 |
|---|---|
| `src/repository.js` | 读取 session index、只读 state DB 和 rollout 元数据；建立根会话、线程与父子关系 |
| `src/rollout-parser.js` | 读取完整 JSONL 行、识别任务边界、快照、quota、ordinal 和预览位置 |
| `src/usage.js` | 规范化六类 token，并以相邻累计快照验证/去重/识别 model-usage event generation |
| `src/request-ledger.js` | 将 verified model-usage events 按 task 聚合为唯一运行时 `deltaUsage`、质量、coverage 和 request-count 指标 |
| `src/pricing.js` | 用版本化官方标准 API 价目生成逐任务 USD 等值，并合并智能体/会话覆盖摘要 |
| `src/source-locator.js` | 在当前 Codex home 的绝对 runtime path 与可持久化 `.codex` 相对 source key 之间做安全转换和旧路径恢复 |
| `src/database.js` | 管理 schema v11、WAL、幂等 upsert、工程元数据、portable source key、Request Ledger、任务定位元数据、可恢复 ingest cursor 和 request-derived session-day 物化索引 |
| `src/monitor.js` | 管理当前选择、增量 tail、1 秒轮询、10 秒全局 reconciliation、Timeline dirty-session 同步和事件发布 |
| `src/server.js` | loopback HTTP、认证、安全响应头、JSON API、SSE 和静态文件 |
| `public/**` | 可折叠工程索引、编辑式会话账页、递归智能体谱系、对齐任务明细、额度与健康状态 |

## 会话发现

启动时先读取 `session_index.jsonl` 和以 `PRAGMA query_only=ON` 打开的最新 `state_*.sqlite`，再扫描 `sessions` 与 `archived_sessions` 下 rollout 的首条 `session_meta`。父子关系优先采用 `thread_spawn_edges`；缺失时由 rollout 的 `parent_thread_id` 和 `source.subagent` 回退推断。根线程的 `cwd` 作为 `projectPath`，子智能体目录不得覆盖它。

会话列表只保存索引级派生元数据，并按完整 `projectPath` 分组；浏览器将 Windows `\\?\` 扩展路径前缀视为同一目录的语法别名，缺少根目录时保持“未归类”。用户选择根会话后，才完整解析该会话及递归子智能体文件；切换选择会替换实时监听范围，数据库中已经导入的任务不会被删除。

## 日期用量账页

`GET /api/timeline` 是独立于当前选择会话的全局只读聚合。schema v11 的唯一 token 事实源为 verified Request Ledger；日期归属仍保持既有任务口径：任务按 `startedAt` 转换到监控器本地日期，最终返回 `month -> day -> session`，并为每层保留 token、verified model request count、任务数和质量计数。Request Ledger 中 unresolved 的 task 只报告已验证下限，不从第二套统计口径补齐。

schema v7 把查询热路径改为持久化派生索引；schema v8 保留这套索引，同时把文件身份从绝对路径改为 portable source key。schema v11 的 `tasks` 只保存任务身份、时间、模型与来源定位元数据；`session_day_usage` 以 `(day, root_session_id)` 保存由 Request Ledger 可重算的轻量物化合计。启动时 `UsageMonitor` 用当前 rollout 元数据和持久化 cursor 的 size/mtime 标记 dirty root session；从未导入的 session 首次回放一次，可信 append-only cursor 只 tail 新增字节，不可信 cursor 才安全 replay。每次 session ledger 更新都在同一 SQLite 事务中重建该 root 的日记录。无 dirty session 时 Timeline 只查询数百行 session-day 数据，不读取 rollout 内容。

schema v9 建立 `model_usage_events` 并完成双账本 backfill；schema v10 按 [ADR-0015](decisions/0015-request-ledger-primary-aggregation.md) 将 verified Request Ledger 提升为页面与 Timeline 主聚合来源。schema v11 按 [ADR-0016](decisions/0016-retire-boundary-ledger.md) 删除旧 Boundary parser 计算、task delta/quality 存储、API 审计字段与 reconciliation CLI，只保留 Request Ledger。旧 v8 session 仍必须安全 replay 建立完整 Request Ledger；已有 v9/v10 ledger 升到 v11 只迁移 schema 并重建 calendar/agent aggregate，不因退役旧方案重新读取 rollout。

`derived_state` 保存建立日历索引时的本地时区；运行环境时区发生变化时，只从已持久化 task 重新物化日期，而不回放 JSONL。日期分组仍不能与 `.codex/sessions/YYYY/MM/DD` 文件夹或服务端订阅账单直接等同。该实现替代 ADR-0012 首版的全历史内存缓存策略，详见 [ADR-0013](decisions/0013-incremental-calendar-index.md)。

## 任务归因

### Verified Request Ledger（唯一聚合事实源）

parser 把每条 `token_count` 建模为独立审计事件。`last_token_usage` 只作为“本次新增 usage”的候选值，必须由相邻 `total_token_usage` 逐字段验证：累计不变先判 `duplicate`；累计增量与 `last` 一致才是 `verified_increment`；累计回退只有在新累计快照本身与 `last` 一致、可证明 generation 起点时才是 `generation_start`；缺前序累计快照/关键字段保留 `unverified`，无法解释的矛盾保留 `anomaly`。Task / Agent / Session / Timeline 只聚合 verified event；duplicate、unverified、anomaly 和未归属 event 都保持独立 coverage。历史 schema 缺少 cache-write 字段时，仅该字段保持不可验证，不把整条记录强制判错。

Request Ledger 的 durable identity 是 portable `(source_key, line_number)`，另保存 thread/turn、event ordinal、时间、generation、classification/quality/reason 与六类经验证 usage。它表示“经累计快照证明的模型 usage 单元”，**不保证与底层 HTTP 请求一一对应**。历史 Phase 13 双账本 reconciliation 已证明迁移一致性；schema v11 不再维护第二套运行时账本。旧实现被固定在 annotated tag `usage-boundary-ledger-v1`。

缓存命中率只做展示层确定性派生：`cachedInputTokens / inputTokens`。会话使用 request-derived `summary.totalUsage`，智能体使用 request-derived `ownUsage`，任务使用 request-derived `deltaUsage`；输入非正、字段缺失或缓存大于输入时不输出百分比。

数据质量：

| 状态 | 含义 |
|---|---|
| `complete` | 已完成任务的归属 usage events 全部可验证且六字段完整 |
| `provisional` | 活跃任务已有可验证 usage，后续仍可能增长 |
| `partial` | 已有 verified usage，但仍存在缺字段、unverified/anomaly；只报告已验证下限 |
| `unknown` | 活跃任务尚没有可验证 usage |

## 美元等值估算

任务的 `model` 和 `effort` 来自同一 turn 的 `turn_context`。美元字段不是从账号 `rate_limits` 推导，而是在 API snapshot 阶段以持久化的 `model + deltaUsage` 套用 [ADR-0007](decisions/0007-versioned-api-equivalent-cost.md) 的版本化官方标准 API 价目：

```text
cost = uncached_input × input_rate
     + cached_input × cached_rate
     + cache_write × cache_write_rate
     + output × output_rate
```

Reasoning tokens 是 output 的明细，不另加一次。GPT-5.6 cache write 按官方说明使用 1.25× input rate；其他已支持模型的 cache write 保留在普通 uncached input 中。未知模型、缺字段或矛盾明细返回 `unavailable`。

Snapshot 先为每个任务重算费用，再沿与 token 完全相同的 `parentThreadId` 拓扑自底向上汇总。每个智能体得到自身任务 `ownCostEstimate` 和包含全部后代的 `subtreeCostEstimate`；会话同时得到主智能体加全部后代的 `totalCostEstimate` 与仅非根智能体的 `subagentCostEstimate`。汇总只相加可估算金额，并累计不可估算任务数量；混合覆盖标为 `partial`，其金额是已知下限而非完整总额。

价目表记录抓取日期、复核日期和官方来源；进程运行时不联网。由于任务 delta 聚合多次响应，无法识别单次请求的 272K 长上下文阈值，也不包含服务层级、区域处理和工具调用费。结果必须始终标为标准 API 短上下文等值估算，而不是 Codex 订阅实际扣费。

## 持久化边界

SQLite schema v11 包含 `sessions`、`agents`、`tasks`、`model_usage_events`、`quota_snapshots`、`ingest_cursors`、`session_day_usage` 和 `derived_state`。`tasks` 只保存任务定位与展示元数据；`model_usage_events` 是唯一 token 审计事实；`agents` 与 `session_day_usage` 保存 request-derived aggregate，后者包含 `model_request_count` 和四类 Request Ledger task quality 计数。sessions 保留 nullable `project_path` 历史工程元数据，同时以 `rollout_key` 记录 source identity；agents 同样使用 `rollout_key`，tasks/quota 与 Request Ledger 使用 `source_key`，`ingest_cursors` 直接以 `source_key` 为主键。source key 仅允许 `sessions/.../rollout-*.jsonl` / `archived_sessions/.../rollout-*.jsonl`，统一使用 `/`，不携带 Windows 用户名或盘符。

旧 schema 的 `rollout_path` / `source_path` 只作为迁移兼容列存在：能够确定映射到 `.codex` 内 rollout 的路径会提取相对 key，随后绝对 locator 置空；无法安全映射的 cursor 不被猜测，而是在后续需要时安全 replay。quota JSON 中的绝对 `sourcePath` 同样被移除。`project_path` 不做这种转换，因为它描述的是会话发生时的工程 `cwd`，不是源文件身份。

运行中的 repository 仍保留当前机器的绝对 path 进行 `stat`、tail 和 preview，但 path 由 active Codex home + source key 重新绑定，不写回 durable identity。任务表保存身份、时间、模型和字节定位；Request Ledger 保存可审计 usage/event metadata；cursor 保存行号、unknown/skipped/discontinuity 诊断及线程最新累计 usage，以便重启或跨同线程 rollout 时继续验证下一条 Request Ledger event。该 cursor 累计状态是请求验证连续性，不是旧 Boundary task baseline。日历表只保存由 Request Ledger 可重算的日期聚合，不保存正文。详见 [ADR-0014](decisions/0014-portable-source-locators.md)。

监控数据库使用 WAL，同时显式限制 `cache_size=-2000`（约 2 MiB）、`mmap_size=0`、`wal_autocheckpoint=256` 和 2 MiB journal size limit；正常关闭时尝试 `wal_checkpoint(TRUNCATE)`。这样 Timeline 性能来自减少历史 I/O，而不是把 SQLite cache 扩大到几十或几百 MiB。数据库不保存 prompt、response、消息正文或会话标题。

预览接口先把任务 `sourceKey` 绑定到当前 Codex home，再重新打开来源 rollout，确定性提取首条父代理指令，折叠空白并截断到 120 字。结果不缓存、不落库；source key 无法绑定或源文件不存在时返回不可用状态。

## 实时更新

`fs.watch` 提供快速通知，1 秒 stat 轮询补偿 Windows 丢失通知，10 秒 reconciliation 发现新增或移动到归档目录的文件。tail cursor 停在最后一个完整换行处并持久化；重启时只有通过大小/mtime 校验的 append-only 文件才从该 offset 继续，不可验证文件会安全全量回放。未完成尾行保留到下一次读取。选择会话的变化通过 `snapshot` SSE 推送，账号额度和健康状态使用独立事件。账号 current quota 在内存中按 primary/secondary 各自的 `windowMinutes + resetsAt` 做窗口级 reconciliation：同一窗口使用观测到的最大 `usedPercent` 抵抗并发旧响应回退，不同 reset 则优先更新后的窗口；SQLite `quota_snapshots` 继续保存单条规范化观测，不把派生 current state 伪装成原始快照。手动额度刷新会重新发现 rollout，并按实时文件 mtime 重排候选后读取最近来源；它仍严格位于只读 `.codex` 边界内，不向模型或远端额度服务发起请求。

Parser 对已知但与归因无关的事件做显式 allowlist 跳过；未知 record/event 和缺少必需任务 ID 的记录分别计入 `unknownRecords`、`skippedRecords` 并触发 warning。这样既容忍新字段，又不会把格式变化静默伪装为健康。

## 界面信息架构

页面沿“工程/时间 → 会话 → 智能体谱系 → 任务账页”逐层展开。工程组使用原生 `details/summary`，默认只打开当前组；时间组按月份、日期和当天 session 展开；会话汇总采用 12 栏分割线账页，避免为每个指标制造独立卡片容器。

智能体树由递归的 `agent-branch` 与 `agent-children` 构成，children 容器绘制连续竖轨并由每个 child 绘制父子横线。角色 badge 是职责的主扫描入口，昵称和 agent path 是身份补充；颜色不参与模型、用量或质量推断。

任务表在每个智能体下复用相同 `colgroup` 和固定布局，确保跨表列宽一致。小屏只让 `.task-table-wrap` 水平滚动，页面本身不产生横向溢出。设计色板、字体、响应式和替代方案见 [ADR-0009](decisions/0009-editorial-lineage-interface.md)。

## 信任边界

- 进程只监听 `127.0.0.1`。
- 启动 URL 的随机令牌只能兑换一次，随后使用 HttpOnly、SameSite=Strict Cookie。
- 只接受 `GET` 和 `HEAD`，并校验 Host 与同源 Origin。
- CSP 禁止第三方脚本、frame 和跨源连接。
- URL 参数只能提供受正则约束的 session/thread/turn ID，不能提供任意文件路径。

安全与内容最小化决策详见 [ADR-0003](decisions/0003-metadata-only-persistence.md) 和 [ADR-0004](decisions/0004-loopback-session-security.md)；美元估算口径见 [ADR-0007](decisions/0007-versioned-api-equivalent-cost.md)，工程分类与缓存比率见 [ADR-0008](decisions/0008-project-directory-session-grouping.md)，界面结构见 [ADR-0009](decisions/0009-editorial-lineage-interface.md)，日期账页口径见 [ADR-0012](decisions/0012-calendar-usage-ledger.md)，增量日历索引见 [ADR-0013](decisions/0013-incremental-calendar-index.md)，Windows source rebinding 见 [ADR-0014](decisions/0014-portable-source-locators.md)。

## 官方证据边界

- [`HistoryEntry` 仅含 `session_id / ts / text`](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/message-history/src/lib.rs#L61-L66)
- [Rollout recorder 将 JSONL 定义为可回放、可检查记录](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/rollout/src/recorder.rs#L77-L84)
- [`TokenUsageInfo` 字段和累计语义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2078-L2138)
- [任务事件与 `turn_id` 定义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2008-L2049)
- [Hooks 文档提示 transcript 格式可能变化](https://learn.chatgpt.com/docs/hooks)
- [App Server 订阅模型](https://learn.chatgpt.com/docs/app-server)

这些链接固定到调查时的 Codex 源码提交 `76d98a7`。未来升级 parser 时应重新核对当前官方版本并新增 fixture。
