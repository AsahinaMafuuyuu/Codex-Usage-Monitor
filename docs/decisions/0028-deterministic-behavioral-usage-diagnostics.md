# ADR-0028：Behavioral Usage Diagnostics 保持确定性、历史基线与只读运行时

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

ADR-0026/0027 已分别冻结 Local 与 Historical Robust Usage Diagnostics。剩余 Phase 24B 中最接近现有事实层的三个能力是 Reasoning Anomaly、Request Burst 与 Subagent Amplification。它们都可以只依赖 canonical Request、Task effort、Agent lineage 与时间戳完成，不需要读取 Prompt/Response，也不需要模型解释。

直接使用固定绝对阈值会产生明显误报：正式历史中绝大多数相邻 Request 间隔很短，单纯“短间隔”不能定义 Burst；多智能体 Session 的 descendant/root token ratio 本身也有明显长尾，`>1x` 不能被视为异常。Reasoning share 同样受 output denominator 影响，必须先排除过小输出，再与严格历史 cohort 比较。

## Decision

- 新增独立深模块 `src/behavioral-diagnostics.js`，不把 Behavioral detector 塞入 Phase 24A `advanced-diagnostics.js`。
- `behavioral-usage-diagnostics-v1` 只消费 canonical Request metadata、Task effort 与 Agent lineage；不读取或持久化 Prompt/Response，不调用模型，不新增外部网络。
- Reasoning Anomaly 使用 `reasoningOutputTokens / outputTokens`，仅在 `outputTokens >= 128` 时参与；historical cohort 严格为 exact `projectPath + model + known effort`，30 天、每 cohort 最多 200 个样本、最少 20 个样本。warning/high 继续要求 Robust-Z `>=3.5 / >=5`，并叠加 reasoning share 增长 `>=20pp / >=35pp` 与 reasoning token `>=512 / >=1024`。
- Request Burst 按 `rootSessionId + projectPath + model + effort` 构造 Session Cohort Slice，以 canonical Request 的最密集 60 秒滑动窗口作为 metric。120 秒 idle gap 只用于解释 episode 边界，不参与 Request 去重或 accounting。历史窗口 60 天、每 cohort 最近 20 个 prior slice、最少 10 个；current slice 至少 10 Requests。warning 要求 `Z>=3.5 && >=15 Requests/60s && >=1.5x historical median`；high 要求 `Z>=5 && >=30 Requests/60s && >=2x`。
- Subagent Amplification 使用同 Session canonical Request 按 Agent depth 切分 root 与 descendant，metric 为 descendant/root total-token ratio；只与 exact `projectPath` 的 prior multi-agent Session 比较，不跨工程 fallback。历史窗口 90 天、最近 20 个样本、最少 5 个。warning 要求 `Z>=3.5 && current ratio>=1.25 && >=2x historical median && descendant extra tokens>=5M && descendant Requests>=50`；high 要求 `Z>=5 && current ratio>=4 && >=2x historical median && extra>=5M && descendant Requests>=50`。
- `MAD=0` 继续返回 `degenerate / robustZ=null`，不使用 epsilon/mean/stddev fallback。
- Day scope 只返回 request-level Reasoning finding；Burst 与 Amplification 只属于 Session scope。
- Behavioral finding 使用独立 deterministic identity。Request-level finding locator 与 Session-level supporting locator 都必须使用 Task-scoped `requestOrdinalInScope`，复用现有 Canonical Request drawer。
- 常规 Session/SSE snapshot 不运行 Behavioral analyzer；公开接口为独立 lazy `GET /api/sessions/:id/behavioral-diagnostics[?day=...]`。
- 生产阈值在正式 `30,198` canonical Requests shadow 上冻结。最终 shadow 为 `26` findings（约 `0.09 / 100 Requests`）：Reasoning `24`、Burst `1`、Subagent Amplification `1`。
- Behavioral analyzer 使用 historical cohort pre-index、binary range lookup 与 baseline memoization，保持 compute-on-read。20 轮 warm benchmark 最终 common P95 `85.607ms`，最大真实工程最新 Session P95 `381.353ms`。
- Budget/Notification 与 LLM Root-Cause Explanation 不由本 ADR 批准。前者需要新的本地写状态/ack 安全契约；后者会突破 no-model-call/no-new-network 边界，必须独立 ADR 与 explicit opt-in/data-egress 设计。

## Alternatives considered

- **只用绝对 reasoning token：** 拒绝。不同模型/effort/output 长度不可直接比较，必须同时使用 denominator、historical cohort 与 absolute effect。
- **Burst 直接看相邻 Request gap：** 拒绝。正式历史中短间隔是常态，会把正常 tool/model loop 当异常。
- **Burst 直接用整个 Session requests/minute：** 拒绝。长 idle 会稀释局部高密度阶段；采用最密集 60 秒窗口更可审计。
- **Subagent ratio `>1x` 即报警：** 拒绝。多智能体并行探索天然可能高于 root；必须结合工程历史、Robust-Z 和绝对 descendant work。
- **样本不足时跨工程或跨 model/effort：** 拒绝。coverage 不足优先于错误扩大 cohort。
- **把 Behavioral finding 放进 SSE：** 拒绝。历史比较不是高频热路径，继续使用 lazy GET + projection generation stale 语义。

## Consequences

- 用户可以把“上下文/缓存/费用异常”与“推理占比、请求密度、子智能体放大”分开理解，不改变 Phase 23/24A finding semantics。
- Behavioral finding 仍然只是异常信号，不声称模型“思考错误”、agent“浪费”或业务根因已经确定。
- exact-project Amplification history 会主动牺牲一部分 coverage；历史不足时返回 coverage，不自动 broaden。
- compute-on-read 增加额外 historical query，但当前实测仍满足 `<200ms common / <500ms largest real project` 性能 Gate。
- 任何需要 acknowledgement、notification persistence、外部通知或 LLM explanation 的能力都需要新的安全/隐私决策，不能通过 Behavioral policy flag 偷渡。
