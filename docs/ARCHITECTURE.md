# 架构与数据流

## 系统边界

Codex Usage Monitor 是 `.codex` 的旁路只读观察器，不参与 Codex 会话执行。它不 resume 线程、不修改配置、不调用模型。Task/Token/Cost 事实层不访问远端；唯一网络例外是账号额度按 [ADR-0025](decisions/0025-official-codex-usage-polling.md) 只读查询 Codex 官方 Usage。

```text
.codex/session_index.jsonl ----┐
.codex/state_*.sqlite (只读) --+--> CodexRepository --> SessionRolloutParser
.codex/sessions/**/*.jsonl ----+                         |
.codex/archived_sessions/** ---┘                         v
                                                MonitorDatabase (SQLite/WAL)
                                                          |
                     fs.watch + 1 秒轮询 --> UsageMonitor |
Codex config/auth --只读--> CodexUsageClient --60 秒--> 官方 Usage
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
| `src/request-identity.js` | 优先提取原生 Request identity；缺失时仅用稳定 usage evidence 做 deterministic reconstruction，拒绝 source/timestamp/call-id 参与身份 |
| `src/request-ownership.js` | 结合 Task lineage、temporal evidence 与 Request identity，将 raw evidence 分为 canonical / inherited_copy / unresolved，并生成 reconciliation |
| `src/request-content.js` | 通过 canonical Request locator + Task byte/line locator bounded seek 原始 rollout，构造 Observed Interaction Slice，并把 message/tool/reasoning/context evidence 投影为不含 Raw JSON 的临时语义模型 |
| `src/snapshot-scope.js` | 统一解析本地自然日边界，并从 Request Ledger 物化 full/day Task Slice、Agent lineage、Session summary 与 Calendar Slice |
| `src/pricing.js` | 用历史订阅标准价逐 verified Request Ledger usage unit 计算 request cost，并合并 Task/Agent/Session/Day coverage |
| `src/source-locator.js` | 在当前 Codex home 的绝对 runtime path 与可持久化 `.codex` 相对 source key 之间做安全转换和旧路径恢复 |
| `src/codex-usage-client.js` | 每次只读重载 Codex `config.toml` / `auth.json`，按官方 backend-client path style 查询账号 Usage 并规范化额度窗口；不持久化凭据 |
| `src/database.js` | 管理 schema v15、raw Request evidence、canonical request/ownership provenance、versioned request-day/cost projection、Task/Request 定向 locator query、Alerts operational state、WAL 与可恢复 cursor |
| `src/monitor.js` | 管理 cached selection、低并发 background indexer、dirty-session queue、增量 tail、SSE 和 graceful shutdown |
| `src/server.js` | loopback HTTP、认证、安全响应头、JSON API、SSE 和静态文件 |
| `public/**` | 可折叠工程索引、编辑式会话账页、递归智能体谱系、按 session/agent/task 稳定 key 增量 reconcile 的任务明细、额度与健康状态 |

## 会话发现

启动时先读取 `session_index.jsonl` 和以 `PRAGMA query_only=ON` 打开的最新 `state_*.sqlite`，再扫描 `sessions` 与 `archived_sessions` 下 rollout 的首条 `session_meta`。父子关系优先采用 `thread_spawn_edges`；缺失时由 rollout 的 `parent_thread_id` 和 `source.subagent` 回退推断。根线程的 `cwd` 作为 `projectPath`，子智能体目录不得覆盖它。

会话列表只保存索引级派生元数据，并按完整 `projectPath` 分组；浏览器将 Windows `\\?\` 扩展路径前缀视为同一目录的语法别名，缺少根目录时保持“未归类”。Phase 18 起选择根会话只读取 SQLite cached canonical projection；文件是否需要解析由启动扫描、watcher/stat reconciliation 标记到 background indexer。已有 projection 的 UI 点击不承担 restore/tail/parse；dirty session 完成新 generation 后通过 SSE 更新。

## 日期用量账页

`GET /api/timeline` 是独立于当前选择会话的全局只读聚合。schema v14 的唯一业务计量事实是 `canonical_requests`：每个 canonical Request 按其原始 `observedAt` 所在本地自然日进入 request-day projection，再按 Task/Agent/Session 分组。Task lifecycle 不再单独创建日期 slice；一个跨午夜 Task 只有在两天都确实发生 canonical Request 时才同时出现在两天。fork copy 的 envelope timestamp 即使被改写，也不能改变 canonical Request 日期。

schema v7 把查询热路径改为持久化派生索引；schema v8 把文件身份改为 portable source key；schema v9–v13 建立 Request Ledger、day scope 与 request-level pricing。schema v14 在此基础上明确区分四层：`model_usage_events` 保存 raw observed evidence；`task_ownership/event_ownership` 保存 canonical/inherited/unresolved provenance；`canonical_requests` 保存唯一业务 Request；`session_day_usage` 保存 request-day/cost projection。ownership、canonical request、day/cost 与 `projection_generation` 在同一 SQLite transaction 内切换，读路径只能看到旧 generation 或新 generation，不会看到混合 Token/Cost/Task count。

Projection semantics 与 schema version 独立。cross-root ownership hardening 使用 projection v2，而 SQL schema 仍为 v14；`derived_state.projection_version` 落后时，启动只从持久化 Task/Request raw evidence 重建 canonical/day/cost projection，不要求重新读取 rollout。全量 rebuild 按 session 创建时间稳定排序，使旧 root 优先建立 canonical identity；若 copy 先被索引，原始 canonical Request 后续出现时会回填 inherited evidence 的 `canonical_request_id`。

schema v9 建立 `model_usage_events` 并完成双账本 backfill；schema v10 按 [ADR-0015](decisions/0015-request-ledger-primary-aggregation.md) 将 verified Request Ledger 提升为页面与 Timeline 主聚合来源。schema v11 按 [ADR-0016](decisions/0016-retire-boundary-ledger.md) 删除旧 Boundary parser 计算、task delta/quality 存储、API 审计字段与 reconciliation CLI，只保留 Request Ledger。旧 v8 session 仍必须安全 replay 建立完整 Request Ledger；已有 v9/v10 ledger 升到 v11 只迁移 schema 并重建 calendar/agent aggregate，不因退役旧方案重新读取 rollout。Phase 18 后 parser 语义版本与 SQLite schema version 独立：当前 schema 仍为 v14，但 parser semantics 提升后会把旧 session 标记 dirty 并后台重索引 cursor diagnostics，而不是通过 schema 迁移或手工清零 `unknown_records` 伪造健康状态。

schema v12 按 [ADR-0018](decisions/0018-day-scoped-request-ledger-snapshot.md) 首次将日期切到 event `observedAt`；schema v14 再由 [ADR-0020](decisions/0020-canonical-request-ownership-and-projections.md) 收紧为 **canonical Request observed-day**。`src/snapshot-scope.js` 负责本地日/DST 和 scoped grouping，但它消费的是 ownership resolver 输出，不再允许 lifecycle-only Task 进入 Time ledger。

`derived_state` 保存建立日历索引时的本地时区；运行环境时区发生变化时，只从已持久化 task + Request Ledger 重新物化日期，而不回放 JSONL。本地日边界由连续两个日历午夜构造，DST 日可以是 23/25 小时，不能固定按 24 小时加法。日期分组仍不能与 `.codex/sessions/YYYY/MM/DD` 文件夹或服务端订阅账单直接等同。

Phase 19 将 **Task** 与 **Task Day Slice** 的展示语义正式分开，但不增加新的 accounting identity。Session/Project 从全部 canonical Request 物化完整 Task；Time 先按 canonical Request `observedAt` 切日，再按 owner Task 聚合，并补充 `scopeKind/scopeDay/firstRequestAt/lastRequestAt/requestCount`。原 Task lifecycle 仍可作为身份元数据存在，但 Time UI 不把 `startedAt/duration` 当作日内计量时间。

Request audit detail 不进入初始 snapshot。Task 展开后通过 `(root_session_id, thread_id, turn_id[, observed_at])` 定向读取 `canonical_requests`，稳定按 `(observed_at, request_id)` cursor 分页。`idx_canonical_requests_task_observed(root_session_id, thread_id, turn_id, observed_at, request_id)` 同时服务 full-task 与 day-scoped drill-down；raw `model_usage_events/event_ownership` 仍只用于 rebuild/reconciliation，不进入默认用户审计列表。该 read path 本身不提升 schema version；当前主线保持 schema v15 / projection v2。

Phase 25 在这一 canonical Request audit 之上增加独立 **Request Content Inspector** read-through seam，但不改变 accounting。`requestId` 先经 `MonitorDatabase.getCanonicalRequestContentLocator()` 解析为 durable canonical origin locator、同 Task/同 source 的前一 canonical boundary 与既有 Task `start_line/start_byte`；随后 `CodexRepository.resolveSourceKey()` 只在服务端重新绑定当前绝对 rollout path，客户端不能提供文件路径、source key、line 或 byte offset。

```text
canonical request_id
  -> origin_source_key + origin_line_number
  -> task.start/end line + byte anchors
  -> previous same-task/same-source canonical boundary
  -> bounded newline-only byte-range locator
  -> Observed Interaction Slice
  -> bounded JSON parse + semantic projection
  -> authenticated GET
  -> one ephemeral Dialog payload
```

Locator 不从 rollout 文件头 replay。它以 Task start/end 为双 anchor，用 `256 KiB` 小块只统计 JSONL `\n`：单侧最多 `12 MiB`、双侧总 locator 预算 `24 MiB`，找到 previous/current canonical line 的精确 byte range 后才读取正文。真正进入 JSON parse/projector 的 Observed Interaction Slice 独立限制为 `4 MiB`，再叠加 `500 records / 64 KiB item / 512 KiB public payload`。当前 canonical `origin_line_number` 是唯一终点，即使后面紧邻额外 `token_count` 也不能扩大 slice。

该拆分避免“大 Task 中目标 Request 离 Task 起点很远”导致整段 JSON 解析：正式 coverage audit 中 source-present canonical Request=`29,807`、boundary ambiguous=`0`，当前 policy 可读=`29,801`（`99.97987%`）；6 条真实 oversized slice 显式 `content_truncated`，394 条历史 source missing 显式 `source_missing`。source/Task locator 无法证明、line 顺序矛盾或超限时只返回 `unavailable/partial/truncated` coverage，不跨 source 猜测。Raw record envelope、compaction replacement history 与 encrypted reasoning 不进入公开 projection；reasoning 只保留明确 summary 或“opaque content present”事实。Tool Result 的 Tool Call 若位于上一 canonical boundary 外，V1 不回读旧 slice 补工具名，只保留 call id。

该 read path 不进入 Session/Day snapshot、Timeline、SSE、Diagnostics 或 background indexer，也不维护正文 LRU。SQLite schema 仍为 v15、projection 仍为 v2；正文生命周期只允许 `rollout -> bounded server memory -> authenticated no-store response -> 当前打开 Dialog memory`。关闭 Dialog 或切换 session/day 后前端清空 payload；generation 变化只把当前 Inspector 标记 stale，由用户显式重新读取。

Phase 25.1 在同一个 `src/request-content.js` 深模块内部深化 semantic projection，不扩大 slice I/O。第一条明确 reasoning / assistant / tool-call model-output record 定义 conservative **pre-model evidence cut**；cut 前可证明的 input-like evidence、allowlisted `turn_context` runtime metadata 与 cut 后 interaction 分别由 server 固定投影为 `observed_input / runtime_context / observed_interaction`，浏览器不再解释 raw rollout shape。Request Content contract 升为 v2。相邻且 public summary 完全一致的 reasoning semantic item 才允许 coalesce，并通过 `occurrenceCount` 保留 record evidence；无 public summary 的 opaque reasoning 只聚合为 activity count，不推断内容等价。Tool Result 仍严格受 canonical slice 约束，不能向上一 Request 回读 Tool Call。

Phase 26 在 Request Inspector 上增加第二条独立、lazy 的 **Reconstructed Input Context** seam，但仍与 accounting 解耦：

```text
canonical request_id
  -> getCanonicalRequestInputContextLocator(rootSessionId, requestId)
  -> same rootSessionId + threadId portable source chain
  -> rollout filename timestamp chronology
  -> bounded historical reader
  -> latest explicit compaction rebase when available
  -> current Phase 25.1 pre-model evidence
  -> provenance grouping
  -> authenticated no-store /input-context
  -> current Dialog Input Context tab only
```

source chain 不能由客户端提供，也不使用 filesystem mtime 作为历史顺序事实；`rollout-YYYY-MM-DDTHH-MM-SS-...jsonl` 的时间前缀必须可唯一解析，否则 locator 降级为 `boundary_ambiguous`。同线程真实数据存在 2–4 source continuity，DB locator 只截取到当前 source 为止，不拼接 sibling/parent/child thread。历史 state machine 遇到 explicit `compacted + replacement_history` 时语义化 snapshot 并 rebase；紧随其后的 `context_compacted` lifecycle echo 不重复算第二次 compaction。若只有 signal 没有 snapshot，则清除无法证明仍保留的旧 history 并形成 coverage gap。

Phase 26 冻结 hard limits 为 `16 source segments / 32 MiB history scan / 800 context items / 64 KiB item / 1 MiB projected characters`。同 Task forward reader 对跨 chunk 大 record 只合并一次；prefix/older-source tail 直接在 Buffer 上逆向逐行解析，并在遇到最近 explicit compaction 后停止继续语义解析，因此不会为已 supersede 的旧 history 创建大量字符串/对象。300 Request audit 中 source/thread P99=`2`、history scan P99=`25,614,241` bytes、context items P99=`699`、visible chars P99=`778,549`；293 complete、3 bounded partial、4 unavailable。最终 20 轮 production-equivalent warm P95 为 common=`9.427ms`、large=`39.421ms`。

每个 Phase 26 context item 必须携带 `direct_current / historical_rollout / compaction_snapshot / runtime_context / coverage_gap` provenance。`providerPayloadReconstructed=false` 与 `providerSerializationKnown=false` 是长期 truthfulness invariant；即使 rollout history coverage complete，也不能转换成“完整 Provider Input”。Input/Cached Input Tokens 继续只属于 canonical Request accounting，不允许按 context item 分配。正文仍不写 SQLite、server cache、SSE 或浏览器持久化存储。

## 任务归因

### Verified Request Ledger（唯一聚合事实源）

parser 把每条 `token_count` 建模为独立审计事件。`last_token_usage` 只作为“本次新增 usage”的候选值，必须由相邻 `total_token_usage` 逐字段验证：累计不变先判 `duplicate`；累计增量与 `last` 一致才是 `verified_increment`；累计回退只有在新累计快照本身与 `last` 一致、可证明 generation 起点时才是 `generation_start`；缺前序累计快照/关键字段保留 `unverified`，无法解释的矛盾保留 `anomaly`。Task / Agent / Session / Timeline 只聚合 verified event；duplicate、unverified、anomaly 和未归属 event 都保持独立 coverage。历史 schema 缺少 cache-write 字段时，仅该字段保持不可验证，不把整条记录强制判错。

Phase 18 把“raw evidence locator”和“业务 Request identity”正式分离。`(source_key, line_number)` 仍是 raw evidence 的 durable locator，但不再被称为 Request identity。Request identity 优先读取 `token_count` 自身的 `request_id/model_request_id/response_id`；当前真实 legacy 样本均不存在，因此 fallback 使用 `turnId + generation + cumulative verified usage + last verified usage` 做确定性 hash。thread/source/line/envelope timestamp 均不参与 identity，`call_id` 只属于工具调用。相同 identity 的 fork copy 只形成 provenance，并通过 `canonical_request_id` 指向唯一 canonical Request。已持久化 reconstructed identity 在 restore 时是 authoritative derived evidence，不能因 source 缺失、部分 replay 或排序变化被再次生成不同 ID；v13→v14 projection rebuild 会把从既有 Request Ledger 重建出的 identity 回填到 raw event 派生列。

Ownership 既处理同-root lineage，也处理 cross-root history copy。Task `startedAt` 明确早于 root session `createdAt` 时直接判为 inherited provenance；若这一时间证据未来失效，但 request identity 已被其他 root 的 `canonical_requests` 占有，则全局 identity ownership 继续阻止重复计量。一个 turn 同时含 inherited 旧 Request 与当前 root 新 Request 时只排除旧 Request，不能按 Task 粗暴清空。

Ownership 解析只发生在 raw evidence 进入 canonical projection 的边界。数据库已经通过 `task_ownership/canonical_requests` 过滤后的 Session/Day 数据，在 Snapshot/Calendar materialization 中以 `ownershipResolved` 输入处理，不再套用 root `createdAt` causal heuristic；这避免 canonical 新 Request 被第二次误判为 inherited。

缓存命中率只做展示层确定性派生：`cachedInputTokens / inputTokens`。会话使用 request-derived `summary.totalUsage`，智能体使用 request-derived `ownUsage`，任务使用 request-derived `deltaUsage`；输入非正、字段缺失或缓存大于输入时不输出百分比。

数据质量：

| 状态 | 含义 |
|---|---|
| `complete` | 已完成任务的归属 usage events 全部可验证且六字段完整 |
| `provisional` | 活跃任务已有可验证 usage，后续仍可能增长 |
| `partial` | 已有 verified usage，但仍存在缺字段、unverified/anomaly；只报告已验证下限 |
| `unknown` | 活跃任务尚没有可验证 usage |

## 美元等值估算

schema v13 按 [ADR-0019](decisions/0019-request-level-subscription-standard-cost.md) 将费用事实层与 Token Ledger 分离。parser 在每个 `token_count` ordinal 处冻结最小 pricing context：当时有效的 `model`、`service_tier` 与 evidence quality。已有 v12 Request Ledger 升级时不重算 token；原 rollout 存在时只读 enrichment pricing metadata，源文件缺失则保持 unknown。

费用粒度固定为 verified model sampling usage unit：

```text
verified Request Ledger event
  -> historical rate(model + observedAt)
  -> request feature policy(long-context / Fast evidence)
  -> Request Cost
  -> Σ Task
  -> Σ Agent own/subtree
  -> Σ Session / Day / Timeline
```

普通 request 只对 `input - cachedInput`、cached input 和 output 计价；reasoning 是 output 明细，不重复收费。subscription-standard policy 不迁入旧 API cache-write 1.25× surcharge。`input >272K` 只在单个 verified usage unit 上判定，并对整个 request 应用 input/cached 2×、output 1.5×；多个普通 request 的 Task aggregate 即使超过 272K 也不能触发。Fast 只在原始 event-level `service_tier` 字面为 `fast` 时应用；`priority`、缺失值和其他非-fast 值均按 standard。当前 Fast + long-context 组合仍被视为 unsupported evidence，不叠乘。

Historical Rate Resolver 使用 `model + observedAt` 选择唯一有效期记录。Terra/Luna 2026-07-30 切换历史价；Sol 的临时 API promotion 不改变本 `subscription-standard-equivalent` policy。Task/Agent/Session/Day 只相加 request-cost summary；`partial.amountUsd` 是当前可证明金额，并同时保留 request/task unavailable 数和 historical-rate/request-boundary/service-tier coverage。它不是 Plus 实际账单，也不能由额度百分比反推；regional processing 与收费工具仍排除。

## 持久化边界

SQLite 当前 schema 为 v15。v14 已包含 `sessions`、`agents`、`tasks`、`model_usage_events`、`canonical_requests`、`task_ownership`、`event_ownership`、`quota_snapshots`、`ingest_cursors`、`session_day_usage` 和 `derived_state`；v15 只新增 `diagnostic_alert_policies` 与 `diagnostic_alert_acknowledgements` 两张 operational state 表。`model_usage_events` 是完整 raw evidence archive；`canonical_requests` 是 Token/Cost 主业务事实；ownership 表保留 copy/unresolved provenance；`session_day_usage` 持久化 canonical request-day Token/Cost/coverage。Alerts operational state 不参与 Request Ledger、ownership、pricing 或 calendar projection。USD 仍是可重建 derived projection，不是 billing truth。

旧 schema 的 `rollout_path` / `source_path` 只作为迁移兼容列存在：能够确定映射到 `.codex` 内 rollout 的路径会提取相对 key，随后绝对 locator 置空；无法安全映射的 cursor 不被猜测，而是在后续需要时安全 replay。quota JSON 中的绝对 `sourcePath` 同样被移除。`project_path` 不做这种转换，因为它描述的是会话发生时的工程 `cwd`，不是源文件身份。

运行中的 repository 仍保留当前机器的绝对 path 进行 `stat`、tail 和 preview，但 path 由 active Codex home + source key 重新绑定，不写回 durable identity。任务表保存身份、时间、模型和字节定位；Request Ledger 保存可审计 usage/event metadata；cursor 保存行号、unknown/skipped/discontinuity 诊断及线程最新累计 usage，以便重启或跨同线程 rollout 时继续验证下一条 Request Ledger event。该 cursor 累计状态是请求验证连续性，不是旧 Boundary task baseline。日历表只保存由 Request Ledger 可重算的日期聚合，不保存正文。详见 [ADR-0014](decisions/0014-portable-source-locators.md)。

监控数据库使用 WAL，同时显式限制 `cache_size=-2000`（约 2 MiB）、`mmap_size=0`、`wal_autocheckpoint=256` 和 2 MiB journal size limit；正常关闭时尝试 `wal_checkpoint(TRUNCATE)`。这样 Timeline 性能来自减少历史 I/O，而不是把 SQLite cache 扩大到几十或几百 MiB。数据库不保存 prompt、response、消息正文或会话标题。

预览接口先把任务 `sourceKey` 绑定到当前 Codex home，再重新打开来源 rollout，确定性提取首条父代理指令，折叠空白并截断到 120 字。结果不缓存、不落库；source key 无法绑定或源文件不存在时返回不可用状态。

## 实时更新

`fs.watch` 提供快速通知，1 秒 stat 轮询补偿 Windows 丢失通知，10 秒 reconciliation 发现新增或移动到归档目录的文件；这些入口只把 root session 标记 dirty。background indexer 顺序执行 restore/tail/replay → identity/ownership → canonical request → day/cost projection → generation commit。source present 时只对当前仍存在 source 做 authoritative replace：该 source 旧 Task/Event 会被删除后以最新 parse 结果重建；source missing 时保留已验证 historical raw/canonical evidence，不因当前文件集合缩小而静默删除。Agent 持久化 aggregate、Timeline `unattributed` fallback、full/day snapshot 都只消费 canonical ownership，raw fork evidence 只服务审计与 projection rebuild。graceful shutdown 停止接收新 job、取消 queued dirty session、等待 active parse/write，再关闭 watcher 与 SQLite。

SSE listener 保存建立连接时的 scope：无 `day` 时每次重建 full-session snapshot，带 `day` 时每次只重建该日 snapshot，禁止把一个预构造 full snapshot 广播给 day listener。浏览器端仍按 [ADR-0017](decisions/0017-live-interaction-stable-rendering.md) 将“传输快照”与“DOM 重建”解耦。Agent 以 `threadId`、Task 以 `turnId` 做 keyed reconciliation；time scope 收到更新后会重新读取 SQL Timeline 并用既有导航 interaction capture/restore 保留 month/day 展开、滚动与焦点，同时右侧任务表横向滚动、Agent 展开和 visible anchor 保持稳定。Phase 19 的 Request detail 继续挂在稳定 Task row 下；已加载明细记录其 `projectionGeneration`，generation 变化时只重新读取当前展开项，因此 SSE 不会把全部 Request detail eager 塞回主 snapshot。

Parser 对已知但与归因无关的事件做显式 allowlist 跳过；未知 record/event 和缺少必需任务 ID 的记录分别计入 `unknownRecords`、`skippedRecords` 并触发 warning。真实 Phase 18 审计已确认 `patch_apply_end(1104)`、`user_message(610)`、`thread_rolled_back(183)`、`web_search_end(81)` 共 1,978 条均为 non-accounting record：它们不生成 model Request，也不直接改变 Task usage。`thread_rolled_back` 只改变会话上下文，不反向撤销已经发生的模型 usage。显式 allowlist 后同一 20-rollout 样本 `unknownRecords=0`，而 canonical Request/Token 数值保持完全一致。

账号额度使用独立的低频网络通道，不参与 rollout dirty queue。`UsageMonitor.initialize()` 先尝试一次官方 Usage；随后 60 秒 timer 复用同一个 `CodexUsageClient`。每次请求前重新读取当前 Codex 配置和 file-backed ChatGPT auth，从而跟随 Codex 自身的 token/account/base-url 变化。手动刷新与自动刷新通过单一 in-flight promise 去重。官方响应只投影为账号级 `quota_snapshots`；session parser 即使继续识别历史 rollout `rate_limits`，也不再把它们写入 current quota。

## 界面信息架构

页面沿“工程/时间 → 会话 → 智能体谱系 → 任务账页”逐层展开。工程组使用原生 `details/summary`，默认只打开当前组；时间组按月份、日期和当天 session 展开；会话汇总采用 12 栏分割线账页，避免为每个指标制造独立卡片容器。

智能体树由递归的 `agent-branch` 与 `agent-children` 构成，children 容器绘制连续竖轨并由每个 child 绘制父子横线。角色 badge 是职责的主扫描入口，昵称和 agent path 是身份补充；颜色不参与模型、用量或质量推断。

任务表在每个智能体下复用相同 `colgroup` 和固定布局，确保跨表列宽一致。小屏只让 `.task-table-wrap` 水平滚动，页面本身不产生横向溢出。设计色板、字体、响应式和替代方案见 [ADR-0009](decisions/0009-editorial-lineage-interface.md)。

交互状态由浏览器/UI 拥有：Agent 节点首次创建后，后续 snapshot 不再根据 active 状态覆盖用户手工选择的 `details.open`；导航在主动搜索或视图切换导致重建时保存并恢复已有分组展开状态与滚动。结构性 live update 则优先保持用户正在阅读的 surviving Agent/Task，而不是保持一个缺乏实体语义的绝对页面像素位置。

## 信任边界

- 进程只监听 `127.0.0.1`。
- 启动 URL 的随机令牌只能兑换一次，随后使用 HttpOnly、SameSite=Strict Cookie。
- 只接受 `GET` 和 `HEAD`，并校验 Host 与同源 Origin。
- CSP 禁止第三方脚本、frame 和跨源连接。
- URL 参数只能提供受正则约束的 session/thread/turn ID，不能提供任意文件路径。

安全与内容最小化决策详见 [ADR-0003](decisions/0003-metadata-only-persistence.md) 和 [ADR-0004](decisions/0004-loopback-session-security.md)；美元估算口径见 [ADR-0007](decisions/0007-versioned-api-equivalent-cost.md)，工程分类与缓存比率见 [ADR-0008](decisions/0008-project-directory-session-grouping.md)，界面结构见 [ADR-0009](decisions/0009-editorial-lineage-interface.md)，日期账页口径见 [ADR-0012](decisions/0012-calendar-usage-ledger.md)，增量日历索引见 [ADR-0013](decisions/0013-incremental-calendar-index.md)，Windows source rebinding 见 [ADR-0014](decisions/0014-portable-source-locators.md)，实时交互稳定性见 [ADR-0017](decisions/0017-live-interaction-stable-rendering.md)。

## 官方证据边界

- [`HistoryEntry` 仅含 `session_id / ts / text`](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/message-history/src/lib.rs#L61-L66)
- [Rollout recorder 将 JSONL 定义为可回放、可检查记录](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/rollout/src/recorder.rs#L77-L84)
- [`TokenUsageInfo` 字段和累计语义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2078-L2138)
- [任务事件与 `turn_id` 定义](https://github.com/openai/codex/blob/76d98a771e6cd44a79a3ab895a9f7c49d27d6deb/codex-rs/protocol/src/protocol.rs#L2008-L2049)
- [Hooks 文档提示 transcript 格式可能变化](https://learn.chatgpt.com/docs/hooks)
- [App Server 订阅模型](https://learn.chatgpt.com/docs/app-server)

这些链接固定到调查时的 Codex 源码提交 `76d98a7`。未来升级 parser 时应重新核对当前官方版本并新增 fixture。
