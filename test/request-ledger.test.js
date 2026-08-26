import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateVerifiedUsageByLocalDay,
  materializeRequestLedgerTasks,
} from "../src/request-ledger.js";

test("verified request events are the only task usage source", () => {
  const [materialized] = materializeRequestLedgerTasks(
    [task()],
    [
      event("generation_start", usage(100)),
      event("duplicate", usage(0)),
      event("verified_increment", usage(50)),
    ],
  );
  assert.equal(materialized.usageSource, "request_ledger");
  assert.equal(materialized.deltaUsage.totalTokens, 150);
  assert.equal(materialized.quality, "complete");
  assert.equal(materialized.requestCount, 2);
  assert.equal(materialized.tokensPerModelRequest, 75);
  assert.deepEqual(materialized.requestLedgerCoverage, {
    verified: 2,
    duplicate: 1,
    unverified: 0,
    anomaly: 0,
  });
  assert.equal("boundaryDeltaUsage" in materialized, false);
  assert.equal("boundaryQuality" in materialized, false);
});

test("unverified task events preserve only the verified lower bound", () => {
  const [materialized] = materializeRequestLedgerTasks(
    [task()],
    [event("verified_increment", usage(80)), event("unverified", null)],
  );
  assert.equal(materialized.deltaUsage.totalTokens, 80);
  assert.equal(materialized.quality, "partial");
  assert.equal(materialized.requestLedgerCoverage.unverified, 1);
  assert.equal(materialized.tokensPerModelRequest, 80);
});

test("active verified tasks are provisional and unresolved-only tasks remain partial", () => {
  const [active] = materializeRequestLedgerTasks(
    [task("in_progress")],
    [event("verified_increment", usage(20))],
  );
  const [unresolved] = materializeRequestLedgerTasks(
    [task()],
    [event("anomaly", null)],
  );
  assert.equal(active.quality, "provisional");
  assert.equal(active.deltaUsage.totalTokens, 20);
  assert.equal(unresolved.quality, "partial");
  assert.equal(unresolved.deltaUsage, null);
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

function task(status = "completed") {
  return {
    rootSessionId: "root",
    threadId: "thread",
    turnId: "turn",
    status,
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
