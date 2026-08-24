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
- 任务模型/effort 跨 SQLite reopen 保留；标准 API USD 估算覆盖缓存读、GPT-5.6 cache write、输出、alias/snapshot、未知模型、total-only 与价目复核状态。
- session API 为每个任务附加 `costEstimate`，为智能体返回自身/含后代汇总，为会话返回完整/仅子智能体汇总，并保留 partial/unavailable 覆盖数与版本化 `pricing` 元数据。
- 会话标题不进入派生数据库。
- 启动 token、Strict Cookie、Host/Origin 和只读 HTTP 边界。
- CSP 下静态页面和脚本不依赖 inline style。
- 开发机五任务真实样本及源文件 SHA-256 不变。

`npm run check` 对服务、监听器、parser、pricing 和浏览器脚本执行 Node 语法检查。

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

日期：2026-08-24。加入逐任务模型强度、USD 等值估算及智能体/会话费用汇总后的执行结果：

- 普通 `npm test`：25 tests，24 passed，0 failed，1 skipped；skipped 项为本轮未配置 `CODEX_MONITOR_REAL_FIXTURE`。
- `npm run check`：通过，5 个关键 JavaScript 入口均无语法错误。
- `git diff --check`：通过。
- 真实浏览器桌面验证：1280×720，历史 6 智能体会话显示会话总计 `≥$41.329`、`16 已估算 · 1 不可估算`，6 张智能体卡均显示自身/含后代 USD；浏览器 error/warn 为 0。
- 真实浏览器窄屏验证：390×844，页面无文档级横向溢出（375px document / 375px viewport），6 张智能体卡仍显示两类 USD；任务表保持独立横向滚动（317px viewport / 1240px content）。
- 只读复核：浏览器解析前后，所选根会话及 5 个子智能体的 6 个 rollout SHA-256 逐一一致。
- 本轮真实五任务 parser fixture：skipped；未把此前交付记录表述为本轮已执行。

本节必须根据命令输出更新，不接受推测值。

## 手工验收

1. 启动服务，确认只监听 `127.0.0.1`，使用一次性 URL 进入页面。
2. 搜索并选择有子智能体的会话，确认 agent tree、任务数、质量状态、六类 token、任务模型、effort、智能体自身/含后代 USD 和会话总计 USD 等值可见。
3. 悬停 USD 单元格，确认能看到价目模型/单价以及“不等于 Codex 订阅扣费”的限制；未知模型显示不可估算。
4. 展开任务，确认预览最多 120 字；数据库 schema 中无正文列。
5. 向选中 rollout 追加脱敏完整测试记录，确认 2 秒内收到 SSE snapshot；随后恢复测试环境。
6. 验证窄屏页面仍可选择会话、横向查看完整任务表、展开任务并查看额度/健康状态。
7. 对源 `.codex` 文件执行验证前后哈希比较。

手工操作不得修改真实 rollout。需要追加测试时使用临时 Codex home 和脱敏 fixture。

## 证据解释

自动化测试证明 parser 对已覆盖结构的行为、数据库内容边界、定价公式和 HTTP 安全控制。它不证明 rollout 是长期稳定公共格式，也不证明客户端 token 差分或 API 等值等于服务端/Codex 订阅账单。页面的数据质量标签、USD 限制和 [架构证据边界](ARCHITECTURE.md#官方证据边界) 必须保留。
