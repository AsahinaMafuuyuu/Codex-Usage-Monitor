import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MonitorDatabase } from "../src/database.js";
import { UsageMonitor } from "../src/monitor.js";
import { CodexRepository } from "../src/repository.js";
import { startApplication } from "../src/server.js";
import { zeroUsage } from "../src/usage.js";

const ROOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIBLING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SIBLING_TURN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GRANDCHILD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const GRANDCHILD_TURN = "11111111-1111-4111-8111-111111111111";

test("SQLite persists usage metadata without a prompt field", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-db-"));
  const path = join(directory, "usage.sqlite");
  const database = new MonitorDatabase(path);
  database.replaceSession(snapshot());
  database.close();

  const reopened = new MonitorDatabase(path);
  t.after(async () => {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });
  const stored = reopened.getSession(ROOT);
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.tasks[0].deltaUsage.totalTokens, 42);
  assert.equal(stored.tasks[0].model, "gpt-5.6-terra");
  assert.equal(stored.tasks[0].effort, "xhigh");
  assert.equal(stored.session.title, "");
  assert.equal(stored.session.projectPath, "C:\\workspace\\codex-usage-monitor");
  const columns = reopened.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.equal(columns.some((name) => /prompt|preview|content|message/iu.test(name)), false);
  assert.equal(reopened.getHealthStats().schemaVersion, 6);
});

test("schema v1 ingest cursors migrate to resumable schema v6", async (t) => {
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
    ) VALUES ('C:\\fixture.jsonl', '${ROOT}', '${CHILD}', 120, 120, '2026-08-24T00:00:00.000Z');
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
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 6);
  const cursors = migrated.getCursors(ROOT);
  assert.equal(cursors.length, 1);
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
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 6);
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
    ) VALUES ('C:\\fixture.jsonl', '${ROOT}', '${CHILD}', 120, 12, 120, '2026-08-24T00:00:00.000Z');
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
  assert.equal(selected.pricing.basis, "openai-standard-api-short-context");
  assert.deepEqual(selected.summary.totalCostEstimate, {
    status: "partial",
    amountUsd: 0.0003,
    currency: "USD",
    estimatedTasks: 1,
    unavailableTasks: 1,
  });
  assert.deepEqual(selected.summary.subagentCostEstimate, {
    status: "partial",
    amountUsd: 0.0003,
    currency: "USD",
    estimatedTasks: 1,
    unavailableTasks: 1,
  });
  const rootAgent = selected.agents.find((agent) => agent.isRoot);
  const childAgent = selected.agents.find((agent) => agent.threadId === CHILD);
  assert.deepEqual(rootAgent.ownCostEstimate, {
    status: "unavailable",
    amountUsd: null,
    currency: "USD",
    estimatedTasks: 0,
    unavailableTasks: 0,
  });
  assert.deepEqual(rootAgent.subtreeCostEstimate, selected.summary.totalCostEstimate);
  assert.deepEqual(childAgent.ownCostEstimate, {
    status: "estimated",
    amountUsd: 0.0003,
    currency: "USD",
    estimatedTasks: 1,
    unavailableTasks: 0,
  });
  assert.deepEqual(childAgent.subtreeCostEstimate, selected.summary.subagentCostEstimate);
  const grandchildAgent = selected.agents.find((agent) => agent.threadId === GRANDCHILD);
  assert.deepEqual(grandchildAgent.ownCostEstimate, {
    status: "unavailable",
    amountUsd: null,
    currency: "USD",
    estimatedTasks: 0,
    unavailableTasks: 1,
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
    { timestamp, ordinal: 3, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } },
    { timestamp, ordinal: 4, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ].map(JSON.stringify).join("\n") + "\n";
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

function snapshot() {
  const usage = { ...zeroUsage(), inputTokens: 40, outputTokens: 2, totalTokens: 42 };
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
      rolloutPath: "C:\\missing.jsonl",
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
      quality: "complete",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:01:00.000Z",
      durationMs: 60_000,
      model: "gpt-5.6-terra",
      effort: "xhigh",
      baselineUsage: zeroUsage(),
      endUsage: usage,
      deltaUsage: usage,
      sourcePath: "C:\\missing.jsonl",
      startByte: 0,
      endByte: 100,
    }],
    cursors: [],
    quotas: [],
    health: { status: "healthy" },
  };
}
