import { createHash } from "node:crypto";

const ROBUST_Z_SCALE = 0.67448975;
const NUMERIC_EPSILON = 1e-12;
const VERIFIED_REQUEST_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export const ADVANCED_USAGE_DIAGNOSTICS_POLICY = Object.freeze({
  version: "advanced-usage-diagnostics-v1",
  frozen: true,
  requestHistory: Object.freeze({
    horizonDays: 30,
    maxSamplesPerCohort: 200,
    minimumSamples: 20,
  }),
  sessionHistory: Object.freeze({
    horizonDays: 60,
    maxSlicesPerCohort: 20,
    minimumSlices: 10,
    minimumRequestsPerSlice: 3,
  }),
  robustZ: Object.freeze({
    warningCandidate: 3.5,
    highCandidate: 5,
  }),
  contextInflation: Object.freeze({
    warningAbsoluteTokens: 32_768,
    warningRatio: 1.35,
    highAbsoluteTokens: 65_536,
    highRatio: 2,
  }),
  cacheRegression: Object.freeze({
    minimumInputTokens: 8_192,
    warningDrop: 0.20,
    highDrop: 0.40,
  }),
  costSpike: Object.freeze({
    warningAbsoluteUsd: 0.05,
    warningRatio: 1.75,
    highRatio: 3,
  }),
});

export function analyzeAdvancedUsageDiagnostics(dataset, policy = ADVANCED_USAGE_DIAGNOSTICS_POLICY) {
  const currentFacts = [...(dataset?.currentFacts ?? [])]
    .filter(isEligibleRequestFact)
    .sort(compareFacts);
  const historicalFacts = [...(dataset?.historicalFacts ?? [])]
    .filter(isEligibleRequestFact)
    .sort(compareFacts);
  const historicalCohorts = buildHistoricalCohortIndex(historicalFacts);
  const requestBaselineCache = new Map();
  const candidates = [];
  const requestOrdinals = requestOrdinalMap(currentFacts);
  const coverage = {
    strictCohortSamples: 0,
    insufficientHistory: 0,
    unknownEffort: 0,
    degenerateMad: 0,
    costIneligible: 0,
  };

  for (const current of currentFacts) {
    if (!current.effort) {
      coverage.unknownEffort += 1;
      continue;
    }
    if (!hasStrictCohort(current)) continue;
    const currentObservedMs = Date.parse(current.observedAt);
    if (!Number.isFinite(currentObservedMs)) continue;
    const requestHorizonStartMs = currentObservedMs - policy.requestHistory.horizonDays * 86_400_000;
    const cohortKey = requestCohortKey(current);
    const cohortEntries = historicalCohorts.get(cohortKey) ?? [];
    const range = historicalRange(cohortEntries, requestHorizonStartMs, currentObservedMs);
    const inputSampleSet = requestMetricSampleSet({
      cache: requestBaselineCache,
      cacheKey: stableTuple(["input", cohortKey, range.start, range.end, current.rootSessionId]),
      entries: cohortEntries,
      range,
      currentRootSessionId: current.rootSessionId,
      maxSamples: policy.requestHistory.maxSamplesPerCohort,
      metricOf: (fact) => finiteNonNegative(fact.usage?.inputTokens),
    });
    const inputSamples = inputSampleSet.samples;
    if (inputSamples.length < policy.requestHistory.minimumSamples) {
      coverage.insufficientHistory += 1;
      continue;
    }
    const baseline = inputSampleSet.baseline;
    coverage.strictCohortSamples += inputSamples.length;
    if (baseline.status === "degenerate") coverage.degenerateMad += 1;
    const currentInput = finiteNonNegative(current.usage?.inputTokens);
    if (currentInput == null) continue;
    candidates.push({
      family: "historical",
      type: "historical_context_inflation",
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
        kind: "historical_request_robust",
        sampleCount: inputSamples.length,
        median: baseline.median,
        mad: baseline.mad,
        robustZ: baseline.status === "ready"
          ? ROBUST_Z_SCALE * (currentInput - baseline.median) / baseline.mad
          : null,
        status: baseline.status,
      },
      metric: {
        name: "input_tokens",
        current: currentInput,
      },
      effect: effectFromValues(currentInput, baseline.median),
      locator: requestLocator(current, requestOrdinals.get(current.requestId)),
    });

    const currentCacheHitRate = cacheHitRate(current, policy.cacheRegression.minimumInputTokens);
    if (currentCacheHitRate != null) {
      const cacheSampleSet = requestMetricSampleSet({
        cache: requestBaselineCache,
        cacheKey: stableTuple(["cache", cohortKey, range.start, range.end, current.rootSessionId]),
        entries: cohortEntries,
        range,
        currentRootSessionId: current.rootSessionId,
        maxSamples: policy.requestHistory.maxSamplesPerCohort,
        metricOf: (fact) => cacheHitRate(fact, policy.cacheRegression.minimumInputTokens),
      });
      const cacheSamples = cacheSampleSet.samples;
      if (cacheSamples.length >= policy.requestHistory.minimumSamples) {
        const cacheBaseline = cacheSampleSet.baseline;
        if (cacheBaseline.status === "degenerate") coverage.degenerateMad += 1;
        candidates.push({
          family: "historical",
          type: "historical_cache_regression",
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
            kind: "historical_request_robust",
            sampleCount: cacheSamples.length,
            median: cacheBaseline.median,
            mad: cacheBaseline.mad,
            robustZ: cacheBaseline.status === "ready"
              ? ROBUST_Z_SCALE * (currentCacheHitRate - cacheBaseline.median) / cacheBaseline.mad
              : null,
            status: cacheBaseline.status,
          },
          metric: {
            name: "cache_hit_rate",
            current: currentCacheHitRate,
          },
          effect: {
            ...effectFromValues(currentCacheHitRate, cacheBaseline.median),
            percentagePoints: currentCacheHitRate - cacheBaseline.median,
          },
          locator: requestLocator(current, requestOrdinals.get(current.requestId)),
        });
      }
    }

    const currentCost = comparableCost(current);
    if (currentCost) {
      const costSampleSet = requestMetricSampleSet({
        cache: requestBaselineCache,
        cacheKey: stableTuple([
          "cost",
          cohortKey,
          range.start,
          range.end,
          current.rootSessionId,
          currentCost.serviceTier,
          currentCost.rateVersion,
        ]),
        entries: cohortEntries,
        range,
        currentRootSessionId: current.rootSessionId,
        maxSamples: policy.requestHistory.maxSamplesPerCohort,
        metricOf: (fact) => {
          const cost = comparableCost(fact);
          return cost &&
            cost.serviceTier === currentCost.serviceTier &&
            cost.rateVersion === currentCost.rateVersion
            ? cost.amountUsd
            : null;
        },
      });
      const costSamples = costSampleSet.samples;
      if (costSamples.length >= policy.requestHistory.minimumSamples) {
        const costBaseline = costSampleSet.baseline;
        if (costBaseline.status === "degenerate") coverage.degenerateMad += 1;
        candidates.push({
          family: "historical",
          type: "historical_cost_spike",
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
            serviceTier: currentCost.serviceTier,
            rateVersion: currentCost.rateVersion,
          },
          baseline: {
            kind: "historical_request_robust",
            sampleCount: costSamples.length,
            median: costBaseline.median,
            mad: costBaseline.mad,
            robustZ: costBaseline.status === "ready"
              ? ROBUST_Z_SCALE * (currentCost.amountUsd - costBaseline.median) / costBaseline.mad
              : null,
            status: costBaseline.status,
          },
          metric: {
            name: "request_cost_usd",
            current: currentCost.amountUsd,
          },
          effect: effectFromValues(currentCost.amountUsd, costBaseline.median),
          locator: requestLocator(current, requestOrdinals.get(current.requestId)),
        });
      }
    } else {
      coverage.costIneligible += 1;
    }
  }

  if ((dataset?.scope?.type ?? "session") === "session") {
    const historicalSessionFacts = [...(dataset?.historicalSessionFacts ?? historicalFacts)]
      .filter(isEligibleRequestFact)
      .sort(compareFacts);
    appendCrossSessionCandidates(
      candidates,
      coverage,
      currentFacts,
      historicalSessionFacts,
      policy,
      requestOrdinals,
    );
  }
  for (const candidate of candidates) {
    candidate.shadowSeverity = candidateSeverity(candidate, policy);
  }
  const findings = policy.frozen === true
    ? candidates
        .filter((candidate) => candidate.shadowSeverity && (candidate.family !== "historical" || candidate.inScope !== false))
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

function buildHistoricalCohortIndex(facts) {
  const cohorts = new Map();
  for (const fact of facts) {
    if (!hasStrictCohort(fact)) continue;
    const observedMs = Date.parse(fact.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const key = requestCohortKey(fact);
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push({ fact, observedMs });
  }
  for (const entries of cohorts.values()) {
    entries.sort((left, right) =>
      left.observedMs - right.observedMs || String(left.fact.requestId).localeCompare(String(right.fact.requestId))
    );
  }
  return cohorts;
}

function requestCohortKey(fact) {
  return stableTuple([fact.projectPath, fact.model, fact.effort]);
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

function requestMetricSampleSet({
  cache,
  cacheKey,
  entries,
  range,
  currentRootSessionId,
  maxSamples,
  metricOf,
}) {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const samples = [];
  for (let index = range.end - 1; index >= range.start && samples.length < maxSamples; index -= 1) {
    const fact = entries[index].fact;
    if (fact.rootSessionId === currentRootSessionId) continue;
    const value = metricOf(fact);
    if (value != null && Number.isFinite(value)) samples.push(value);
  }
  const result = {
    samples,
    baseline: samples.length ? robustBaseline(samples) : null,
  };
  cache.set(cacheKey, result);
  return result;
}

function materializeFinding(candidate, policy) {
  const findingId = deterministicFindingId(candidate, policy.version);
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
    requestId: candidate.requestId ?? null,
    rootSessionId: candidate.rootSessionId ?? candidate.subject?.rootSessionId ?? null,
    threadId: candidate.locator?.threadId ?? candidate.supportingLocator?.threadId ?? null,
    turnId: candidate.locator?.turnId ?? candidate.supportingLocator?.turnId ?? null,
    observedAt: candidate.observedAt ?? null,
  };
}

function deterministicFindingId(candidate, policyVersion) {
  const subjectIdentity = candidate.subject ?? null;
  const cohortIdentity = candidate.cohort ?? null;
  const digest = createHash("sha256")
    .update(JSON.stringify([
      policyVersion,
      candidate.family,
      candidate.type,
      subjectIdentity,
      cohortIdentity,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `advanced-diagnostic-${digest}`;
}

function summarizeFindings(findings) {
  const summary = { high: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (Object.hasOwn(summary, finding.severity)) summary[finding.severity] += 1;
  }
  return summary;
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

function requestOrdinalMap(facts) {
  const ordinalByTask = new Map();
  const ordinalByRequest = new Map();
  for (const fact of [...facts].sort(compareFacts)) {
    if (fact.inScope === false) continue;
    const taskKey = stableTuple([fact.rootSessionId, fact.threadId ?? null, fact.turnId ?? null]);
    const ordinal = (ordinalByTask.get(taskKey) ?? 0) + 1;
    ordinalByTask.set(taskKey, ordinal);
    ordinalByRequest.set(fact.requestId, ordinal);
  }
  return ordinalByRequest;
}

function candidateSeverity(candidate, policy) {
  const robustZ = candidate.baseline?.robustZ;
  if (!Number.isFinite(robustZ) || candidate.baseline?.status !== "ready") return null;
  if (
    candidate.type === "historical_context_inflation" ||
    candidate.type === "cross_session_context_regression"
  ) {
    const absolute = candidate.effect?.absolute;
    const ratio = candidate.effect?.ratio;
    if (
      robustZ + NUMERIC_EPSILON >= policy.robustZ.highCandidate &&
      absolute + NUMERIC_EPSILON >= policy.contextInflation.highAbsoluteTokens &&
      ratio + NUMERIC_EPSILON >= policy.contextInflation.highRatio
    ) return "high";
    if (
      robustZ + NUMERIC_EPSILON >= policy.robustZ.warningCandidate &&
      absolute + NUMERIC_EPSILON >= policy.contextInflation.warningAbsoluteTokens &&
      ratio + NUMERIC_EPSILON >= policy.contextInflation.warningRatio
    ) return "warning";
    return null;
  }
  if (
    candidate.type === "historical_cache_regression" ||
    candidate.type === "cross_session_cache_regression"
  ) {
    const drop = -(candidate.effect?.percentagePoints ?? 0);
    if (
      robustZ - NUMERIC_EPSILON <= -policy.robustZ.highCandidate &&
      drop + NUMERIC_EPSILON >= policy.cacheRegression.highDrop
    ) return "high";
    if (
      robustZ - NUMERIC_EPSILON <= -policy.robustZ.warningCandidate &&
      drop + NUMERIC_EPSILON >= policy.cacheRegression.warningDrop
    ) return "warning";
    return null;
  }
  if (
    candidate.type === "historical_cost_spike" ||
    candidate.type === "cross_session_cost_regression"
  ) {
    const absolute = candidate.effect?.absolute;
    const ratio = candidate.effect?.ratio;
    if (
      robustZ + NUMERIC_EPSILON >= policy.robustZ.highCandidate &&
      absolute + NUMERIC_EPSILON >= policy.costSpike.warningAbsoluteUsd &&
      ratio + NUMERIC_EPSILON >= policy.costSpike.highRatio
    ) return "high";
    if (
      robustZ + NUMERIC_EPSILON >= policy.robustZ.warningCandidate &&
      absolute + NUMERIC_EPSILON >= policy.costSpike.warningAbsoluteUsd &&
      ratio + NUMERIC_EPSILON >= policy.costSpike.warningRatio
    ) return "warning";
  }
  return null;
}

function appendCrossSessionCandidates(
  candidates,
  coverage,
  currentFacts,
  historicalFacts,
  policy,
  requestOrdinals,
) {
  const currentSlices = buildSessionSlices(currentFacts, policy);
  const historicalSlices = buildSessionSlices(historicalFacts, policy);
  for (const current of currentSlices) {
    if (current.requestCount < policy.sessionHistory.minimumRequestsPerSlice) continue;
    const currentStartMs = Date.parse(current.firstObservedAt);
    const sessionHorizonStartMs = currentStartMs - policy.sessionHistory.horizonDays * 86_400_000;
    const prior = historicalSlices
      .filter((slice) =>
        slice.rootSessionId !== current.rootSessionId &&
        slice.projectPath === current.projectPath &&
        slice.model === current.model &&
        slice.effort === current.effort &&
        Date.parse(slice.lastObservedAt) >= sessionHorizonStartMs &&
        Date.parse(slice.lastObservedAt) < currentStartMs
      )
      .sort((left, right) => Date.parse(left.lastObservedAt) - Date.parse(right.lastObservedAt))
      .slice(-policy.sessionHistory.maxSlicesPerCohort);
    if (prior.length < policy.sessionHistory.minimumSlices) continue;
    const samples = prior.map((slice) => slice.medianInputTokensPerRequest);
    const baseline = robustBaseline(samples);
    if (baseline.status === "degenerate") coverage.degenerateMad += 1;
    candidates.push({
      family: "cross_session",
      type: "cross_session_context_regression",
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
        kind: "historical_session_slice_robust",
        sampleCount: samples.length,
        median: baseline.median,
        mad: baseline.mad,
        robustZ: baseline.status === "ready"
          ? ROBUST_Z_SCALE * (current.medianInputTokensPerRequest - baseline.median) / baseline.mad
          : null,
        status: baseline.status,
        horizonStart: prior[0]?.firstObservedAt ?? null,
        horizonEnd: prior.at(-1)?.lastObservedAt ?? null,
      },
      metric: {
        name: "median_input_tokens_per_request",
        current: current.medianInputTokensPerRequest,
      },
      effect: effectFromValues(current.medianInputTokensPerRequest, baseline.median),
      supportingLocator: supportingLocator(
        current.facts,
        (fact) => finiteNonNegative(fact.usage?.inputTokens),
        baseline.median,
        "high",
        requestOrdinals,
      ),
    });

    if (current.weightedCacheHitRate != null) {
      const cacheSamples = prior
        .map((slice) => slice.weightedCacheHitRate)
        .filter((value) => value != null);
      if (cacheSamples.length >= policy.sessionHistory.minimumSlices) {
        const cacheBaseline = robustBaseline(cacheSamples);
        if (cacheBaseline.status === "degenerate") coverage.degenerateMad += 1;
        candidates.push({
          family: "cross_session",
          type: "cross_session_cache_regression",
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
            kind: "historical_session_slice_robust",
            sampleCount: cacheSamples.length,
            median: cacheBaseline.median,
            mad: cacheBaseline.mad,
            robustZ: cacheBaseline.status === "ready"
              ? ROBUST_Z_SCALE * (current.weightedCacheHitRate - cacheBaseline.median) / cacheBaseline.mad
              : null,
            status: cacheBaseline.status,
            horizonStart: prior[0]?.firstObservedAt ?? null,
            horizonEnd: prior.at(-1)?.lastObservedAt ?? null,
          },
          metric: {
            name: "weighted_cache_hit_rate",
            current: current.weightedCacheHitRate,
          },
          effect: {
            ...effectFromValues(current.weightedCacheHitRate, cacheBaseline.median),
            percentagePoints: current.weightedCacheHitRate - cacheBaseline.median,
          },
          supportingLocator: supportingLocator(
            current.facts,
            (fact) => cacheHitRate(fact, policy.cacheRegression.minimumInputTokens),
            cacheBaseline.median,
            "low",
            requestOrdinals,
          ),
        });
      }
    }
  }
  appendCrossSessionCostCandidates(
    candidates,
    coverage,
    currentFacts,
    historicalFacts,
    policy,
    requestOrdinals,
  );
}

function appendCrossSessionCostCandidates(
  candidates,
  coverage,
  currentFacts,
  historicalFacts,
  policy,
  requestOrdinals,
) {
  const currentSlices = buildCostSessionSlices(currentFacts);
  const historicalSlices = buildCostSessionSlices(historicalFacts);
  for (const current of currentSlices) {
    if (current.requestCount < policy.sessionHistory.minimumRequestsPerSlice) continue;
    const currentStartMs = Date.parse(current.firstObservedAt);
    const sessionHorizonStartMs = currentStartMs - policy.sessionHistory.horizonDays * 86_400_000;
    const prior = historicalSlices
      .filter((slice) =>
        slice.rootSessionId !== current.rootSessionId &&
        slice.projectPath === current.projectPath &&
        slice.model === current.model &&
        slice.effort === current.effort &&
        slice.serviceTier === current.serviceTier &&
        slice.rateVersion === current.rateVersion &&
        Date.parse(slice.lastObservedAt) >= sessionHorizonStartMs &&
        Date.parse(slice.lastObservedAt) < currentStartMs
      )
      .sort((left, right) => Date.parse(left.lastObservedAt) - Date.parse(right.lastObservedAt))
      .slice(-policy.sessionHistory.maxSlicesPerCohort);
    if (prior.length < policy.sessionHistory.minimumSlices) continue;
    const samples = prior.map((slice) => slice.medianEstimatedCostUsd);
    const baseline = robustBaseline(samples);
    if (baseline.status === "degenerate") coverage.degenerateMad += 1;
    candidates.push({
      family: "cross_session",
      type: "cross_session_cost_regression",
      subject: {
        kind: "session_cohort_slice",
        rootSessionId: current.rootSessionId,
        requestCount: current.requestCount,
      },
      cohort: {
        projectPath: current.projectPath,
        model: current.model,
        effort: current.effort,
        serviceTier: current.serviceTier,
        rateVersion: current.rateVersion,
      },
      baseline: {
        kind: "historical_session_slice_robust",
        sampleCount: samples.length,
        median: baseline.median,
        mad: baseline.mad,
        robustZ: baseline.status === "ready"
          ? ROBUST_Z_SCALE * (current.medianEstimatedCostUsd - baseline.median) / baseline.mad
          : null,
        status: baseline.status,
        horizonStart: prior[0]?.firstObservedAt ?? null,
        horizonEnd: prior.at(-1)?.lastObservedAt ?? null,
      },
      metric: {
        name: "median_estimated_cost_usd",
        current: current.medianEstimatedCostUsd,
      },
      effect: effectFromValues(current.medianEstimatedCostUsd, baseline.median),
      supportingLocator: supportingLocator(
        current.facts,
        (fact) => comparableCost(fact)?.amountUsd ?? null,
        baseline.median,
        "high",
        requestOrdinals,
      ),
    });
  }
}

function buildCostSessionSlices(facts) {
  const groups = new Map();
  for (const fact of facts) {
    if (!hasStrictCohort(fact)) continue;
    const cost = comparableCost(fact);
    if (!cost) continue;
    const key = stableTuple([
      fact.rootSessionId,
      fact.projectPath,
      fact.model,
      fact.effort,
      cost.serviceTier,
      cost.rateVersion,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ fact, cost });
  }
  const slices = [];
  for (const entries of groups.values()) {
    entries.sort((left, right) => compareFacts(left.fact, right.fact));
    const first = entries[0];
    const last = entries.at(-1);
    slices.push({
      rootSessionId: first.fact.rootSessionId,
      projectPath: first.fact.projectPath,
      model: first.fact.model,
      effort: first.fact.effort,
      serviceTier: first.cost.serviceTier,
      rateVersion: first.cost.rateVersion,
      requestCount: entries.length,
      medianEstimatedCostUsd: median(entries.map((entry) => entry.cost.amountUsd)),
      firstObservedAt: first.fact.observedAt,
      lastObservedAt: last.fact.observedAt,
      facts: entries.map((entry) => entry.fact),
    });
  }
  return slices;
}

function buildSessionSlices(facts, policy) {
  const groups = new Map();
  for (const fact of facts) {
    if (!hasStrictCohort(fact)) continue;
    const key = stableTuple([fact.rootSessionId, fact.projectPath, fact.model, fact.effort]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  const slices = [];
  for (const groupedFacts of groups.values()) {
    const ordered = groupedFacts.sort(compareFacts);
    const inputs = ordered
      .map((fact) => finiteNonNegative(fact.usage?.inputTokens))
      .filter((value) => value != null);
    if (!inputs.length) continue;
    const first = ordered[0];
    const last = ordered.at(-1);
    slices.push({
      rootSessionId: first.rootSessionId,
      projectPath: first.projectPath,
      model: first.model,
      effort: first.effort,
      requestCount: ordered.length,
      medianInputTokensPerRequest: median(inputs),
      weightedCacheHitRate: weightedCacheHitRate(ordered, policy.cacheRegression.minimumInputTokens),
      firstObservedAt: first.observedAt,
      lastObservedAt: last.observedAt,
      facts: ordered,
    });
  }
  return slices;
}

function supportingLocator(facts, metricOf, baseline, direction, requestOrdinals) {
  let selected = null;
  let selectedDistance = -Infinity;
  for (const fact of facts ?? []) {
    if (fact.inScope === false) continue;
    const value = metricOf(fact);
    if (!Number.isFinite(value)) continue;
    const distance = direction === "low" ? baseline - value : value - baseline;
    if (distance > selectedDistance) {
      selected = fact;
      selectedDistance = distance;
    }
  }
  return selected
    ? requestLocator(selected, requestOrdinals.get(selected.requestId))
    : null;
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
  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

function isEligibleRequestFact(fact) {
  return Boolean(
    fact?.requestId &&
    fact?.rootSessionId &&
    VERIFIED_REQUEST_CLASSIFICATIONS.has(fact.classification),
  );
}

function hasStrictCohort(fact) {
  return Boolean(fact.projectPath && fact.model && fact.effort);
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cacheHitRate(fact, minimumInputTokens) {
  const input = finiteNonNegative(fact.usage?.inputTokens);
  const cached = finiteNonNegative(fact.usage?.cachedInputTokens);
  if (input == null || cached == null || input < minimumInputTokens || cached > input || input === 0) {
    return null;
  }
  return cached / input;
}

function comparableCost(fact) {
  const cost = fact?.costEstimate;
  const amountUsd = finiteNonNegative(cost?.amountUsd);
  const serviceTier = cost?.serviceTier ?? fact?.serviceTier ?? null;
  const rateVersion = cost?.rateVersion ?? null;
  if (cost?.status !== "estimated" || amountUsd == null || !serviceTier || !rateVersion) return null;
  return { amountUsd, serviceTier, rateVersion };
}

function weightedCacheHitRate(facts, minimumInputTokens) {
  let totalInput = 0;
  let totalCached = 0;
  for (const fact of facts) {
    const input = finiteNonNegative(fact.usage?.inputTokens);
    const cached = finiteNonNegative(fact.usage?.cachedInputTokens);
    if (input == null || cached == null || input < minimumInputTokens || cached > input) continue;
    totalInput += input;
    totalCached += cached;
  }
  return totalInput > 0 ? totalCached / totalInput : null;
}

function stableTuple(values) {
  return JSON.stringify(values);
}

function effectFromValues(current, baseline) {
  return {
    absolute: current - baseline,
    ratio: baseline > 0 ? current / baseline : null,
    percentagePoints: null,
  };
}

function compareFacts(left, right) {
  const timeDelta = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
  return String(left.requestId).localeCompare(String(right.requestId));
}
