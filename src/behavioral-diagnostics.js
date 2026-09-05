import { createHash } from "node:crypto";

const ROBUST_Z_SCALE = 0.67448975;
const EPSILON = 1e-12;
const DAY_MS = 86_400_000;
const VERIFIED_REQUEST_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export const BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY = Object.freeze({
  version: "behavioral-usage-diagnostics-v1",
  frozen: true,
  requestHistory: Object.freeze({
    horizonDays: 30,
    maxSamplesPerCohort: 200,
    minimumSamples: 20,
  }),
  robustZ: Object.freeze({
    warningCandidate: 3.5,
    highCandidate: 5,
  }),
  reasoning: Object.freeze({
    minimumOutputTokens: 128,
    warningShareIncrease: 0.20,
    highShareIncrease: 0.35,
    warningReasoningTokens: 512,
    highReasoningTokens: 1_024,
  }),
  burst: Object.freeze({
    horizonDays: 60,
    maxSlicesPerCohort: 20,
    minimumSlices: 10,
    minimumCurrentRequests: 10,
    windowMs: 60_000,
    idleGapMs: 120_000,
    warningRequestCount: 15,
    warningRatio: 1.5,
    highRequestCount: 30,
    highRatio: 2,
  }),
  subagentAmplification: Object.freeze({
    horizonDays: 90,
    maxSessions: 20,
    minimumSamples: 5,
    warningTokenRatio: 1.25,
    warningRatioGrowth: 2,
    warningExtraTokens: 5_000_000,
    warningDescendantRequests: 50,
    highTokenRatio: 4,
    highRatioGrowth: 2,
    highExtraTokens: 5_000_000,
    highDescendantRequests: 50,
  }),
});

export function analyzeBehavioralUsageDiagnostics(
  dataset,
  policy = BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
) {
  const currentFacts = [...(dataset?.currentFacts ?? [])]
    .filter(isEligibleRequestFact)
    .sort(compareFacts);
  const historicalFacts = [...(dataset?.historicalFacts ?? [])]
    .filter(isEligibleRequestFact)
    .sort(compareFacts);
  const historicalSessionFacts = [...(dataset?.historicalSessionFacts ?? historicalFacts)]
    .filter(isEligibleRequestFact)
    .sort(compareFacts);
  const historicalAmplificationSamples = [...(dataset?.historicalAmplificationSamples ?? [])]
    .filter(isValidAmplificationSample)
    .sort(compareAmplificationSamples);
  const scope = dataset?.scope?.type === "day" ? dataset.scope : { type: "session" };
  const candidates = [];
  const coverage = {
    reasoningIneligible: 0,
    unknownEffort: 0,
    insufficientReasoningHistory: 0,
    insufficientBurstHistory: 0,
    insufficientAmplificationHistory: 0,
    noLineage: 0,
    degenerateMad: 0,
  };

  const ordinals = requestOrdinals(currentFacts);
  appendReasoningCandidates(
    candidates,
    coverage,
    currentFacts,
    historicalFacts,
    ordinals,
    policy,
  );
  if (scope.type === "session") {
    appendBurstCandidates(
      candidates,
      coverage,
      currentFacts,
      historicalSessionFacts,
      ordinals,
      policy,
    );
    appendSubagentAmplificationCandidate(
      candidates,
      coverage,
      currentFacts,
      historicalAmplificationSamples,
      ordinals,
      policy,
    );
  }

  for (const candidate of candidates) candidate.shadowSeverity = candidateSeverity(candidate, policy);
  const findings = policy.frozen === true
    ? candidates
        .filter((candidate) => candidate.shadowSeverity && (candidate.family !== "behavioral_request" || candidate.inScope !== false))
        .map((candidate) => materializeFinding(candidate, policy))
    : [];
  return {
    policy: { version: policy.version, frozen: policy.frozen === true },
    coverage,
    candidates,
    findings,
    summary: summarizeFindings(findings),
  };
}

function appendReasoningCandidates(candidates, coverage, currentFacts, historicalFacts, ordinals, policy) {
  const historicalByCohort = buildReasoningHistoryIndex(
    historicalFacts,
    policy.reasoning.minimumOutputTokens,
  );
  const baselineCache = new Map();
  for (const current of currentFacts) {
    if (!current.effort) {
      coverage.unknownEffort += 1;
      continue;
    }
    if (!hasStrictCohort(current)) continue;
    const currentMetric = reasoningMetric(current, policy.reasoning.minimumOutputTokens);
    if (!currentMetric) {
      coverage.reasoningIneligible += 1;
      continue;
    }
    const observedMs = Date.parse(current.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const horizonStart = observedMs - policy.requestHistory.horizonDays * DAY_MS;
    const cohortKey = strictCohortKey(current);
    const entries = historicalByCohort.get(cohortKey) ?? [];
    const range = historicalRange(entries, horizonStart, observedMs);
    const sampleSet = reasoningSampleSet({
      cache: baselineCache,
      cacheKey: JSON.stringify([
        cohortKey,
        range.start,
        range.end,
        current.rootSessionId,
      ]),
      entries,
      range,
      currentRootSessionId: current.rootSessionId,
      maxSamples: policy.requestHistory.maxSamplesPerCohort,
    });
    if (sampleSet.shareSamples.length < policy.requestHistory.minimumSamples) {
      coverage.insufficientReasoningHistory += 1;
      continue;
    }
    const baseline = sampleSet.baseline;
    if (baseline.status === "degenerate") coverage.degenerateMad += 1;
    candidates.push({
      family: "behavioral_request",
      type: "reasoning_anomaly",
      requestId: current.requestId,
      rootSessionId: current.rootSessionId,
      observedAt: current.observedAt,
      inScope: current.inScope !== false,
      subject: {
        kind: "request",
        rootSessionId: current.rootSessionId,
        requestId: current.requestId,
      },
      cohort: {
        projectPath: current.projectPath,
        model: current.model,
        effort: current.effort,
      },
      baseline: {
        kind: "historical_reasoning_share_robust",
        sampleCount: sampleSet.shareSamples.length,
        median: baseline.median,
        mad: baseline.mad,
        robustZ: baseline.status === "ready"
          ? ROBUST_Z_SCALE * (currentMetric.share - baseline.median) / baseline.mad
          : null,
        status: baseline.status,
      },
      metric: {
        name: "reasoning_output_share",
        current: currentMetric.share,
      },
      effect: {
        absolute: currentMetric.share - baseline.median,
        ratio: baseline.median > 0 ? currentMetric.share / baseline.median : null,
        percentagePoints: currentMetric.share - baseline.median,
      },
      evidence: {
        outputTokens: currentMetric.outputTokens,
        reasoningOutputTokens: currentMetric.reasoningTokens,
        historicalReasoningTokensMedian: sampleSet.reasoningTokenMedian,
        reasoningTokenDelta: currentMetric.reasoningTokens - sampleSet.reasoningTokenMedian,
      },
      locator: requestLocator(current, ordinals.get(current.requestId)),
    });
  }
}

function appendBurstCandidates(candidates, coverage, currentFacts, historicalFacts, ordinals, policy) {
  const currentSlices = buildBurstSlices(currentFacts, policy);
  const historicalSlices = buildBurstSlices(historicalFacts, policy);
  for (const current of currentSlices) {
    if (current.requestCount < policy.burst.minimumCurrentRequests) continue;
    const currentStartMs = Date.parse(current.firstObservedAt);
    if (!Number.isFinite(currentStartMs)) continue;
    const horizonStart = currentStartMs - policy.burst.horizonDays * DAY_MS;
    const prior = historicalSlices
      .filter((slice) =>
        slice.rootSessionId !== current.rootSessionId &&
        slice.projectPath === current.projectPath &&
        slice.model === current.model &&
        slice.effort === current.effort &&
        Date.parse(slice.lastObservedAt) >= horizonStart &&
        Date.parse(slice.lastObservedAt) < currentStartMs
      )
      .sort((left, right) => compareIso(left.lastObservedAt, right.lastObservedAt))
      .slice(-policy.burst.maxSlicesPerCohort);
    if (prior.length < policy.burst.minimumSlices) {
      coverage.insufficientBurstHistory += 1;
      continue;
    }
    const samples = prior.map((slice) => slice.maxRequestsInWindow);
    const baseline = robustBaseline(samples);
    if (baseline.status === "degenerate") coverage.degenerateMad += 1;
    const supportingFact = current.supportingFact;
    candidates.push({
      family: "behavioral_session",
      type: "request_burst",
      rootSessionId: current.rootSessionId,
      observedAt: current.supportingWindowEnd,
      subject: {
        kind: "session_cohort_slice",
        rootSessionId: current.rootSessionId,
        requestCount: current.requestCount,
      },
      cohort: {
        projectPath: current.projectPath,
        model: current.model,
        effort: current.effort,
      },
      baseline: {
        kind: "historical_session_burst_robust",
        sampleCount: samples.length,
        median: baseline.median,
        mad: baseline.mad,
        robustZ: baseline.status === "ready"
          ? ROBUST_Z_SCALE * (current.maxRequestsInWindow - baseline.median) / baseline.mad
          : null,
        status: baseline.status,
        horizonStart: prior[0]?.firstObservedAt ?? null,
        horizonEnd: prior.at(-1)?.lastObservedAt ?? null,
      },
      metric: {
        name: "max_requests_in_60_seconds",
        current: current.maxRequestsInWindow,
      },
      effect: {
        absolute: current.maxRequestsInWindow - baseline.median,
        ratio: baseline.median > 0 ? current.maxRequestsInWindow / baseline.median : null,
        percentagePoints: null,
      },
      evidence: {
        windowMs: policy.burst.windowMs,
        idleGapMs: policy.burst.idleGapMs,
        requestCount: current.maxRequestsInWindow,
        supportingWindowStart: current.supportingWindowStart,
        supportingWindowEnd: current.supportingWindowEnd,
        episodeStart: current.episodeStart,
        episodeEnd: current.episodeEnd,
      },
      supportingLocator: supportingFact
        ? requestLocator(supportingFact, ordinals.get(supportingFact.requestId))
        : null,
    });
  }
}

function appendSubagentAmplificationCandidate(
  candidates,
  coverage,
  currentFacts,
  historicalSamples,
  ordinals,
  policy,
) {
  const current = buildCurrentAmplificationSample(currentFacts);
  if (!current) {
    coverage.noLineage += 1;
    return;
  }
  const currentMs = Date.parse(current.observedAt);
  if (!Number.isFinite(currentMs)) return;
  const horizonStart = currentMs - policy.subagentAmplification.horizonDays * DAY_MS;
  const prior = historicalSamples
    .filter((sample) =>
      sample.rootSessionId !== current.rootSessionId &&
      sample.projectPath === current.projectPath &&
      Date.parse(sample.observedAt) >= horizonStart &&
      Date.parse(sample.observedAt) < currentMs
    )
    .slice(-policy.subagentAmplification.maxSessions);
  if (prior.length < policy.subagentAmplification.minimumSamples) {
    coverage.insufficientAmplificationHistory += 1;
    return;
  }
  const samples = prior.map((sample) => sample.tokenRatio);
  const baseline = robustBaseline(samples);
  if (baseline.status === "degenerate") coverage.degenerateMad += 1;
  candidates.push({
    family: "behavioral_session",
    type: "subagent_amplification",
    rootSessionId: current.rootSessionId,
    observedAt: current.observedAt,
    subject: {
      kind: "session_lineage",
      rootSessionId: current.rootSessionId,
    },
    cohort: {
      projectPath: current.projectPath,
    },
    baseline: {
      kind: "historical_project_multi_agent_robust",
      sampleCount: samples.length,
      median: baseline.median,
      mad: baseline.mad,
      robustZ: baseline.status === "ready"
        ? ROBUST_Z_SCALE * (current.tokenRatio - baseline.median) / baseline.mad
        : null,
      status: baseline.status,
      horizonStart: prior[0]?.observedAt ?? null,
      horizonEnd: prior.at(-1)?.observedAt ?? null,
    },
    metric: {
      name: "descendant_to_root_token_ratio",
      current: current.tokenRatio,
    },
    effect: {
      absolute: current.tokenRatio - baseline.median,
      ratio: baseline.median > 0 ? current.tokenRatio / baseline.median : null,
      percentagePoints: null,
    },
    evidence: {
      rootTokens: current.rootTokens,
      descendantTokens: current.descendantTokens,
      descendantExtraTokens: current.descendantTokens - current.rootTokens,
      rootRequests: current.rootRequests,
      descendantRequests: current.descendantRequests,
      requestRatio: current.requestRatio,
      descendantAgents: current.descendantAgents,
      maxDepth: current.maxDepth,
    },
    supportingLocator: current.supportingFact
      ? requestLocator(current.supportingFact, ordinals.get(current.supportingFact.requestId))
      : null,
  });
}

function candidateSeverity(candidate, policy) {
  const z = candidate.baseline?.robustZ;
  if (!Number.isFinite(z) || candidate.baseline?.status !== "ready") return null;
  if (candidate.type === "reasoning_anomaly") {
    const shareIncrease = candidate.effect?.percentagePoints;
    const reasoningTokens = candidate.evidence?.reasoningOutputTokens;
    if (
      z + EPSILON >= policy.robustZ.highCandidate &&
      shareIncrease + EPSILON >= policy.reasoning.highShareIncrease &&
      reasoningTokens + EPSILON >= policy.reasoning.highReasoningTokens
    ) return "high";
    if (
      z + EPSILON >= policy.robustZ.warningCandidate &&
      shareIncrease + EPSILON >= policy.reasoning.warningShareIncrease &&
      reasoningTokens + EPSILON >= policy.reasoning.warningReasoningTokens
    ) return "warning";
    return null;
  }
  if (candidate.type === "request_burst") {
    const count = candidate.metric?.current;
    const ratio = candidate.effect?.ratio;
    if (
      z + EPSILON >= policy.robustZ.highCandidate &&
      count + EPSILON >= policy.burst.highRequestCount &&
      ratio + EPSILON >= policy.burst.highRatio
    ) return "high";
    if (
      z + EPSILON >= policy.robustZ.warningCandidate &&
      count + EPSILON >= policy.burst.warningRequestCount &&
      ratio + EPSILON >= policy.burst.warningRatio
    ) return "warning";
    return null;
  }
  if (candidate.type === "subagent_amplification") {
    const tokenRatio = candidate.metric?.current;
    const ratioGrowth = candidate.effect?.ratio;
    const extraTokens = candidate.evidence?.descendantExtraTokens;
    const descendantRequests = candidate.evidence?.descendantRequests;
    if (
      z + EPSILON >= policy.robustZ.highCandidate &&
      tokenRatio + EPSILON >= policy.subagentAmplification.highTokenRatio &&
      ratioGrowth + EPSILON >= policy.subagentAmplification.highRatioGrowth &&
      extraTokens + EPSILON >= policy.subagentAmplification.highExtraTokens &&
      descendantRequests + EPSILON >= policy.subagentAmplification.highDescendantRequests
    ) return "high";
    if (
      z + EPSILON >= policy.robustZ.warningCandidate &&
      tokenRatio + EPSILON >= policy.subagentAmplification.warningTokenRatio &&
      ratioGrowth + EPSILON >= policy.subagentAmplification.warningRatioGrowth &&
      extraTokens + EPSILON >= policy.subagentAmplification.warningExtraTokens &&
      descendantRequests + EPSILON >= policy.subagentAmplification.warningDescendantRequests
    ) return "warning";
  }
  return null;
}

function materializeFinding(candidate, policy) {
  const findingId = deterministicFindingId(candidate, policy.version);
  const locator = candidate.locator ?? candidate.supportingLocator ?? null;
  return {
    findingId,
    policyVersion: policy.version,
    family: candidate.family,
    type: candidate.type,
    severity: candidate.shadowSeverity,
    subject: candidate.subject,
    cohort: candidate.cohort,
    baseline: candidate.baseline,
    metric: candidate.metric,
    effect: candidate.effect,
    evidence: candidate.evidence ?? null,
    locator: candidate.locator ?? null,
    supportingLocator: candidate.supportingLocator ?? null,
    requestId: candidate.requestId ?? locator?.requestId ?? null,
    rootSessionId: candidate.rootSessionId ?? candidate.subject?.rootSessionId ?? null,
    threadId: locator?.threadId ?? null,
    turnId: locator?.turnId ?? null,
    observedAt: candidate.observedAt ?? locator?.observedAt ?? null,
  };
}

function deterministicFindingId(candidate, policyVersion) {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      policyVersion,
      candidate.family,
      candidate.type,
      candidate.subject ?? null,
      candidate.cohort ?? null,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `behavioral-diagnostic-${digest}`;
}

function summarizeFindings(findings) {
  const summary = { high: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (Object.hasOwn(summary, finding.severity)) summary[finding.severity] += 1;
  }
  return summary;
}

function buildBurstSlices(facts, policy) {
  const groups = new Map();
  for (const fact of facts) {
    if (!hasStrictCohort(fact)) continue;
    const key = JSON.stringify([fact.rootSessionId, fact.projectPath, fact.model, fact.effort]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  const slices = [];
  for (const grouped of groups.values()) {
    // analyzeBehavioralUsageDiagnostics() provides facts in stable time order, and
    // grouping preserves insertion order. Avoid sorting each cohort slice again.
    const ordered = grouped;
    if (!ordered.length) continue;
    const densest = densestWindow(ordered, policy.burst.windowMs, policy.burst.idleGapMs);
    const first = ordered[0];
    const last = ordered.at(-1);
    slices.push({
      rootSessionId: first.rootSessionId,
      projectPath: first.projectPath,
      model: first.model,
      effort: first.effort,
      requestCount: ordered.length,
      maxRequestsInWindow: densest.count,
      supportingWindowStart: densest.windowStart,
      supportingWindowEnd: densest.windowEnd,
      episodeStart: densest.episodeStart,
      episodeEnd: densest.episodeEnd,
      supportingFact: densest.supportingFact,
      firstObservedAt: first.observedAt,
      lastObservedAt: last.observedAt,
    });
  }
  return slices;
}

function densestWindow(facts, windowMs, idleGapMs) {
  let left = 0;
  let best = { count: 0, left: 0, right: 0 };
  const timestamps = facts.map((fact) => Date.parse(fact.observedAt));
  for (let right = 0; right < facts.length; right += 1) {
    while (left < right && timestamps[right] - timestamps[left] > windowMs) left += 1;
    const count = right - left + 1;
    if (count > best.count) best = { count, left, right };
  }
  let episodeLeft = best.left;
  while (
    episodeLeft > 0 &&
    timestamps[episodeLeft] - timestamps[episodeLeft - 1] <= idleGapMs
  ) episodeLeft -= 1;
  let episodeRight = best.right;
  while (
    episodeRight + 1 < facts.length &&
    timestamps[episodeRight + 1] - timestamps[episodeRight] <= idleGapMs
  ) episodeRight += 1;
  return {
    count: best.count,
    windowStart: facts[best.left]?.observedAt ?? null,
    windowEnd: facts[best.right]?.observedAt ?? null,
    episodeStart: facts[episodeLeft]?.observedAt ?? null,
    episodeEnd: facts[episodeRight]?.observedAt ?? null,
    supportingFact: facts[best.right] ?? null,
  };
}

function buildCurrentAmplificationSample(facts) {
  let rootTokens = 0;
  let descendantTokens = 0;
  let rootRequests = 0;
  let descendantRequests = 0;
  let maxDepth = 0;
  let supportingFact = null;
  const descendantThreads = new Set();
  // The analyzer normalizes current facts to stable time order before calling us.
  const ordered = facts;
  for (const fact of ordered) {
    const total = finiteNonNegative(fact.usage?.totalTokens);
    const depth = Number(fact.agentDepth);
    const root = fact.isRootAgent === true || depth === 0;
    if (total == null || !Number.isFinite(depth)) continue;
    if (root) {
      rootTokens += total;
      rootRequests += 1;
      continue;
    }
    if (depth > 0) {
      descendantTokens += total;
      descendantRequests += 1;
      descendantThreads.add(fact.threadId);
      maxDepth = Math.max(maxDepth, depth);
      if (!supportingFact || total > Number(supportingFact.usage?.totalTokens ?? -1)) supportingFact = fact;
    }
  }
  if (rootTokens <= 0 || descendantTokens <= 0 || rootRequests <= 0 || descendantRequests <= 0) return null;
  const first = ordered[0];
  const last = ordered.at(-1);
  return {
    rootSessionId: first?.rootSessionId ?? null,
    projectPath: first?.projectPath ?? null,
    observedAt: last?.observedAt ?? first?.observedAt ?? null,
    tokenRatio: descendantTokens / rootTokens,
    requestRatio: descendantRequests / rootRequests,
    rootTokens,
    descendantTokens,
    rootRequests,
    descendantRequests,
    descendantAgents: descendantThreads.size,
    maxDepth,
    supportingFact,
  };
}

function reasoningMetric(fact, minimumOutputTokens) {
  const outputTokens = finiteNonNegative(fact.usage?.outputTokens);
  const reasoningTokens = finiteNonNegative(fact.usage?.reasoningOutputTokens);
  if (
    outputTokens == null ||
    reasoningTokens == null ||
    outputTokens < minimumOutputTokens ||
    outputTokens === 0 ||
    reasoningTokens > outputTokens
  ) return null;
  return {
    outputTokens,
    reasoningTokens,
    share: reasoningTokens / outputTokens,
  };
}

function buildReasoningHistoryIndex(facts, minimumOutputTokens) {
  const groups = new Map();
  for (const fact of facts) {
    if (!hasStrictCohort(fact)) continue;
    const observedMs = Date.parse(fact.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const metric = reasoningMetric(fact, minimumOutputTokens);
    if (!metric) continue;
    const key = strictCohortKey(fact);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ fact, observedMs, metric });
  }
  return groups;
}

function historicalRange(entries, startMs, endMs) {
  return {
    start: lowerBoundObserved(entries, startMs),
    end: lowerBoundObserved(entries, endMs),
  };
}

function lowerBoundObserved(entries, targetMs) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entries[middle].observedMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function reasoningSampleSet({
  cache,
  cacheKey,
  entries,
  range,
  currentRootSessionId,
  maxSamples,
}) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const shareSamples = [];
  const reasoningTokenSamples = [];
  for (
    let index = range.end - 1;
    index >= range.start && shareSamples.length < maxSamples;
    index -= 1
  ) {
    const entry = entries[index];
    if (entry.fact.rootSessionId === currentRootSessionId) continue;
    shareSamples.push(entry.metric.share);
    reasoningTokenSamples.push(entry.metric.reasoningTokens);
  }
  const result = {
    shareSamples,
    baseline: shareSamples.length ? robustBaseline(shareSamples) : null,
    reasoningTokenMedian: reasoningTokenSamples.length ? median(reasoningTokenSamples) : null,
  };
  cache.set(cacheKey, result);
  return result;
}

function strictCohortKey(fact) {
  return JSON.stringify([fact.projectPath, fact.model, fact.effort]);
}

function requestOrdinals(facts) {
  const ordinalByTask = new Map();
  const ordinals = new Map();
  for (const fact of [...facts].sort(compareFacts)) {
    if (fact.inScope === false) continue;
    const taskKey = JSON.stringify([
      fact.rootSessionId,
      fact.threadId ?? null,
      fact.turnId ?? null,
    ]);
    const ordinal = (ordinalByTask.get(taskKey) ?? 0) + 1;
    ordinalByTask.set(taskKey, ordinal);
    ordinals.set(fact.requestId, ordinal);
  }
  return ordinals;
}

function requestLocator(fact, requestOrdinalInScope = null) {
  return {
    rootSessionId: fact.rootSessionId,
    threadId: fact.threadId ?? null,
    turnId: fact.turnId ?? null,
    requestId: fact.requestId,
    observedAt: fact.observedAt ?? null,
    requestOrdinalInScope: Number.isInteger(requestOrdinalInScope) ? requestOrdinalInScope : null,
  };
}

function robustBaseline(values) {
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = median(deviations);
  return {
    median: center,
    mad,
    status: mad > 0 ? "ready" : "degenerate",
  };
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function hasStrictCohort(fact) {
  return Boolean(fact.projectPath && fact.model && fact.effort);
}

function isEligibleRequestFact(fact) {
  return Boolean(
    fact?.requestId &&
    fact?.rootSessionId &&
    VERIFIED_REQUEST_CLASSIFICATIONS.has(fact.classification),
  );
}

function isValidAmplificationSample(sample) {
  return Boolean(
    sample?.rootSessionId &&
    sample?.projectPath &&
    Number.isFinite(Date.parse(sample.observedAt)) &&
    Number.isFinite(Number(sample.tokenRatio)) &&
    Number(sample.tokenRatio) >= 0,
  );
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compareFacts(left, right) {
  const timeDelta = compareIso(left.observedAt, right.observedAt);
  if (timeDelta !== 0) return timeDelta;
  return String(left.requestId).localeCompare(String(right.requestId));
}

function compareAmplificationSamples(left, right) {
  const timeDelta = compareIso(left.observedAt, right.observedAt);
  if (timeDelta !== 0) return timeDelta;
  return String(left.rootSessionId).localeCompare(String(right.rootSessionId));
}

function compareIso(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  return String(left ?? "").localeCompare(String(right ?? ""));
}
