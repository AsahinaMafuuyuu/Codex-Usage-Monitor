import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MonitorDatabase } from "../src/database.js";
import {
  analyzeRequestContextDelta,
  REQUEST_CONTEXT_DELTA_LIMITS,
} from "../src/request-context-delta.js";

const THREAD = "thread-context-delta";
const SOURCE_A = "sessions/2026/09/02/rollout-2026-09-02T10-00-00-root-a.jsonl";
const SOURCE_B = "sessions/2026/09/02/rollout-2026-09-02T11-00-00-root-b.jsonl";

test("retains prior semantic context while classifying appended input and accounting deltas", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 80));
  const current = locator("request-2", SOURCE_A, usage(150, 75));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ current: [message("same prompt", "direct_current")], visible: 11 }),
    [current.requestId]: context({
      history: [message("same prompt", "historical_rollout")],
      current: [message("new tool result", "direct_current")],
      visible: 26,
    }),
  });

  assert.equal(result.pair.status, "complete_pair");
  assert.equal(result.contextDelta.summary.retainedItems, 1);
  assert.equal(result.contextDelta.summary.addedItems, 1);
  assert.equal(result.contextDelta.summary.removedOrSupersededItems, 0);
  assert.equal(result.accounting.delta.inputTokens, 50);
  assert.equal(result.accounting.delta.cachedInputTokens, -5);
  assert.equal(result.accounting.delta.cacheHitRatePoints, -30);
  assert.ok(result.correlationSignals.some((signal) => signal.type === "cache_hit_drop_with_context_growth"));
  assert.equal(result.evidence.providerCacheKeyKnown, false);
  assert.equal(result.evidence.providerSerializationKnown, false);
  assert.equal(result.evidence.exactCacheCausalityKnown, false);
  assert.doesNotMatch(JSON.stringify(result), /itemTokens|tokenAllocation|providerCacheKey[^K]/u);
});

test("sequence-aware matching preserves duplicate semantic items", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 80));
  const current = locator("request-2", SOURCE_A, usage(100, 80));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({
      history: [message("duplicate"), message("duplicate")],
      visible: 18,
    }),
    [current.requestId]: context({
      history: [message("duplicate"), message("duplicate"), message("duplicate")],
      visible: 27,
    }),
  });
  assert.equal(result.contextDelta.summary.retainedItems, 2);
  assert.equal(result.contextDelta.summary.addedItems, 1);
  assert.equal(result.contextDelta.summary.removedOrSupersededItems, 0);
});

test("semantic fingerprint normalizes NFC and CRLF without exposing a digest", async () => {
  const previous = locator("request-1", SOURCE_A, usage(10, 10));
  const current = locator("request-2", SOURCE_A, usage(10, 10));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ history: [message("e\u0301\r\nline")], visible: 8 }),
    [current.requestId]: context({ history: [message("é\nline")], visible: 6 }),
  });
  assert.equal(result.contextDelta.summary.retainedItems, 1);
  assert.equal(result.contextDelta.summary.addedItems, 0);
  assert.equal(result.contextDelta.summary.removedOrSupersededItems, 0);
  assert.doesNotMatch(JSON.stringify(result), /fingerprint|sha256|digest/u);
});

test("runtime allowlist changes correlate with cache drop without becoming a causal claim", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 90));
  const current = locator("request-2", SOURCE_A, usage(100, 50));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ runtime: [runtime("cwd", "Working directory", "D:/old")], visible: 5 }),
    [current.requestId]: context({ runtime: [runtime("cwd", "Working directory", "D:/new")], visible: 5 }),
  });
  assert.deepEqual(result.contextDelta.runtimeChanges, [{
    kind: "runtime_changed",
    key: "cwd",
    label: "Working directory",
    previousValue: "D:/old",
    currentValue: "D:/new",
  }]);
  const signal = result.correlationSignals.find((candidate) => candidate.type === "cache_hit_drop_with_runtime_change");
  assert.ok(signal);
  assert.equal(signal.limitation, "Exact provider cache causality unavailable.");
  assert.doesNotMatch(JSON.stringify(result), /root cause|caused the cache|cache key changed/iu);
});

test("explicit compaction marks unmatched pre-compaction history as superseded", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 90));
  const current = locator("request-2", SOURCE_A, usage(100, 50));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ history: [message("old history")], visible: 11 }),
    [current.requestId]: context({
      history: [message("replacement", "compaction_snapshot")],
      compaction: [compaction("compaction_snapshot", SOURCE_A, 40)],
      visible: 11,
    }),
  });
  assert.equal(result.contextDelta.compaction.length, 1);
  assert.equal(result.contextDelta.removedOrSuperseded[0].deltaDisposition, "superseded_by_compaction");
  assert.ok(result.correlationSignals.some((signal) => signal.type === "cache_hit_drop_with_compaction"));
});

test("signal-only compaction keeps unmatched history epistemically unresolved", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 90));
  const current = locator("request-2", SOURCE_A, usage(100, 80));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ history: [message("old history")], visible: 11 }),
    [current.requestId]: context({
      history: [message("after signal")],
      compaction: [compaction("compaction_signal", SOURCE_A, 40)],
      coverage: "partial_compaction_snapshot_unavailable",
      visible: 12,
    }),
  });
  assert.equal(result.contextDelta.removedOrSuperseded[0].deltaDisposition, "unresolved_due_to_compaction_gap");
  assert.equal(result.evidence.comparisonCoverage, "current_context_partial");
  assert.ok(result.correlationSignals.some((signal) => signal.type === "insufficient_context_coverage"));
});

test("bounded diff falls back to prefix/suffix matching when work budget is exceeded", async () => {
  const previous = locator("request-1", SOURCE_A, usage(100, 90));
  const current = locator("request-2", SOURCE_A, usage(100, 90));
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ history: [message("a"), message("b"), message("c"), message("d")], visible: 4 }),
    [current.requestId]: context({ history: [message("a"), message("c"), message("b"), message("d")], visible: 4 }),
  }, {
    ...REQUEST_CONTEXT_DELTA_LIMITS,
    maxDiffWorkUnits: 1,
  });
  assert.equal(result.evidence.diffTruncated, true);
  assert.equal(result.contextDelta.summary.retainedItems, 2);
});

test("no predecessor returns explicit state without reconstructing context", async () => {
  const current = locator("request-1", SOURCE_A, usage(100, 80));
  let calls = 0;
  const result = await analyzeRequestContextDelta({
    pairLocator: { status: "no_predecessor", threadId: THREAD, current, previous: null },
    reconstructInputContext: async () => {
      calls += 1;
      throw new Error("should not reconstruct");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.pair.status, "no_predecessor");
  assert.equal(result.evidence.comparisonCoverage, "no_predecessor");
  assert.equal(result.accounting.previous.coverage, "accounting_missing");
});

test("missing or contradictory accounting stays null/covered instead of being zero-filled", async () => {
  const previous = locator("request-1", SOURCE_A, { inputTokens: 100, cachedInputTokens: 120 });
  const current = locator("request-2", SOURCE_A, null);
  const result = await analyze(previous, current, {
    [previous.requestId]: context({ visible: 0 }),
    [current.requestId]: context({ visible: 0 }),
  });
  assert.equal(result.accounting.previous.coverage, "accounting_inconsistent");
  assert.equal(result.accounting.previous.cacheHitRate, null);
  assert.equal(result.accounting.current.inputTokens, null);
  assert.equal(result.accounting.delta.inputTokens, null);
  assert.equal(result.accounting.delta.cacheHitRatePoints, null);
});

test("DB pair locator selects the immediate same-thread predecessor across rollout source chronology", async () => {
  await withPairDatabase(async (database) => {
    seedCanonical(database, { requestId: "request-a", sourceKey: SOURCE_A, lineNumber: 10, observedAt: "2026-09-02T12:00:00.000Z" });
    seedCanonical(database, { requestId: "request-b", sourceKey: SOURCE_B, lineNumber: 5, observedAt: "2026-09-02T12:00:00.000Z" });
    seedCursor(database, SOURCE_A, 10);
    seedCursor(database, SOURCE_B, 5);

    const pair = database.getCanonicalRequestContextDeltaLocator("root-context-delta", "request-b");
    assert.equal(pair.status, "ok");
    assert.equal(pair.previous.requestId, "request-a");
    assert.equal(pair.current.requestId, "request-b");
    assert.equal(pair.previous.sourceKey, SOURCE_A);
    assert.equal(pair.current.sourceKey, SOURCE_B);
    assert.equal(pair.sourceOrdering, "rollout_filename_timestamp");
  });
});

test("DB pair locator refuses duplicate source chronology instead of guessing a predecessor", async () => {
  const duplicateChronologySource = "sessions/2026/09/02/rollout-2026-09-02T10-00-00-root-c.jsonl";
  await withPairDatabase(async (database) => {
    seedCanonical(database, { requestId: "request-a", sourceKey: SOURCE_A, lineNumber: 10, observedAt: "2026-09-02T12:00:00.000Z" });
    seedCanonical(database, { requestId: "request-c", sourceKey: duplicateChronologySource, lineNumber: 20, observedAt: "2026-09-02T12:00:01.000Z" });
    seedCursor(database, SOURCE_A, 10);
    seedCursor(database, duplicateChronologySource, 20);

    const pair = database.getCanonicalRequestContextDeltaLocator("root-context-delta", "request-c");
    assert.equal(pair.status, "boundary_ambiguous");
    assert.equal(pair.previous, null);
  });
});

function analyze(previous, current, contexts, limits = undefined) {
  return analyzeRequestContextDelta({
    pairLocator: {
      status: "ok",
      rootSessionId: "root-context-delta",
      threadId: THREAD,
      sourceOrdering: "rollout_filename_timestamp",
      previous,
      current,
    },
    reconstructInputContext: async (target) => structuredClone(contexts[target.requestId]),
    ...(limits ? { limits } : {}),
  });
}

function locator(requestId, sourceKey, requestUsage) {
  return {
    requestId,
    rootSessionId: "root-context-delta",
    threadId: THREAD,
    sourceKey,
    lineNumber: requestId.endsWith("1") ? 10 : 20,
    usage: requestUsage,
  };
}

function usage(inputTokens, cachedInputTokens) {
  return { inputTokens, cachedInputTokens };
}

function context({
  history = [],
  current = [],
  runtime = [],
  compaction = [],
  coverage = "complete_observed_history",
  visible = 0,
} = {}) {
  return {
    available: true,
    evidence: { rolloutCoverage: coverage },
    sections: {
      currentInput: current,
      runtimeContext: runtime,
      historyGroups: history.length ? [{ items: history }] : [],
      compaction,
      gaps: [],
    },
    summary: { visibleCharacters: visible },
  };
}

function message(text, level = "historical_rollout") {
  return {
    kind: "message",
    role: "user",
    text,
    provenance: { level, sourceKey: SOURCE_A, lineStart: 1, lineEnd: 1 },
  };
}

function runtime(key, label, value) {
  return {
    kind: "runtime_context",
    fields: [{ key, label, value, format: "code" }],
    provenance: { level: "runtime_context", sourceKey: SOURCE_A },
  };
}

function compaction(kind, sourceKey, line) {
  return {
    kind,
    label: kind === "compaction_snapshot" ? "Explicit replacement history snapshot" : "Compaction signal",
    provenance: {
      level: kind === "compaction_snapshot" ? "compaction_snapshot" : "coverage_gap",
      sourceKey,
      lineStart: line,
      lineEnd: line,
    },
  };
}

async function withPairDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "request-context-delta-db-"));
  const database = new MonitorDatabase(join(directory, "usage.sqlite"));
  try {
    database.db.prepare(`
      INSERT INTO sessions (id, title, parse_status)
      VALUES (?, ?, ?)
    `).run("root-context-delta", "Context Delta fixture", "imported");
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function seedCanonical(database, { requestId, sourceKey, lineNumber, observedAt }) {
  database.db.prepare(`
    INSERT INTO canonical_requests (
      request_id, root_session_id, thread_id, turn_id, event_ordinal, observed_at,
      generation, classification, quality, input_tokens, cached_input_tokens,
      cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      identity_kind, origin_source_key, origin_line_number
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'model_request', 'complete', 100, 80, 0, 20, 5, 120, 'native', ?, ?)
  `).run(
    requestId,
    "root-context-delta",
    THREAD,
    "turn-context-delta",
    lineNumber,
    observedAt,
    sourceKey,
    lineNumber,
  );
}

function seedCursor(database, sourceKey, lineNumber) {
  database.db.prepare(`
    INSERT INTO ingest_cursors (
      source_key, root_session_id, thread_id, byte_offset, line_number, file_size, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceKey,
    "root-context-delta",
    THREAD,
    1024,
    lineNumber,
    1024,
    "2026-09-02T12:00:00.000Z",
  );
}
