import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MonitorDatabase } from "../src/database.js";
import {
  analyzeRequestContextDelta,
  REQUEST_CONTEXT_DELTA_LIMITS,
  REQUEST_CONTEXT_DELTA_POLICY,
} from "../src/request-context-delta.js";
import { readReconstructedInputContext } from "../src/request-input-context.js";
import { CodexSourceLocator } from "../src/source-locator.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");
const sampleSize = positiveInteger(readArgument("--sample"), 300);
const database = new MonitorDatabase(databasePath, { readOnly: true });
const sourceLocator = new CodexSourceLocator(codexHome);

try {
  const rows = database.db.prepare(`
    SELECT request_id, root_session_id, observed_at
    FROM canonical_requests
    ORDER BY observed_at, request_id
  `).all();
  const sampled = evenlySample(rows, sampleSize);
  const reports = [];

  for (const row of sampled) {
    const pairLocator = database.getCanonicalRequestContextDeltaLocator(row.root_session_id, row.request_id);
    if (!pairLocator) continue;
    if (pairLocator.status !== "ok") {
      reports.push({
        requestId: row.request_id,
        pairStatus: pairLocator.status,
        crossSource: false,
        comparisonCoverage: pairLocator.status,
        diffTruncated: false,
        compactionCount: 0,
        retainedItems: 0,
        addedItems: 0,
        removedOrSupersededItems: 0,
        visibleCharactersDelta: null,
        inputTokensDelta: null,
        cachedInputTokensDelta: null,
        cacheHitRateDeltaPoints: null,
        correlationSignals: [],
      });
      continue;
    }
    const result = await analyzeRequestContextDelta({
      pairLocator,
      reconstructInputContext: (locator) => readReconstructedInputContext({
        locator,
        resolveSource: resolveExistingSource,
      }),
    });
    reports.push({
      requestId: row.request_id,
      pairStatus: pairLocator.status,
      crossSource: pairLocator.previous.sourceKey !== pairLocator.current.sourceKey,
      comparisonCoverage: result.evidence.comparisonCoverage,
      diffTruncated: Boolean(result.evidence.diffTruncated),
      compactionCount: result.contextDelta.compaction.length,
      retainedItems: Number(result.contextDelta.summary.retainedItems ?? 0),
      addedItems: Number(result.contextDelta.summary.addedItems ?? 0),
      removedOrSupersededItems: Number(result.contextDelta.summary.removedOrSupersededItems ?? 0),
      visibleCharactersDelta: finiteOrNull(result.contextDelta.summary.visibleCharactersDelta),
      inputTokensDelta: finiteOrNull(result.accounting.delta.inputTokens),
      cachedInputTokensDelta: finiteOrNull(result.accounting.delta.cachedInputTokens),
      cacheHitRateDeltaPoints: finiteOrNull(result.accounting.delta.cacheHitRatePoints),
      correlationSignals: result.correlationSignals.map((signal) => signal.type),
    });
  }

  const completePairs = reports.filter((row) => row.pairStatus === "ok");
  console.log(JSON.stringify({
    databasePath,
    codexHome,
    limitsEvaluated: REQUEST_CONTEXT_DELTA_LIMITS,
    policyEvaluated: REQUEST_CONTEXT_DELTA_POLICY,
    canonicalRequests: {
      total: rows.length,
      requestedSampleSize: sampleSize,
      sampled: reports.length,
      completePairs: completePairs.length,
    },
    pairStatusCounts: countBy(reports, (row) => row.pairStatus),
    comparisonCoverageCounts: countBy(reports, (row) => row.comparisonCoverage),
    crossSourcePairs: completePairs.filter((row) => row.crossSource).length,
    pairsWithCompaction: completePairs.filter((row) => row.compactionCount > 0).length,
    diffTruncatedPairs: completePairs.filter((row) => row.diffTruncated).length,
    semanticDelta: {
      retainedItems: summarize(completePairs.map((row) => row.retainedItems)),
      addedItems: summarize(completePairs.map((row) => row.addedItems)),
      removedOrSupersededItems: summarize(completePairs.map((row) => row.removedOrSupersededItems)),
      visibleCharactersDelta: summarizeNullable(completePairs.map((row) => row.visibleCharactersDelta)),
    },
    accountingDelta: {
      inputTokens: summarizeNullable(completePairs.map((row) => row.inputTokensDelta)),
      cachedInputTokens: summarizeNullable(completePairs.map((row) => row.cachedInputTokensDelta)),
      cacheHitRatePoints: summarizeNullable(completePairs.map((row) => row.cacheHitRateDeltaPoints)),
    },
    correlationSignalCounts: countSignalTypes(completePairs),
    cacheChangedWithoutVisibleContextChange: completePairs.filter(
      (row) => row.correlationSignals.includes("cache_changed_without_visible_context_change"),
    ).length,
  }, null, 2));
} finally {
  database.close();
}

function resolveExistingSource(sourceKey) {
  const path = sourceLocator.pathForKey(sourceKey);
  return path && existsSync(path) ? path : null;
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

function summarize(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted.at(0) ?? null,
    max: sorted.at(-1) ?? null,
  };
}

function summarizeNullable(values) {
  return {
    available: values.filter(Number.isFinite).length,
    missing: values.filter((value) => !Number.isFinite(value)).length,
    ...summarize(values),
  };
}

function percentile(sorted, quantile) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

function countBy(rows, project) {
  const result = {};
  for (const row of rows) {
    const key = String(project(row) ?? "unknown");
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function countSignalTypes(rows) {
  const result = {};
  for (const row of rows) {
    for (const signal of row.correlationSignals) result[signal] = (result[signal] ?? 0) + 1;
  }
  return result;
}

function finiteOrNull(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
