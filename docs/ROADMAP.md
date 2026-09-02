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
