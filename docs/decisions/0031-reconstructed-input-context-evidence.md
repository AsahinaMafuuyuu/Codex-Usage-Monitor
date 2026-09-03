# ADR-0031：Reconstructed Input Context 使用分层 evidence，不冒充 Provider Input

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Phase 25 已通过 ADR-0030 建立 Request Content read-through：canonical Request 的 `token_count` origin 可以定位单次 Observed Interaction Slice，但该 slice 不是完整 Provider request body。

真实 UI 使用暴露出新的需求：Request accounting 可能显示二十万以上 Input Tokens 与很高 Cached Input，但当前 slice 只直接出现一条短 User message。用户需要理解“这次 Request 之前有哪些可观察历史上下文”，否则 Input/Cached 数字缺乏可读解释。

本地 rollout 能提供大量历史 message/tool/context record，并可能提供显式 compaction replacement snapshot；同一个 thread 还可能跨多个 rollout source。与此同时，当前证据仍不足以证明最终 Provider SDK/Responses API 的完整 system/developer/history 序列、最终 serialization 顺序、每个 item 的 exact token attribution，以及所有 harness/provider 注入字段。

如果把历史 rollout 简单拼接后命名为“Request Input”或“Provider Prompt”，会把 reconstruction 冒充 wire evidence；如果完全拒绝历史重建，又无法满足开发者调试 context/cache 的核心需求。

## Decision

- 新能力正式命名为 **Reconstructed Input Context / 重建输入上下文**。
- Phase 26 的 reconstruction 只使用当前 `rootSessionId + threadId` 上可证明的 rollout history、明确 compaction snapshot、runtime context 和当前 Request 的 pre-model evidence；V1 不跨 sibling/parent/child thread 猜正文。
- 当前 Request 的重建 cut 定义为当前 Observed Interaction Slice 中**第一条明确可观察 model-output evidence 之前**。该 cut 只表示 rollout event order，禁止称为 Provider request start。
- Public evidence 必须分层标记：`direct_current`、`historical_rollout`、`compaction_snapshot`、`runtime_context`、`coverage_gap`。
- Public response 必须同时表达 rollout history reconstruction coverage 与 Provider serialization unknown。即使所有可观察历史都读完，也必须保持 `providerPayloadReconstructed=false` / `providerSerializationKnown=false`。
- 显式 compaction replacement snapshot 可以作为 reconstruction evidence，但必须经过 semantic projector，并标为 `compaction_snapshot`；不得 Raw JSON dump，不得声称 Provider 原样收到 replacement JSON。
- 若仅观测到 compaction signal 而没有可读 replacement snapshot，则形成 `coverage_gap`；不得假设 compaction 前全部历史仍 retained。
- Official `inputTokens/cachedInputTokens` 只作为 Request accounting 对照。没有官方 attribution evidence 时，不把 token 分配到 reconstructed item，不从差值反推“新增正文 token”。
- Reconstructed Input Context 采用 lazy、bounded、ephemeral read-through，不写 SQLite、日志、browser persistence，也不进入 Session/Day snapshot、Timeline、SSE 或 Diagnostics hot path。
- 客户端只能提交 canonical session/request identity，不能提交 source path/key/line/byte。任何 pagination/continuation 若未来需要，只允许 server-generated opaque cursor。
- Exact Provider Request Capture、正文持久化、全文搜索、item-level exact token attribution 需要独立后续决策，不属于 Phase 26 V1。

## Alternatives considered

- **把 Input Tokens 当作完整正文大小并按差值拆分 history/current：** 拒绝。token accounting 无法证明 item attribution，cached token 更不能直接映射到某段历史正文。
- **从 thread 文件头简单拼接所有 message/tool record：** 拒绝。忽略 compaction、source gap 和当前 Request output cut，会把已被替换/本轮输出内容错误算进 Input。
- **把 `compacted.replacement_history` 直接当 Provider prompt：** 拒绝。它是强 reconstruction evidence，但不是已证明的 wire serialization。
- **只展示当前 User message：** 拒绝。虽然最保守，但无法解释大 Input/Cached context，也不满足开发者调试需求。
- **捕获/代理 Codex 网络请求：** Phase 26 拒绝。当前监控器是旁路 read-only 工具；网络 hook/proxy 会扩大侵入面、credential/threat model，若未来需要应单独 ADR。
- **把 reconstructed context 持久化以加速打开：** 拒绝。违反 metadata-only persistence，并把敏感正文生命周期从源 rollout 扩大到第二份数据库/缓存。

## Consequences

- 用户可以读取一个比单 Request slice 更接近“模型上下文视角”的可解释历史视图，同时清楚知道每项 evidence 从哪里来。
- 产品必须长期显示 `Reconstructed` 与 provider disclaimer，不能为了 UI 简洁省略证据标签。
- Phase 26 实现复杂度主要集中在 multi-source continuity、compaction state machine、bounded history 与 provenance，而不是 token accounting。
- source missing、compaction snapshot missing、unsupported history shape 会产生明确 partial coverage；“不完整”是合法结果，不通过无界扫描/猜测填平。
- 未来 Context Delta / Cache Explanation 可以消费该 reconstruction projection，但必须保持“context facts”和“cache root-cause inference”分离。
- 如果未来出现官方稳定 Provider serialization evidence，可以新增更高 evidence level 或新的 Exact Provider Request capability，但不能静默把现有 reconstructed contract 改名为 exact。

