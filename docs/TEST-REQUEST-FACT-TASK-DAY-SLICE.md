# Phase 19：Request Fact / Task Day Slice 测试方案

**状态：** Implementation Gate
**原则：** 业务单元测试只验证领域行为；数据库性能、HTTP、安全、DOM/CSS 分别在集成或浏览器门槛验证，不混入业务单元测试。

## 1. 业务单元测试文件

固定文件：

```text
test/request-scope-business.test.js
```

该文件只允许依赖纯领域 seam：

- `resolveCanonicalRequestOwnership`
- `materializeScopedSnapshot`
- `resolveLocalDayRange`

禁止在该文件测试：

- HTTP 200/500、Cookie、CSP、Host/Origin
- SQLite migration 列名、索引是否存在
- CSS class、DOM 布局、按钮文本
- Node/SQLite experimental warning
- 与本业务无关的 parser record 类型

## 2. 必须锁定的业务场景

### BIZ-SCOPE-001：Session Scope 保持完整 Task

一个 Task 跨两天产生 3 个 Request。Session scope 必须只显示 1 个 Task，usage/request count 为三个 Request 总和。

### BIZ-SCOPE-002：Time Scope 按 Request Day 切片

同一 Task 的 R1 在 day1，R2/R3 在 day2。day1/day2 都可以显示同一个 Task identity，但各自只统计当天 Request。

### BIZ-SCOPE-003：Full = Σ Day

对 input / cached input / cache-write input / output / reasoning / total 六字段以及 request count：完整 Session 必须等于所有 day slice 求和。

### BIZ-SCOPE-004：无当日 Request 的 Task 不进入 Day Slice

Task 可以存在于完整 Session，但当天没有 canonical Request 时不得因为 lifecycle overlap 出现在当天统计。

### BIZ-OWN-001：Cross-root inherited + current Request 混合

新 root 的同一个 turn 同时包含旧 root inherited Request 与真实新 Request：旧 Request 只进入 provenance，新 Request 仍 canonical；Task 仍作为当前 root 的真实 Task 可见。

### BIZ-OWN-002：六字段 Evidence Conservation

所有 verified raw evidence 必须逐字段满足：

```text
raw = canonical + inherited + unresolved
```

不能只验证 `totalTokens`。

### BIZ-TIME-001：Copied timestamp 不污染日期

旧 Request 被复制进新 root 并获得新的 envelope/observed-looking 时间时，只要 identity 已有 external canonical owner，就不能把旧 Token 移入新日期；新日期只统计真正新 Request。

## 3. 数据库 / API 集成门槛

这些测试不进入 `request-scope-business.test.js`，但实现阶段必须覆盖：

- canonical global identity collision 不崩溃、不重复 accounting。
- copy-first / original-later provenance pointer backfill。
- Task request drill-down 只返回 canonical Request；`?day=` 只返回该日 Request。
- Request drill-down 分页稳定，不重不漏。
- Project snapshot 与无 `day` request detail 一致；Time snapshot 与带 `day` detail 一致。
- Async API rejection 被请求级边界捕获，不导致 Node 进程退出。

建议继续放在 `test/database-server.test.js` / `test/request-ownership.test.js`，不要复制一套第二实现。

## 4. UI 浏览器验收

UI 行为只做浏览器/E2E，不塞入业务 unit：

- Project 标题“任务记录”，一行代表完整 Task。
- Time 标题“当日任务活动”，摘要使用“活动任务 + Requests”。
- Time 表不把 full Task `startedAt/duration` 冒充当日时间；显示当日 Request window/count。
- 展开 Task：Project 返回全部 Request；Time 只返回当天 Request。
- Day 切换后相同 `turnId` 可以出现，但数值随 Request day 改变。
- SSE 后横向滚动、Agent/Task 展开、focus、visual anchor 保持。

## 5. 性能门槛

性能使用真实/合成大历史 benchmark：

- Timeline warm P95 `<200ms`
- day/session detail warm P95 `<300ms`
- request drill-down 首批 warm P95 `<100ms`
- 初始 snapshot 不加载 Request detail rows
- DB query plan 必须命中 `(root_session_id, thread_id, turn_id, observed_at, request_id)` drill-down index
- cached scope switch 不 replay rollout

性能测试失败时优先优化 SQL、索引、projection 或 payload，不允许通过降低 accounting 精度换性能。

## 6. 数据安全 / Reconciliation 门槛

真实历史 cutover 前必须记录：

1. `.codex` before/after SHA-256 不变。
2. raw/canonical/inherited/unresolved 六字段守恒。
3. canonical Full = Σ day 六字段与 Request count 守恒。
4. Session/Agent/Task rollup = canonical Request aggregation。
5. cross-root duplicate 不增加 Token/Cost。
6. unresolved evidence 有数量/usage 报告，不能静默掉入 canonical。

## 7. 完成门槛

```text
node --test test/request-scope-business.test.js
node --test test/request-ownership.test.js test/database-server.test.js
npm test
npm run check
git diff --check
```

随后执行真实 reconciliation、性能 benchmark、1440px/720px 浏览器验收。只有全部通过，交付文件才能从 `Implementation Pending` 改成 `Implemented`。
