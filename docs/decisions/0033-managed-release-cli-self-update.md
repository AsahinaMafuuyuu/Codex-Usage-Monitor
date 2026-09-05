# ADR-0033：Managed Release、CLI 与 GitHub Self-Update

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

Codex Usage Monitor 已经有 Git tag 和 release note，但目前仍以 Git checkout + `npm start` 为主要运行方式。应用版本散落在 package/documentation，server 同时承担 CLI main，且没有安全的 release update transaction。

用户希望后续只通过命令行即可查询版本、获得更新提示并从 GitHub Release 升级，同时保持发布过程可控、可回滚、不会破坏开发工作树或本地 `.codex` 数据。

该能力会新增第二类网络访问（GitHub Release）和新的本地写入面（managed install root），因此必须明确长期安全与版本契约。

## Decision

### 1. App Version 单一事实源

`package.json.version` 是唯一 App Version。Git tag、package-lock root version、release note 和 release manifest 必须在 Release Gate 中与其一致。

SQLite schema、projection version、pricing policy、diagnostics policy 继续独立版本化。

### 2. 独立 CLI entrypoint

建立 `bin/codex-usage-monitor.js -> src/cli.js`，`src/server.js` 只保留 `startApplication()` module 职责。

V1.2.0 用户 interface 固定包含：

```text
codex-usage-monitor
codex-usage-monitor start [--no-open]
codex-usage-monitor --version
codex-usage-monitor --help
codex-usage-monitor --update
codex-usage-monitor update --check
codex-usage-monitor rollback [--restore-data]
codex-usage-monitor doctor
```

`--version` 本地读取 package/update cache，不强制联网。

### 3. Development 与 Managed Install 分离

Git checkout / 普通解压目录视为 unmanaged。`--update` 和 rollback 不允许修改该目录，版本由 Git/开发者管理。

正式 self-update 只在显式 Managed Install 中启用。Managed Install 使用：

```text
%LOCALAPPDATA%\CodexUsageMonitor
```

作为稳定根目录，程序版本写入 `app/vX.Y.Z`，可写数据写入独立 `data/state/backups/downloads`，稳定 `.cmd` shim 通过 `state/current` 指向当前版本。

### 4. GitHub Release 是唯一 self-update source

固定 repository：

```text
AsahinaMafuuyuu/Codex-Usage-Monitor
```

Updater 不读取 Git remote、不接受任意自定义 release URL、不执行 `git pull/reset/checkout`。

stable updater 只消费已 Publish 的 stable Release，不消费 Draft/Prerelease。

### 5. Release 必须有 manifest + SHA-256

GitHub Release 提供外部 `release-manifest.json`，声明 version/tag/commit/runtime/storage/artifact size/SHA-256。

zip 内包含不带 archive hash 的 `build-manifest.json`。Updater 校验外部 manifest + artifact SHA，再校验 embedded build identity，避免循环 hash。

### 6. 更新采用 staging + atomic pointer switch

Updater 不原地覆盖当前程序目录：

```text
download -> hash -> staging extract -> offline self-check -> optional DB backup
-> immutable version dir -> atomic state/current switch
```

切换前任何失败都必须保持旧版可启动。正在运行的旧 server 不会被 updater 强杀；下一次启动使用新 pointer。

### 7. Rollback 必须兼容数据格式

版本目录存在不代表旧程序可以安全读取新数据库。

code-only rollback 只有在目标 release 声明可读取当前 `PRAGMA user_version` 且 storage compatibility epoch 相同时允许。

跨不兼容边界必须有 pre-update SQLite backup，并通过显式 `rollback --restore-data` 恢复。备份使用 Node `node:sqlite backup()`，不复制 live WAL/SHM 文件组合。

### 8. Installed data 与 source checkout 分离

Managed 默认 DB：

```text
%LOCALAPPDATA%\CodexUsageMonitor\data\usage.sqlite
```

Development 默认仍为 repo `data/usage.sqlite`。

既有 checkout 迁移到 Managed Install 使用 SQLite online backup，一次性复制、不删除源 DB，并做 accounting fingerprint verification。

### 9. GitHub 是第二个严格网络例外

除 ADR-0025 的 Codex Usage GET 外，允许 GitHub Release metadata/artifact 的 HTTPS GET/HEAD。

GitHub 请求不得携带 Codex token/account id、`.codex` 内容、工程路径、usage/session/request 数据或 telemetry identifier。

Release client 固定 owner/repo，30x redirect 必须手动验证 HTTPS + frozen host allowlist + redirect limit，不能自动跟随任意 Location。

代理 transport 可以与 Codex Usage 共享，但 credential/header builder 必须独立。

### 10. Release 自动化只生成 Draft

SemVer tag 触发 GitHub Actions：version consistency -> tests/check/diff -> runtime bundle -> manifest/hash -> clean-artifact self-test -> Draft Release。

workflow 不自动 bump version、不自动 commit/tag、不自动 Publish。维护者显式 Publish 是 stable channel 的最后人工 gate。

## Alternatives considered

### `git pull` 作为 `--update`

拒绝。Git worktree 可能 dirty、分支不同、存在本地改动；自动 pull/reset 会破坏开发状态，也无法形成可审计 artifact/integrity/rollback transaction。

### 原地覆盖安装目录

拒绝。Windows 正在运行文件、部分写入、更新中断都会增加不可恢复状态。版本目录 + pointer switch 更容易做到事务化。

### 每次 `--version` 联网查询 GitHub

拒绝。版本查询应当确定性、快速、可离线。实时检查由 `update --check` 提供，正常 managed start 只做低频后台 check。

### 更新时运行 `npm install`

拒绝。会让目标机额外依赖 npm registry、代理、lock 解析和第二次供应链下载。Release artifact 必须自包含 runtime dependencies。

### 仅保留旧 binary，不做 DB compatibility gate

拒绝。SQLite schema/projection 会演进，盲目 rollback 可能让旧 binary 读取或降写新格式，风险高于无法回退本身。

### 自动 Publish GitHub Release

拒绝。项目希望 release 可控；CI 只负责证明 artifact，stable 发布必须有显式维护者 gate。

## Consequences

- `src/server.js` 不再是命令行事实源，CLI/Server seam 更清晰、可独立测试。
- 正式安装会从 source checkout 数据布局迁移到 `%LOCALAPPDATA%` 稳定 mutable root。
- updater 获得 install root 内受限写权限，但不得写 `.codex`、任意项目目录或 Git checkout。
- 项目新增 GitHub Release 网络依赖；网络失败不得影响核心 monitor 启动。
- 每个正式 Release 都需要 runtime bundle、external manifest、embedded build manifest、SHA-256 与 clean-artifact test。
- rollback 变为“代码 + 数据兼容”的产品能力，而不是简单切 tag。
- 发布文档、package version、tag 与 artifact 身份必须保持一致，避免再次出现 README/package 版本漂移。

## Verification requirements

- dev checkout `--update` 对 worktree 零写入；
- `--version` 零 network/DB 初始化；
- hash/self-check/redirect/lock failure injection 不改变 current pointer；
- managed install successful update 原子切换且保留 previous；
- compatible/incompatible rollback gate；
- SQLite online backup/migration integrity；
- GitHub request header 不含 Codex credentials；
- clean release artifact 无 npm install 可运行；
- Draft Release 只有 test/check/build/verify 全 Green 才创建；
- canonical accounting 与 `.codex` source hashes 在 Phase 28 前后不变。
