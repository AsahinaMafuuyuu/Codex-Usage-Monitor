# Phase 26：Reconstructed Input Context 交付契约

**状态：** Implemented / Verified  
**日期：** 2026-09-02

## 交付目标

为 Canonical Request 提供独立、lazy、bounded、ephemeral 的 **Reconstructed Input Context** 视图，使用户能阅读本地 rollout 可证明的当前输入、历史上下文、runtime context 与 compaction evidence，同时明确它不是完整 Provider request serialization。

设计事实源：

- [设计方案](DESIGN-RECONSTRUCTED-INPUT-CONTEXT.md)
- [技术实施方案](TECHNICAL-IMPLEMENTATION-RECONSTRUCTED-INPUT-CONTEXT.md)
- [ADR-0031](decisions/0031-reconstructed-input-context-evidence.md)

> 本文已转为已验证交付记录。V1 明确排除项继续保持未勾选；其余勾选项均有 unit/API/security、真实 rollout audit/benchmark、Chrome/CDP 或 accounting/read-only evidence 支持。

## Phase 26A：Evidence & Reconstruction Core

- [x] 定义并实现 reconstruction cut。
- [x] DB 提供 request/thread/source-chain narrow locator。
- [x] source chain 顺序有可证明 evidence，不依赖文件 mtime 猜测。
- [x] 新增 `src/request-input-context.js` 深模块。
- [x] 支持同线程 multi-source history continuity。
- [x] 支持 explicit compaction snapshot rebase。
- [x] signal-only compaction 明确 coverage gap。
- [x] current pre-model evidence 复用 Phase 25.1 单一 cut 事实源。
- [x] historical message/tool context semantic projection。
- [x] encrypted/opaque reasoning 不进入可读 Input transcript。
- [x] 每个 item 有 provenance level。
- [x] source missing/unsupported/truncated 不静默忽略。
- [x] Input/Cached tokens 不分配到 item。

## Phase 26B：Audit / Limits Freeze

- [x] 新增 `audit:request-input-context`。
- [x] 审计 sources/thread 分布。
- [x] 审计 latest-compaction->request bytes 分布。
- [x] 审计 context items/chars 分布。
- [x] 审计 compaction snapshot coverage。
- [x] 审计 source missing / cut unavailable / unsupported shape。
- [x] 根据真实数据冻结 scan/item/payload limits。
- [x] 记录 oversized/partial policy。

## Phase 26C：Lazy HTTP Interface

- [x] 新增 `GET/HEAD /api/sessions/:sessionId/requests/:requestId/input-context`。
- [x] endpoint 只接受 session/request identity。
- [x] path/source/line/byte query 注入拒绝。
- [x] foreign session 404。
- [x] `Cache-Control: no-store`。
- [x] response 无 absolute path。
- [x] 不进入 Session/Day snapshot。
- [x] 不进入 SSE。
- [x] 不触发 parser replay/ownership rebuild/diagnostics recompute。
- [x] V1 未使用 pagination，因此不存在客户端可提交的 line/byte cursor；若未来分页仍只允许 server-generated opaque cursor。

## Phase 26D：Input Context UI

- [x] Request Inspector 增加 `Interaction / Input Context` tab。
- [x] Input Context 首次点击才 lazy fetch。
- [x] Header 显示 official Input/Cached accounting 与 provider disclaimer。
- [x] Current Input Evidence 分区。
- [x] Runtime Context 分区。
- [x] Retained/Reconstructed History 分组。
- [x] Compaction Evidence 分区。
- [x] Coverage Gaps 可见。
- [x] 每个 context item 有文字 provenance label。
- [x] older history 默认折叠。
- [x] Tool Result 默认折叠。
- [x] 大历史不一次展开数百 Card。
- [x] 720px 下操作区可达。

## Evidence / Truthfulness Gate

- [x] 产品名称始终为 Reconstructed Input Context。
- [x] `providerPayloadReconstructed=false`。
- [x] `providerSerializationKnown=false`。
- [x] complete observed history 不等于 complete Provider Input。
- [x] reconstruction cut 不称 Provider request start。
- [x] 未记录 system/developer prompt 不推断。
- [x] token accounting 不分配到 context item。
- [x] compaction snapshot 有独立 provenance。
- [x] source/compaction gap 不静默补齐。

## Privacy / Security / Accounting Gate

- [x] SQLite 不新增正文列/table/cache。
- [x] server/browser 不持久化 context body。
- [x] 不缓存多个 Request 的 Input Context。
- [x] close/scope switch 清空。
- [x] source absolute path/raw replacement history 不公开。
- [x] loopback / Strict Cookie / Host / Origin / CSP 不变。
- [x] 所有正文/Tool Result/Runtime Context escape。
- [x] bounded read 防止超大 context DoS。
- [x] canonical Request count、六字段 token、calendar cost、identity/ownership/diagnostics 不变。
- [x] schema/projection accounting 不因 Phase 26 改变。

## Performance Gate

- [x] audit 后冻结 limits。
- [x] production-equivalent benchmark 包含 DB/source/reconstruction/projector。
- [x] common warm P95 达到冻结门槛（设计目标 `<150ms`）。
- [x] large/near-limit P95 达到冻结门槛（设计目标 `<500ms`）。
- [x] oversized history bounded partial，不无界 replay。
- [x] 浏览器无不可接受长任务/冻结。
- [x] close 后大 payload 被释放。

## Browser / Automation Gate

- [x] Interaction tab 不回归 Phase 25/25.1。
- [x] Input Context tab lazy fetch。
- [x] SSE replay 不替换 Dialog root，stale refresh 明确。
- [x] close 恢复同 Request 查看按钮焦点。
- [x] 1440×900 / 720×900 Green。
- [x] Request pagination/scroll/diagnostics locator 不回归。
- [x] `test/request-input-context.test.js` Green。
- [x] DB/API/UI security Green。
- [x] `audit:request-input-context` 完成真实审计。
- [x] `benchmark:request-input-context` 达标。
- [x] Chrome/CDP Green。
- [x] `npm test` / `npm run check` / `git diff --check` Green。
- [x] accounting/read-only fingerprint 一致。

## Documentation Gate

- [x] 实现后更新 API/Architecture。
- [x] 真实验证后更新 Verification。
- [x] 用户可见交付后更新 README/CHANGELOG。
- [x] ROADMAP 只在完成 Gate 后改为“已交付”。
- [x] Delivery 只在真实证据齐全后改为 `Implemented / Verified`。

## 明确不在 Phase 26 V1

- [ ] Exact Provider Request Capture。
- [ ] Raw JSON Input Viewer。
- [ ] 正文持久化/全文搜索。
- [ ] item-level exact token attribution。
- [ ] reasoning CoT reconstruction/decryption。
- [ ] Context Delta / Cache Root-Cause（属于后续方向）。

以上条目是明确排除项，不阻塞 Phase 26 V1 交付。

## Delivered evidence（2026-09-02）

- Core：新增 `MonitorDatabase.getCanonicalRequestInputContextLocator()`、`src/request-input-context.js`、lazy `GET/HEAD .../input-context` 与 Inspector `Interaction / Input Context` tab；source chain 只使用同 `rootSessionId + threadId` 的 portable sources，并按 rollout filename timestamp chronology 排序，不使用文件 mtime 作为事实依据。
- Unit/API/security：`test/request-input-context.test.js` focused=`6/6 passed`，覆盖同 source/多 source continuity、current cut、explicit compaction rebase、paired `context_compacted` echo、signal-only gap、source missing/truncation；DB/API test 覆盖 GET/HEAD/no-store/query injection/foreign session/no absolute path；UI security 保持 CSP 与全量 escape。
- Audit：300 个真实 Request 样本中 source/thread P50/P95/P99/max=`1/1/2/4`；history scan P50/P95/P99/max=`1,572,864 / 13,416,588 / 25,614,241 / 33,554,432` bytes；context items P99=`699`、max=`800`；visible chars P99=`778,549`、max=`822,132`。coverage=`293 complete_observed_history / 3 partial_bounded_truncation / 4 unavailable`。118 个样本观察到 compaction，118 个均有 explicit snapshot；全库 262 条 `context_compacted` lifecycle signal 均可对应前方 2–4 行的 explicit snapshot，未发现孤立 signal。
- Frozen limits：`16 sources / 32 MiB history scan / 800 items / 64 KiB item / 1 MiB projected characters`。超限明确降级，不无界 replay。
- Performance：20 轮 production-equivalent warm benchmark common P50/P95/max=`8.501/9.427/9.853ms`，large P50/P95/max=`36.693/39.421/40.272ms`；两组 source hash 前后不变，低于 `<150ms / <500ms` Gate。
- Chrome/CDP：1440×900 与 720×900 均 Green；打开 Interaction 时 Input Context resource count=`0`，首次点击 Input Context 后变为 `1`；当前/历史/runtime/compaction/gap/provenance 均可见，24 个 provenance badge 被实际渲染；SSE replay、stale refresh、close payload clear/focus restore、窄屏无横向溢出均通过。
- Accounting/read-only：canonical/calendar 仍为 `30,201 Requests`，六字段 token 完全一致；known calendar cost=`$2569.48648723`，projection version=`2`；`.codex` 仍为 450 rollout、manifest SHA-256=`8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`。

