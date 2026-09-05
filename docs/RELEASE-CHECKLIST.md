# 发布核对清单

每次准备本地发布或交付提交时复制本清单，并记录实际输出。协调智能体独占 stage、commit 和 tag 操作。

## 范围与决策

- [ ] 版本范围、验收标准和非目标已写入 plan/todo。
- [ ] API、schema、安全、隐私或归因口径变化已更新 ADR。
- [ ] 若包含 USD 估算，官方价目来源、catalog version、review date、未知模型和长上下文限制已经复核。
- [ ] README、API、运维、验证和 CHANGELOG 与实现一致。
- [ ] 多智能体文件所有权已收回，所有交接和风险已检查。

## 质量门

```powershell
npm test
npm run check
git diff --check
```

- [ ] 记录 passed/failed/skipped 数量，不把 skipped 表述为 passed。
- [ ] 若本机真实五任务样本存在，五个总数匹配且源文件哈希不变。
- [ ] 涉及 UI 时已完成桌面和窄屏浏览器验证。
- [ ] 涉及 watcher/SSE 时已验证追加、尾行、轮转、重启续读和延迟目标。

## 隐私与安全

- [ ] `git status --short --ignored` 中 SQLite、日志和工具缓存均为 ignored。
- [ ] staged diff 不含真实 rollout、prompt/response、会话标题、token URL、Cookie 或凭证。
- [ ] `.codex` 源文件未被修改。
- [ ] 服务仍只监听 loopback，并通过认证、Host/Origin、CSP 和只读方法测试。

## Git

```powershell
git status --short
git diff --cached --check
git diff --cached --stat
```

- [ ] 使用明确路径 stage，审查完整 staged diff。
- [ ] 提交信息准确反映交付内容。
- [ ] 提交后工作区只剩预期的 ignored runtime 文件。
- [ ] 只有明确发布时才创建版本 tag；没有远程授权时不 push。

## Phase 28 Managed Release gate

- [ ] `package.json.version`、`package-lock.json` root version、SemVer tag 与 `docs/releases/vX.Y.Z.md` 完全一致。
- [ ] `node scripts/verify-release-gate.js --tag vX.Y.Z` 通过。
- [ ] release build 使用 clean tagged checkout；禁止从 dirty worktree 生成正式发布资产。
- [ ] `release-manifest.json` 的 version/tag/commit/runtime/storage 与 ZIP 内 `build-manifest.json` 一致。
- [ ] release ZIP 的 exact size 与 SHA-256 已由 `scripts/verify-release.js` 复核。
- [ ] clean extract 后直接运行 `--version` 与 `doctor --release-self-check`，不执行 `npm install`/`npm ci`。
- [ ] artifact 不含 `data/state/backups/downloads`、SQLite、日志、`.codex`、`.git`、browser auth secret 或其他凭据。
- [ ] Managed install/update/rollback 与 SQLite compatibility/restore smoke tests 已在临时 `%LOCALAPPDATA%` 真实执行。
- [ ] GitHub Actions 仅创建 Draft Release；由维护者复核资产后显式 Publish。
- [ ] Publish 前重新确认 stable updater 不消费 Draft/Prerelease。

### Phase 28 implementation verification baseline (2026-09-05)

本节记录实现验证，不替代上面的**每次正式发布**手工 checklist：

- local full suite: `274 tests / 273 passed / 0 failed / 1 existing optional skipped`；
- `npm run check` / `git diff --check`: PASS；
- deterministic release build + clean extract `--version` / release self-check: PASS；
- temp `%LOCALAPPDATA%` Managed Install + SQLite migration + stable shim: PASS；
- clean artifact `v1.2.0 install -> temporary v1.2.1 update -> v1.2.0 rollback`: PASS；
- accounting before/after: `30,239` canonical Requests、`3,718,496,297` total tokens、known cost `$2579.79482923`，一致；
- `.codex`: `452` rollout，combined SHA-256 `fb704efd96f4dc0019737a0ed9bed8fc7ecfe394f6029db8e9cb15302cc813cf`，一致；
- 未创建/push 正式 tag，未实际创建 GitHub Draft，未 Publish；这些项目必须在 clean tagged checkout 上重新执行本清单。
