# 验证说明与证据

## 自动化验证

在项目根目录运行：

```powershell
npm test
npm run check
```

测试覆盖：

- 分页复制历史和 `subagent_history_start_ordinal` 排除。
- 累计快照差分、重复快照幂等和 active → completed 增量 tail。
- 累计倒退的 `discontinuity` 标签。
- SQLite schema v1–v4→v5 迁移、cursor 恢复 active task、任务间累计 baseline、不可信 cursor 全量回放和 warning/discontinuity 跨重启保留。
- 原 rollout 消失后，派生任务与汇总在重启后继续保留，预览明确不可用。
- 未完成 JSONL 尾行保留到下一次读取。
- 未知/跳过格式进入健康 warning，父→子预览不会被子智能体回复覆盖。
- SQLite 中任务用量持久化且 schema 不含 prompt/preview/content/message 字段。
- 会话标题不进入派生数据库。
- 启动 token、Strict Cookie、Host/Origin 和只读 HTTP 边界。
- CSP 下静态页面和脚本不依赖 inline style。
- 开发机五任务真实样本及源文件 SHA-256 不变。

`npm run check` 对服务、监听器、parser 和浏览器脚本执行 Node 语法检查。

## 可移植与本机附加验证

脱敏 fixture、SQLite 和 HTTP 安全测试可在任何满足 Node 24 的机器运行。真实五任务样本不进入 Git；仅当 `CODEX_MONITOR_REAL_FIXTURE` 指向该开发机文件时执行：

```powershell
$env:CODEX_MONITOR_REAL_FIXTURE = 'C:\path\to\audited-rollout.jsonl'
npm test
```

期望差分：

| Task | total tokens |
|---:|---:|
| 1 | 1,081,772 |
| 2 | 765,891 |
| 3 | 2,230,918 |
| 4 | 1,144,641 |
| 5 | 482,917 |

该文件不存在时，Node test runner 必须报告该项 `SKIP`；不能把它计作已通过的真实数据验证。

## 交付运行记录

日期：2026-08-24。基线提交前执行结果：

- 普通 `npm test`：20 tests，19 passed，0 failed，1 skipped；skipped 项为未配置的开发机真实样本。
- 设置 `CODEX_MONITOR_REAL_FIXTURE` 后 `npm test`：20 tests，20 passed，0 failed，0 skipped，约 0.33 秒。
- `npm run check`：通过，4 个关键 JavaScript 入口均无语法错误。
- `git diff --cached --check`：通过，staged 基线无空白错误。
- 真实样本：已执行并通过；五个 total token 均匹配，SHA-256 前后相同。

本节必须根据命令输出更新，不接受推测值。

## 手工验收

1. 启动服务，确认只监听 `127.0.0.1`，使用一次性 URL 进入页面。
2. 搜索并选择有子智能体的会话，确认 agent tree、任务数、质量状态和六类 token 可见。
3. 展开任务，确认预览最多 120 字；数据库 schema 中无正文列。
4. 向选中 rollout 追加脱敏完整测试记录，确认 2 秒内收到 SSE snapshot；随后恢复测试环境。
5. 验证窄屏页面仍可选择会话、展开任务并查看额度/健康状态。
6. 对源 `.codex` 文件执行验证前后哈希比较。

手工操作不得修改真实 rollout。需要追加测试时使用临时 Codex home 和脱敏 fixture。

## 证据解释

自动化测试证明 parser 对已覆盖结构的行为、数据库内容边界和 HTTP 安全控制。它不证明 rollout 是长期稳定公共格式，也不证明客户端 token 差分等于服务端账单。页面的数据质量标签和 [架构证据边界](ARCHITECTURE.md#官方证据边界) 必须保留这些限制。
