# Phase 28：Release & CLI Management 设计说明

- **状态：** Implemented / Verified
- **设计日期：** 2026-09-04
- **实施验证日期：** 2026-09-05
- **目标版本：** `v1.2.0`
- **关联决策：** [ADR-0033](decisions/0033-managed-release-cli-self-update.md)、[ADR-0034](decisions/0034-fixed-loopback-persistent-browser-auth.md)
- **交付证据：** [DELIVERY-RELEASE-CLI-MANAGEMENT.md](DELIVERY-RELEASE-CLI-MANAGEMENT.md)

## 1. 背景

当前仓库已经具备 `v1.0.0 / v1.1.0` Git tag 和 release note，但应用版本、运行入口、发布流程与升级方式仍未形成一个完整的产品契约：

- `package.json.version=1.1.0`，README 曾仍显示旧的 `0.1.0`，已经出现版本漂移；
- `src/server.js` 同时承担 HTTP server 与命令行入口，只识别 `--no-open`；
- 没有正式 `bin` CLI；
- 没有 GitHub Release CI；
- 没有受控的 update check、下载、完整性校验、原子切换或 rollback；
- 默认 SQLite 位于 checkout 的 `data/usage.sqlite`，不适合“版本化只读程序目录 + 稳定可写数据目录”的长期安装模型；
- 当前网络例外只允许 Codex 官方 Usage endpoint，自更新若访问 GitHub 必须重新定义安全边界。

Phase 28 的目标不是增加业务统计功能，而是把 Codex Usage Monitor 从“可运行的 Git checkout”提升为**可发布、可安装、可查询版本、可安全升级、可诊断、可回滚的本地产品**。

## 2. 核心目标

V1.2.0 冻结以下用户体验：

```text
codex-usage-monitor
codex-usage-monitor start [--no-open]
codex-usage-monitor open
codex-usage-monitor --version
codex-usage-monitor --help
codex-usage-monitor --update
codex-usage-monitor update --check
codex-usage-monitor rollback
codex-usage-monitor doctor
```

其中：

1. `package.json.version` 是唯一 App Version 事实源；
2. `--version` 必须本地快速返回，不因为 GitHub/DNS/代理不可用而阻塞；
3. 正常启动会以低频、非阻塞方式检查 stable Release，并把结果写入本机 update state；
4. `--version` 读取该缓存，在有新版本时提示 `--update`；
5. `--update` 只作用于 **Managed Install**，不允许修改 Git checkout；
6. 更新以 GitHub stable Release 为唯一来源，下载到 staging、校验 SHA-256、离线 self-check 后再原子切换 current version；
7. 版本目录保留至少上一版，为 rollback 提供基础；
8. rollback 必须受 SQLite/data compatibility gate 保护，不能把旧程序直接指向它无法读取的新数据库；
9. GitHub Release 发布必须经过测试、manifest、checksum、artifact self-test，并先生成 Draft Release，最终由维护者显式 Publish；
10. `.codex`、Request Ledger、canonical accounting、pricing、quota 与 update subsystem 保持完全解耦。
11. HTTP 服务默认且精确监听 `127.0.0.1:47832`；端口占用时启动失败并报告冲突，不再自动递增尝试 47833/47834 等端口。
12. 用户可长期使用固定地址 `http://127.0.0.1:47832/`。浏览器授权从“每次进程启动生成一次性 URL token”改为“本机持久 auth secret + 持久 HttpOnly browser cookie”；首次浏览器授权或 Cookie 丢失时使用 `codex-usage-monitor open` 建立/恢复授权。

## 3. 非目标

V1.2.0 不做：

- npm registry 自动发布；
- `git pull` / `git reset` / 自动切 Git 分支；
- beta/nightly channel；
- 自动更新后台强制安装；
- 静默重启正在运行的监控器；
- 用户遥测、设备 ID、使用统计上传；
- 自动修改 `.codex`；
- 跨平台安装器抽象。当前正式 Managed Install 仍以 Windows 11 + Node.js 24+ 为目标。

## 4. 两种运行模式

### 4.1 Development / Unmanaged Mode

满足任一条件即视为 unmanaged：

- 从普通 Git checkout / 解压目录直接执行；
- 没有有效 managed install marker；
- 当前 entrypoint 不位于 marker 所声明的版本目录中。

行为：

- 允许 `start / --version / --help / doctor / update --check`；
- `--update` 与 `rollback` **不得写当前工程目录**；
- `--update` 返回明确提示：这是开发/非托管目录，应由 Git 管理版本；
- 默认数据库继续使用工程内 `data/usage.sqlite`，保持现有开发行为。

这一规则不能只靠“是否存在 `.git`”判断。Managed Install 必须由显式 marker + install root + current pointer 共同证明。

### 4.2 Managed Install Mode

正式安装根目录：

```text
%LOCALAPPDATA%\CodexUsageMonitor\
├─ app\
│  ├─ v1.2.0\
│  ├─ v1.2.1\
│  └─ ...
├─ bin\
│  └─ codex-usage-monitor.cmd
├─ data\
│  └─ usage.sqlite
├─ state\
│  ├─ install.json
│  ├─ current
│  ├─ update.json
│  └─ history.json
├─ downloads\
└─ backups\
```

关键点：

- `app/vX.Y.Z` 是不可变 release payload；
- `data/state/backups` 是稳定可写区域，不随版本目录切换；
- `state/current` 是纯文本版本指针，例如 `1.2.1`；
- `bin/codex-usage-monitor.cmd` 是极薄稳定 shim，只读取 `state/current` 并执行对应版本的 Node entrypoint；
- 不依赖 Windows symlink/junction，因此无需管理员权限；
- updater 永远不覆盖当前正在执行的版本目录，而是安装新目录后切 pointer。

## 5. App Version 单一事实源

唯一事实源：

```text
package.json -> version
```

禁止再维护：

- README 手写“当前版本”；
- `src/version.js` 硬编码第二份版本；
- release workflow 自动猜版本；
- Git tag 与 package version 不一致。

Release Gate 必须验证：

```text
tag v1.2.0
    == package.json 1.2.0
    == package-lock.json root version 1.2.0
    == docs/releases/v1.2.0.md
    == release-manifest.json version 1.2.0
```

SQLite schema、projection、pricing policy、diagnostics policy 继续独立版本化，不能用 App Version 替代。

## 6. CLI 契约

### 6.1 默认启动

```text
codex-usage-monitor
codex-usage-monitor start
```

两者等价。`--no-open` 仍保留。

服务监听契约固定为：

```text
host = 127.0.0.1
port = CODEX_MONITOR_PORT ?? 47832
```

选择出的端口是**精确端口**。如果已被占用，启动返回明确的 `EADDRINUSE` 用户错误，不扫描后续端口。这样书签、CLI 输出、诊断和本地防火墙规则都有稳定地址。

终端对用户只展示稳定 URL：

```text
Codex Usage Monitor
http://127.0.0.1:47832/
```

不得再把一次性 bearer token 输出到可见 URL。

### 6.2 `open`

```text
codex-usage-monitor open
```

用于首次浏览器授权、Cookie 被清理或切换浏览器 profile 后重新建立授权。CLI 从本机 auth secret 生成一个短时、签名 bootstrap credential，并只把它交给本机浏览器启动参数；server 校验后设置持久 `HttpOnly; SameSite=Strict` Cookie，并立即重定向到固定根地址 `/`。

约束：

- bootstrap credential 不写 SQLite、不写日志、不显示在普通 `start` 输出；
- credential 必须有短 TTL，并绑定当前固定 loopback origin；
- 浏览器 Cookie 可跨 monitor 进程重启继续使用，因此不需要每次启动重新授权；
- `open` 不启动第二个 server；目标端口未监听时应明确提示先执行 `start`；
- `--no-open` 只控制是否自动拉起浏览器，不影响固定 URL 或已有 browser authorization。

### 6.3 `--version`

输出至少包含：

```text
Codex Usage Monitor 1.2.0
```

若 `state/update.json` 中存在未过度陈旧且比当前版本新的 stable 版本：

```text
Update available: 1.2.1
Run: codex-usage-monitor --update
```

`--version` 自身**不联网**。这是确定性/可脚本化契约。

### 6.4 `update --check`

显式联网检查最新 stable release，但不安装：

```text
Current: 1.2.0
Latest:  1.2.1
Status:  update-available
```

Managed mode 会刷新 `state/update.json`。unmanaged mode 也允许该读操作，但只做 one-shot 输出，不创建 managed marker/update cache。

### 6.5 `--update`

等价于：

```text
codex-usage-monitor update
```

仅 managed mode 可执行写入。更新失败时 current pointer 不变。

### 6.6 `rollback`

默认回到最近一个保留版本，但必须满足：

- 目标版本完整；
- 目标 release manifest 可读；
- 当前数据库 schema / storage compatibility 在目标版本声明的可读范围内。

若数据库已经跨不兼容边界升级，只允许使用对应 pre-update backup 做显式 data restore；V1.2.0 不允许“明知不兼容仍 code-only rollback”。显式恢复命令固定为：

```text
codex-usage-monitor rollback --restore-data
```

`state/history.json` 保存有限条版本切换记录与对应 backup locator，仅用于本机 rollback，不包含会话、工程或账号数据。

### 6.7 `doctor`

默认只做本地、只读诊断：

- App version / mode；
- Node version；
- install root/current pointer；
- 当前 release manifest；
- `.codex` 目录可达性；
- SQLite path / `PRAGMA user_version`；
- update state；
- staged/failed update residue。

默认 doctor 不联网、不迁移 schema、不启动 server。

## 6.8 固定端口下的浏览器安全边界

固定 URL 不意味着取消认证。ADR-0004 中“每进程随机 launch token -> session cookie”需要由 Phase 28 的长期 browser authorization 方案替代，但以下边界保持：

- 只监听 IPv4 loopback `127.0.0.1`，不监听 `0.0.0.0` / LAN；
- Host 只接受 `127.0.0.1:<exactPort>` 与 `localhost:<exactPort>`；
- 有 `Origin` 时必须严格同源；
- CORS 仍关闭；CSP / `DENY` / `nosniff` / `no-referrer` 保持；
- 未持有有效 HttpOnly browser cookie 的 API 请求返回 `401`；
- Request Content / Input Context / Context Delta 等敏感 read path 绝不因为“localhost”而匿名开放；
- Alerts POST 继续要求同一 cookie + Host/Origin gate。

持久 auth secret 存储在 runtime layout 的私有 mutable state 中：Development 位于 ignored runtime state，Managed 位于 `%LOCALAPPDATA%\\CodexUsageMonitor\\state`。不得提交 Git、不得进入 release artifact、不得复用 Codex access token。

## 7. Update Check 策略

Managed Install 正常 `start` 后：

1. Server 先完成本地启动；
2. update checker 在后台执行，不阻塞 access URL；
3. 仅当上次成功检查距今 >=24h 才访问 GitHub；
4. 失败只记录脱敏状态与时间，不影响 Monitor health；
5. 若发现新版本，仅输出本地提示并刷新 cache，不自动安装。

`--version` 永远不强制联网；用户需要实时结果时使用 `update --check`。

## 8. GitHub Release 作为唯一升级源

固定官方仓库：

```text
AsahinaMafuuyuu/Codex-Usage-Monitor
```

Updater 不从 Git remote 推导来源，也不允许配置任意 release URL。原因：Git checkout remote 可以被用户改写，而 installed application 必须有稳定可信的 release origin。

stable update 只消费已发布、非 draft、非 prerelease 的 Release。V1.2.0 不引入 channel selector。

## 9. Release Manifest

每个 GitHub Release 必须包含外部 `release-manifest.json`。V1 contract：

```json
{
  "schemaVersion": 1,
  "name": "codex-usage-monitor",
  "version": "1.2.0",
  "tag": "v1.2.0",
  "channel": "stable",
  "commit": "<40-hex>",
  "publishedAt": "2026-09-04T00:00:00.000Z",
  "runtime": {
    "node": ">=24.0.0",
    "platform": "win32"
  },
  "storage": {
    "schemaVersion": 15,
    "compatibilityEpoch": 1,
    "minMigratableSchemaVersion": 1,
    "maxReadableSchemaVersion": 15
  },
  "artifact": {
    "name": "codex-usage-monitor-v1.2.0-win.zip",
    "sha256": "<64-hex>",
    "size": 123456
  }
}
```

注意：`storage.*` 是 rollback/update compatibility metadata，不替代运行时数据库 migration 代码。

## 10. Release Artifact

Release zip 必须是**运行时自包含**的，更新时不得再执行 `npm install` / `npm ci`。

V1 artifact 包含：

```text
package.json
package-lock.json
bin/
src/
public/
node_modules/<runtime deps only>/
build-manifest.json
```

当前 runtime dependency 只有 `lucide`。GitHub Actions 使用 `npm ci --omit=dev` 构建 staging tree 后打包，因此目标机器更新不再依赖 npm registry、registry mirror 或第二次供应链解析。

`build-manifest.json` 只保存 package/version/tag/commit/runtime/storage 等构建身份，不包含 zip 自身的 SHA-256。外部 `release-manifest.json` 在 zip 完成后生成，保存 artifact size/SHA-256。这样避免“archive 内 manifest 包含 archive 自身 hash”的循环依赖。Updater 解压后必须比较 embedded build manifest 与 external release manifest 的 version/tag/commit/runtime/storage 身份。

## 11. Update Transaction

`update` 采用严格状态机：

```text
idle
  -> acquire lock
  -> fetch manifest
  -> validate manifest/version/runtime/storage
  -> download artifact.tmp
  -> verify size + SHA-256
  -> extract app/vX.Y.Z.staging
  -> verify no unexpected traversal + required files
  -> run target offline self-check
  -> create DB backup if compatibility boundary requires
  -> rename staging -> app/vX.Y.Z
  -> atomic replace state/current
  -> record update state
  -> prune old safe versions
  -> release lock
```

任何切 pointer 之前的失败都必须保持旧版完全可用。

`state/current` 更新方式固定为：同目录写临时文件 -> flush/close -> rename replace，避免半写版本号。

## 12. 并发与锁

同一 install root 同时最多一个 updater。

使用 `state/update.lock` 的 exclusive-create 语义。锁文件至少记录 PID、开始时间、目标版本。若 PID 不存在且锁超过合理 TTL，`doctor` 可以将其判为 stale；普通 update 不应随意删除活锁。

正在运行的旧 server 不阻止下载/安装新版本，因为新版本写入独立目录。但 updater 不自动杀掉或重启 server；新版本从下一次启动生效。

## 13. Rollback 与数据库兼容

版本目录可回退不等于数据一定可回退。

V1 冻结两个 gate：

1. **Code compatibility gate**：目标 release 的 `maxReadableSchemaVersion` 必须 >= 当前 DB `PRAGMA user_version`，且 compatibility epoch 相同；满足时允许 code-only pointer rollback。
2. **Data restore gate**：若不满足，但 updater 在升级前生成了对应一致性 SQLite backup，则只有显式 restore 流程可以回退；不得让旧 binary 直接打开新 schema。

数据库 backup 使用 Node 24 `node:sqlite` 的 `backup()` 生成一致性快照，不复制正在使用中的 `-wal/-shm` 组合。

因为 canonical usage 可由 `.codex` 重建，恢复旧 backup 后允许后续版本重新索引派生数据；但 Alerts/Ack/Snooze 等 operational state 可能回到 backup 时点，CLI 必须明确提示这一点。

## 14. 数据目录迁移

Managed Install 默认 DB 改为：

```text
%LOCALAPPDATA%\CodexUsageMonitor\data\usage.sqlite
```

Development Mode 保持：

```text
<repo>\data\usage.sqlite
```

从既有 checkout 迁移到 Managed Install 必须：

- 目标 DB 不存在时才允许首次迁移；
- 使用 SQLite online backup 复制一致性数据库；
- 不删除原 checkout DB；
- 写入 migration marker，确保幂等；
- migration 前后比较 `PRAGMA user_version`、canonical Request/Token/Cost fingerprint；
- `.codex` 源文件 hash 不变。

`CODEX_MONITOR_DB` 继续存在，但“允许范围”从固定 project root 调整为当前 runtime layout 的 mutable data root。这个变化必须有回归测试，不能让 absolute override 越界写任意位置。

## 15. 网络安全边界

Phase 28 增加第二个明确网络用途：GitHub Release metadata/artifact。

允许发送的内容只有：

- HTTPS GET/HEAD；
- 固定 User-Agent（包含公开 App Version）；
- 普通 Accept header。

严禁发送：

- Codex access token / account id；
- `.codex` 内容；
- session/request/task/model usage；
- project path；
- SQLite 内容；
- install id 作为遥测标识。

Release client 必须使用固定 owner/repo，手动验证 redirect host；不能把任意 30x Location 交给自动 follow。允许的 GitHub host 集合必须显式、最小化，并限制 redirect 次数。

代理行为应与现有 Codex Usage client 一致：优先 `HTTPS_PROXY/ALL_PROXY`，Windows 下可只读 WinINET proxy；但 GitHub 请求不携带 Codex credentials。

## 16. GitHub Release Gate

Release workflow 仅由 SemVer tag 触发：

```text
v1.2.0 tag
  -> version/tag/release-note consistency
  -> npm ci
  -> npm test
  -> npm run check
  -> git diff --check
  -> build runtime staging tree
  -> generate manifest + SHA-256
  -> extract artifact in clean temp dir
  -> target --version
  -> target doctor --release-self-check
  -> create GitHub Draft Release
  -> human review
  -> Publish
```

workflow **不得自动修改 package version、commit 或 tag**。发布版本必须在 tag 之前作为普通 reviewable commit 冻结。

Draft/Prerelease 永远不会进入 stable update client。

## 17. 失败语义

必须区分：

- `up-to-date`；
- `update-available`；
- `network-unavailable`；
- `manifest-invalid`；
- `runtime-incompatible`；
- `storage-incompatible`；
- `integrity-failed`；
- `install-mode-required`；
- `update-locked`；
- `self-check-failed`；
- `rollback-incompatible`。

用户提示可以简洁，但内部 result 必须结构化，测试不能依赖自然语言解析。

## 18. 版本保留策略

V1 默认保留：

- current；
- immediate previous；
- 正在被 rollback backup 引用的版本。

其余旧版本可在成功更新后清理。不得在 update transaction 成功前删除旧版本。

## 19. 现有工程不变量

Phase 28 不得改变：

- `.codex` read-only；
- Request Ledger / canonical Request accounting；
- schema v15 的既有业务语义；
- pricing / diagnostics policy 的事实来源；
- loopback + launch token + Strict Cookie + Host/Origin/CSP；
- quota endpoint credential isolation；
- prompt/response 不落 SQLite。

Updater 的本地写权限只允许 managed install root 下的 `app/bin/data/state/downloads/backups`，不得扩大到 `.codex` 或任意工作目录。

## 20. 验收门槛

设计实现完成前至少证明：

1. `--version` 完全离线、版本只来自 package；
2. README 不再存在手工当前版本漂移；
3. dev checkout `--update` 不改变任何 tracked/untracked file；
4. managed update 在 hash/self-check 失败时 current pointer 不变；
5. successful update 下一次启动使用新版本，旧 server 不被强杀；
6. concurrent update 只有一个成功持锁；
7. manifest path traversal / redirect escape / checksum mismatch 被拒绝；
8. update check 失败不影响 server 启动；
9. data migration 使用 SQLite backup，一致性 fingerprint 前后相同；
10. incompatible rollback 被阻止，兼容 rollback 原子切换；
11. release artifact 在干净目录、不依赖 npm install 可运行；
12. GitHub draft release 只有全部 Gate Green 才生成；
13. 全量 `npm test / npm run check / git diff --check` Green。

## 21. 实施顺序

Phase 28 按依赖顺序拆成：

```text
Version/CLI seam
    ↓
Runtime layout + managed marker
    ↓
Shared proxy-aware HTTP transport
    ↓
Release client + update cache
    ↓
Updater transaction + integrity
    ↓
SQLite migration/backup + rollback gate
    ↓
Installer/shim
    ↓
Release builder + GitHub Draft workflow
    ↓
End-to-end clean-install/update/rollback verification
```

在以上契约未实现和验证前，不把 `v1.2.0` 标记为 Release Ready。
