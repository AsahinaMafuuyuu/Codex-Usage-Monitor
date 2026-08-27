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
| `CODEX_MONITOR_HOME` | 当前 Windows 用户的 `.codex` | 只读 Codex 数据源；旧值不存在时自动回退当前用户目录并告警 |
| `CODEX_MONITOR_PORT` | `47832` | 首选 loopback 端口 |
| `CODEX_MONITOR_DB` | `<project>\data\usage.sqlite` | 派生 SQLite 路径；相对值始终从工程根解析 |

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

进程不会联网获取价格。`src/pricing.js` 内维护不可变 Historical Rate Catalog；resolver 按 `model + event.observedAt` 选择唯一有效区间，并由 policy version 决定 long-context / Fast / cache-write 语义。历史记录不能通过覆盖“当前价格”来回写。

更新价目时：

1. 只使用 OpenAI 官方模型/定价/订阅计量材料，核对 effective interval、input/cached/output 以及 feature multiplier。
2. 新价格新增 interval，不修改已发生历史区间；gap/overlap 必须让测试失败，而不是选最近价。
3. 同步 [ADR-0019](decisions/0019-request-level-subscription-standard-cost.md)、DESIGN、API 文档和 CHANGELOG。
4. 更新 T-COST historical/feature fixtures，然后运行 `npm test`、`npm run check`、`git diff --check` 和桌面/窄屏浏览器验收。

价格显示始终是 **Subscription Standard-Rate Equivalent**，不是 Plus 实际扣费。不要从 `rate_limits`、plan type 或账号额度百分比反推美元。

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

## Windows 跨用户 / 跨盘迁移

schema v8 的 durable locator 不再包含旧机器用户名或盘符。迁移推荐流程：

1. 旧电脑停止监控器，确保 SQLite 正常关闭并完成 WAL checkpoint。
2. 复制整个 `codex-usage-monitor` 工程目录，至少保留 `data\usage.sqlite`；若停止后仍存在 `usage.sqlite-wal` / `usage.sqlite-shm`，一起复制。
3. 把原 `.codex` 历史复制到新 Windows 用户标准位置 `%USERPROFILE%\.codex`，或者放到任意位置后设置 `CODEX_MONITOR_HOME`。
4. 在新位置执行 `npm install`（如依赖目录未复制）和 `npm start`。
5. 查看 `/api/health`：无变化的 rollout 应直接匹配原 `source_key`；只有新增、收缩或完整性校验失败的文件才需要 tail/replay。

例如以下迁移不会改变 rollout identity：

```text
旧：C:\Users\OldUser\.codex\sessions\2026\08\25\rollout-abc.jsonl
新：D:\Profiles\NewUser\.codex\sessions\2026\08\25\rollout-abc.jsonl

DB source_key：sessions/2026/08/25/rollout-abc.jsonl
```

数据库默认随工程移动，所以 `C:\tools\codex-usage-monitor` 搬到 `D:\apps\codex-usage-monitor` 后仍使用新工程目录内的 `data\usage.sqlite`。`CODEX_MONITOR_DB` 可以选择工程内的其他相对位置；若用户环境变量仍指向旧工程或其他工程外绝对路径，CLI 会回退当前工程的 `data\usage.sqlite` 并输出 warning，避免迁移后重新绑定旧盘符。

程序不会遍历所有盘符寻找 `.codex`。标准当前用户路径自动发现；自定义位置用 `CODEX_MONITOR_HOME` 明确指定。若旧环境变量已经失效，启动会回退当前用户 `.codex` 并在终端报告 warning。运行期间改变 Codex home 后应重启监控器，让 watcher 和 source-key resolver 一次性切换到新根目录。

`projectPath` 是历史 session 的原始 `cwd`，因此迁移后仍可能显示旧盘符。这是有意保留的审计元数据，不参与 rollout 定位，也不需要为迁移批量重写。

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

用量可以来自 SQLite 历史，但预览必须实时读取原 rollout。schema v8 会先用任务 `sourceKey` 绑定当前 Codex home，因此单纯换用户名/盘符不会使 preview 继续指向旧绝对路径。日志已删除、source key 无法绑定，或无法从 `agent_path` 与协作信封证明父→子路由时，会明确不可用；子智能体回复不会作为 fallback。这是内容最小化设计，不是数据丢失。

### USD 显示“不可估算”或与实际账单不同

费用必须有 verified Request Ledger usage、事件发生时可解析的历史模型价，以及对应 request pricing evidence。service tier 缺失会保留基础金额但降低为 partial；未知模型、历史价 gap、矛盾 usage 或不支持的 Fast+long-context 组合不会猜测。

长上下文只按单个 verified usage unit 的 `input >272K` 判定；Fast/priority 只按 event-level service tier 应用。即使 coverage 完整，金额也只是订阅标准价等值，不是 Plus invoice；区域处理和收费工具仍未纳入当前 policy。

### 端口全部被占用

设置其他 `CODEX_MONITOR_PORT` 后重启。服务会从该值起尝试 11 个连续端口。

## 升级

升级前停止服务并备份派生 SQLite。检查 [CHANGELOG](../CHANGELOG.md) 和 [ADR](decisions/README.md) 是否包含 schema/parser 变化；运行 `npm test` 和 `npm run check` 后再启动。任何升级都不应要求修改 `.codex/config.toml`。
