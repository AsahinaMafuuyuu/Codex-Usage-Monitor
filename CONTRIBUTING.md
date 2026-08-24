# 参与开发

开始前先阅读 [AGENTS.md](AGENTS.md) 和相关 [架构决策](docs/decisions/README.md)。本项目把 `.codex` 只读性、内容最小化和用量口径视为不可随意改变的产品契约。

## 工作流

1. 从 `main` 创建短生命周期分支。
2. 在 `tasks/plan.md` 或关联任务中写明范围和验收标准。
3. 修改实现时同步更新测试；改变公共行为时同步更新文档和 CHANGELOG。
4. 运行全量验证并检查 `git diff` 中没有真实 rollout、SQLite、会话正文或凭证。
5. 使用简洁的 Conventional Commit 风格提交。

推荐命令：

```powershell
npm test
npm run check
git status --short
git diff --check
```

## 变更决策

以下变化必须新增或更新 ADR：

- rollout 归因口径或数据质量含义。
- SQLite schema 或持久化内容边界。
- HTTP API、认证、Host/Origin/CSP 或监听地址。
- 数据源、实时观察方式或外部进程集成。

ADR 使用 `docs/decisions/NNNN-short-name.md`，包含 `Status`、`Date`、`Context`、`Decision`、`Alternatives considered` 和 `Consequences`。

## 测试数据

优先提交脱敏的最小结构 fixture。不得提交真实 prompt、response、会话名称、凭证或 rollout。依赖开发机真实样本的测试必须在样本不存在时明确 skipped，并在文档中区分“可移植测试”和“本机附加验证”。

## 多智能体协作

由协调者分配不重叠的文件所有权并负责 Git 操作。子智能体不 stash、reset、revert 或提交共享工作区；交接时报告改动文件、接口变化、精确测试结果和未完成风险。
