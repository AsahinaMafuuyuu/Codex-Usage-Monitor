import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

import { readRequestContent, REQUEST_CONTENT_LIMITS } from "../src/request-content.js";
import { CodexSourceLocator } from "../src/source-locator.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");
const iterations = positiveInteger(readArgument("--iterations"), 20);
const warmup = positiveInteger(readArgument("--warmup"), 3);
const requestedRequestId = readArgument("--request");

const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec("PRAGMA query_only=ON;");
const sourceLocator = new CodexSourceLocator(codexHome);

try {
  const requested = requestedRequestId ? selectRequestCandidate(db, requestedRequestId) : null;
  if (requestedRequestId && !requested) {
    throw new Error(`Canonical Request not found: ${requestedRequestId}`);
  }
  const common = selectCandidate(db, {
    where: "(t.end_byte - t.start_byte) BETWEEN 8192 AND 262144",
    order: "r.observed_at DESC, r.request_id DESC",
  }) ?? selectCandidate(db, {
    where: "(t.end_byte - t.start_byte) <= 524288",
    order: "(t.end_byte - t.start_byte) DESC, r.observed_at DESC",
  });
  const nearLimit = selectCandidate(db, {
    where: `(t.end_byte - t.start_byte) <= ${REQUEST_CONTENT_LIMITS.maxSliceBytes}`,
    order: "(t.end_byte - t.start_byte) DESC, r.origin_line_number DESC",
  });
  if (!requested && (!common || !nearLimit)) {
    throw new Error("No canonical Request candidates with bounded Task byte locators were found");
  }

  const reports = [];
  const candidates = requested
    ? [["requested", requested]]
    : [["common", common], ["near_limit", nearLimit]];
  for (const [name, candidate] of candidates) {
    const locator = loadProductionLocator(db, candidate.root_session_id, candidate.request_id);
    if (!locator) {
      reports.push({ name, available: false, reason: "request_locator_missing", requestId: candidate.request_id });
      continue;
    }
    const sourcePath = sourceLocator.pathForKey(locator.sourceKey);
    if (!sourcePath || !existsSync(sourcePath)) {
      reports.push({ name, available: false, reason: "source_missing", requestId: locator.requestId });
      continue;
    }
    const sourceHashBefore = await hashFile(sourcePath);
    for (let index = 0; index < warmup; index += 1) {
      const warmLocator = loadProductionLocator(db, candidate.root_session_id, candidate.request_id);
      const warmPath = sourceLocator.pathForKey(warmLocator.sourceKey);
      await readRequestContent({ sourcePath: warmPath, locator: warmLocator });
    }
    const samples = [];
    let lastResult = null;
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const currentLocator = loadProductionLocator(db, candidate.root_session_id, candidate.request_id);
      const currentSourcePath = sourceLocator.pathForKey(currentLocator.sourceKey);
      lastResult = await readRequestContent({ sourcePath: currentSourcePath, locator: currentLocator });
      samples.push(performance.now() - started);
    }
    const sourceHashAfter = await hashFile(sourcePath);
    reports.push({
      name,
      requestId: locator.requestId,
      sourceKey: locator.sourceKey,
      taskBytes: locator.task.endByte - locator.task.startByte,
      taskLines: locator.task.endLine - locator.task.startLine + 1,
      targetLine: locator.lineNumber,
      previousBoundaryLine: locator.previousBoundary?.lineNumber ?? null,
      available: Boolean(lastResult?.available),
      reason: lastResult?.reason ?? null,
      coverage: lastResult?.evidence?.coverage ?? null,
      itemCount: lastResult?.items?.length ?? 0,
      scanBytes: lastResult?.evidence?.scanBytes ?? null,
      locateBytes: lastResult?.evidence?.locateBytes ?? null,
      sliceBytes: lastResult?.evidence?.sliceBytes ?? null,
      anchor: lastResult?.evidence?.anchor ?? null,
      p50Ms: round(percentile(samples, 0.50)),
      p95Ms: round(percentile(samples, 0.95)),
      maxMs: round(Math.max(...samples)),
      sourceHashUnchanged: sourceHashBefore === sourceHashAfter,
    });
  }
  console.log(JSON.stringify({
    iterations,
    warmup,
    limits: REQUEST_CONTENT_LIMITS,
    reports,
  }, null, 2));
} finally {
  db.close();
}

function selectRequestCandidate(db, requestId) {
  return db.prepare(`
    SELECT r.request_id, r.root_session_id
    FROM canonical_requests r
    WHERE r.request_id=?
    LIMIT 1
  `).get(requestId) ?? null;
}

function selectCandidate(db, { where, order }) {
  return db.prepare(`
    SELECT
      r.request_id,
      r.root_session_id,
      r.thread_id,
      r.turn_id,
      r.observed_at,
      r.event_ordinal,
      r.origin_source_key,
      r.origin_line_number,
      t.sequence AS task_sequence,
      t.status AS task_status,
      t.effort AS task_effort,
      t.source_key AS task_source_key,
      t.start_line AS task_start_line,
      t.end_line AS task_end_line,
      t.start_byte AS task_start_byte,
      t.end_byte AS task_end_byte
    FROM canonical_requests r
    INNER JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    WHERE r.origin_source_key=t.source_key
      AND t.start_line IS NOT NULL
      AND t.end_line IS NOT NULL
      AND t.start_byte IS NOT NULL
      AND t.end_byte IS NOT NULL
      AND t.end_byte > t.start_byte
      AND ${where}
    ORDER BY ${order}
    LIMIT 1
  `).get() ?? null;
}

function loadProductionLocator(db, rootSessionId, requestId) {
  const row = db.prepare(`
    SELECT
      r.request_id,
      r.root_session_id,
      r.thread_id,
      r.turn_id,
      r.observed_at,
      r.event_ordinal,
      r.origin_source_key,
      r.origin_line_number,
      t.sequence AS task_sequence,
      t.status AS task_status,
      t.effort AS task_effort,
      t.source_key AS task_source_key,
      t.start_line AS task_start_line,
      t.end_line AS task_end_line,
      t.start_byte AS task_start_byte,
      t.end_byte AS task_end_byte
    FROM canonical_requests r
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    WHERE r.root_session_id=? AND r.request_id=?
  `).get(rootSessionId, requestId);
  if (!row) return null;
  const ordered = db.prepare(`
    SELECT request_id, observed_at, event_ordinal, origin_source_key, origin_line_number
    FROM canonical_requests
    WHERE root_session_id=? AND thread_id=? AND turn_id=? AND origin_source_key=?
    ORDER BY observed_at, request_id
  `).all(row.root_session_id, row.thread_id, row.turn_id, row.origin_source_key);
  const currentIndex = ordered.findIndex((candidate) => candidate.request_id === row.request_id);
  const previous = currentIndex > 0 ? ordered[currentIndex - 1] : null;
  let boundaryStatus = "ok";
  if (row.task_source_key == null || row.task_start_line == null || row.task_start_byte == null) {
    boundaryStatus = "task_boundary_unavailable";
  } else if (row.task_source_key !== row.origin_source_key || currentIndex < 0) {
    boundaryStatus = "boundary_ambiguous";
  } else {
    for (let index = 1; index <= currentIndex; index += 1) {
      if (Number(ordered[index - 1].origin_line_number) >= Number(ordered[index].origin_line_number)) {
        boundaryStatus = "boundary_ambiguous";
        break;
      }
    }
  }
  return {
    requestId: row.request_id,
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    observedAt: row.observed_at,
    eventOrdinal: row.event_ordinal == null ? null : Number(row.event_ordinal),
    sourceKey: row.origin_source_key,
    lineNumber: Number(row.origin_line_number),
    boundaryStatus,
    previousBoundary: previous
      ? {
          requestId: previous.request_id,
          observedAt: previous.observed_at,
          eventOrdinal: previous.event_ordinal == null ? null : Number(previous.event_ordinal),
          sourceKey: previous.origin_source_key,
          lineNumber: Number(previous.origin_line_number),
        }
      : null,
    task: {
      sequence: Number(row.task_sequence),
      status: row.task_status,
      effort: row.task_effort,
      sourceKey: row.task_source_key,
      startLine: Number(row.task_start_line),
      endLine: Number(row.task_end_line),
      startByte: Number(row.task_start_byte),
      endByte: Number(row.task_end_byte),
    },
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function round(value) {
  return Number(value.toFixed(3));
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
