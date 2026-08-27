import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MonitorDatabase } from "../src/database.js";
import { UsageMonitor } from "../src/monitor.js";
import { CodexRepository } from "../src/repository.js";
import { resolveCodexHome, resolveDatabasePath, startApplication } from "../src/server.js";
import { CodexSourceLocator, recoverLegacySourceKey } from "../src/source-locator.js";
import { zeroUsage } from "../src/usage.js";

const ROOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIBLING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SIBLING_TURN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GRANDCHILD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const GRANDCHILD_TURN = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOT = "22222222-2222-4222-8222-222222222222";
const OTHER_TURN = "33333333-3333-4333-8333-333333333333";

process.env.TZ = "America/Los_Angeles";

test("calendar aggregate includes unselected sessions and local-day quality", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-calendar-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-first-${ROOT}.jsonl`),
    makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"),
  );
  await writeFile(
    join(sessions, `rollout-second-${OTHER_ROOT}.jsonl`),
    makeCalendarRootRollout(OTHER_ROOT, OTHER_TURN, 240, "2026-08-25T12:00:00.000Z"),
  );
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  t.after(() => {
    monitor.close();
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  await monitor.initialize();
  const timeline = await monitor.timeline();
  const sessionsById = new Map(
    timeline.months.flatMap((month) => month.days.flatMap((day) => day.sessions))
      .map((session) => [session.id, session]),
  );
  assert.equal(sessionsById.size, 2);
  assert.equal(sessionsById.get(ROOT).usage.totalTokens, 100);
  assert.equal(sessionsById.get(OTHER_ROOT).usage.totalTokens, 240);
  assert.equal(sessionsById.get(ROOT).costEstimate.status, "estimated");
  assert.equal(sessionsById.get(ROOT).costEstimate.amountUsd, 0.0003);
  assert.equal(sessionsById.get(OTHER_ROOT).costEstimate.amountUsd, 0.00058);
  assert.equal(timeline.months[0].costEstimate.amountUsd, 0.00088);
  assert.deepEqual(
    [...sessionsById.values()].map((session) => session.date).sort(),
    [localDayKey("2026-08-24T12:00:00.000Z"), localDayKey("2026-08-25T12:00:00.000Z")].sort(),
  );
  assert.equal(timeline.unattributed.taskCount, 0);
  assert.equal(timeline.qualityCounts.complete, 2);
  assert.equal(monitor.health().timeline.sessionsSynced, 2);
  assert.equal(monitor.health().timeline.replayedFiles, 2);

  const hotTimeline = await monitor.timeline();
  assert.equal(hotTimeline.usage.totalTokens, timeline.usage.totalTokens);
  assert.equal(monitor.health().timeline.sessionsSynced, 2);
  assert.equal(monitor.health().timeline.replayedFiles, 2);
  assert.equal(monitor.health().timeline.tailedFiles, 0);
  assert.equal(monitor.health().timeline.projectionDirtySessions, 0);
  assert.equal(monitor.health().timeline.indexQueueLength, 0);
  assert.equal(monitor.health().timeline.activeIndexJobs, 0);
});

test("incremental timeline survives restart without replaying unchanged rollout history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-calendar-restart-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-first-${ROOT}.jsonl`),
    makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"),
  );
  let second = null;
  t.after(async () => {
    second?.monitor.close();
    second?.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await bootMonitor(codexHome, databasePath);
  const firstTimeline = await first.monitor.timeline();
  assert.equal(firstTimeline.usage.totalTokens, 100);
  assert.equal(firstTimeline.modelRequestCount, 1);
  assert.equal(first.monitor.health().timeline.replayedFiles, 1);
  assert.equal(first.database.getModelUsageEvents(ROOT).length, 1);
  first.monitor.close();
  first.database.close();

  second = await bootMonitor(codexHome, databasePath);
  assert.equal(second.monitor.health().timeline.dirtySessions, 0);
  const secondTimeline = await second.monitor.timeline();
  assert.equal(secondTimeline.usage.totalTokens, 100);
  assert.equal(secondTimeline.modelRequestCount, 1);
  assert.equal(second.monitor.health().timeline.sessionsSynced, 0);
  assert.equal(second.monitor.health().timeline.replayedFiles, 0);
  assert.equal(second.monitor.health().timeline.tailedFiles, 0);
  assert.equal(second.database.getModelUsageEvents(ROOT).length, 1);
});

test("parser semantics version reindexes stale cursor diagnostics without changing schema version", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-parser-version-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-parser-version-${ROOT}.jsonl`),
    makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"),
  );
  let second = null;
  t.after(async () => {
    await second?.monitor.close();
    second?.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await bootMonitor(codexHome, databasePath);
  await first.monitor.timeline();
  await first.monitor.close();
  first.database.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    UPDATE sessions SET parser_version=14 WHERE id='${ROOT}';
    UPDATE ingest_cursors SET unknown_records=1978 WHERE root_session_id='${ROOT}';
  `);
  legacy.close();

  second = await bootMonitor(codexHome, databasePath);
  await second.monitor.runBackgroundIndexer();
  const state = second.database.getSessionIndexState(ROOT);
  assert.equal(second.database.getHealthStats().schemaVersion, 14);
  assert.equal(state.parserVersion, 15);
  assert.equal(state.parserCurrent, true);
  assert.equal(second.database.getHealthStats().unknownRecords, 0);
  assert.equal(second.monitor.health().timeline.replayedFiles, 1);
});

test("portable source keys survive Codex home relocation without path-only replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-portable-"));
  const oldCodexHome = join(directory, "old-profile", ".codex");
  const newCodexHome = join(directory, "new-drive", ".codex");
  const sessions = join(oldCodexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  const rolloutPath = join(sessions, `rollout-portable-${CHILD}.jsonl`);
  await writeFile(rolloutPath, makePortablePreviewRollout());
  let first = null;
  let second = null;
  t.after(async () => {
    first?.monitor.close();
    first?.database.close();
    second?.monitor.close();
    second?.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  first = await bootMonitor(oldCodexHome, databasePath);
  const initial = await first.monitor.selectSession(ROOT);
  assert.equal(initial.summary.taskCount, 1);
  assert.equal(first.database.getCursors(ROOT)[0].sourceKey,
    `sessions/2026/08/24/rollout-portable-${CHILD}.jsonl`);
  first.monitor.close();
  first.database.close();
  first = null;

  await mkdir(join(directory, "new-drive"), { recursive: true });
  await rename(oldCodexHome, newCodexHome);
  second = await bootMonitor(newCodexHome, databasePath);
  assert.equal(second.monitor.health().timeline.dirtySessions, 0);

  const selected = await second.monitor.selectSession(ROOT);
  assert.equal(selected.health.parser, null);
  assert.equal(second.monitor.health().timeline.sessionsSynced, 0);
  assert.equal(second.monitor.health().timeline.replayedFiles, 0);
  assert.equal(second.database.getModelUsageEvents(ROOT).length, 1);
  const preview = await second.monitor.taskPreview(CHILD, TURN);
  assert.equal(preview.available, true);
  assert.equal(preview.text, "Portable preview survives source rebinding.");

  const task = second.database.getTask(CHILD, TURN);
  assert.equal(task.sourceKey, `sessions/2026/08/24/rollout-portable-${CHILD}.jsonl`);
  const raw = second.database.db.prepare(`
    SELECT source_key, source_path FROM tasks WHERE thread_id=? AND turn_id=?
  `).get(CHILD, TURN);
  assert.equal(raw.source_key, task.sourceKey);
  assert.equal(raw.source_path, null);
});

test("source locator canonicalizes runtime paths and recovers legacy Windows roots", () => {
  const locator = new CodexSourceLocator("C:\\Users\\NewUser\\.codex");
  const sourceKey = "sessions/2026/08/24/rollout-portable.jsonl";
  assert.equal(
    locator.keyForPath("C:\\Users\\NewUser\\.codex\\sessions\\2026\\08\\24\\rollout-portable.jsonl"),
    sourceKey,
  );
  assert.equal(
    recoverLegacySourceKey("D:\\Profiles\\OldUser\\.codex\\sessions\\2026\\08\\24\\rollout-portable.jsonl"),
    sourceKey,
  );
  assert.equal(recoverLegacySourceKey("D:\\unrelated\\rollout-portable.jsonl"), null);
  assert.equal(locator.pathForKey("sessions/../../outside/rollout-portable.jsonl"), null);
});

test("startup falls back from a stale Codex home and anchors relative database paths to the project", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-home-resolution-"));
  const userHome = join(directory, "NewUser");
  const currentCodexHome = join(userHome, ".codex");
  const customCodexHome = join(directory, "portable-codex-home");
  await mkdir(currentCodexHome, { recursive: true });
  await mkdir(customCodexHome, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fallback = resolveCodexHome(null, {
    environment: {
      CODEX_MONITOR_HOME: join(directory, "missing-old-home"),
      USERPROFILE: userHome,
    },
    userHome,
  });
  assert.equal(fallback.path, currentCodexHome);
  assert.equal(fallback.source, "current-user");
  assert.match(fallback.warning, /CODEX_MONITOR_HOME/u);

  const configured = resolveCodexHome(null, {
    environment: { CODEX_MONITOR_HOME: customCodexHome },
    userHome,
  });
  assert.equal(configured.path, customCodexHome);
  assert.equal(configured.source, "environment");
  assert.equal(configured.warning, null);

  assert.throws(
    () => resolveCodexHome(join(directory, "missing-explicit-home"), { environment: {}, userHome }),
    /Codex 数据目录不存在/u,
  );

  const projectDatabase = resolveDatabasePath("portable-data\\usage.sqlite", {});
  assert.match(projectDatabase, /codex-usage-monitor[\\/]portable-data[\\/]usage\.sqlite$/u);
  assert.match(resolveDatabasePath(null, {}), /codex-usage-monitor[\\/]data[\\/]usage\.sqlite$/u);
  assert.match(
    resolveDatabasePath(null, { CODEX_MONITOR_DB: join(directory, "external.sqlite") }),
    /codex-usage-monitor[\\/]data[\\/]usage\.sqlite$/u,
  );
});

test("incremental timeline tails only the changed session after rollout append", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-calendar-tail-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  const firstPath = join(sessions, `rollout-first-${ROOT}.jsonl`);
  const secondPath = join(sessions, `rollout-second-${OTHER_ROOT}.jsonl`);
  await writeFile(firstPath, makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"));
  await writeFile(secondPath, makeCalendarRootRollout(OTHER_ROOT, OTHER_TURN, 240, "2026-08-24T13:00:00.000Z"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  t.after(async () => {
    monitor.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  await monitor.initialize();
  const initial = await monitor.timeline();
  assert.equal(initial.usage.totalTokens, 340);
  assert.equal(initial.modelRequestCount, 2);

  await appendFile(
    firstPath,
    makeCalendarTaskAppend(SIBLING_TURN, 160, "2026-08-24T14:00:00.000Z"),
  );
  monitor.pendingPaths.add(firstPath);
  await monitor.processPendingPaths();
  await monitor.runBackgroundIndexer();
  assert.equal(monitor.health().timeline.dirtySessions, 0);

  const updated = await monitor.timeline();
  assert.equal(updated.usage.totalTokens, 400);
  assert.equal(updated.modelRequestCount, 3);
  assert.equal(updated.tokensPerModelRequest, 400 / 3);
  assert.equal(monitor.health().timeline.sessionsSynced, 1);
  assert.equal(monitor.health().timeline.replayedFiles, 0);
  assert.equal(monitor.health().timeline.tailedFiles, 1);
});

test("SQLite persists usage metadata without a prompt field", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-db-"));
  const path = join(directory, "usage.sqlite");
  const database = new MonitorDatabase(path);
  const fixture = snapshot();
  database.replaceSession(fixture);
  database.replaceSession(fixture);
  assert.equal(
    database.db.prepare("SELECT COUNT(*) AS count FROM model_usage_events").get().count,
    1,
  );
  database.close();

  const reopened = new MonitorDatabase(path);
  t.after(async () => {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });
  const stored = reopened.getSession(ROOT);
  assert.equal(stored.tasks.length, 1);
  assert.equal("deltaUsage" in stored.tasks[0], false);
  assert.equal("quality" in stored.tasks[0], false);
  assert.equal(stored.tasks[0].model, "gpt-5.6-terra");
  assert.equal(stored.tasks[0].effort, "xhigh");
  assert.equal(stored.modelUsageEvents.length, 1);
  assert.equal(stored.modelUsageEvents[0].classification, "generation_start");
  assert.equal(stored.modelUsageEvents[0].usage.totalTokens, 42);
  assert.equal(stored.modelUsageEvents[0].model, "gpt-5.6-terra");
  assert.equal(stored.modelUsageEvents[0].serviceTier, "default");
  assert.equal(stored.modelUsageEvents[0].pricingContextQuality, "verified");
  assert.equal(stored.session.title, "");
  assert.equal(stored.session.projectPath, "C:\\workspace\\codex-usage-monitor");
  const columns = reopened.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.equal(columns.some((name) => /prompt|preview|content|message/iu.test(name)), false);
  assert.equal(columns.includes("quality"), false);
  assert.equal(columns.includes("baseline_usage"), false);
  assert.equal(columns.includes("end_usage"), false);
  assert.equal(columns.includes("delta_usage"), false);
  assert.equal(columns.some((name) => name.startsWith("delta_")), false);
  const eventColumns = reopened.db.prepare("PRAGMA table_info(model_usage_events)").all()
    .map((row) => row.name);
  assert.equal(eventColumns.some((name) => /prompt|preview|content|message|source_path|rollout_path/iu.test(name)), false);
  assert.equal(eventColumns.includes("model"), true);
  assert.equal(eventColumns.includes("service_tier"), true);
  assert.equal(eventColumns.includes("pricing_context_quality"), true);
  const calendar = reopened.getTimeline(new Map([[ROOT, {
    title: "Test",
    projectPath: "C:\\workspace\\codex-usage-monitor",
    updatedAt: "2026-08-24T00:01:00.000Z",
  }]]));
  assert.equal(calendar.months[0].days[0].sessions[0].usage.totalTokens, 42);
  assert.equal(calendar.months[0].days[0].sessions[0].modelRequestCount, 1);
  assert.equal(calendar.months[0].days[0].sessions[0].tokensPerModelRequest, 42);
  assert.equal(calendar.months[0].days[0].sessions[0].taskCount, 1);
  assert.equal(reopened.getHealthStats().calendarRows, 1);
  assert.equal(reopened.getHealthStats().schemaVersion, 14);
  assert.equal(reopened.getHealthStats().modelUsageEventRows, 1);
  assert.equal(reopened.getHealthStats().cacheSize, -2000);
  assert.equal(reopened.getHealthStats().mmapSize, 0);
  assert.equal(reopened.getHealthStats().walAutoCheckpoint, 256);
});

test("T-COST-062 v12 to v13 preserves classification and all six usage fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v12-v13-"));
  const path = join(directory, "usage.sqlite");
  let database = new MonitorDatabase(path);
  t.after(async () => {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });
  database.replaceSession(snapshot());
  const evidenceSql = `
    SELECT classification, input_tokens, cached_input_tokens, cache_write_input_tokens,
           output_tokens, reasoning_output_tokens, total_tokens
    FROM model_usage_events ORDER BY source_key, line_number
  `;
  const before = database.db.prepare(evidenceSql).all();
  database.close();
  database = null;

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    ALTER TABLE model_usage_events DROP COLUMN pricing_context_quality;
    ALTER TABLE model_usage_events DROP COLUMN service_tier;
    ALTER TABLE model_usage_events DROP COLUMN model;
    ALTER TABLE ingest_cursors DROP COLUMN pricing_context;
    PRAGMA user_version=12;
  `);
  legacy.close();

  database = new MonitorDatabase(path);
  const after = database.db.prepare(evidenceSql).all();
  assert.deepEqual(after, before);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, 14);
  const event = database.getModelUsageEvents(ROOT)[0];
  assert.equal(event.model, null);
  assert.equal(event.serviceTier, null);
  assert.equal(event.pricingContextQuality, null);
});

test("T-ID-007 schema v13 to v14 backfills durable request identity from persisted ledger evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v13-v14-identity-"));
  const path = join(directory, "usage.sqlite");
  let database = new MonitorDatabase(path);
  t.after(async () => {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });
  database.replaceSession(snapshot(), { persistQuotas: false });
  database.close();
  database = null;

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DROP TABLE canonical_requests;
    ALTER TABLE event_ownership DROP COLUMN canonical_request_id;
    ALTER TABLE model_usage_events DROP COLUMN request_native_field;
    ALTER TABLE model_usage_events DROP COLUMN request_identity_reason;
    ALTER TABLE model_usage_events DROP COLUMN request_identity_kind;
    ALTER TABLE model_usage_events DROP COLUMN request_identity;
    PRAGMA user_version=13;
  `);
  legacy.close();

  database = new MonitorDatabase(path);
  const row = database.db.prepare(`
    SELECT request_identity, request_identity_kind, request_identity_reason
    FROM model_usage_events
    WHERE root_session_id=?
    LIMIT 1
  `).get(ROOT);
  assert.match(row.request_identity, /^reqr_[0-9a-f]{64}$/u);
  assert.equal(row.request_identity_kind, "reconstructed");
  assert.equal(row.request_identity_reason, "deterministic_request_reconstruction");
  assert.equal(database.getHealthStats().canonicalRequestRows, 1);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, 14);
});

test("request ledger exclusively drives snapshot, agent, cost, and calendar usage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-primary-ledger-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  const data = snapshot();
  data.agents[0].ownUsage = zeroUsage();
  data.agents[0].subtreeUsage = zeroUsage();
  database.replaceSession(data);
  const repository = { getSession: () => null, summary: () => ({}) };
  const monitor = new UsageMonitor({ repository, database });
  t.after(async () => {
    monitor.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const rawTask = database.getTask(CHILD, TURN);
  assert.equal("quality" in rawTask, false);
  assert.equal("deltaUsage" in rawTask, false);
  const storedAgent = database.getSession(ROOT).agents[0];
  assert.equal(storedAgent.ownUsage.totalTokens, 42);
  const selected = monitor.snapshot(ROOT);
  assert.equal(selected.agents[0].tasks[0].deltaUsage.totalTokens, 42);
  assert.equal(selected.agents[0].tasks[0].quality, "complete");
  assert.equal("boundaryQuality" in selected.agents[0].tasks[0], false);
  assert.equal("boundaryDeltaUsage" in selected.agents[0].tasks[0], false);
  assert.equal(selected.agents[0].tasks[0].usageSource, "request_ledger");
  assert.equal(selected.agents[0].tasks[0].requestCount, 1);
  assert.equal(selected.agents[0].tasks[0].tokensPerModelRequest, 42);
  assert.equal(selected.agents[0].tasks[0].costEstimate.status, "estimated");
  assert.ok(selected.agents[0].tasks[0].costEstimate.amountUsd > 0);
  assert.equal(selected.agents[0].ownModelRequestCount, 1);
  assert.equal(selected.agents[0].subtreeModelRequestCount, 1);
  assert.equal(selected.agents[0].ownTokensPerModelRequest, 42);
  assert.equal(selected.agents[0].subtreeTokensPerModelRequest, 42);
  assert.equal(selected.summary.totalUsage.totalTokens, 42);
  assert.equal(selected.summary.modelRequestCount, 1);
  assert.equal(selected.summary.tokensPerModelRequest, 42);
  assert.equal(selected.summary.subagentModelRequestCount, 1);
  assert.equal(selected.summary.subagentTokensPerModelRequest, 42);
  const calendar = database.getTimeline();
  assert.equal(calendar.usage.totalTokens, 42);
  assert.equal(calendar.modelRequestCount, 1);
  assert.equal(calendar.tokensPerModelRequest, 42);
});

test("T-DAY-040/042/043 schema v14 preserves v12 observedAt day slices and restart parity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-day-v12-"));
  const path = join(directory, "usage.sqlite");
  let database = new MonitorDatabase(path);
  t.after(async () => {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  database.replaceSession(crossMidnightSnapshot());
  const first = database.getTimeline();
  assertDayTimeline(first, "2026-08-26", 100, 1, 1);
  assertDayTimeline(first, "2026-08-27", 200, 2, 2);
  const indexColumns = database.db.prepare("PRAGMA index_info(idx_model_usage_events_root_observed)")
    .all().map((row) => row.name);
  assert.deepEqual(indexColumns, ["root_session_id", "observed_at", "classification"]);
  database.close();

  database = new MonitorDatabase(path);
  const restarted = database.getTimeline();
  assertDayTimeline(restarted, "2026-08-26", 100, 1, 1);
  assertDayTimeline(restarted, "2026-08-27", 200, 2, 2);
  assert.equal(database.getHealthStats().schemaVersion, 14);
});

test("T-DAY-022 event-backed task without lifecycle timestamps is day-attributed only once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-day-no-lifecycle-"));
  const path = join(directory, "usage.sqlite");
  const database = new MonitorDatabase(path);
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const stored = crossMidnightSnapshot();
  const turnId = "44444444-4444-4444-8444-444444444444";
  stored.tasks.push({
    rootSessionId: ROOT,
    threadId: CHILD,
    turnId,
    sequence: 3,
    status: "completed",
    startedAt: null,
    completedAt: null,
    model: "gpt-5.6-terra",
    effort: "high",
    sourceKey: "sessions/2026/08/26/rollout-day-scope.jsonl",
  });
  stored.modelUsageEvents.push(directUsageEvent({
    lineNumber: 30,
    threadId: CHILD,
    turnId,
    totalTokens: 25,
    observedAt: "2026-08-27T00:12:00-07:00",
    classification: "generation_start",
  }));
  database.replaceSession(stored);

  const timeline = database.getTimeline();
  assertDayTimeline(timeline, "2026-08-27", 225, 3, 3);
  assert.equal(timeline.usage.totalTokens, 325);
  assert.equal(timeline.unattributed.taskCount, 0);
  assert.equal(timeline.unattributed.usage.totalTokens, 0);
});

test("T-DAY-041 v11 through v13 rebuilds calendar from persisted ledger without rollout replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v11-day-migration-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-v11-${ROOT}.jsonl`),
    makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"),
  );
  let booted = await bootMonitor(codexHome, databasePath);
  t.after(async () => {
    booted?.monitor.close();
    booted?.database.close();
    await rm(directory, { recursive: true, force: true });
  });
  await booted.monitor.timeline();
  booted.monitor.close();
  booted.database.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    UPDATE session_day_usage
    SET total_tokens=0, input_tokens=0, output_tokens=0, model_request_count=0
    WHERE root_session_id='${ROOT}';
    UPDATE sessions SET parser_version=11 WHERE id='${ROOT}';
    PRAGMA user_version=11;
  `);
  legacy.close();

  booted = await bootMonitor(codexHome, databasePath);
  assert.equal(booted.database.db.prepare("PRAGMA user_version").get().user_version, 14);
  assert.equal(booted.monitor.health().timeline.dirtySessions, 0);
  const timeline = await booted.monitor.timeline();
  assert.equal(timeline.usage.totalTokens, 100);
  assert.equal(timeline.modelRequestCount, 1);
  assert.equal(booted.monitor.health().timeline.replayedFiles, 0);
  assert.equal(booted.monitor.health().timeline.tailedFiles, 0);
});

test("calendar-only persistence does not archive historical quota snapshots", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-calendar-quota-"));
  const path = join(directory, "usage.sqlite");
  const database = new MonitorDatabase(path);
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const data = snapshot();
  data.quotas = [
    {
      observedAt: "2026-08-24T00:00:00.000Z",
      limitId: "codex",
      planType: "plus",
      sourcePath: "C:\\fixture-a.jsonl",
      primary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: null },
    },
    {
      observedAt: "2026-08-24T00:01:00.000Z",
      limitId: "codex",
      planType: "plus",
      sourcePath: "C:\\fixture-b.jsonl",
      primary: { usedPercent: 11, windowMinutes: 10_080, resetsAt: null },
    },
  ];

  database.replaceSession(data, { persistQuotas: false });
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM quota_snapshots").get().count, 0);

  database.replaceSession(data);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM quota_snapshots").get().count, 2);
});

test("global quota does not regress within the same reset window when concurrent snapshots arrive out of order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-quota-race-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "26");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-quota-full-${ROOT}.jsonl`),
    makeQuotaRollout(ROOT, "2026-08-26T08:39:21.277Z", 100, 31, 1_787_748_993, 1_788_317_703),
  );
  await writeFile(
    join(sessions, `rollout-quota-lagging-${OTHER_ROOT}.jsonl`),
    makeQuotaRollout(OTHER_ROOT, "2026-08-26T08:39:21.958Z", 97, 31, 1_787_748_993, 1_788_317_703),
  );

  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  t.after(() => {
    monitor.close();
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  await monitor.initialize();
  const quota = monitor.quota();
  assert.equal(quota.primary.usedPercent, 100);
  assert.equal(quota.secondary.usedPercent, 31);
  assert.equal(quota.primary.resetsAt, "2026-08-26T12:56:33.000Z");
  assert.equal(quota.reconciled, true);
});

test("manual quota refresh re-stats existing rollout files and reads the newest local snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-quota-refresh-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "26");
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-quota-refresh-${ROOT}.jsonl`);
  await writeFile(
    rollout,
    makeQuotaRollout(ROOT, "2026-08-26T08:00:00.000Z", 60, 20, 1_787_748_993, 1_788_317_703),
  );

  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  t.after(() => {
    monitor.close();
    database.close();
    return rm(directory, { recursive: true, force: true });
  });

  await monitor.initialize();
  assert.equal(monitor.quota().primary.usedPercent, 60);

  await appendFile(
    rollout,
    makeQuotaEvent("2026-08-26T08:05:00.000Z", 100, 31, 1_787_748_993, 1_788_317_703),
  );
  const refreshed = await monitor.refreshQuotaNow();
  assert.equal(refreshed.primary.usedPercent, 100);
  assert.equal(refreshed.secondary.usedPercent, 31);
});

test("schema v1 ingest cursors migrate to portable resumable schema v14", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-migration-"));
  const path = join(directory, "usage.sqlite");
  let migrated = null;
  t.after(async () => {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE ingest_cursors (
      path TEXT PRIMARY KEY,
      root_session_id TEXT,
      thread_id TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      modified_at_ms REAL,
      last_ordinal INTEGER,
      invalid_lines INTEGER NOT NULL DEFAULT 0,
      partial_bytes INTEGER NOT NULL DEFAULT 0,
      parsed_at TEXT NOT NULL
    );
    INSERT INTO ingest_cursors (
      path, root_session_id, thread_id, byte_offset, file_size, parsed_at
    ) VALUES ('C:\\Users\\OldUser\\.codex\\sessions\\2026\\08\\24\\rollout-fixture.jsonl', '${ROOT}', '${CHILD}', 120, 120, '2026-08-24T00:00:00.000Z');
    PRAGMA user_version=1;
  `);
  legacy.close();

  migrated = new MonitorDatabase(path);
  const columns = migrated.db.prepare("PRAGMA table_info(ingest_cursors)").all();
  assert.equal(columns.some((column) => column.name === "line_number"), true);
  assert.equal(columns.some((column) => column.name === "unknown_records"), true);
  assert.equal(columns.some((column) => column.name === "skipped_records"), true);
  assert.equal(columns.some((column) => column.name === "last_usage"), true);
  assert.equal(columns.some((column) => column.name === "discontinuities"), true);
  assert.equal(columns.some((column) => column.name === "source_key"), true);
  assert.equal(columns.some((column) => column.name === "path"), false);
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 14);
  const cursors = migrated.getCursors(ROOT);
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0].sourceKey, "sessions/2026/08/24/rollout-fixture.jsonl");
  assert.equal(cursors[0].byteOffset, 120);
  assert.equal(cursors[0].lineNumber, 0);
});

test("schema v5 sessions gain project locator metadata without losing rows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-session-migration-"));
  const path = join(directory, "usage.sqlite");
  let migrated = null;
  t.after(async () => {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      source TEXT,
      created_at TEXT,
      updated_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT,
      rollout_path TEXT,
      parse_status TEXT NOT NULL DEFAULT 'not_imported',
      imported_at TEXT,
      agent_count INTEGER NOT NULL DEFAULT 0,
      task_count INTEGER NOT NULL DEFAULT 0,
      parser_version INTEGER NOT NULL DEFAULT 5
    );
    INSERT INTO sessions (id, source, updated_at) VALUES ('${ROOT}', 'cli', '2026-08-24T00:00:00.000Z');
    PRAGMA user_version=5;
  `);
  legacy.close();

  migrated = new MonitorDatabase(path);
  const columns = migrated.db.prepare("PRAGMA table_info(sessions)").all();
  assert.equal(columns.some((column) => column.name === "project_path"), true);
  assert.equal(migrated.listSessions()[0].projectPath, null);
  migrated.upsertSessions([{
    id: ROOT,
    source: "cli",
    projectPath: "C:\\workspace\\retained-project",
    updatedAt: "2026-08-24T00:01:00.000Z",
  }]);
  assert.equal(migrated.listSessions()[0].projectPath, "C:\\workspace\\retained-project");
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 14);
});

test("schema v8 sessions replay once to backfill the request ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v8-request-ledger-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-v8-${ROOT}.jsonl`);
  await writeFile(rollout, makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"));
  let monitor = null;
  let database = null;
  t.after(async () => {
    monitor?.close();
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  ({ monitor, database } = await bootMonitor(codexHome, databasePath));
  await monitor.timeline();
  monitor.close();
  database.close();
  monitor = null;
  database = null;

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TABLE model_usage_events;
    UPDATE sessions SET parser_version=8;
    PRAGMA user_version=8;
  `);
  legacy.close();

  ({ monitor, database } = await bootMonitor(codexHome, databasePath));
  assert.equal(database.getSessionIndexState(ROOT).requestLedgerReady, false);
  await monitor.timeline();
  assert.equal(monitor.health().timeline.replayedFiles, 1);
  assert.equal(database.getSessionIndexState(ROOT).requestLedgerReady, true);
  assert.equal(database.getModelUsageEvents(ROOT).length, 1);
  assert.equal(database.getModelUsageEvents(ROOT)[0].classification, "generation_start");
  assert.equal(database.getModelUsageEvents(ROOT)[0].usage.totalTokens, 100);
});

test("schema v10 retires boundary storage and reaches v13 without replaying rollout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v10-retire-boundary-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-v10-${ROOT}.jsonl`),
    makeCalendarRootRollout(ROOT, TURN, 100, "2026-08-24T12:00:00.000Z"),
  );
  let monitor = null;
  let database = null;
  t.after(async () => {
    monitor?.close();
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  ({ monitor, database } = await bootMonitor(codexHome, databasePath));
  await monitor.timeline();
  monitor.close();
  database.close();
  monitor = null;
  database = null;

  const legacy = new DatabaseSync(databasePath);
  const empty = JSON.stringify(zeroUsage());
  legacy.prepare("UPDATE agents SET own_usage=?, subtree_usage=? WHERE root_session_id=?")
    .run(empty, empty, ROOT);
  legacy.exec(`
    ALTER TABLE tasks ADD COLUMN quality TEXT;
    ALTER TABLE tasks ADD COLUMN baseline_usage TEXT;
    ALTER TABLE tasks ADD COLUMN end_usage TEXT;
    ALTER TABLE tasks ADD COLUMN delta_usage TEXT;
    ALTER TABLE tasks ADD COLUMN delta_total_tokens INTEGER;
    UPDATE tasks SET quality='complete', baseline_usage='{}', end_usage='{}',
      delta_usage='{}', delta_total_tokens=999999;
    ALTER TABLE session_day_usage ADD COLUMN estimated_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_day_usage ADD COLUMN discontinuity_count INTEGER NOT NULL DEFAULT 0;
    UPDATE session_day_usage SET total_tokens=0, input_tokens=0, output_tokens=0,
      model_request_count=0 WHERE root_session_id='${ROOT}';
    UPDATE sessions SET parser_version=10 WHERE id='${ROOT}';
    PRAGMA user_version=10;
  `);
  legacy.close();

  ({ monitor, database } = await bootMonitor(codexHome, databasePath));
  assert.equal(database.getSessionIndexState(ROOT).requestLedgerReady, true);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, 14);
  const taskColumns = database.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.equal(taskColumns.includes("quality"), false);
  assert.equal(taskColumns.includes("baseline_usage"), false);
  assert.equal(taskColumns.includes("end_usage"), false);
  assert.equal(taskColumns.includes("delta_usage"), false);
  assert.equal(taskColumns.some((name) => name.startsWith("delta_")), false);
  const dayColumns = database.db.prepare("PRAGMA table_info(session_day_usage)").all()
    .map((row) => row.name);
  assert.equal(dayColumns.includes("estimated_count"), false);
  assert.equal(dayColumns.includes("discontinuity_count"), false);
  const timeline = await monitor.timeline();
  assert.equal(monitor.health().timeline.replayedFiles, 0);
  assert.equal(timeline.usage.totalTokens, 100);
  assert.equal(timeline.modelRequestCount, 1);
  const stored = database.getSession(ROOT);
  assert.equal(stored.agents.find((agent) => agent.threadId === ROOT).ownUsage.totalTokens, 100);
});

test("schema v7 absolute rollout locators migrate to portable keys without losing derived data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v7-portable-migration-"));
  const path = join(directory, "usage.sqlite");
  let migrated = null;
  t.after(async () => {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const seed = new MonitorDatabase(path);
  seed.replaceSession(snapshot());
  seed.close();

  const legacy = new DatabaseSync(path);
  const rootLegacyPath = "C:\\Users\\OldUser\\.codex\\sessions\\2026\\08\\24\\rollout-root.jsonl";
  const childLegacyPath = "D:\\Profiles\\OldUser\\.codex\\sessions\\2026\\08\\24\\rollout-child.jsonl";
  legacy.prepare("UPDATE sessions SET rollout_key=NULL, rollout_path=? WHERE id=?").run(rootLegacyPath, ROOT);
  legacy.prepare("UPDATE agents SET rollout_key=NULL, rollout_path=? WHERE root_session_id=? AND thread_id=?")
    .run(childLegacyPath, ROOT, CHILD);
  legacy.prepare("UPDATE tasks SET source_key=NULL, source_path=? WHERE thread_id=? AND turn_id=?")
    .run(childLegacyPath, CHILD, TURN);
  legacy.prepare(`
    INSERT INTO quota_snapshots (observed_at, limit_id, plan_type, source_key, source_path, payload)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).run(
    "2026-08-24T00:02:00.000Z",
    "codex",
    "plus",
    childLegacyPath,
    JSON.stringify({
      observedAt: "2026-08-24T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      sourcePath: childLegacyPath,
      primary: { usedPercent: 12, windowMinutes: 10_080, resetsAt: null },
    }),
  );
  legacy.exec("PRAGMA user_version=7;");
  legacy.close();

  migrated = new MonitorDatabase(path);
  const stored = migrated.getSession(ROOT);
  assert.equal(stored.session.rolloutKey, "sessions/2026/08/24/rollout-root.jsonl");
  assert.equal(stored.agents[0].rolloutKey, "sessions/2026/08/24/rollout-child.jsonl");
  assert.equal(stored.tasks[0].sourceKey, "sessions/2026/08/24/rollout-child.jsonl");
  assert.equal("deltaUsage" in stored.tasks[0], false);
  assert.equal(stored.modelUsageEvents[0].usage.totalTokens, 42);
  assert.equal(stored.session.projectPath, "C:\\workspace\\codex-usage-monitor");
  assert.equal(migrated.getTimeline().usage.totalTokens, 42);

  const rawSession = migrated.db.prepare("SELECT rollout_path FROM sessions WHERE id=?").get(ROOT);
  const rawAgent = migrated.db.prepare(`
    SELECT rollout_path FROM agents WHERE root_session_id=? AND thread_id=?
  `).get(ROOT, CHILD);
  const rawTask = migrated.db.prepare("SELECT source_path FROM tasks WHERE thread_id=? AND turn_id=?")
    .get(CHILD, TURN);
  assert.equal(rawSession.rollout_path, null);
  assert.equal(rawAgent.rollout_path, null);
  assert.equal(rawTask.source_path, null);

  const quotaRow = migrated.db.prepare(`
    SELECT source_key, source_path, payload FROM quota_snapshots
    WHERE observed_at='2026-08-24T00:02:00.000Z' AND limit_id='codex'
  `).get();
  const quotaPayload = JSON.parse(quotaRow.payload);
  assert.equal(quotaRow.source_key, "sessions/2026/08/24/rollout-child.jsonl");
  assert.equal(quotaRow.source_path, null);
  assert.equal(quotaPayload.sourceKey, "sessions/2026/08/24/rollout-child.jsonl");
  assert.equal("sourcePath" in quotaPayload, false);
});

test("pre-v5 cursors replay once to rebuild diagnostics and cumulative usage state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-v2-migration-"));
  const path = join(directory, "usage.sqlite");
  let migrated = null;
  t.after(async () => {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE ingest_cursors (
      path TEXT PRIMARY KEY,
      root_session_id TEXT,
      thread_id TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      modified_at_ms REAL,
      last_ordinal INTEGER,
      invalid_lines INTEGER NOT NULL DEFAULT 0,
      partial_bytes INTEGER NOT NULL DEFAULT 0,
      parsed_at TEXT NOT NULL
    );
    INSERT INTO ingest_cursors (
      path, root_session_id, thread_id, byte_offset, line_number, file_size, parsed_at
    ) VALUES ('D:\\Profiles\\OldUser\\.codex\\sessions\\2026\\08\\24\\rollout-fixture.jsonl', '${ROOT}', '${CHILD}', 120, 12, 120, '2026-08-24T00:00:00.000Z');
    PRAGMA user_version=2;
  `);
  legacy.close();

  migrated = new MonitorDatabase(path);
  const cursor = migrated.getCursors(ROOT)[0];
  assert.equal(cursor.byteOffset, 120);
  assert.equal(cursor.lineNumber, 0);
  assert.equal(cursor.unknownRecords, 0);
  assert.equal(cursor.skippedRecords, 0);
  assert.equal(cursor.discontinuities, 0);
  assert.equal(cursor.lastUsage, null);
});

test("derived tasks survive restart after one source rollout disappears", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-retention-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(sessions, { recursive: true });
  const firstPath = join(sessions, `rollout-first-${CHILD}.jsonl`);
  const secondPath = join(sessions, `rollout-second-${SIBLING}.jsonl`);
  let second = null;
  await writeFile(firstPath, makeSubagentRollout(CHILD, TURN, 100));
  await writeFile(secondPath, makeSubagentRollout(SIBLING, SIBLING_TURN, 200));
  t.after(async () => {
    second?.monitor.close();
    second?.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await bootMonitor(codexHome, databasePath);
  const before = await first.monitor.selectSession(ROOT);
  assert.equal(before.summary.taskCount, 2);
  first.monitor.close();
  first.database.close();

  await unlink(secondPath);
  second = await bootMonitor(codexHome, databasePath);
  const after = await second.monitor.selectSession(ROOT);
  assert.equal(after.summary.taskCount, 2);
  assert.equal(after.agents.some((agent) => agent.threadId === SIBLING), true);
  const retained = after.agents.flatMap((agent) => agent.tasks)
    .find((task) => task.turnId === SIBLING_TURN);
  assert.equal(retained.deltaUsage.totalTokens, 200);
  const preview = await second.monitor.taskPreview(SIBLING, SIBLING_TURN);
  assert.equal(preview.available, false);
});

test("HTTP service requires the launch token, strict cookie, and trusted origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-server-"));
  const codexHome = join(directory, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-test-${ROOT}.jsonl`);
  const childRollout = join(sessions, `rollout-test-${CHILD}.jsonl`);
  const grandchildRollout = join(sessions, `rollout-test-${GRANDCHILD}.jsonl`);
  await writeFile(rollout, JSON.stringify({
    timestamp: "2026-08-24T00:00:00.000Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      id: ROOT,
      session_id: ROOT,
      timestamp: "2026-08-24T00:00:00.000Z",
      cli_version: "test",
      cwd: "C:\\workspace\\project-alpha",
    },
  }) + "\n");
  await writeFile(childRollout, makeSubagentRollout(CHILD, TURN, 100, {
    projectPath: "C:\\workspace\\project-beta",
  }));
  await writeFile(grandchildRollout, makeSubagentRollout(GRANDCHILD, GRANDCHILD_TURN, 50, {
    parentThreadId: CHILD,
    depth: 2,
    model: "codex-auto-review",
  }));
  const app = await startApplication({
    codexHome,
    databasePath: join(directory, "usage.sqlite"),
    port: 49_150,
    openBrowser: false,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.port}`;
  const unauthorized = await fetch(`${base}/api/sessions`);
  assert.equal(unauthorized.status, 401);
  assertSecurityHeaders(unauthorized.headers);

  const exchange = await fetch(app.accessUrl, { redirect: "manual" });
  assert.equal(exchange.status, 302);
  assertSecurityHeaders(exchange.headers);
  const setCookie = exchange.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  assert.match(setCookie, /Path=\//iu);
  const cookie = setCookie.split(";")[0];

  const secondExchange = await fetch(app.accessUrl, { redirect: "manual" });
  assert.equal(secondExchange.status, 401);
  assertSecurityHeaders(secondExchange.headers);
  const sessionsResponse = await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } });
  assert.equal(sessionsResponse.status, 200);
  assertSecurityHeaders(sessionsResponse.headers);
  const contentSecurityPolicy = sessionsResponse.headers.get("content-security-policy");
  assert.match(contentSecurityPolicy, /(?:^|;)\s*style-src 'self'(?:;|$)/u);
  assert.doesNotMatch(contentSecurityPolicy, /unsafe-inline/iu);
  const payload = await sessionsResponse.json();
  assert.equal(payload.sessions[0].id, ROOT);
  assert.equal(payload.sessions[0].projectPath, "C:\\workspace\\project-alpha");

  const brandImageResponse = await fetch(`${base}/assets/mizuki.png`, {
    headers: { Cookie: cookie },
  });
  assert.equal(brandImageResponse.status, 200);
  assert.equal(brandImageResponse.headers.get("content-type"), "image/png");
  assert.ok((await brandImageResponse.arrayBuffer()).byteLength > 0);

  const timelineResponse = await fetch(`${base}/api/timeline`, {
    headers: { Cookie: cookie },
  });
  assert.equal(timelineResponse.status, 200);
  const timeline = await timelineResponse.json();
  assert.equal(Array.isArray(timeline.months), true);
  assert.equal(timeline.months[0].days[0].sessions[0].id, ROOT);
  assert.equal(timeline.months[0].days[0].sessions[0].usage.totalTokens, 150);
  assert.equal(timeline.months[0].days[0].qualityCounts.complete, 2);
  assert.equal(timeline.unattributed.taskCount, 0);

  const snapshotResponse = await fetch(`${base}/api/sessions/${ROOT}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(snapshotResponse.status, 200);
  const selected = await snapshotResponse.json();
  assert.equal(selected.session.projectPath, "C:\\workspace\\project-alpha");
  const task = selected.agents.flatMap((agent) => agent.tasks)
    .find((candidate) => candidate.threadId === CHILD);
  assert.equal(task.model, "gpt-5.6-terra");
  assert.equal(task.effort, "xhigh");
  assert.equal(task.costEstimate.status, "estimated");
  assert.equal(task.costEstimate.amountUsd, 0.0003);
  assert.equal(selected.pricing.basis, "subscription-standard-equivalent");
  assertCostSummary(selected.summary.totalCostEstimate, {
    status: "partial", amountUsd: 0.0003, estimatedTasks: 1, unavailableTasks: 1,
    estimatedRequests: 1, unavailableRequests: 1,
  });
  assertCostSummary(selected.summary.subagentCostEstimate, {
    status: "partial", amountUsd: 0.0003, estimatedTasks: 1, unavailableTasks: 1,
    estimatedRequests: 1, unavailableRequests: 1,
  });
  const rootAgent = selected.agents.find((agent) => agent.isRoot);
  const childAgent = selected.agents.find((agent) => agent.threadId === CHILD);
  assertCostSummary(rootAgent.ownCostEstimate, {
    status: "unavailable", amountUsd: null, estimatedTasks: 0, unavailableTasks: 0,
    estimatedRequests: 0, unavailableRequests: 0,
  });
  assert.deepEqual(rootAgent.subtreeCostEstimate, selected.summary.totalCostEstimate);
  assertCostSummary(childAgent.ownCostEstimate, {
    status: "estimated", amountUsd: 0.0003, estimatedTasks: 1, unavailableTasks: 0,
    estimatedRequests: 1, unavailableRequests: 0,
  });
  assert.deepEqual(childAgent.subtreeCostEstimate, selected.summary.subagentCostEstimate);
  const grandchildAgent = selected.agents.find((agent) => agent.threadId === GRANDCHILD);
  assertCostSummary(grandchildAgent.ownCostEstimate, {
    status: "unavailable", amountUsd: null, estimatedTasks: 0, unavailableTasks: 1,
    estimatedRequests: 0, unavailableRequests: 1,
  });
  assert.deepEqual(grandchildAgent.subtreeCostEstimate, grandchildAgent.ownCostEstimate);

  const hostile = await fetch(`${base}/api/sessions`, {
    headers: { Cookie: cookie, Origin: "https://example.test" },
  });
  assert.equal(hostile.status, 403);
  assertSecurityHeaders(hostile.headers);

  const hostileHost = await rawRequest(app.port, "/api/sessions", {
    Cookie: cookie,
    Host: "attacker.invalid",
  });
  assert.equal(hostileHost.statusCode, 403);
  assertSecurityHeaders(new Headers(hostileHost.headers));

  const writeAttempt = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(writeAttempt.status, 405);
  assertSecurityHeaders(writeAttempt.headers);

  const missingStatic = await fetch(`${base}/missing`, { headers: { Cookie: cookie } });
  assert.equal(missingStatic.status, 404);
  assertSecurityHeaders(missingStatic.headers);
});

test("T-DAY-050..054 API keeps full and day snapshots distinct and aligned with Timeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-day-api-"));
  const codexHome = join(directory, ".codex");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(codexHome, { recursive: true });
  const seed = new MonitorDatabase(databasePath);
  seed.replaceSession(crossMidnightSnapshot());
  seed.close();
  const app = await startApplication({
    codexHome,
    databasePath,
    port: 49_170,
    openBrowser: false,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { base, cookie } = await authenticateApplication(app);

  const fullResponse = await fetch(`${base}/api/sessions/${ROOT}`, { headers: { Cookie: cookie } });
  assert.equal(fullResponse.status, 200);
  const full = await fullResponse.json();
  assert.deepEqual(full.scope, { type: "session" });
  assert.equal(full.summary.totalUsage.totalTokens, 300);

  const day1Response = await fetch(`${base}/api/sessions/${ROOT}?day=2026-08-26`, {
    headers: { Cookie: cookie },
  });
  assert.equal(day1Response.status, 200);
  const day1 = await day1Response.json();
  assert.equal(day1.scope.type, "day");
  assert.equal(day1.scope.day, "2026-08-26");
  assert.equal(day1.scope.timezone, "America/Los_Angeles");
  assert.equal(day1.summary.totalUsage.totalTokens, 100);
  assert.equal(day1.summary.taskCount, 1);

  const day2Response = await fetch(`${base}/api/sessions/${ROOT}?day=2026-08-27`, {
    headers: { Cookie: cookie },
  });
  assert.equal(day2Response.status, 200);
  const day2 = await day2Response.json();
  assert.equal(day2.summary.totalUsage.totalTokens, 200);
  assert.equal(day2.summary.taskCount, 2);
  assert.equal(day2.summary.agentCount, 1);

  const invalidResponse = await fetch(`${base}/api/sessions/${ROOT}?day=2026-02-31`, {
    headers: { Cookie: cookie },
  });
  assert.equal(invalidResponse.status, 400);
  const invalidPayload = await invalidResponse.json();
  assert.match(invalidPayload.error, /YYYY-MM-DD/u);

  const timelineResponse = await fetch(`${base}/api/timeline`, { headers: { Cookie: cookie } });
  assert.equal(timelineResponse.status, 200);
  const timeline = await timelineResponse.json();
  const timelineDay1 = findTimelineSession(timeline, ROOT, "2026-08-26");
  const timelineDay2 = findTimelineSession(timeline, ROOT, "2026-08-27");
  assert.equal(timelineDay1.usage.totalTokens, day1.summary.totalUsage.totalTokens);
  assert.equal(timelineDay2.usage.totalTokens, day2.summary.totalUsage.totalTokens);
  assert.equal(timelineDay1.modelRequestCount, day1.summary.modelRequestCount);
  assert.equal(timelineDay2.modelRequestCount, day2.summary.modelRequestCount);
  assert.equal(timelineDay1.costEstimate.amountUsd, day1.summary.totalCostEstimate.amountUsd);
  assert.equal(timelineDay2.costEstimate.amountUsd, day2.summary.totalCostEstimate.amountUsd);
});

test("T-DAY-060..062 scoped SSE rematerializes the listener scope after updates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-day-sse-"));
  const codexHome = join(directory, ".codex");
  const databasePath = join(directory, "usage.sqlite");
  await mkdir(codexHome, { recursive: true });
  const seed = new MonitorDatabase(databasePath);
  seed.replaceSession(crossMidnightSnapshot());
  seed.close();
  const app = await startApplication({
    codexHome,
    databasePath,
    port: 49_180,
    openBrowser: false,
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { base, cookie } = await authenticateApplication(app);
  const response = await fetch(`${base}/api/sessions/${ROOT}/events?day=2026-08-26`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const stream = { reader, buffer: "", decoder: new TextDecoder() };
  const initial = await readNextSnapshotEvent(stream);
  assert.equal(initial.scope.day, "2026-08-26");
  assert.equal(initial.summary.totalUsage.totalTokens, 100);

  const day2Only = crossMidnightSnapshot();
  day2Only.modelUsageEvents.push(directUsageEvent({
    lineNumber: 20,
    threadId: CHILD,
    turnId: OTHER_TURN,
    totalTokens: 25,
    observedAt: "2026-08-27T00:09:30-07:00",
  }));
  app.monitor.database.replaceSession(day2Only);
  app.monitor.emit("update", { sessionId: ROOT });
  const afterDay2 = await readNextSnapshotEvent(stream);
  assert.equal(afterDay2.summary.totalUsage.totalTokens, 100);

  const day1AndDay2 = crossMidnightSnapshot();
  day1AndDay2.modelUsageEvents.push(
    directUsageEvent({
      lineNumber: 21,
      threadId: ROOT,
      turnId: TURN,
      totalTokens: 10,
      observedAt: "2026-08-26T23:59:30-07:00",
    }),
    directUsageEvent({
      lineNumber: 22,
      threadId: CHILD,
      turnId: OTHER_TURN,
      totalTokens: 25,
      observedAt: "2026-08-27T00:09:30-07:00",
    }),
  );
  app.monitor.database.replaceSession(day1AndDay2);
  app.monitor.emit("update", { sessionId: ROOT });
  const afterDay1 = await readNextSnapshotEvent(stream);
  assert.equal(afterDay1.summary.totalUsage.totalTokens, 110);
  assert.equal(app.monitor.snapshot(ROOT).summary.totalUsage.totalTokens, 335);
  await reader.cancel();
});

async function bootMonitor(codexHome, databasePath) {
  const database = new MonitorDatabase(databasePath);
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  await monitor.initialize();
  return { database, monitor };
}

function makeSubagentRollout(threadId, turnId, totalTokens, options = {}) {
  const parentThreadId = options.parentThreadId ?? ROOT;
  const depth = options.depth ?? 1;
  const model = options.model ?? "gpt-5.6-terra";
  const timestamp = "2026-08-24T00:00:00.000Z";
  const usage = {
    input_tokens: totalTokens - 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return [
    {
      timestamp,
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: ROOT,
        parent_thread_id: parentThreadId,
        timestamp,
        cwd: options.projectPath,
        source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth } } },
      },
    },
    { timestamp, ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp, ordinal: 2, type: "turn_context", payload: { turn_id: turnId, model, effort: "xhigh" } },
    { timestamp, ordinal: 3, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } } },
    { timestamp, ordinal: 4, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    { timestamp, ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ].map(JSON.stringify).join("\n") + "\n";
}

function makePortablePreviewRollout() {
  const timestamp = "2026-08-24T00:00:00.000Z";
  const parentPath = "/root";
  const childPath = "/root/portable-worker";
  return [
    {
      timestamp,
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: CHILD,
        session_id: ROOT,
        parent_thread_id: ROOT,
        timestamp,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: ROOT,
              depth: 1,
              agent_path: childPath,
            },
          },
        },
      },
    },
    { timestamp, ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: TURN } },
    {
      timestamp,
      ordinal: 2,
      type: "response_item",
      payload: {
        type: "agent_message",
        author: parentPath,
        recipient: childPath,
        content: [{
          type: "input_text",
          text: `Message Type: NEW_TASK\nTask name: ${childPath}\nSender: ${parentPath}\nPayload:\nPortable preview survives source rebinding.`,
        }],
      },
    },
    {
      timestamp,
      ordinal: 3,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 100,
          },
          last_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 100,
          },
        },
      },
    },
    { timestamp, ordinal: 4, type: "event_msg", payload: { type: "task_complete", turn_id: TURN } },
  ].map(JSON.stringify).join("\n") + "\n";
}

function makeCalendarRootRollout(rootId, turnId, totalTokens, timestamp) {
  const usage = {
    input_tokens: totalTokens - 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return [
    {
      timestamp,
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: rootId,
        session_id: rootId,
        timestamp,
        cwd: "C:\\workspace\\calendar",
      },
    },
    { timestamp, ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp, ordinal: 2, type: "turn_context", payload: { turn_id: turnId, model: "gpt-5.6-terra", effort: "xhigh" } },
    { timestamp, ordinal: 3, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } } },
    { timestamp, ordinal: 4, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } },
    { timestamp, ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ].map(JSON.stringify).join("\n") + "\n";
}

function makeCalendarTaskAppend(turnId, cumulativeTotalTokens, timestamp) {
  const usage = {
    input_tokens: cumulativeTotalTokens - 20,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
    total_tokens: cumulativeTotalTokens,
  };
  const lastUsage = {
    input_tokens: cumulativeTotalTokens - 110,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 0,
    total_tokens: cumulativeTotalTokens - 100,
  };
  return [
    { timestamp, ordinal: 5, type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp, ordinal: 6, type: "turn_context", payload: { turn_id: turnId, model: "gpt-5.6-terra", effort: "xhigh" } },
    { timestamp, ordinal: 7, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: lastUsage } } },
    { timestamp, ordinal: 8, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ].map(JSON.stringify).join("\n") + "\n";
}

function makeQuotaRollout(rootId, timestamp, primaryUsed, secondaryUsed, primaryReset, secondaryReset) {
  return [
    {
      timestamp,
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: rootId,
        session_id: rootId,
        timestamp,
        cwd: "C:\\workspace\\quota-race",
      },
    },
    {
      timestamp,
      ordinal: 1,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: {
            used_percent: primaryUsed,
            window_minutes: 300,
            resets_at: primaryReset,
          },
          secondary: {
            used_percent: secondaryUsed,
            window_minutes: 10_080,
            resets_at: secondaryReset,
          },
        },
      },
    },
  ].map(JSON.stringify).join("\n") + "\n";
}

function makeQuotaEvent(timestamp, primaryUsed, secondaryUsed, primaryReset, secondaryReset) {
  return JSON.stringify({
    timestamp,
    ordinal: 2,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        plan_type: "plus",
        primary: {
          used_percent: primaryUsed,
          window_minutes: 300,
          resets_at: primaryReset,
        },
        secondary: {
          used_percent: secondaryUsed,
          window_minutes: 10_080,
          resets_at: secondaryReset,
        },
      },
    },
  }) + "\n";
}

function localDayKey(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function rawRequest(port, path, headers) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers,
    }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
      }));
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

function assertSecurityHeaders(headers) {
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("content-security-policy"), /default-src 'self'/u);
}

function assertCostSummary(actual, expected) {
  assert.equal(actual.status, expected.status);
  assert.equal(actual.amountUsd, expected.amountUsd);
  assert.equal(actual.currency, "USD");
  assert.equal(actual.basis, "subscription-standard-equivalent");
  assert.equal(actual.estimatedTasks, expected.estimatedTasks);
  assert.equal(actual.unavailableTasks, expected.unavailableTasks);
  assert.equal(actual.estimatedRequests, expected.estimatedRequests);
  assert.equal(actual.unavailableRequests, expected.unavailableRequests);
  assert.ok(actual.featureCoverage);
}

async function authenticateApplication(app) {
  const base = `http://127.0.0.1:${app.port}`;
  const exchange = await fetch(app.accessUrl, { redirect: "manual" });
  assert.equal(exchange.status, 302);
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { base, cookie };
}

async function readNextSnapshotEvent(stream) {
  while (true) {
    const boundary = stream.buffer.indexOf("\n\n");
    if (boundary !== -1) {
      const block = stream.buffer.slice(0, boundary);
      stream.buffer = stream.buffer.slice(boundary + 2);
      const event = block.match(/^event:\s*(.+)$/mu)?.[1];
      const data = block.match(/^data:\s*(.+)$/mu)?.[1];
      if (event === "snapshot" && data) return JSON.parse(data);
      continue;
    }
    const { value, done } = await stream.reader.read();
    if (done) throw new Error("SSE stream ended before next snapshot");
    stream.buffer += stream.decoder.decode(value, { stream: true });
  }
}

function findTimelineSession(timeline, sessionId, dayKey) {
  for (const month of timeline.months ?? []) {
    const day = month.days.find((candidate) => candidate.key === dayKey);
    const session = day?.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return session;
  }
  return null;
}

function assertDayTimeline(timeline, dayKey, totalTokens, taskCount, requestCount) {
  const session = findTimelineSession(timeline, ROOT, dayKey);
  assert.ok(session, `expected ${ROOT} in ${dayKey}`);
  assert.equal(session.usage.totalTokens, totalTokens);
  assert.equal(session.taskCount, taskCount);
  assert.equal(session.modelRequestCount, requestCount);
}

function crossMidnightSnapshot() {
  const sourceKey = "sessions/2026/08/26/rollout-day-scope.jsonl";
  const rootTask = {
    rootSessionId: ROOT,
    threadId: ROOT,
    turnId: TURN,
    sequence: 1,
    status: "completed",
    startedAt: "2026-08-26T23:50:00-07:00",
    completedAt: "2026-08-27T00:20:00-07:00",
    durationMs: 30 * 60_000,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    sourceKey,
  };
  const childTask = {
    rootSessionId: ROOT,
    threadId: CHILD,
    turnId: OTHER_TURN,
    sequence: 2,
    status: "completed",
    startedAt: "2026-08-27T00:05:00-07:00",
    completedAt: "2026-08-27T00:10:00-07:00",
    durationMs: 5 * 60_000,
    model: "gpt-5.6-terra",
    effort: "high",
    sourceKey,
  };
  return {
    session: {
      id: ROOT,
      title: "Cross midnight fixture",
      projectPath: "C:\\workspace\\day-scope",
      createdAt: "2026-08-26T23:45:00-07:00",
      updatedAt: "2026-08-27T00:20:00-07:00",
      cliVersion: "fixture",
    },
    agents: [
      {
        rootSessionId: ROOT,
        threadId: ROOT,
        parentThreadId: null,
        depth: 0,
        isRoot: true,
        ownUsage: zeroUsage(),
        subtreeUsage: zeroUsage(),
        taskCount: 1,
      },
      {
        rootSessionId: ROOT,
        threadId: CHILD,
        parentThreadId: ROOT,
        depth: 1,
        isRoot: false,
        ownUsage: zeroUsage(),
        subtreeUsage: zeroUsage(),
        taskCount: 1,
      },
      {
        rootSessionId: ROOT,
        threadId: SIBLING,
        parentThreadId: ROOT,
        depth: 1,
        isRoot: false,
        ownUsage: zeroUsage(),
        subtreeUsage: zeroUsage(),
        taskCount: 0,
      },
    ],
    tasks: [rootTask, childTask],
    modelUsageEvents: [
      directUsageEvent({ lineNumber: 1, threadId: ROOT, turnId: TURN, totalTokens: 100, observedAt: "2026-08-26T23:58:00-07:00", classification: "generation_start" }),
      directUsageEvent({ lineNumber: 2, threadId: ROOT, turnId: TURN, totalTokens: 50, observedAt: "2026-08-27T00:02:00-07:00" }),
      directUsageEvent({ lineNumber: 3, threadId: CHILD, turnId: OTHER_TURN, totalTokens: 150, observedAt: "2026-08-27T00:06:00-07:00", classification: "generation_start" }),
      {
        ...directUsageEvent({ lineNumber: 4, threadId: CHILD, turnId: OTHER_TURN, totalTokens: 0, observedAt: "2026-08-27T00:07:00-07:00", classification: "duplicate" }),
        usage: zeroUsage(),
      },
      {
        ...directUsageEvent({ lineNumber: 5, threadId: CHILD, turnId: OTHER_TURN, totalTokens: 0, observedAt: "2026-08-27T00:08:00-07:00", classification: "anomaly" }),
        usage: null,
      },
      directUsageEvent({
        lineNumber: 6,
        threadId: CHILD,
        turnId: GRANDCHILD_TURN,
        totalTokens: 999,
        observedAt: "2026-08-27T00:09:00-07:00",
      }),
    ],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  };
}

function directUsageEvent({
  lineNumber,
  threadId,
  turnId,
  totalTokens,
  observedAt,
  classification = "verified_increment",
}) {
  const usage = {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
  return {
    rootSessionId: ROOT,
    sourceKey: "sessions/2026/08/26/rollout-day-scope.jsonl",
    threadId,
    turnId,
    lineNumber,
    eventOrdinal: lineNumber,
    observedAt,
    generation: 1,
    classification,
    quality: classification === "anomaly" ? "anomaly" : "verified",
    reason: "fixture",
    usage,
  };
}

function snapshot() {
  const usage = { ...zeroUsage(), inputTokens: 40, outputTokens: 2, totalTokens: 42 };
  const sourceKey = "sessions/2026/08/24/rollout-test.jsonl";
  return {
    session: {
      id: ROOT,
      title: "Test",
      projectPath: "C:\\workspace\\codex-usage-monitor",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:01:00.000Z",
    },
    agents: [{
      rootSessionId: ROOT,
      threadId: CHILD,
      parentThreadId: ROOT,
      depth: 1,
      nickname: "Worker",
      role: "explorer",
      agentPath: "/root/worker",
      rolloutKey: sourceKey,
      isRoot: false,
      ownUsage: usage,
      subtreeUsage: usage,
      taskCount: 1,
    }],
    tasks: [{
      rootSessionId: ROOT,
      threadId: CHILD,
      turnId: TURN,
      sequence: 1,
      status: "completed",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:01:00.000Z",
      durationMs: 60_000,
      model: "gpt-5.6-terra",
      effort: "xhigh",
      sourceKey,
      startByte: 0,
      endByte: 100,
    }],
    modelUsageEvents: [{
      rootSessionId: ROOT,
      sourceKey,
      threadId: CHILD,
      turnId: TURN,
      lineNumber: 4,
      eventOrdinal: 3,
      observedAt: "2026-08-24T00:00:30.000Z",
      generation: 1,
      classification: "generation_start",
      quality: "verified",
      reason: "zero_baseline_proven",
      usage,
      model: "gpt-5.6-terra",
      serviceTier: "default",
      pricingContextQuality: "verified",
    }],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  };
}
