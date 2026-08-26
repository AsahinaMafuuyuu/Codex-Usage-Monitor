# ADR-0014：用 Codex 相对 source key 实现 Windows 路径重绑定

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

schema v7 已经把历史任务、cursor 和日期索引持久化，因此同一台机器重启后可以直接从 byte offset 增量续读。但 rollout 身份仍由 `C:\Users\<name>\.codex\...` 这类绝对路径承担，`sessions.rollout_path`、`agents.rollout_path`、`tasks.source_path`、`quota_snapshots.source_path` 和 `ingest_cursors.path` 都会把数据库绑定到原 Windows 用户名与盘符。

这会导致一个本应只改变 locator 的迁移——例如把 `.codex` 从 `C:\Users\OldUser\.codex` 搬到 `D:\Profiles\NewUser\.codex`——被误判成一批全新的源文件。统计数据不会因此丢失，但 cursor 无法无缝续读，按需 preview 也会继续尝试旧路径。

项目自身的数据库默认已经位于 `<project>\data\usage.sqlite`，因此工程目录跨盘移动并不是 SQLite 的问题；需要解耦的是“持久化源身份”和“当前机器上的绝对文件位置”。

## Decision

- SQLite 升级到 schema v8。持久化 rollout 身份统一使用以 `.codex` 为逻辑根的 canonical source key，例如 `sessions/2026/08/25/rollout-xxx.jsonl` 或 `archived_sessions/rollout-xxx.jsonl`，分隔符固定为 `/`。
- `ingest_cursors` 改以 `source_key` 为主键；sessions/agents 使用 `rollout_key`，tasks/quota 使用 `source_key`。绝对 `rollout_path` / `source_path` 旧列只作为兼容迁移壳，迁移后置空，不再承担 durable identity。
- `CodexRepository` 在运行时同时持有当前绝对 path 和稳定 source key。文件 I/O 始终使用当前绝对 path；SQLite 只接收 source key。这样 locator 变化不会改变文件身份。
- v7 及更早数据库迁移时，从旧绝对路径中只接受能够确定恢复为 `sessions/.../rollout-*.jsonl` 或 `archived_sessions/.../rollout-*.jsonl` 的 locator。无法安全恢复的旧 cursor 被丢弃并在需要时走既有 replay，而不是猜测路径。
- quota payload 同步移除旧 `sourcePath`，只保留 portable `sourceKey`，避免绝对 `.codex` 路径继续藏在 JSON 中。
- 启动时 Codex home 的优先级为：显式 `startApplication({ codexHome })`；有效的 `CODEX_MONITOR_HOME`；当前 Windows 用户的 `.codex`。若环境变量仍指向旧机器且不存在，程序自动回退到当前用户 `.codex` 并输出 warning。非标准 Codex 目录仍可显式配置，不进行全盘扫描。
- 默认监控数据库始终从源码所在项目根解析为 `<project>\data\usage.sqlite`，不依赖进程当前工作目录。相对 `CODEX_MONITOR_DB` 也以项目根解析；用户环境变量若指向工程外绝对路径，CLI 回退项目默认数据库并给出 warning，避免旧盘符配置破坏目录级迁移。程序化 `startApplication({ databasePath })` 仍保留临时测试/嵌入式注入能力。
- task preview 不再信任 SQLite 中的绝对路径，而是把任务 `sourceKey` 绑定到当前 `CODEX_MONITOR_HOME` 后再读取原 rollout。
- `project_path` 不属于 source locator。它是根 session 当时记录的 `cwd` 审计/分组元数据，可以保留旧机器的历史绝对目录，但不得用于寻找 rollout、cursor 恢复或文件访问。

## Alternatives considered

- **继续持久化绝对路径并在迁移时字符串替换用户目录：** 拒绝。旧根目录不一定只是用户名变化，还可能换盘、换自定义 Codex home；字符串重写容易误伤历史工程路径并把机器细节重新写回身份层。
- **以 thread/session ID 作为唯一文件 cursor key：** 拒绝。一个 root session 可有多个 rollout/子线程文件，cursor 需要稳定区分具体源文件；相对 source key 与当前 Codex 目录结构直接对应。
- **启动时扫描所有 Windows 盘符寻找 `.codex`：** 拒绝。代价、隐私边界和歧义都不合理；标准当前用户路径可以自动发现，非标准路径必须显式指定。
- **迁移时无条件信任旧 byte offset，不做文件校验：** 拒绝。路径可移植性不能削弱现有 size/mtime/usage-state 验证；无法证明是同一 append-only 文件时仍安全 replay。
- **把 SQLite 移到用户 AppData：** 拒绝当前需求。项目目标是目录级可携带，默认把数据库随工程放在 `data/` 更容易整体备份和迁移。

## Consequences

- 将工程目录、`data\usage.sqlite` 和同一份 `.codex` 历史搬到另一 Windows 用户目录或盘符后，数据库可直接绑定新 Codex home；仅路径变化不会触发 rollout 全历史 replay。
- relocation 回归验证同一 rollout 从旧 Codex home 移到新绝对根后恢复为 `1 restored / 0 replayed`，并且 task preview 从新路径正常读取。
- 文件大小、mtime、cursor offset 或累计 usage 状态不可信时，仍沿用既有线程级 replay；“可移植”不等于绕过完整性校验。
- 首次使用全新数据库仍需要一次性建立历史 task/cursor ledger；此后只发现元数据、新文件和变化字节。source key 改造不取消首次 backfill。
- 当前正式支持范围仍是 Windows。source key 本身使用平台中立分隔符，但其他启动、watch 和产品验证尚未承诺 macOS/Linux 行为。
