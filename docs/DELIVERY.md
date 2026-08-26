# v0.1.0 交付说明

**交付日期：** 2026-08-24

**项目路径：** 仓库根目录

**状态：** MVP 可本地运行

**运行要求：** Windows、Node.js 24+

## 交付范围

本版本交付一个只读、仅本机可访问的 Codex 子智能体用量监控器。它能发现根会话及递归子智能体，把累计 token 快照归因到单个 `thread_id + turn_id` 任务，持久化派生结果，并通过中文页面实时展示。

已交付：

- 会话索引、父子关系与归档 rollout 发现。
- 单/多/嵌套子智能体和同一智能体多任务归因。
- 六类 token、任务边界、状态、时间、模型、effort 与质量标签。
- 自身/含后代汇总，账号级额度快照，解析健康信息。
- 文件增量 tail、轮询 reconciliation、SSE 实时推送。
- SQLite WAL 存储和重启后的历史可见性。
- 按需原始指令预览，内容不缓存、不落库。
- loopback、一次性令牌、Strict Cookie、Host/Origin、CSP 和只读方法保护。
- 自动化测试、真实历史回归、交付文档、ADR 与 Git 基线。

## 启动与停止

```powershell
cd C:\path\to\codex-usage-monitor
npm start
```

服务输出一次性访问 URL 并打开浏览器。按 `Ctrl+C` 安全关闭 HTTP 服务、文件监听器和 SQLite 连接。更完整的配置、备份和故障处理见 [OPERATIONS.md](OPERATIONS.md)。

## 验收基准

标准验收命令：

```powershell
npm test
npm run check
```

开发机真实样本通过环境变量显式提供，不把用户名、session UUID 或 rollout 路径写入仓库：

```powershell
$env:CODEX_MONITOR_REAL_FIXTURE = 'C:\path\to\audited-rollout.jsonl'
npm test
```

期望的五个任务总 token 依次为：

```text
1,081,772 / 765,891 / 2,230,918 / 1,144,641 / 482,917
```

测试在解析前后比较源 rollout 的 SHA-256，证明该文件没有被监控器修改。样本不随仓库分发；其他机器会把该项明确标记为 skipped。最新一次执行结果记录在 [VERIFICATION.md](VERIFICATION.md)。

## 数据和恢复

- 默认派生数据库：`data\usage.sqlite`，其 WAL/SHM 文件和工具缓存均被 Git 忽略。
- 原始 `.codex` 数据不属于交付物，监控器不会备份或修改它。
- 原日志删除后，已导入任务用量仍在 SQLite 中；指令预览会显示不可用。
- 需要完全重建派生数据时，先停止服务，备份后删除监控数据库文件，再重新启动并选择会话回填。不要删除 `.codex` 数据。

## 已知限制

- 第一版只支持当前 Windows 本机数据和一个浏览器会话，不处理远程机器或多账号合并。
- Rollout 是内部可回放格式，不是稳定公共 API；未知字段被容忍，但新事件语义仍可能需要适配。
- 监控器只完整解析当前选择的根会话；未选择会话只有索引级信息，已导入历史仍保留。
- `complete` 是客户端可审计边界完整，不是账单级逐请求 usage。
- 额度与 token 没有官方证明的一一换算；页面展示的 USD 仅来自逐任务可审计 token 明细与版本化标准 API 价目，不把账号额度换算为费用，也不声称是 Codex 订阅实际扣费。
- 未集成 App Server、Hooks 或 OpenTelemetry，原因记录在 [ADR-0001](decisions/0001-read-only-rollout-observer.md)。

## 前端后续交接

当前前端视觉工作位于 `codex/project-grouping-claude-redesign` 分支。Phase 8 已完成编辑式账页与连续 Agent 谱系，Phase 9 已完成 Typography v1；后续视觉优化必须按 `AGENTS.md` 的“一项视觉决策一个 Git commit”规则继续。

下一位智能体开始修改 `public/**` 前，应先阅读 [Frontend Handoff](FRONTEND-HANDOFF.md)。该文档记录精确 Git 基线、已冻结视觉/字体契约、Phase 9 后续顺序、浏览器验收协议和禁止越界修改的后端/安全边界。

## 下一阶段交接：Request Ledger 双账本验证

当前任务 token 仍以 `total_token_usage` 的任务边界差分为正式事实源。2026-08-26 对本机历史 rollout 做了一次只读 Request Ledger 可行性实验，结果显示：把 `last_token_usage` 视为“最近一次新增模型 usage”，再用累计 `total_token_usage` 做逐字段一致性校验和去重，可以恢复当前任务边界算法因累计 generation 重置而丢失的可审计用量；但在完成双账本回归前，不得直接用裸 `SUM(last_token_usage)` 替换现有实现。

实验基线：

- 扫描 `412` 个 rollout、`42,159` 条 `token_count`。
- 识别 `1,726` 条累计值完全不变的重复广播；这些事件不得重复计量 `last_token_usage`。
- 在兼容历史 schema（旧记录可能缺少 `cache_write_input_tokens`）后，得到 `40,388` 个可由累计值逐字段验证的新增 usage 单元；对已有前序累计值的有效增长事件，未观察到 `Δtotal_token_usage != last_token_usage` 的真实异常。
- 另有 `45` 条文件首记录无法仅凭单文件证明，其中多数表现为 `total_tokens = 0` 且 `last_token_usage > 0`；必须保留为 `unverified` 或通过同一 thread 的跨文件前序状态继续验证，禁止猜测计入。
- Request Ledger 对 2026-08-22 / 08-23 / 08-24 的可审计总量分别为 `60,289,305` / `64,066,930` / `175,486,562`。前两日与用户提供的 Profile `61,819,000` / `65,058,000` 仍分别相差约 `2.47%` / `1.52%`；08-24 与此前约 `180,000,000` 的 Profile 值相差约 `2.51%`。这些差额不得用补偿系数抹平。

2026-08-26 实施进度：Phase 13 Task 1–3 已完成。分类器、SQLite schema v9 `model_usage_events` 和同一 thread 的跨 rollout cumulative continuity 已落地；旧 v8 session 会在首次升级时安全 replay 一次建立完整 Request Ledger，现有 Task Boundary Ledger、Timeline 和页面统计口径仍保持不变。Task 3 固化了 chronological replay / terminal-tail 规则：同一 thread 只有时间上最后一个 rollout 可以增量 tail；旧文件增长、截断、同大小重写或晚发现的更早文件都会让整个 thread 进入安全 replay，而不会在未来 baseline 上继续分类。真实 412 个 rollout 的临时 backfill 仍为 42,183 条事件、40,389 verified、1,726 duplicate、68 unverified、0 anomaly，数据库约 31.4 MB、冷构建约 23.2 s；相对逐文件独立实验多验证出的 1 条 file-first 事件现已由 deterministic multi-file fixture 明确证明，不作为补偿值处理。

下一阶段实施顺序固定如下：

1. **冻结 usage-event 分类契约。** 用 fixture 和真实历史验证 `verified_increment`、`duplicate`、`generation_start`、`unverified`、`anomaly`；逐字段比较 input / cached input / cache-write input（字段存在时）/ output / reasoning / total，而不是只比较 total。
2. **建立双账本。** 新增内部 `model_usage_events` / Request Ledger，但保留现有 Task Boundary Ledger。Request Ledger 的单元语义是“经累计快照证明的新增模型 usage”，不是底层 HTTP 请求；产品层可显示“模型请求”，内部不得假定与网络请求一一对应。
3. **跨文件保持 thread usage continuity。** 同一 `thread_id` 的累计状态不能被 rollout 文件边界截断；文件首记录只有在能由前序 generation 或 `total == last` 的新 generation 规则证明时才可计入。
4. **生成 reconciliation report。** 对每个 complete task 验证 `Σ verified request usage == boundary deltaUsage`；reset / missing-baseline 任务单独列出 Request Ledger 可恢复值；重复广播必须为零增量；无法证明的记录必须保持质量标签而不是补值。
5. **通过门槛后再切换事实源。** 只有完整测试、真实历史回放、增量 tail、SQLite 重启恢复、跨文件 continuity 和日期聚合均通过，才允许用 Request Ledger 聚合 Task / Agent / Session / Day；旧边界算法至少保留一个迁移期作为一致性审计器。
6. **记录架构决策和迁移证据。** 新 ADR 应 supersede ADR-0002 中“任务边界累计差分是唯一主计量方式”的部分，但继续保留“不裸累加 `last_token_usage`”“不把 Profile 当本地 ground truth”“未知数据不伪造精确值”等不变量。

详细任务拆分和验收条件见 [`tasks/plan.md`](../tasks/plan.md) 的 **Phase 13: Verified Request Ledger and dual-ledger reconciliation**。

## 交付核对

- [x] 源码、静态页面和测试在独立项目目录中。
- [x] Git `main` 基线和忽略规则包含在交付中。
- [x] README、交付、架构、API、运维、验证、路线图、CHANGELOG 和 ADR 已提供。
- [x] 项目级 `AGENTS.md` 定义多智能体角色、所有权、并行边界和交接格式。
- [x] 数据口径、隐私边界和真实样本证据已明确区分。
- [x] 前端视觉迭代已提供独立接手文档与逐决策版本控制规则。
- [x] Request Ledger 可行性实验、风险边界和下一阶段双账本迁移计划已写入交付文档；尚未声明 Request Ledger 已成为正式统计事实源。
