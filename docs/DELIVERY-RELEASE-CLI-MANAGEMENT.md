# Phase 28：Release & CLI Management 交付记录

- **状态：** Implemented / Verified
- **验证日期：** 2026-09-05
- **目标版本：** `v1.2.0`
- **设计事实源：** [DESIGN-RELEASE-CLI-MANAGEMENT.md](DESIGN-RELEASE-CLI-MANAGEMENT.md)
- **技术事实源：** [TECHNICAL-IMPLEMENTATION-RELEASE-CLI-MANAGEMENT.md](TECHNICAL-IMPLEMENTATION-RELEASE-CLI-MANAGEMENT.md)
- **长期决策：** [ADR-0033](decisions/0033-managed-release-cli-self-update.md)、[ADR-0034](decisions/0034-fixed-loopback-persistent-browser-auth.md)

## 1. 实际交付

Phase 28 已把 Git checkout 运行模型补齐为独立 CLI、Development / Managed Runtime Layout、固定 loopback + 持久 browser authorization、固定 GitHub stable Release client、checksum/staging/self-check/current-pointer update transaction、SQLite compatibility/backup/rollback、Windows installer/shim、self-contained deterministic release artifact 与 Draft-only GitHub Actions gate。

实现保持以下边界：

- `package.json.version` 是唯一 App Version；当前为 `1.2.0`。
- `src/server.js` 不解析 CLI 参数；正式入口是 `bin/codex-usage-monitor.js -> src/cli.js`。
- Development checkout 的 update/rollback 写路径被拒绝；Managed Install 根固定为 `%LOCALAPPDATA%\CodexUsageMonitor`。
- 默认精确监听 `127.0.0.1:47832`；`EADDRINUSE` fail-fast，不自动漂移。
- 正常访问 URL 固定为 `http://127.0.0.1:47832/`；browser secret 持久保存在本机 runtime state，`open` 通过 60 秒 one-shot challenge/proof bootstrap HttpOnly Strict Cookie。
- GitHub Release request 只使用固定仓库和 `github.com` / `release-assets.githubusercontent.com` 两个冻结 host，不携带 Codex credential。
- updater 使用 size + SHA-256 + ZIP traversal preflight + staging + embedded build identity + offline self-check + immutable version directory + atomic current pointer。
- rollback 只读检查 SQLite schema/quick_check；不兼容 code-only rollback 被拒绝，显式 `--restore-data` 使用 pre-update backup，并在 commit 失败时恢复 emergency backup 与旧 pointer。
- installer 的 checkout migration 使用 Node 24 `node:sqlite backup()`，不复制 live WAL/SHM，不删除源 DB；安装失败会清理本次创建的 migrated DB/current/marker/shim/version tree。
- release ZIP 是运行时自包含 artifact，目标机器 update 不执行 `npm install` / `npm ci`。
- Managed start 的 update check 是 24 小时 TTL、fire-and-forget；失败只写脱敏状态，不阻塞 server health。

## 2. 真实测试与故障注入证据

最终全量门：

```text
npm test
274 tests / 273 passed / 0 failed / 1 skipped

npm run check
PASS

git diff --check
PASS
```

唯一 skipped 是仓库既有的真实五任务可选 fixture：未设置 `CODEX_MONITOR_REAL_FIXTURE` 时按设计 skip，没有被计为 passed。

关键 focused / integration evidence：

- exact port `EADDRINUSE` fail-fast、persistent Cookie restart、anonymous route allowlist；
- Phase 28 初次收口后由真实 `npm start` 暴露 Windows browser opener 缺口：`cmd.exe /c start` 会把 bootstrap URL 中的 `&` 解释为 shell command separator，mock spawn 单测此前没有模拟这一层。已改为无 shell 的 `rundll32.exe url.dll,FileProtocolHandler`，并新增 CLI regression 断言完整 `version/challenge/expiresAt/proof` URL 作为单一参数传递；
- `--version` 直接子进程运行 stderr 为空，并证明不会加载 `node:sqlite`；
- Git checkout `update` 在任何 release/network work 前拒绝；
- SHA-256/self-check/lock failure 保持旧 current pointer；
- existing target version 只在 embedded identity 完全一致时复用；
- pointer 写后 history failure 会恢复旧 pointer；update cache failure 为 warning-only；
- `rollback --restore-data` 在 incompatible backup 时于 DB replace 前拒绝；restore 后若 history/pointer commit 被注入失败，会恢复原 DB 与原 pointer；
- Windows temp `LOCALAPPDATA` installer smoke 实际完成 managed layout、SQLite online migration、stable `.cmd` shim `--version`；
- release builder 两次独立构建得到相同 artifact size/SHA-256，clean extract 后不执行 npm install 即通过 `--version` 与 `doctor --release-self-check`；
- workflow contract 验证 tag/package/package-lock/release-note mismatch fail，GitHub job 只创建 Draft，不执行 bump/commit/tag/publish。

## 3. Clean artifact → install → update → rollback E2E

`test/release-e2e.test.js` 使用真实默认 release builder（staging 内执行 `npm ci --omit=dev` 后裁剪为实际 runtime dependency）、真实 ZIP、真实 PowerShell installer、真实 updater 解压和 current/history transaction，执行：

```text
clean v1.2.0 artifact
  -> Managed Install v1.2.0
  -> build temporary v1.2.1 artifact
  -> real ManagedUpdater update to v1.2.1
  -> code-compatible rollback to v1.2.0
```

最终全量测试中的该 E2E 为 **PASS**（约 `27.5s`）。此前在真实 E2E 中实际发现并修复了 Windows-only 问题，包括 `npm.cmd spawn EINVAL`、PowerShell `Expand-Archive` 参数传递、临时 archive 后缀必须保持 `.zip`、以及 archive traversal preflight；这些问题未被 mock extractor 单元测试掩盖。

## 4. SQLite compatibility / migration / restore

实际测试使用 Node 24 `node:sqlite backup()` 创建一致性 snapshot，并对 source/destination 执行 `PRAGMA user_version` 与 `PRAGMA quick_check`。验证覆盖：

- managed migration 不覆盖已存在 destination；
- update 跨 storage schema/compatibility epoch boundary 时先创建 pre-update backup；
- same epoch + target readable schema 才允许 code-only rollback；
- incompatible rollback 必须显式 `--restore-data` 且存在对应 backup；
- restore 前创建 emergency backup；
- selected backup 在替换 live DB 前先验证目标 release 可读性；
- restore 后 commit 失败时恢复 emergency DB 与旧 current pointer。

## 5. Accounting fingerprint

Phase 28 实施前记录的业务基线与最终验证后结果完全一致：

| 指标 | Before | After |
|---|---:|---:|
| canonical Requests | 30,239 | 30,239 |
| input tokens | 3,702,019,644 | 3,702,019,644 |
| cached input tokens | 3,491,995,868 | 3,491,995,868 |
| cache-write input tokens | 498,176 | 498,176 |
| output tokens | 16,476,653 | 16,476,653 |
| reasoning output tokens | 5,991,813 | 5,991,813 |
| total tokens | 3,718,496,297 | 3,718,496,297 |
| known calendar cost USD | 2579.79482923 | 2579.79482923 |
| estimated / partial / unavailable requests | 30,030 / 0 / 237 | 30,030 / 0 / 237 |
| canonical == calendar six-field fingerprint | true | true |

`pricing_policy_version` 前后均为 `2026-09-04-astra-codex`，projection version 前后均为 `2`。本机 `projection_generation` 从采集基线时的 `9062` 持续推进；文档收口前中间采样为 `9159`，最终只读采样为 `9460`。该值是可重建 projection 的运行代数，不是 Request/Token/Cost identity。由于上述业务 fingerprint 与 `.codex` source manifest 在这些采样中均完全一致，因此没有把 generation 变化伪装成 accounting 变化或“不变”。

## 6. `.codex` read-only evidence

实施前后均发现 `452` 个 `sessions/**/rollout-*.jsonl` / `archived_sessions/**` JSONL 文件，按 portable relative path + 单文件 SHA-256 组合后的 manifest 均为：

```text
fb704efd96f4dc0019737a0ed9bed8fc7ecfe394f6029db8e9cb15302cc813cf
```

因此 Phase 28 installer/update/rollback/release tests 没有修改 `.codex` rollout。browser auth secret、update state、download/staging/backup 也都限定在 ignored Development runtime state 或 Managed Install root，不进入 `.codex`。

## 7. 正式 GitHub 发布边界

本次完成的是**实现与本地 Release Gate 验证**，没有伪造远程发布行为：

- 尚未为本轮工作创建或 push `v1.2.0` tag；
- 尚未实际触发 GitHub Actions Draft Release；
- 尚未 Publish GitHub Release。

`.github/workflows/release.yml` 的静态 contract 与本地 release gate 已验证；正式发布必须在未来 clean tagged checkout 上重新执行 `docs/RELEASE-CHECKLIST.md`，由维护者检查 Draft assets 后手工 Publish。stable updater 只消费已发布 stable Release，不消费 Draft/Prerelease。

## 8. 状态结论

Phase 28 的代码、failure-injection、Windows installer、release artifact、update/rollback transaction、最终全量门、accounting fingerprint 与 `.codex` read-only gate 均已完成，因此状态从 `Design Approved / Implementation Pending` 更新为 **Implemented / Verified**。远程 GitHub Publish 是后续显式发布动作，不属于“实现已验证”的伪进度。

补充：Development checkout 的 `npm start` 只是新 CLI 的开发兼容入口，不等于 Managed Install。两种模式共用固定 loopback endpoint，但各自在自己的 runtime state 中持有 browser-auth secret；因此 checkout server 必须用 `npm run open` bootstrap，Managed server 必须用已安装的 `codex-usage-monitor open` bootstrap。该隔离是安全边界，不应通过共享 secret 消除。
