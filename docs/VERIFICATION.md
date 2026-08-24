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

自动化测试证明 parser 对已覆盖结构的行为、数据库内容边界、定价公式和 HTTP 安全控制。它不证明 rollout 是长期稳定公共格式，也不证明客户端 token 差分或 API 等值等于服务端/Codex 订阅账单。页面的数据质量标签、USD 限制和 [架构证据边界](ARCHITECTURE.md#官方证据边界) 必须保留。
