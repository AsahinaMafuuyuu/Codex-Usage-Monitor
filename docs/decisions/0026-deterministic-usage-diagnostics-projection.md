# ADR-0026：Usage 异常诊断采用独立确定性 Projection

- **Status:** Accepted
- **Date:** 2026-09-01

## Context

当前系统已经建立 verified Request Ledger、canonical Request ownership、request-day projection 和 request-level pricing。用户下一阶段需要的不只是“用了多少”，还需要定位 Context 膨胀、Cache 命中率骤降、单 Request 成本突增以及长上下文触发点。

如果直接把“异常”字段写进 `canonical_requests`，会把稳定 accounting fact 与频繁迭代的诊断 policy 耦合；如果在前端临时计算，又会造成阈值散落、不同页面口径不一致且难以测试。调用 LLM 解释异常还会引入新用量、隐私和非确定性问题。

## Decision

- Usage Diagnostics 作为 `canonical_requests` 之上的独立派生 projection/module，不修改 Request Ledger classification、ownership、Token 或 Cost accounting。
- V1 只消费 canonical Request；raw/inherited evidence 只继续用于现有 provenance/reconciliation，不重复生成业务 finding。
- V1 使用确定性 Local Baseline 和显式规则，首批 detector 为 Context Inflation、Cache Regression/Breakpoint、Cost Spike、Long Context Trigger。
- Cost Spike 与 Long Context 的 pricing evidence 复用现有 request-level pricing module；Diagnostics 不维护第二份 rate card 或 multiplier policy。
- Diagnostics 不读取/持久化 Prompt、Response 或消息正文，不调用模型，也不增加任何网络访问。
- V1 不新增 SQLite schema；按需从 cached canonical projection 计算，并通过 `usage-diagnostics-v1` policy version 保证规则可审计。只有真实历史证明稳定且成为明确热路径后，才允许增加可重建的 persisted diagnostics projection。
- 同一 canonical Request 在相同 diagnostics policy 下必须 scope-invariant：Day scope 可以读取 dayStart 前的可比较 Request 建立 baseline，只过滤 finding 输出范围，不在午夜重置 baseline。
- 完整 finding 和 diagnostics summary 均不进入常规 Session/SSE snapshot；V1 compute-on-read 统一使用 lazy read endpoint，避免把 diagnostics analyzer 带入 SSE 热路径。
- Cost Spike V1 只把 `estimated` pricing result 当成可比较完整金额；`partial/unavailable` 只能作为 evidence，不能产生伪精确 spike。
- Long Context feature policy 继续由 pricing module 单点拥有；Diagnostics 只消费 pricing 暴露的 candidate/status evidence，不复制 272K 阈值实现。
- Analyzer 使用 single-pass rolling state，保持随 canonical Request 数量线性增长；不得按 Request 反复扫描全历史。
- finding locator 必须能复用现有 Canonical Request 分页和 Task drawer 精确定位 requestId，不建设第二套 Request viewer。
- 算法集中在独立 `src/diagnostics.js` 深模块；`database.js` 只负责读取 facts，前端只负责渲染结构化 finding。

## Alternatives considered

- **把异常状态写入 `canonical_requests`：** 拒绝。会把解释 policy 与 accounting fact 混合，增加 migration/rebuild 风险。
- **只在前端计算：** 拒绝。阈值与基线算法会散落到展示层，难以复用、测试和版本化。
- **第一版直接使用全项目 MAD / ML anomaly detection：** 拒绝。cohort、样本量、模型/effort/service tier 混合问题尚未通过真实历史验证；V1 先锁定局部可解释诊断。
- **调用 LLM 读取 Prompt/Response 做根因分析：** 拒绝。会破坏 metadata-only / no-model-call 边界，并产生不可重复结论和额外使用成本。
- **立即新增 `diagnostic_findings` 持久化表：** 拒绝。V1 policy 仍需 shadow validation，先 compute-on-read 能降低 schema churn。

## Consequences

- Diagnostics policy 可以独立演化、版本化或整体重建，不影响 Token/Cost 历史事实。
- V1 能精确定位“从哪个 canonical Request 开始异常”，但在没有正文 evidence 时不会声称具体 Prompt 根因。
- 初期 diagnostics query 需要对一个 Session 的 canonical Request 做线性内存分析；必须通过 SQL 定向读取和 benchmark 控制成本。
- Historical cohort / MAD / Subagent amplification 等能力需要后续 ADR/设计扩展，不能通过在 V1 中悄悄改变 baseline 语义加入。
