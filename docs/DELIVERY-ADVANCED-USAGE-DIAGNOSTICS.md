# Phase 24：Advanced Usage Diagnostics 交付契约

**状态：** Phase 24A Implemented / Verified；Phase 24B1 Behavioral Diagnostics Implemented / Verified；Phase 24B2 Budget / In-app Notification Implemented / Verified；LLM Root-Cause Explanation Pending
**日期：** 2026-09-02

## 交付目标

Phase 24 在 Phase 23 Local Diagnostics 之上建立历史鲁棒统计层，使用户可以判断一个 Request 或 Session slice 是否相对于同工程、同模型、同 effort 的历史行为显著异常，同时不改变 canonical Request accounting。

设计事实源：

- [Advanced Usage Diagnostics 设计方案](DESIGN-ADVANCED-USAGE-DIAGNOSTICS.md)
- [Advanced Usage Diagnostics 技术实现](TECHNICAL-IMPLEMENTATION-ADVANCED-USAGE-DIAGNOSTICS.md)
- [ADR-0027：Historical Robust Usage Diagnostics](decisions/0027-historical-robust-usage-diagnostics.md)

## Phase 24A 必须交付

- [x] strict Historical Cohort：exact projectPath + model + known effort。
- [x] bounded request history：时间窗口 + per-cohort cap + minimum sample。
- [x] Median / MAD / Robust Z-Score。
- [x] MAD=0 明确 degenerate，不做 epsilon fallback。
- [x] Historical Context candidate/finding。
- [x] Historical Cache Regression candidate/finding。
- [x] Historical Cost candidate/finding，严格隔离 service tier / rate version。
- [x] Session Cohort Slice。
- [x] Cross-session Regression。
- [x] Session/Day request-level scope invariance。
- [x] Shadow CLI 与 threshold review。
- [x] Frozen `advanced-usage-diagnostics-v1` policy。
- [x] 独立 lazy Advanced Diagnostics API。
- [x] Local / Historical / Cross-session UI 分层。
- [x] Canonical Request locator / supporting locator。

## Phase 24B1 Behavioral Diagnostics

以下三个 deterministic behavioral detector 已完成实现、真实 shadow、policy freeze、lazy API/UI、浏览器与性能验证：

- [x] Reasoning Anomaly。
- [x] Request Burst。
- [x] Subagent Amplification。
- [x] Frozen `behavioral-usage-diagnostics-v1`。
- [x] `shadow:behavioral-usage-diagnostics`。
- [x] `benchmark:behavioral-usage-diagnostics`。
- [x] 独立 lazy `/behavioral-diagnostics` full/day read path。
- [x] `Behavioral · Request / Behavioral · Session` UI。
- [x] Request locator / Session supporting locator 均复用 Canonical Request audit。

## Phase 24B2 Budget / In-app Notification

Budget / Notification 已按 [ADR-0029](decisions/0029-local-diagnostic-budget-notification-state.md) 完成并验证：

- [x] SQLite schema `v14 -> v15`，只新增 `diagnostic_alert_policies` 与 `diagnostic_alert_acknowledgements` operational tables。
- [x] canonical Request / Request Ledger / ownership / pricing / calendar projection 语义不变。
- [x] 工程级 Session USD Budget 使用 `Subscription Standard-Rate Equivalent`，仅在 `costEstimate.status=estimated` 时触发。
- [x] `minimumSeverity` 只支持 `warning/high`，默认 `high`。
- [x] Ack 使用 deterministic alert identity；Snooze 使用工程 policy 的 cooldown，默认 60 分钟。
- [x] 通知仅存在于本机 in-app Alerts center；不发送邮件、Webhook、系统推送或其他外部通知。
- [x] 新增严格 allowlist 的本地 POST API；其他非 allowlist POST 仍为 `405`，Host / Origin / Strict Cookie 边界继续生效。
- [x] Alerts lazy-read 使用 `projectionGeneration` scoped deterministic cache；projection generation、policy 修改、Ack、Snooze 时失效，最多缓存 32 个 Session。
- [x] 1440×900 / 720×900 Chrome QA、DB/API 定向回归、性能与最终仓库 Gate 均通过。

LLM Root-Cause Explanation **仍为 Pending**。它会突破当前 `no-model-call / no-new-network` 不变量，必须另立 ADR，并明确 explicit opt-in、data-egress、模型调用费用和 deterministic finding 分离契约；当前实现没有伪造任何 LLM explanation。

## Phase 24B1 Behavioral Gate

- [x] Reasoning denominator 至少 `outputTokens >= 128`，unknown effort 不 broaden cohort。
- [x] Reasoning historical cohort exact project/model/effort，30 天 / 200 samples / min 20。
- [x] Burst 只消费 canonical Request，60s sliding window；120s idle gap 只作为 evidence episode。
- [x] Burst historical Session Slice 60 天 / 20 slices / min 10，Day scope 不返回 Session-level Burst。
- [x] Amplification 使用 canonical root/descendant Token/Request + Agent lineage。
- [x] Amplification historical baseline 只使用 exact-project prior multi-agent Session，不跨工程 fallback。
- [x] `MAD=0 -> degenerate / robustZ=null`。
- [x] final shadow：`26 findings / 30,198 Requests`（Reasoning 24 / Burst 1 / Amplification 1）。
- [x] Chrome/CDP 1440×900 / 720×900；Behavioral Session evidence locator、SSE/focus/scroll/viewport 均通过。
- [x] 20 轮 warm benchmark：common P95 `85.607ms`；largest real project/latest Session P95 `381.353ms`。
- [x] 常规 Session/SSE snapshot 不执行 Behavioral analyzer。
- [x] SQLite schema/accounting 不因 Behavioral detector 改变。

## Accounting / Privacy Gate

- [x] Advanced Diagnostics 只消费 canonical Request 业务事实。
- [x] inherited/raw copied evidence 不进入 historical sample count。
- [x] Request/Task/Session/Timeline 六字段 Token 前后逐项一致。
- [x] Request cost 继续唯一来自 pricing module。
- [x] Advanced module 不复制 model rate card、272K、Fast multiplier。
- [x] `.codex` before/after combined SHA-256 不变。
- [x] SQLite 不新增 Prompt/Response/message-body/credential。
- [x] Phase 24A 不新增模型调用或外部网络。
- [x] 常规 Session/SSE snapshot 不执行 historical analyzer。
- [x] schema v15 新增表只保存 alert operational state，不保存新的 accounting truth 或正文。
- [x] Budget / Notification 仅本机 in-app，不新增外部通知网络。

## Cohort Correctness Gate

- [x] Historical cohort exact projectPath 隔离。
- [x] exact recorded model 隔离。
- [x] known exact effort 隔离。
- [x] effort unknown 不 fallback 到其他 effort。
- [x] current Session 永不进入自己的 historical baseline。
- [x] future sample 永不泄漏。
- [x] Cost baseline 同 service tier。
- [x] Cost baseline 同 rate version。
- [x] 样本不足返回明确 coverage，不通过扩大 cohort 猜结果。

## Robust Statistics Gate

- [x] median 与 MAD 对 worked example 有独立 literal 期望值测试。
- [x] Robust-Z 公式与设计一致。
- [x] MAD=0 返回 `degenerate / robustZ=null`。
- [x] NaN/Infinity/null 不进入 valid sample。
- [x] statistical gate 与 practical-effect gate 分开记录。
- [x] Draft threshold 只用于 shadow；完成真实 review 后才切 Frozen version。

## Cross-session Gate

- [x] 一个 prior Session cohort slice 只贡献一个 sample。
- [x] 不按 Session Request 数重复加权历史 baseline。
- [x] current slice 至少满足 minimum Request count。
- [x] prior slice 至少满足 minimum history count。
- [x] weighted cache hit 使用 `Σcached / Σinput`。
- [x] Session-slice finding 不在 Day scope 冒充 day-level regression。
- [x] supporting Request 只作为 locator，不成为 finding identity。

## Shadow Validation Gate

- [x] 输出 strict cohort coverage。
- [x] 输出 insufficient-history / unknown-effort / degenerate-MAD 覆盖。
- [x] 输出 robustZ/effect 分位数。
- [x] 输出 candidate/finding / 100 Requests。
- [x] 输出 unique affected Requests / sessions。
- [x] 输出 V1 Local 与 Historical overlap ratio。
- [x] 对 threshold 附近候选做人工代表样本审查。
- [x] 对 high tail 做人工代表样本审查。
- [x] threshold revision 有事实依据，不以“减少报警数量”为唯一目标。

## API / Performance Gate

- [x] Advanced endpoint 与 Phase 23 `/diagnostics` 独立，不改变 V1 contract。
- [x] Session scope 支持 request historical + cross-session finding。
- [x] Day scope 只输出目标 day current Request 的 historical finding。
- [x] Advanced request 不触发同步 rollout replay。
- [x] historical SQL bounded，无 Task/Request N+1。
- [x] query plan / index 有实测记录。
- [x] common warm Advanced Diagnostics P95 `<200ms`。
- [x] largest real project/session benchmark `<500ms`。

## UI Gate

- [x] Local / Historical / Cross-session baseline source 明确。
- [x] Historical finding 显示 sample count / median / MAD / Robust-Z / effect。
- [x] 找到 canonical Request 时复用现有 Request audit，不新增第二套 viewer。
- [x] Cross-session finding 可定位 supporting Request evidence。
- [x] 1440×900 可用。
- [x] 720×900 可用。
- [x] SSE 后 panel / Agent / Task / Request drawer / focus / scroll 稳定。
- [x] reduced-motion 继续成立。

## Automation Gate

- [x] 新增 `test/advanced-diagnostics.test.js`。
- [x] DB/API regression Green。
- [x] UI static/security Green。
- [x] Shadow CLI Green。
- [x] Benchmark CLI Green。
- [x] `npm test` Green（允许既有 optional real fixture skip）。
- [x] `npm run check` Green。
- [x] `git diff --check` Green。
- [x] accounting fingerprint 前后相同。
- [x] rollout manifest 前后相同。
- [x] `docs/VERIFICATION.md` 只记录真实执行结果。
- [x] Phase 24B2 最终 `npm test` = `176 tests / 175 passed / 0 failed / 1 optional skipped`。
- [x] Phase 24B2 最终 `npm run check` 与 `git diff --check` Green。
- [x] schema v15 最终 canonical/calendar 六字段 reconciliation 相等。

## 状态切换规则

Phase 24A 当前为 `Implemented / Verified`。

只有以下条件全部满足后，**Phase 24A** 才允许切换为 `Implemented / Verified`：

1. strict historical cohort 与 robust statistics 实际实现；
2. 真实 shadow 完成并冻结 `advanced-usage-diagnostics-v1`；
3. request historical + cross-session 两类 finding 完成；
4. API/UI/性能/浏览器/安全回归实际通过；
5. accounting 与 rollout hash 证明无副作用；
6. VERIFICATION 记录本轮实际执行证据。

Phase 24A 完成不代表 Phase 24B 完成。24B 必须独立更新状态；当前 B1 与 B2 Budget / In-app Notification 均已完成，只有 LLM Root-Cause Explanation 继续 Pending。

## 最终交付证据（2026-09-02）

- Real-history shadow：`242` Sessions / `30,198` canonical Requests；production-equivalent finding `4,490`（`14.868534 / 100 Requests`），unique affected Requests `3,668`（`12.1465 / 100`）。
- Shadow severity：Historical Cache `1,079 high / 500 warning`；Historical Context `889 / 440`；Historical Cost `856 / 722`；Cross-session Cache `3 warning`、Context `1 warning`、Cost `0`。threshold-adjacent 与 high-tail 脱敏样本均完成审查。
- 20 轮 warm benchmark：common P95 `84.298ms`；最大 Request Session P95 `40.158ms`；最大真实工程最新 Session P95 `416.362ms`。优化后最大工程 analyzer stage P50 约 `60.175ms`。
- Chrome/CDP：1440×900 与 720×900 均通过；Local/Historical/Cross-session 分层、Historical `n/median/MAD/Z/effect`、Local/Historical locator、SSE 后 panel/drawer/focus/scroll 与窄屏 viewport fit 均验证。
- Automation：`npm test` = `164 tests / 163 pass / 0 fail / 1 optional fixture skip`；`npm run check`、`git diff --check` 均 Green。
- Accounting/read-only：Advanced shadow + benchmark 前后均为 `30,201 Requests / 3,712,877,422 total tokens / $2569.48648723 known calendar cost`，canonical 与 calendar 六字段相同；projection generation 保持 `7888`。`.codex` 均为 `450` rollout，manifest SHA-256 均为 `8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`。
- Phase 24B2 DB/API 定向回归 `42/42`，UI + DB/API 联合定向回归 `44/44`；Chrome QA 实测 Alerts center、Budget 默认关闭、minimum severity=High、cooldown=60min、Ack/Snooze 与 720px 响应式均通过。
- Phase 24B2 Alerts steady-state 20 轮 warm HTTP：common P50/P95=`1.268/2.208ms`；最大真实工程最新 Session P50/P95=`1.071/2.335ms`。服务刚启动且 background indexer 尚在推进 projection generation 时 cache 会按设计失效，因此该阶段不冒充 steady-state warm 性能；generation 稳定后复测满足目标。
- schema v15 最终 reconciliation：canonical 与 calendar 均为 `30,201 Requests / 3,712,877,422 total tokens`，known calendar cost=`$2569.48648723`，projection v2 / generation=`8191`；`.codex` 仍为 `450` rollout，manifest SHA-256=`8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`。
- 最终仓库自动化：`npm test`=`176 tests / 175 passed / 0 failed / 1 optional skipped`；唯一 skip 为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture；`npm run check` 与 `git diff --check` 均 Green。
