# Phase 19：Request Fact / Task Day Slice 交付契约

**状态：** Design Complete / Implementation Pending
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

- [ ] global `request_id` 唯一性继续成立。
- [ ] cross-root copy 不重复 accounting。
- [ ] 同 turn mixed inherited/new Request 不误删新 usage。
- [ ] raw = canonical + inherited + unresolved，六字段逐项守恒。
- [ ] Full Session = Σ Task = Σ canonical Request。
- [ ] Full canonical = Σ local-day Request。
- [ ] copied timestamp 不改变 canonical Request day。
- [ ] `.codex` 源文件 before/after hash 完全不变。

## 后端 / 性能验收

- [ ] 初始 snapshot 不携带全部 Request 明细。
- [ ] Request drill-down 使用 task/day 定向 SQL，并有对应索引。
- [ ] Timeline warm P95 `<200ms`。
- [ ] Session/Day detail warm P95 `<300ms`。
- [ ] Request drill-down 首批 warm P95 `<100ms`。
- [ ] cached Project/Time 切换不触发 rollout replay。
- [ ] projection rebuild 与前端读取 generation 原子隔离。

## UI 验收

- [ ] Project 与 Time 的 Task 语义在标题、列名和摘要上明确区分。
- [ ] Time 不显示误导性的 full-task “开始/耗时”作为日内计量字段。
- [ ] Request detail 在 Task 展开时懒加载，Project=全量，Time=当日。
- [ ] 1440px 与 720px 横向审计表可用。
- [ ] SSE 后滚动、Agent 展开、Task 展开、focus、visual anchor 不丢失。

## 测试验收

- [x] 业务测试契约已定义：`docs/TEST-REQUEST-FACT-TASK-DAY-SLICE.md`。
- [x] 独立业务 unit 文件已建立：`test/request-scope-business.test.js`。
- [ ] 业务 unit 全部 Green。
- [ ] DB/API 定向集成测试全部 Green。
- [ ] `npm test` / `npm run check` / `git diff --check` Green。
- [ ] 真实历史 reconciliation / performance / browser evidence 已写入 `docs/VERIFICATION.md`。

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

## 当前交接状态

本文件现在是**交付定义**，不是“已交付证明”。工作区已有其他未提交的 Phase 18.1 cross-root hardening 改动，应保留并单独审查；Phase 19 实现必须在这些改动的真实基线上执行，不能 reset/stash/覆盖他人工作。

最终交付时应把本文件状态改为 `Implemented`，并填写精确测试数量、性能 P95、真实 reconciliation 数字、浏览器结果和 commit/tag；在此之前不得提前勾选实现项。
