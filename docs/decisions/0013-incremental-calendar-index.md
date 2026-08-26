# ADR-0013：用持久化日历索引替代 Timeline 全历史回放

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

ADR-0012 建立了正确的日期口径：所有已发现 root session 都必须按任务 `startedAt` 的监控器本地日期进入 `month -> day -> session`，用量仍只来自可审计的任务边界 `deltaUsage`。但其首版实现把日期账页作为纯内存缓存；缓存失效后会为所有 root session 新建 parser 并从头回放所有 rollout。

开发机实测为 267 个 root session、408 个 rollout、约 1.23 GB JSONL。旧实现首次 Timeline 构建约 16–24 秒，构建过程额外 RSS 峰值约 156 MiB；任意 rollout 追加又会使整份缓存失效。随着历史增长，这个成本与“当天只追加少量日志”的实际变化量无关。

与此同时，监控数据库已经持久化任务、可恢复 cursor 和任务边界 delta。重复读取 1.23 GB 原始 JSONL 来回答一个约 279 个 `session-day` 组合的查询，不再是合理的热路径。

## Decision

- SQLite 升级到 schema v7。`tasks` 在原 `delta_usage` JSON 之外增加六个 nullable INTEGER delta 字段，使高频聚合不必反复 `json_extract`。
- 新增 `session_day_usage` 物化表，以 `(day, root_session_id)` 为主键，保存六类 token、任务数、活动任务数和六类质量计数。月份不单独持久化，由日记录在查询时分组得到。
- `replaceSession()` 在同一事务中更新任务 ledger 后，只重建该 root session 的日记录。`derived_state` 保存建立日期索引时的本地时区；进程发现时区变化时，从已持久化任务重新生成日记录，而不是读取 rollout。
- `UsageMonitor` 维护 dirty root-session 集合。启动时使用当前 rollout 元数据与持久化 cursor 的 file size / mtime 判断哪些 session 需要同步；未导入 session 首次安全全量解析，可信 cursor 对 append-only 文件从原 byte offset tail，不可信 cursor 沿用 parser 的安全 replay 规则。
- `GET /api/timeline` 先同步 dirty session，再直接读取 `session_day_usage` 和少量 `started_at IS NULL` 任务；不再维护“任意更新即全局失效”的 Timeline 内存缓存。未变化的第二次请求不读取 rollout 内容。
- Timeline 的后台补齐不持久化各历史 rollout 中的全部 quota 记录；账号额度仍由现有 latest-quota 扫描和已选 session 实时路径维护，避免为了日期索引扩张 `quota_snapshots`。
- SQLite 明确使用约 2 MiB page cache（`cache_size=-2000`）、`mmap_size=0`、256 页 WAL auto-checkpoint，并限制 journal size 为 2 MiB；正常关闭时执行 `wal_checkpoint(TRUNCATE)`。不通过扩大 SQLite cache 换取 Timeline 性能。

## Alternatives considered

- **继续全量回放但增加并发：** 拒绝。可以降低一次冷构建墙钟时间，却仍然是 O(全部历史字节)，并放大磁盘读取和峰值内存；任意追加仍会重复历史工作。
- **每次直接从 `tasks.delta_usage` JSON 做 SQL 聚合：** 拒绝作为主方案。它避免 rollout I/O，但会重复 JSON 提取和日期分组；`session_day_usage` 只有数百行，物化成本更低且失效边界明确。
- **持久化 month/day/session 三层表：** 拒绝。month 和 day 总量可由 `session_day_usage` 线性聚合，额外层级会增加更新和一致性状态。
- **扩大 SQLite page cache 或启用较大 mmap：** 拒绝。当前热查询数据远小于几 MiB，性能瓶颈来自原始 rollout 重放而不是 SQLite cache miss。
- **只索引用户打开过的 session：** 拒绝。会破坏 ADR-0012 的账号级本地审计范围，无法回答某日全部可见 Codex 工作量。

## Consequences

- 第一次面对全新的监控数据库仍必须读取从未导入过的历史，这是建立持久化事实派生 ledger 的一次性成本；此后同一历史不会因打开“时间”视图而重复扫描。
- 最终实现对当前 267 session / 408 rollout 的全新临时数据库冷建立约 18.0 秒；随后无变化 Timeline 查询约 6.45 ms。已有索引、但本机仍有活跃追加时的一次重启同步实测为 13 个 dirty session、0 个 replay、49 个 cursor tail，约 36.6 ms，额外 RSS 峰值约 2.3 MiB。
- 完全无 dirty session 的热查询实测约 2.07 ms，采样期间未观察到额外 RSS/heap 峰值；旧全历史回放的约 156 MiB 热路径内存压力被移出常态查询。
- 在全新临时数据库中，2340 个 task、279 个 session-day 的主 SQLite 文件约 3.05 MiB；`session_day_usage` 连同两个索引约 72 KiB，tasks 表约 1.85 MiB。page cache 固定约 2 MiB，WAL 在测试写入阶段约 1.69 MiB，并在正常关闭时截断。
- 日期语义、质量计数和“本地可审计 delta 不等于 Codex 订阅账单”的产品契约保持 ADR-0012 不变；本 ADR 只替换其全历史回放和内存缓存实现策略。
