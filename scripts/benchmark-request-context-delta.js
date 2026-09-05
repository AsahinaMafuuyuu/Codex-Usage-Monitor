import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

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
const iterations = positiveInteger(readArgument("--iterations"), 20);
const warmup = positiveInteger(readArgument("--warmup"), 3);
const requestedRequestId = readArgument("--request");
const database = new MonitorDatabase(databasePath, { readOnly: true });
const sourceLocator = new CodexSourceLocator(codexHome);

try {
  const requested = requestedRequestId
    ? database.db.prepare("SELECT request_id, root_session_id FROM canonical_requests WHERE request_id=? LIMIT 1")
      .get(requestedRequestId) ?? null
    : null;
  if (requestedRequestId && !requested) throw new Error(`Canonical Request not found: ${requestedRequestId}`);

  const common = requested ?? findCandidate(`
    SELECT request_id, root_session_id
    FROM canonical_requests
    WHERE input_tokens BETWEEN 20000 AND 150000
    ORDER BY observed_at DESC, request_id DESC
    LIMIT 160
  `);
  const large = requested ? null : findCandidate(`
    SELECT request_id, root_session_id
    FROM canonical_requests
    ORDER BY input_tokens DESC, observed_at DESC, request_id DESC
    LIMIT 240
  `);
  const candidates = requested
    ? [["requested", requested]]
    : [["common", common], ["large", large]];
  if (candidates.some(([, candidate]) => !candidate)) {
    throw new Error("No production-equivalent Context Delta benchmark candidates were found");
  }

  const reports = [];
  for (const [name, candidate] of candidates) {
    const initialPair = database.getCanonicalRequestContextDeltaLocator(
      candidate.root_session_id,
      candidate.request_id,
    );
    if (!initialPair || initialPair.status !== "ok") {
      reports.push({ name, requestId: candidate.request_id, available: false, reason: initialPair?.status ?? "request_locator_missing" });
      continue;
    }
    const sourcePaths = pairSourcePaths(initialPair);
    const sourceHashBefore = await hashFiles(sourcePaths);

    for (let index = 0; index < warmup; index += 1) await runProductionPair(candidate);
    const totalSamples = [];
    let lastResult = null;
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      lastResult = await runProductionPair(candidate);
      totalSamples.push(performance.now() - started);
    }

    const cachedPrevious = await reconstruct(initialPair.previous);
    const cachedCurrent = await reconstruct(initialPair.current);
    const cachedContexts = new Map([
      [initialPair.previous.requestId, cachedPrevious],
      [initialPair.current.requestId, cachedCurrent],
    ]);
    for (let index = 0; index < warmup; index += 1) {
      await analyzeRequestContextDelta({
        pairLocator: initialPair,
        reconstructInputContext: async (locator) => cachedContexts.get(locator.requestId),
      });
    }
    const diffSamples = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      await analyzeRequestContextDelta({
        pairLocator: initialPair,
        reconstructInputContext: async (locator) => cachedContexts.get(locator.requestId),
      });
      diffSamples.push(performance.now() - started);
    }

    const sourceHashAfter = await hashFiles(sourcePaths);
    const totalP95Ms = round(percentile(totalSamples, 0.95));
    const diffP95Ms = round(percentile(diffSamples, 0.95));
    const totalTargetMs = name === "large" ? 750 : 100;
    reports.push({
      name,
      requestId: candidate.request_id,
      available: true,
      pairStatus: lastResult?.pair?.status ?? null,
      comparisonCoverage: lastResult?.evidence?.comparisonCoverage ?? null,
      crossSource: initialPair.previous.sourceKey !== initialPair.current.sourceKey,
      sourceFileCount: sourcePaths.length,
      previousItems: cachedPrevious.summary?.itemCount ?? null,
      currentItems: cachedCurrent.summary?.itemCount ?? null,
      retainedItems: lastResult?.contextDelta?.summary?.retainedItems ?? null,
      addedItems: lastResult?.contextDelta?.summary?.addedItems ?? null,
      removedOrSupersededItems: lastResult?.contextDelta?.summary?.removedOrSupersededItems ?? null,
      diffTruncated: Boolean(lastResult?.evidence?.diffTruncated),
      totalP50Ms: round(percentile(totalSamples, 0.50)),
      totalP95Ms,
      totalMaxMs: round(Math.max(...totalSamples)),
      diffProjectionP50Ms: round(percentile(diffSamples, 0.50)),
      diffProjectionP95Ms: diffP95Ms,
      diffProjectionMaxMs: round(Math.max(...diffSamples)),
      sourceHashUnchanged: sourceHashBefore === sourceHashAfter,
      gates: {
        totalTargetMs,
        totalP95Pass: totalP95Ms < totalTargetMs,
        diffP95TargetMs: 100,
        diffP95Pass: diffP95Ms < 100,
        sourceHashUnchanged: sourceHashBefore === sourceHashAfter,
      },
    });
  }

  console.log(JSON.stringify({
    iterations,
    warmup,
    limits: REQUEST_CONTEXT_DELTA_LIMITS,
    policy: REQUEST_CONTEXT_DELTA_POLICY,
    reports,
    allMeasuredGatesPass: reports
      .filter((report) => report.available)
      .every((report) => report.gates.totalP95Pass && report.gates.diffP95Pass && report.gates.sourceHashUnchanged),
  }, null, 2));
} finally {
  database.close();
}

function findCandidate(sql) {
  const rows = database.db.prepare(sql).all();
  for (const row of rows) {
    const pair = database.getCanonicalRequestContextDeltaLocator(row.root_session_id, row.request_id);
    if (!pair || pair.status !== "ok") continue;
    if (pairSourcePaths(pair).length === 0) continue;
    if (!allPairSourcesExist(pair)) continue;
    return row;
  }
  return null;
}

async function runProductionPair(candidate) {
  const pairLocator = database.getCanonicalRequestContextDeltaLocator(
    candidate.root_session_id,
    candidate.request_id,
  );
  return analyzeRequestContextDelta({
    pairLocator,
    reconstructInputContext: reconstruct,
  });
}

function reconstruct(locator) {
  return readReconstructedInputContext({
    locator,
    resolveSource: resolveExistingSource,
  });
}

function resolveExistingSource(sourceKey) {
  const path = sourceLocator.pathForKey(sourceKey);
  return path && existsSync(path) ? path : null;
}

function pairSourcePaths(pair) {
  const unique = new Set();
  for (const locator of [pair.previous, pair.current]) {
    for (const segment of locator?.sourceChain ?? []) {
      const path = sourceLocator.pathForKey(segment.sourceKey);
      if (path && existsSync(path)) unique.add(path);
    }
  }
  return [...unique].sort();
}

function allPairSourcesExist(pair) {
  for (const locator of [pair.previous, pair.current]) {
    for (const segment of locator?.sourceChain ?? []) {
      const path = sourceLocator.pathForKey(segment.sourceKey);
      if (!path || !existsSync(path)) return false;
    }
  }
  return true;
}

async function hashFiles(paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  }
  return hash.digest("hex");
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function round(value) {
  return Number(value.toFixed(3));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
