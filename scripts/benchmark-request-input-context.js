import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

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

  const common = requested ?? findExistingCandidate(database, sourceLocator, `
    SELECT request_id, root_session_id
    FROM canonical_requests
    WHERE input_tokens BETWEEN 20000 AND 150000
    ORDER BY observed_at DESC, request_id DESC
    LIMIT 80
  `);
  const large = requested ? null : findExistingCandidate(database, sourceLocator, `
    SELECT request_id, root_session_id
    FROM canonical_requests
    ORDER BY input_tokens DESC, observed_at DESC, request_id DESC
    LIMIT 120
  `);
  const candidates = requested
    ? [["requested", requested]]
    : [["common", common], ["large", large]];
  if (candidates.some(([, candidate]) => !candidate)) {
    throw new Error("No production-equivalent Request Input Context benchmark candidates were found");
  }

  const reports = [];
  for (const [name, candidate] of candidates) {
    const initialLocator = database.getCanonicalRequestInputContextLocator(
      candidate.root_session_id,
      candidate.request_id,
    );
    if (!initialLocator) {
      reports.push({ name, requestId: candidate.request_id, available: false, reason: "request_locator_missing" });
      continue;
    }
    const sourcePaths = initialLocator.sourceChain
      .map((segment) => sourceLocator.pathForKey(segment.sourceKey))
      .filter((path) => path && existsSync(path));
    const sourceHashBefore = await hashFiles(sourcePaths);
    for (let index = 0; index < warmup; index += 1) {
      const locator = database.getCanonicalRequestInputContextLocator(
        candidate.root_session_id,
        candidate.request_id,
      );
      await readReconstructedInputContext({
        locator,
        resolveSource: (sourceKey) => {
          const path = sourceLocator.pathForKey(sourceKey);
          return path && existsSync(path) ? path : null;
        },
      });
    }

    const samples = [];
    let lastResult = null;
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const locator = database.getCanonicalRequestInputContextLocator(
        candidate.root_session_id,
        candidate.request_id,
      );
      lastResult = await readReconstructedInputContext({
        locator,
        resolveSource: (sourceKey) => {
          const path = sourceLocator.pathForKey(sourceKey);
          return path && existsSync(path) ? path : null;
        },
      });
      samples.push(performance.now() - started);
    }
    const sourceHashAfter = await hashFiles(sourcePaths);
    reports.push({
      name,
      requestId: candidate.request_id,
      sourceSegmentCount: initialLocator.sourceChain.length,
      available: Boolean(lastResult?.available),
      reason: lastResult?.reason ?? null,
      rolloutCoverage: lastResult?.evidence?.rolloutCoverage ?? null,
      historyScanBytes: lastResult?.summary?.historyScanBytes ?? null,
      itemCount: lastResult?.summary?.itemCount ?? null,
      visibleCharacters: lastResult?.summary?.visibleCharacters ?? null,
      compactionCount: lastResult?.summary?.compactionCount ?? null,
      p50Ms: round(percentile(samples, 0.50)),
      p95Ms: round(percentile(samples, 0.95)),
      maxMs: round(Math.max(...samples)),
      sourceHashUnchanged: sourceHashBefore === sourceHashAfter,
    });
  }

  console.log(JSON.stringify({
    iterations,
    warmup,
    limits: REQUEST_INPUT_CONTEXT_LIMITS,
    reports,
  }, null, 2));
} finally {
  database.close();
}

function findExistingCandidate(database, sourceLocator, sql) {
  const rows = database.db.prepare(sql).all();
  for (const row of rows) {
    const locator = database.getCanonicalRequestInputContextLocator(row.root_session_id, row.request_id);
    if (!locator || locator.sourceChainStatus !== "ok") continue;
    const currentPath = sourceLocator.pathForKey(locator.sourceKey);
    if (currentPath && existsSync(currentPath)) return row;
  }
  return null;
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
