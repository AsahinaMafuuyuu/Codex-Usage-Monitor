# ADR-0027：Advanced Usage Diagnostics 采用严格 Historical Robust Baseline

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

ADR-0026 已把 Phase 23 Usage Diagnostics 固定为 canonical Request 之上的独立、确定性 Local Baseline projection。Local Baseline 能解释“当前 Session 最近几次 Request 是否突然变化”，但无法判断当前 Request 或整个 Session 是否已经偏离同一工程长期历史。

直接把长期统计塞进 `src/diagnostics.js` 会混合两套不同生命周期：Local analyzer 是单 Session、短窗口、single-pass state；Historical analyzer 需要跨 Session cohort、时间 horizon、样本 cap、Median/MAD、Robust Z、Session Slice 与更严格的性能预算。将历史 finding 持久化到 `canonical_requests` 又会把易演化的诊断 policy 与稳定 accounting fact 耦合。

真实 shadow 进一步证明 Robust-Z 不能单独作为用户报警条件：大量 Request 在统计上偏离长期分布，但实际 effect 很小。生产 policy 必须同时要求 statistical significance 与 practical effect。

## Decision

- 新增独立深模块 `src/advanced-diagnostics.js`；Phase 23 `src/diagnostics.js` 和 `usage-diagnostics-v1` interface/threshold/finding identity 保持不变。
- Historical Request cohort 使用 exact `projectPath + recorded model + known effort`。unknown effort 不 fallback，不跨工程、不自动归并 model family；current Session 与 future fact 永不进入自己的 historical baseline。
- Request history 固定为最多 30 天、每 cohort 最近最多 200 个有效样本、最少 20 个样本。DB adapter 使用 bounded canonical query，不把 Project 全历史无界装入 Node。
- Robust baseline 使用 Median、MAD 与 `0.67448975 * (x - median) / MAD`。`MAD=0` 明确返回 `degenerate / robustZ=null`，不注入 epsilon、不改用 mean/stddev。
- Cost cohort 除 project/model/effort 外必须同 `serviceTier + pricing rateVersion`，且仅 `estimateRequestCost()` 的 `status=estimated` 样本可参与统计；Advanced Diagnostics 不维护第二份 rate card。
- Cross-session 按 `rootSessionId + projectPath + model + effort` 构造 Session Cohort Slice。每个 prior Session slice 只贡献一个历史样本；Cache 使用 `ΣcachedInput / Σinput`，避免按 Request 数量重复加权大 Session。
- Session history 固定为最多 60 天、每 cohort 最近最多 20 个 prior slice、最少 10 个 prior slice；current slice 至少 3 个 Request。
- `advanced-usage-diagnostics-v1` 冻结 Robust-Z warning/high 为 `3.5 / 5.0`，并继续叠加 practical-effect gate：Context warning `>=1.35x && +32,768`、high `>=2x && +65,536`；Cache warning/high drop `>=20pp / 40pp`；Cost warning `>=1.75x && +$0.05`、high `>=3x && +$0.05`。
- 上述阈值是在真实 `30,198` canonical Request shadow 上审查 threshold-adjacent 与 high-tail 样本后冻结。生产 finding 必须同时通过 statistical gate 与 practical-effect gate。
- Advanced Diagnostics 继续 compute-on-read，不新增 persisted finding/sample 表。常规 Session/SSE snapshot 不运行 historical analyzer；独立 lazy `GET /api/sessions/:id/advanced-diagnostics[?day=...]` 按需计算。
- Day scope 只过滤 current request-level finding 输出，不改变 historical baseline；Cross-session finding 只在 Session scope 返回。
- Historical finding 复用 canonical Request locator；Cross-session finding 使用 supporting Request locator 作为审计入口，但 supporting Request 不参与 finding identity。
- Phase 24A 保持 metadata-only、no-model-call、no-new-network、`.codex` read-only。任何 LLM root-cause explanation 必须另立 ADR，并与 deterministic finding 判定分离。

## Alternatives considered

- **直接扩展 `src/diagnostics.js`：** 拒绝。Local 与 Historical baseline 生命周期、查询方式和性能模型不同，会扩大 interface 并降低模块 locality。
- **平均值 + 标准差：** 拒绝。真实 Request/Cost 分布存在明显 heavy tail，Median/MAD 更抗极端值且可保持 deterministic。
- **只使用 Robust-Z：** 拒绝。Shadow 显示统计偏离数量远高于实际有意义的异常，必须叠加 practical-effect gate。
- **样本不足时扩大到其他 model/effort 或 60/90 天：** 拒绝。coverage 优先于猜测；不足时返回 `insufficientHistory`。
- **立即新增 persisted historical summary/finding 表：** 拒绝。优化后的 compute-on-read benchmark 已满足 common P95 `<200ms`、最大真实工程 Session P95 `<500ms`，没有 schema churn 的必要。
- **把 Advanced finding 放进普通 SSE snapshot：** 拒绝。跨历史扫描不是高频热路径，UI 使用 projection generation 标记 stale 后 lazy refetch。

## Consequences

- 用户可以同时区分 Local、Historical 与 Cross-session 三种异常来源，而 Phase 23 finding semantics 不变。
- Historical 结果可解释且可审计：每条 finding 保留 cohort、sample count、median、MAD、Robust-Z、effect 与 Request locator。
- 严格 cohort 会主动牺牲一部分 coverage；这是避免 model/effort/project 混合误报的设计取舍。
- Advanced analyzer 需要额外 SQLite historical query 和内存统计。实现通过 cohort 预索引与 baseline memoization 把最大真实工程 20 轮 warm P95 控制在约 `416ms`，仍需在数据规模显著增长后继续 benchmark。
- Phase 24B 的 Reasoning anomaly、Request burst、Subagent amplification、Budget/Notification 与 LLM explanation 不因本 ADR 自动获得批准，必须继续独立设计。
