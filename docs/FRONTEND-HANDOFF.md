# Frontend Handoff：Phase 9 视觉迭代接手说明

**交付日期：** 2026-08-24  
**目标读者：** 后续负责 `public/**` 的智能体 / 开发者  
**当前分支：** `codex/project-grouping-claude-redesign`  
**接手基线：** `fd8e5c9 refactor(ui): compact deep agent lineage gutters`

## 1. 接手前必须确认

先阅读：

1. 根目录 [`AGENTS.md`](../AGENTS.md)，尤其是“前端视觉迭代版本控制”。
2. [`tasks/plan.md`](../tasks/plan.md) 的 Phase 9。
3. [`ADR-0009`](decisions/0009-editorial-lineage-interface.md)：编辑式账页、连续谱系轨、角色标签。
4. [`ADR-0010`](decisions/0010-typography-hierarchy.md)：字体职责与字号层级。
5. [`VERIFICATION.md`](VERIFICATION.md)：最近一次真实浏览器验收证据。

然后执行：

```powershell
git status --short --branch
git log --oneline -5
npm test
npm run check
git diff --check
```

预期基线至少包含：

```text
fd8e5c9 refactor(ui): compact deep agent lineage gutters
7c80576 docs: add frontend iteration handoff
aed004a feat(ui): establish readable typography hierarchy
c0cc86d chore: require versioned frontend design decisions
b9641bf feat: redesign dashboard as an editorial lineage ledger
```

开始新的视觉决策前，工作区必须 clean。不要 reset、stash 或覆盖其他工作者的改动。

## 2. 当前前端状态

前端为零框架静态页面：

- `public/index.html`：页面语义结构与固定容器。
- `public/app.js`：会话选择、SSE、DOM 渲染、Agent 递归树和任务表。
- `public/styles.css`：Phase 8/9 的全部视觉、排版、响应式和谱系布局。
- `test/ui-security.test.js`：CSP、关键 UI 合同与 Typography v1 静态约束。

当前界面已经具备：工程分组、Session 概览、输入/输出/缓存命中率、USD API 等值、额度快照、递归 Agent lineage、角色标签、14 列任务审计表、桌面/窄屏响应式与独立表格横向滚动。

## 3. 已冻结的视觉契约

### Phase 8：编辑式观测工作区

- 暖纸色基底、低卡片化结构保留。
- clay accent 主要用于选中状态、谱系节点和关键焦点；不要重新大面积填充卡片。
- Agent 层级必须通过真实递归结构与连续连接轨表达，不能退化为仅靠整卡 margin 缩进。
- `reviewer`、`test-worker` 等职责必须优先可扫描，未知角色使用中性 fallback。
- 任务表不得隐藏审计字段；窄屏使用表格自身横向滚动。

### Phase 9 / Typography v1

- **Display serif**：只用于 Session、Section、Project、Agent 等实体标题。
- **System sans**：导航、正文、label、状态、role、effort、quality、table header。
- **Monospace**：路径、ID、模型、时间、token、比例、USD 等机器数据。
- `mono` 不得作为“小字”的默认方案。
- 当前 token：identifier `10px`、utility `11px`、label `12px`、body `14px`、data `12px`、entity `20px`。
- 不重新引入 `8px` / `9px` UI 文字。
- Session 标题上限 `48px`，Section 标题上限 `36px`。

## 4. Phase 9 后续工作顺序

后续四项必须**逐项完成、逐项验证、逐项提交**；禁止混合实现。

### Decision 2：减少深层谱系横向空间损失 — 已完成

已在 `fd8e5c9` 完成。`.agent-children` 改为变量化 lineage geometry：桌面 `18px` rail offset + `14px` elbow，每层总横向占用由 54px 收敛到 32px；720px 以下使用 `10px + 8px = 18px/层`。

已验证保持以下契约：

- 连续竖轨、横向 elbow 和节点圆点仍明确表达 parent → child。
- `.task-table-wrap` 仍是唯一任务审计表横向 overflow 边界。
- 真实 7 Agent / depth 3 会话在 1440×900 与 390×844 均无 document-level 横向 overflow。
- 本提交没有混入 sticky task columns、Overview 重组或 Agent 展开策略。

提交：

```text
fd8e5c9 refactor(ui): compact deep agent lineage gutters
```

### Decision 3：任务审计表横向浏览 — 下一项

目标：改善 14 列、`1390px` 审计表的上下文保持，例如 sticky Task/Status、明确滚动 affordance 或审计密度控制。

不要通过隐藏 token / model / effort / cost / quality 字段解决宽度问题。

### Decision 4：Overview 信息层级

将当前七项近似等权指标重新组织成更符合监控任务的语义层，例如 Activity / Token Flow / Cost；不要恢复多层圆角 card grid。

### Decision 5：Agent 展开策略

当前非 root Agent 基本默认展开，大会话会生成很长页面。应设计 root、一级、活跃节点、深层节点的明确策略，并在需要时记忆用户展开状态。

## 5. 每个视觉决策的强制版本控制流程

按照 `AGENTS.md`：

1. 确认工作区 clean，并记录当前 HEAD。
2. 只实现一个可命名的视觉决策。
3. 长期契约变化时同步 `tasks/plan.md` 与 ADR；普通微调至少更新交付/验证记录。
4. 执行自动化与 diff 检查。
5. 使用真实 Chrome 验证桌面与窄屏。
6. 检查 diff，只 stage 本决策相关路径。
7. 形成独立 Conventional Commit，记录 hash 后才开始下一项。

不要使用 `git add .`、`git reset --hard`、`git checkout --` 或强制推送。

## 6. 每轮前端验收协议

最低自动化：

```powershell
npm test
npm run check
git diff --check
```

真实浏览器至少验证：

- Desktop：`1440 × 900`。
- Narrow：`390 × 844`。
- 页面本身无 document-level 横向 overflow。
- 任务表横向 overflow 限制在 `.task-table-wrap`。
- keyboard `:focus-visible` 保留。
- `prefers-reduced-motion` 保留。
- Chrome console error / warning / runtime exception 为 `0`。

涉及真实 `.codex` 历史时继续遵守只读要求；不得为了视觉验收修改真实 rollout。

## 7. 当前验证基线

Typography v1 提交前后的最近验收：

- `npm test`：26 tests，25 passed，0 failed，1 skipped；skip 为未配置 `CODEX_MONITOR_REAL_FIXTURE`。
- `npm run check`：通过。
- `git diff --check`：通过。
- Chrome 1440×900：无 document-level 横向 overflow；Session 48px、Section 36px、utility/header 11px、identifier 10px。
- Chrome 390×844：无 document-level 横向 overflow；任务表在约 339px 容器内维持 1390px 独立横向滚动。
- 实际字体角色：中文章节标题落到本机 serif，UI 标签使用 Segoe UI，标识使用 Cascadia Code。
- console error / warning / runtime exception：0。

Decision 2 最新增量：

- `npm test`：26 tests，25 passed，0 failed，1 skipped。
- `npm run check`、`git diff --check`：通过。
- Chrome 1440×900：实际 7 Agent / depth 3 会话，lineage 为 `18px + 14px = 32px/层`，document width 1440，无横向溢出；任务表 977px 容器 / 1390px 内容，独立滚动。
- Chrome 390×844：同一会话 lineage 为 `10px + 8px = 18px/层`，document width 375，无横向溢出；任务表 339px 容器 / 1390px 内容，独立滚动。
- console error / warning / runtime exception：0。

详细证据以 [`VERIFICATION.md`](VERIFICATION.md) 为准，不要把历史记录冒充为新一轮已执行验证。

## 8. 本阶段明确不应触碰的边界

纯前端视觉迭代原则上不要修改：

- `src/rollout-parser.js` 的累计 token 边界差分。
- SQLite schema / metadata-only persistence。
- `src/pricing.js` 的 API 等值计价口径。
- loopback、Cookie、Host/Origin、CSP、只读 HTTP 安全边界。
- quota 的账号级语义。

如果视觉需求确实需要 API/schema 变化，先停止当前视觉 commit，提出独立契约变更，并按仓库 ADR/测试规则另行处理。

## 9. 给下一位智能体的直接任务

接手后先验证本文件第 1 节的 Git/测试基线。若基线一致，从 **Decision 3：任务审计表横向浏览** 开始；只拥有该决策所需的 `public/**`、对应测试和交付文档，不提前混入 Overview 或展开策略。完成并提交后汇报：目标、修改文件、视觉契约变化、精确验证结果、浏览器数据、commit hash、风险和下一项建议。
