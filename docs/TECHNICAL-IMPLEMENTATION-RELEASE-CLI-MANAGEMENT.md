# Phase 28：Release & CLI Management 技术实施方案

- **状态：** Implemented / Verified
- **日期：** 2026-09-04
- **实施验证日期：** 2026-09-05
- **设计事实源：** [DESIGN-RELEASE-CLI-MANAGEMENT.md](DESIGN-RELEASE-CLI-MANAGEMENT.md)
- **长期决策：** [ADR-0033](decisions/0033-managed-release-cli-self-update.md)、[ADR-0034](decisions/0034-fixed-loopback-persistent-browser-auth.md)
- **目标版本：** `v1.2.0`
- **交付证据：** [DELIVERY-RELEASE-CLI-MANAGEMENT.md](DELIVERY-RELEASE-CLI-MANAGEMENT.md)

## 1. 实施原则

Phase 28 必须先建立 CLI / Runtime Layout / Release Update 三个明确 seam，再接入 GitHub 与安装器。不得继续把参数解析、版本判断、下载、SQLite 迁移塞进 `src/server.js`。

最终依赖关系：

```text
bin/codex-usage-monitor.js
        ↓
src/cli.js
  ├─ app-version.js
  ├─ runtime-layout.js
  ├─ release-client.js
  ├─ update-state.js
  ├─ updater.js
  └─ server.js -> startApplication()

release-client.js
        ↓
http-transport.js
        ↑
codex-usage-client.js

updater.js
  ├─ runtime-layout.js
  ├─ release-client.js
  ├─ database-backup.js
  └─ update-state.js
```

Accounting、parser、pricing、diagnostics 不应成为 updater 的依赖。

## 2. 预计文件范围

### 新增运行时模块

```text
bin/codex-usage-monitor.js
src/app-version.js
src/cli.js
src/runtime-layout.js
src/browser-auth.js
src/http-transport.js
src/release-client.js
src/update-state.js
src/database-backup.js
src/updater.js
```

### 新增发布工具

```text
scripts/build-release.js
scripts/verify-release.js
scripts/install.ps1
.github/workflows/release.yml
```

### 主要测试

```text
test/cli.test.js
test/runtime-layout.test.js
test/browser-auth.test.js
test/release-client.test.js
test/updater.test.js
test/database-backup.test.js
test/release-build.test.js
```

### 既有文件预计修改

```text
package.json
package-lock.json
src/server.js
src/codex-usage-client.js
test/codex-usage-client.test.js
README.md                    # 实现后
docs/OPERATIONS.md           # 实现后
docs/RELEASE-CHECKLIST.md    # 实现后
CHANGELOG.md                 # 实现后
docs/VERIFICATION.md         # 只记录真实执行证据
docs/releases/v1.2.0.md      # Release Candidate 冻结时创建
```

不得为了 Phase 28 修改 `src/request-ledger.js / request-identity.js / request-ownership.js / pricing.js / diagnostics*.js` 的业务语义。

## 3. `app-version.js`：唯一版本读取 seam

外部 interface：

```js
getAppVersion() -> "1.2.0"
getAppIdentity() -> {
  name: "codex-usage-monitor",
  displayName: "Codex Usage Monitor",
  version: "1.2.0",
  nodeRange: ">=24.0.0"
}
```

实现从当前 release tree 的 `package.json` 读取，不允许常量复制版本号。

单测必须证明：

- package version 是唯一来源；
- 缺失/非法 package metadata 时 fail closed；
- `--version` 不触发 network / DB / `.codex` I/O。

## 4. `runtime-layout.js`：Development 与 Managed Install

外部 interface 建议：

```js
resolveRuntimeLayout({
  entryPath,
  environment,
  localAppData,
  projectRoot,
}) -> {
  mode: "development" | "managed",
  projectRoot,
  installRoot,
  appRoot,
  mutableRoot,
  dataRoot,
  stateRoot,
  downloadsRoot,
  backupsRoot,
  databasePath,
  currentVersion,
  marker,
}
```

### 4.1 Managed proof

Shim 启动时设置内部环境变量：

```text
CODEX_MONITOR_INSTALL_ROOT=<absolute install root>
```

但环境变量**不是单独充分条件**。resolver 还必须验证：

1. `<root>/state/install.json` 存在且 `name=codex-usage-monitor`；
2. `<root>/state/current` 是严格 stable SemVer；
3. 当前 entrypoint 实际位于 `<root>/app/v<current>/...`；
4. 所有可写路径经 `resolve/relative` 证明仍在 install root 内。

任一失败降级为 unmanaged，`update/rollback` 禁止写入。

### 4.2 Database 默认路径

Development：

```text
<projectRoot>/data/usage.sqlite
```

Managed：

```text
<installRoot>/data/usage.sqlite
```

现有 `CODEX_MONITOR_DB` 继续允许相对 override，但相对基准从“固定 project root”改为 `layout.dataRoot`；absolute override 只有位于 `layout.mutableRoot` 内才接受。测试必须锁定 Windows drive/case/`..` 逃逸行为。

## 5. `bin/codex-usage-monitor.js` 与 `cli.js`

`bin` 文件保持极薄：

```js
#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch(...);
```

`src/server.js` 只保留 server/module 职责：

```js
startApplication(options)
```

移除它自己的 `main()` 参数解析和 process signal ownership。signal lifecycle 由 CLI start command 统一负责。

### 5.1 CLI parser

V1 不引入 commander/yargs。命令面小，使用纯函数 parser：

```js
parseCliArgs(argv) -> {
  command,
  flags,
}
```

支持：

```text
[]                       -> start
["start"]                -> start
["--no-open"]            -> start
["open"]                 -> open
["--version"]            -> version
["-V"]                   -> version
["--help"]               -> help
["-h"]                   -> help
["--update"]             -> update
["update"]               -> update
["update", "--check"]    -> update-check
["rollback"]             -> rollback
["rollback","--restore-data"] -> rollback-restore
["doctor"]               -> doctor
```

未知命令/冲突 flag 返回 usage error，不做猜测。

### 5.2 `runCli()` 可测试依赖注入

建议：

```js
runCli(argv, {
  stdout,
  stderr,
  startApplicationImpl,
  releaseClient,
  updater,
  now,
  processControl,
})
```

不要让测试通过 monkey-patch 全局 `process.exit`、网络或真实安装目录。

## 5.3 固定 loopback endpoint

`startApplication()` 不再调用“从 preferredPort 连续尝试 10 个端口”的 `listenOnAvailable()` 语义。Phase 28 改为精确监听：

```js
const host = "127.0.0.1";
const port = Number(options.port ?? process.env.CODEX_MONITOR_PORT ?? 47_832);
await listenExactly(server, host, port);
```

要求：

- `EADDRINUSE` 直接向 CLI 返回结构化 `port_in_use`；
- 不尝试 `port + 1`；
- server 返回稳定 `origin=http://127.0.0.1:${port}`；
- Host allowlist 使用这个 exact port；
- 普通 stdout 只输出 `origin + "/"`，不输出 bearer credential。

`CODEX_MONITOR_PORT` 仍允许用户选择其他**固定**端口，但一次启动只允许一个精确值。

## 5.4 `browser-auth.js`：跨进程重启的浏览器授权

Phase 28 用一个独立深模块替代 `src/server.js` 当前“每进程 random launchToken + random sessionSecret”实现。

外部 interface 建议：

```js
ensureBrowserAuthSecret({ stateRoot }) -> Buffer

createBrowserAuth({ secret, now, randomBytes }) -> {
  createBootstrapChallenge(origin),
  consumeBootstrapProof({ origin, challenge, proof }),
  issueCookie(origin),
  verifyCookie(cookieValue, origin),
}
```

### Secret storage

路径由 Runtime Layout 提供：

```text
Development: <repo>/data/state/browser-auth.key
Managed:     %LOCALAPPDATA%/CodexUsageMonitor/state/browser-auth.key
```

规则：

- 首次用 `open(..., "wx", 0o600)` exclusive-create 生成 32 bytes cryptographic random secret；
- 已存在则只读；长度/格式错误 fail closed，不静默覆盖；
- 路径必须经过 mutable-root containment；
- 文件已由 `.gitignore`/release packager 排除；
- 不复用 Codex auth/token，不进入 SQLite、日志、前端 payload。

### Bootstrap challenge/proof

server 提供唯一匿名 auth endpoint：

```text
GET /auth/challenge
```

只返回短时随机 challenge、expiry 和 protocol version，不返回 session/usage/version/path 等业务信息。server 维护 bounded in-memory challenge map；challenge TTL 建议 60 秒，消费后立即删除。

CLI `open`：

1. 请求固定 origin 的 `/auth/challenge`；
2. 若无法连接或 payload/protocol 不符，返回 `monitor_not_running`；
3. 使用本机 secret 对 `version + origin + challenge + expiresAt` 做 HMAC-SHA256；
4. 只将 proof 放入本机浏览器启动 URL；普通 stdout 不打印 proof；
5. 浏览器访问 `/auth/bootstrap?...`；server 验证 + consume challenge 后设置 browser cookie 并 `302 /`。

这样 `open` 只能授权真正持有同一 state secret 的 monitor instance，并且 bootstrap proof 是短时、one-shot。

### Persistent browser cookie

成功 bootstrap 后 server 签发 HMAC-authenticated cookie，payload 至少含 protocol version、issuedAt、expiresAt、random nonce，并绑定 origin。建议有效期 180 天：

```text
codex_monitor=<opaque signed value>;
HttpOnly;
SameSite=Strict;
Path=/;
Max-Age=15552000
```

因为当前 origin 是明文 loopback HTTP，不依赖 `Secure` cookie 的浏览器特殊规则。Host/Origin/CSP 仍是独立安全 gate。

`verifyCookie()` 必须使用 constant-time MAC comparison；过期、origin mismatch、格式错误均返回 unauthorized。

### Start/open ownership

- `start` 负责：resolve layout -> ensure secret -> start server；若没有 `--no-open`，启动后内部执行等价 `open` 流程拉起浏览器。
- `open` 负责：不启动 server，只对当前精确端口进行 challenge/proof bootstrap。
- 即使用户直接点击 `http://127.0.0.1:47832/`，只要浏览器已有未过期 cookie 即直接进入；不再依赖当前进程的 launch URL。
- Cookie 丢失时固定 URL返回清晰 `401`/authorization 页面，CLI `open` 可恢复，不要求 server restart。

### Server auth routing

`/auth/challenge` 与 `/auth/bootstrap` 是唯一无需 browser cookie 的 route；其余静态页面/API 仍要求有效 cookie。bootstrap route 必须：

- exact Host；
- 禁止 cross-origin `Origin`；
- challenge one-shot；
- no-store；
- 成功后立即重定向到不含 credential 的 `/`。

该模块不读取 Request/Session/SQLite，因此可独立 unit test。

## 6. CLI 结果与退出码

内部所有命令返回结构化结果，再由 presentation 层输出文本。

建议固定：

```text
0  success / up-to-date / update-available(check only)
2  invalid usage
3  network/update source unavailable
4  manifest/integrity/self-check failure
5  install mode / compatibility / lock conflict
1  unexpected internal failure
```

测试断言 result code + machine state，不依赖中文文案。

V1 不公开 `--json`，但内部 result shape 要为未来 JSON output 留出空间。

## 7. 共享 `http-transport.js`

当前 `src/codex-usage-client.js` 已实现：

- `HTTPS_PROXY / ALL_PROXY`；
- `NO_PROXY`；
- Windows WinINET proxy；
- HTTPS CONNECT tunnel。

Phase 28 把 transport/proxy 能力抽到独立深模块，但必须保持 Codex Usage 行为完全一致。

建议 interface：

```js
requestHttps(url, {
  method = "GET",
  headers,
  signal,
  redirect = "manual",
  proxyResolver = resolveProxyForUrl,
}) -> ResponseLike
```

`CodexUsageClient` 继续自己构造 Authorization / Account header；Release client 永远没有这些字段。两者只共享 transport，不共享业务 request builder。

提取前后现有 `test/codex-usage-client.test.js` 必须全部 Green。

## 8. `release-client.js`

固定 source config：

```js
const RELEASE_SOURCE = {
  owner: "AsahinaMafuuyuu",
  repo: "Codex-Usage-Monitor",
  channel: "stable",
};
```

V1 使用固定 stable manifest URL：

```text
https://github.com/AsahinaMafuuyuu/Codex-Usage-Monitor/releases/latest/download/release-manifest.json
```

不读取 Git remote，不允许用户传任意 URL。

### 8.1 interface

```js
class ReleaseClient {
  async fetchLatestManifest()
  async downloadArtifact(manifest, destination)
}
```

### 8.2 Redirect policy

网络请求使用 `redirect: manual`。每次 30x：

1. resolve Location；
2. 必须保持 `https:`；
3. hostname 必须在 frozen allowlist；
4. 最多 5 跳；
5. 禁止 URL credential；
6. 禁止 downgrade 到 HTTP。

allowlist 初始由 GitHub release 实际 redirect chain fixture 冻结；实现前必须用官方/真实 Release 复核，不凭经验扩大到 `*.githubusercontent.com` 全域。

### 8.3 Manifest validator

纯函数：

```js
validateReleaseManifest(payload) -> validated | error
```

必须验证：

- schemaVersion=1；
- package name 固定；
- stable SemVer；
- `tag === v${version}`；
- channel=stable；
- commit 40 hex；
- platform=win32；
- artifact name 不含 `/\\..`；
- sha256 64 hex；
- size 为正整数并设合理上限；
- storage `minMigratableSchemaVersion <= schemaVersion <= maxReadableSchemaVersion`；
- compatibility epoch 为正整数。

## 9. Stable SemVer comparator

V1 只支持 release version：

```text
MAJOR.MINOR.PATCH
```

`v` 只允许出现在 tag，不允许 package version 自带 `v`。prerelease/build metadata 在 V1 update channel 直接拒绝，不做复杂 precedence。

内部：

```js
parseStableVersion()
compareStableVersions()
```

不得用字符串比较，例如 `1.10.0 > 1.9.0` 必须正确。

## 10. `update-state.js`

### 10.1 `state/update.json`

只保存 latest-check cache：

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "lastCheckedAt": "2026-09-04T20:00:00.000Z",
  "latestVersion": "1.2.1",
  "latestTag": "v1.2.1",
  "latestPublishedAt": "...",
  "status": "update-available",
  "lastErrorCode": null
}
```

不保存 HTTP body、redirect chain、IP、Codex credential、project/session 信息。

### 10.2 `state/history.json`

bounded transition journal：

```json
{
  "schemaVersion": 1,
  "transitions": [
    {
      "from": "1.2.0",
      "to": "1.2.1",
      "switchedAt": "...",
      "schemaBefore": 15,
      "schemaAfterExpected": 15,
      "compatibilityEpoch": 1,
      "backup": null
    }
  ]
}
```

默认最多保留最近 10 次。

所有 state write 使用同目录 temp + rename 原子替换。

Development mode 的 `update --check` 只输出结果，不要求创建 managed update cache；自动 24h check 仅在 managed start 启用，避免普通 Git checkout 产生新的持久状态。

## 11. `updater.js` 深模块

外部 interface 保持小：

```js
class ManagedUpdater {
  async check()
  async update()
  async rollback({ restoreData = false } = {})
  async doctor()
}
```

CLI 不知道 staging/hash/lock/backup 的细节。

### 11.1 Update state machine

内部步骤：

```text
assert managed
acquire lock
fetch/validate manifest
compare version
check runtime/storage metadata
download .tmp
verify exact size
SHA-256 stream verify
extract to unique staging dir
validate extraction tree
validate embedded build-manifest
run target release self-check
read current DB schema
conditionally backup DB
rename staging to immutable version dir
append transition history
atomic current pointer switch
cleanup temp
prune safe old releases
release lock
```

顺序关键：**history 与 pointer 切换必须作为最后的 commit 部分处理。** 如果切换 pointer 后 journal write 失败，updater 必须能通过 current + installed dirs 恢复，而不能留下“无版本可启动”状态。

### 11.2 Existing target version

如果 `app/vX.Y.Z` 已存在：

- build-manifest identity 完全匹配 -> 可复用，不覆盖；
- identity 不匹配 -> `integrity-failed`，禁止删除后重装来掩盖异常。

### 11.3 Downgrade

`update` 禁止 latest < current。降级只能通过 rollback 到已安装且验证过的版本。

## 12. Archive extraction

当前平台固定 Windows。V1 使用系统 PowerShell `Expand-Archive`，因为：

- Windows 11 默认具备；
- release artifact 已先做 SHA-256；
- 避免为了 updater 再引入 unzip runtime dependency。

调用必须使用 `execFile/spawn` 参数，不拼接用户可控 shell command。所有 archive/staging 路径由 updater 自己生成。

解压后仍要二次校验：

- `realpath` 在 staging root 内；
- 不接受 symlink/junction/reparse escape；
- 必须存在 `package.json / build-manifest.json / bin/codex-usage-monitor.js / src/server.js / public/index.html`；
- package version 与 manifest 一致。

## 13. Target offline self-check

新版本切换前运行：

```text
node <staging>/bin/codex-usage-monitor.js doctor --release-self-check
```

该隐藏/internal flag 只用于 artifact verification，不能：

- 打开数据库写连接；
- migration；
- 网络；
- `.codex` scan；
- 启动 HTTP server。

它只验证 package/build manifest、runtime files、Node range、关键模块 import/syntax 与静态资源存在。

## 14. `database-backup.js`

Node 24 已提供 `node:sqlite` `backup()`，Phase 28 使用它替代 raw sqlite/WAL 文件复制。

外部 interface：

```js
readDatabaseCompatibility(databasePath)
backupDatabase({ sourcePath, destinationPath })
migrateDatabase({ sourcePath, destinationPath })
restoreDatabase({ backupPath, destinationPath })
```

### 14.1 Read-only compatibility

只读打开：

```js
new DatabaseSync(path, { readOnly: true })
PRAGMA user_version
PRAGMA quick_check
```

`doctor` 和 rollback gate 只走 read-only path，不实例化 `MonitorDatabase`，避免构造器触发 migration。

### 14.2 Backup

如果 target manifest 的 storage metadata 表示可能跨 schema/epoch compatibility boundary，则 update commit 前必须创建 backup：

```text
backups/pre-v1.2.1-from-v1.2.0-<UTC>.sqlite
```

backup 成功且 quick_check Green 后才能继续切换。

### 14.3 Restore

`rollback --restore-data`：

1. 确认 server 未持有当前 managed DB writer（若无法证明则拒绝并提示先停止）；
2. 当前 DB 先生成 emergency backup；
3. 从 selected pre-update backup 生成 temp restore DB；
4. quick_check；
5. atomic replace database file；
6. 再切 current pointer。

失败时不得同时丢失 current DB 与 current pointer。

## 15. Existing checkout -> Managed data migration

`scripts/install.ps1` 支持显式：

```powershell
.\install.ps1 -MigrateFrom "D:\path\to\codex-usage-monitor"
```

只有目标 managed DB 不存在时允许。

installer 调用新 release 内部 migration helper，使用 `node:sqlite backup()` 从：

```text
<source>\data\usage.sqlite
```

复制到 managed data root。源 DB 保留不删。

迁移完成记录：

```text
state/install.json.migration
```

包含 sourcePath、migratedAt、sourceSchema、destinationSchema，但 sourcePath 只存在本机 marker，不发送网络。

验收时额外运行 canonical accounting fingerprint 对照；该 fingerprint 只用于 release/migration QA，不进入 installer 网络或 telemetry。

## 16. Windows shim

`bin/codex-usage-monitor.cmd` 不解析业务参数：

```bat
@echo off
set "ROOT=%LOCALAPPDATA%\CodexUsageMonitor"
set /p VERSION=<"%ROOT%\state\current"
set "CODEX_MONITOR_INSTALL_ROOT=%ROOT%"
node "%ROOT%\app\v%VERSION%\bin\codex-usage-monitor.js" %*
```

实际实现需补：

- missing current 明确错误；
- quoted path；
- `%*` 透传；
- `exit /b %ERRORLEVEL%`；
- 不使用 delayed expansion 处理用户参数。

installer 将 `<root>/bin` 加入当前用户 PATH；不修改 machine PATH，不要求管理员权限。若 PATH 修改需要新 terminal 生效，明确提示。

## 17. `scripts/install.ps1`

bootstrap installer 职责：

1. 检查 Windows + Node >=24；
2. 创建 `%LOCALAPPDATA%/CodexUsageMonitor`；
3. 固定 GitHub source 下载 latest stable external manifest；
4. 下载/校验 release zip；
5. 解压并验证 embedded build manifest；
6. 写 install marker/current pointer/shim；
7. 可选 `-MigrateFrom`；
8. 更新 User PATH；
9. 运行 installed `--version` + release self-check。

installer 与 updater 必须共享 manifest schema 和 artifact verification 规则。避免 PowerShell 与 JS 各实现一套不同 validator：建议 installer 下载 zip 后调用其中一个最小 bootstrap verifier，或把 PowerShell 检查限定为 transport/hash，最终 semantic validation 交给 Node release code。

## 18. Release build

`scripts/build-release.js`：

1. 接受 `--tag vX.Y.Z --commit <sha>`；
2. 验证 package/package-lock/tag；
3. 创建 clean staging；
4. 复制 runtime tree；
5. `npm ci --omit=dev` 应在 staging 构建步骤完成，不污染 source worktree；
6. 写 `build-manifest.json`；
7. 生成 zip；
8. 计算 size/SHA-256；
9. 生成外部 `release-manifest.json`。

构建输出放 CI 临时目录，不提交 artifact 到 Git。

## 19. Release verification

`scripts/verify-release.js` 接受 manifest + zip：

- external manifest schema；
- SHA/size；
- clean extract；
- embedded manifest identity；
- runtime dependency completeness；
- `--version`；
- `doctor --release-self-check`；
- server module syntax/import；
- static assets；
- no unexpected `data/*.sqlite`、logs、`.codex`、credentials、`.git`。

## 20. GitHub Actions

`.github/workflows/release.yml`：

```yaml
on:
  push:
    tags:
      - 'v*.*.*'
```

Job 顺序：

```text
checkout exact tag
setup-node 24
npm ci
version consistency gate
npm test
npm run check
git diff --check
release build
release verify
upload CI artifact
create Draft GitHub Release with:
  - zip
  - release-manifest.json
  - install.ps1
  - docs/releases/vX.Y.Z.md body/reference
```

GitHub token 权限最小化为 release content write；测试 job 不需要写权限。

workflow 只创建 Draft。维护者 Publish 是 stable channel 的最终人工 gate。

## 21. Background update check integration

只在 managed `start` 成功监听后执行：

```js
void updater.checkIfDue({ ttlMs: 24h })
```

要求：

- 不 await 后再输出 access URL；
- promise rejection 被本地消费并转成 update state；
- 不写 Monitor health error queue；
- 不通过 SSE/API 注入 update payload；
- 发现新版本只写 console notice。

后续若要 UI update badge，应另开产品阶段，不在 Phase 28 顺手加入。

## 22. `doctor`

`doctor()` 返回结构化 checks：

```js
{
  status: "healthy" | "warning" | "error",
  checks: [
    { id: "app-version", status, detail },
    { id: "runtime-mode", status, detail },
    { id: "node-version", status, detail },
    { id: "install-pointer", status, detail },
    { id: "release-manifest", status, detail },
    { id: "codex-home", status, detail },
    { id: "database", status, detail },
    { id: "update-lock", status, detail },
    { id: "update-state", status, detail }
  ]
}
```

输出不可包含 auth token、launch token、Cookie 或 Request 内容。

## 23. 测试矩阵

### CLI

- version/help/start alias；
- conflicting args；
- no network for version/doctor；
- unmanaged update write refusal；
- exit codes。

### Runtime layout

- dev checkout；
- valid managed root；
- spoofed env without marker；
- pointer/path mismatch；
- Windows path escape；
- DB override containment。

### Release client

- latest manifest；
- invalid schema/SemVer/tag/hash/size；
- redirect allowed/denied/loop；
- HTTPS only；
- proxy reuse；
- zero Codex credentials in headers。

### Updater

- current==latest no-op；
- successful stage/switch；
- hash failure；
- extraction failure；
- self-check failure；
- existing same/mismatched version dir；
- concurrent lock；
- stale temp cleanup；
- update never writes checkout；
- previous version retained。

### Database/rollback

- read-only schema inspection；
- online backup under WAL；
- compatible code-only rollback；
- incompatible rollback refusal；
- explicit restore rollback；
- failed restore preserves current DB/pointer；
- checkout -> managed migration fingerprint equality。

### Release artifact

- clean extraction；
- no npm install required；
- exact version；
- no SQLite/log/credential leakage；
- install -> update -> rollback end-to-end temp root。

## 24. 实施任务切片

### Task 1：Version + CLI seam

**Files:** `bin/codex-usage-monitor.js`, `src/app-version.js`, `src/cli.js`, `src/server.js`, `test/cli.test.js`。

**Gate:** 现有 start 行为不回归；`--version/--help` 不初始化 DB/network。

### Task 2：Runtime layout

**Files:** `src/runtime-layout.js`, `src/server.js`, `test/runtime-layout.test.js`, `test/database-server.test.js`。

**Gate:** managed/dev DB path 与 containment 回归 Green。

### Task 3：Shared HTTP transport extraction

**Files:** `src/http-transport.js`, `src/codex-usage-client.js`, `test/codex-usage-client.test.js`。

**Gate:** Codex Usage HTTP/proxy/auth tests byte-for-behavior compatible。

### Task 4：Release client + update state

**Files:** `src/release-client.js`, `src/update-state.js`, `test/release-client.test.js`。

**Gate:** manifest/redirect/SemVer/cache tests Green。

### Task 5：Managed updater transaction

**Files:** `src/updater.js`, `src/cli.js`, `test/updater.test.js`。

**Gate:** checksum/staging/self-check/current pointer/lock failure injection Green。

### Task 6：Database backup + rollback

**Files:** `src/database-backup.js`, `src/updater.js`, `test/database-backup.test.js`, `test/updater.test.js`。

**Gate:** WAL backup、compatibility refusal、restore rollback Green。

### Task 7：Managed installer + shim

**Files:** `scripts/install.ps1`, `src/runtime-layout.js`, `test/runtime-layout.test.js`, `docs/OPERATIONS.md`。

**Gate:** temp LOCALAPPDATA install/migrate/PATH/shim smoke test。

### Task 8：Release builder/verifier

**Files:** `scripts/build-release.js`, `scripts/verify-release.js`, `test/release-build.test.js`, `package.json`。

**Gate:** artifact 可在 clean temp dir 无 npm install 运行。

### Task 9：GitHub Draft Release workflow

**Files:** `.github/workflows/release.yml`, `docs/RELEASE-CHECKLIST.md`, `docs/releases/v1.2.0.md`。

**Gate:** tag/version mismatch fail；全 Gate Green 后仅生成 Draft。

### Task 10：Public docs + final release verification

**Files:** `README.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`, `docs/API.md`, `docs/ARCHITECTURE.md`（仅实际行为需要时）。

**Gate:** full test/check/diff、clean install/update/rollback、accounting/.codex fingerprint 全 Green。

## 25. 实施前置条件

当前工作树存在 Phase 27 等未提交改动。Phase 28 implementation 开始前必须先形成可审查基线：

- 不 reset/stash/覆盖现有工作；
- 先确认当前业务改动的 commit/release ownership；
- 版本/CLI 基础 Task 1 从已集成主线开始；
- release workflow 最终只对 clean Git tag 构建，不允许从 dirty worktree 生成正式 artifact。

本方案已于 2026-09-05 完成实现与本地真实验证，状态更新为 **Implemented / Verified**。正式 GitHub tag / Draft / Publish 仍属于发布操作，必须在 clean tagged checkout 上按 `docs/RELEASE-CHECKLIST.md` 单独执行，不以本地实现验证冒充远程发布完成。
