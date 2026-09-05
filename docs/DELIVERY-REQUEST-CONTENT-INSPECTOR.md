# Phase 25：Request Content Inspector 交付契约

**状态：** Implemented / Verified  
**日期：** 2026-09-02

## 交付目标

Phase 25 在现有 Canonical Request audit 上增加一个只读、按需、语义化的 Request Content Inspector，使用户能够理解一次 canonical Request 对应的本地 rollout 交互内容，同时保持 accounting、SQLite metadata-only、loopback security 与 `.codex` read-only 不变量。

设计事实源：

- [Request Content Inspector 设计方案](DESIGN-REQUEST-CONTENT-INSPECTOR.md)
- [Request Content Inspector 技术实施方案](TECHNICAL-IMPLEMENTATION-REQUEST-CONTENT-INSPECTOR.md)
- [ADR-0030：Request Content 使用 read-through ephemeral projection](decisions/0030-read-through-request-content-inspector.md)

> 本文已由交付契约转为**已验证交付记录**。勾选项均有自动化、真实 rollout benchmark、Chrome/CDP 或 accounting/read-only reconciliation 证据；V1 明确排除项继续保持未勾选。

## Phase 25A：Content Projection Core

- [x] 新增独立 `src/request-content.js` 深模块。
- [x] Request content 使用相邻 canonical `token_count` evidence boundary 构造 Observed Interaction Slice。
- [x] 第一 Request 只在可证明的同-source Task start boundary 下回退。
- [x] boundary ambiguous / source changed 时明确降级，不跨 source 猜测。
- [x] DB 新增只读 `requestId -> origin source/line + previous boundary + task` locator query。
- [x] repository 只通过 portable source key 绑定当前 source path；客户端不能传路径。
- [x] semantic projector 支持 message / assistant message / tool call / tool result / reasoning summary / context signal。
- [x] unknown record 不以 Raw JSON 回传 UI。
- [x] reasoning 只展示明确 summary；opaque/encrypted content 不解码、不推断。
- [x] bounded locator / slice / record / per-item / total-payload limits 已实现，任何截断均显式标记。
- [x] 新增 `GET /api/sessions/:sessionId/requests/:requestId/content` lazy read path。
- [x] request exists but source unavailable 返回可解释 unavailable state；request 不属于 session 返回 404。
- [x] endpoint 不触发 `selectSession()`、rollout replay、ownership rebuild、Timeline rebuild 或 Diagnostics recompute。

## Phase 25B：Request Inspector UI

- [x] Canonical Requests 表增加 `详情 / 查看` 入口。
- [x] 使用单一全局 Dialog，不为每个 Request 创建 modal DOM。
- [x] Dialog header 显示 Request time/model/effort/tier/usage/cache/cost/evidence。
- [x] 默认主体为可读 interaction timeline，不是 JSON viewer。
- [x] Message 使用角色化正文块。
- [x] Tool Call 使用通用 key/value Card。
- [x] Tool Result 使用状态 + 摘要 + 可折叠正文。
- [x] Reasoning summary 默认折叠；无公开摘要时只显示存在性。
- [x] Context/compaction 只展示有明确 evidence 的 signal。
- [x] UI 明确标注 `Rollout observed interaction`，不声称 Provider payload reconstructed。
- [x] loading / unavailable / partial / truncated / error 状态均有用户可读提示。
- [x] close/session switch/day switch 后清空当前正文 payload。
- [x] 不使用 localStorage/sessionStorage/IndexedDB 保存正文。
- [x] SSE 更新不关闭 Dialog、不破坏 focus/scroll/Request row identity。
- [x] Dialog close 后焦点回到触发按钮。
- [x] 1440×900 与 720×900 实际浏览器可用。
- [x] `prefers-reduced-motion` 继续成立。

## Evidence / Truthfulness Gate

- [x] UI/API 文档明确区分 Canonical Request、Observed Interaction Slice、Provider Wire Payload。
- [x] 不把 `origin_line_number` 之外的未知记录归属于当前 Request。
- [x] 不从 `inputTokens` 猜“历史 token / 新增 token”拆分。
- [x] 不从 output behavior 猜 system/developer prompt。
- [x] 不从 `call_id` 反推 model Request identity。
- [x] 不声称 rollout 是长期稳定公共格式；unsupported shape 有 coverage state。

## Privacy / Persistence Gate

- [x] SQLite schema 不新增 Prompt/Response/message/tool body 字段或 content cache table。
- [x] `PRAGMA user_version` 不因 V1 content inspector 改变。
- [x] server 不落盘缓存 Request Content。
- [x] server 不把 Request Content 写入普通日志/health/telemetry。
- [x] 浏览器正文只存在于当前打开 Dialog 的临时 state。
- [x] API response 不包含 absolute source path。
- [x] API 不接受 source/path/line/byte 参数。
- [x] `.codex` before/after manifest SHA-256 完全一致。

## Security Gate

- [x] 新 endpoint 只读 GET/HEAD，POST/PUT/PATCH/DELETE 不开放。
- [x] Strict Cookie / Host / Origin / loopback 边界继续生效。
- [x] `Cache-Control: no-store` 生效。
- [x] session/request ID 使用现有严格 validator。
- [x] Tool/message/result 全量 HTML escape。
- [x] Raw HTML / script / event handler / javascript URL fixture 不能执行。
- [x] 大 payload / malformed record 不导致无界内存或 server crash。
- [x] CSP 不新增 `unsafe-inline` / `unsafe-eval`。

## Accounting Regression Gate

- [x] canonical Request count 前后完全一致。
- [x] input/cached/cache-write/output/reasoning/total 六字段逐项完全一致。
- [x] `session_day_usage` 与 canonical accounting reconciliation 不变。
- [x] known calendar cost 与 estimated/partial/unavailable counts 不变。
- [x] Request identity/ownership/projection version/generation 不因打开 Inspector 改变。
- [x] Diagnostics finding identity/severity/policy 不因 Inspector 改变。

## API Gate

- [x] request content endpoint 不进入 Session/Day snapshot payload。
- [x] request content endpoint 不进入 SSE payload。
- [x] response shape 有固定 evidence/version contract。
- [x] unavailable source 与 unknown request 使用不同状态。
- [x] response truncation 明确返回 flag/count，不静默丢内容。
- [x] API.md 在实现完成后记录公开 contract 与 evidence limitation。

## Performance Gate

- [x] Locator 有 `12 MiB/侧 + 24 MiB 总预算`，Observed Interaction Slice 有独立 `4 MiB` hard limit，projector 另有 record/item/payload limits。
- [x] common Request warm read P95 `<100ms` 或记录经审查后的等价冻结门槛。
- [x] near-limit Request P95 `<250ms` 或记录经审查后的等价冻结门槛。
- [x] 打开 Inspector 不同步 replay rollout。
- [x] 大 Tool Result 不导致整个页面长期主线程阻塞。
- [x] close 后 DOM/JS 不继续保留历史 Request 正文集合。

## Browser / Interaction Gate

- [x] Request table 既有独立横向 scrollbar 与 5/10 pagination 不回归。
- [x] Diagnostics locator 仍能定位并持续高亮正确 Request。
- [x] collapsed Agent locator 自动展开行为不回归。
- [x] Inspector 从当前分页 Request 正确打开。
- [x] Inspector 打开时切换/重放 SSE，不替换 dialog root。
- [x] 关闭后焦点恢复到相同 Request 的查看按钮（仍存在时）。
- [x] 720px 下 Dialog 不产生不可达的底部/右侧操作区域。

## Automation / Test Gate

- [x] `test/request-content.test.js` 覆盖 boundary/projector/truncation/unsupported shape。
- [x] `test/database-server.test.js` 覆盖 locator + API + security + unavailable source。
- [x] `test/ui-security.test.js` 覆盖 no raw JSON / escape / dialog contract / no persistent content state。
- [x] `scripts/verify-live-ui.js` 覆盖真实 Request Inspector desktop/narrow/SSE/focus。
- [x] `scripts/audit-request-content.js` 只读审计 source/locator/slice coverage。
- [x] `npm test` Green。
- [x] `npm run check` Green。
- [x] `git diff --check` Green。

## Documentation Gate

- [x] `docs/API.md` 与实际 endpoint 一致。
- [x] `docs/ARCHITECTURE.md` 记录 ephemeral content projection seam。
- [x] `README.md` 只描述实际已实现的 Request Inspector。
- [x] `CHANGELOG.md` 只在用户可见功能交付后更新。
- [x] `docs/VERIFICATION.md` 只记录真实执行过的测试/benchmark/browser/hash evidence。
- [x] Delivery 状态只在以上实际 gate 完成后改为 `Implemented / Verified`。

## Delivered evidence（2026-09-02）

- 自动化：最终文档落盘后全量 `npm test`=`188 tests / 187 passed / 0 failed / 1 optional skipped`；唯一 optional skip 为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 同时 Green。
- 真实 Chrome/CDP：1440×900 Inspector 实际读取 `5` 个 semantic items，其中 `2` 个 Tool card、`1` 个 Reasoning card；Raw JSON label 不存在，`Provider Payload unavailable / not reconstructed` evidence 文案存在。SSE replay 保持同一 Dialog DOM 与正文，projection generation 变化显示 refresh；关闭后 payload 清空并把焦点恢复到同一 Request 的“查看”按钮。720×900 下 Dialog 实际边界 `left=8/right=712/top=8/bottom=892`，body `overflow-y=auto`。
- Coverage：`audit:request-content` 对 `30,201` canonical Requests 得到 source-present=`29,807`、source missing=`394`、boundary ambiguous=`0`；当前 bounded policy 可读=`29,801`，占 source-present `99.97987%`。6 条 oversized slice 显式 `content_truncated`；locator unreachable=`1` 且包含在这 6 条内，不额外扩大 unavailable 集合。
- 性能：最终 default production-equivalent warm benchmark common P50/P95=`0.990/1.683ms`、near-limit P50/P95=`1.042/1.538ms`；真实最重双-anchor fallback P50/P95=`54.820/63.370ms`；`3,865,074` bytes 可投影 slice P50/P95=`45.176/49.776ms`。boundary 可定位但 `5,699,680` bytes oversized slice P95=`12.683ms` 内直接 truncate；最大 `15,128,752` bytes slice P95=`32.146ms` 内 bounded truncate。所有样本源文件 SHA-256 前后不变。
- Accounting：前后均为 canonical/calendar `30,201 Requests`；input=`3,696,441,874`、cached=`3,486,715,356`、cache-write=`498,176`、output=`16,435,548`、reasoning=`5,980,151`、total=`3,712,877,422`；known calendar cost=`$2569.48648723`，estimated/partial/unavailable=`29,992 / 0 / 236`；projection version=`2`、generation=`8329` 前后不变。
- `.codex` read-only：前后均为 `450` rollout，combined manifest SHA-256=`8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`；benchmark 对 common/near-limit 单文件也分别确认 SHA-256 未改变。

## 明确不在 V1 交付范围

- [ ] Provider wire payload recorder。
- [ ] 完整 prompt serialization viewer。
- [ ] Raw JSON viewer。
- [ ] Request 正文持久化/全文搜索。
- [ ] 历史继承 token / 本轮新增 token 的猜测式拆分。
- [ ] reasoning chain-of-thought 解密或推断。

以上条目保持未勾选并不阻塞 V1；它们是显式排除项，而不是未完成缺陷。

