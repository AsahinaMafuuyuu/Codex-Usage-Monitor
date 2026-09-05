# Phase 27：Context Delta & Cache Correlation 交付契约

**状态：** Implemented / Verified
**日期：** 2026-09-02

## 交付目标

在 Phase 26 Reconstructed Input Context 之上，为当前 canonical Request 与同 thread immediate predecessor 提供 **Context Delta & Cache Correlation** lazy drill-down：展示本地 rollout 可证明的上下文变化、canonical Input/Cached accounting 变化和两者的 correlation evidence，同时明确不恢复 Provider cache key，也不宣称精确因果。

实施事实源：

- [技术实施方案](TECHNICAL-IMPLEMENTATION-CONTEXT-DELTA-CACHE-CORRELATION.md)
- [Phase 26 Reconstructed Input Context](TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md)
- [ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

> Phase 27 已完成真实代码、audit、benchmark、Chrome/CDP、accounting/read-only reconciliation。以下勾选项仅表示已实际交付/验证；“明确不在 Phase 27 V1”继续保持未勾选，表示刻意未实现。

## Phase 27A：Request Pair Evidence

- [x] 定义 current Request + same-thread immediate predecessor 的唯一 comparison 语义。
- [x] predecessor 顺序基于可证明 source chronology + origin line，不按 mtime/UI order 猜测。
- [x] first Request 明确返回 `no_predecessor`。
- [x] chronology/source ambiguity 明确 coverage，不猜 predecessor。
- [x] DB 提供 narrow pair locator。
- [x] foreign session/request 不参与 comparison。
- [x] V1 不允许客户端提交 arbitrary predecessor Request ID。

## Phase 27B：Semantic Context Delta Core

- [x] 新增 `src/request-context-delta.js` 深模块。
- [x] previous/current context 均复用 Phase 26 reconstruction seam。
- [x] 不建立第二套 raw rollout context reconstruction。
- [x] semantic fingerprint 只在内存中存在。
- [x] Unicode/line-ending normalization 有测试。
- [x] sequence-aware retained/added/removed-or-superseded matching。
- [x] duplicate semantic item 不被 Set diff 误判。
- [x] explicit compaction 产生 rebase evidence，旧 history 标为 superseded。
- [x] signal-only compaction 只形成 coverage gap。
- [x] runtime context 只比较 Phase 25.1 allowlist 字段。
- [x] source transition 有独立 evidence。
- [x] encrypted/opaque reasoning 不进入 Context Delta transcript。
- [x] detailed diff 超限时 bounded partial，不无界计算。

## Phase 27C：Cache Accounting Correlation

- [x] previous/current Input Tokens 来自 canonical accounting。
- [x] previous/current Cached Input Tokens 来自 canonical accounting。
- [x] Cache Hit Rate 只由 `cached/input` 确定性派生。
- [x] Input Tokens delta 正确。
- [x] Cached Input Tokens delta 正确。
- [x] Cache Hit Rate delta 使用 percentage points，不混成百分比变化率。
- [x] 缺失/矛盾字段保持 null/coverage，不补零。
- [x] 不把 token 分配到 context item。
- [x] 不从 token delta 反推正文/tokenized context。
- [x] correlation signal 与 causal claim 明确分离。
- [x] `providerCacheKeyKnown=false`。
- [x] `providerSerializationKnown=false`。
- [x] `exactCacheCausalityKnown=false`。

## Phase 27D：Correlation Policy Freeze

- [x] 新增真实 `audit:request-context-delta`。
- [x] 审计 same-thread predecessor coverage。
- [x] 审计 cross-source Request pair 比例（本次 300 样本为 0；cross-source capability 另由 fixture 覆盖）。
- [x] 审计 pair interval compaction 比例（本次 300 样本为 0；compaction semantics 另由 fixture 覆盖）。
- [x] 审计 previous/current reconstruction coverage 组合。
- [x] 审计 retained/added/superseded item 分布。
- [x] 审计 visible-character delta 分布。
- [x] 审计 Input/Cached/Cache Hit delta 分布。
- [x] 审计 `cache_changed_without_visible_context_change` 数量。
- [x] 审计 diff truncation/ambiguity rate。
- [x] audit 后冻结 `REQUEST_CONTEXT_DELTA_LIMITS`。
- [x] audit 后冻结 `request-context-delta-v1` correlation signal policy/threshold。
- [x] Phase 23 Cache Regression threshold 不被未经审计地直接复用。

## Phase 27E：Lazy HTTP Interface

- [x] 新增 `GET/HEAD /api/sessions/:sessionId/requests/:requestId/context-delta`。
- [x] endpoint 只接受 session/request identity。
- [x] source/path/line/byte/predecessor query 注入拒绝。
- [x] foreign session/request 404。
- [x] no predecessor 返回 200 + explicit state。
- [x] `Cache-Control: no-store`。
- [x] response 无 absolute path。
- [x] response 无 raw JSON/replacement history/encrypted reasoning。
- [x] 不进入 Session/Day snapshot。
- [x] 不进入 SSE。
- [x] 不触发 parser replay/ownership rebuild/diagnostics recompute。
- [x] 非 GET/HEAD 方法继续拒绝。

## Phase 27F：Request Inspector UI

- [x] Request Inspector 增加 `Interaction / Input Context / Context Delta` tab。
- [x] Context Delta 首次点击才 lazy fetch。
- [x] 打开 Dialog 不预加载 Phase 27 payload。
- [x] previous/current Request identity 可读。
- [x] previous/current Input/Cached/Cache Hit 可读。
- [x] token delta 正负号正确。
- [x] Cache Hit delta 明确使用 `pp`。
- [x] `Context Change Summary` 可读。
- [x] Added Context 分区。
- [x] Removed / Superseded Context 分区。
- [x] Runtime Context Changes 分区。
- [x] Compaction / Source Evidence 分区。
- [x] Cache Correlation Evidence 分区。
- [x] Coverage & Limitations 分区。
- [x] older/detailed delta 默认折叠。
- [x] Tool Result 默认折叠。
- [x] 大 delta 不一次展开数百 Card。
- [x] no predecessor/partial/truncated/error 有可读状态。
- [x] 720px 下无不可达操作区/横向溢出。

## Evidence / Truthfulness Gate

- [x] 产品名称始终为 `Context Delta & Cache Correlation`。
- [x] UI/API 不使用 `Exact Cache Root Cause` 等误导名称。
- [x] Context change 明确来自 local rollout reconstruction。
- [x] Cache metrics 明确来自 canonical accounting。
- [x] correlation 不称 causation。
- [x] 不声称恢复 Provider cache key/prefix hash。
- [x] 不声称恢复 Provider serialization。
- [x] 不从 visible-char delta 推 exact token delta。
- [x] 不从 cache drop 断言某一个 context item 是原因。
- [x] compaction unmatched history 使用 superseded 语义，不冒充 Provider delete。
- [x] partial source/context coverage 会降低 correlation evidence，不静默补齐。

## Privacy / Persistence / Security Gate

- [x] SQLite 无正文/delta/fingerprint/cache diagnosis 新表或列。
- [x] semantic fingerprint 不落盘。
- [x] server 不缓存多 Request Context Delta body。
- [x] browser 不持久化 Context Delta。
- [x] close/session/day switch abort + clear。
- [x] absolute path 不公开。
- [x] raw JSON/replacement history 不公开。
- [x] encrypted reasoning 不公开。
- [x] loopback / Strict Cookie / Host / Origin / CSP 不变。
- [x] 所有正文统一 escape。
- [x] bounded diff 防止 CPU/DOM DoS。
- [x] `.codex` 始终只读。

## Accounting Regression Gate

- [x] canonical Request count 前后完全一致。
- [x] input/cached/cache-write/output/reasoning/total 六字段完全一致。
- [x] calendar reconciliation 不变。
- [x] known calendar cost/coverage 不变。
- [x] Request identity/ownership 不变。
- [x] Phase 23/24 Diagnostics finding identity/severity/policy 不变。
- [x] schema v15 不因 Phase 27 改变。
- [x] projection v2 accounting 不因 Phase 27 改变。

## Performance Gate

- [x] Phase 26 reconstruction hard limits 不放宽。
- [x] Phase 27 diff 自身有 work/item/payload hard limits。
- [x] production-equivalent benchmark 包含 DB pair locator + 两侧 reconstruction + diff + accounting/correlation projector。
- [x] common warm P95 达到冻结门槛（`19.777ms < 100ms`）。
- [x] large/near-limit pair P95 达到冻结门槛（`68.592ms < 750ms`）。
- [x] diff compute 自身达到冻结门槛（P95 `1.463/9.351ms < 100ms`）。
- [x] source hash before/after 不变。
- [x] browser 大 delta 无不可接受长任务/冻结（200 detailed item detached render=`1.5ms`，默认折叠）。
- [x] close 后 previous/current reconstruction 临时对象与 delta payload 可释放。

## Browser / Automation Gate

- [x] Interaction tab 不回归。
- [x] Input Context tab 不回归。
- [x] Context Delta tab lazy fetch。
- [x] SSE replay 不替换 Dialog root。
- [x] projection stale 显示 refresh，不后台重读正文。
- [x] close 恢复同 Request 查看按钮焦点。
- [x] 1440×900 Green。
- [x] 720×900 Green。
- [x] Request pagination/scroll/diagnostics locator 不回归。
- [x] `test/request-context-delta.test.js` Green（11/11）。
- [x] DB/API/UI security Green。
- [x] `audit:request-context-delta` 完成真实审计。
- [x] `benchmark:request-context-delta` 达标。
- [x] Chrome/CDP Green。
- [x] `npm test` Green（210 / 209 passed / 0 failed / 1 existing optional skipped）。
- [x] `npm run check` Green。
- [x] `git diff --check` Green。
- [x] accounting/read-only fingerprint 一致。

## Documentation Gate

- [x] 实现后更新 `docs/API.md`。
- [x] 实现后更新 `docs/ARCHITECTURE.md`。
- [x] 真实验证后更新 `docs/VERIFICATION.md`。
- [x] 用户可见交付后更新 `README.md`。
- [x] 用户可见交付后更新 `CHANGELOG.md`。
- [x] ROADMAP 只有在全部 Gate Green 后改为“已交付”。
- [x] Delivery 只有在真实证据齐全后改为 `Implemented / Verified`。

## 明确不在 Phase 27 V1

- [ ] Exact Provider Request Capture。
- [ ] Provider cache key / prefix hash reconstruction。
- [ ] Exact cache causal attribution。
- [ ] causal confidence / ranking。
- [ ] item-level exact token attribution。
- [ ] Raw JSON diff/viewer。
- [ ] reasoning CoT diff/decryption。
- [ ] arbitrary two-Request comparison。
- [ ] Context Delta 正文持久化/全文搜索。
- [ ] LLM-generated root-cause explanation。

以上条目是显式排除项，不应在 V1 实施时“顺手完成”，也不阻塞 Phase 27 在其既定 evidence boundary 内交付。
