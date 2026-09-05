import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { analyzeUsageDiagnostics, USAGE_DIAGNOSTICS_POLICY } from "../src/diagnostics.js";
import { estimateRequestCost } from "../src/pricing.js";
import { resolveDatabasePath } from "../src/server.js";

const databaseArgument = readArgument("--database");
const databasePath = resolveDatabasePath(databaseArgument);
if (!existsSync(databasePath)) throw new Error(`Diagnostics database not found: ${databasePath}`);

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON;");
  const sessions = db.prepare(`
    SELECT id
    FROM sessions
    WHERE parse_status!='not_imported'
    ORDER BY id
  `).all();
  const sessionReports = [];
  let totalRequests = 0;
  for (const session of sessions) {
    const facts = readDiagnosticFacts(db, session.id);
    if (!facts.length) continue;
    totalRequests += facts.length;
    const enriched = facts.map((fact) => ({
      ...fact,
      costEstimate: estimateRequestCost(fact),
    }));
    const report = analyzeUsageDiagnostics(enriched);
    sessionReports.push({
      sessionId: session.id,
      requestCount: facts.length,
      summary: report.summary,
      findings: report.findings,
    });
  }

  const findings = sessionReports.flatMap((report) => report.findings.map((finding) => ({
    ...finding,
    rootSessionId: finding.rootSessionId ?? report.sessionId,
  })));
  const affectedRequests = new Set(
    findings.map((finding) => `${finding.rootSessionId ?? ""}\u0000${finding.requestId ?? ""}`),
  );
  const byType = groupCount(findings, (finding) => finding.type);
  const bySeverity = groupCount(findings, (finding) => finding.severity);
  const byTypeSeverity = groupCount(findings, (finding) => `${finding.type}:${finding.severity}`);
  const topAffectedSessions = sessionReports
    .map((report) => ({
      sessionId: report.sessionId,
      requestCount: report.requestCount,
      findingCount: report.findings.length,
      findingsPer100Requests: per100(report.findings.length, report.requestCount),
      summary: report.summary,
    }))
    .filter((report) => report.findingCount > 0)
    .sort((left, right) => right.findingCount - left.findingCount || right.findingsPer100Requests - left.findingsPer100Requests)
    .slice(0, 20);

  console.log(JSON.stringify({
    policy: {
      version: USAGE_DIAGNOSTICS_POLICY.version,
      baselineWindow: USAGE_DIAGNOSTICS_POLICY.baselineWindow,
      minimumBaselineSamples: USAGE_DIAGNOSTICS_POLICY.minimumBaselineSamples,
    },
    sessionsAnalyzed: sessionReports.length,
    totalRequests,
    findingCount: findings.length,
    findingsPer100Requests: per100(findings.length, totalRequests),
    affectedRequestCount: affectedRequests.size,
    affectedRequestsPer100: per100(affectedRequests.size, totalRequests),
    byType,
    bySeverity,
    byTypeSeverity,
    deltaDistribution: buildDeltaDistribution(findings),
    topAffectedSessions,
  }, null, 2));
} finally {
  db.close();
}

function readDiagnosticFacts(db, rootSessionId) {
  return db.prepare(`
    SELECT
      r.request_id,
      r.root_session_id,
      r.thread_id,
      r.turn_id,
      r.observed_at,
      r.classification,
      r.quality,
      r.input_tokens,
      r.cached_input_tokens,
      r.cache_write_input_tokens,
      r.output_tokens,
      r.reasoning_output_tokens,
      r.total_tokens,
      r.model,
      r.service_tier,
      r.pricing_context_quality,
      t.effort
    FROM canonical_requests r
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    WHERE r.root_session_id=?
    ORDER BY r.observed_at, r.request_id
  `).all(rootSessionId).map((row) => ({
    requestId: row.request_id,
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    observedAt: row.observed_at,
    classification: row.classification,
    quality: row.quality,
    model: row.model ?? null,
    effort: row.effort ?? null,
    serviceTier: row.service_tier ?? null,
    pricingContextQuality: row.pricing_context_quality ?? null,
    inScope: true,
    usage: {
      inputTokens: numberOrNull(row.input_tokens),
      cachedInputTokens: numberOrNull(row.cached_input_tokens),
      cacheWriteInputTokens: numberOrNull(row.cache_write_input_tokens),
      outputTokens: numberOrNull(row.output_tokens),
      reasoningOutputTokens: numberOrNull(row.reasoning_output_tokens),
      totalTokens: numberOrNull(row.total_tokens),
    },
  }));
}

function buildDeltaDistribution(findings) {
  const metrics = new Map();
  for (const finding of findings) {
    const value = diagnosticMagnitude(finding);
    if (!Number.isFinite(value)) continue;
    const values = metrics.get(finding.type) ?? [];
    values.push(value);
    metrics.set(finding.type, values);
  }
  return Object.fromEntries([...metrics.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, values]) => [
    type,
    distribution(values),
  ]));
}

function diagnosticMagnitude(finding) {
  if (finding.type === "context_inflation") return finding.metric?.relativeDelta;
  if (finding.type === "cache_regression") return finding.evidence?.drop;
  if (finding.type === "cost_spike") return finding.metric?.relativeDelta;
  if (finding.type === "long_context_trigger") return finding.evidence?.inputTokens;
  return null;
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.50),
    p90: percentile(sorted, 0.90),
    max: sorted.at(-1) ?? null,
  };
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index];
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
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0;
}

function numberOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
