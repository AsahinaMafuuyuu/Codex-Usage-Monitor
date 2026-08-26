import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateVerifiedUsageByLocalDay,
  materializeRequestLedgerTasks,
  reconcileRequestLedger,
} from "../src/reconciliation.js";

test("complete tasks reconcile exactly while duplicates contribute zero", () => {
  const tasks = [task("complete", usage(150))];
  const events = [
    event("generation_start", usage(100)),
    event("duplicate", usage(0)),
    event("verified_increment", usage(50)),
  ];
  const report = reconcileRequestLedger(tasks, events);
  assert.equal(report.summary.exact_match, 1);
  assert.equal(report.summary.mismatch, 0);
  assert.equal(report.summary.eventCounts.duplicate, 1);
  assert.equal(report.tasks[0].requestUsage.totalTokens, 150);
  assert.equal(report.tasks[0].requestCount, 2);
});

test("legacy unavailable fields are reported as schema-limited instead of fabricated", () => {
  const boundary = usage(50);
  const request = usage(50);
  request.cacheWriteInputTokens = null;
  const report = reconcileRequestLedger(
    [task("complete", boundary)],
    [event("verified_increment", request)],
  );
  assert.equal(report.tasks[0].status, "schema_limited_match");
  assert.deepEqual(report.tasks[0].unavailableFields, ["cacheWriteInputTokens"]);
  assert.equal(report.tasks[0].requestUsage.cacheWriteInputTokens, null);
});

test("request ledger recovers a discontinuity without pretending the boundary ledger matched", () => {
  const report = reconcileRequestLedger(
    [task("discontinuity", null)],
    [event("generation_start", usage(30))],
  );
  assert.equal(report.tasks[0].status, "recovered");
  assert.equal(report.tasks[0].requestUsage.totalTokens, 30);
});

test("verified local-day aggregation excludes duplicate and unverified events", () => {
  const events = [
    event("generation_start", usage(20), "2026-08-22T08:00:00.000Z"),
    event("verified_increment", usage(30), "2026-08-22T09:00:00.000Z"),
    event("duplicate", usage(0), "2026-08-22T10:00:00.000Z"),
    event("unverified", null, "2026-08-22T11:00:00.000Z"),
  ];
  const days = aggregateVerifiedUsageByLocalDay(events);
  assert.equal(days["2026-08-22"].usage.totalTokens, 50);
  assert.equal(days["2026-08-22"].requestCount, 2);
});

test("primary task usage comes only from fully verified request events while retaining boundary evidence", () => {
  const original = task("discontinuity", null);
  const [promoted] = materializeRequestLedgerTasks(
    [original],
    [event("generation_start", usage(30))],
  );
  assert.equal(promoted.usageSource, "request_ledger");
  assert.equal(promoted.deltaUsage.totalTokens, 30);
  assert.equal(promoted.quality, "complete");
  assert.equal(promoted.boundaryQuality, "discontinuity");
  assert.equal(promoted.boundaryDeltaUsage, null);
  assert.equal(promoted.requestCount, 1);
  assert.equal(promoted.tokensPerModelRequest, 30);
});

test("an attributed unverified event keeps only verified request usage as partial without boundary fallback", () => {
  const original = task("complete", usage(100));
  const [promoted] = materializeRequestLedgerTasks(
    [original],
    [
      event("verified_increment", usage(80)),
      event("unverified", null),
    ],
  );
  assert.equal(promoted.deltaUsage.totalTokens, 80);
  assert.equal(promoted.quality, "partial");
  assert.equal(promoted.boundaryDeltaUsage.totalTokens, 100);
  assert.equal(promoted.requestLedgerCoverage.unverified, 1);
  assert.equal(promoted.tokensPerModelRequest, 80);
});

function task(quality, deltaUsage) {
  return {
    rootSessionId: "root",
    threadId: "thread",
    turnId: "turn",
    quality,
    deltaUsage,
  };
}

function event(classification, usageValue, observedAt = "2026-08-22T08:00:00.000Z") {
  return {
    rootSessionId: "root",
    threadId: "thread",
    turnId: "turn",
    classification,
    usage: usageValue,
    observedAt,
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
