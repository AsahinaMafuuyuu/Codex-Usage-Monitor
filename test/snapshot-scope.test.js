import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { USAGE_FIELDS } from "../src/usage.js";

process.env.TZ = "America/Los_Angeles";

const {
  materializeCalendarSlices,
  materializeScopedSnapshot,
  resolveLocalDayRange,
} = await import("../src/snapshot-scope.js");

const ROOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIBLING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let eventLineNumber = 1;

test("T-DAY-001/002 resolves only strict local calendar dates", () => {
  const range = resolveLocalDayRange("2026-08-26");
  assert.equal(range.day, "2026-08-26");
  assert.equal(range.timezone, "America/Los_Angeles");
  assert.equal(new Date(range.startMs).getHours(), 0);
  assert.equal(new Date(range.endMs).getHours(), 0);
  assert.equal(new Date(range.startMs).getDate(), 26);
  assert.equal(new Date(range.endMs).getDate(), 27);

  for (const invalid of ["2026-02-31", "2026-8-26", "2026-08-26T00:00:00", "nope"]) {
    assert.throws(() => resolveLocalDayRange(invalid), /YYYY-MM-DD|合法本地日期/u);
  }
});

test("T-DAY-003 derives DST boundaries from adjacent local midnights", () => {
  const script = `
    import { resolveLocalDayRange } from ${JSON.stringify(new URL("../src/snapshot-scope.js", import.meta.url).href)};
    const spring = resolveLocalDayRange("2026-03-08");
    const fall = resolveLocalDayRange("2026-11-01");
    process.stdout.write(JSON.stringify({ spring: spring.endMs - spring.startMs, fall: fall.endMs - fall.startMs }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/Los_Angeles" },
  });
  assert.equal(child.status, 0, child.stderr);
  const durations = JSON.parse(child.stdout);
  assert.equal(durations.spring, 23 * 60 * 60 * 1000);
  assert.equal(durations.fall, 25 * 60 * 60 * 1000);
});

test("T-DAY-010..033 materializes request-ledger task and agent day slices", () => {
  const stored = crossMidnightStoredSession();
  const full = materializeScopedSnapshot(stored, { type: "session" });
  const day1 = materializeScopedSnapshot(stored, { type: "day", day: "2026-08-26" });
  const day2 = materializeScopedSnapshot(stored, { type: "day", day: "2026-08-27" });

  assert.deepEqual(full.scope, { type: "session" });
  assert.deepEqual(day1.scope, {
    type: "day",
    day: "2026-08-26",
    timezone: "America/Los_Angeles",
  });
  assertUsageTotals(day1.summary.totalUsage, 100);
  assertUsageTotals(day2.summary.totalUsage, 200);
  assertUsageTotals(full.summary.totalUsage, 300);
  for (const field of USAGE_FIELDS) {
    assert.equal(
      day1.summary.totalUsage[field] + day2.summary.totalUsage[field],
      full.summary.totalUsage[field],
      field,
    );
  }

  const day1RootTask = day1.agents.find((agent) => agent.threadId === ROOT).tasks[0];
  const day2RootTask = day2.agents.find((agent) => agent.threadId === ROOT).tasks[0];
  assert.equal(day1RootTask.startedAt, "2026-08-26T23:50:00-07:00");
  assert.equal(day2RootTask.completedAt, "2026-08-27T00:20:00-07:00");
  assert.equal(day1RootTask.deltaUsage.totalTokens, 100);
  assert.equal(day2RootTask.deltaUsage.totalTokens, 50);
  assert.equal(day1RootTask.requestLedgerCoverage.unverified, 1);
  assert.equal(day1RootTask.quality, "partial");
  assert.equal(day2RootTask.requestCount, 1);

  const day2Child = day2.agents.find((agent) => agent.threadId === CHILD);
  assert.equal(day2Child.ownUsage.totalTokens, 150);
  assert.equal(day2Child.taskCount, 1);
  assert.equal(day2Child.ownModelRequestCount, 1);
  assert.equal(day2Child.tasks[0].requestLedgerCoverage.duplicate, 1);
  assert.equal(day2Child.tasks[0].requestLedgerCoverage.anomaly, 1);
  assert.equal(day2Child.tasks[0].quality, "partial");
  const day2Root = day2.agents.find((agent) => agent.threadId === ROOT);
  assert.equal(day2Root.ownUsage.totalTokens, 50);
  assert.equal(day2Root.subtreeUsage.totalTokens, 200);
  assert.equal(day2Root.subtreeModelRequestCount, 2);
  assert.equal(day2.agents.some((agent) => agent.threadId === SIBLING), false);
  assert.equal(day2.summary.agentCount, 1);
  assert.equal(day2.summary.modelRequestCount, 2);
  assert.equal(day2.summary.totalUsage.totalTokens, 200, "unattributed 999-token event must stay diagnostic-only");

  assert.equal(day1.summary.totalCostEstimate.estimatedTasks, 1);
  assert.equal(day2.summary.totalCostEstimate.estimatedTasks, 2);
  assert.notEqual(day1.summary.totalCostEstimate.amountUsd, day2.summary.totalCostEstimate.amountUsd);
});

test("T-DAY-021/022 keeps lifecycle slices without usage and event-backed slices without timestamps", () => {
  const stored = crossMidnightStoredSession();
  stored.tasks.push({
    rootSessionId: ROOT,
    threadId: ROOT,
    turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    sequence: 3,
    status: "completed",
    startedAt: "2026-08-27T09:00:00-07:00",
    completedAt: "2026-08-27T09:05:00-07:00",
    model: "gpt-5.6-terra",
  });
  stored.tasks.push({
    rootSessionId: ROOT,
    threadId: CHILD,
    turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    sequence: 4,
    status: "completed",
    startedAt: null,
    completedAt: null,
    model: "gpt-5.6-terra",
  });
  stored.modelUsageEvents.push(event({
    threadId: CHILD,
    turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    classification: "generation_start",
    total: 25,
    observedAt: "2026-08-27T10:00:00-07:00",
  }));

  const day2 = materializeScopedSnapshot(stored, { type: "day", day: "2026-08-27" });
  const tasks = day2.agents.flatMap((agent) => agent.tasks);
  const lifecycleOnly = tasks.find((task) => task.turnId === "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const eventBacked = tasks.find((task) => task.turnId === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  assert.equal(lifecycleOnly.deltaUsage, null);
  assert.equal(["partial", "unknown"].includes(lifecycleOnly.quality), true);
  assert.equal(eventBacked.deltaUsage.totalTokens, 25);
});

test("T-DAY-040 calendar slices use observedAt and task lifecycle rather than task start day", () => {
  const slices = materializeCalendarSlices(crossMidnightStoredSession());
  assert.deepEqual(slices.map((slice) => slice.day), ["2026-08-26", "2026-08-27"]);
  assert.equal(slices[0].usage.totalTokens, 100);
  assert.equal(slices[1].usage.totalTokens, 200);
  assert.equal(slices[0].taskCount, 1);
  assert.equal(slices[1].taskCount, 2);
  assert.equal(slices[0].modelRequestCount, 1);
  assert.equal(slices[1].modelRequestCount, 2);
});

function crossMidnightStoredSession() {
  const rootTask = {
    rootSessionId: ROOT,
    threadId: ROOT,
    turnId: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    status: "completed",
    startedAt: "2026-08-26T23:50:00-07:00",
    completedAt: "2026-08-27T00:20:00-07:00",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  };
  const childTask = {
    rootSessionId: ROOT,
    threadId: CHILD,
    turnId: "22222222-2222-4222-8222-222222222222",
    sequence: 2,
    status: "completed",
    startedAt: "2026-08-27T00:05:00-07:00",
    completedAt: "2026-08-27T00:10:00-07:00",
    model: "gpt-5.6-terra",
    effort: "high",
  };
  return {
    session: { id: ROOT, title: "fixture", cliVersion: "fixture" },
    agents: [
      agent(ROOT, null, 0, true),
      agent(CHILD, ROOT, 1, false),
      agent(SIBLING, ROOT, 1, false),
    ],
    tasks: [rootTask, childTask],
    modelUsageEvents: [
      event({ threadId: ROOT, turnId: rootTask.turnId, classification: "generation_start", total: 100, observedAt: "2026-08-26T23:58:00-07:00" }),
      event({ threadId: ROOT, turnId: rootTask.turnId, classification: "unverified", total: null, observedAt: "2026-08-26T23:59:00-07:00" }),
      event({ threadId: ROOT, turnId: rootTask.turnId, classification: "verified_increment", total: 50, observedAt: "2026-08-27T00:02:00-07:00" }),
      event({ threadId: CHILD, turnId: childTask.turnId, classification: "generation_start", total: 150, observedAt: "2026-08-27T00:06:00-07:00" }),
      event({ threadId: CHILD, turnId: childTask.turnId, classification: "duplicate", total: 0, observedAt: "2026-08-27T00:07:00-07:00" }),
      event({ threadId: CHILD, turnId: childTask.turnId, classification: "anomaly", total: null, observedAt: "2026-08-27T00:08:00-07:00" }),
      event({ threadId: CHILD, turnId: "99999999-9999-4999-8999-999999999999", classification: "verified_increment", total: 999, observedAt: "2026-08-27T00:09:00-07:00" }),
    ],
  };
}

function agent(threadId, parentThreadId, depth, isRoot) {
  return {
    rootSessionId: ROOT,
    threadId,
    parentThreadId,
    depth,
    isRoot,
    ownUsage: usage(0),
    subtreeUsage: usage(0),
  };
}

function event({ threadId, turnId, classification, total, observedAt }) {
  return {
    sourceKey: "fixture.jsonl",
    lineNumber: eventLineNumber++,
    rootSessionId: ROOT,
    threadId,
    turnId,
    classification,
    observedAt,
    usage: total == null ? null : usage(total),
  };
}

function usage(total) {
  return {
    inputTokens: total,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: total,
  };
}

function assertUsageTotals(actual, total) {
  assert.equal(actual.inputTokens, total);
  assert.equal(actual.cachedInputTokens, 0);
  assert.equal(actual.cacheWriteInputTokens, 0);
  assert.equal(actual.outputTokens, 0);
  assert.equal(actual.reasoningOutputTokens, 0);
  assert.equal(actual.totalTokens, total);
}
