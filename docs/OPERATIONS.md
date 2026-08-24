# 运行与故障处理

## 启动

```powershell
cd C:\path\to\codex-usage-monitor
node --version
npm start
```

Node 版本必须为 24 或更高。服务优先监听 `127.0.0.1:47832`；如被占用，会顺序尝试到 `47842`。终端输出的 URL 含一次性令牌，只应在本机浏览器打开。

不自动打开浏览器：

```powershell
npm run start:no-open
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_MONITOR_HOME` | `%USERPROFILE%\.codex` | 只读 Codex 数据源 |
| `CODEX_MONITOR_PORT` | `47832` | 首选 loopback 端口 |
| `CODEX_MONITOR_DB` | `<project>\data\usage.sqlite` | 派生 SQLite 路径 |

示例：

```powershell
$env:CODEX_MONITOR_PORT = '49000'
npm run start:no-open
```

## 停止与重启

在运行终端按 `Ctrl+C`。进程会停止 watcher 和 timer、关闭 HTTP 服务与 SQLite。每次启动都会生成新的随机 token/Cookie；旧浏览器 Cookie 对新进程无效。

## 健康检查

在已完成一次性 token 交换的浏览器会话中访问 `/api/health`。关注：

- `status`：`healthy` 或 `warning`。
- `liveWatching`：文件观察或轮询是否工作。
- `lastUpdateAt`：选择会话最近解析时间。
- `repository`：发现的 sessions、rollout files、state DB 和索引错误。
- `storage`：schema/parser 数据和 cursor 状态。
- `parser`：坏行、尾部 partial bytes、跳过/未知记录、discontinuity，以及重启时 restored/replayed 文件数。
- `recentErrors`：最近最多 5 条本地异常。

页面额度卡超过 5 分钟会显示可能过期；这通常表示最近没有新的 rate-limit 记录，并不自动代表账号异常。

## USD 价目维护

进程不会联网获取价格。`src/pricing.js` 内的标准 API 短上下文价目表带 `version`、`capturedAt` 和 `reviewAfter`；页面在复核日期后显示“价目待复核”，但不会静默切换或猜测新价格。

更新价目时：

1. 只使用 OpenAI 官方模型/定价页面，逐项核对 input、cached input、cache write 和 output。
2. 更新价目版本、抓取/复核日期和来源 URL；不要覆盖不再适用的历史证据而不记录变更。
3. 同步 [ADR-0007](decisions/0007-versioned-api-equivalent-cost.md)、API 文档和 CHANGELOG。
4. 为每个变更模型更新精确分项测试，然后运行 `npm test`、`npm run check` 和桌面/窄屏浏览器验收。

价格显示始终是当前标准 API 等值，不是 Codex 订阅实际扣费。不要从 `rate_limits`、plan type 或账号额度百分比反推美元。

## SQLite、备份和重建

默认数据库使用 WAL，运行时可能同时出现：

```text
data\usage.sqlite
data\usage.sqlite-wal
data\usage.sqlite-shm
```

备份前先停止服务，再复制这三个文件中实际存在的文件。不要只在进程运行时复制主文件。

完全重建派生数据：

1. 停止监控器。
2. 把 `data\usage.sqlite*` 移到项目外的备份目录。
3. 重新启动监控器。
4. 在页面中选择需要回填的根会话。

此操作不应触碰 `%USERPROFILE%\.codex`。记录默认无限期保留；当前没有自动清理策略。

## 常见问题

### 页面显示 401

重新运行启动命令，并使用终端最新输出的完整 token URL。一次性 URL 成功兑换后会重定向到 `/`。

### 显示“Host/Origin 不受信任”

只使用服务输出的 `127.0.0.1` 或同端口 `localhost` 地址，不要通过局域网 IP、代理、iframe 或其他网页跨源调用。

### 会话存在但没有任务

先确认选中的是根会话、对应 rollout 仍存在，并查看 `/api/health` 的 repository/parser 信息。未选择的会话只完成索引；第一次选择才做完整解析。

### 实时更新延迟

正常目标是追加完整 JSONL 行后 2 秒内。若 `fs.watch` 丢事件，1 秒轮询应补偿；若仍未更新，检查源文件是否位于 `sessions` 或 `archived_sessions`、尾行是否已有换行，并查看 recent errors。

### 指令预览不可用

用量可以来自 SQLite 历史，但预览必须实时读取原 rollout。日志已删除、移动且索引未刷新，或无法从 `agent_path` 与协作信封证明父→子路由时，会明确不可用；子智能体回复不会作为 fallback。这是内容最小化设计，不是数据丢失。

### USD 显示“不可估算”或与实际账单不同

任务必须同时有受支持的官方模型映射和一致的 input/cached/cache-write/output 差分才能估算。内部 alias、未知模型、total-only 增长或字段缺失会显示不可估算，不会套用相近模型价格。

即使有金额，它也只代表价目表版本对应的标准 API 短上下文等值。Codex 订阅、超过 272K input 的请求、Fast/Batch/Flex/Priority、区域处理和收费工具调用可能采用不同口径，不能用该字段对账。

### 端口全部被占用

设置其他 `CODEX_MONITOR_PORT` 后重启。服务会从该值起尝试 11 个连续端口。

## 升级

升级前停止服务并备份派生 SQLite。检查 [CHANGELOG](../CHANGELOG.md) 和 [ADR](decisions/README.md) 是否包含 schema/parser 变化；运行 `npm test` 和 `npm run check` 后再启动。任何升级都不应要求修改 `.codex/config.toml`。
