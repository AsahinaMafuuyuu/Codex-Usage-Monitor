# Phase 19：Request Fact / Task Day Slice 交付契约

**状态：** Implemented
**日期：** 2026-08-28

## 交付目标

本阶段完成后，Codex Usage Monitor 必须让“业务查看”和“计量查看”同时成立：

- Project / Session：用户看到完整 Session 和完整 Task；Task 是主要业务展示单位。
- Time：用户按本地自然日查看真实发生在当天的 canonical Request，再按 Task Day Slice 分组。
- Request：始终是 Token / Cost / 日期的最小计量事实。
- Legacy copied history：保留 provenance，但绝不重复增加 Token / Cost / Request count。

## 用户可见行为

### Project / Session

- “任务记录”继续展示完整 Task。
- Task 的 Token、Cost、cache、Request 数为整个 Task 生命周期汇总。
- Task 展开后按需查看该 Task 的全部 canonical Request。

### Time

- 标题改为“当日任务活动”。
- Summary 明确显示“活动任务”和“Requests”。
- Task 行只显示当天 Request 子集的 Token / Cost / cache / quality。
- 当日时间列使用 `firstRequestAt / lastRequestAt`，不把完整 Task 生命周期冒充为当日耗时。
- Task 展开只显示当前日期的 canonical Request。

## 数据正确性验收

- [x] global `request_id` 唯一性继续成立。
- [x] cross-root copy 不重复 accounting。
- [x] 同 turn mixed inherited/new Request 不误删新 usage。
- [x] raw = canonical + inherited + unresolved，六字段逐项守恒。
- [x] Full Session = Σ Task = Σ canonical Request。
- [x] Full canonical = Σ local-day Request。
- [x] copied timestamp 不改变 canonical Request day。
- [x] `.codex` 源文件 before/after hash 完全不变。

## 后端 / 性能验收

- [x] 初始 snapshot 不携带全部 Request 明细。
- [x] Request drill-down 使用 task/day 定向 SQL，并有对应索引。
- [x] Timeline warm P95 `<200ms`。
- [x] Session/Day detail warm P95 `<300ms`。
- [x] Request drill-down 首批 warm P95 `<100ms`。
- [x] cached Project/Time 切换不触发 rollout replay。
- [x] projection rebuild 与前端读取 generation 原子隔离。

## UI 验收

- [x] Project 与 Time 的 Task 语义在标题、列名和摘要上明确区分。
- [x] Time 不显示误导性的 full-task “开始/耗时”作为日内计量字段。
- [x] Request detail 在 Task 展开时懒加载，Project=全量，Time=当日。
- [x] 1440px 与 720px 横向审计表可用。
- [x] SSE 后滚动、Agent 展开、Task 展开、focus、visual anchor 不丢失。

## 测试验收

- [x] 业务测试契约已定义：`docs/TEST-REQUEST-FACT-TASK-DAY-SLICE.md`。
- [x] 独立业务 unit 文件已建立：`test/request-scope-business.test.js`。
- [x] 业务 unit 全部 Green。
- [x] DB/API 定向集成测试全部 Green。
- [x] `npm test` / `npm run check` / `git diff --check` Green。
- [x] 真实历史 reconciliation / performance / browser evidence 已写入 `docs/VERIFICATION.md`。

## 实施文件边界

预计实现主要涉及：

```text
src/request-ownership.js        # 只在仍有 cross-root 边界缺口时修改
src/database.js                 # drill-down query/index/projection hot path
src/snapshot-scope.js           # day-slice request window metadata
src/monitor.js / src/server.js  # read-only request detail API
public/app.js / styles.css      # Project/Time task presentation + lazy detail
test/request-scope-business.test.js
test/request-ownership.test.js
test/database-server.test.js
scripts/*                       # 仅必要 benchmark/reconciliation
```

不得为了 UI 改造重新引入 Boundary Ledger、Task-start day accounting 或 root-local Request identity。

## 已交付证据

- 业务测试 `test/request-scope-business.test.js`：8 / 8 Green；Full Task、Task Day Slice、Full=ΣDay、无当日 Request 不显示、cross-root mixed-turn、六字段 conservation、copied timestamp 与 day-slice Request window 全部锁定。
- 定向 ownership/DB/API 集成：46 / 46 Green；Request drill-down 只读 `canonical_requests`，支持 `day`、稳定 `(observedAt, requestId)` cursor 与 `1..500` bounded page size。静态 UI/交互契约 2 / 2 Green。
- 最终全量门槛：`npm test` 为 124 tests / 123 passed / 0 failed / 1 optional real-fixture skip；`npm run check`、`git diff --check` 通过。
- 正式 SQLite 真实热路径：Timeline P95 `191.237ms`；完整 Session `47.652ms`；Day detail `34.626ms`；最大 Task 的 Request drill-down 首批 P95 `4.498ms`。查询计划命中 covering index `idx_canonical_requests_task_observed`。
- 真实 reconciliation session：1,022 canonical verified Requests / 0 inherited / 0 unresolved；六字段 raw=canonical+inherited+unresolved 成立，且 canonical=Σday=full snapshot，Request count 同为 1,022。
- 真实 rollout manifest before/after 均为 `5d684e43b671aeb19b92bdbfca1a7b2b02e335774f43c952ae1b6843ea8ef379`，`hashChangedFiles=0`。
- Chrome/CDP：1440×900 下 Project/Time scope 文案与列语义正确，真实 Task 懒加载 24 条 canonical Request；SSE 后 Request detail DOM/展开状态、task-table `scrollLeft=463`、focus 与 visual-anchor 保持。720×900 下 overflow、`scrollLeft=240`、focus 与 Agent 展开状态保持。

本阶段不创建新 schema version，SQLite 仍为 v14、projection semantics 仍为 v2；实现与交付提交以仓库 Git 历史为最终版本证据。
