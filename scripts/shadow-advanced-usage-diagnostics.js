import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  ADVANCED_USAGE_DIAGNOSTICS_POLICY,
  analyzeAdvancedUsageDiagnostics,
} from "../src/advanced-diagnostics.js";
import { analyzeUsageDiagnostics } from "../src/diagnostics.js";
import { estimateRequestCost } from "../src/pricing.js";
import { resolveDatabasePath } from "../src/server.js";

const databaseArgument = readArgument("--database");
const debugIds = process.argv.includes("--debug-ids");
const databasePath = resolveDatabasePath(databaseArgument);
if (!existsSync(databasePath)) throw new Error(`Advanced diagnostics database not found: ${databasePath}`);

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON;");
  const sessions = db.prepare(`
    SELECT id, project_path
    FROM sessions
    WHERE parse_status!='not_imported' AND project_path IS NOT NULL AND project_path!=''
    ORDER BY COALESCE(updated_at, created_at), id
  `).all();
  const currentStatement = db.prepare(diagnosticFactsSql("r.root_session_id=?"));
  const historicalStatement = db.prepare(diagnosticFactsSql(`
    s.project_path=?
    AND r.root_session_id<>?
    AND r.observed_at>=?
    AND r.observed_at<?
  `));

  const reports = [];
  let totalRequests = 0;
  let localFindingRequests = new Set();
  for (const session of sessions) {
    const currentFacts = currentStatement.all(session.id).map(mapFact);
    if (!currentFacts.length) continue;
    const timestamps = currentFacts.map((fact) => Date.parse(fact.observedAt)).filter(Number.isFinite);
    if (!timestamps.length) continue;
    const firstMs = Math.min(...timestamps);
    const lastMs = Math.max(...timestamps);
    const historyAfter = new Date(firstMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.horizonDays * 86_400_000).toISOString();
    const historyBefore = new Date(lastMs + 1).toISOString();
    const historicalAll = historicalStatement
      .all(session.project_path, session.id, historyAfter, historyBefore)
      .map(mapFact);
    const requestAfterMs = firstMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays * 86_400_000;
    const historicalFacts = capRequestHistory(
      historicalAll.filter((fact) => Date.parse(fact.observedAt) >= requestAfterMs),
      ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
    );
    const enrichedCurrent = enrich(currentFacts);
    const report = analyzeAdvancedUsageDiagnostics({
      currentFacts: enrichedCurrent,
      historicalFacts: enrich(historicalFacts),
      historicalSessionFacts: enrich(historicalAll),
      scope: { type: "session" },
    });
    const localReport = analyzeUsageDiagnostics(enrichedCurrent);
    for (const finding of localReport.findings) {
      if (finding.requestId) localFindingRequests.add(`${session.id}\u0000${finding.requestId}`);
    }
    totalRequests += currentFacts.length;
    reports.push({ session, requestCount: currentFacts.length, report });
  }

  const candidates = reports.flatMap(({ session, report }) => report.candidates.map((candidate) => ({
    ...candidate,
    rootSessionId: candidate.subject?.rootSessionId ?? session.id,
  })));
  const shadowFindings = candidates.filter((candidate) => candidate.shadowSeverity);
  const requestCandidates = candidates.filter((candidate) => candidate.requestId);
  const affectedRequests = new Set(requestCandidates.map((candidate) => `${candidate.rootSessionId}\u0000${candidate.requestId}`));
  const shadowAffectedRequests = new Set(
    shadowFindings
      .filter((candidate) => candidate.requestId)
      .map((candidate) => `${candidate.rootSessionId}\u0000${candidate.requestId}`),
  );
  const overlapRequests = new Set([...affectedRequests].filter((key) => localFindingRequests.has(key)));
  const coverage = sumCoverage(reports.map(({ report }) => report.coverage));

  console.log(JSON.stringify({
    policy: ADVANCED_USAGE_DIAGNOSTICS_POLICY,
    sessionsAnalyzed: reports.length,
    totalRequests,
    candidateCount: candidates.length,
    candidatesPer100Requests: per100(candidates.length, totalRequests),
    shadowFindingCount: shadowFindings.length,
    shadowFindingsPer100Requests: per100(shadowFindings.length, totalRequests),
    shadowAffectedRequestCount: shadowAffectedRequests.size,
    shadowAffectedRequestsPer100: per100(shadowAffectedRequests.size, totalRequests),
    affectedRequestCount: affectedRequests.size,
    affectedRequestsPer100: per100(affectedRequests.size, totalRequests),
    coverage,
    byType: groupCount(candidates, (candidate) => candidate.type),
    shadowBySeverity: groupCount(shadowFindings, (candidate) => candidate.shadowSeverity),
    shadowByTypeSeverity: groupCount(
      shadowFindings,
      (candidate) => `${candidate.type}:${candidate.shadowSeverity}`,
    ),
    robustZDistribution: metricDistribution(candidates, (candidate) => candidate.baseline?.robustZ),
    effectAbsoluteDistribution: metricDistribution(candidates, (candidate) => candidate.effect?.absolute),
    effectRatioDistribution: metricDistribution(candidates, (candidate) => candidate.effect?.ratio),
    effectPercentagePointDistribution: metricDistribution(candidates, (candidate) => candidate.effect?.percentagePoints),
    v1Overlap: {
      localFindingRequestCount: localFindingRequests.size,
      advancedCandidateRequestCount: affectedRequests.size,
      overlapRequestCount: overlapRequests.size,
      advancedOverlapRatio: affectedRequests.size ? round(overlapRequests.size / affectedRequests.size) : 0,
    },
    topCohorts: topCohorts(candidates),
    thresholdAdjacentFindings: [...shadowFindings]
      .filter((candidate) => Number.isFinite(candidate.baseline?.robustZ))
      .sort((left, right) => thresholdDistance(left) - thresholdDistance(right))
      .slice(0, 20)
      .map((candidate) => summarizeCandidate(candidate, debugIds)),
    topOutliers: [...candidates]
      .filter((candidate) => Number.isFinite(candidate.baseline?.robustZ))
      .sort((left, right) => Math.abs(right.baseline.robustZ) - Math.abs(left.baseline.robustZ))
      .slice(0, 30)
      .map((candidate) => summarizeCandidate(candidate, debugIds)),
  }, null, 2));
} finally {
  db.close();
}

function thresholdDistance(candidate) {
  return Math.abs(Math.abs(candidate.baseline?.robustZ ?? 0) - ADVANCED_USAGE_DIAGNOSTICS_POLICY.robustZ.warningCandidate);
}

function summarizeCandidate(candidate, debugIds) {
  return {
    type: candidate.type,
    severity: candidate.shadowSeverity ?? null,
    robustZ: round(candidate.baseline.robustZ),
    effect: candidate.effect,
    sampleCount: candidate.baseline.sampleCount,
    cohort: redactCohort(candidate.cohort),
    ...(debugIds ? {
      rootSessionId: candidate.rootSessionId,
      requestId: candidate.requestId ?? null,
    } : {}),
  };
}

function diagnosticFactsSql(whereClause) {
  return `
    SELECT
      r.request_id, r.root_session_id, r.thread_id, r.turn_id, r.event_ordinal,
      r.observed_at, r.generation, r.classification, r.quality, r.reason,
      r.input_tokens, r.cached_input_tokens, r.cache_write_input_tokens,
      r.output_tokens, r.reasoning_output_tokens, r.total_tokens,
      r.model, r.service_tier, r.pricing_context_quality,
      s.project_path, t.effort, t.sequence AS task_sequence
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    WHERE ${whereClause}
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

function capRequestHistory(facts, maxSamplesPerCohort) {
  const groups = new Map();
  for (const fact of facts) {
    const key = JSON.stringify([fact.projectPath, fact.model, fact.effort]);
    const values = groups.get(key) ?? [];
    values.push(fact);
    groups.set(key, values);
  }
  return [...groups.values()].flatMap((values) => values.slice(-maxSamplesPerCohort));
}

function sumCoverage(items) {
  const output = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item ?? {})) {
      output[key] = (output[key] ?? 0) + Number(value ?? 0);
    }
  }
  return output;
}

function metricDistribution(candidates, valueOf) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const value = valueOf(candidate);
    if (!Number.isFinite(value)) continue;
    const values = grouped.get(candidate.type) ?? [];
    values.push(value);
    grouped.set(candidate.type, values);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, values]) => [
    type,
    distribution(values),
  ]));
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.50)),
    p90: round(percentile(sorted, 0.90)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)),
  };
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index];
}

function topCohorts(candidates) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      projectHash(candidate.cohort?.projectPath),
      candidate.cohort?.model ?? null,
      candidate.cohort?.effort ?? null,
    ]);
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .map(([key, count]) => {
      const [project, model, effort] = JSON.parse(key);
      return { project, model, effort, count };
    })
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);
}

function redactCohort(cohort) {
  return {
    project: projectHash(cohort?.projectPath),
    model: cohort?.model ?? null,
    effort: cohort?.effort ?? null,
    serviceTier: cohort?.serviceTier ?? null,
    rateVersion: cohort?.rateVersion ?? null,
  };
}

function projectHash(projectPath) {
  if (!projectPath) return null;
  return `project-${createHash("sha256").update(projectPath).digest("hex").slice(0, 10)}`;
}

function groupCount(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function per100(count, total) {
  return total > 0 ? round((count / total) * 100) : 0;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function numberOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
