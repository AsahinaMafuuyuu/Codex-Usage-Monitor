import { createHash } from "node:crypto";

const VERIFIED_REQUEST_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);
const NUMERIC_EPSILON = 1e-12;

export const USAGE_DIAGNOSTICS_POLICY = Object.freeze({
  version: "usage-diagnostics-v1",
  baselineWindow: 5,
  minimumBaselineSamples: 3,
  contextInflation: Object.freeze({
    warningRatio: 1.35,
    warningAbsoluteTokens: 32_768,
    highRatio: 2,
    highAbsoluteTokens: 65_536,
  }),
  cacheRegression: Object.freeze({
    minimumInputTokens: 8_192,
    warningDrop: 0.20,
    highDrop: 0.40,
  }),
  costSpike: Object.freeze({
    warningRatio: 1.75,
    warningAbsoluteUsd: 0.05,
    highRatio: 3,
  }),
});

export function analyzeUsageDiagnostics(facts, policy = USAGE_DIAGNOSTICS_POLICY) {
  const orderedFacts = [...(facts ?? [])]
    .filter(isCanonicalDiagnosticFact)
    .sort(compareFacts);
  const contextTaskHistory = new Map();
  const contextSessionHistory = new Map();
  const cacheTaskHistory = new Map();
  const cacheSessionHistory = new Map();
  const cacheBreakpointSeen = new Set();
  const costTaskHistory = new Map();
  const costSessionHistory = new Map();
  const ordinalByTask = new Map();
  const findings = [];

  for (const fact of orderedFacts) {
    const taskIdentity = taskIdentityKey(fact);
    let requestOrdinalInScope = null;
    if (fact.inScope !== false) {
      requestOrdinalInScope = (ordinalByTask.get(taskIdentity) ?? 0) + 1;
      ordinalByTask.set(taskIdentity, requestOrdinalInScope);
    }

    const currentInput = finiteNonNegative(fact.usage?.inputTokens);
    if (currentInput != null) {
      const taskKey = comparableTaskKey(fact);
      const sessionKey = comparableSessionKey(fact);
      const taskHistory = historyFor(contextTaskHistory, taskKey);
      const sessionHistory = historyFor(contextSessionHistory, sessionKey);
      const baseline = chooseBaseline(taskHistory, sessionHistory, policy);
      if (baseline && fact.inScope !== false) {
        const finding = contextInflationFinding(
          fact,
          currentInput,
          baseline,
          requestOrdinalInScope,
          policy,
        );
        if (finding) findings.push(finding);
      }
      appendHistory(taskHistory, { requestId: fact.requestId, value: currentInput }, policy.baselineWindow);
      appendHistory(sessionHistory, { requestId: fact.requestId, value: currentInput }, policy.baselineWindow);

      const currentCacheHitRate = cacheHitRate(fact, policy);
      if (currentCacheHitRate != null) {
        const cacheTaskHistoryForKey = historyFor(cacheTaskHistory, taskKey);
        const cacheSessionHistoryForKey = historyFor(cacheSessionHistory, sessionKey);
        const cacheBaseline = chooseBaseline(
          cacheTaskHistoryForKey,
          cacheSessionHistoryForKey,
          policy,
        );
        if (cacheBaseline) {
          const cacheFinding = cacheRegressionFinding(
            fact,
            currentCacheHitRate,
            cacheBaseline,
            requestOrdinalInScope,
            taskKey,
            cacheBreakpointSeen,
            policy,
          );
          if (cacheFinding && fact.inScope !== false) findings.push(cacheFinding);
        }
        appendHistory(
          cacheTaskHistoryForKey,
          { requestId: fact.requestId, value: currentCacheHitRate },
          policy.baselineWindow,
        );
        appendHistory(
          cacheSessionHistoryForKey,
          { requestId: fact.requestId, value: currentCacheHitRate },
          policy.baselineWindow,
        );
      }
    }

    const currentCost = comparableCost(fact.costEstimate);
    if (currentCost != null) {
      const taskKey = comparableCostTaskKey(fact);
      const sessionKey = comparableCostSessionKey(fact);
      const taskHistory = historyFor(costTaskHistory, taskKey);
      const sessionHistory = historyFor(costSessionHistory, sessionKey);
      const selection = selectBaselineHistory(taskHistory, sessionHistory, policy);
      if (selection && fact.inScope !== false) {
        const costFinding = costSpikeFinding(
          fact,
          currentCost,
          selection,
          requestOrdinalInScope,
          policy,
        );
        if (costFinding) findings.push(costFinding);
      }
      const entry = {
        requestId: fact.requestId,
        value: currentCost,
        inputTokens: finiteNonNegative(fact.usage?.inputTokens),
        cacheHitRate: rawCacheHitRate(fact),
      };
      appendHistory(taskHistory, entry, policy.baselineWindow);
      appendHistory(sessionHistory, entry, policy.baselineWindow);
    }

    if (fact.inScope !== false && fact.costEstimate?.longContextCandidate === true) {
      findings.push(longContextFinding(fact, requestOrdinalInScope, policy));
    }
  }

  return {
    summary: summarizeFindings(findings),
    findings,
    policy: {
      version: policy.version,
      baselineWindow: policy.baselineWindow,
    },
  };
}

function longContextFinding(fact, requestOrdinalInScope, policy) {
  return findingBase(fact, "long_context_trigger", "info", requestOrdinalInScope, policy, {
    metric: {
      name: "long_context_candidate",
      current: true,
      baseline: null,
      absoluteDelta: null,
      relativeDelta: null,
    },
    baseline: {
      kind: "explicit_pricing_feature",
      sampleCount: 0,
      value: null,
      requestIds: [],
    },
    evidence: {
      inputTokens: finiteNonNegative(fact.usage?.inputTokens),
      longContextStatus: fact.costEstimate?.longContextStatus ?? "unknown",
      pricingStatus: fact.costEstimate?.status ?? "unavailable",
      serviceTier: fact.costEstimate?.serviceTier ?? fact.serviceTier ?? null,
      pricingPolicyVersion: fact.costEstimate?.policyVersion ?? null,
    },
  });
}

function costSpikeFinding(fact, current, selection, requestOrdinalInScope, policy) {
  const baseline = baselineFromHistory(selection.history, selection.kind);
  if (!(baseline.value > 0)) return null;
  const absoluteGrowth = current - baseline.value;
  const growthRatio = current / baseline.value;
  let severity = null;
  if (
    meetsRatio(current, baseline.value, policy.costSpike.highRatio) &&
    absoluteGrowth >= policy.costSpike.warningAbsoluteUsd
  ) {
    severity = "high";
  } else if (
    meetsRatio(current, baseline.value, policy.costSpike.warningRatio) &&
    absoluteGrowth >= policy.costSpike.warningAbsoluteUsd
  ) {
    severity = "warning";
  }
  if (!severity) return null;
  const currentInput = finiteNonNegative(fact.usage?.inputTokens);
  const baselineInput = medianFinite(selection.history.map((entry) => entry.inputTokens));
  const currentCacheHitRate = rawCacheHitRate(fact);
  const baselineCacheHitRate = medianFinite(selection.history.map((entry) => entry.cacheHitRate));
  return findingBase(fact, "cost_spike", severity, requestOrdinalInScope, policy, {
    metric: {
      name: "request_cost_usd",
      current,
      baseline: baseline.value,
      absoluteDelta: absoluteGrowth,
      relativeDelta: growthRatio - 1,
    },
    baseline,
    evidence: {
      inputDelta: currentInput != null && baselineInput != null ? currentInput - baselineInput : null,
      cacheHitDelta: currentCacheHitRate != null && baselineCacheHitRate != null
        ? currentCacheHitRate - baselineCacheHitRate
        : null,
      longContextStatus: fact.costEstimate?.longContextStatus ?? "unknown",
      serviceTier: fact.costEstimate?.serviceTier ?? fact.serviceTier ?? null,
      pricingStatus: fact.costEstimate?.status ?? "unavailable",
    },
  });
}

function cacheRegressionFinding(
  fact,
  current,
  baseline,
  requestOrdinalInScope,
  breakpointKey,
  breakpointSeen,
  policy,
) {
  const drop = baseline.value - current;
  let severity = null;
  if (drop + NUMERIC_EPSILON >= policy.cacheRegression.highDrop) severity = "high";
  else if (drop + NUMERIC_EPSILON >= policy.cacheRegression.warningDrop) severity = "warning";
  if (!severity) return null;
  const breakpointCandidate = !breakpointSeen.has(breakpointKey);
  if (breakpointCandidate) breakpointSeen.add(breakpointKey);
  return findingBase(fact, "cache_regression", severity, requestOrdinalInScope, policy, {
    metric: {
      name: "cache_hit_rate",
      current,
      baseline: baseline.value,
      absoluteDelta: current - baseline.value,
      relativeDelta: null,
    },
    baseline,
    evidence: {
      drop,
      breakpointCandidate,
    },
  });
}

function contextInflationFinding(fact, current, baseline, requestOrdinalInScope, policy) {
  if (!(baseline.value > 0)) return null;
  const absoluteGrowth = current - baseline.value;
  const growthRatio = current / baseline.value;
  let severity = null;
  if (
    meetsRatio(current, baseline.value, policy.contextInflation.highRatio) &&
    absoluteGrowth >= policy.contextInflation.highAbsoluteTokens
  ) {
    severity = "high";
  } else if (
    meetsRatio(current, baseline.value, policy.contextInflation.warningRatio) &&
    absoluteGrowth >= policy.contextInflation.warningAbsoluteTokens
  ) {
    severity = "warning";
  }
  if (!severity) return null;
  return findingBase(fact, "context_inflation", severity, requestOrdinalInScope, policy, {
    metric: {
      name: "input_tokens",
      current,
      baseline: baseline.value,
      absoluteDelta: absoluteGrowth,
      relativeDelta: growthRatio - 1,
    },
    baseline,
    evidence: {},
  });
}

function chooseBaseline(taskHistory, sessionHistory, policy) {
  const selection = selectBaselineHistory(taskHistory, sessionHistory, policy);
  return selection ? baselineFromHistory(selection.history, selection.kind) : null;
}

function selectBaselineHistory(taskHistory, sessionHistory, policy) {
  if (taskHistory.length >= policy.minimumBaselineSamples) {
    return { kind: "task_rolling_median", history: taskHistory };
  }
  if (sessionHistory.length >= policy.minimumBaselineSamples) {
    return { kind: "session_model_effort_rolling_median", history: sessionHistory };
  }
  return null;
}

function baselineFromHistory(history, kind) {
  return {
    kind,
    sampleCount: history.length,
    value: median(history.map((entry) => entry.value)),
    requestIds: history.map((entry) => entry.requestId),
  };
}

function findingBase(fact, type, severity, requestOrdinalInScope, policy, extra) {
  return {
    findingId: deterministicFindingId(policy.version, type, fact.requestId),
    type,
    severity,
    scope: "request",
    rootSessionId: fact.rootSessionId ?? null,
    threadId: fact.threadId,
    turnId: fact.turnId,
    requestId: fact.requestId,
    observedAt: fact.observedAt,
    locator: { requestOrdinalInScope },
    policyVersion: policy.version,
    ...extra,
  };
}

function summarizeFindings(findings) {
  const summary = { high: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (Object.hasOwn(summary, finding.severity)) summary[finding.severity] += 1;
  }
  return summary;
}

function deterministicFindingId(policyVersion, type, requestId) {
  return createHash("sha256")
    .update(`${policyVersion}\u0000${type}\u0000${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

function appendHistory(history, entry, window) {
  history.push(entry);
  if (history.length > window) history.splice(0, history.length - window);
}

function historyFor(map, key) {
  let history = map.get(key);
  if (!history) {
    history = [];
    map.set(key, history);
  }
  return history;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function meetsRatio(current, baseline, ratio) {
  return current + NUMERIC_EPSILON >= baseline * ratio;
}

function cacheHitRate(fact, policy) {
  const inputTokens = finiteNonNegative(fact.usage?.inputTokens);
  const cachedInputTokens = finiteNonNegative(fact.usage?.cachedInputTokens);
  if (
    inputTokens == null ||
    cachedInputTokens == null ||
    inputTokens < policy.cacheRegression.minimumInputTokens ||
    cachedInputTokens > inputTokens
  ) {
    return null;
  }
  return cachedInputTokens / inputTokens;
}

function rawCacheHitRate(fact) {
  const inputTokens = finiteNonNegative(fact.usage?.inputTokens);
  const cachedInputTokens = finiteNonNegative(fact.usage?.cachedInputTokens);
  if (inputTokens == null || inputTokens <= 0 || cachedInputTokens == null || cachedInputTokens > inputTokens) {
    return null;
  }
  return cachedInputTokens / inputTokens;
}

function comparableCost(costEstimate) {
  if (costEstimate?.status !== "estimated") return null;
  return finiteNonNegative(costEstimate?.amountUsd);
}

function medianFinite(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? median(finite) : null;
}

function isCanonicalDiagnosticFact(fact) {
  return Boolean(
    fact?.requestId &&
    fact?.threadId &&
    fact?.turnId &&
    VERIFIED_REQUEST_CLASSIFICATIONS.has(fact?.classification),
  );
}

function compareFacts(left, right) {
  const timeOrder = String(left.observedAt ?? "").localeCompare(String(right.observedAt ?? ""));
  if (timeOrder !== 0) return timeOrder;
  return String(left.requestId).localeCompare(String(right.requestId));
}

function taskIdentityKey(fact) {
  return `${fact.threadId}\u0000${fact.turnId}`;
}

function comparableTaskKey(fact) {
  return `${taskIdentityKey(fact)}\u0000${fact.model ?? ""}`;
}

function comparableSessionKey(fact) {
  return `${fact.model ?? ""}\u0000${fact.effort ?? ""}`;
}

function comparableCostTaskKey(fact) {
  return `${comparableTaskKey(fact)}\u0000${fact.costEstimate?.serviceTier ?? fact.serviceTier ?? ""}`;
}

function comparableCostSessionKey(fact) {
  return `${comparableSessionKey(fact)}\u0000${fact.costEstimate?.serviceTier ?? fact.serviceTier ?? ""}`;
}
