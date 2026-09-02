# ADR-0029：Budget / Notification 使用本地 operational state 与窄范围写 API

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

ADR-0026/0027/0028 保持 Usage Diagnostics 的事实层和诊断层只读、deterministic。Phase 24B2 的 Budget / Notification 需要 acknowledgement、snooze/cooldown 和用户显式预算配置；这些状态不能从 `.codex` 推导，也不能塞进 canonical Request accounting。

仓库此前把 GET/HEAD-only HTTP 作为安全边界。若要让本地用户保存预算与 Ack，必须显式缩小新的写入面，并确保写入只落在监控器自身 SQLite operational tables，不改 `.codex`、Request Ledger、pricing evidence 或 session projection。

## Decision

- Budget/Notification 只实现 **in-app notification center**；不发送系统通知、邮件、Webhook 或任何外部网络请求。
- schema 升级为 v15，仅新增两个 operational metadata table：工程级 `diagnostic_alert_policies` 与 Session-scoped `diagnostic_alert_acknowledgements`。它们不参与 canonical Request、Token、Cost、Timeline 或 pricing projection。
- Policy 由服务器通过 `sessionId` 解析工程；客户端不能提交任意 `projectPath`。工程级配置包括：
  - `sessionCostBudgetUsd`：Subscription Standard-Rate Equivalent 的 Session ceiling；`null` 表示关闭，且只能对 `costEstimate.status=estimated` 判断超限。
  - `minimumSeverity`：`warning` 或 `high`，默认 `high`。
  - `cooldownMinutes`：Snooze 时长，范围 `5..1440`，默认 `60`。
  - `snoozedUntil`：由专用 snooze action 生成，不能由客户端写任意时间戳。
- Notification 是 compute-on-read：合并 Local/Historical/Cross-session/Behavioral frozen findings，再按 severity filter；Budget alert 从当前 cached Session snapshot 的 `summary.costEstimate` 派生。GET 本身不写 SQLite。
- Finding alert ID 基于 deterministic finding ID；Budget alert ID 基于 `rootSessionId + pricing policy version + budget value`。Ack 只隐藏同一 deterministic alert；预算值改变会生成新 ID，不会被旧 Ack 错误吞掉。
- Ack 仅写 `(rootSessionId, alertId, acknowledgedAt)`；不持久化 finding body、Prompt/Response 或 token payload。Snooze 只更新工程 policy 的 `snoozedUntil`。
- 新增的 POST 仅允许三类受认证 loopback API：更新当前 Session 所属工程的 alert policy、ack 当前 Session 中实际存在的 alert、按 policy cooldown snooze。其它 POST 仍返回 `405`。
- POST 继续受一次性 Cookie、Host/Origin、SameSite=Strict 与 CSP 边界保护；只接受 `application/json`，body 有严格大小限制和字段校验。不得增加通用文件写入或任意 SQL 参数入口。
- Budget UI 必须始终标注“Subscription Standard-Rate Equivalent / 等值预算”，不得称为 Plus 实际扣费或从账号 Usage 百分比换算。
- 常规 SSE 不计算 alerts；Notifications 与 Diagnostics panel 一样 lazy 获取。projection generation 变化后只标记 stale/按需刷新，不把历史诊断塞进 SSE 热路径。

## Alternatives considered

- **浏览器 localStorage：** 拒绝作为主状态。无法跨浏览器 profile 保持 Ack/预算，也无法由服务端统一校验 alert identity。
- **GET 请求顺便写“已见”状态：** 拒绝。读接口必须保持无副作用，GET 只 compute-on-read。
- **把预算/Ack 写入 canonical_requests 或 derived_state：** 拒绝。operational preference 与 business fact 生命周期不同，会污染 accounting/projection 语义。
- **默认给出固定美元预算：** 拒绝。用户未配置时 budget 必须关闭；不得假设 Plus 实际消费阈值。
- **外部通知/Webhook：** 本阶段拒绝。会引入新的 data-egress/credential/network 威胁模型，需要另一份 ADR。

## Consequences

- HTTP 不再是绝对 GET/HEAD-only，而是“GET/HEAD + 三个精确 allowlisted local POST mutation”；安全测试必须锁住 allowlist、Origin、Cookie、JSON schema 和 body limit。
- SQLite schema 从 v14 升为 v15，但 canonical accounting/projection 版本保持不变；迁移只创建 operational tables，不触发 `.codex` replay。
- 用户可以持久化工程级等值预算、severity filter、Ack 与 Snooze，而 deterministic finding 本身仍由原 analyzer 计算，不被 operational state 改写。
- Budget/Notification 仍无外部推送；如果后续增加系统通知、邮件或 Webhook，必须新 ADR。
- LLM Root-Cause Explanation 不由本 ADR 批准。
