import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  ADVANCED_USAGE_DIAGNOSTICS_POLICY,
  analyzeAdvancedUsageDiagnostics,
} from "../src/advanced-diagnostics.js";
import { estimateRequestCost } from "../src/pricing.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
const iterations = Math.max(1, Math.min(100, Number(readArgument("--iterations") ?? 20) || 20));
if (!existsSync(databasePath)) throw new Error(`Advanced diagnostics database not found: ${databasePath}`);

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON;");
  const candidates = db.prepare(`
    SELECT
      s.id,
      s.project_path,
      COUNT(r.request_id) AS request_count,
      MIN(r.observed_at) AS first_observed_at,
      MAX(r.observed_at) AS last_observed_at
    FROM sessions s
    JOIN canonical_requests r ON r.root_session_id=s.id
    WHERE s.project_path IS NOT NULL AND s.project_path!=''
    GROUP BY s.id, s.project_path
    ORDER BY request_count, s.id
  `).all();
  if (!candidates.length) throw new Error("No indexed sessions with canonical requests are available");

  const common = candidates[Math.floor(candidates.length / 2)];
  const largestSession = candidates.at(-1);
  const largestProject = db.prepare(`
    SELECT s.project_path, COUNT(r.request_id) AS request_count
    FROM sessions s
    JOIN canonical_requests r ON r.root_session_id=s.id
    WHERE s.project_path IS NOT NULL AND s.project_path!=''
    GROUP BY s.project_path
    ORDER BY request_count DESC, s.project_path
    LIMIT 1
  `).get();
  const largestProjectSession = db.prepare(`
    SELECT
      s.id,
      s.project_path,
      COUNT(r.request_id) AS request_count,
      MIN(r.observed_at) AS first_observed_at,
      MAX(r.observed_at) AS last_observed_at
    FROM sessions s
    JOIN canonical_requests r ON r.root_session_id=s.id
    WHERE s.project_path=?
    GROUP BY s.id, s.project_path
    ORDER BY last_observed_at DESC, s.id DESC
    LIMIT 1
  `).get(largestProject.project_path);

  const cases = dedupeCases([
    { name: "common", session: common },
    { name: "largest-session", session: largestSession },
    { name: "largest-project-latest-session", session: largestProjectSession },
  ]);
  const results = [];
  for (const benchmarkCase of cases) {
    for (let index = 0; index < Math.min(3, iterations); index += 1) runReport(db, benchmarkCase.session);
    const timings = [];
    const stageTimings = [];
    let lastCounts = null;
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      lastCounts = runReport(db, benchmarkCase.session);
      timings.push(performance.now() - startedAt);
      stageTimings.push(lastCounts.stages);
    }
    timings.sort((left, right) => left - right);
    results.push({
      name: benchmarkCase.name,
      sessionRequestCount: Number(benchmarkCase.session.request_count ?? 0),
      ...lastCounts,
      p50Ms: round(percentile(timings, 0.50)),
      p95Ms: round(percentile(timings, 0.95)),
      maxMs: round(timings.at(-1)),
      stageP50Ms: Object.fromEntries(
        Object.keys(stageTimings[0] ?? {}).map((key) => [
          key,
          round(percentile(stageTimings.map((entry) => entry[key]).sort((a, b) => a - b), 0.50)),
        ]),
      ),
    });
  }

  const planTarget = largestProjectSession;
  const bounds = historyBounds(planTarget);
  console.log(JSON.stringify({
    policyVersion: ADVANCED_USAGE_DIAGNOSTICS_POLICY.version,
    databasePath,
    sessionCount: candidates.length,
    largestProjectRequestCount: Number(largestProject.request_count ?? 0),
    results,
    goals: {
      commonWarmP95Ms: 200,
      largestRealProjectSessionMs: 500,
    },
    queryPlans: {
      requestHistory: explainRequestHistory(db, planTarget, bounds),
      sessionHistory: explainSessionHistory(db, planTarget, bounds),
    },
  }, null, 2));
} finally {
  db.close();
}

function runReport(db, session) {
  const stages = {};
  let startedAt = performance.now();
  const currentFacts = readCurrentFacts(db, session.id);
  stages.currentQuery = performance.now() - startedAt;
  const bounds = historyBounds(session);
  startedAt = performance.now();
  const requestHistory = readRequestHistory(db, session, bounds);
  stages.requestHistoryQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const sessionHistory = readSessionHistory(db, session, bounds);
  stages.sessionHistoryQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const currentEnriched = enrich(currentFacts);
  const requestEnriched = enrich(requestHistory);
  const sessionEnriched = enrich(sessionHistory);
  stages.pricingEnrichment = performance.now() - startedAt;
  startedAt = performance.now();
  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts: currentEnriched,
    historicalFacts: requestEnriched,
    historicalSessionFacts: sessionEnriched,
    scope: { type: "session" },
  });
  stages.analyzer = performance.now() - startedAt;
  return {
    requestHistoryCount: requestHistory.length,
    sessionHistoryRequestCount: sessionHistory.length,
    findingCount: report.findings.length,
    stages,
  };
}

function historyBounds(session) {
  const firstMs = Date.parse(session.first_observed_at);
  const lastMs = Date.parse(session.last_observed_at);
  return {
    requestAfter: new Date(
      firstMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays * 86_400_000,
    ).toISOString(),
    sessionAfter: new Date(
      firstMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.horizonDays * 86_400_000,
    ).toISOString(),
    before: new Date(lastMs + 1).toISOString(),
  };
}

function readCurrentFacts(db, rootSessionId) {
  return db.prepare(`
    SELECT
      r.*, s.project_path, t.effort, t.sequence AS task_sequence
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    WHERE r.root_session_id=?
    ORDER BY r.observed_at, r.request_id
  `).all(rootSessionId).map(mapFact);
}

function readRequestHistory(db, session, bounds) {
  return db.prepare(requestHistorySql(false)).all(
    session.project_path,
    session.id,
    bounds.requestAfter,
    bounds.before,
    ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
  ).map(mapFact);
}

function readSessionHistory(db, session, bounds) {
  return db.prepare(sessionHistorySql(false)).all(
    session.project_path,
    session.id,
    bounds.sessionAfter,
    bounds.before,
    ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.maxSlicesPerCohort,
    session.project_path,
    session.id,
    bounds.sessionAfter,
    bounds.before,
  ).map(mapFact);
}

function explainRequestHistory(db, session, bounds) {
  return db.prepare(requestHistorySql(true)).all(
    session.project_path,
    session.id,
    bounds.requestAfter,
    bounds.before,
    ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
  ).map((row) => row.detail);
}

function explainSessionHistory(db, session, bounds) {
  return db.prepare(sessionHistorySql(true)).all(
    session.project_path,
    session.id,
    bounds.sessionAfter,
    bounds.before,
    ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.maxSlicesPerCohort,
    session.project_path,
    session.id,
    bounds.sessionAfter,
    bounds.before,
  ).map((row) => row.detail);
}

function requestHistorySql(explain) {
  return `${explain ? "EXPLAIN QUERY PLAN " : ""}
    WITH ranked AS (
      SELECT
        r.*, s.project_path, t.effort, t.sequence AS task_sequence,
        ROW_NUMBER() OVER (
          PARTITION BY r.model, t.effort
          ORDER BY r.observed_at DESC, r.root_session_id DESC, r.request_id DESC
        ) AS cohort_rank
      FROM canonical_requests r
      JOIN sessions s ON s.id=r.root_session_id
      LEFT JOIN tasks t
        ON t.root_session_id=r.root_session_id
       AND t.thread_id=r.thread_id
       AND t.turn_id=r.turn_id
      WHERE s.project_path=?
        AND r.root_session_id<>?
        AND r.observed_at>=?
        AND r.observed_at<?
    )
    SELECT * FROM ranked
    WHERE cohort_rank<=?
    ORDER BY observed_at, root_session_id, request_id
  `;
}

function sessionHistorySql(explain) {
  return `${explain ? "EXPLAIN QUERY PLAN " : ""}
    WITH slice_candidates AS (
      SELECT
        r.root_session_id, r.model, t.effort, MAX(r.observed_at) AS last_observed_at
      FROM canonical_requests r
      JOIN sessions s ON s.id=r.root_session_id
      LEFT JOIN tasks t
        ON t.root_session_id=r.root_session_id
       AND t.thread_id=r.thread_id
       AND t.turn_id=r.turn_id
      WHERE s.project_path=?
        AND r.root_session_id<>?
        AND r.observed_at>=?
        AND r.observed_at<?
        AND r.model IS NOT NULL
        AND t.effort IS NOT NULL
      GROUP BY r.root_session_id, r.model, t.effort
    ), ranked_slices AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY model, effort
        ORDER BY last_observed_at DESC, root_session_id DESC
      ) AS slice_rank
      FROM slice_candidates
    ), selected_slices AS (
      SELECT root_session_id, model, effort FROM ranked_slices WHERE slice_rank<=?
    )
    SELECT r.*, s.project_path, t.effort, t.sequence AS task_sequence
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    INNER JOIN selected_slices selected
      ON selected.root_session_id=r.root_session_id
     AND selected.model=r.model
     AND selected.effort=t.effort
    WHERE s.project_path=?
      AND r.root_session_id<>?
      AND r.observed_at>=?
      AND r.observed_at<?
    ORDER BY r.observed_at, r.root_session_id, r.request_id
  `;
}

function mapFact(row) {
  return {
    requestId: row.request_id,
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    eventOrdinal: numberOrNull(row.event_ordinal),
    observedAt: row.observed_at,
    generation: Number(row.generation ?? 0),
    classification: row.classification,
    quality: row.quality,
    reason: row.reason ?? null,
    projectPath: row.project_path ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    serviceTier: row.service_tier ?? null,
    pricingContextQuality: row.pricing_context_quality ?? null,
    taskSequence: numberOrNull(row.task_sequence),
    usage: {
      inputTokens: numberOrNull(row.input_tokens),
      cachedInputTokens: numberOrNull(row.cached_input_tokens),
      cacheWriteInputTokens: numberOrNull(row.cache_write_input_tokens),
      outputTokens: numberOrNull(row.output_tokens),
      reasoningOutputTokens: numberOrNull(row.reasoning_output_tokens),
      totalTokens: numberOrNull(row.total_tokens),
    },
  };
}

function enrich(facts) {
  return facts.map((fact) => ({ ...fact, costEstimate: estimateRequestCost(fact) }));
}

function dedupeCases(cases) {
  const seen = new Set();
  return cases.filter((entry) => {
    if (!entry.session || seen.has(entry.session.id)) return false;
    seen.add(entry.session.id);
    return true;
  });
}

function percentile(sorted, value) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))];
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function numberOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
