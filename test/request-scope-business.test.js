import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanonicalRequestOwnership } from "../src/request-ownership.js";
import { materializeScopedSnapshot, resolveLocalDayRange } from "../src/snapshot-scope.js";
import { USAGE_FIELDS } from "../src/usage.js";

const DAY1 = "2026-08-27";
const DAY2 = "2026-08-28";

function localIso(day, hour, minute = 0) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, hour, minute, 0, 0).toISOString();
}

function usage({ input, cached = 0, cacheWrite = 0, output = 0, reasoning = 0, total }) {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: total,
  };
}

function makeTask(turnId, sequence = 1) {
  return {
    rootSessionId: "root",
    threadId: "root",
    turnId,
    sequence,
    status: "completed",
    startedAt: localIso(DAY1, 23, 45),
    completedAt: localIso(DAY2, 0, 30),
    durationMs: 45 * 60 * 1000,
    model: "gpt-5.6-terra",
    effort: "high",
  };
}

function makeEvent({ turnId = "turn-a", lineNumber, observedAt, eventUsage, rootId = "root", requestIdentity = null }) {
  return {
    rootSessionId: rootId,
    sourceKey: `${rootId}.jsonl`,
    lineNumber,
    threadId: rootId,
    turnId,
    observedAt,
    generation: 0,
    classification: "verified_increment",
    quality: "complete",
    usage: eventUsage,
    model: "gpt-5.6-terra",
    serviceTier: "default",
    pricingContextQuality: "verified",
    ...(requestIdentity ? {
      requestIdentity,
      requestIdentityKind: "reconstructed",
      requestIdentityReason: "deterministic_request_reconstruction",
    } : {}),
  };
}

function storedFixture({ includeIdleTask = false } = {}) {
  const tasks = [makeTask("turn-a")];
  if (includeIdleTask) tasks.push({
    ...makeTask("turn-idle", 2),
    startedAt: localIso(DAY2, 10),
    completedAt: localIso(DAY2, 10, 10),
  });
  return {
    session: { id: "root", createdAt: localIso(DAY1, 22) },
    agents: [{
      rootSessionId: "root",
      threadId: "root",
      parentThreadId: null,
      depth: 0,
      isRoot: true,
      firstSeenAt: localIso(DAY1, 22),
      lastSeenAt: localIso(DAY2, 1),
    }],
    tasks,
    modelUsageEvents: [
      makeEvent({
        lineNumber: 10,
        observedAt: localIso(DAY1, 23, 50),
        eventUsage: usage({ input: 80, cached: 20, output: 20, reasoning: 5, total: 100 }),
      }),
      makeEvent({
        lineNumber: 20,
        observedAt: localIso(DAY2, 0, 5),
        eventUsage: usage({ input: 160, cached: 80, output: 40, reasoning: 10, total: 200 }),
      }),
      makeEvent({
        lineNumber: 30,
        observedAt: localIso(DAY2, 0, 20),
        eventUsage: usage({ input: 120, cached: 60, output: 30, reasoning: 5, total: 150 }),
      }),
    ],
  };
}

function onlyTask(snapshot) {
  const tasks = snapshot.agents.flatMap((agent) => agent.tasks ?? []);
  assert.equal(tasks.length, 1);
  return tasks[0];
}

test("BIZ-SCOPE-001 session scope keeps one full task and sums every request across days", () => {
  const snapshot = materializeScopedSnapshot(storedFixture(), { type: "session" });
  const taskRow = onlyTask(snapshot);

  assert.equal(snapshot.summary.taskCount, 1);
  assert.equal(snapshot.summary.modelRequestCount, 3);
  assert.equal(snapshot.summary.totalUsage.totalTokens, 450);
  assert.equal(taskRow.turnId, "turn-a");
  assert.equal(taskRow.requestCount, 3);
  assert.equal(taskRow.deltaUsage.totalTokens, 450);
});
test("BIZ-SCOPE-002 day scope keeps task identity but includes only requests observed on that day", () => {
  const stored = storedFixture();
  const day1 = materializeScopedSnapshot(stored, {
    type: "day",
    day: DAY1,
    range: resolveLocalDayRange(DAY1),
  });
  const day2 = materializeScopedSnapshot(stored, {
    type: "day",
    day: DAY2,
    range: resolveLocalDayRange(DAY2),
  });

  const day1Task = onlyTask(day1);
  const day2Task = onlyTask(day2);
  assert.equal(day1Task.turnId, "turn-a");
  assert.equal(day2Task.turnId, "turn-a");
  assert.equal(day1Task.requestCount, 1);
  assert.equal(day1Task.deltaUsage.totalTokens, 100);
  assert.equal(day2Task.requestCount, 2);
  assert.equal(day2Task.deltaUsage.totalTokens, 350);
});

test("BIZ-SCOPE-003 full session equals the sum of all request-day slices for all six usage fields", () => {
  const stored = storedFixture();
  const full = materializeScopedSnapshot(stored, { type: "session" });
  const day1 = materializeScopedSnapshot(stored, {
    type: "day", day: DAY1, range: resolveLocalDayRange(DAY1),
  });
  const day2 = materializeScopedSnapshot(stored, {
    type: "day", day: DAY2, range: resolveLocalDayRange(DAY2),
  });

  for (const field of USAGE_FIELDS) {
    assert.equal(
      full.summary.totalUsage[field],
      day1.summary.totalUsage[field] + day2.summary.totalUsage[field],
      field,
    );
  }
  assert.equal(
    full.summary.modelRequestCount,
    day1.summary.modelRequestCount + day2.summary.modelRequestCount,
  );
});

test("BIZ-SCOPE-004 a task with no request on the selected day stays in full session but not in the day slice", () => {
  const stored = storedFixture({ includeIdleTask: true });
  const full = materializeScopedSnapshot(stored, { type: "session" });
  const day2 = materializeScopedSnapshot(stored, {
    type: "day", day: DAY2, range: resolveLocalDayRange(DAY2),
  });

  assert.equal(full.summary.taskCount, 2);
  assert.equal(day2.summary.taskCount, 1);
  assert.deepEqual(
    day2.agents.flatMap((agent) => agent.tasks.map((taskRow) => taskRow.turnId)),
    ["turn-a"],
  );
});

test("BIZ-OWN-001 inherited history and a new request in the same turn keep only the new accounting usage", () => {
  const externalRequestId = `reqr_${"a".repeat(64)}`;
  const rootId = "root-b";
  const agents = [{
    rootSessionId: rootId,
    threadId: rootId,
    parentThreadId: null,
    depth: 0,
    isRoot: true,
    firstSeenAt: localIso(DAY2, 9),
  }];
  const tasks = [{
    ...makeTask("turn-shared"),
    rootSessionId: rootId,
    threadId: rootId,
    startedAt: localIso(DAY1, 12),
  }];
  const events = [
    makeEvent({
      rootId,
      turnId: "turn-shared",
      lineNumber: 10,
      observedAt: localIso(DAY2, 9, 5),
      eventUsage: usage({ input: 80, cached: 20, output: 20, reasoning: 5, total: 100 }),
      requestIdentity: externalRequestId,
    }),
    makeEvent({
      rootId,
      turnId: "turn-shared",
      lineNumber: 20,
      observedAt: localIso(DAY2, 9, 10),
      eventUsage: usage({ input: 40, cached: 10, output: 10, reasoning: 2, total: 50 }),
    }),
  ];

  const resolved = resolveCanonicalRequestOwnership({
    agents,
    tasks,
    events,
    rootCreatedAt: localIso(DAY2, 9),
    externalCanonicalRequestIds: new Set([externalRequestId]),
  });

  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.requests.length, 1);
  assert.equal(resolved.requests[0].usage.totalTokens, 50);
  assert.equal(resolved.reconciliation.canonicalVerifiedTokens, 50);
  assert.equal(resolved.reconciliation.inheritedVerifiedTokens, 100);
});

test("BIZ-OWN-002 verified evidence conservation holds for every usage field", () => {
  const externalRequestId = `reqr_${"b".repeat(64)}`;
  const rootId = "root-b";
  const events = [
    makeEvent({
      rootId,
      turnId: "turn-shared",
      lineNumber: 10,
      observedAt: localIso(DAY2, 9, 5),
      eventUsage: usage({ input: 80, cached: 20, cacheWrite: 3, output: 20, reasoning: 5, total: 100 }),
      requestIdentity: externalRequestId,
    }),
    makeEvent({
      rootId,
      turnId: "turn-shared",
      lineNumber: 20,
      observedAt: localIso(DAY2, 9, 10),
      eventUsage: usage({ input: 40, cached: 10, cacheWrite: 2, output: 10, reasoning: 2, total: 50 }),
    }),
  ];
  const resolved = resolveCanonicalRequestOwnership({
    agents: [{ rootSessionId: rootId, threadId: rootId, depth: 0, isRoot: true }],
    tasks: [{ ...makeTask("turn-shared"), rootSessionId: rootId, threadId: rootId }],
    events,
    externalCanonicalRequestIds: new Set([externalRequestId]),
  });

  for (const field of USAGE_FIELDS) {
    assert.equal(
      resolved.reconciliation.rawUsage[field],
      resolved.reconciliation.canonicalUsage[field] +
        resolved.reconciliation.inheritedUsage[field] +
        resolved.reconciliation.unresolvedUsage[field],
      field,
    );
  }
  assert.equal(resolved.reconciliation.conserved, true);
});

test("BIZ-TIME-001 copied request timestamp cannot move externally owned usage into the new day", () => {
  const externalRequestId = `reqr_${"c".repeat(64)}`;
  const rootId = "root-b";
  const taskRow = {
    ...makeTask("turn-shared"),
    rootSessionId: rootId,
    threadId: rootId,
    startedAt: localIso(DAY1, 12),
  };
  const resolved = resolveCanonicalRequestOwnership({
    agents: [{ rootSessionId: rootId, threadId: rootId, depth: 0, isRoot: true }],
    tasks: [taskRow],
    events: [
      makeEvent({
        rootId,
        turnId: "turn-shared",
        lineNumber: 10,
        observedAt: localIso(DAY2, 10),
        eventUsage: usage({ input: 80, cached: 20, output: 20, reasoning: 5, total: 100 }),
        requestIdentity: externalRequestId,
      }),
      makeEvent({
        rootId,
        turnId: "turn-shared",
        lineNumber: 20,
        observedAt: localIso(DAY2, 10, 5),
        eventUsage: usage({ input: 40, cached: 10, output: 10, reasoning: 2, total: 50 }),
      }),
    ],
    rootCreatedAt: localIso(DAY2, 9),
    externalCanonicalRequestIds: new Set([externalRequestId]),
  });

  const day2 = materializeScopedSnapshot({
    session: { id: rootId, createdAt: localIso(DAY2, 9) },
    agents: [{ rootSessionId: rootId, threadId: rootId, depth: 0, isRoot: true }],
    tasks: resolved.tasks,
    modelUsageEvents: resolved.events,
  }, {
    type: "day",
    day: DAY2,
    range: resolveLocalDayRange(DAY2),
  }, { ownershipResolved: true });

  assert.equal(day2.summary.modelRequestCount, 1);
  assert.equal(day2.summary.totalUsage.totalTokens, 50);
});
