# ADR-0003：SQLite 仅持久化派生元数据

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

任务用量需要在监控器重启或原 rollout 删除后继续可见，但 prompt、response 和会话标题可能包含敏感内容。完整复制 rollout 会把本来位于 `.codex` 的正文扩散到新的长期数据库。

## Decision

SQLite 使用 WAL 和 schema/parser 版本，保存：

- sessions 的 ID、时间、来源、归档、CLI/parser 状态；持久化标题固定为空。
- agents 的线程关系、角色、路径和派生汇总。
- tasks 的 turn ID、序号、状态、质量、时间、模型、effort、baseline/end/delta 和来源定位。
- quota snapshots 与 ingest cursors。

禁止保存 prompt、response、消息正文、预览文本或会话标题。任务预览仅在已认证用户展开时，从已记录的来源位置按需读取，折叠空白并限制 120 字；不缓存、不落库。原日志不可用时直接报告不可用。

## Alternatives considered

- **复制完整 rollout：** 拒绝，内容扩散和保留风险过高。
- **持久化 120 字预览：** 拒绝，仍然永久复制潜在敏感正文。
- **完全不使用数据库：** 拒绝，无法在重启和原日志删除后保留任务用量。
- **只保存派生元数据并按需预览：** 采用，在可用性和内容最小化之间建立清晰边界。

## Consequences

- 删除原始 rollout 后，用量仍可查看但预览不可恢复。
- 后续解析使用幂等 merge 而非删除重建，并从全部持久化任务重算 agent 自身/后代汇总，避免一个 sibling 源消失时级联删除历史。
- 数据库可长期保留，仍应视为本地敏感元数据并由用户管理备份。
- schema migration 和导出功能必须继续证明不存在正文列。
- 会话列表标题只能来自当前只读 repository 内存索引，不得从 SQLite 恢复。
