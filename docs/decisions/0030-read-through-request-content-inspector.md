# ADR-0030：Request Content 使用只读 read-through ephemeral projection

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Phase 18–24 已将 canonical Request 固定为 Token/Cost/Diagnostics 的业务事实，并在 `canonical_requests` 中保留 `origin_source_key + origin_line_number` 证据定位。当前 Request audit 可以说明一次 Request 的用量、价格与异常，但不能让用户理解该次模型交互中实际记录了哪些 message/tool interaction。

仓库同时有严格 privacy invariant：SQLite 不保存 Prompt、Response、消息正文；正文只能在已认证本地请求时从原始 rollout 按需读取。若直接把 Request content 写入 SQLite、塞进 Session snapshot 或做浏览器长期缓存，会破坏这一不变量，并让大上下文按 Request 数量成倍扩张。

另一个事实边界是：本地 rollout 是交互 evidence，不等于最终 Provider HTTP/Responses serialization。`token_count` 能形成稳定的 model usage accounting boundary，但不能证明完整 wire payload 的 system/developer/history 重组形式。

## Decision

- Request Content Inspector 采用 **read-through ephemeral projection**：通过 canonical `requestId` 查询 durable origin locator，再从当前 `.codex` rollout 只读读取目标范围，语义化后返回浏览器；不持久化正文。
- V1 内容单位正式命名为 **Observed Interaction Slice**，范围为上一条同 Task、同 source canonical Request `token_count` boundary 之后，到当前 Request origin `token_count` boundary 为止的可观察 rollout records。第一 Request 只在同-source Task start locator 可证明时使用 Task start 作为下界。
- `canonical_requests`、Request identity/ownership、Request-day、pricing、Diagnostics 保持不变；V1 不升级 SQLite schema/projection version。
- 新增独立深模块负责 boundary scan 与 semantic projection；HTTP/UI 不直接理解 rollout raw JSON shape。
- 新增精确只读 endpoint `GET /api/sessions/:sessionId/requests/:requestId/content`。客户端不能传 source path/key/line/byte；服务端必须从 canonical evidence 解析 locator，防止任意文件读取。
- Endpoint lazy only：不进入 Session/Day snapshot、Timeline、SSE、Diagnostics 热路径，也不维护 server content LRU。
- 浏览器只维护**当前打开的一个 Request** 的临时 payload；关闭 Dialog、切换 session/day 后清除。禁止 localStorage/sessionStorage/IndexedDB 正文持久化。
- UI 使用单一 Request Inspector Dialog，以 Message、Tool Call、Tool Result、Reasoning Summary、Context Signal 等语义 card 展示。Raw JSON viewer 不属于 V1。
- Tool/message/result 全部视为不可信文本，统一 escape；不执行 raw HTML、script 或 tool output 中的链接。
- Reasoning 只展示 rollout 中明确存在、可公开读取的 summary 文本；opaque/encrypted/no-summary reasoning 只显示存在性，不解密、不推断 chain-of-thought。
- UI/API 必须明确 `providerPayloadReconstructed=false`，不得把 Observed Interaction Slice 称为“完整 Provider Request”“完整 prompt”或 HTTP request body。
- `inputTokens/cachedInputTokens` 继续只作为 Request usage evidence；没有新的 provider serialization evidence 时，不拆分“历史继承 token / 本次新增 token”。
- Scanner 与 response 必须 bounded。超限必须显式 `truncated/partial`，不得通过无界读取追求表面“完整”。

## Alternatives considered

- **把 prompt/response/tool body 写入 SQLite：** 拒绝。违反 ADR-0003 metadata-only persistence，扩大敏感数据生命周期，也使数据库大小随正文快速增长。
- **把完整 Request content 放进 `/api/sessions/:id` 或 SSE：** 拒绝。大 payload 会破坏 Phase 18/19 已建立的 lazy Request audit 和 live UI 性能边界。
- **直接展示 rollout Raw JSON：** 拒绝。可读性差，把不稳定 wire shape 泄漏成长期 UI interface，同时提高 XSS/兼容成本。
- **按单条 user message 定义 Request：** 拒绝。一次 model Request 可能由 tool result 触发并输出 tool call，没有新的 user message；与现有 `token_count` accounting 不一致。
- **把一个完整 Task 当 Request 内容：** 拒绝。一个 Task 常包含多次 canonical Request，无法回答单次用量为什么发生。
- **宣称重建 Provider payload：** 拒绝。当前 rollout 缺少足以证明最终 provider serialization 的 evidence。
- **浏览器缓存最近 N 个 Request 正文：** V1 拒绝。会延长敏感内容驻留时间且容易产生不可见内存增长；第一版只保留当前 Dialog payload。

## Consequences

- 用户可以从 canonical Request 用量直接下钻到可读的本地交互证据，而无需阅读 JSONL。
- SQLite schema v15 / projection v2 与 accounting 保持稳定；Inspector 是 presentation-only read path。
- 内容可用性依赖原始 rollout 仍存在并能通过 portable source key 重新绑定。source missing 时 Request Usage/Cost 仍存在，但 content 明确 unavailable。
- UI 必须长期维护“Observed Interaction != Provider Payload”的证据标签，即使以后支持更多 record shape。
- 大 Tool Result/长 slice 需要显式 bounded/truncated UX；“完整展示一切”不是 V1 的正确性目标。
- 如果未来需要 Provider wire recorder、正文持久化、全文搜索或跨机器 content transport，必须新 ADR 重新评估 persistence、data egress、credential 与 threat model。

