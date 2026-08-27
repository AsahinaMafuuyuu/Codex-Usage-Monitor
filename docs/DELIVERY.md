# v0.1.0 交付说明

**交付日期：** 2026-08-24

**项目路径：** 仓库根目录

**状态：** MVP 可本地运行

**运行要求：** Windows、Node.js 24+

## 交付范围

本版本交付一个只读、仅本机可访问的 Codex 子智能体用量监控器。它能发现根会话及递归子智能体，把累计 token 快照归因到单个 `thread_id + turn_id` 任务，持久化派生结果，并通过中文页面实时展示。

已交付：

- 会话索引、父子关系与归档 rollout 发现。
- 单/多/嵌套子智能体和同一智能体多任务归因。
- 六类 token、任务边界、状态、时间、模型、effort 与质量标签。
- 自身/含后代汇总，账号级额度快照，解析健康信息。
- 文件增量 tail、轮询 reconciliation、SSE 实时推送。
- SQLite WAL 存储和重启后的历史可见性。
- 按需原始指令预览，内容不缓存、不落库。
- loopback、一次性令牌、Strict Cookie、Host/Origin、CSP 和只读方法保护。
- 自动化测试、真实历史回归、交付文档、ADR 与 Git 基线。

## 启动与停止

```powershell
cd C:\path\to\codex-usage-monitor
npm start
```

服务输出一次性访问 URL 并打开浏览器。按 `Ctrl+C` 安全关闭 HTTP 服务、文件监听器和 SQLite 连接。更完整的配置、备份和故障处理见 [OPERATIONS.md](OPERATIONS.md)。

## 验收基准

标准验收命令：

```powershell
npm test
npm run check
```

开发机真实样本通过环境变量显式提供，不把用户名、session UUID 或 rollout 路径写入仓库：

```powershell
$env:CODEX_MONITOR_REAL_FIXTURE = 'C:\path\to\audited-rollout.jsonl'
npm test
```

期望的五个任务总 token 依次为：

```text
1,081,772 / 765,891 / 2,230,918 / 1,144,641 / 482,917
```

测试在解析前后比较源 rollout 的 SHA-256，证明该文件没有被监控器修改。样本不随仓库分发；其他机器会把该项明确标记为 skipped。最新一次执行结果记录在 [VERIFICATION.md](VERIFICATION.md)。

## 数据和恢复

- 默认派生数据库：`data\usage.sqlite`，其 WAL/SHM 文件和工具缓存均被 Git 忽略。
- 原始 `.codex` 数据不属于交付物，监控器不会备份或修改它。
- 原日志删除后，已导入任务用量仍在 SQLite 中；指令预览会显示不可用。
- 需要完全重建派生数据时，先停止服务，备份后删除监控数据库文件，再重新启动并选择会话回填。不要删除 `.codex` 数据。

## 已知限制

- 第一版只支持当前 Windows 本机数据和一个浏览器会话，不处理远程机器或多账号合并。
- Rollout 是内部可回放格式，不是稳定公共 API；未知字段被容忍，但新事件语义仍可能需要适配。
- 监控器只完整解析当前选择的根会话；未选择会话只有索引级信息，已导入历史仍保留。
- `complete` 表示该任务已归属的 Request Ledger usage 全部可验证且六字段完整，不是账单级逐请求 usage。
- 额度与 token 没有官方证明的一一换算；页面展示的 USD 仅来自逐任务可审计 token 明细与版本化标准 API 价目，不把账号额度换算为费用，也不声称是 Codex 订阅实际扣费。
- 未集成 App Server、Hooks 或 OpenTelemetry，原因记录在 [ADR-0001](decisions/0001-read-only-rollout-observer.md)。

## 前端后续交接

当前前端视觉工作位于 `codex/project-grouping-claude-redesign` 分支。Phase 8 已完成编辑式账页与连续 Agent 谱系，Phase 9 已完成 Typography v1；后续视觉优化必须按 `AGENTS.md` 的“一项视觉决策一个 Git commit”规则继续。

下一位智能体开始修改 `public/**` 前，应先阅读 [Frontend Handoff](FRONTEND-HANDOFF.md)。该文档记录精确 Git 基线、已冻结视觉/字体契约、Phase 9 后续顺序、浏览器验收协议和禁止越界修改的后端/安全边界。

## Phase 13 交付：Request Ledger 主聚合迁移

Phase 13 在 schema v10 已将任务、Agent、Session、Timeline、缓存命中率和 USD 等值估算的主 token 事实源切换为 **verified Request Ledger**。`last_token_usage` 绝不裸累加：每个候选新增 usage 必须由相邻 `total_token_usage` 逐字段证明。该阶段曾暂时保留旧 Boundary Ledger，用于完成迁移期 reconciliation。

实验基线：

- 扫描 `412` 个 rollout、`42,159` 条 `token_count`。
- 识别 `1,726` 条累计值完全不变的重复广播；这些事件不得重复计量 `last_token_usage`。
- 在兼容历史 schema（旧记录可能缺少 `cache_write_input_tokens`）后，得到 `40,388` 个可由累计值逐字段验证的新增 usage 单元；对已有前序累计值的有效增长事件，未观察到 `Δtotal_token_usage != last_token_usage` 的真实异常。
- 另有 `45` 条文件首记录无法仅凭单文件证明，其中多数表现为 `total_tokens = 0` 且 `last_token_usage > 0`；必须保留为 `unverified` 或通过同一 thread 的跨文件前序状态继续验证，禁止猜测计入。
- Request Ledger 对 2026-08-22 / 08-23 / 08-24 的可审计总量分别为 `60,289,305` / `64,066,930` / `175,486,562`。前两日与用户提供的 Profile `61,819,000` / `65,058,000` 仍分别相差约 `2.47%` / `1.52%`；08-24 与此前约 `180,000,000` 的 Profile 值相差约 `2.51%`。这些差额不得用补偿系数抹平。

2026-08-26 实施进度：Phase 13 Task 1–5 已完成。schema v10 将 verified Request Ledger 提升为主聚合事实源，并为 Task / Agent / Session / Timeline 增加 verified model usage unit count 与 tokens/unit；这里的“model request”不保证与 HTTP 请求或服务端计费请求一一对应。全历史临时回放覆盖 412 rollout / 267 session / 2,347 task：1,335 个旧 Boundary `complete` task 全部逐字段一致，`mismatch=0`；4 个 Boundary `discontinuity` task 可恢复。主 Timeline 对 08-22 / 08-23 / 08-24 分别为 `60,289,305 / 64,066,930 / 175,486,562`，对应 `636 / 550 / 1,439` 个 verified model usage units。duplicate、unverified、anomaly 和未归属事件继续单独保留 coverage，不通过 Boundary fallback 或补偿系数伪造完整值。

Phase 13 的实施顺序与历史证据如下：

1. **冻结 usage-event 分类契约。** 用 fixture 和真实历史验证 `verified_increment`、`duplicate`、`generation_start`、`unverified`、`anomaly`；逐字段比较 input / cached input / cache-write input（字段存在时）/ output / reasoning / total，而不是只比较 total。
2. **建立双账本。** 新增内部 `model_usage_events` / Request Ledger，但保留现有 Task Boundary Ledger。Request Ledger 的单元语义是“经累计快照证明的新增模型 usage”，不是底层 HTTP 请求；产品层可显示“模型请求”，内部不得假定与网络请求一一对应。
3. **跨文件保持 thread usage continuity。** 同一 `thread_id` 的累计状态不能被 rollout 文件边界截断；文件首记录只有在能由前序 generation 或 `total == last` 的新 generation 规则证明时才可计入。
4. **生成 reconciliation report。** 对每个 complete task 验证 `Σ verified request usage == boundary deltaUsage`；reset / missing-baseline 任务单独列出 Request Ledger 可恢复值；重复广播必须为零增量；无法证明的记录必须保持质量标签而不是补值。
5. **通过门槛后再切换事实源。** 已完成；Request Ledger 聚合 Task / Agent / Session / Day，旧 Boundary Ledger 在 schema v10 保留一个迁移期作为一致性审计器。
6. **记录架构决策和迁移证据。** 已由 [ADR-0015](decisions/0015-request-ledger-primary-aggregation.md) 接替 ADR-0002 的主聚合职责，并继续保留“不裸累加 `last_token_usage`”“不把 Profile 当本地 ground truth”“未知数据不伪造精确值”等不变量。

详细任务拆分和验收条件见 [`tasks/plan.md`](../tasks/plan.md) 的 **Phase 13: Verified Request Ledger and dual-ledger reconciliation**。

## Phase 14 交付：Boundary Ledger 退役 / schema v11

2026-08-26，迁移审计期结束。schema v11 按 [ADR-0016](decisions/0016-retire-boundary-ledger.md) 将旧方案从当前实现中完全退役：parser 不再计算 task boundary baseline/end/delta；SQLite `tasks` 不再保存 Boundary `quality`、baseline/end、`delta_usage` 或 `delta_*`；Timeline 删除 Boundary 专属质量列；API 删除 `boundaryDeltaUsage` / `boundaryQuality`；`src/reconciliation.js` 与 `npm run reconcile:request-ledger` 同步移除。

Request Ledger 现在是唯一运行时统计路径。已有 v10 数据库升级到 v11 时，程序在监控 SQLite 内重建 task/calendar schema，并直接使用已持久化 `model_usage_events` 重算 Agent/Timeline aggregate；具备 Request Ledger 的 session 不因该迁移重扫 `.codex`。旧方案实现与迁移前对照环境固定在 annotated tag `usage-boundary-ledger-v1`（commit `4a38ba6`）；完成退役的当前基线使用 annotated tag `usage-request-ledger-v1`，不再通过主线运行时模式开关维护旧方案。

Phase 14 的定向测试覆盖 schema v10→v11 删除旧列且 `replayedFiles=0`、Request-only task/agent/session/calendar/cost、跨重启与跨 rollout request continuity、verified generation reset、unexplained anomaly 的 partial 下限，以及 API 不再暴露 boundary 字段。最终验证结果记录在 [VERIFICATION.md](VERIFICATION.md)。

## Phase 16 交付：时间视图 Day-scoped Snapshot / schema v12

**状态：已实现并通过交付门槛。** Project 模式继续读取完整 session；Time 模式以 `(sessionId, local day)` 为选择身份，右侧 Task / Agent / Token / Request / Cost 与左侧 Timeline 使用同一 Request Ledger event-day 语义。

### 业务需求

- **工程筛选 = 完整 session。** 用户从工程目录下选择 session 时，Task、Agent、Token、Request Ledger coverage、缓存命中率和 USD 等值估算都覆盖完整 session 生命周期。
- **时间筛选 = session + 本地自然日。** 用户从某一天选择 session 时，右侧所有统计只包含该 session 在该日的记录；同一 session 可在多个日期分别打开。
- **跨午夜按真实 usage event 分日。** token 不再把整个 task 粗放地归到 `task.startedAt` 当天，而按 verified Request Ledger event `observedAt` 的本地自然日分桶。
- **智能体统计同 scope。** 时间模式 Agent own/subtree token、request count、task count 和 cost 必须由当天 Task Day Slice 重新聚合，不能读取完整 session 的持久化 Agent aggregate。
- **Timeline 与详情同口径。** 左侧某日 session 数值与右侧该 `session + day` snapshot 必须一致。
- **实时更新保持 scope。** day-scoped SSE 只能更新该日数据，同时继续保护滚动、展开、焦点和可见锚点。

### 规范与事实边界

- Request Ledger 仍是唯一 token 事实源，只接受 `verified_increment` / `generation_start` usage。
- duplicate 不增量；unverified/anomaly 不补数，只降低 coverage/quality。
- 未归属到已知 task 的 event 不进入 Task/Agent/Session 主统计。
- 本地日期必须按监控器时区的日历午夜处理并兼容 DST，不能固定加 24 小时。
- task 可以跨日形成多个**查询 slice**，但 SQLite 不复制 task 身份，也不伪造按日 duration。
- USD 继续是标准 API 等值估算，不是 Codex 订阅账单或额度换算。
- `.codex` 继续严格只读；schema v12 的日历语义迁移应直接利用已持久化 Request Ledger，不因迁移重放 Request-ready 历史。

### 已交付实现

- 设计事实源：[DESIGN-DAY-SCOPED-SNAPSHOT.md](DESIGN-DAY-SCOPED-SNAPSHOT.md)。
- 架构决策：[ADR-0018](decisions/0018-day-scoped-request-ledger-snapshot.md)。
- 测试门槛：[TEST-DAY-SCOPED-SNAPSHOT.md](TEST-DAY-SCOPED-SNAPSHOT.md)。
- 任务拆分：[`tasks/plan.md`](../tasks/plan.md) Phase 16。
- `src/snapshot-scope.js` 集中实现严格本地日/DST 边界、Task Day Slice、Agent lineage、Session summary 与 Calendar Slice；Timeline 与详情不再维护两套日期规则。
- schema v12 从已持久化 `tasks + model_usage_events` 重建 event-observed `session_day_usage`，规范化 `observed_at` 为 UTC ISO，并新增 `(root_session_id, observed_at, classification)` 查询索引；Request-ready v11 迁移 `replayedFiles=0`。
- snapshot/SSE 支持严格 `?day=YYYY-MM-DD`；SSE listener 后续更新按建立连接时 scope 重新物化。
- Time 前端保存 `selectedDay` 并以 id/day 二元组选择；同一 session 可跨日分别打开。Project↔Time 会重新请求正确 scope；Time live update 重新拉取 SQL Timeline，同时保持导航滚动/展开/焦点与 ADR-0017 的任务表/Agent 交互稳定性。
- 定向、全量与真实 Chrome/CDP 证据见 [VERIFICATION.md](VERIFICATION.md#phase-16day-scoped-request-ledger-snapshots--schema-v12)。

## Phase 17 交付：Subscription Standard-Rate Cost / Request-level Pricing

**状态：已实现并通过交付门槛。** 本阶段把现有“当前 API 短上下文等值”升级为更适合订阅用户审计的 **Subscription Standard-Rate Equivalent**，同时保持 Request Ledger 的 Token 事实链不变。

### 业务需求

- **按订阅标准价等值比较使用价值。** USD 不再跟随 GPT-5.6 Sol 的临时 API/token-based 促销；Sol 的 included-plan/legacy metering 官方声明未变，因此本 policy 继续使用促销前标准价等值。
- **历史价格必须按发生时间选择。** Terra/Luna 2026-07-30 降价会反映到付费订阅 usage，因此该日期是历史价目切点；历史 GPT-5.5/GPT-5.4 等模型按其实际 recorded model 和可证明 rate interval 计算。
- **费用计算下沉到 Request Ledger usage unit。** Task/Agent/Session 只汇总 request cost，不能先把 Task token 合并后再判断 feature surcharge。
- **长上下文按单次请求判定。** 只有 request-level evidence 可证明且 input `>272K` 才应用 full-request `input 2× / cached 2× / output 1.5×`；Task 累计超过 272K 不构成长上下文。
- **Fast 按事件当时 service tier 判定。** `fast`/`priority` 使用模型对应 multiplier；缺 evidence 不猜。当前官方 Fast FAQ 不支持 long context，因此两者同时出现不做倍率叠乘。
- **API cache-write surcharge 不直接迁入订阅口径。** `cacheWriteInputTokens` 保留审计，但第一版 subscription-standard policy 按非 cached input 处理，直到出现明确的订阅/legacy metering cache-write 规则。

### 证据与边界

- Token Ledger 仍只接受 verified `generation_start` / `verified_increment`，本阶段不得改变六字段 usage、classification 或 day-scope 归属。
- request-boundary evidence gate 已通过 bounded semantics：verified Request Ledger usage unit 可作为 Codex 单次 model sampling usage unit 判断 272K；它不等价于 HTTP invoice identity。重复 `token_count` 仍必须由 cumulative advancement 去重，未验证 event 只能报告 candidate/partial。
- 历史 service tier 目前没有持久化。原 rollout 存在时允许只读 metadata enrichment；原文件不存在时保持 unknown，不能默认 `default`。
- USD 始终只是订阅标准价等值，不是 Plus 实际扣费，也不能用于反推 5 小时/周额度。
- Regional processing、web search、image/voice/tool fee 不在本阶段范围，后续必须作为独立 feature policy 且有可证明本地 evidence 后再加入。

### 交付事实源

- 方案设计：[DESIGN-SUBSCRIPTION-STANDARD-COST.md](DESIGN-SUBSCRIPTION-STANDARD-COST.md)。
- 测试门槛：[TEST-SUBSCRIPTION-STANDARD-COST.md](TEST-SUBSCRIPTION-STANDARD-COST.md)。
- 架构决策：[ADR-0019](decisions/0019-request-level-subscription-standard-cost.md)。
- 实施任务：[`tasks/plan.md`](../tasks/plan.md) Phase 17。

后续智能体开发前必须重新阅读上述 DESIGN + TEST + ADR。测试失败时先回到设计核对，不允许通过放宽 historical-rate、272K、service-tier 或 coverage 断言绕过失败。

### 已交付实现与真实历史证据

- Historical Rate Catalog 按 `model + observedAt` 唯一选价；Terra/Luna 2026-07-30 切价、Sol promotion exclusion、GPT-5.4/5.5 历史边界均有 fixture。
- Snapshot / Agent / Session / Day / Timeline USD 全部改为 `Σ requestCost(event)`，不再从 Task aggregate 重跑 threshold/multiplier；partial 金额直接显示 `$xx.xx`，coverage/title 解释证据缺口，不恢复 `≥`。
- schema v13 为 `model_usage_events` 增加 `model / service_tier / pricing_context_quality`，cursor 保存 pricing context；v12→v13 migration 逐字段证明 classification + 六类 usage 不变。原 rollout 存在时只读 enrichment，缺源时保持 unknown。
- 真实历史 reconciliation 扫描 `425` 个 rollout / `242` 个 root session / `2,368` 个 task / `41,089` 个 verified usage unit，总 verified token `5,223,166,739`；源文件 `hashChangedFiles=0`。
- 真实 service-tier evidence：`default=23,743`、`fast=0`、`priority=0`、`unknown=17,346`。因此真实历史 Fast adjustment 为 `$0`，不是缺失实现；unknown 继续降低 coverage，不并入 default。
- `input >272K` 的 verified usage unit 共 `571` 个，input token `166,551,689`。真实可比较的 `1,792` 个 task 上，旧 current API equivalent `$2703.97106036` 经 subscription-policy `+$155.09507810`、historical-rate `+$50.84818823`、long-context `+$106.61941600`、Fast `+$0` 后得到 `$3016.53374269`；重建 delta 为 `$0`。所有可定价 usage unit 的已知新金额合计 `$3087.22782329`，其中部分 task 因旧 estimator 或历史证据不可比较而不进入 additive subset。
- 真实 Chrome/CDP 桌面与 720px 验收通过；snapshot 更新保持任务表横向滚动、focus、Agent 展开和 visual anchor，Project↔Time scope 仍正常。

## Phase 18 交付：Canonical Request Ownership / Request-Day Projection / schema v14

**状态：已实现并通过交付门槛。** 本阶段把运行时计量模型冻结为：Rollout 是只读 evidence；`canonical_requests` 是 Token/Cost 唯一业务事实；Task、Agent、Session、Day 都是 canonical Request projection；fork history 只能产生 provenance。

### 已实现边界

- Native Request Identity 只接受 `token_count` 自身可证明的 `request_id/model_request_id/response_id`；`call_id` 明确属于工具调用。当前真实 legacy 样本无 native Request ID，因此使用 `turnId + generation + cumulative verified usage + last verified usage` 确定性重建，thread/source/line/timestamp 不参与 identity。
- schema v14 保留 `model_usage_events` raw evidence，新建 `canonical_requests`、`task_ownership`、`event_ownership`；inherited evidence 通过 `canonical_request_id` 指向唯一业务 Request，raw evidence 不删除。
- Time 模式严格按 canonical Request 原始 `observedAt` 本地日切片；Task lifecycle 本身不创建日期记录。跨午夜 Task 仅在对应日期真正发生 Request 时出现。
- `verified_zero` 只在 Task 后首个 cumulative checkpoint 可严格证明零增量时成立；无法证明仍保持 partial/unknown。
- Timeline/Session hot path 读取 cached SQL projection；dirty source 由 background indexer restore/tail/replay 后生成新 generation。Parser restore 使用 raw session，避免 incremental tail 丢失 inherited provenance。
- source present 以当前 rollout authoritative replace 派生结果；source missing 保留已验证 historical canonical usage，不因当前文件集合缩小而静默删除。
- source authority 已进一步收紧为 source-scoped replace：present source 的 stale Task/Event 会先删除再重建；missing source 的 historical evidence 保留。持久化 Agent aggregate 与 Timeline `unattributed` fallback 也只消费 canonical ownership。
- reconstructed Request identity 在 restore 时保留已持久化 identity；v13→v14 migration/rebuild 会从既有 Request Ledger backfill identity。parser semantics version 与 schema v14 独立，事件分类更新会触发后台 reindex cursor diagnostics，而不是手工清除旧 warning。
- ownership/canonical request/day/cost/`projection_generation` 在同一 SQLite transaction 中切换；graceful close 取消 queued job、等待 active parse/write 后才允许关闭 SQLite。

### 真实污染 Session reconciliation

对 `019fbb2b-5db4-7410-bc55-41bbf5a6afc1` 的 20 个 rollout 执行只读 `npm run reconcile:phase18`：

- `13,593` 条 `token_count`；`12,783` verified increment、`790` duplicate、`20` unverified。
- 同一 20-rollout 中共读取 `52,552` 条 JSONL record；原 `1,978 unknownRecords` 已精确审计为 `patch_apply_end=1,104`、`user_message=610`、`thread_rolled_back=183`、`web_search_end=81`。四类均不生成 model Request/Task usage；allowlist 后 `unknownRecords=0`，parser health=`healthy`。
- Native canonical Request `0`，deterministic reconstructed canonical Request `1,464`。
- Task：`639 raw = 67 canonical + 572 inherited + 0 unresolved`。
- Request evidence：`12,783 raw verified = 1,464 canonical + 11,319 inherited + 0 unresolved`。
- 六字段逐项守恒；total token 为 `1,739,759,444 raw = 175,379,870 canonical business + 1,564,379,574 inherited provenance + 0 unresolved`。
- 20 个参与 rollout before/after SHA-256 全部一致，`hashChangedFiles=0`。
- 临时 schema v14 shadow projection：`13,593` raw evidence rows、`1,464` canonical request rows、2 个 session-day rows；最终 warm Timeline P95 `19.76ms`，warm Session-Day P95 `65.43ms`，满足 `<200ms / <300ms` 门槛。完整 shadow persist `1,306.58ms`，位于后台索引路径。
- 最终 20-file SHA-256 manifest：before=`3ada9c1437ab51d5bac24451e6709182675fbe47a8cbc0754108bf8b5a2b7f30`，after 完全相同。

### 浏览器验收

最终真实 Chrome/CDP 1440×900 与 720×900 均通过：普通 snapshot 更新保持同一 task-table/Agent DOM、`scrollLeft=354`、focus、展开与手工折叠状态；结构变化 `scrollDelta=66px` 时 visual-anchor top delta `0px`，Project 恢复 full scope。最终复验选中的 live session 只有一个 Timeline day，因此 cross-day 子检查自然 skipped；此前多日真实 session 已实际通过 `2026-08-27 → 2026-08-26`。720px 下独立横向 overflow、`scrollLeft=240`、focus 和 Agent 状态保持。

## 交付核对

- [x] 源码、静态页面和测试在独立项目目录中。
- [x] Git `main` 基线和忽略规则包含在交付中。
- [x] README、交付、架构、API、运维、验证、路线图、CHANGELOG 和 ADR 已提供。
- [x] 项目级 `AGENTS.md` 定义多智能体角色、所有权、并行边界和交接格式。
- [x] 数据口径、隐私边界和真实样本证据已明确区分。
- [x] 前端视觉迭代已提供独立接手文档与逐决策版本控制规则。
- [x] Request Ledger 已在 reconciliation、增量 tail、重启、schema v9→v10 迁移和真实历史回放门槛通过后成为正式主统计事实源；schema v11 已结束迁移期并退役 Boundary Ledger，旧实现由 `usage-boundary-ledger-v1` 保存。
- [x] Phase 16 Day-scoped Snapshot 已按 ADR-0018 和 schema v12 交付；Timeline/detail、HTTP/SSE、前端二元选择和 live interaction 验证证据已归档。
- [x] Phase 17 Subscription Standard-Rate Cost 已按 ADR-0019 完成交付：historical catalog、request-cost engine、long/Fast policy、schema v13、event pricing context、只读 enrichment、request-derived aggregation、API/UI coverage 与真实历史 reconciliation 均已闭环。
- [x] Phase 18 Canonical Request Ownership / Request-Day / schema v14 已完成：最终 `npm test` 为 109 tests / 108 passed / 0 failed / 1 optional skip；`npm run check`、`git diff --check`、真实 unknown-record audit、canonical reconciliation、read-only hash、性能与桌面/窄屏浏览器门槛均通过。
