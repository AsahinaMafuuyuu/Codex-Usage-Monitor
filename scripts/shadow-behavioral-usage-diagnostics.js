import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
  analyzeBehavioralUsageDiagnostics,
} from "../src/behavioral-diagnostics.js";
import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Behavioral diagnostics database not found: ${databasePath}`);
const debugIds = process.argv.includes("--debug-ids");
const db = new DatabaseSync(databasePath, { readOnly: true });

try {
  db.exec("PRAGMA query_only=ON;");
  const facts = db.prepare(`
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
      s.project_path,
      t.effort,
      a.depth AS agent_depth,
      a.is_root AS agent_is_root
    FROM canonical_requests r
    JOIN sessions s ON s.id=r.root_session_id
    LEFT JOIN tasks t
      ON t.root_session_id=r.root_session_id
     AND t.thread_id=r.thread_id
     AND t.turn_id=r.turn_id
    LEFT JOIN agents a
      ON a.root_session_id=r.root_session_id
     AND a.thread_id=r.thread_id
    WHERE r.classification IN ('verified_increment', 'generation_start')
    ORDER BY r.observed_at, r.root_session_id, r.request_id
  `).all().map(mapFact);
  const bySession = groupBy(facts, (fact) => fact.rootSessionId);
  const byProject = groupBy(facts, (fact) => fact.projectPath ?? "");
  const amplificationSamples = buildAmplificationSamples(bySession);
  const amplificationByProject = groupBy(amplificationSamples, (sample) => sample.projectPath ?? "");
  const reports = [];
  let totalRequests = 0;

  for (const [sessionId, currentFacts] of bySession) {
    if (!currentFacts.length) continue;
    const projectPath = currentFacts.find((fact) => fact.projectPath)?.projectPath ?? null;
    if (!projectPath) continue;
    const projectFacts = byProject.get(projectPath) ?? [];
    const observed = currentFacts.map((fact) => Date.parse(fact.observedAt)).filter(Number.isFinite);
    if (!observed.length) continue;
    const currentStartMs = Math.min(...observed);
    const currentEndMs = Math.max(...observed);
    const historyStartMs = currentStartMs - Math.max(
      BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays,
      BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.burst.horizonDays,
    ) * 86_400_000;
    const historicalFacts = projectFacts.filter((fact) =>
      fact.rootSessionId !== sessionId &&
      Date.parse(fact.observedAt) >= historyStartMs &&
      Date.parse(fact.observedAt) < currentEndMs + 1
    );
    const report = analyzeBehavioralUsageDiagnostics({
      currentFacts,
      historicalFacts,
      historicalSessionFacts: historicalFacts,
      historicalAmplificationSamples: amplificationByProject.get(projectPath) ?? [],
      scope: { type: "session" },
    });
    totalRequests += currentFacts.length;
    reports.push({ sessionId, projectPath, requestCount: currentFacts.length, report });
  }

  const candidates = reports.flatMap(({ sessionId, projectPath, report }) => report.candidates.map((candidate) => ({
    ...candidate,
    rootSessionId: candidate.rootSessionId ?? candidate.subject?.rootSessionId ?? sessionId,
    projectPath,
  })));
  const shadowFindings = candidates.filter((candidate) => candidate.shadowSeverity);
  const requestFindings = shadowFindings.filter((candidate) => candidate.requestId);
  const affectedRequests = new Set(requestFindings.map((candidate) => `${candidate.rootSessionId}\u0000${candidate.requestId}`));
  const affectedSessions = new Set(shadowFindings.map((candidate) => candidate.rootSessionId));

  console.log(JSON.stringify({
    policy: BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
    sessionsAnalyzed: reports.length,
    totalRequests,
    candidateCount: candidates.length,
    shadowFindingCount: shadowFindings.length,
    shadowFindingsPer100Requests: per100(shadowFindings.length, totalRequests),
    shadowAffectedRequestCount: affectedRequests.size,
    shadowAffectedRequestsPer100: per100(affectedRequests.size, totalRequests),
    shadowAffectedSessionCount: affectedSessions.size,
    coverage: sumCoverage(reports.map(({ report }) => report.coverage)),
    byType: groupCount(candidates, (candidate) => candidate.type),
    shadowBySeverity: groupCount(shadowFindings, (candidate) => candidate.shadowSeverity),
    shadowByTypeSeverity: groupCount(shadowFindings, (candidate) => `${candidate.type}:${candidate.shadowSeverity}`),
    robustZDistribution: metricDistribution(candidates, (candidate) => candidate.baseline?.robustZ),
    effectAbsoluteDistribution: metricDistribution(candidates, (candidate) => candidate.effect?.absolute),
    effectRatioDistribution: metricDistribution(candidates, (candidate) => candidate.effect?.ratio),
    detectorMetricDistribution: metricDistribution(candidates, (candidate) => candidate.metric?.current),
    thresholdAdjacentFindings: shadowFindings
      .filter((candidate) => Number.isFinite(candidate.baseline?.robustZ))
      .sort((left, right) => thresholdDistance(left) - thresholdDistance(right))
      .slice(0, 12)
      .map((candidate) => summarizeCandidate(candidate, debugIds)),
    topOutliers: shadowFindings
      .filter((candidate) => Number.isFinite(candidate.baseline?.robustZ))
      .sort((left, right) => Math.abs(right.baseline.robustZ) - Math.abs(left.baseline.robustZ))
      .slice(0, 20)
      .map((candidate) => summarizeCandidate(candidate, debugIds)),
    topCandidatesByType: Object.fromEntries(
      [...new Set(candidates.map((candidate) => candidate.type))]
        .sort()
        .map((type) => [
          type,
          candidates
            .filter((candidate) => candidate.type === type && Number.isFinite(candidate.baseline?.robustZ))
            .sort((left, right) => Math.abs(right.baseline.robustZ) - Math.abs(left.baseline.robustZ))
            .slice(0, 5)
            .map((candidate) => summarizeCandidate(candidate, debugIds)),
        ]),
    ),
    topProjects: topProjects(shadowFindings),
  }, null, 2));
} finally {
  db.close();
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

function buildAmplificationSamples(bySession) {
  const samples = [];
  for (const [rootSessionId, facts] of bySession) {
    let rootTokens = 0;
    let descendantTokens = 0;
    let rootRequests = 0;
    let descendantRequests = 0;
    let maxDepth = 0;
    const descendantAgents = new Set();
    for (const fact of facts) {
      const total = numberOrNull(fact.usage?.totalTokens);
      const depth = Number(fact.agentDepth);
      if (total == null || !Number.isFinite(depth)) continue;
      if (fact.isRootAgent === true || depth === 0) {
        rootTokens += total;
        rootRequests += 1;
      } else if (depth > 0) {
        descendantTokens += total;
        descendantRequests += 1;
        descendantAgents.add(fact.threadId);
        maxDepth = Math.max(maxDepth, depth);
      }
    }
    if (rootTokens <= 0 || descendantTokens <= 0 || rootRequests <= 0 || descendantRequests <= 0) continue;
    samples.push({
      rootSessionId,
      projectPath: facts.find((fact) => fact.projectPath)?.projectPath ?? null,
      observedAt: facts.at(-1)?.observedAt ?? null,
      tokenRatio: descendantTokens / rootTokens,
      rootTokens,
      descendantTokens,
      rootRequests,
      descendantRequests,
      descendantAgents: descendantAgents.size,
      maxDepth,
    });
  }
  return samples;
}

function summarizeCandidate(candidate, debugIds) {
  return {
    type: candidate.type,
    severity: candidate.shadowSeverity,
    robustZ: round(candidate.baseline?.robustZ),
    metric: round(candidate.metric?.current),
    effect: roundEffect(candidate.effect),
    sampleCount: candidate.baseline?.sampleCount ?? null,
    cohort: {
      project: redactProject(candidate.cohort?.projectPath ?? candidate.projectPath),
      model: candidate.cohort?.model ?? null,
      effort: candidate.cohort?.effort ?? null,
    },
    evidence: summarizeEvidence(candidate),
    ...(debugIds ? {
      rootSessionId: candidate.rootSessionId,
      requestId: candidate.requestId ?? candidate.supportingLocator?.requestId ?? null,
    } : {}),
  };
}

function summarizeEvidence(candidate) {
  if (candidate.type === "reasoning_anomaly") return {
    reasoningOutputTokens: candidate.evidence?.reasoningOutputTokens ?? null,
    outputTokens: candidate.evidence?.outputTokens ?? null,
    reasoningTokenDelta: candidate.evidence?.reasoningTokenDelta ?? null,
  };
  if (candidate.type === "request_burst") return {
    requestCount: candidate.evidence?.requestCount ?? null,
    windowMs: candidate.evidence?.windowMs ?? null,
  };
  if (candidate.type === "subagent_amplification") return {
    descendantExtraTokens: candidate.evidence?.descendantExtraTokens ?? null,
    descendantRequests: candidate.evidence?.descendantRequests ?? null,
    descendantAgents: candidate.evidence?.descendantAgents ?? null,
    maxDepth: candidate.evidence?.maxDepth ?? null,
  };
  return null;
}

function thresholdDistance(candidate) {
  const z = Math.abs(Number(candidate.baseline?.robustZ));
  if (!Number.isFinite(z)) return Number.POSITIVE_INFINITY;
  return Math.min(
    Math.abs(z - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.robustZ.warningCandidate),
    Math.abs(z - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.robustZ.highCandidate),
  );
}

function topProjects(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const project = redactProject(finding.cohort?.projectPath ?? finding.projectPath);
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([project, count]) => ({ project, count }))
    .sort((left, right) => right.count - left.count || left.project.localeCompare(right.project))
    .slice(0, 20);
}

function metricDistribution(items, valueOf) {
  const byType = new Map();
  for (const item of items) {
    const value = Number(valueOf(item));
    if (!Number.isFinite(value)) continue;
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(value);
  }
  return Object.fromEntries([...byType.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, values]) => [
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

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function sumCoverage(items) {
  const totals = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item ?? {})) totals[key] = (totals[key] ?? 0) + Number(value ?? 0);
  }
  return totals;
}

function groupCount(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function redactProject(projectPath) {
  if (!projectPath) return "project-unknown";
  return `project-${createHash("sha256").update(projectPath).digest("hex").slice(0, 10)}`;
}

function roundEffect(effect) {
  if (!effect) return null;
  return Object.fromEntries(Object.entries(effect).map(([key, value]) => [key, round(value)]));
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1_000_000) / 1_000_000 : null;
}

function per100(count, total) {
  return total > 0 ? Math.round((count / total) * 10_000) / 100 : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
