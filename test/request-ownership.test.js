import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MonitorDatabase } from "../src/database.js";
import { UsageMonitor } from "../src/monitor.js";
import { resolveCanonicalRequestOwnership } from "../src/request-ownership.js";
import { materializeRequestLedgerTasks } from "../src/request-ledger.js";
import { priceTasksByRequestEvents } from "../src/pricing.js";
import { materializeScopedSnapshot } from "../src/snapshot-scope.js";

function task(threadId, turnId, startedAt = "2026-08-01T15:00:00.000Z") {
  return {
    rootSessionId: "root",
    threadId,
    turnId,
    sequence: 1,
    status: "completed",
    startedAt,
    completedAt: startedAt,
    model: "gpt-5.6-terra",
  };
}

function event(threadId, turnId, observedAt, totalTokens) {
  return {
    rootSessionId: "root",
    sourceKey: `${threadId}.jsonl`,
    lineNumber: totalTokens,
    threadId,
    turnId,
    observedAt,
    classification: "verified_increment",
    quality: "complete",
    usage: {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
    },
    model: "gpt-5.6-terra",
    serviceTier: "default",
    pricingContextQuality: "verified",
  };
}

const agents = [
  { threadId: "root", parentThreadId: null, depth: 0, isRoot: true },
  { threadId: "a", parentThreadId: "root", depth: 1, isRoot: false },
  { threadId: "b", parentThreadId: "a", depth: 2, isRoot: false },
];

test("T-OWN-001/002 canonical owner stays with the ancestor that created the turn", () => {
  const tasks = [
    task("root", "root-turn"),
    task("a", "root-turn"),
    task("b", "root-turn"),
    task("a", "a-turn"),
    task("b", "a-turn"),
    task("b", "b-turn"),
  ];
  const events = [
    event("root", "root-turn", "2026-08-01T15:00:01.000Z", 100),
    event("a", "root-turn", "2026-08-02T01:00:00.000Z", 100),
    event("b", "root-turn", "2026-08-02T02:00:00.000Z", 100),
    event("a", "a-turn", "2026-08-02T01:01:00.000Z", 200),
    event("b", "a-turn", "2026-08-02T02:01:00.000Z", 200),
    event("b", "b-turn", "2026-08-02T02:02:00.000Z", 300),
  ];

  const resolved = resolveCanonicalRequestOwnership({ agents, tasks, events });

  assert.deepEqual(
    resolved.tasks.map((row) => [row.turnId, row.threadId]),
    [["root-turn", "root"], ["a-turn", "a"], ["b-turn", "b"]],
  );
  assert.deepEqual(
    resolved.events.map((row) => [row.turnId, row.threadId]),
    [["root-turn", "root"], ["a-turn", "a"], ["b-turn", "b"]],
  );
  assert.equal(resolved.reconciliation.canonicalVerifiedTokens, 600);
  assert.equal(resolved.reconciliation.inheritedVerifiedTokens, 400);
  assert.equal(resolved.reconciliation.unresolvedVerifiedTokens, 0);
  assert.equal(resolved.reconciliation.rawVerifiedTokens, 1000);
});

test("T-OWN-003 sibling collision is unresolved instead of guessed", () => {
  const siblingAgents = [
    { threadId: "root", parentThreadId: null, depth: 0, isRoot: true },
    { threadId: "a", parentThreadId: "root", depth: 1, isRoot: false },
    { threadId: "c", parentThreadId: "root", depth: 1, isRoot: false },
  ];
  const tasks = [task("a", "collision"), task("c", "collision")];
  const events = [
    event("a", "collision", "2026-08-02T01:00:00.000Z", 40),
    event("c", "collision", "2026-08-02T01:00:00.000Z", 40),
  ];
  const resolved = resolveCanonicalRequestOwnership({ agents: siblingAgents, tasks, events });

  assert.equal(resolved.tasks.length, 0);
  assert.equal(resolved.events.length, 0);
  assert.equal(resolved.reconciliation.unresolvedVerifiedTokens, 80);
  assert.equal(resolved.reconciliation.rawVerifiedTokens, 80);
});

test("T-OWN-005 later sibling legacy history cannot steal an earlier sibling task", () => {
  const siblingAgents = [
    {
      threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-02T00:00:00.000Z",
    },
    {
      threadId: "a", parentThreadId: "root", depth: 1, isRoot: false,
      firstSeenAt: "2026-08-02T01:00:00.000Z",
    },
    {
      threadId: "c", parentThreadId: "root", depth: 1, isRoot: false,
      firstSeenAt: "2026-08-02T03:00:00.000Z",
    },
  ];
  const tasks = [
    task("a", "a-local", "2026-08-02T02:00:00.000Z"),
    task("c", "a-local", "2026-08-02T02:00:00.000Z"),
  ];
  const events = [
    event("a", "a-local", "2026-08-02T02:01:00.000Z", 60),
    event("c", "a-local", "2026-08-02T03:00:00.001Z", 60),
  ];
  const resolved = resolveCanonicalRequestOwnership({ agents: siblingAgents, tasks, events });

  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].threadId, "a");
  assert.equal(resolved.events.length, 1);
  assert.equal(resolved.events[0].threadId, "a");
  assert.equal(resolved.reconciliation.inheritedVerifiedTokens, 60);
});

test("T-DAY2-002/003 copied envelope timestamps cannot move ancestor usage into another day", () => {
  const stored = {
    session: { id: "root" },
    agents,
    tasks: [task("root", "root-turn"), task("a", "root-turn")],
    modelUsageEvents: [
      event("root", "root-turn", "2026-08-01T15:00:01.000Z", 100),
      event("a", "root-turn", "2026-08-02T01:00:00.000Z", 100),
    ],
  };

  const day2 = materializeScopedSnapshot(stored, {
    type: "day",
    day: "2026-08-02",
    range: {
      day: "2026-08-02",
      startMs: Date.parse("2026-08-02T00:00:00.000Z"),
      endMs: Date.parse("2026-08-03T00:00:00.000Z"),
      timezone: "UTC",
    },
  });

  assert.equal(day2.summary.taskCount, 0);
  assert.equal(day2.summary.totalUsage.totalTokens, 0);
  assert.equal(day2.summary.modelRequestCount, 0);
});

test("T-ZERO-001 unchanged cumulative evidence proves a no-request task costs zero", () => {
  const zeroTask = {
    ...task("root", "zero-turn", "2026-08-02T02:27:18.572Z"),
    completedAt: "2026-08-02T02:27:43.055Z",
    zeroUsageVerified: true,
  };
  const [materialized] = materializeRequestLedgerTasks([zeroTask], []);
  const [priced] = priceTasksByRequestEvents([materialized], []);

  assert.equal(materialized.zeroUsageVerified, true);
  assert.equal(materialized.deltaUsage.totalTokens, 0);
  assert.equal(materialized.quality, "complete");
  assert.equal(priced.costEstimate.status, "estimated");
  assert.equal(priced.costEstimate.amountUsd, 0);
});

test("T-ZERO-002 missing post-task unchanged proof stays partial", () => {
  const zeroTask = {
    ...task("root", "zero-turn", "2026-08-02T02:27:18.572Z"),
    completedAt: "2026-08-02T02:27:43.055Z",
  };
  const [materialized] = materializeRequestLedgerTasks([zeroTask], []);
  assert.equal(materialized.zeroUsageVerified, false);
  assert.equal(materialized.deltaUsage, null);
  assert.equal(materialized.quality, "partial");
});

test("T-PROJ-001/002 raw fork copies remain auditable but runtime reads canonical projection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-ownership-projection-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });
  const projectionAgents = [
    {
      rootSessionId: "root", threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-03T00:00:00.000Z",
    },
    {
      rootSessionId: "root", threadId: "a", parentThreadId: "root", depth: 1, isRoot: false,
      firstSeenAt: "2026-08-02T01:00:00.000Z", lastSeenAt: "2026-08-03T00:00:00.000Z",
    },
  ];
  const rootTask = task("root", "root-turn", "2026-08-01T15:00:00.000Z");
  const copiedRootTask = task("a", "root-turn", "2026-08-01T15:00:00.000Z");
  const localTask = task("a", "a-turn", "2026-08-02T02:00:00.000Z");
  const snapshot = {
    session: { id: "root", title: "", createdAt: "2026-08-01T00:00:00Z" },
    agents: projectionAgents,
    tasks: [rootTask, copiedRootTask, localTask],
    modelUsageEvents: [
      event("root", "root-turn", "2026-08-01T15:01:00.000Z", 100),
      event("a", "root-turn", "2026-08-02T01:00:00.000Z", 100),
      event("a", "a-turn", "2026-08-02T02:01:00.000Z", 200),
    ],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  };

  database.replaceSession(snapshot, { persistQuotas: false });
  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c, 3);
  assert.equal(database.getSession("root").tasks.length, 2);
  assert.equal(database.getSession("root").modelUsageEvents.length, 2);
  assert.equal(database.getRawSession("root").modelUsageEvents.length, 3);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM canonical_requests").get().c, 2);
  const persistedAgents = new Map(
    database.getRawSession("root").agents.map((agent) => [agent.threadId, agent]),
  );
  assert.equal(persistedAgents.get("root").ownUsage.totalTokens, 100);
  assert.equal(persistedAgents.get("a").ownUsage.totalTokens, 200);
  assert.equal(persistedAgents.get("root").subtreeUsage.totalTokens, 300);
  const inherited = database.db.prepare(`
    SELECT canonical_request_id FROM event_ownership WHERE status='inherited_copy' LIMIT 1
  `).get();
  assert.match(inherited.canonical_request_id, /^reqr_[0-9a-f]{64}$/u);
  const day2 = database.getSessionDay("root", {
    startMs: Date.parse("2026-08-02T00:00:00.000Z"),
    endMs: Date.parse("2026-08-03T00:00:00.000Z"),
  });
  assert.deepEqual(day2.tasks.map((row) => row.turnId), ["a-turn"]);
  assert.equal(day2.modelUsageEvents.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0), 200);
  const ownershipCounts = database.getHealthStats().ownership;
  assert.equal(ownershipCounts.canonicalEvents, 2);
  assert.equal(ownershipCounts.inheritedEvents, 1);
  assert.equal(ownershipCounts.unresolvedEvents, 0);
  assert.equal(database.getHealthStats().canonicalRequestRows, 2);
  assert.equal(database.getTimeline().projection.version, 2);
  assert.ok(database.getTimeline().projection.generation > 0);
});

test("T-PROJ-007 cross-root legacy history stays provenance and cannot duplicate a canonical request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cross-root-projection-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  const originalRoot = "root-a";
  const copiedRoot = "root-b";
  const turnId = "turn-shared";
  const originalSource = "sessions/2026/08/01/rollout-root-a.jsonl";
  const copiedSource = "sessions/2026/08/02/rollout-root-b.jsonl";
  const makeSnapshot = ({ rootId, sourceKey, createdAt, taskStartedAt }) => ({
    session: { id: rootId, title: "", createdAt },
    agents: [{
      rootSessionId: rootId,
      threadId: rootId,
      parentThreadId: null,
      depth: 0,
      isRoot: true,
      rolloutKey: sourceKey,
      firstSeenAt: createdAt,
      lastSeenAt: "2026-08-02T03:00:00.000Z",
    }],
    tasks: [{
      ...task(rootId, turnId, taskStartedAt),
      rootSessionId: rootId,
      sourceKey,
    }],
    modelUsageEvents: [{
      ...event(rootId, turnId, "2026-08-01T15:01:00.000Z", 100),
      rootSessionId: rootId,
      sourceKey,
      lineNumber: 10,
    }],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  });

  database.replaceSession(makeSnapshot({
    rootId: originalRoot,
    sourceKey: originalSource,
    createdAt: "2026-08-01T14:00:00.000Z",
    taskStartedAt: "2026-08-01T15:00:00.000Z",
  }), { persistQuotas: false });

  assert.doesNotThrow(() => database.replaceSession(makeSnapshot({
    rootId: copiedRoot,
    sourceKey: copiedSource,
    createdAt: "2026-08-02T14:00:00.000Z",
    taskStartedAt: "2026-08-01T15:00:00.000Z",
  }), { persistQuotas: false }));

  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM canonical_requests").get().c, 1);
  assert.equal(database.getSession(originalRoot).modelUsageEvents.length, 1);
  assert.equal(database.getSession(copiedRoot).modelUsageEvents.length, 0);
  assert.equal(database.getSession(copiedRoot).tasks.length, 0);
  const copiedOwnership = database.db.prepare(`
    SELECT status, canonical_request_id
    FROM event_ownership
    WHERE root_session_id=? AND source_key=? AND line_number=?
  `).get(copiedRoot, copiedSource, 10);
  assert.equal(copiedOwnership.status, "inherited_copy");
  assert.match(copiedOwnership.canonical_request_id, /^reqr_[0-9a-f]{64}$/u);
  const timelineRows = database.db.prepare(`
    SELECT SUM(total_tokens) AS total_tokens, SUM(model_request_count) AS requests
    FROM session_day_usage
  `).get();
  assert.equal(Number(timelineRows.total_tokens), 100);
  assert.equal(Number(timelineRows.requests), 1);
});

test("T-PROJ-008 cross-root provenance backfills when the original root is indexed later", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cross-root-reverse-order-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  const turnId = "turn-shared";
  const makeSnapshot = ({ rootId, sourceKey, createdAt, taskStartedAt }) => ({
    session: { id: rootId, title: "", createdAt },
    agents: [{
      rootSessionId: rootId,
      threadId: rootId,
      parentThreadId: null,
      depth: 0,
      isRoot: true,
      rolloutKey: sourceKey,
      firstSeenAt: createdAt,
      lastSeenAt: "2026-08-02T03:00:00.000Z",
    }],
    tasks: [{
      ...task(rootId, turnId, taskStartedAt),
      rootSessionId: rootId,
      sourceKey,
    }],
    modelUsageEvents: [{
      ...event(rootId, turnId, "2026-08-01T15:01:00.000Z", 100),
      rootSessionId: rootId,
      sourceKey,
      lineNumber: 10,
    }],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  });

  const copiedRoot = "root-b";
  const copiedSource = "sessions/2026/08/02/rollout-root-b.jsonl";
  database.replaceSession(makeSnapshot({
    rootId: copiedRoot,
    sourceKey: copiedSource,
    createdAt: "2026-08-02T14:00:00.000Z",
    taskStartedAt: "2026-08-01T15:00:00.000Z",
  }), { persistQuotas: false });
  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM canonical_requests").get().c, 0);

  database.replaceSession(makeSnapshot({
    rootId: "root-a",
    sourceKey: "sessions/2026/08/01/rollout-root-a.jsonl",
    createdAt: "2026-08-01T14:00:00.000Z",
    taskStartedAt: "2026-08-01T15:00:00.000Z",
  }), { persistQuotas: false });

  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM canonical_requests").get().c, 1);
  const copiedOwnership = database.db.prepare(`
    SELECT status, canonical_request_id
    FROM event_ownership
    WHERE root_session_id=? AND source_key=? AND line_number=?
  `).get(copiedRoot, copiedSource, 10);
  assert.equal(copiedOwnership.status, "inherited_copy");
  assert.match(copiedOwnership.canonical_request_id, /^reqr_[0-9a-f]{64}$/u);
  const timelineRows = database.db.prepare(`
    SELECT SUM(total_tokens) AS total_tokens, SUM(model_request_count) AS requests
    FROM session_day_usage
  `).get();
  assert.equal(Number(timelineRows.total_tokens), 100);
  assert.equal(Number(timelineRows.requests), 1);
});

test("T-PROJ-009 global request identity is a duplicate-accounting guard even when copied task time is rewritten", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cross-root-identity-guard-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  const turnId = "turn-shared";
  const makeSnapshot = ({ rootId, sourceKey, createdAt, taskStartedAt, observedAt }) => ({
    session: { id: rootId, title: "", createdAt },
    agents: [{
      rootSessionId: rootId,
      threadId: rootId,
      parentThreadId: null,
      depth: 0,
      isRoot: true,
      rolloutKey: sourceKey,
      firstSeenAt: createdAt,
      lastSeenAt: "2026-08-02T18:00:00.000Z",
    }],
    tasks: [{
      ...task(rootId, turnId, taskStartedAt),
      rootSessionId: rootId,
      sourceKey,
    }],
    modelUsageEvents: [{
      ...event(rootId, turnId, observedAt, 100),
      rootSessionId: rootId,
      sourceKey,
      lineNumber: 10,
    }],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  });

  database.replaceSession(makeSnapshot({
    rootId: "root-a",
    sourceKey: "sessions/2026/08/01/rollout-root-a.jsonl",
    createdAt: "2026-08-01T14:00:00.000Z",
    taskStartedAt: "2026-08-01T15:00:00.000Z",
    observedAt: "2026-08-01T15:01:00.000Z",
  }), { persistQuotas: false });

  assert.doesNotThrow(() => database.replaceSession(makeSnapshot({
    rootId: "root-b",
    sourceKey: "sessions/2026/08/02/rollout-root-b.jsonl",
    createdAt: "2026-08-02T14:00:00.000Z",
    taskStartedAt: "2026-08-02T15:00:00.000Z",
    observedAt: "2026-08-02T15:01:00.000Z",
  }), { persistQuotas: false }));

  assert.equal(database.db.prepare("SELECT COUNT(*) AS c FROM canonical_requests").get().c, 1);
  assert.equal(database.getSession("root-b").modelUsageEvents.length, 0);
  assert.equal(database.getSession("root-b").tasks.length, 0);
  const copiedOwnership = database.db.prepare(`
    SELECT status, canonical_request_id
    FROM event_ownership
    WHERE root_session_id='root-b'
  `).get();
  assert.equal(copiedOwnership.status, "inherited_copy");
  assert.match(copiedOwnership.canonical_request_id, /^reqr_[0-9a-f]{64}$/u);
});

test("T-PROJ-010 stale projection semantics rebuild from persisted raw evidence without a schema bump", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-projection-version-rebuild-"));
  const databasePath = join(directory, "usage.sqlite");
  let database = new MonitorDatabase(databasePath);
  t.after(() => {
    database?.close();
    return rm(directory, { recursive: true, force: true });
  });

  database.replaceSession({
    session: { id: "root", title: "", createdAt: "2026-08-01T14:00:00.000Z" },
    agents: [{
      rootSessionId: "root", threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-01T14:00:00.000Z", lastSeenAt: "2026-08-01T16:00:00.000Z",
    }],
    tasks: [task("root", "turn-a", "2026-08-01T15:00:00.000Z")],
    modelUsageEvents: [event("root", "turn-a", "2026-08-01T15:01:00.000Z", 100)],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  }, { persistQuotas: false });
  database.db.prepare("UPDATE session_day_usage SET total_tokens=999").run();
  database.db.prepare(`
    INSERT INTO derived_state (key, value) VALUES ('projection_version', '0')
    ON CONFLICT(key) DO UPDATE SET value='0'
  `).run();
  database.close();
  database = null;

  database = new MonitorDatabase(databasePath);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, 14);
  assert.equal(database.getTimeline().usage.totalTokens, 100);
  assert.equal(database.getTimeline().projection.version, 2);
  assert.equal(
    database.db.prepare("SELECT value FROM derived_state WHERE key='projection_version'").get().value,
    "2",
  );
});

test("T-PROJ-011 a turn with inherited history and a new request keeps only the new accounting usage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cross-root-mixed-turn-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  const original = {
    session: { id: "root-a", title: "", createdAt: "2026-08-01T14:00:00.000Z" },
    agents: [{
      rootSessionId: "root-a", threadId: "root-a", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-01T14:00:00.000Z", lastSeenAt: "2026-08-01T16:00:00.000Z",
    }],
    tasks: [task("root-a", "turn-shared", "2026-08-01T15:00:00.000Z")],
    modelUsageEvents: [{
      ...event("root-a", "turn-shared", "2026-08-01T15:01:00.000Z", 100),
      sourceKey: "sessions/2026/08/01/rollout-root-a.jsonl",
      lineNumber: 10,
    }],
    cursors: [], quotas: [], health: { status: "healthy" },
  };
  database.replaceSession(original, { persistQuotas: false });
  const originalRequestId = database.getCanonicalModelUsageEvents("root-a")[0].requestIdentity;

  const copiedOldEvent = {
    ...event("root-b", "turn-shared", "2026-08-02T15:01:00.000Z", 100),
    rootSessionId: "root-b",
    sourceKey: "sessions/2026/08/02/rollout-root-b.jsonl",
    lineNumber: 10,
    requestIdentity: originalRequestId,
    requestIdentityKind: "reconstructed",
    requestIdentityReason: "deterministic_request_reconstruction",
  };
  const newEvent = {
    ...event("root-b", "turn-shared", "2026-08-02T15:02:00.000Z", 50),
    rootSessionId: "root-b",
    sourceKey: "sessions/2026/08/02/rollout-root-b.jsonl",
    lineNumber: 20,
  };
  database.replaceSession({
    session: { id: "root-b", title: "", createdAt: "2026-08-02T14:00:00.000Z" },
    agents: [{
      rootSessionId: "root-b", threadId: "root-b", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-02T14:00:00.000Z", lastSeenAt: "2026-08-02T16:00:00.000Z",
    }],
    tasks: [task("root-b", "turn-shared", "2026-08-01T15:00:00.000Z")],
    modelUsageEvents: [copiedOldEvent, newEvent],
    cursors: [], quotas: [], health: { status: "healthy" },
  }, { persistQuotas: false });

  const rootB = database.getSession("root-b");
  assert.equal(rootB.tasks.length, 1);
  assert.equal(rootB.modelUsageEvents.length, 1);
  assert.equal(rootB.modelUsageEvents[0].usage.totalTokens, 50);
  assert.equal(rootB.tasks[0].turnId, "turn-shared");
  const ownership = database.db.prepare(`
    SELECT line_number, status, canonical_request_id
    FROM event_ownership
    WHERE root_session_id='root-b'
    ORDER BY line_number
  `).all();
  assert.equal(ownership[0].status, "inherited_copy");
  assert.equal(ownership[0].canonical_request_id, originalRequestId);
  assert.equal(ownership[1].status, "canonical");
  assert.equal(database.getTimeline().modelRequestCount, 2);
  assert.equal(database.getTimeline().usage.totalTokens, 150);
  const monitor = new UsageMonitor({
    repository: {
      sessions: new Map(),
      getSession: () => null,
      summary: () => ({}),
    },
    database,
  });
  const snapshot = monitor.snapshot("root-b");
  assert.equal(snapshot.summary.taskCount, 1);
  assert.equal(snapshot.summary.modelRequestCount, 1);
  assert.equal(snapshot.summary.totalUsage.totalTokens, 50);
  await monitor.close();
});

test("T-PROJ-005 present source authoritatively removes stale tasks and request evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-authoritative-source-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });
  const sourceKey = "sessions/2026/08/01/rollout-root.jsonl";
  const agent = {
    rootSessionId: "root", threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
    rolloutKey: sourceKey, firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T03:00:00.000Z",
  };
  const firstTask = { ...task("root", "keep-turn"), sourceKey };
  const staleTask = { ...task("root", "stale-turn", "2026-08-01T16:00:00.000Z"), sequence: 2, sourceKey };
  const firstEvent = {
    ...event("root", "keep-turn", "2026-08-01T15:01:00.000Z", 100),
    sourceKey,
    lineNumber: 10,
  };
  const staleEvent = {
    ...event("root", "stale-turn", "2026-08-01T16:01:00.000Z", 200),
    sourceKey,
    lineNumber: 20,
  };
  const cursor = {
    sourceKey, threadId: "root", byteOffset: 100, lineNumber: 20, fileSize: 100,
    modifiedAtMs: 1, lastOrdinal: 20,
  };

  database.replaceSession({
    session: { id: "root" }, agents: [agent], tasks: [firstTask, staleTask],
    modelUsageEvents: [firstEvent, staleEvent], cursors: [cursor], quotas: [],
    health: { status: "healthy" },
  }, { persistQuotas: false });
  database.replaceSession({
    session: { id: "root" }, agents: [agent], tasks: [firstTask],
    modelUsageEvents: [firstEvent], cursors: [cursor], quotas: [],
    health: { status: "healthy" },
  }, { persistQuotas: false });

  assert.deepEqual(database.getRawSession("root").tasks.map((row) => row.turnId), ["keep-turn"]);
  assert.equal(database.getRawSession("root").modelUsageEvents.length, 1);
  assert.equal(database.getHealthStats().canonicalRequestRows, 1);
});

test("T-INDEX-004 missing source keeps historical task and request evidence while present source replaces itself", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-missing-source-preserve-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });
  const sourceA = "sessions/2026/08/01/rollout-a.jsonl";
  const sourceB = "sessions/2026/08/02/rollout-b.jsonl";
  const agent = {
    rootSessionId: "root", threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
    rolloutKey: sourceA, firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-02T03:00:00.000Z",
  };
  const historicalTask = { ...task("root", "historical-turn"), sourceKey: sourceA };
  const historicalEvent = {
    ...event("root", "historical-turn", "2026-08-01T15:01:00.000Z", 100),
    sourceKey: sourceA,
    lineNumber: 10,
  };
  database.replaceSession({
    session: { id: "root" }, agents: [agent], tasks: [historicalTask],
    modelUsageEvents: [historicalEvent],
    cursors: [{ sourceKey: sourceA, threadId: "root", byteOffset: 100, lineNumber: 10, fileSize: 100 }],
    quotas: [], health: { status: "healthy" },
  }, { persistQuotas: false });

  const currentTask = { ...task("root", "current-turn", "2026-08-02T15:00:00.000Z"), sourceKey: sourceB };
  const currentEvent = {
    ...event("root", "current-turn", "2026-08-02T15:01:00.000Z", 200),
    sourceKey: sourceB,
    lineNumber: 20,
  };
  database.replaceSession({
    session: { id: "root" }, agents: [{ ...agent, rolloutKey: sourceB }], tasks: [currentTask],
    modelUsageEvents: [currentEvent],
    cursors: [{ sourceKey: sourceB, threadId: "root", byteOffset: 100, lineNumber: 20, fileSize: 100 }],
    quotas: [], health: { status: "healthy" },
  }, { persistQuotas: false });

  assert.deepEqual(
    database.getRawSession("root").tasks.map((row) => row.turnId).sort(),
    ["current-turn", "historical-turn"],
  );
  assert.equal(database.getRawSession("root").modelUsageEvents.length, 2);
  assert.equal(database.getHealthStats().canonicalRequestRows, 2);
  assert.equal(database.getSession("root").modelUsageEvents.reduce(
    (sum, row) => sum + (row.usage?.totalTokens ?? 0), 0,
  ), 300);
});

test("T-PROJ-006 unattributed fallback consumes canonical ownership instead of raw fork copies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-canonical-unattributed-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  t.after(() => {
    database.close();
    return rm(directory, { recursive: true, force: true });
  });
  const sourceRoot = "sessions/2026/08/01/rollout-root.jsonl";
  const sourceChild = "sessions/2026/08/01/rollout-child.jsonl";
  const projectionAgents = [
    {
      rootSessionId: "root", threadId: "root", parentThreadId: null, depth: 0, isRoot: true,
      firstSeenAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T02:00:00.000Z",
      rolloutKey: sourceRoot,
    },
    {
      rootSessionId: "root", threadId: "a", parentThreadId: "root", depth: 1, isRoot: false,
      firstSeenAt: "2026-08-01T01:00:00.000Z", lastSeenAt: "2026-08-01T02:00:00.000Z",
      rolloutKey: sourceChild,
    },
  ];
  const rootTask = { ...task("root", "legacy-turn", null), startedAt: null, completedAt: null, sourceKey: sourceRoot };
  const copyTask = { ...task("a", "legacy-turn", null), startedAt: null, completedAt: null, sourceKey: sourceChild };
  const rootEvent = { ...event("root", "legacy-turn", null, 100), sourceKey: sourceRoot, lineNumber: 10 };
  const copyEvent = { ...event("a", "legacy-turn", null, 100), sourceKey: sourceChild, lineNumber: 10 };

  database.replaceSession({
    session: { id: "root" },
    agents: projectionAgents,
    tasks: [rootTask, copyTask],
    modelUsageEvents: [rootEvent, copyEvent],
    cursors: [
      { sourceKey: sourceRoot, threadId: "root", byteOffset: 1, lineNumber: 10, fileSize: 1 },
      { sourceKey: sourceChild, threadId: "a", byteOffset: 1, lineNumber: 10, fileSize: 1 },
    ],
    quotas: [],
    health: { status: "healthy" },
  }, { persistQuotas: false });

  const timeline = database.getTimeline();
  assert.equal(timeline.unattributed.taskCount, 1);
  assert.equal(timeline.unattributed.modelRequestCount, 1);
  assert.equal(timeline.unattributed.usage.totalTokens, 100);
  assert.equal(timeline.usage.totalTokens, 100);
});

test("T-PROJ-003 monitor Timeline does not call the retired full-history cost path", async () => {
  const timeline = { usage: { totalTokens: 1 }, months: [{ key: "2026-08", days: [] }] };
  const database = {
    getTimeline: () => timeline,
    getTimelineCostTasks: () => {
      throw new Error("full-history cost path must not run");
    },
  };
  const repository = { sessions: new Map() };
  const monitor = new UsageMonitor({ repository, database });
  const result = await monitor.timeline();
  assert.equal(result, timeline);
  monitor.close();
});

test("T-INDEX-005 graceful close waits for the active index job and cancels queued sessions", async () => {
  const monitor = new UsageMonitor({
    repository: { sessions: new Map() },
    database: {},
  });
  monitor.timelineDirtySessions.add("active");
  monitor.timelineDirtySessions.add("queued");
  let releaseActive;
  let activeStarted;
  const started = new Promise((resolve) => { activeStarted = resolve; });
  const release = new Promise((resolve) => { releaseActive = resolve; });
  const calls = [];
  monitor.syncTimelineSession = async (sessionId) => {
    calls.push(sessionId);
    activeStarted();
    await release;
    return { replayedFiles: 0, tailedFiles: 1 };
  };

  const indexing = monitor.runBackgroundIndexer();
  await started;
  let closed = false;
  const closing = monitor.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(calls, ["active"]);
  assert.equal(monitor.timelineDirtySessions.size, 0);

  releaseActive();
  await Promise.all([indexing, closing]);
  assert.equal(closed, true);
  assert.deepEqual(calls, ["active"]);
});
