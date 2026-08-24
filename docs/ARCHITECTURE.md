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
| `src/usage.js` | 规范化六类 token、检查单调性、做边界差分和质量分类 |
| `src/pricing.js` | 用版本化官方标准 API 价目生成逐任务 USD 等值，并合并智能体/会话覆盖摘要 |
| `src/database.js` | 管理 schema v6、WAL、幂等 upsert、工程定位、任务快照和可恢复 ingest cursor |
| `src/monitor.js` | 管理当前选择、增量 tail、1 秒轮询、10 秒全局 reconciliation 和事件发布 |
| `src/server.js` | loopback HTTP、认证、安全响应头、JSON API、SSE 和静态文件 |
| `public/**` | 会话搜索、子智能体树、任务明细、额度与健康状态 |

## 会话发现

启动时先读取 `session_index.jsonl` 和以 `PRAGMA query_only=ON` 打开的最新 `state_*.sqlite`，再扫描 `sessions` 与 `archived_sessions` 下 rollout 的首条 `session_meta`。父子关系优先采用 `thread_spawn_edges`；缺失时由 rollout 的 `parent_thread_id` 和 `source.subagent` 回退推断。根线程的 `cwd` 作为 `projectPath`，子智能体目录不得覆盖它。

会话列表只保存索引级派生元数据，并按完整 `projectPath` 分组；浏览器将 Windows `\\?\` 扩展路径前缀视为同一目录的语法别名，缺少根目录时保持“未归类”。用户选择根会话后，才完整解析该会话及递归子智能体文件；切换选择会替换实时监听范围，数据库中已经导入的任务不会被删除。

## 任务归因

任务主键是 `thread_id + turn_id`。parser 兼容 `task_started/task_complete` 和 `turn_*` 别名，并为每个任务保存最近的累计 baseline 与完成、终止或当前最新 end 快照。

六类字段分别为 input、cached input、cache-write input、output、reasoning output 和 total。差分规则：

```text
delta[field] = end.total_token_usage[field] - baseline.total_token_usage[field]
```

重复累计快照不产生新用量；累计倒退不计算伪精确 delta。`last_token_usage` 可能重复或重置，因而不参与相加。`subagent_history_start_ordinal` 之前的分页复制历史被排除。

缓存命中率只做展示层确定性派生：`cachedInputTokens / inputTokens`。会话使用 `summary.totalUsage`，智能体使用 `ownUsage`，任务使用 `deltaUsage`；输入非正、字段缺失或缓存大于输入时不输出百分比。

数据质量：

| 状态 | 含义 |
|---|---|
| `complete` | 已完成任务，边界存在、字段完整且累计单调 |
| `provisional` | 活跃任务的当前差分，后续会变化 |
| `estimated` | 只有 total 明显增长，细分字段不足以解释 |
| `partial` | 已完成但 baseline/end 或字段不完整 |
| `discontinuity` | 累计值倒退或流出现不连续，不输出伪精确差分 |
| `unknown` | 活跃任务尚缺可计算的边界 |

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

SQLite schema v6 包含 `sessions`、`agents`、`tasks`、`quota_snapshots` 和 `ingest_cursors`。sessions 新增 nullable `project_path` 定位元数据；任务保存边界、baseline/end/delta、源文件定位和字节偏移；cursor 额外保存行号、unknown/skipped/discontinuity 诊断及线程最新累计 usage，以便重启后安全续读且不丢失 warning 或任务间 baseline。数据库不保存 prompt、response、消息正文或会话标题。

预览接口只使用已存的任务定位信息重新打开来源 rollout，确定性提取首条父代理指令，折叠空白并截断到 120 字。结果不缓存、不落库；源文件不存在时返回不可用状态。

## 实时更新

`fs.watch` 提供快速通知，1 秒 stat 轮询补偿 Windows 丢失通知，10 秒 reconciliation 发现新增或移动到归档目录的文件。tail cursor 停在最后一个完整换行处并持久化；重启时只有通过大小/mtime 校验的 append-only 文件才从该 offset 继续，不可验证文件会安全全量回放。未完成尾行保留到下一次读取。选择会话的变化通过 `snapshot` SSE 推送，账号额度和健康状态使用独立事件。

Parser 对已知但与归因无关的事件做显式 allowlist 跳过；未知 record/event 和缺少必需任务 ID 的记录分别计入 `unknownRecords`、`skippedRecords` 并触发 warning。这样既容忍新字段，又不会把格式变化静默伪装为健康。

## 信任边界

- 进程只监听 `127.0.0.1`。
- 启动 URL 的随机令牌只能兑换一次，随后使用 HttpOnly、SameSite=Strict Cookie。
- 只接受 `GET` 和 `HEAD`，并校验 Host 与同源 Origin。
- CSP 禁止第三方脚本、frame 和跨源连接。
- URL 参数只能提供受正则约束的 session/thread/turn ID，不能提供任意文件路径。

安全与内容最小化决策详见 [ADR-0003](decisions/0003-metadata-only-persistence.md) 和 [ADR-0004](decisions/0004-loopback-session-security.md)；美元估算口径见 [ADR-0007](decisions/0007-versioned-api-equivalent-cost.md)，工程分类与缓存比率见 [ADR-0008](decisions/0008-project-directory-session-grouping.md)。

## 官方证据边界

- [`HistoryEntry` 仅含 `session_id / ts / text`](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/message-history/src/lib.rs#L61-L66)
- [Rollout recorder 将 JSONL 定义为可回放、可检查记录](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/rollout/src/recorder.rs#L77-L84)
- [`TokenUsageInfo` 字段和累计语义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2078-L2138)
- [任务事件与 `turn_id` 定义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2008-L2049)
- [Hooks 文档提示 transcript 格式可能变化](https://learn.chatgpt.com/docs/hooks)
- [App Server 订阅模型](https://learn.chatgpt.com/docs/app-server)

这些链接固定到调查时的 Codex 源码提交 `76d98a7`。未来升级 parser 时应重新核对当前官方版本并新增 fixture。
