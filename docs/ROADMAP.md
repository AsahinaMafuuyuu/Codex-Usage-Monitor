# 路线图

路线图描述候选方向，不是已承诺交付。优先级变化应先更新本文件和相关 ADR。

## 已完成：Usage Diagnostics

- Phase 23 V1：基于 canonical Request 实现 Context Inflation、Cache Regression/Breakpoint、Cost Spike、Long Context Trigger。
- 诊断采用独立、确定性、版本化 projection，不改变 Request Ledger / ownership / pricing accounting，也不读取 Prompt/Response。
- 第一版 compute-on-read，不新增 SQLite schema；真实历史 shadow report、性能、浏览器与 accounting/read-only 门槛已通过并进入用户可见交付。
- Phase 24A 已继续交付 `projectPath + model + effort` historical cohort、Median + MAD / Robust-Z 与跨 Session regression；Phase 24B1 已交付 Reasoning anomaly、Request burst 与 Subagent amplification；Phase 24B2 的 Budget / In-app Notification 也已交付。

设计与实现边界见 [DESIGN-USAGE-DIAGNOSTICS.md](DESIGN-USAGE-DIAGNOSTICS.md)、[TECHNICAL-IMPLEMENTATION-USAGE-DIAGNOSTICS.md](TECHNICAL-IMPLEMENTATION-USAGE-DIAGNOSTICS.md) 与 [ADR-0026](decisions/0026-deterministic-usage-diagnostics-projection.md)。

## 已完成：Phase 24A Advanced Usage Diagnostics

Phase 24A、Phase 24B1 与 Phase 24B2 Budget / In-app Notification 均已实现并验证；剩余项只有可选 LLM Root-Cause Explanation。

### Phase 24A：Historical Robust Diagnostics

- strict historical cohort：exact `projectPath + model + known effort`；样本不足时不跨 cohort 猜测。
- bounded historical request window + Median / MAD / Robust Z-Score。
- Historical Context / Cache / Cost diagnostics；Cost 额外隔离 service tier 与 pricing rate version。
- Session Cohort Slice + Cross-session Regression；一个 prior Session 对同 cohort 只贡献一个 sample，避免大 Session 支配 baseline。
- 已完成 deterministic fixture + real-history shadow，并冻结 `advanced-usage-diagnostics-v1` threshold/effect gates；独立 lazy API/UI、Canonical Request locator、20 轮性能门槛与浏览器回归均已通过。

### Phase 24B1：Behavioral Diagnostics（已完成）

- Reasoning Anomaly：reasoning/output share + minimum denominator + exact project/model/effort historical robust baseline。
- Request Burst：canonical Request 60 秒 sliding window + prior Session Slice Robust Baseline；120 秒 idle gap 只解释 supporting episode。
- Subagent Amplification：descendant/root canonical token ratio + exact-project prior multi-agent Session baseline，不跨工程 fallback。
- `behavioral-usage-diagnostics-v1` 已冻结；final shadow `26 findings / 30,198 Requests`，20 轮最大真实工程 P95 `381.353ms`。
- 独立 lazy API 与 `Behavioral · Request / Behavioral · Session` UI 均已交付并复用 Canonical Request audit。

### Phase 24B2：Budget / In-app Notification（已完成）

- schema v15 仅新增 alert policy / acknowledgement operational tables，不改变 canonical accounting projection。
- 工程级 Session `Subscription Standard-Rate Equivalent` Budget、Warning/High 最低等级、Ack、Snooze/cooldown 已交付。
- 通知仅显示在本机页面，不发送邮件/Webhook/外部通知；本地 POST 仅开放明确 allowlist。
- projection-generation scoped Alerts cache 已交付，steady-state warm 20 轮 P95 为 common `2.208ms`、最大真实工程最新 Session `2.335ms`。
- 可选 LLM Root-Cause Explanation 仍 Pending；该能力会突破 no-model-call / no-new-network 边界，实施前必须独立 ADR 和 opt-in/data-egress 设计。

Phase 24A/24B1/24B2 都不修改 Phase 23 `usage-diagnostics-v1` 或 canonical Request accounting。24B2 的本地 operational state 由 [ADR-0029](decisions/0029-local-diagnostic-budget-notification-state.md) 单独约束。设计见 [DESIGN-ADVANCED-USAGE-DIAGNOSTICS.md](DESIGN-ADVANCED-USAGE-DIAGNOSTICS.md)、[TECHNICAL-IMPLEMENTATION-ADVANCED-USAGE-DIAGNOSTICS.md](TECHNICAL-IMPLEMENTATION-ADVANCED-USAGE-DIAGNOSTICS.md)、[DELIVERY-ADVANCED-USAGE-DIAGNOSTICS.md](DELIVERY-ADVANCED-USAGE-DIAGNOSTICS.md)、[ADR-0027](decisions/0027-historical-robust-usage-diagnostics.md)、[ADR-0028](decisions/0028-deterministic-behavioral-usage-diagnostics.md) 与 [ADR-0029](decisions/0029-local-diagnostic-budget-notification-state.md)。

## 已交付：Phase 25 Request Content Inspector

Phase 25 已在现有 Canonical Request audit 中增加 `详情 / 查看`。用户主动点击后通过 request 的 `origin_source_key + origin_line_number` 按需只读原始 rollout，并把相邻 canonical `token_count` boundary 之间的 message / tool interaction 投影成可读 Dialog。

- 正式内容语义为 **Observed Interaction Slice**，不声称恢复 Provider HTTP/Responses wire payload。
- 不把 Prompt/Response/Tool body 写入 SQLite；不进入 Session/Day snapshot、Timeline、SSE 或 Diagnostics 热路径。
- V1 只在当前打开 Dialog 的临时浏览器 state 持有正文；关闭/切换 scope 后释放，不写浏览器持久化存储。
- Tool Call / Tool Result 使用语义 Card；Reasoning 只展示明确可公开 summary；V1 不提供 Raw JSON viewer。
- Scanner/response 必须 bounded，source missing/boundary ambiguous/truncation 都显式降级。
- V1 预计保持 schema v15 / projection v2 与全部 Request/Token/Cost accounting 不变。

实现复用了既有 Task start/end line+byte locator，但将定位与正文解析分离：单侧最多 `12 MiB`、双侧总 `24 MiB` 的 locator 只统计 JSONL 换行；精确定位后最多解析 `4 MiB` 的真实 interaction slice，不从 rollout 文件头 replay。schema v15 / projection v2 与 canonical accounting 均未改变。正式 coverage audit：source-present `29,807` Requests 中 `29,801` 满足当前 bounded policy（`99.97987%`），6 条 oversized slice 显式 truncate；394 条历史 source missing 保持 unavailable。最终 default warm benchmark common P95=`1.683ms`、最重双-anchor fallback=`63.370ms`、3.865 MiB 可投影 slice=`49.776ms`。设计与交付证据见 [DESIGN-REQUEST-CONTENT-INSPECTOR.md](DESIGN-REQUEST-CONTENT-INSPECTOR.md)、[TECHNICAL-IMPLEMENTATION-REQUEST-CONTENT-INSPECTOR.md](TECHNICAL-IMPLEMENTATION-REQUEST-CONTENT-INSPECTOR.md)、[DELIVERY-REQUEST-CONTENT-INSPECTOR.md](DELIVERY-REQUEST-CONTENT-INSPECTOR.md) 与 [ADR-0030](decisions/0030-read-through-request-content-inspector.md)。当前状态为 **Implemented / Verified**。

## 已交付：Phase 25.1 Request Inspector Semantic Refinement

状态：**Implemented / Verified**。

Phase 25.1 不扩大历史读取范围，先修正现有 Inspector 的阅读语义：

- `Input/Cached/Output/Total` 改为明确 Token accounting label；
- 使用当前 slice 第一条明确 model-output evidence 之前的保守 pre-model cut，单独展示 `Observed Input Evidence`；
- `turn_context` 以 allowlisted `Runtime Context` Card 展示，不冒充 system/developer prompt；
- identical reasoning summary 在 semantic projector 层 coalesce，并保留 occurrence count；
- strict-slice Tool Result 继续使用 callId fallback，不跨 canonical boundary 回读。

Request Content public contract 已升级为 v2。正式 `audit:request-content` 仍保持 30,201 canonical Requests、source-present 29,807、当前 bounded policy 可读 29,801、boundary ambiguous 0；20 轮 warm common/near-limit P95=`0.967/0.892ms`。真实 Chrome/CDP 额外验证了 `occurrenceCount=2` 的 duplicate reasoning Request 只渲染一张 Reasoning Card，并保留 occurrence evidence。schema v15 / projection v2 与 canonical accounting 未改变。

设计、实施、交付分别见 [DESIGN-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md](DESIGN-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)、[TECHNICAL-IMPLEMENTATION-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md](TECHNICAL-IMPLEMENTATION-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)、[DELIVERY-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md](DELIVERY-REQUEST-INSPECTOR-SEMANTIC-REFINEMENT.md)。

## 已交付：Phase 26 Reconstructed Input Context

状态：**Implemented / Verified**。

Phase 26 解决“Input Tokens 很大，但当前 User message 很短时，模型可观察历史上下文是什么”的问题：

- Request Inspector 增加 lazy `Input Context` 视图；
- 只重建当前 thread 的可证明 multi-source rollout history；
- 使用 Phase 25.1 pre-model cut 排除当前 Request 已观察到的模型输出；
- 显式 compaction snapshot 参与 context rebase；signal-only/missing source 形成 coverage gap；
- 每个 context item 标记 direct/current、historical rollout、compaction snapshot、runtime context 等 provenance；
- official Input/Cached Tokens 只做 accounting 对照，不按 item 分配；
- 始终标记 Provider payload/serialization unavailable / not reconstructed；
- 全部历史正文 lazy、bounded、ephemeral，不改变 schema/accounting。

最终实现新增 `src/request-input-context.js`、DB request/thread/source-chain locator、lazy `GET/HEAD .../input-context` 与 Inspector `Interaction / Input Context` tab。source chain 只按同线程 portable rollout source 的 filename timestamp chronology 排序，不依赖 mtime。300 Request 真实 audit 冻结 `16 sources / 32 MiB scan / 800 items / 64 KiB item / 1 MiB projected body`：293 complete、3 bounded partial、4 unavailable；source/thread P99=`2`、max=`4`，history scan P99=`25,614,241` bytes，context items P99=`699`，visible chars P99=`778,549`。最终 20 轮 warm common/large P95=`9.427/39.421ms`，低于 `<150/<500ms` Gate。Chrome/CDP 验证 lazy fetch、provenance、compaction/gap、SSE/focus 与 1440×900 / 720×900；Provider payload/serialization 始终明确为未重建/未知。

设计、实施、交付与长期证据约束见 [DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md](DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md)、[TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md](TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md)、[DELIVERY-RECONSTRUCTED-INPUT-CONTEXT.md](DELIVERY-RECONSTRUCTED-INPUT-CONTEXT.md)、[ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)。

## 近期：MVP 稳定性

- 固化更多脱敏 fixture：并发、嵌套、终止、legacy 无 ordinal、未知事件、坏行和归档移动。
- 增加文件轮转、重启续读、重复导入和 2 秒 SSE 延迟的全自动集成测试。
- 为 rollout `cli_version` 建立显式 parser capability matrix。
- 提供经过确认的本地数据库导出/清理操作，不触碰原始 `.codex`。
- 增加可访问性和更多窗口尺寸的浏览器回归。

## 中期：可审计性

- 为每项质量降级提供页面级原因和边界定位。
- 增加 schema/parser migration 验证和升级前备份提示。
- 提供只包含派生统计、不含内容的 CSV/JSON 导出。
- 增加多根会话对比和时间范围过滤，同时保持额度与任务 token 分离。

## 远期适配器

- App Server：仅在监控器自身负责 start/resume 并订阅线程时，考虑使用原生 `thread/tokenUsage/updated`；不旁路接管 Codex Desktop 正在工作的线程。
- Hooks：仅在 transcript 兼容性、配置副作用和内容最小化得到重新评估后作为可选适配器。
- OpenTelemetry：仅在用户主动配置、数据字段有官方证据且不会泄露内容时评估。
- 远程/多机器：需要独立的认证、传输、存储与威胁模型，不复用当前 loopback 信任假设。

上述方向都不能改变当前事实：任务 token 是经累计快照验证的 Request Ledger usage，额度是账号级观测。USD 只允许按 event-level recorded model、历史订阅标准价和可证明 feature evidence 显示 Subscription Standard-Rate Equivalent；不得从额度百分比换算或称为 Plus 实际账单。
