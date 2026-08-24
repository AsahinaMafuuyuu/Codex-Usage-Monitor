# 发布核对清单

每次准备本地发布或交付提交时复制本清单，并记录实际输出。协调智能体独占 stage、commit 和 tag 操作。

## 范围与决策

- [ ] 版本范围、验收标准和非目标已写入 plan/todo。
- [ ] API、schema、安全、隐私或归因口径变化已更新 ADR。
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
