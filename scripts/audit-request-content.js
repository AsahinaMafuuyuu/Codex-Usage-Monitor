import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { REQUEST_CONTENT_LIMITS } from "../src/request-content.js";
import { CodexSourceLocator } from "../src/source-locator.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");
const sourceLocator = new CodexSourceLocator(codexHome);
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec("PRAGMA query_only=ON;");

try {
  const totalRequests = Number(db.prepare("SELECT COUNT(*) AS count FROM canonical_requests").get()?.count ?? 0);
  const sourceGroups = db.prepare(`
    SELECT origin_source_key AS source_key, COUNT(*) AS request_count
    FROM canonical_requests
    GROUP BY origin_source_key
  `).all();
  let sourceMissingRequests = 0;
  let sourceMissingSources = 0;
  const presentSources = new Set();
  for (const group of sourceGroups) {
    const path = sourceLocator.pathForKey(group.source_key);
    if (!path || !existsSync(path)) {
      sourceMissingSources += 1;
      sourceMissingRequests += Number(group.request_count ?? 0);
    } else {
      presentSources.add(group.source_key);
    }
  }

  const boundaryAmbiguousIds = new Set();
  const oversizedSliceIds = new Set();
  const locatorUnreachableIds = new Set();
  const boundedUnavailableIds = new Set();
  const sliceSizes = [];
  const largestSlices = [];
  let inspectedTaskCount = 0;
  let inspectedRequestCount = 0;

  const locatorRows = db.prepare(`
    SELECT r.request_id, r.root_session_id, r.thread_id, r.turn_id,
           r.origin_source_key, r.origin_line_number, r.observed_at,
           t.source_key AS task_source_key, t.start_line, t.end_line, t.start_byte
    FROM canonical_requests r
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    ORDER BY r.root_session_id, r.thread_id, r.turn_id, r.origin_source_key,
             r.observed_at, r.request_id
  `).all();
  let locatorGroup = null;
  let previousOriginLine = null;
  let groupLineOrderAmbiguous = false;
  for (const row of locatorRows) {
    if (!presentSources.has(row.origin_source_key)) continue;
    const groupKey = `${row.root_session_id}\u0000${row.thread_id}\u0000${row.turn_id}\u0000${row.origin_source_key}`;
    if (groupKey !== locatorGroup) {
      locatorGroup = groupKey;
      previousOriginLine = null;
      groupLineOrderAmbiguous = false;
    }
    const originLine = Number(row.origin_line_number);
    if (previousOriginLine != null && previousOriginLine >= originLine) groupLineOrderAmbiguous = true;
    const basicBoundaryInvalid =
      row.task_source_key == null ||
      row.start_line == null ||
      row.start_byte == null ||
      row.task_source_key !== row.origin_source_key ||
      originLine < Number(row.start_line) ||
      (row.end_line != null && originLine > Number(row.end_line));
    if (basicBoundaryInvalid || groupLineOrderAmbiguous) {
      boundaryAmbiguousIds.add(row.request_id);
      boundedUnavailableIds.add(row.request_id);
    }
    previousOriginLine = originLine;
  }

  const candidateTasks = db.prepare(`
    SELECT root_session_id, thread_id, turn_id, source_key,
           start_line, end_line, start_byte, end_byte
    FROM tasks
    WHERE source_key IS NOT NULL
      AND start_line IS NOT NULL AND end_line IS NOT NULL
      AND start_byte IS NOT NULL AND end_byte IS NOT NULL
      AND end_byte > start_byte
      AND end_byte - start_byte > ?
    ORDER BY root_session_id, thread_id, turn_id
  `).all(REQUEST_CONTENT_LIMITS.maxSliceBytes);

  for (const task of candidateTasks) {
    if (!presentSources.has(task.source_key)) continue;
    const path = sourceLocator.pathForKey(task.source_key);
    if (!path || !existsSync(path)) continue;
    const taskBytes = Number(task.end_byte) - Number(task.start_byte);
    const buffer = readExactFileRange(path, Number(task.start_byte), taskBytes);
    const lineStarts = buildLineStarts(buffer);
    const taskStartLine = Number(task.start_line);
    const requests = db.prepare(`
      SELECT request_id, origin_line_number
      FROM canonical_requests
      WHERE root_session_id=? AND thread_id=? AND turn_id=? AND origin_source_key=?
      ORDER BY observed_at, request_id
    `).all(task.root_session_id, task.thread_id, task.turn_id, task.source_key);
    inspectedTaskCount += 1;
    inspectedRequestCount += requests.length;
    let previousLine = null;
    for (const request of requests) {
      const lineNumber = Number(request.origin_line_number);
      const currentIndex = lineNumber - taskStartLine;
      const currentEnd = lineStarts[currentIndex + 1];
      if (!Number.isInteger(currentEnd)) {
        locatorUnreachableIds.add(request.request_id);
        boundedUnavailableIds.add(request.request_id);
        previousLine = lineNumber;
        continue;
      }
      let sliceStart = 0;
      let locatorReachable = currentEnd <= REQUEST_CONTENT_LIMITS.maxWindowBytes;
      if (previousLine != null) {
        const previousIndex = previousLine - taskStartLine;
        const previousStart = lineStarts[previousIndex];
        const previousEnd = lineStarts[previousIndex + 1];
        if (!Number.isInteger(previousStart) || !Number.isInteger(previousEnd)) {
          locatorReachable = false;
        } else {
          sliceStart = previousEnd;
          const forwardLocateBytes = currentEnd;
          const reverseLocateBytes = taskBytes - previousStart;
          locatorReachable =
            forwardLocateBytes <= REQUEST_CONTENT_LIMITS.maxWindowBytes ||
            reverseLocateBytes <= REQUEST_CONTENT_LIMITS.maxWindowBytes;
        }
      }
      const sliceBytes = Math.max(0, currentEnd - sliceStart);
      sliceSizes.push(sliceBytes);
      largestSlices.push({ requestId: request.request_id, sliceBytes, taskBytes });
      if (!locatorReachable) {
        locatorUnreachableIds.add(request.request_id);
        boundedUnavailableIds.add(request.request_id);
      }
      if (sliceBytes > REQUEST_CONTENT_LIMITS.maxSliceBytes) {
        oversizedSliceIds.add(request.request_id);
        boundedUnavailableIds.add(request.request_id);
      }
      previousLine = lineNumber;
    }
  }

  const sourcePresentRequests = totalRequests - sourceMissingRequests;
  const expectedReadableRequests = Math.max(0, sourcePresentRequests - boundedUnavailableIds.size);
  console.log(JSON.stringify({
    databasePath,
    limits: REQUEST_CONTENT_LIMITS,
    coverage: {
      totalRequests,
      sourcePresentRequests,
      sourceMissingRequests,
      sourceMissingSources,
      boundaryAmbiguousRequests: boundaryAmbiguousIds.size,
      candidateLargeTasks: inspectedTaskCount,
      candidateLargeTaskRequests: inspectedRequestCount,
      locatorUnreachableRequests: locatorUnreachableIds.size,
      oversizedSliceRequests: oversizedSliceIds.size,
      boundedUnavailableRequests: boundedUnavailableIds.size,
      expectedReadableRequests,
      sourcePresentReadablePercent: percent(expectedReadableRequests, sourcePresentRequests),
      allRequestReadablePercent: percent(expectedReadableRequests, totalRequests),
    },
    slices: summarizeSlices(sliceSizes, largestSlices),
  }, null, 2));
} finally {
  db.close();
}

function readExactFileRange(path, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  let offset = 0;
  try {
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) throw new Error(`Unexpected end of rollout while auditing ${length} bytes`);
      offset += bytesRead;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function buildLineStarts(buffer) {
  const starts = [0];
  let offset = 0;
  while (true) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) return starts;
    starts.push(newline + 1);
    offset = newline + 1;
  }
}

function summarizeSlices(values, examples) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p95Bytes: percentile(sorted, 0.95),
    p99Bytes: percentile(sorted, 0.99),
    p999Bytes: percentile(sorted, 0.999),
    maxBytes: sorted.at(-1) ?? 0,
    over2MiB: sorted.filter((value) => value > 2 * 1024 * 1024).length,
    over4MiB: sorted.filter((value) => value > 4 * 1024 * 1024).length,
    over8MiB: sorted.filter((value) => value > 8 * 1024 * 1024).length,
    largest: examples.sort((left, right) => right.sliceBytes - left.sliceBytes).slice(0, 10),
  };
}

function percentile(sorted, quantile) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function percent(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(5));
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
