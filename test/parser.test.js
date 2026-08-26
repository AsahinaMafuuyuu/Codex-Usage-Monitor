import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readTaskPreview,
  scanRolloutMetadata,
  SessionRolloutParser,
} from "../src/rollout-parser.js";
import {
  classifyModelUsageEvent,
  normalizeUsage,
  reconcileRateLimitSnapshots,
} from "../src/usage.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const PARENT_TURN = "33333333-3333-4333-8333-333333333333";
const TURN = "44444444-4444-4444-8444-444444444444";
const THIRD_TURN = "55555555-5555-4555-8555-555555555555";

test("rate-limit reconciliation keeps the strictest usage inside one reset window and releases it after reset", () => {
  const full = quotaSnapshot("2026-08-26T08:39:21.277Z", 100, "2026-08-26T12:56:33.000Z");
  const lagging = quotaSnapshot("2026-08-26T08:39:21.958Z", 97, "2026-08-26T12:56:33.000Z");
  const reconciled = reconcileRateLimitSnapshots(full, lagging);
  assert.equal(reconciled.primary.usedPercent, 100);
  assert.equal(reconciled.observedAt, lagging.observedAt);
  assert.equal(reconciled.reconciled, true);

  const reset = quotaSnapshot("2026-08-26T13:00:00.000Z", 4, "2026-08-26T17:56:33.000Z");
  const afterReset = reconcileRateLimitSnapshots(reconciled, reset);
  assert.equal(afterReset.primary.usedPercent, 4);
  assert.equal(afterReset.primary.resetsAt, "2026-08-26T17:56:33.000Z");

  const oldWindowStraggler = quotaSnapshot("2026-08-26T13:00:00.500Z", 100, "2026-08-26T12:56:33.000Z");
  const afterStraggler = reconcileRateLimitSnapshots(afterReset, oldWindowStraggler);
  assert.equal(afterStraggler.primary.usedPercent, 4);
  assert.equal(afterStraggler.primary.resetsAt, "2026-08-26T17:56:33.000Z");
});

test("paginated copied history is skipped and cumulative snapshots are differenced", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta({ subagent_history_start_ordinal: 5 })),
    line(1, "session_meta", { id: ROOT, session_id: ROOT }),
    event(2, "task_started", { turn_id: PARENT_TURN, started_at: 1_700_000_000 }),
    token(3, usage(999), null),
    event(5, "thread_settings_applied"),
    event(6, "task_started", { turn_id: TURN, started_at: 1_700_000_100 }),
    line(7, "turn_context", { turn_id: TURN, model: "gpt-test", effort: "high" }),
    line(8, "inter_agent_communication_metadata", { trigger_turn: ROOT }),
    line(9, "response_item", {
      type: "agent_message",
      author: "/root",
      recipient: "/root/test-agent",
      content: [{
        type: "input_text",
        text: "Message Type: NEW_TASK\nTask name: /root/test-agent\nSender: /root\nPayload:\nReview the cumulative usage boundary carefully.",
      }],
    }),
    token(10, usage(100), { used_percent: 20 }),
    token(11, usage(100), { used_percent: 20 }, usage(100)),
    token(12, usage(150), { used_percent: 21 }, usageDelta(100, 150)),
    event(13, "task_complete", {
      turn_id: TURN,
      started_at: 1_700_000_100,
      completed_at: 1_700_000_130,
      duration_ms: 30_000,
    }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const parser = await parserFor(fixture.path);
  const snapshot = parser.snapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].turnId, TURN);
  assert.equal(snapshot.tasks[0].deltaUsage.totalTokens, 150);
  assert.equal(snapshot.tasks[0].quality, "complete");
  assert.equal(snapshot.tasks[0].model, "gpt-test");
  assert.equal(snapshot.tasks[0].effort, "high");
  assert.equal(snapshot.quotas.at(-1).primary.usedPercent, 21);

  const preview = await readTaskPreview(snapshot.tasks[0]);
  assert.equal(preview.available, true);
  assert.equal(preview.text, "Review the cumulative usage boundary carefully.");
});

test("task preview accepts only a routed parent instruction and never a child reply", async (t) => {
  const parentPath = "/root/test-parent";
  const childPath = `${parentPath}/test-agent`;
  const fixture = await createFixture([
    line(0, "session_meta", childMeta({
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT,
            depth: 1,
            agent_path: childPath,
          },
        },
      },
    })),
    event(1, "task_started", { turn_id: TURN }),
    line(2, "response_item", {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Message Type: NEW_TASK\nTask name: /root/test-parent/test-agent\nSender: ${parentPath}\nPayload:\nUse the audited parent instruction.`,
      }],
    }),
    line(3, "response_item", {
      type: "agent_message",
      author: parentPath,
      recipient: childPath,
      content: [{
        type: "input_text",
        text: `Message Type: NEW_TASK\nTask name: ${childPath}\nSender: ${parentPath}\nPayload:\n`,
      }],
    }),
    line(4, "response_item", {
      type: "agent_message",
      author: childPath,
      recipient: parentPath,
      content: [{ type: "input_text", text: "I am the child reply and must never be previewed." }],
    }),
    event(5, "task_complete", { turn_id: TURN }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const parser = await parserFor(fixture.path);
  const preview = await readTaskPreview(parser.snapshot().tasks[0]);
  assert.equal(preview.available, true);
  assert.equal(preview.text, "Use the audited parent instruction.");
  assert.doesNotMatch(preview.text, /child reply/u);

  const replyOnly = await createFixture([
    line(0, "session_meta", childMeta({
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT,
            depth: 1,
            agent_path: childPath,
          },
        },
      },
    })),
    event(1, "task_started", { turn_id: TURN }),
    line(2, "response_item", {
      type: "agent_message",
      author: childPath,
      recipient: parentPath,
      content: [{ type: "input_text", text: "Child response without a parent instruction." }],
    }),
  ]);
  t.after(() => rm(replyOnly.directory, { recursive: true, force: true }));
  const replyOnlyParser = await parserFor(replyOnly.path);
  const unavailable = await readTaskPreview(replyOnlyParser.snapshot().tasks[0]);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.text, null);
});

test("tailing completes an active task without rereading or double counting", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN, started_at: 1_700_000_100 }),
    token(2, usage(80)),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const parser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  await parser.parseFiles([entry]);
  assert.equal(parser.snapshot().tasks[0].quality, "provisional");
  assert.equal(parser.snapshot().tasks[0].deltaUsage.totalTokens, 80);
  assert.equal(parser.snapshot().tasks[0].model, null);
  assert.equal(parser.snapshot().tasks[0].effort, null);

  await appendFile(
    fixture.path,
    [token(3, usage(125), null, usageDelta(80, 125)), event(4, "task_complete", { turn_id: TURN, completed_at: 1_700_000_130 })]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const result = await parser.tailFile(entry);
  const task = parser.snapshot().tasks[0];
  assert.equal(result.changed, true);
  assert.equal(task.status, "completed");
  assert.equal(task.quality, "complete");
  assert.equal(task.deltaUsage.totalTokens, 125);

  const unchanged = await parser.tailFile(entry);
  assert.equal(unchanged.changed, false);
  assert.equal(parser.snapshot().tasks[0].deltaUsage.totalTokens, 125);
});

test("verified model-usage event classifier distinguishes increments, duplicates, generations, and anomalies", () => {
  const first = normalizeUsage(usage(100));
  const next = normalizeUsage(usage(150));
  const verified = classifyModelUsageEvent(first, next, normalizeUsage(usageIncrement(50)));
  assert.equal(verified.classification, "verified_increment");
  assert.equal(verified.usage.totalTokens, 50);
  assert.deepEqual(verified.mismatchFields, []);

  const duplicate = classifyModelUsageEvent(next, next, normalizeUsage(usageIncrement(7)));
  assert.equal(duplicate.classification, "duplicate");
  assert.equal(duplicate.usage.totalTokens, 0);

  const generation = classifyModelUsageEvent(
    normalizeUsage(usage(200)),
    normalizeUsage(usage(30)),
    normalizeUsage(usage(30)),
  );
  assert.equal(generation.classification, "generation_start");
  assert.equal(generation.usage.totalTokens, 30);
  assert.ok(generation.rollbackFields.includes("totalTokens"));

  const fileStart = classifyModelUsageEvent(null, first, first);
  assert.equal(fileStart.classification, "generation_start");
  assert.equal(fileStart.reason, "zero_baseline_proven");

  const unverified = classifyModelUsageEvent(
    null,
    normalizeUsage(zeroWireUsage()),
    normalizeUsage(usageIncrement(10)),
  );
  assert.equal(unverified.classification, "unverified");
  assert.equal(unverified.reason, "missing_baseline");

  const anomaly = classifyModelUsageEvent(first, next, normalizeUsage(usageIncrement(49)));
  assert.equal(anomaly.classification, "anomaly");
  assert.ok(anomaly.mismatchFields.includes("totalTokens"));
});

test("verified model-usage classifier tolerates legacy missing cache-write fields without inventing them", () => {
  const previous = legacyUsage(100);
  const current = legacyUsage(150);
  const last = normalizeUsage({
    input_tokens: 50,
    cached_input_tokens: 50,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 50,
  });
  const result = classifyModelUsageEvent(previous, current, last);
  assert.equal(result.classification, "verified_increment");
  assert.equal(result.usage.totalTokens, 50);
  assert.equal(result.usage.cacheWriteInputTokens, null);
  assert.ok(result.missingFields.includes("cacheWriteInputTokens"));
  assert.deepEqual(result.mismatchFields, []);
});

test("zero cumulative total with positive last usage stays unverified at an unproven generation boundary", () => {
  const result = classifyModelUsageEvent(
    normalizeUsage(usage(100)),
    normalizeUsage(zeroWireUsage()),
    normalizeUsage(usageIncrement(10)),
  );
  assert.equal(result.classification, "unverified");
  assert.equal(result.reason, "unproven_generation_start");
  assert.equal(result.usage, null);
});

test("unexplained counter rollback keeps verified usage as a partial lower bound", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(200)),
    token(3, usage(30), null, usage(20)),
    event(4, "task_complete", { turn_id: TURN }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const parser = await parserFor(fixture.path);
  const task = parser.snapshot().tasks[0];
  assert.equal(task.quality, "partial");
  assert.equal(task.deltaUsage.totalTokens, 200);
  assert.equal(task.requestLedgerCoverage.anomaly, 1);
  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restoredParser.restore(parser.snapshot(), parser.snapshot().cursors, [entry]);
  assert.deepEqual(recovery.restoredPaths, [fixture.path]);
  assert.equal(restoredParser.snapshot().health.discontinuities, 1);
  assert.equal(restoredParser.snapshot().health.status, "warning");
});

test("a verified generation reset contributes directly without becoming a parser anomaly", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(200), null, usage(200)),
    token(3, usage(30), null, usage(30)),
    event(4, "task_complete", { turn_id: TURN }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const parser = await parserFor(fixture.path);
  const snapshot = parser.snapshot();
  assert.equal(snapshot.modelUsageEvents.at(-1).classification, "generation_start");
  assert.equal(snapshot.tasks[0].quality, "complete");
  assert.equal(snapshot.tasks[0].deltaUsage.totalTokens, 230);
  assert.equal(snapshot.tasks[0].requestCount, 2);
  assert.equal(snapshot.health.discontinuities, 0);
});

test("unknown formats and malformed task boundaries surface in parser health", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    line(1, "future_rollout_record", { compatible_extra_field: true }),
    event(2, "future_event", { compatible_extra_field: true }),
    event(3, "task_started", { started_at: 1_700_000_100 }),
    token(4, usage(10)),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const parser = await parserFor(fixture.path);
  const health = parser.snapshot().health;
  assert.equal(health.unknownRecords, 2);
  assert.equal(health.skippedRecords, 1);
  assert.equal(health.status, "warning");

  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restoredParser.restore(parser.snapshot(), parser.snapshot().cursors, [entry]);
  assert.deepEqual(recovery.restoredPaths, [fixture.path]);
  const restoredHealth = restoredParser.snapshot().health;
  assert.equal(restoredHealth.unknownRecords, 2);
  assert.equal(restoredHealth.skippedRecords, 1);
  assert.equal(restoredHealth.status, "warning");
});

test("restored cursors tail active and subsequent tasks without losing request continuity", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(80)),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const firstParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const stored = await firstParser.parseFiles([entry]);
  assert.equal(stored.cursors[0].lineNumber, 3);

  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const restored = await restoredParser.restore(stored, stored.cursors, [entry]);
  assert.deepEqual(restored.restoredPaths, [fixture.path]);
  assert.deepEqual(restored.replayPaths, []);

  await appendFile(
    fixture.path,
    [
      token(3, usage(125), null, usageDelta(80, 125)),
      event(4, "task_complete", { turn_id: TURN }),
      event(5, "task_started", { turn_id: PARENT_TURN }),
      token(6, usage(200), null, usageDelta(125, 200)),
      event(7, "task_complete", { turn_id: PARENT_TURN }),
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  await restoredParser.tailFile(entry);
  const snapshot = restoredParser.snapshot();
  assert.equal(snapshot.tasks[0].deltaUsage.totalTokens, 125);
  assert.equal(snapshot.tasks[1].deltaUsage.totalTokens, 75);
  assert.equal(snapshot.tasks[1].requestCount, 1);
  assert.equal(snapshot.modelUsageEvents.at(-1).classification, "verified_increment");
  assert.equal(snapshot.health.restoredFiles, 1);
  assert.equal(snapshot.health.replayedFiles, 0);
});

test("restored cursors preserve cumulative usage observed between tasks", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(100)),
    event(3, "task_complete", { turn_id: TURN }),
    token(4, usage(120), null, usageDelta(100, 120)),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const firstParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const stored = await firstParser.parseFiles([entry]);
  assert.equal(stored.cursors[0].lastUsage.totalTokens, 120);

  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restoredParser.restore(stored, stored.cursors, [entry]);
  assert.deepEqual(recovery.restoredPaths, [fixture.path]);
  await appendFile(
    fixture.path,
    [
      event(5, "task_started", { turn_id: PARENT_TURN }),
      token(6, usage(150), null, usageDelta(120, 150)),
      event(7, "task_complete", { turn_id: PARENT_TURN }),
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  await restoredParser.tailFile(entry);
  const restoredTask = restoredParser.snapshot().tasks.find(
    (task) => task.turnId === PARENT_TURN,
  );

  const replayedParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const replayed = await replayedParser.parseFiles([entry]);
  const replayedTask = replayed.tasks.find((task) => task.turnId === PARENT_TURN);
  assert.equal(restoredTask.deltaUsage.totalTokens, 30);
  assert.deepEqual(restoredTask.deltaUsage, replayedTask.deltaUsage);
  assert.equal(restoredTask.requestCount, 1);
});

test("same-thread rollout files preserve verified usage continuity across restore and terminal tail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-multifile-"));
  const firstPath = join(directory, `rollout-first-${CHILD}.jsonl`);
  const secondPath = join(directory, `rollout-second-${CHILD}.jsonl`);
  const firstMeta = childMeta({ timestamp: "2026-08-24T00:00:00.000Z" });
  const secondMeta = childMeta({ timestamp: "2026-08-24T00:10:00.000Z" });
  await writeFile(firstPath, [
    line(0, "session_meta", firstMeta),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(100)),
    event(3, "task_complete", { turn_id: TURN }),
  ].map(JSON.stringify).join("\n") + "\n");
  await writeFile(secondPath, [
    line(4, "session_meta", secondMeta),
    event(5, "task_started", { turn_id: PARENT_TURN }),
    token(6, usage(150), null, usageDelta(100, 150)),
    event(7, "task_complete", { turn_id: PARENT_TURN }),
  ].map(JSON.stringify).join("\n") + "\n");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const entries = [
    makeEntry(firstPath, firstMeta, firstMeta.timestamp, "sessions/2026/08/24/rollout-first.jsonl"),
    makeEntry(secondPath, secondMeta, secondMeta.timestamp, "sessions/2026/08/24/rollout-second.jsonl"),
  ];
  const parser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const stored = await parser.parseFiles(entries);
  assert.deepEqual(
    stored.modelUsageEvents.map((item) => [item.classification, item.usage?.totalTokens, item.generation]),
    [["generation_start", 100, 1], ["verified_increment", 50, 1]],
  );
  assert.deepEqual(stored.tasks.map((task) => task.deltaUsage?.totalTokens), [100, 50]);

  const restored = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restored.restore(stored, stored.cursors, [...entries].reverse());
  assert.deepEqual(recovery.replayPaths, []);
  assert.equal(restored.snapshot().modelUsageEvents.length, 2);
  const restoredFirstTask = restored.snapshot().tasks.find((task) => task.turnId === TURN);
  const restoredSecondTask = restored.snapshot().tasks.find((task) => task.turnId === PARENT_TURN);
  assert.equal(restoredFirstTask.sourcePath, firstPath);
  assert.equal(restoredSecondTask.sourcePath, secondPath);

  await appendFile(secondPath, [
    event(8, "task_started", { turn_id: THIRD_TURN }),
    token(9, usage(180), null, usageDelta(150, 180)),
    event(10, "task_complete", { turn_id: THIRD_TURN }),
  ].map(JSON.stringify).join("\n") + "\n");
  const tail = await restored.tailFile(entries[1]);
  assert.deepEqual(tail, { rebuilt: false, changed: true });
  const afterTail = restored.snapshot();
  assert.equal(afterTail.modelUsageEvents.length, 3);
  assert.equal(afterTail.modelUsageEvents.at(-1).classification, "verified_increment");
  assert.equal(afterTail.modelUsageEvents.at(-1).usage.totalTokens, 30);
  assert.equal(afterTail.tasks.find((task) => task.turnId === THIRD_TURN).deltaUsage.totalTokens, 30);
});

test("growth in a non-terminal same-thread rollout invalidates the whole thread cursor chain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-multifile-replay-"));
  const firstPath = join(directory, `rollout-first-${CHILD}.jsonl`);
  const secondPath = join(directory, `rollout-second-${CHILD}.jsonl`);
  const firstMeta = childMeta({ timestamp: "2026-08-24T00:00:00.000Z" });
  const secondMeta = childMeta({ timestamp: "2026-08-24T00:10:00.000Z" });
  await writeFile(firstPath, [
    line(0, "session_meta", firstMeta),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(100)),
    event(3, "task_complete", { turn_id: TURN }),
  ].map(JSON.stringify).join("\n") + "\n");
  await writeFile(secondPath, [
    line(4, "session_meta", secondMeta),
    event(5, "task_started", { turn_id: PARENT_TURN }),
    token(6, usage(150), null, usageDelta(100, 150)),
    event(7, "task_complete", { turn_id: PARENT_TURN }),
  ].map(JSON.stringify).join("\n") + "\n");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = [
    makeEntry(firstPath, firstMeta, firstMeta.timestamp, "sessions/2026/08/24/rollout-first.jsonl"),
    makeEntry(secondPath, secondMeta, secondMeta.timestamp, "sessions/2026/08/24/rollout-second.jsonl"),
  ];
  const parser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const stored = await parser.parseFiles(entries);

  await appendFile(firstPath, `${JSON.stringify(event(8, "agent_message"))}\n`);
  const restored = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restored.restore(stored, stored.cursors, entries);
  assert.deepEqual(recovery.restoredPaths, []);
  assert.deepEqual(recovery.replayPaths, [firstPath, secondPath]);
  assert.equal(restored.snapshot().modelUsageEvents.length, 0);
});

test("a newly discovered older same-thread rollout requests a rebuild instead of using a future baseline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-multifile-order-"));
  const olderPath = join(directory, `rollout-older-${CHILD}.jsonl`);
  const newerPath = join(directory, `rollout-newer-${CHILD}.jsonl`);
  const olderMeta = childMeta({ timestamp: "2026-08-24T00:00:00.000Z" });
  const newerMeta = childMeta({ timestamp: "2026-08-24T00:10:00.000Z" });
  await writeFile(olderPath, `${JSON.stringify(line(0, "session_meta", olderMeta))}\n`);
  await writeFile(newerPath, [
    line(0, "session_meta", newerMeta),
    token(1, usage(150), null, usage(150)),
  ].map(JSON.stringify).join("\n") + "\n");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const olderEntry = makeEntry(
    olderPath,
    olderMeta,
    olderMeta.timestamp,
    "sessions/2026/08/24/rollout-older.jsonl",
  );
  const newerEntry = makeEntry(
    newerPath,
    newerMeta,
    newerMeta.timestamp,
    "sessions/2026/08/24/rollout-newer.jsonl",
  );
  const parser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  await parser.parseFiles([newerEntry]);
  assert.deepEqual(
    await parser.tailFile(olderEntry),
    { rebuilt: true, changed: false },
  );
});

test("an untrusted cursor is rejected so its thread can be replayed cleanly", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(80)),
    event(3, "task_complete", { turn_id: TURN }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const metadata = await scanRolloutMetadata(fixture.path);
  const entry = makeEntry(fixture.path, metadata.meta, metadata.envelopeTimestamp);
  const firstParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const stored = await firstParser.parseFiles([entry]);
  const invalidCursor = {
    ...stored.cursors[0],
    lineNumber: 0,
  };

  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const restored = await restoredParser.restore(stored, [invalidCursor], [entry]);
  assert.deepEqual(restored.restoredPaths, []);
  assert.deepEqual(restored.replayPaths, [fixture.path]);
  assert.equal(restoredParser.snapshot().tasks.length, 0);

  await restoredParser.parseFile(entry, { reset: true });
  const snapshot = restoredParser.snapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].deltaUsage.totalTokens, 80);
  assert.equal(snapshot.health.replayedFiles, 1);
});

test("stored tasks remain available when their original file is no longer discovered", async (t) => {
  const fixture = await createFixture([
    line(0, "session_meta", childMeta()),
    event(1, "task_started", { turn_id: TURN }),
    token(2, usage(80)),
    event(3, "task_complete", { turn_id: TURN }),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const parser = await parserFor(fixture.path);
  const stored = parser.snapshot();
  await rm(fixture.path);

  const restoredParser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  const recovery = await restoredParser.restore(stored, stored.cursors, []);
  const snapshot = restoredParser.snapshot();
  assert.deepEqual(recovery, { restoredPaths: [], replayPaths: [] });
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].deltaUsage.totalTokens, 80);
});

test("an incomplete final JSON line is retained for the next tail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-partial-"));
  const path = join(directory, `rollout-test-${CHILD}.jsonl`);
  const complete = JSON.stringify(line(0, "session_meta", childMeta())) + "\n";
  const partial = JSON.stringify(event(1, "task_started", { turn_id: TURN })).slice(0, 35);
  await writeFile(path, complete + partial);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parser = await parserFor(path);
  const snapshot = parser.snapshot();
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.health.partialBytes, Buffer.byteLength(partial));
});

test("the real five-task rollout matches the audited totals when available", async (t) => {
  const path = process.env.CODEX_MONITOR_REAL_FIXTURE;
  if (!path || !existsSync(path)) {
    t.skip("set CODEX_MONITOR_REAL_FIXTURE to an audited local rollout to run this test");
    return;
  }
  const beforeHash = await fileHash(path);
  const parser = await parserFor(path);
  assert.deepEqual(
    parser.snapshot().tasks.map((task) => task.deltaUsage?.totalTokens),
    [1_081_772, 765_891, 2_230_918, 1_144_641, 482_917],
  );
  assert.equal(await fileHash(path), beforeHash);
});

async function parserFor(path) {
  const metadata = await scanRolloutMetadata(path);
  const parser = new SessionRolloutParser(ROOT, { id: ROOT, title: "Fixture" });
  await parser.parseFiles([makeEntry(path, metadata.meta, metadata.envelopeTimestamp)]);
  return parser;
}

function makeEntry(path, meta, envelopeTimestamp, sourceKey = null) {
  return {
    path,
    sourceKey: sourceKey ?? undefined,
    threadId: meta.id,
    rootSessionId: meta.session_id,
    parentThreadId: meta.parent_thread_id,
    meta,
    envelopeTimestamp,
  };
}

async function createFixture(records) {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-parser-"));
  const path = join(directory, `rollout-test-${CHILD}.jsonl`);
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { directory, path };
}

function childMeta(extra = {}) {
  return {
    id: CHILD,
    session_id: ROOT,
    parent_thread_id: ROOT,
    timestamp: "2026-08-24T00:00:00.000Z",
    cli_version: "test-1",
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: ROOT,
          depth: 1,
          agent_path: "/root/test-agent",
          agent_nickname: "Test Agent",
          agent_role: "explorer",
        },
      },
    },
    ...extra,
  };
}

function line(ordinal, type, payload) {
  return { timestamp: new Date(1_700_000_000_000 + ordinal * 1000).toISOString(), ordinal, type, payload };
}

function event(ordinal, type, payload = {}) {
  return line(ordinal, "event_msg", { type, ...payload });
}

function token(ordinal, total, primary = null, last = null) {
  return event(ordinal, "token_count", {
    info: { total_token_usage: total, last_token_usage: last ?? total, model_context_window: 100_000 },
    rate_limits: primary
      ? { limit_id: "codex", plan_type: "plus", primary: { ...primary, window_minutes: 10_080, resets_at: 1_800_000_000 } }
      : null,
  });
}

function quotaSnapshot(observedAt, primaryUsed, primaryReset) {
  return {
    limitId: "codex",
    planType: "plus",
    observedAt,
    primary: {
      usedPercent: primaryUsed,
      windowMinutes: 300,
      resetsAt: primaryReset,
    },
    secondary: {
      usedPercent: 31,
      windowMinutes: 10_080,
      resetsAt: "2026-09-02T02:55:03.000Z",
    },
  };
}

function usage(total) {
  return {
    input_tokens: total - 20,
    cached_input_tokens: Math.max(0, total - 40),
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: total,
  };
}

function usageDelta(previousTotal, currentTotal) {
  const previous = normalizeUsage(usage(previousTotal));
  const current = normalizeUsage(usage(currentTotal));
  return {
    input_tokens: current.inputTokens - previous.inputTokens,
    cached_input_tokens: current.cachedInputTokens - previous.cachedInputTokens,
    cache_write_input_tokens: current.cacheWriteInputTokens - previous.cacheWriteInputTokens,
    output_tokens: current.outputTokens - previous.outputTokens,
    reasoning_output_tokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    total_tokens: current.totalTokens - previous.totalTokens,
  };
}

function usageIncrement(total) {
  return {
    input_tokens: total,
    cached_input_tokens: total,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
  };
}

function zeroWireUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function legacyUsage(total) {
  const raw = usage(total);
  delete raw.cache_write_input_tokens;
  return normalizeUsage(raw);
}

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
