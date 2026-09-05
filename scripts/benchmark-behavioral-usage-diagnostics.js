import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
  analyzeBehavioralUsageDiagnostics,
} from "../src/behavioral-diagnostics.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
const iterations = Math.max(1, Math.min(100, Number(readArgument("--iterations") ?? 20) || 20));
if (!existsSync(databasePath)) throw new Error(`Behavioral diagnostics database not found: ${databasePath}`);

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
      requestHistoryCount: lastCounts.requestHistoryCount,
      sessionHistoryRequestCount: lastCounts.sessionHistoryRequestCount,
      amplificationHistoryCount: lastCounts.amplificationHistoryCount,
      findingCount: lastCounts.findingCount,
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

  console.log(JSON.stringify({
    policyVersion: BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.version,
    databasePath,
    sessionCount: candidates.length,
    largestProjectRequestCount: Number(largestProject.request_count ?? 0),
    results,
    goals: {
      commonWarmP95Ms: 200,
      largestRealProjectSessionMs: 500,
    },
  }, null, 2));
} finally {
  db.close();
}

function runReport(db, session) {
  const stages = {};
  const bounds = historyBounds(session);
  let startedAt = performance.now();
  const currentFacts = readCurrentFacts(db, session.id);
  stages.currentQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const requestHistory = readRequestHistory(db, session, bounds);
  stages.requestHistoryQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const sessionHistory = readSessionHistory(db, session, bounds);
  stages.sessionHistoryQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const amplificationHistory = readAmplificationHistory(db, session, bounds);
  stages.amplificationHistoryQuery = performance.now() - startedAt;
  startedAt = performance.now();
  const report = analyzeBehavioralUsageDiagnostics({
    currentFacts,
    historicalFacts: requestHistory,
    historicalSessionFacts: sessionHistory,
    historicalAmplificationSamples: amplificationHistory,
    scope: { type: "session" },
  });
  stages.analyzer = performance.now() - startedAt;
  return {
    requestHistoryCount: requestHistory.length,
    sessionHistoryRequestCount: sessionHistory.length,
    amplificationHistoryCount: amplificationHistory.length,
    findingCount: report.findings.length,
    stages,
  };
}

function historyBounds(session) {
  const firstMs = Date.parse(session.first_observed_at);
  const lastMs = Date.parse(session.last_observed_at);
  return {
    requestAfter: new Date(firstMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays * 86_400_000).toISOString(),
    burstAfter: new Date(firstMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.burst.horizonDays * 86_400_000).toISOString(),
    amplificationAfter: new Date(firstMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.subagentAmplification.horizonDays * 86_400_000).toISOString(),
    before: new Date(lastMs + 1).toISOString(),
  };
}

function readCurrentFacts(db, rootSessionId) {
  return db.prepare(`
    SELECT r.*, s.project_path, t.effort, t.sequence AS task_sequence,
           a.depth AS agent_depth, a.is_root AS agent_is_root
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    LEFT JOIN agents a
      ON a.root_session_id=r.root_session_id
     AND a.thread_id=r.thread_id
    WHERE r.root_session_id=?
    ORDER BY r.observed_at, r.request_id
  `).all(rootSessionId).map(mapFact);
}

function readRequestHistory(db, session, bounds) {
  return db.prepare(`
    WITH ranked AS (
      SELECT r.*, s.project_path, t.effort, t.sequence AS task_sequence,
             a.depth AS agent_depth, a.is_root AS agent_is_root,
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
      LEFT JOIN agents a
        ON a.root_session_id=r.root_session_id
       AND a.thread_id=r.thread_id
      WHERE s.project_path=?
        AND r.root_session_id<>?
        AND r.observed_at>=?
        AND r.observed_at<?
    )
    SELECT * FROM ranked
    WHERE cohort_rank<=?
    ORDER BY observed_at, root_session_id, request_id
  `).all(
    session.project_path,
    session.id,
    bounds.requestAfter,
    bounds.before,
    BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
  ).map(mapFact);
}

function readSessionHistory(db, session, bounds) {
  return db.prepare(`
    WITH slice_candidates AS (
      SELECT r.root_session_id, r.model, t.effort, MAX(r.observed_at) AS last_observed_at
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
    SELECT r.*, s.project_path, t.effort, t.sequence AS task_sequence,
           a.depth AS agent_depth, a.is_root AS agent_is_root
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    LEFT JOIN agents a
      ON a.root_session_id=r.root_session_id
     AND a.thread_id=r.thread_id
    INNER JOIN selected_slices selected
      ON selected.root_session_id=r.root_session_id
     AND selected.model=r.model
     AND selected.effort=t.effort
    WHERE s.project_path=?
      AND r.root_session_id<>?
      AND r.observed_at>=?
      AND r.observed_at<?
    ORDER BY r.observed_at, r.root_session_id, r.request_id
  `).all(
    session.project_path,
    session.id,
    bounds.burstAfter,
    bounds.before,
    BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.burst.maxSlicesPerCohort,
    session.project_path,
    session.id,
    bounds.burstAfter,
    bounds.before,
  ).map(mapFact);
}

function readAmplificationHistory(db, session, bounds) {
  return db.prepare(`
    WITH per_session AS (
      SELECT
        r.root_session_id,
        s.project_path,
        MAX(r.observed_at) AS observed_at,
        SUM(CASE WHEN a.is_root=1 THEN COALESCE(r.total_tokens, 0) ELSE 0 END) AS root_tokens,
        SUM(CASE WHEN a.depth>0 THEN COALESCE(r.total_tokens, 0) ELSE 0 END) AS descendant_tokens,
        SUM(CASE WHEN a.is_root=1 THEN 1 ELSE 0 END) AS root_requests,
        SUM(CASE WHEN a.depth>0 THEN 1 ELSE 0 END) AS descendant_requests,
        COUNT(DISTINCT CASE WHEN a.depth>0 THEN a.thread_id END) AS descendant_agents,
        MAX(CASE WHEN a.depth>0 THEN a.depth ELSE 0 END) AS max_depth
      FROM canonical_requests r
      JOIN sessions s ON s.id=r.root_session_id
      JOIN agents a
        ON a.root_session_id=r.root_session_id
       AND a.thread_id=r.thread_id
      WHERE s.project_path=?
        AND r.root_session_id<>?
        AND r.observed_at>=?
        AND r.observed_at<?
        AND r.classification IN ('verified_increment', 'generation_start')
      GROUP BY r.root_session_id, s.project_path
    )
    SELECT * FROM per_session
    WHERE root_tokens>0 AND descendant_tokens>0 AND root_requests>0 AND descendant_requests>0
    ORDER BY observed_at DESC, root_session_id DESC
    LIMIT ?
  `).all(
    session.project_path,
    session.id,
    bounds.amplificationAfter,
    bounds.before,
    BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.subagentAmplification.maxSessions,
  ).reverse().map((row) => ({
    rootSessionId: row.root_session_id,
    projectPath: row.project_path,
    observedAt: row.observed_at,
    rootTokens: Number(row.root_tokens ?? 0),
    descendantTokens: Number(row.descendant_tokens ?? 0),
    rootRequests: Number(row.root_requests ?? 0),
    descendantRequests: Number(row.descendant_requests ?? 0),
    descendantAgents: Number(row.descendant_agents ?? 0),
    maxDepth: Number(row.max_depth ?? 0),
    tokenRatio: Number(row.root_tokens ?? 0) > 0
      ? Number(row.descendant_tokens ?? 0) / Number(row.root_tokens)
      : null,
  }));
}

function mapFact(row) {
  return {
    requestId: row.request_id,
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    observedAt: row.observed_at,
    classification: row.classification,
    quality: row.quality,
    projectPath: row.project_path ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    agentDepth: row.agent_depth == null ? null : Number(row.agent_depth),
    isRootAgent: row.agent_is_root == null ? null : Boolean(row.agent_is_root),
    inScope: true,
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
