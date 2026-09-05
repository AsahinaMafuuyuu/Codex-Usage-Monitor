# Phase 23：Usage Diagnostics 交付契约

**状态：** Implemented / Verified
**日期：** 2026-09-01

## 交付目标

Phase 23 完成后，Codex Usage Monitor 在保持现有只读、metadata-only、Request Ledger accounting 边界的同时，应能针对 canonical Request 给出可解释的 Usage 异常诊断，并能够从 finding 精确定位到 Task / Request 审计事实。

设计事实源：

- [Usage Diagnostics 设计方案](DESIGN-USAGE-DIAGNOSTICS.md)
- [Usage Diagnostics 技术实现文档](TECHNICAL-IMPLEMENTATION-USAGE-DIAGNOSTICS.md)
- [ADR-0026](decisions/0026-deterministic-usage-diagnostics-projection.md)

## V1 交付范围

- [x] Context Inflation。
- [x] Cache Regression。
- [x] Cache Breakpoint 首次显著下降定位。
- [x] Cost Spike。
- [x] Long Context Trigger / pricing evidence 展示。
- [x] Session / Day lazy Diagnostics API。
- [x] Session diagnostics summary。
- [x] Finding 列表和定位 Canonical Request 的 UI。
- [x] Policy version / baseline evidence / severity 结构化输出。

## 明确不在 V1

- Historical project/model/effort cohort；
- Median + MAD / robust Z-score production rule；
- Reasoning-heavy；
- Request burst；
- Subagent amplification；
- 跨 Session regression comparison；
- 自动通知、额度预测、Budget；
- AI/LLM 根因分析。

## Accounting / Privacy 验收

- [x] `canonical_requests` 仍是唯一诊断计量输入，不修改 Request ownership 或 classification。
- [x] Diagnostics 不重新计量 inherited copied history。
- [x] Request / Task / Session / Timeline Token 在 Phase 23 前后逐字段一致。
- [x] request cost 继续唯一来自现有 pricing module；Diagnostics 不复制 rate card。
- [x] `.codex` before/after SHA-256 完全不变。
- [x] SQLite / API 不新增 Prompt、Response、消息正文、credentials 持久化。
- [x] 不新增模型调用或网络通道。

## Diagnostic Correctness 验收

- [x] baseline 只使用当前 Request 之前的可比较样本，不使用未来数据。
- [x] Day scope 不在午夜重置 baseline；同一 Request / policy 在 Session 与 Day scope 下得到相同 metric、baseline 和 severity。
- [x] baseline sample 不足时不误报。
- [x] Context Inflation 同时经过 relative + absolute gate。
- [x] Cache Regression 使用 percentage-point drop，并过滤小 Input Request 噪声。
- [x] Cache Breakpoint 可定位第一个显著下降的 canonical Request。
- [x] Cost Spike 只允许 `estimated` request cost 参与 current warning/high 与 baseline；`partial/unavailable` 不产生伪精确 spike。
- [x] Long Context finding 只消费 pricing module 暴露的 candidate/status evidence；Diagnostics 不维护第二份 272K feature policy。
- [x] 每条 finding 都含 request locator、metric、baseline/evidence、policy version。

## API / 性能验收

- [x] `GET /api/sessions/:id/diagnostics` 可读取完整 Session scope。
- [x] `?day=YYYY-MM-DD` 与现有 canonical Request day semantics 完全一致。
- [x] Diagnostics 请求不触发同步 rollout replay。
- [x] 初始 Session/SSE payload 不包含 finding detail 或 diagnostics summary，且常规 SSE 更新不执行 diagnostics analyzer。
- [x] diagnostics fact query 无 Task/Request N+1 SQL。
- [x] analyzer 为 single-pass rolling state，不存在每 Request 全历史回扫导致的 O(N²) 路径。
- [x] 常规 warm diagnostics API P95 目标 `<150ms`，真实大 Session 单独记录 benchmark。

## UI 验收

- [x] Session overview 有低噪声 High / Warning summary。
- [x] Finding 按 severity / time 可扫描展示。
- [x] finding 可以精确定位现有 Task / Canonical Request audit detail。
- [x] finding locator 能跨 Canonical Request 分页自动打开正确页并定位 `requestId`。
- [x] Request 表只增加轻量状态提示，不破坏现有审计和滚动层级。
- [x] 1440×900 与 720×900 可用。
- [x] SSE 后 Diagnostics panel、Task expansion、Request drawer、focus、scroll 和 visual anchor 保持稳定。
- [x] reduced-motion 契约继续成立。

## 测试交付门槛

- [x] 新增独立 `test/diagnostics.test.js`。
- [x] DB/API regression Green。
- [x] UI static/security contract Green。
- [x] `npm test` Green（允许既有 optional real fixture skip）。
- [x] `npm run check` Green。
- [x] `git diff --check` Green。
- [x] 真实历史 shadow diagnostics report 已记录 finding 分布和阈值审查结论。
- [x] 真实 Request/Token/Cost reconciliation 前后无变化。
- [x] 真实 rollout hash 无变化。

## 交付状态切换规则

本轮已经满足以下条件，因此状态切换为 `Implemented / Verified`：

1. 四类 V1 detector 全部实现；
2. policy 已通过 deterministic fixture 与真实 shadow report；
3. API / UI 完成并通过性能、浏览器与安全回归；
4. accounting reconciliation 与源文件 hash 均证明无副作用；
5. `docs/VERIFICATION.md` 记录实际执行结果，不把未执行检查写成已通过。

## Phase 23 实际交付证据

- 自动化：实现完成后的全量回归为 `153 tests / 152 passed / 0 failed / 1 optional skipped`；唯一 skip 仍是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 均通过。
- Shadow：正式 SQLite 上分析 `245` 个 session / `30,201` canonical Request，得到 `4,068` findings，等于 `13.47 findings / 100 requests`；唯一受影响 Request 为 `3,048`，即 `10.09 / 100 requests`。分类为 Cache Regression `1,361`、Context Inflation `280`、Cost Spike `1,856`、Long Context Trigger `571`。幅度分布显示触发项整体并非贴阈值噪声，因此保留 `usage-diagnostics-v1` 当前 policy。
- 性能：真实 HTTP warm benchmark 的常规 `70` Request session P95=`6.206ms`；正式库最大 `1,464` Request session（`225` findings、payload `259,186` bytes）P95=`80.049ms`、max=`108.368ms`，均低于 `<150ms` 目标。
- 浏览器：Chrome/CDP 1440×900 与 720×900 通过。真实 finding 从 panel 定位到 scope 内第 `25` 个 Request，自动跨分页打开正确 canonical `requestId`，marker/highlight 生效；SSE replay 后 Diagnostics panel、Request drawer 与目标 Request 保持。普通 SSE snapshot 明确不携带 `diagnostics` / `diagnosticSummary`。
- Accounting：交付前后正式库均为 `30,201` canonical Request、`3,712,877,422` total tokens；六类 token 与 `Σ session_day_usage` 逐字段相同，known calendar cost 均为 `$2569.48648723`，projection v2 / generation `7888` 未变化。
- Source read-only：交付前后均发现 `450` 个真实 rollout，combined manifest SHA-256 都是 `8d535514aef5b8dff3fa532afeb01922fc2e9e46941bf52d5899fc3cf0a02fee`。
