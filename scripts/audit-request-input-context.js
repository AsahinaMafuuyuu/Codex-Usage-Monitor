import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MonitorDatabase } from "../src/database.js";
import {
  readReconstructedInputContext,
  REQUEST_INPUT_CONTEXT_LIMITS,
} from "../src/request-input-context.js";
import { CodexSourceLocator } from "../src/source-locator.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");
const sampleSize = positiveInteger(readArgument("--sample"), 40);
const database = new MonitorDatabase(databasePath, { readOnly: true });
const sourceLocator = new CodexSourceLocator(codexHome);

try {
  const requestRows = database.db.prepare(`
    SELECT request_id, root_session_id, observed_at
    FROM canonical_requests
    ORDER BY observed_at, request_id
  `).all();
  const threadRows = database.db.prepare(`
    SELECT root_session_id, thread_id, COUNT(*) AS source_count
    FROM ingest_cursors
    WHERE root_session_id IS NOT NULL AND thread_id IS NOT NULL
    GROUP BY root_session_id, thread_id
  `).all();
  const sourceCounts = threadRows.map((row) => Number(row.source_count ?? 0)).sort((a, b) => a - b);
  const sampledRequests = evenlySample(requestRows, sampleSize);
  const reconstructionReports = [];

  for (const row of sampledRequests) {
    const locator = database.getCanonicalRequestInputContextLocator(row.root_session_id, row.request_id);
    if (!locator) continue;
    const result = await readReconstructedInputContext({
      locator,
      resolveSource: (sourceKey) => {
        const path = sourceLocator.pathForKey(sourceKey);
        return path && existsSync(path) ? path : null;
      },
    });
    reconstructionReports.push({
      requestId: row.request_id,
      available: result.available,
      reason: result.reason ?? null,
      sourceChainStatus: locator.sourceChainStatus,
      sourceSegments: locator.sourceChain?.length ?? 0,
      historyScanBytes: Number(result.summary?.historyScanBytes ?? 0),
      itemCount: Number(result.summary?.itemCount ?? 0),
      visibleCharacters: Number(result.summary?.visibleCharacters ?? 0),
      missingSourceCount: Number(result.summary?.missingSourceCount ?? 0),
      compactionCount: Number(result.summary?.compactionCount ?? 0),
      compactionSnapshotCount: (result.sections?.compaction ?? [])
        .filter((item) => item.kind === "compaction_snapshot").length,
      cutStatus: result.reconstructionCut?.status ?? "unavailable",
      rolloutCoverage: result.evidence?.rolloutCoverage ?? "unavailable",
      truncated: Boolean(result.evidence?.truncated),
    });
  }

  const scans = reconstructionReports.map((row) => row.historyScanBytes).sort((a, b) => a - b);
  const items = reconstructionReports.map((row) => row.itemCount).sort((a, b) => a - b);
  const characters = reconstructionReports.map((row) => row.visibleCharacters).sort((a, b) => a - b);
  const compactionObserved = reconstructionReports.filter((row) => row.compactionCount > 0);
  const coverageCounts = countBy(reconstructionReports, (row) => row.rolloutCoverage);
  const sourceChainStatuses = countBy(reconstructionReports, (row) => row.sourceChainStatus);

  console.log(JSON.stringify({
    databasePath,
    codexHome,
    limitsEvaluated: REQUEST_INPUT_CONTEXT_LIMITS,
    canonicalRequests: {
      total: requestRows.length,
      sampled: reconstructionReports.length,
      requestedSampleSize: sampleSize,
    },
    sourcesPerThread: summarize(sourceCounts),
    sampledReconstruction: {
      historyScanBytes: summarize(scans),
      contextItems: summarize(items),
      visibleCharacters: summarize(characters),
      sourceMissingRequests: reconstructionReports.filter((row) => row.missingSourceCount > 0).length,
      cutUnavailableRequests: reconstructionReports.filter((row) => row.cutStatus !== "observed").length,
      truncatedRequests: reconstructionReports.filter((row) => row.truncated).length,
      sourceChainStatuses,
      coverageCounts,
    },
    compaction: {
      requestsWithObservedCompaction: compactionObserved.length,
      requestsWithExplicitSnapshot: compactionObserved.filter((row) => row.compactionSnapshotCount > 0).length,
      requestsWithSignalOnlyOrUnsupportedCompaction: compactionObserved.filter(
        (row) => row.compactionSnapshotCount === 0,
      ).length,
    },
  }, null, 2));
} finally {
  database.close();
}

function evenlySample(rows, count) {
  if (rows.length <= count) return rows;
  if (count <= 1) return [rows.at(-1)];
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const position = Math.round((index * (rows.length - 1)) / (count - 1));
    const row = rows[position];
    if (!row || seen.has(row.request_id)) continue;
    seen.add(row.request_id);
    selected.push(row);
  }
  return selected;
}

function summarize(sortedValues) {
  const values = [...sortedValues].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.at(-1) ?? 0,
  };
}

function percentile(sorted, quantile) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function countBy(rows, project) {
  const result = {};
  for (const row of rows) {
    const key = String(project(row) ?? "unknown");
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
