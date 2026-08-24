# 架构决策记录（ADR）

ADR 记录已经做出的、会约束后续实现的重要选择。`Accepted` 表示当前实现必须遵循；被替代时保留原文件并标记 `Superseded by ADR-NNNN`，不得删除历史。

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-read-only-rollout-observer.md) | Accepted | 使用本地只读 rollout observer |
| [0002](0002-cumulative-boundary-delta.md) | Accepted | 用累计快照边界差分做任务归因 |
| [0003](0003-metadata-only-persistence.md) | Accepted | SQLite 仅持久化派生元数据 |
| [0004](0004-loopback-session-security.md) | Accepted | 采用 loopback 和启动会话安全边界 |
| [0005](0005-file-observer-and-sse.md) | Accepted | 使用文件观察、轮询与 SSE 实时更新 |
| [0006](0006-node-builtins-and-vanilla-ui.md) | Accepted | 使用 Node 内置模块和无框架页面 |
| [0007](0007-versioned-api-equivalent-cost.md) | Accepted | 用版本化官方 API 价目估算任务、智能体和会话美元等值 |
| [0008](0008-project-directory-session-grouping.md) | Accepted | 按根会话工程目录分组并统一缓存命中率口径 |
| [0009](0009-editorial-lineage-interface.md) | Accepted | 使用编辑式账页、连续谱系轨和显式角色标签 |
| [0010](0010-typography-hierarchy.md) | Accepted | 建立实体、正文、辅助与机器数据分离的字体职责和可读字号层级 |

## 新增 ADR

文件名使用 `NNNN-short-name.md`。最少包含：

- `Status`
- `Date`
- `Context`
- `Decision`
- `Alternatives considered`
- `Consequences`

ADR 描述“为何作出选择”和长期后果，不替代具体实现文档或任务清单。格式变化、隐私、安全、API 或 schema 决策必须引用可复核的测试或官方证据。
