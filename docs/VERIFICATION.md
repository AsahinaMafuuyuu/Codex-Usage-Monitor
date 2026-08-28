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
- SQLite schema v1–v5→v6 迁移、根会话 `project_path` 保留、cursor 恢复 active task、任务间累计 baseline、不可信 cursor 全量回放和 warning/discontinuity 跨重启保留。
- 原 rollout 消失后，派生任务与汇总在重启后继续保留，预览明确不可用。
- 未完成 JSONL 尾行保留到下一次读取。
- 未知/跳过格式进入健康 warning，父→子预览不会被子智能体回复覆盖。
- SQLite 中任务用量持久化且 schema 不含 prompt/preview/content/message 字段。
- 任务模型/effort 跨 SQLite reopen 保留；标准 API USD 估算覆盖缓存读、GPT-5.6 cache write、输出、alias/snapshot、未知模型、total-only 与价目复核状态。
- session API 为每个任务附加 `costEstimate`，为智能体返回自身/含后代汇总，为会话返回完整/仅子智能体汇总，并保留 partial/unavailable 覆盖数与版本化 `pricing` 元数据。
- 会话列表和 snapshot 返回根 `projectPath`，子智能体目录不会覆盖工程归属；静态 UI 契约覆盖工程分组、三级缓存命中率和已移除的指令列。
- 会话标题不进入派生数据库。
- 启动 token、Strict Cookie、Host/Origin 和只读 HTTP 边界。
- CSP 下静态页面和脚本不依赖 inline style。
- 静态界面契约覆盖暖色设计 token、工程上下文、递归 branch/children、reviewer/test-worker 角色样式、固定表格 colgroup、tabular numerals 和 reduced-motion。
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

### 工程分组与缓存可见性增量复核

日期：2026-08-24。加入根工程目录分类、会话输入/输出/总缓存命中率、智能体/任务命中率并移除指令列后的执行结果：

- 普通 `npm test`：26 tests，25 passed，0 failed，1 skipped；skipped 项为本轮未配置 `CODEX_MONITOR_REAL_FIXTURE`。
- `npm run check` 与 `git diff --check`：通过。
- 真实浏览器桌面验证：1440×900，260 个会话形成 41 个唯一完整工程路径组；Windows 普通路径与 `\\?\` 扩展路径不再重复分组。页面显示会话输入、输出和总缓存命中率，6 个智能体及其任务表均显示命中率，指令表头不存在，文档级横向溢出为 0。
- 真实浏览器窄屏验证：390×844，文档级横向溢出为 0；330px 工程抽屉可打开且保留全部 41 组，任务表在 317px 可视区域内保持 1320px 独立横向滚动。
- 浏览器控制台：0 error、0 warning。
- 只读复核：所选稳定历史会话的 6 个 rollout 在浏览器解析前后 SHA-256 逐一一致。
- 本轮真实五任务 parser fixture：skipped；未把此前交付记录表述为本轮已执行。

### 编辑式谱系界面增量复核

日期：2026-08-24。完成 Claude 启发的暖色编辑式界面、可折叠工程索引、连续智能体谱系、显式角色标签和固定表格布局后的执行结果：

- 普通 `npm test`：26 tests，25 passed，0 failed，1 skipped；skipped 项为本轮未配置 `CODEX_MONITOR_REAL_FIXTURE`。
- `npm run check` 与 `git diff --check`：通过。
- 真实浏览器桌面验证：1440×900，概览七项按 `4 + 3` 等宽分栏，无圆角指标/智能体卡片，页面横向溢出为 0；当前工程是 41 个工程组中唯一展开项。
- 拓扑与角色验证：用户截图对应的历史会话显示 7 个智能体、连续递归谱系轨、1 个 `REVIEWER` 和 1 个 `TEST-WORKER`；两类角色分别使用可区分的紫灰与鼠尾草绿语义样式。
- 表格验证：每个智能体任务表使用相同 14 列固定宽度；抽查前六列分别为 160、76、125、82、150、72px，文本首列左对齐、数值列右对齐并使用 tabular numerals。
- 真实浏览器窄屏验证：390×844，概览为 169px 双列，智能体统计为约 151px 双列，页面横向溢出为 0；340px 工程抽屉可用，1390px 任务表在 339px 容器内独立横向滚动。
- 可访问性验证：工程 `summary` 键盘聚焦时出现 2px clay 焦点环；静态契约保留 `prefers-reduced-motion`。
- 浏览器控制台：0 error、0 warning。
- 只读复核：角色验收会话的 7 个 rollout 在浏览器解析前后 SHA-256 逐一一致。
- 本轮真实五任务 parser fixture：skipped；未把此前交付记录表述为本轮已执行。

### Typography hierarchy v1 增量复核

日期：2026-08-24。按 ADR-0010 重新划分 serif / sans / monospace 职责、移除 8–9px UI 文本并收敛超大标题后的执行结果：

- 普通 `npm test`：26 tests，25 passed，0 failed，1 skipped；skipped 项仍为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的开发机真实样本。
- `npm run check` 与 `git diff --check`：通过；静态 UI 契约额外验证 typography tokens、无 `8px` / `9px` font declaration，以及 eyebrow/role/table header 使用 sans、任务数据使用 monospace。
- 真实 Chrome 桌面渲染：CDP 视口 1440×900，document width 1440，无文档级横向溢出；Session 标题实际计算为 48px，Section 标题 36px，eyebrow / role / task header 为 11px，任务数据为 11px，长标识为 10px。
- 真实 Chrome 窄屏渲染：CDP 视口 390×844，document width 375；Session 标题按响应式 clamp 为 39px，概览仍为 169px 双列、智能体统计约 151px 双列；可见任务表容器 339px、内容 1390px，`overflow-x: auto` 独立滚动保持有效。
- 实际平台字体核对：中文 Section 标题由 Chrome 报告为 `Noto Serif SC`，eyebrow 为 `Segoe UI`，Agent 标识为 `Cascadia Code`，与 ADR-0010 的实体 / UI / identifier 职责一致。
- 浏览器重新加载后捕获的 console warning / error 与 Runtime exception 均为 0。

### Phase 9 Decision 2：深层谱系 gutter 增量复核

日期：2026-08-24。只收敛 Agent lineage 的 rail offset、elbow connector 与对应窄屏值，不改变任务表列、Overview 或 Agent 展开策略。

- 普通 `npm test`：26 tests，25 passed，0 failed，1 skipped；skipped 项仍为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的开发机真实样本。
- `npm run check` 与 `git diff --check`：通过；静态 UI 契约新增 lineage geometry 约束，确认桌面 `18px + 14px` 与窄屏 `10px + 8px` 变量化实现。
- 真实 Chrome 桌面渲染：CDP 视口 1440×900，选取实际 7 Agent、最大 lineage depth 3 的历史会话；document width 1440，无文档级横向溢出。`.agent-children` 实际计算为 `margin-left: 18px`、`padding-left: 14px`、`border-left-width: 1px`，即每深入一级从原 54px 收敛到 32px。
- 真实 Chrome 窄屏渲染：CDP 视口 390×844，document width 375，无文档级横向溢出；同一会话仍渲染 7 Agent、最大 depth 3，`.agent-children` 实际为 `10px + 8px`，即 18px/层。
- 任务审计表保持原契约：桌面 `.task-table-wrap` 可视宽度 977px、内容 1390px；窄屏可视宽度 339px、内容 1390px；两者 `overflow-x: auto`，未将深层谱系优化扩散到 Decision 3。
- Chrome 捕获的 console warning / error 与 Runtime exception 均为 0。

### Phase 9 Decision 3：任务审计表横向浏览增量复核

日期：2026-08-24。只改善 14 列任务审计表的横向浏览上下文与滚动可发现性，不隐藏任何审计字段，也不改变 Overview 或 Agent 展开策略。

- 普通 `npm test`：26 tests，25 passed，0 failed，1 skipped；skipped 项仍为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的开发机真实样本。
- `npm run check` 与 `git diff --check`：通过；静态 UI 契约确认 `.task-table-wrap` 是可键盘聚焦的 `region`，Task / Status 分别使用 `left: 0` / `160px` sticky 定位，并保留 `prefers-reduced-motion`、Typography v1 与 lineage geometry 约束。
- 真实 Chrome 使用实际 **8 Agent / 18 Task** 历史会话验证。桌面 CDP 视口 1440×900，document `1440 / 1440` 无页面级横向溢出；任务表容器 `977px`、内容 `1390px`，`overflow-x: auto`。横向滚动 413px 后，Task 表头与首行仍保持容器内 `0px`，Status 表头与首行仍保持 `160px`，第三列已移动到 `-177px`，证明冻结上下文独立于滚动数据。
- 窄屏 CDP 视口 390×844，document `375 / 375` 无页面级横向溢出；任务表容器恢复并保持 `339px`、内容 `1390px`。横向滚动 620px 后 Task / Status 表头及首行仍分别固定在 `0px` / `160px`，第三列移动到 `-384px`；没有为窄屏隐藏 model、effort、token、cost 或 quality 字段。
- Chromium 计算的 WebKit 横向 scrollbar 高度为 `10px`；`.task-table-wrap` 的 `tabIndex=0`、`role=region`，aria label 明确说明“任务与状态列固定，可横向滚动查看完整 14 列”。
- Chrome 捕获的 console warning / error 与 Runtime exception 均为 0。
- 只读复核：对本轮 8 Agent 会话涉及的 9 个 rollout 在最终 Chrome 验收前后逐一计算 SHA-256，全部哈希完全一致；监控器未修改真实 `.codex` 历史。

### Calendar usage ledger and daily reconciliation

日期：2026-08-25。按主机本地时区 Asia/Shanghai 回放本机所有 root session 的 rollout，并按月、日、session 建立只读日期索引。

- 本地审计范围：261 个 root session、405 个 rollout 文件。2026-08-24 有 4 个 root session、35 个任务，未归属任务为 0。
- 昨日已知可审计总量：170,393,639 tokens；其中 input 169,604,230、cached input 165,259,520、output 789,409、reasoning output 267,285、cache write input 0。四个 root session 总量依次为 72,757,423、71,419,820、14,063,983、12,152,413。
- 质量覆盖：34 个 complete，1 个 discontinuity；没有 partial、estimated、provisional 或 unknown 任务。累计值倒退的任务未被伪造成精确差分，因此该数是本机 rollout 可证明的已知总量，不是账单级日总额。
- 已认证 GET /api/timeline 在首次打开时间视图时建立索引，返回倒序月、日和会话，并为每一层保留六类 token 与质量计数；工程视图、session snapshot 与 SSE 契约不变。
- 真实浏览器桌面验证：1280px 宽度下切换到“时间”后，2026年8月 -> 8月24日周一 可展开，日期节点显示约 1.7亿，有 4 个会话；页面无文档级横向溢出。现有工程视图和 session dashboard 均正常加载。
- 真实浏览器窄屏验证：390x844，document 宽度 375px，未出现页面级横向溢出；时间视图、月/日展开及会话条目仍可见。浏览器 console 为 0 error、0 warning。
- 只读复核：对 C:/Users/SishuoXie/.codex/sessions/2026/08/24 的 16 个 rollout 在页面验收前后计算 SHA-256，全部一致；监控器未改写真实 .codex 历史。
- 自动化验证：npm test 为 27 tests、26 passed、0 failed、1 skipped；唯一 skipped 是未配置 CODEX_MONITOR_REAL_FIXTURE 的既有真实五任务 fixture。npm run check 与 git diff --check 通过。

个人资料显示的约 180,000,000 与本地已知量相差 9,606,361（约 5.34%）。本实现不把个人资料数字当作校准值补齐差额：差异可能来自那条不可安全差分的任务、服务端日界或时区，以及本地 rollout 无法证明的服务端计量口径。日期索引只报告可由 total_token_usage 边界差分证明的本地观测，不代表 Codex 订阅扣费。

### Incremental calendar index and SQLite memory

日期：2026-08-25。Phase 11 将上述日期口径保持不变，但把 Timeline 的实现从全历史内存回放改为 SQLite schema v7 的 task/cursor ledger + `session_day_usage` 物化索引。性能验证均使用真实 `.codex` 作为只读来源；全新导入使用临时监控数据库，不改写 rollout。

- 旧基线：267 个 root session、408 个 rollout、约 1.23 GB JSONL；旧 Timeline 冷构建约 16–24 秒，构建过程额外 RSS 峰值约 156 MiB。任意 rollout 变化会使整份内存 Timeline 缓存失效。
- 全新临时 schema v7 数据库一次性 backfill：408 个 rollout 全部 replay，得到 2,340 tasks、408 cursors 和 279 个 session-day；耗时 18,016.3 ms。该路径仍会出现约 +165.02 MiB RSS 峰值，因此本轮不声称消除了“第一次导入全部历史”的内存成本；改造目标是让这项成本只发生一次。
- 同一临时数据库 backfill 后立即再次查询 Timeline：6.45 ms。另一次完全无 dirty session 的稳定热查询为 2.07 ms，1 ms RSS/heap 采样未观察到额外峰值。
- 已有 v7 索引但本机仍有活跃追加时，重启后的实际同步命中 13 个 dirty session、0 个 replay、49 个 cursor tail，Timeline 用时 36.62 ms；RSS 从 132.24 MiB 到 134.50 MiB，额外峰值约 2.26 MiB。说明正常增量路径与全部历史体积解耦。
- 全新临时数据库磁盘：主 SQLite 约 3.05 MiB；写入阶段 WAL 约 1.69 MiB；`session_day_usage` 表连同主键/查询索引约 72 KiB；tasks 表约 1.85 MiB。Timeline 后台补齐关闭历史 quota 批量持久化后，冷导入只保留 latest-quota 路径产生的 1 条 quota，而不是数千条历史快照。
- SQLite 运行约束实测：`page_size=4096`、`cache_size=-2000`（约 2 MiB）、`mmap_size=0`、`wal_autocheckpoint=256`。正常关闭执行 truncate checkpoint；测试中的 WAL 关闭后归零。
- 增量行为回归覆盖：无变化的第二次 Timeline 不 replay/tail；进程重启后未变化历史不 replay；向两个 session 中的一个 rollout 追加任务后，只同步该 root session，并命中 1 个 cursor tail / 0 replay。
- 最终自动化验证：`npm test` 为 30 tests、29 passed、0 failed、1 skipped；唯一 skipped 仍是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。

### Windows portable source locators / schema v8

日期：2026-08-25。Phase 12 将 rollout 的 durable identity 从机器绝对路径改为 `.codex` 相对 source key；真实 `.codex` 和当前 `data/usage.sqlite` 的兼容性检查均以只读方式执行，未在验证阶段迁移真实数据库。

- relocation fixture：同一 rollout + SQLite 先位于一个临时 `old-profile\.codex`，建立 cursor 后整体移动到另一个绝对 `new-drive\.codex`。第二次启动命中 `1 restored / 0 replayed`，Timeline 无 dirty session，证明仅绝对根路径变化不会使 cursor 失效。
- 同一 relocation fixture 的任务 preview 在移动后仍能读取父代理指令，证明 preview 通过 `sourceKey -> 当前 Codex home` 重绑定，而不是继续信任数据库中的旧 `source_path`。
- schema v7 迁移 fixture 保留原 task delta、`projectPath` 和 `session_day_usage`，同时把 session/agent/task/quota 的旧 `.codex` 绝对 locator 转为 portable key，并把旧 `rollout_path` / `source_path` 置空；quota payload 的 `sourcePath` 被删除并替换为 `sourceKey`。
- startup resolver fixture 验证：失效的 `CODEX_MONITOR_HOME` 会回退当前 Windows 用户 `.codex` 并返回 warning；有效自定义 home 继续优先使用；显式不存在的 API option 仍报错而不静默猜测。相对 `CODEX_MONITOR_DB` 和默认数据库均从工程根解析，工程外绝对环境变量会回退项目默认数据库。
- 当前真实 `data/usage.sqlite` 只读兼容性审计：`PRAGMA user_version=7`；267/267 session rollout paths、412/412 agent rollout paths、2,365/2,365 task source paths、6,569/6,569 quota source paths、418/418 cursor paths 均可确定转换为 source key，五类 locator 的不可转换数量均为 0。该命令只以 `DatabaseSync(..., { readOnly: true })` 查询，没有触发 schema v8 迁移。
- 最终自动化验证：`npm test` 为 34 tests、33 passed、0 failed、1 skipped；唯一 skipped 是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。

### Phase 13 Task 1：verified model-usage event classifier

日期：2026-08-26。新增独立 `classifyModelUsageEvent` 分类层，以累计 `total_token_usage` 验证 `last_token_usage`，但仍保留 Task Boundary Ledger 为正式聚合事实源；本任务没有切换 session/timeline 统计口径。

- fixture 覆盖 `verified_increment`、`duplicate`、`generation_start`、`unverified`、`anomaly`；历史 schema 缺少 `cache_write_input_tokens` 时只把该字段保留为不可验证 `null`，不会误判整个事件。
- `duplicate` 在检查 `last_token_usage` 前先按累计快照去重，因此重复广播不会重复计量上一请求；累计 rollback 只有在当前累计快照与 `last_token_usage` 逐字段一致时才视为可证明的新 generation，否则仍进入 anomaly/discontinuity 路径。
- `npm run audit:request-ledger` 对当前真实 `.codex` 扫描 412 个 rollout、42,183 条 `token_count`：40,040 个 `verified_increment`、348 个 `generation_start`、1,726 个 `duplicate`、69 个 `unverified`、0 个 `anomaly`，即 verified usage event 合计仍为 40,388。
- 与交付实验相比新增 24 条 `token_count` 全部属于 `missing_total_usage`；原有 `missing_baseline` 仍精确为 45，说明 `42,159 -> 42,183` 是新增未验证记录，而不是分类器改变历史结果。
- 同一只读回放仍得到 2026-08-22 / 08-23 / 08-24 的 60,289,305 / 64,066,930 / 175,486,562 tokens；412 个 rollout 扫描前后 SHA-256 全部一致（`hashChangedFiles=0`）。

### Phase 13 Task 2：privacy-safe Request Ledger / schema v9

日期：2026-08-26。SQLite 增加 `model_usage_events` 双账本，但 Task Boundary Ledger 继续作为迁移期正式聚合来源。

- durable event identity 为 `(source_key, line_number)`；同一 snapshot 连续 `replaceSession`、进程重启 cursor restore 和 portable Codex-home relocation 均验证事件数不增长、不重复插入。
- `model_usage_events` 只保存 portable source key、thread/turn、line/ordinal、时间、generation、classification/quality/reason 与六类派生 usage。schema 测试确认不存在 prompt/preview/content/message、`source_path` 或 `rollout_path` 字段。
- v8→v9 fixture 删除 Request Ledger 并把 session `parser_version` 回退为 8 后重启：session 明确为 `requestLedgerReady=false`，首次 Timeline 安全 replay 1 个 rollout，补建事件后切换为 ready；之后正常重启不重复 replay。
- `npm run benchmark:request-ledger` 使用临时 SQLite 对当前 412 个真实 rollout 做一次完整 backfill：42,183 条 `model_usage_events`、2,347 条 task，耗时约 22,705.81 ms；关闭后数据库 31,399,936 bytes（约 29.95 MiB / 十进制 31.4 MB）。page size 4096、`cache_size=-2000`、`mmap_size=0`、`wal_autocheckpoint=256` 保持既有内存/WAL 约束。
- session/thread 连续 parser 在该 backfill 中得到 40,389 verified、1,726 duplicate、68 unverified、0 anomaly；相比 Task 1“每文件重置 baseline”的只读实验多证明 1 条、少 1 条 unverified。该结果说明跨文件 continuity 确实存在可恢复信息，Task 3 必须用 deterministic multi-file fixture 固化其前序状态规则后才能进入 reconciliation。
- Task 2 最终自动化验证：`npm test` 为 37 tests、36 passed、0 failed、1 skipped；唯一 skipped 仍是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。

### Phase 13 Task 3：same-thread rollout continuity

日期：2026-08-26。Request Ledger 将 cumulative verifier 从“单文件状态”提升为“同一 thread 的连续状态”；文件边界与 generation 边界明确分离，仍不裸累加 `last_token_usage`。

- deterministic multi-file fixture 使用同一 `thread_id` 的两个 rollout，并故意逆序传入 discovery 结果；parser 按 rollout 时间顺序回放，首文件得到 `generation_start=100`，后续文件首条得到 `verified_increment=50`，证明文件切换不会丢失累计 baseline。
- cursor restore 在逆序 entries 输入下仍恢复两个 source 的正确任务路径和 terminal baseline；继续向第二个（terminal）rollout append 后得到单次 `verified_increment=30`，没有 replay 或重复插入。
- 非 terminal rollout 若后续增长，restore 会把该 thread 的全部 source 标记为 replay；实时发现一个时间上更早的同-thread rollout 时，`tailFile` 直接请求 rebuild，而不是把它接到当前未来 baseline 后面。
- 累计回退到 `total_tokens=0` 但 `last_token_usage>0` 的边界被明确保留为 `unverified / unproven_generation_start`；只有 `total == last` 等可验证零 baseline 才能成为 generation start。
- 真实 412 rollout 临时 backfill：42,183 event rows、2,347 task rows、40,389 verified、1,726 duplicate、68 unverified、0 anomaly；耗时 23,169.79 ms，关闭后 SQLite 31,399,936 bytes，page/cache/WAL 约束保持 `4096 / -2000 / 0 / 256`。该结果与 Task 2 的跨-thread连续 parser 基线一致，说明本轮没有制造新的历史分类异常。
- 最终自动化验证：`npm test` 为 41 tests、40 passed、0 failed、1 skipped；唯一 skipped 仍是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。

### Phase 13 Task 4：dual-ledger reconciliation

日期：2026-08-26。新增 `src/reconciliation.js` 与 `npm run reconcile:request-ledger`，在临时 schema v9 数据库中同时保留 Boundary Ledger 与 Request Ledger，并按 task / day 输出一致性、恢复和覆盖状态；该任务仍没有切换产品事实源。

- 首次全历史 reconciliation 暴露 1 个 Boundary `complete` task mismatch：Boundary `3,482,276` vs Request `5,092,923`。根因不是 Request Ledger 多算，而是已验证的 cumulative generation reset 没有继续把迁移期 Boundary task 标为 `discontinuity`。修复后该 task 与另外 3 个 reset task 都进入 `recovered`，parser anomaly/discontinuity health 不会把“已解释 reset”误报为未知异常。
- 最终全历史结果：412 rollout、267 session、2,347 task；1,335 `exact_match`、0 `schema_limited_match`、0 `mismatch`、4 `recovered`、1,008 `not_comparable`。`not_comparable` 主要是非 complete / 无完整 Boundary delta 的任务，不被当作失败或补值。
- Request Ledger coverage：40,389 verified、1,726 duplicate、68 unverified、0 anomaly，其中 38 个 verified event 没有 task attribution；duplicate 不进入精确总量，unverified 和 unattributed 单独报告。
- 日聚合精确复现审计基线：2026-08-22=`60,289,305`，08-23=`64,066,930`，08-24=`175,486,562`。该报告不读取或校准 Profile 数字。
- 独立 `npm run audit:request-ledger` 仍按单文件 baseline 得到 40,388 verified / 69 unverified，并确认 412 个真实 rollout 的 `hashChangedFiles=0`；跨文件 parser 比单文件审计多证明 1 条事件，差异与 Task 3 fixture 一致。
- reconciliation 单元测试覆盖 exact match、duplicate=0、历史缺字段的 schema-limited 状态、discontinuity recovery 和按本地日聚合。

### Phase 13 Task 5：Request Ledger primary aggregation / schema v10

日期：2026-08-26。通过 Task 4 双账本门槛后，schema v10 将 verified Request Ledger 提升为 Task / Agent / Session / Timeline、缓存命中率和 USD 等值估算的主用量来源；Boundary Ledger 字段仍原样持久化供独立审计。

- 定向回归覆盖：request-derived task/agent/session/calendar usage 与费用、verified model usage unit count、tokens/unit、同 task 存在 unverified 时只保留 verified 下限并降为 `partial`、增量 tail、进程重启、v8→v9 Request Ledger backfill，以及 v9→v10 只重建 aggregate 而 `replayedFiles=0`。定向组合为 9 tests / 9 passed / 0 failed。
- 全量自动化验证：`npm test` 为 50 tests、49 passed、0 failed、1 skipped；唯一 skipped 是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。
- schema v10 全历史 reconciliation：412 rollout、267 session、2,347 task；1,335 exact match、0 mismatch、4 recovered；Request Ledger coverage 仍为 40,389 verified / 1,726 duplicate / 68 unverified / 0 anomaly，另有 38 个 verified 但未归属 task 的 event。
- primary Timeline 保持既有“按 task `startedAt` 本地日期”API 语义；2026-08-22 / 08-23 / 08-24 主总量分别为 `60,289,305 / 64,066,930 / 175,486,562`，verified model usage units 为 `636 / 550 / 1,439`。没有为了与 Profile 对齐而应用补偿系数。
- 独立只读 classifier audit 再次扫描 412 个 rollout / 42,183 条 `token_count`，结果为 40,388 verified / 1,726 duplicate / 69 unverified / 0 anomaly，且 `hashChangedFiles=0`；它仍以单文件 baseline 审计，因此比跨文件连续 parser 少验证 1 条，差异与 Task 3 的 continuity fixture 一致。
- schema v10 临时全量 backfill benchmark：42,183 event rows、2,347 task rows，22,673.34 ms；关闭后 SQLite 31,399,936 bytes。`page_size=4096`、`cache_size=-2000`、`mmap_size=0`、`wal_autocheckpoint=256` 均未回归。
- `tasks.delta_usage/quality` 仍保存 Boundary Ledger；API 运行时另外返回 request-derived `deltaUsage/quality`、`boundaryDeltaUsage/boundaryQuality`、`requestLedgerCoverage` 与 request-count 指标，因此迁移证据没有被覆盖。
- 本轮没有修改 `public/**`；现有页面继续消费同名 `deltaUsage` / Agent aggregate / Session summary 字段，静态 UI 契约测试保持通过。新增 request-count 字段属于向后兼容 API 扩展，不要求页面立即展示。

### Phase 14：Boundary Ledger retirement / schema v11

日期：2026-08-26。迁移期 reconciliation 已完成后，按 ADR-0016 将 Boundary Ledger 从当前 runtime / SQLite / API / CLI 中退役。旧方案在修改前先以 annotated tag `usage-boundary-ledger-v1` 固定到 commit `4a38ba6`，因此历史实现仍可从独立 worktree 复核，但主线只维护 Request Ledger。

- schema v11 的 `tasks` 只保存任务身份、时间、模型/effort、portable source key 和 ordinal/line/byte 定位；`quality`、baseline/end、`delta_usage` 与全部 `delta_*` token 列已删除。`session_day_usage` 同时删除旧 Boundary 专属 `estimated_count` / `discontinuity_count`。
- v10→v11 migration regression 人工构造旧 Boundary 列和错误 calendar/agent aggregate 后重新打开数据库，确认旧列被物理删除、Request Ledger aggregate 恢复正确，且 `replayedFiles=0`，即退役旧方案不会让 request-ready session 重读 rollout。
- parser 不再计算 task boundary delta；`snapshot()` 直接由 `model_usage_events` 物化 `deltaUsage/quality/requestCount/requestLedgerCoverage`。verified generation reset 直接计入已证明 usage；无法解释 rollback 保留 anomaly/health evidence，task 只报告 verified lower bound 并降为 `partial`。
- API/runtime 不再返回 `boundaryDeltaUsage` / `boundaryQuality`；双账本 `src/reconciliation.js` 和 `npm run reconcile:request-ledger` 已删除。只读 `audit:request-ledger` / `benchmark:request-ledger` 保留。
- schema v11 真实历史只读 audit：412 rollout / 42,183 `token_count`；40,388 verified / 1,726 duplicate / 69 unverified / 0 anomaly，`hashChangedFiles=0`。该脚本按单文件 baseline 审计；跨文件连续 parser 仍为 40,389 verified / 68 unverified，与 Phase 13 已记录差异一致。
- schema v11 临时全历史 benchmark：412 rollout、2,347 task rows、42,183 event rows、40,389 verified / 1,726 duplicate / 68 unverified / 0 anomaly；26,148.19 ms，关闭后 SQLite `30,318,592` bytes。相比 schema v10 的 `31,399,936` bytes 少约 `1.08 MB`，同时保持 `page_size=4096`、`cache_size=-2000`、`mmap_size=0`、`wal_autocheckpoint=256`。
- 最终全量自动化验证：`npm test` 为 48 tests、47 passed、0 failed、1 skipped；唯一 skipped 是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的真实五任务 fixture。`npm run check` 与 `git diff --check` 均通过；文档契约测试同时验证 Superseded ADR 生命周期状态和相对链接完整性。

### 2026-08-25：Overview / task ledger / scrollbar / motion polish

本轮按用户指定顺序将视觉调整拆成独立提交；开始前在 clean HEAD `21daac7` 创建 `ui-polish-baseline-20260825` 标签，便于整轮回退和截图对照。

- `68ad758 feat(ui): group overview metrics by purpose`：Overview 改为 Activity / Token Flow / Cost 三个语义组；会话总计 USD 直接格式化 `amountUsd`，不再添加 `≥` 前缀，partial/unavailable 仍由 coverage 文案和 title 说明。
- `0a8dc58 refactor(ui): simplify task ledger presentation`：任务表移除独立 reasoning 列，主账页从 14 列 / 1390px 收敛到 13 列 / 1314px；所有 th/td 统一居中，Task/Status sticky 偏移保持 `0 / 160px`。
- `046b23d feat(ui): refine themed scrollbars`：页面与侧栏使用 8px warm-taupe vertical thumb，任务表使用 8px muted-clay horizontal thumb；不新增 `scrollbar-gutter`。
- `58a7eb2 feat(ui): add restrained navigation motion`：工程/日期/Agent `<details>` 使用 `::details-content` 过渡；会话与工程/时间导航在 Chrome 支持时使用 View Transitions API；`prefers-reduced-motion` 继续关闭实质动画。
- 每个功能提交前均执行 `npm test`、`npm run check` 与 `git diff --check`；最近一次结果为 27 tests / 26 passed / 0 failed / 1 skipped，唯一 skipped 为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的既有真实五任务 fixture。
- Headless Chrome 认证页面截图已成功生成：1440×900 desktop 与 390×844 narrow。该步骤证明当前静态资源、认证入口和页面脚本可在真实 Chrome 中加载；本轮未执行新的 CDP console/error 采样或精确 overflow 几何断言，因此不新增“0 warning / 0 overflow”类未验证结论。
- `.impeccable/` 中的浏览器 QA 工件保持忽略状态，不进入 Git；本轮没有修改 `.codex` 源文件，也没有把截图或运行时数据库纳入提交。

### Phase 15：实时交互稳定性增量复核

日期：2026-08-26。将 selected-session SSE snapshot 从 destructive render 改为 session / Agent / Task stable-key reconciliation，并对结构变化增加视觉锚点补偿。

- 全量 `npm test`：52 tests，51 passed，0 failed，1 skipped；唯一 skipped 为本轮未配置 `CODEX_MONITOR_REAL_FIXTURE` 的开发机真实五任务 fixture。
- `npm run check` 与 `git diff --check`：通过；静态 UI 回归新增 `live updates preserve keyed interaction containers instead of rebuilding them`，约束 `threadId` / `turnId` key、Agent summary/task row visual anchor、selected-session 导航原位更新以及禁止恢复旧的整树 `innerHTML` 路径。
- 真实 Chrome/CDP 回归通过。测试在页面加载前包装浏览器 `EventSource`，捕获应用实际注册的 `snapshot` listener 与最新 snapshot，再仅在浏览器内重复回放，不写入 rollout。普通 snapshot 前后 `.task-table-wrap` 与 `.agent-card` 均保持同一 DOM 实例；任务表 `scrollLeft` 保持 `354`，键盘 focus 保持在 `DIV.task-table-wrap`，Agent `details.open=true` 保持不变。
- 手工折叠同一 Agent 后再次回放 snapshot：仍为同一 `<details>`，`open=false` 保持，任务表横向位置仍为 `354`。
- 结构回归在浏览器内复制一条 Task 并临时插入当前可见 Task 之前；原 Task row DOM 继续存活。插入造成布局增加 66px，visual-anchor 逻辑同步将页面滚动补偿 66px，因此该 surviving Task 的 `getBoundingClientRect().top` 从 `0.40625px` 到 `0.40625px`，top delta 为 `0px`。随后回放原 snapshot 清除临时结构。
- 本轮浏览器结构数据和额外 spacer 都只存在于 QA 页面内存/DOM；未向 `.codex` 写入测试记录，也未把 Chrome profile、运行时 SQLite 或其他 QA 工件纳入仓库。

### Phase 16：Day-scoped Request Ledger snapshots / schema v12

日期：2026-08-26。按 `DESIGN-DAY-SCOPED-SNAPSHOT.md`、`TEST-DAY-SCOPED-SNAPSHOT.md` 与 ADR-0018 实现 Project=full session、Time=`(sessionId, local day)` 两套显式 snapshot scope，并把 Timeline 日期归属切换为 Request Ledger event `observedAt`。

- T-DAY-001~043：严格 `YYYY-MM-DD` 本地日期校验通过；`America/Los_Angeles` 2026-03-08 / 2026-11-01 分别验证 23h / 25h DST 日边界。确定性跨午夜 fixture 的 full/day1/day2 total token 为 `300 / 100 / 200`，六类 usage 字段逐项满足 `day1 + day2 == full`。duplicate 不增量，unverified/anomaly 降低 quality，未归属的 `999` token event 不进入 Task/Agent/Session 主统计。
- Task Day Slice 保留原 `startedAt` / `completedAt`，按目标日重新计算 `deltaUsage`、request count、coverage、quality 和 cost；生命周期跨日但当日无 usage 的 task 仍可形成 slice，没有时间字段但存在当天归属 event 的 task 也可形成 slice。Agent Day Slice 只保留相关 Agent 与必要祖先，并从当天 task 重建 own/subtree usage、request、task count 和 cost。
- 审查阶段新增 T-DAY-022 数据库回归：无 lifecycle timestamp、但有合法 `observedAt` 的 25-token task 只计入 2026-08-27 day slice 一次；Timeline 总量为 `325`、`unattributed=0`，避免旧 `started_at IS NULL` 路径重复计数。
- schema v12：新增 `(root_session_id, observed_at, classification)` 索引；Request Ledger `observed_at` 写入统一规范为 UTC ISO，v11→v12 同样规范化历史值后从已持久化 `tasks + model_usage_events` 重建 `session_day_usage`。迁移回归确认 `PRAGMA user_version=12`、Timeline 恢复正确且 `replayedFiles=0 / tailedFiles=0`，没有因日期语义迁移重放 Request-ready rollout。
- T-DAY-050~054：`GET /api/sessions/:id` 保持 full scope，总量 `300`；`?day=2026-08-26` / `?day=2026-08-27` 分别返回 `100 / 200`，非法 `2026-02-31` 返回 400。两天的 Timeline session usage、model request count 与 USD cost 均分别和 day snapshot 对账一致。
- T-DAY-060~062：day-scoped SSE listener 在只增加另一天 `25` token 后仍保持目标日 `100`；再给目标日增加 `10` token 后更新为 `110`；同一持久化状态下 full snapshot 为 `335`。证明 listener 后续更新按建立连接时 scope 重新物化，不把 full-session snapshot 泄漏给 day listener。
- T-DAY-070~073 静态 UI 契约覆盖 `selectedDay`、`data-session-day`、`?day=` snapshot/SSE、id+day active identity、Project↔Time scope 切换、stale selection version 防护，以及 Time live update 重新拉取 Timeline 时复用导航 interaction capture/restore。
- 真实 Chrome/CDP 验收通过：1440×900 下 task table `scrollLeft=357` 在 snapshot 后不变，focus 和 Agent 展开状态保持；结构插入造成页面 66px 布局变化时 visual anchor top delta 为 `0px`。实机 selected session 同时存在 `2026-08-27` 与 `2026-08-26`，Time 模式实际完成同 session 跨日切换，版本标签同步变更，随后 Project 模式恢复 full scope。切到 720×900 后 task table 仍保持水平 overflow，`scrollLeft=240`、focus 与 Agent 展开状态均不变。
- 全量自动化门槛：`npm test` 为 62 tests / 61 passed / 0 failed / 1 skipped；唯一 skipped 是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的可选真实五任务 fixture，因此 T-DAY-081 源文件哈希门槛本轮按测试计划记为 skipped。`npm run check` 与 `git diff --check` 均通过。
- 当前真实监控 SQLite（schema v12）热路径抽样：399 个 session-day、2,934 个 cost task-day slice；`getTimeline()` 约 `29ms`，按 event-day 物化 cost slices 约 `354ms`。该路径只读 SQLite，不扫描 rollout 正文；第一版逐 session/逐日重复过滤约 `596ms`，审查阶段已改为单次 event 分组后按 task/day 物化。
- 浏览器 QA 只读取本机现有 monitor/rollout，并在页面内存中回放/复制 snapshot；没有写 `.codex`。schema/API/privacy 回归继续确认数据库不新增 prompt、response、message 等正文列。

### Phase 17：Subscription Standard-Rate Cost / schema v13

日期：2026-08-26。按 `DESIGN-SUBSCRIPTION-STANDARD-COST.md`、`TEST-SUBSCRIPTION-STANDARD-COST.md` 与 ADR-0019 将旧 Task-level current API estimator 替换为逐 verified Request Ledger usage unit 的 Subscription Standard-Rate Equivalent。

- T-COST-001~013：Historical Rate Catalog、Terra/Luna 2026-07-30 切价、Sol 2026-08-21 promotion exclusion、GPT-5.4/5.5 历史有效期、cached input、reasoning 与 subscription-policy cache-write 语义通过。gap/unknown 不选择最近价。
- T-COST-020~034：`272000` 为 normal、`272001` 为 long；full-request input/cached 2×、output 1.5×；两个 200K request 的 Task aggregate=400K 不误触发 long。Fast multiplier 按模型族，missing tier 保持 partial，Fast+long-context 不叠乘。
- request-boundary evidence gate 以 bounded semantics 通过：verified Request Ledger usage unit 可作为 Codex model sampling usage boundary 使用 272K threshold；不宣称等于 HTTP invoice identity。duplicate `token_count` 仍必须由 cumulative advancement 去重。
- T-COST-033/060/061：同一 thread 内 `turn_context` model 与 `thread_settings_applied.service_tier` 按 event ordinal as-of 绑定，后续设置不会回写旧 request。schema v13 只持久化最小 `model/service_tier/pricing_context_quality`。
- T-COST-062~065：v12→v13 migration 前后 `classification + input/cached/cache-write/output/reasoning/total` 逐字段完全一致。原 rollout 存在时只读 enrichment pricing metadata，测试 SHA-256 前后相同；原文件不存在时 service tier/model pricing context 保持 unknown；新 schema 不保存正文或完整 settings payload。
- T-COST-040~052：Task cost 只等于 `Σ requestCost`；Agent own/subtree、Session total/subagent-only、Full/Day/Timeline 只汇总 request-derived summary。跨 2026-07-29/07-30 的 Terra fixture 分别得到 `$0.25 / $0.20`，完整 session `$0.45`，Timeline 与 day detail 一致。
- T-COST-070~073：API `basis=subscription-standard-equivalent`；Task/summary 暴露 request/task counts 与 historical-rate/request-boundary/service-tier coverage；UI 主数值不恢复 `≥`，title 明确 partial 为可证明部分而非 Plus 实际扣费；历史 recorded model 不被改写成当前模型。
- T-COST-080~083：新增 `npm run reconcile:subscription-cost` 只读 reconciliation CLI。脱敏 fixture 证明 subscription-policy、historical-rate、long-context、Fast adjustment 可分离且加总 delta=0，源 rollout 哈希不变。
- 真实历史 reconciliation：`425` rollout、`242` root session、`2,368` task、`41,089` verified usage unit、`5,223,166,739` verified token。`571` 个 usage unit 的 input `>272K`，合计 input `166,551,689`。
- 真实 service-tier inventory：`default=23,743`、`fast=0`、`priority=0`、`unknown=17,346`。因此真实 Fast adjustment 为 `$0`；unknown 不并入 default。未知/无历史价格 usage unit `301` 个，其中 `missing_model=92`、`historical_rate_unavailable=209`；`service_tier_unknown=17,289` 个 request 保留已知基础金额但降低 coverage。
- additive reconciliation subset 覆盖 `1,792` 个可比较 task：旧 current API equivalent `$2703.97106036`；subscription-policy adjustment `+$155.09507810`；historical-rate `+$50.84818823`；long-context `+$106.61941600`；Fast `$0`；新 subscription-standard equivalent `$3016.53374269`，`additivityDeltaUsd=0`。所有存在可证明新金额的 usage unit 合计 `$3087.22782329`。
- 真实 `.codex` 只读门槛：reconciliation 前后 425 个 rollout 全部 SHA-256 相同，`hashChangedFiles=0 / sourceReadOnly=true`。
- 真实 Chrome/CDP：1440px 常规 snapshot 前后 task wrap/Agent details DOM identity、`scrollLeft=357`、focus、展开状态保持；结构变化 visual-anchor top delta `0px`。720px 下横向 overflow 保持，`scrollLeft=240`、focus 与展开状态不变；同 session Time 跨日和 Project full-scope 恢复通过。
- 最终全量门槛：`npm test` 为 `86 tests / 85 passed / 0 failed / 1 skipped`；唯一 skipped 是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的可选五任务样本。`npm run check` 与 `git diff --check` 均通过；真实历史只读证据由上面的 425-file reconciliation 独立满足。

### Phase 18：Canonical Request Ownership / Request-Day Projection / schema v14

日期：2026-08-27。按 `DESIGN-CANONICAL-REQUEST-PROJECTION.md`、`TEST-CANONICAL-REQUEST-PROJECTION.md` 与 ADR-0020 完成 legacy fork-history 去重、Request identity、canonical projection、background indexer 与 graceful shutdown。

- Native Request Identity 调查覆盖真实污染 root session `019fbb2b-5db4-7410-bc55-41bbf5a6afc1` 的 20 个 rollout / 13,593 条 `token_count`。`request_id/response_id/model_request_id/trace_id/span_id/generation_id` 在计量事件上均未出现；`token_count` 携带 `call_id` / `turn_id` 均为 0。`call_id` 只出现在 MCP/patch/web-search/function/custom-tool call 链，因此不能作为模型 Request identity。
- T-ID-001~007：native identity 只从 `token_count` 强字段提取；当前格式缺失时使用 `turnId + generation + cumulative verified usage + last verified usage` 确定性 reconstruction。thread/source/line/envelope timestamp 不参与 identity，同一 fork copy 可稳定映射同一 `reqr_*`。新增回归证明 persisted reconstructed identity 在 restore 时保持 authoritative，且 v13→v14 可仅凭持久化 Request Ledger backfill identity。
- schema v14 将 `model_usage_events` 固定为 raw evidence，新建 `canonical_requests`、`task_ownership`、`event_ownership`；inherited copy 的 provenance 持久化 `canonical_request_id`。Parser restart/portable relocation 恢复时读取 raw session，不把 UI canonical projection 回灌为 raw evidence。
- T-OWN/T-PROJ：真实污染 session Task 为 `639 raw = 67 canonical + 572 inherited + 0 unresolved`；verified Request evidence 为 `12,783 raw = 1,464 canonical + 11,319 inherited + 0 unresolved`。业务 Request 不随 20 个 Agent/fork copy 倍增。
- 六字段 evidence conservation 全部成立。total token：`1,739,759,444 raw observed = 175,379,870 canonical business + 1,564,379,574 inherited provenance + 0 unresolved`；input/cached/cache-write/output/reasoning 字段也逐项满足同一恒等式。
- Request-Day：Time scope 只消费 canonical Request 原始 `observedAt`；lifecycle-only Task 不进入日期页，fork copy 重写 timestamp 不改变原 Request 日期。`verified_zero` 只有严格 unchanged cumulative post-checkpoint 才产生 `0 Token / $0.00`。
- Background indexer：首次空 projection 可等待首轮构建；已有 projection 的 Timeline/Session 点击只读 SQLite cache。append 只消费 dirty session；restart/portable source key 不 replay 无变化历史。present source 采用 source-scoped authoritative replace，source missing 保留 historical verified evidence；Agent persisted aggregate 与 Timeline unattributed fallback 也已回归锁定 canonical-only。parser semantics 与 schema version 分离，旧 cursor diagnostics 会通过后台 reindex 重建。T-INDEX-005 证明 close 会取消 queued job 并等待 active index job，生产 `server.close()` 在此后才关闭 SQLite。
- projection generation：ownership、`canonical_requests`、day/cost rows 与 `projection_generation` 在 SQLite transaction 内切换；Health 暴露 projection version/generation、canonical/inherited/unresolved Request/Task、dirty queue 和 active jobs；`unresolvedRequests > 0` 会降低 health。
- unknown-record 审计：52,552 条真实 JSONL record 中，原 `1,978 unknownRecords` 精确聚类为 `patch_apply_end=1,104`、`user_message=610`、`thread_rolled_back=183`、`web_search_end=81`。四类均为 non-accounting event；显式 allowlist 后同一只读样本 `unknownRecords=0 / parser health=healthy`，Request/Token reconciliation 数值完全不变。
- 最终真实 shadow benchmark：临时 SQLite 写入 `13,593` raw evidence rows、`1,464` canonical request rows、2 个 day rows；background persist `1,306.58ms`。20 次 warm 查询 P95：Timeline `19.76ms`（门槛 `<200ms`），Session-Day `65.43ms`（门槛 `<300ms`）。临时 DB `21,057,536` bytes，WAL `21,506,432` bytes。
- `.codex` read-only gate：20 个参与 rollout 的 combined SHA-256 manifest before=`3ada9c1437ab51d5bac24451e6709182675fbe47a8cbc0754108bf8b5a2b7f30`，after 完全相同；`hashChangedFiles=0`。
- 最终 Chrome/CDP 复验：1440×900 下 task-table `scrollLeft=354`、focus、Agent 展开/手工折叠与 DOM identity 在 snapshot 后保持，结构插入 `scrollDelta=66px` 时 visual-anchor top delta=`0px`；Project 恢复 full scope。当前复验选中的 live session 只有 `2026-08-27` 一个 Timeline day，因此 cross-day 子检查自然 skipped；前一轮多日真实 session 已实际通过 `2026-08-27 → 2026-08-26`。720×900 下横向 overflow、`scrollLeft=240`、focus 与 Agent 状态保持。
- 最终全量门槛：`npm test` 为 `109 tests / 108 passed / 0 failed / 1 skipped`；唯一 skipped 为未配置 `CODEX_MONITOR_REAL_FIXTURE` 的可选五任务 fixture。`npm run check` 与 `git diff --check` 均通过。

#### Cross-root ownership hardening / projection v2

- 真实故障 root `01a0461a-1c38-7433-8ed8-18f6586ddc43` 只读重扫得到 49 Task / 382 verified Request。12 个 Task 的 `startedAt` 明确早于 root `createdAt=2026-08-28T02:01:51.000Z`；这些 Task 中 278 条 verified Request 的 identity `278/278` 已存在于其他 root，`uniquePreRootVerifiedEvents=0`，证明本次 causal guard 不会删除该真实 session 的新 Request。
- 临时库集成使用旧 root `019ff3cc-b7b9-7c01-9a48-d93b6c6c43aa` 的真实 raw evidence + 故障 root 当前 rollout：旧 root 278 canonical Request；故障 root 104 新 canonical Request；故障 root inherited event 284、unresolved 0；全局 projection Request=382，没有把 278 个历史副本再次计量。
- `T-PROJ-007` 锁定 old-root-first 的 UNIQUE 崩溃；`T-PROJ-008` 锁定当前 legacy 格式下 copy-first/original-later pointer backfill；`T-PROJ-009` 锁定 original canonical 已存在时 copied Task timestamp rewrite 后仍由全局 request identity 防重复；`T-PROJ-010` 锁定 projection semantics stale 时 schema v14 原地从 raw evidence 重建为 projection v2；`T-PROJ-011` 锁定同 turn 的旧 inherited Request 与真正新 Request 不会被一起删除。
- HTTP async error-boundary 回归先稳定复现“请求悬挂”，修复后 synthetic projection rejection 返回 500，随后 `/api/health` 仍可正常 200，证明错误不再逃逸请求级 `try/catch`。
- 该 hardening 不修改 `.codex`、不放宽 `canonical_requests.request_id` 全局唯一性、也不通过 `INSERT OR IGNORE` 隐藏重复。若未来 wire format 同时改写 copied Task 时间且 copy root 早于原始 root 被 canonicalize，当前设计会要求新增证据/显式 unresolved 规则，而不是静默猜 ownership。
- 正式 `data/usage.sqlite` 的临时副本执行真实 v1→v2 migration：`PRAGMA user_version=14` 保持不变，projection=`v2`，一次性 rebuild `2766ms`。随后在该副本导入当前故障 root：104 canonical verified Request / 278 inherited verified Request / 0 unresolved；37 canonical Task / 12 inherited Task；canonical Token=`12,808,314`。参与的 2 个真实 rollout SHA-256 before/after 完全一致。
- 最终门槛：`npm test` 为 `115 tests / 114 passed / 0 failed / 1 skipped`；唯一 skip 仍是未配置 `CODEX_MONITOR_REAL_FIXTURE` 的可选真实五任务 fixture。`npm run check` 与 `git diff --check` 通过。

## 手工验收

1. 启动服务，确认只监听 `127.0.0.1`，使用一次性 URL 进入页面。
2. 确认会话按完整工程目录分组；搜索并选择有子智能体的会话，确认 agent tree、任务数、质量状态、输入/输出/缓存命中率、六类 token、任务模型、effort、智能体自身/含后代 USD 和会话总计 USD 等值可见。
3. 悬停 USD 单元格，确认能看到价目模型/单价以及“不等于 Codex 订阅扣费”的限制；未知模型显示不可估算。
4. 确认任务表不再显示指令列；数据库 schema 中无正文列，旧 preview API 仍受认证且不落库。
5. 向选中 rollout 追加脱敏完整测试记录，确认 2 秒内收到 SSE snapshot；随后恢复测试环境。
6. 验证窄屏页面仍可按工程选择会话、横向查看完整任务表并查看额度/健康状态。
7. 对源 `.codex` 文件执行验证前后哈希比较。

手工操作不得修改真实 rollout。需要追加测试时使用临时 Codex home 和脱敏 fixture。

## 证据解释

自动化测试证明 parser 对已覆盖结构的行为、数据库内容边界、定价公式和 HTTP 安全控制。它不证明 rollout 是长期稳定公共格式，也不证明本地 Request Ledger / Subscription Standard-Rate Equivalent 等于服务端实际 Plus 账单。页面的数据质量标签、USD 限制和 [架构证据边界](ARCHITECTURE.md#官方证据边界) 必须保留。
