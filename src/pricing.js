const MILLION = 1_000_000;

const VERIFIED_REQUEST_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export const SUBSCRIPTION_PRICING_CATALOG = Object.freeze({
  version: "subscription-standard-v2",
  currency: "USD",
  basis: "subscription-standard-equivalent",
  capturedAt: "2026-08-28T00:00:00.000Z",
  policyVersion: "2026-08-28-explicit-fast",
  limitations: Object.freeze([
    "codex_subscription_not_billing",
    "quota_not_currency_convertible",
    "tool_fees_excluded",
  ]),
  sources: Object.freeze([
    "https://openai.com/index/introducing-gpt-5-4/",
    "https://openai.com/index/introducing-gpt-5-5/",
    "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/",
    "https://help.openai.com/en/articles/11647665",
  ]),
});

const HISTORICAL_RATE_INTERVALS = Object.freeze([
  historicalRate("gpt-5.4", "2026-03-05T00:00:00.000Z", null, 2.5, 0.25, 15, "gpt-5.4@2026-03-05"),
  historicalRate("gpt-5.5", "2026-04-23T00:00:00.000Z", null, 5, 0.5, 30, "gpt-5.5@2026-04-23"),
  historicalRate("gpt-5.6-sol", "2026-07-09T00:00:00.000Z", null, 5, 0.5, 30, "gpt-5.6-sol@2026-07-09"),
  historicalRate("gpt-5.6-terra", "2026-07-09T00:00:00.000Z", "2026-07-30T00:00:00.000Z", 2.5, 0.25, 15, "gpt-5.6-terra@2026-07-09"),
  historicalRate("gpt-5.6-terra", "2026-07-30T00:00:00.000Z", null, 2, 0.2, 12, "gpt-5.6-terra@2026-07-30"),
  historicalRate("gpt-5.6-luna", "2026-07-09T00:00:00.000Z", "2026-07-30T00:00:00.000Z", 1, 0.1, 6, "gpt-5.6-luna@2026-07-09"),
  historicalRate("gpt-5.6-luna", "2026-07-30T00:00:00.000Z", null, 0.2, 0.02, 1.2, "gpt-5.6-luna@2026-07-30"),
]);

const HISTORICAL_MODEL_ALIASES = Object.freeze([
  Object.freeze({
    alias: "gpt-5.6",
    model: "gpt-5.6-sol",
    effectiveFrom: "2026-07-09T00:00:00.000Z",
    effectiveUntil: null,
  }),
]);

validateHistoricalCatalog(HISTORICAL_RATE_INTERVALS);

export function resolveHistoricalRate(model, observedAt) {
  const instant = timestampMs(observedAt);
  if (!Number.isFinite(instant)) return null;
  const normalized = normalizeHistoricalModel(model, instant);
  if (!normalized) return null;
  const matches = HISTORICAL_RATE_INTERVALS.filter((record) =>
    record.model === normalized && intervalContains(record, instant)
  );
  if (matches.length !== 1) return null;
  const record = matches[0];
  return {
    model: record.model,
    rateVersion: record.rateVersion,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    ratesPerMillion: { ...record.ratesPerMillion },
    sourceUrl: record.sourceUrl,
  };
}

export function normalizeServiceTier(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "fast" ? "fast" : "standard";
}

export function estimateRequestCost(event, {
  requestBoundaryVerified = true,
  applyFeaturePolicy = true,
} = {}) {
  const model = event?.model ?? null;
  const observedAt = event?.observedAt ?? null;
  if (!VERIFIED_REQUEST_CLASSIFICATIONS.has(event?.classification)) {
    return unavailableRequestCost("unverified_request_usage", model, observedAt);
  }
  const rate = resolveHistoricalRate(model, observedAt);
  if (!rate) return unavailableRequestCost(model ? "historical_rate_unavailable" : "missing_model", model, observedAt);
  const usage = validateRequestUsage(event?.usage);
  if (!usage) return unavailableRequestCost("inconsistent_usage_breakdown", model, observedAt, rate);

  const serviceTier = normalizeServiceTier(event?.serviceTier);
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  const baseComponents = {
    uncachedInput: priceTokens(uncachedInputTokens, rate.ratesPerMillion.input),
    cachedInput: priceTokens(usage.cachedInputTokens, rate.ratesPerMillion.cachedInput),
    output: priceTokens(usage.outputTokens, rate.ratesPerMillion.output),
  };
  const baseAmountUsd = baseComponents.uncachedInput + baseComponents.cachedInput + baseComponents.output;
  const longCandidate = usage.inputTokens > 272_000;
  let status = "estimated";
  let reason = null;
  let longContextStatus = "normal";
  let inputMultiplier = 1;
  let outputMultiplier = 1;
  let fastMultiplier = 1;

  if (!applyFeaturePolicy) {
    longContextStatus = longCandidate ? "candidate" : "normal";
  } else if (longCandidate && !supportsLongContext(rate.model)) {
    status = "partial";
    reason = "long_context_model_unsupported";
    longContextStatus = "unknown";
  } else if (longCandidate && !requestBoundaryVerified) {
    status = "partial";
    reason = "long_context_request_boundary_unproven";
    longContextStatus = "candidate";
  } else if (longCandidate) {
    longContextStatus = "long";
    inputMultiplier = 2;
    outputMultiplier = 1.5;
  }

  if (!applyFeaturePolicy) {
    // Historical/base pricing is intentionally feature-neutral. This seam is used by
    // reconciliation and by the T-COST base-rate tests before long/Fast adjustments.
  } else if (serviceTier === "fast" && longContextStatus === "long") {
    status = "partial";
    reason = "unsupported_feature_combination";
    inputMultiplier = 1;
    outputMultiplier = 1;
  } else if (serviceTier === "fast") {
    fastMultiplier = fastMultiplierForModel(rate.model);
    if (fastMultiplier == null) {
      status = "partial";
      reason = "fast_model_unsupported";
      fastMultiplier = 1;
    }
  }

  const uncachedInputUsd = baseComponents.uncachedInput * inputMultiplier * fastMultiplier;
  const cachedInputUsd = baseComponents.cachedInput * inputMultiplier * fastMultiplier;
  const outputUsd = baseComponents.output * outputMultiplier * fastMultiplier;
  const amountUsd = roundUsd(uncachedInputUsd + cachedInputUsd + outputUsd);
  return {
    status,
    amountUsd,
    currency: SUBSCRIPTION_PRICING_CATALOG.currency,
    basis: SUBSCRIPTION_PRICING_CATALOG.basis,
    policyVersion: SUBSCRIPTION_PRICING_CATALOG.policyVersion,
    requestedModel: model,
    pricedModel: rate.model,
    rateVersion: rate.rateVersion,
    observedAt,
    serviceTier,
    rawServiceTier: event?.serviceTier ?? null,
    longContextStatus,
    ratesPerMillion: { ...rate.ratesPerMillion },
    multipliers: {
      input: inputMultiplier,
      cachedInput: inputMultiplier,
      output: outputMultiplier,
      fast: fastMultiplier,
    },
    featureCoverage: {
      historicalRate: "verified",
      requestBoundary: requestBoundaryVerified ? "verified" : "unproven",
      serviceTier: "verified",
    },
    components: {
      uncachedInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      uncachedInputUsd: roundUsd(uncachedInputUsd),
      cachedInputUsd: roundUsd(cachedInputUsd),
      cacheWriteInputUsd: 0,
      outputUsd: roundUsd(outputUsd),
      baseAmountUsd: roundUsd(baseAmountUsd),
    },
    limitations: [...SUBSCRIPTION_PRICING_CATALOG.limitations],
    reason,
  };
}

export function priceTasksByRequestEvents(tasks, events, options = {}) {
  const eventsByTask = new Map();
  for (const event of events ?? []) {
    const key = pricingTaskKey(event?.threadId, event?.turnId);
    const list = eventsByTask.get(key) ?? [];
    list.push(event);
    eventsByTask.set(key, list);
  }
  return (tasks ?? []).map((task) => {
    const taskEvents = eventsByTask.get(pricingTaskKey(task?.threadId, task?.turnId)) ?? [];
    const requestCosts = [];
    for (const event of taskEvents) {
      if (event?.classification === "duplicate") continue;
      requestCosts.push(estimateRequestCost(event, options));
    }
    const costEstimate = task.zeroUsageVerified && requestCosts.length === 0
      ? zeroUsageCostSummary()
      : summarizeRequestCosts(requestCosts);
    return {
      ...task,
      costEstimate,
    };
  });
}

function zeroUsageCostSummary() {
  return {
    status: "estimated",
    amountUsd: 0,
    currency: SUBSCRIPTION_PRICING_CATALOG.currency,
    basis: SUBSCRIPTION_PRICING_CATALOG.basis,
    policyVersion: SUBSCRIPTION_PRICING_CATALOG.policyVersion,
    requestCount: 0,
    estimatedRequests: 0,
    partialRequests: 0,
    unavailableRequests: 0,
    featureCoverage: {
      historicalRate: "verified",
      requestBoundary: "verified",
      serviceTier: "verified",
    },
    rateVersions: [],
    limitations: [...SUBSCRIPTION_PRICING_CATALOG.limitations],
    reasons: [],
    reason: "verified_zero_usage",
  };
}

export function summarizeRequestCosts(costs) {
  let amountUsd = 0;
  let knownAmountCount = 0;
  let estimatedRequests = 0;
  let partialRequests = 0;
  let unavailableRequests = 0;
  const rateVersions = new Set();
  const limitations = new Set();
  const reasons = new Set();
  const coverageValues = {
    historicalRate: [],
    requestBoundary: [],
    serviceTier: [],
  };
  for (const cost of costs ?? []) {
    if (!cost) continue;
    if (cost.status === "estimated") estimatedRequests += 1;
    else if (cost.status === "partial") partialRequests += 1;
    else unavailableRequests += 1;
    if (Number.isFinite(cost.amountUsd)) {
      amountUsd += cost.amountUsd;
      knownAmountCount += 1;
    }
    if (cost.rateVersion) rateVersions.add(cost.rateVersion);
    for (const limitation of cost.limitations ?? []) limitations.add(limitation);
    if (cost.reason) reasons.add(cost.reason);
    for (const key of Object.keys(coverageValues)) {
      if (cost.featureCoverage?.[key]) coverageValues[key].push(cost.featureCoverage[key]);
    }
  }
  const requestCount = estimatedRequests + partialRequests + unavailableRequests;
  const status = knownAmountCount === 0
    ? "unavailable"
    : partialRequests > 0 || unavailableRequests > 0
      ? "partial"
      : "estimated";
  return {
    status,
    amountUsd: knownAmountCount ? roundUsd(amountUsd) : null,
    currency: SUBSCRIPTION_PRICING_CATALOG.currency,
    basis: SUBSCRIPTION_PRICING_CATALOG.basis,
    policyVersion: SUBSCRIPTION_PRICING_CATALOG.policyVersion,
    requestCount,
    estimatedRequests,
    partialRequests,
    unavailableRequests,
    featureCoverage: {
      historicalRate: aggregateFeatureCoverage(coverageValues.historicalRate),
      requestBoundary: aggregateFeatureCoverage(coverageValues.requestBoundary),
      serviceTier: aggregateFeatureCoverage(coverageValues.serviceTier),
    },
    rateVersions: [...rateVersions].sort(),
    limitations: [...limitations].sort(),
    reasons: [...reasons].sort(),
    reason: requestCount === 0 ? "no_request_pricing_evidence" : null,
  };
}

export const PRICING_CATALOG = Object.freeze({
  version: "2026-08-24",
  currency: "USD",
  basis: "openai-standard-api-short-context",
  capturedAt: "2026-08-24T00:00:00.000Z",
  reviewAfter: "2026-11-21T23:59:59.999Z",
  limitations: Object.freeze([
    "codex_subscription_not_billing",
    "long_context_surcharge_not_detectable",
    "service_tier_and_regional_uplifts_excluded",
    "tool_fees_excluded",
  ]),
  sources: Object.freeze([
    "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    "https://developers.openai.com/api/docs/models/gpt-5.5",
    "https://developers.openai.com/api/docs/models/gpt-5.4",
  ]),
});

const RATE_CARDS = Object.freeze({
  "gpt-5.6-sol": rateCard(4, 0.4, 20, 1.25, PRICING_CATALOG.sources[0]),
  "gpt-5.6-terra": rateCard(2, 0.2, 12, 1.25, PRICING_CATALOG.sources[1]),
  "gpt-5.6-luna": rateCard(0.2, 0.02, 1.2, 1.25, PRICING_CATALOG.sources[2]),
  "gpt-5.5": rateCard(5, 0.5, 30, null, PRICING_CATALOG.sources[3]),
  "gpt-5.4": rateCard(2.5, 0.25, 15, null, PRICING_CATALOG.sources[4]),
});

const MODEL_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
});

export function estimateTaskCost(model, usage, now = Date.now()) {
  const resolved = resolveRateCard(model);
  if (!resolved) {
    return unavailableCost(model ? "unsupported_model" : "missing_model", model, now);
  }
  if (!usage || typeof usage !== "object") {
    return unavailableCost("missing_usage", model, now, resolved);
  }

  const inputTokens = validTokenCount(usage.inputTokens);
  const cachedInputTokens = validTokenCount(usage.cachedInputTokens);
  const outputTokens = validTokenCount(usage.outputTokens);
  const cacheWriteInputTokens = validTokenCount(usage.cacheWriteInputTokens);
  const totalTokens = validTokenCount(usage.totalTokens);
  if (inputTokens == null || cachedInputTokens == null || outputTokens == null) {
    return unavailableCost("incomplete_usage_breakdown", model, now, resolved);
  }
  if (resolved.card.cacheWriteMultiplier != null && cacheWriteInputTokens == null) {
    return unavailableCost("incomplete_usage_breakdown", model, now, resolved);
  }
  if (totalTokens != null && inputTokens + outputTokens !== totalTokens) {
    return unavailableCost("inconsistent_usage_breakdown", model, now, resolved);
  }

  const cacheWriteTokens = cacheWriteInputTokens ?? 0;
  const separatelyPricedCacheWrite = resolved.card.cacheWriteMultiplier != null
    ? cacheWriteTokens
    : 0;
  if (cachedInputTokens + separatelyPricedCacheWrite > inputTokens) {
    return unavailableCost("inconsistent_usage_breakdown", model, now, resolved);
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens - separatelyPricedCacheWrite;
  const uncachedInputUsd = priceTokens(uncachedInputTokens, resolved.card.inputUsdPerMillion);
  const cachedInputUsd = priceTokens(cachedInputTokens, resolved.card.cachedInputUsdPerMillion);
  const cacheWriteInputUsd = priceTokens(
    separatelyPricedCacheWrite,
    resolved.card.inputUsdPerMillion * (resolved.card.cacheWriteMultiplier ?? 1),
  );
  const outputUsd = priceTokens(outputTokens, resolved.card.outputUsdPerMillion);
  const amountUsd = roundUsd(
    uncachedInputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd,
  );

  return {
    status: "estimated",
    amountUsd,
    currency: PRICING_CATALOG.currency,
    basis: PRICING_CATALOG.basis,
    catalogVersion: PRICING_CATALOG.version,
    catalogStale: isCatalogStale(now),
    requestedModel: model ?? null,
    pricedModel: resolved.model,
    ratesPerMillion: {
      input: resolved.card.inputUsdPerMillion,
      cachedInput: resolved.card.cachedInputUsdPerMillion,
      cacheWriteInput: resolved.card.cacheWriteMultiplier == null
        ? resolved.card.inputUsdPerMillion
        : resolved.card.inputUsdPerMillion * resolved.card.cacheWriteMultiplier,
      output: resolved.card.outputUsdPerMillion,
    },
    components: {
      uncachedInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: cacheWriteTokens,
      outputTokens,
      uncachedInputUsd: roundUsd(uncachedInputUsd),
      cachedInputUsd: roundUsd(cachedInputUsd),
      cacheWriteInputUsd: roundUsd(cacheWriteInputUsd),
      outputUsd: roundUsd(outputUsd),
    },
    sourceUrl: resolved.card.sourceUrl,
    limitations: [...PRICING_CATALOG.limitations],
    reason: null,
  };
}

export function pricingCatalogSummary() {
  return {
    ...SUBSCRIPTION_PRICING_CATALOG,
    limitations: [...SUBSCRIPTION_PRICING_CATALOG.limitations],
    sources: [...SUBSCRIPTION_PRICING_CATALOG.sources],
    stale: false,
    supportedModels: [...new Set(HISTORICAL_RATE_INTERVALS.map((record) => record.model))].sort(),
  };
}

export function summarizeTaskCosts(tasks) {
  let amountUsd = 0;
  let estimatedTasks = 0;
  let partialTasks = 0;
  let unavailableTasks = 0;
  let estimatedRequests = 0;
  let partialRequests = 0;
  let unavailableRequests = 0;
  const coverage = [];
  for (const task of tasks) {
    const estimate = task.costEstimate;
    if (estimate?.status === "estimated") estimatedTasks += 1;
    else if (estimate?.status === "partial") partialTasks += 1;
    else unavailableTasks += 1;
    amountUsd += estimate?.amountUsd ?? 0;
    estimatedRequests += estimate?.estimatedRequests ?? 0;
    partialRequests += estimate?.partialRequests ?? 0;
    unavailableRequests += estimate?.unavailableRequests ?? 0;
    if (estimate?.featureCoverage) coverage.push(estimate.featureCoverage);
  }
  return costSummary({
    amountUsd,
    estimatedTasks,
    partialTasks,
    unavailableTasks,
    estimatedRequests,
    partialRequests,
    unavailableRequests,
    coverage,
  });
}

export function combineCostSummaries(summaries) {
  let amountUsd = 0;
  let estimatedTasks = 0;
  let partialTasks = 0;
  let unavailableTasks = 0;
  let estimatedRequests = 0;
  let partialRequests = 0;
  let unavailableRequests = 0;
  const coverage = [];
  for (const summary of summaries) {
    if (!summary) continue;
    amountUsd += summary.amountUsd ?? 0;
    estimatedTasks += summary.estimatedTasks ?? 0;
    partialTasks += summary.partialTasks ?? 0;
    unavailableTasks += summary.unavailableTasks ?? 0;
    estimatedRequests += summary.estimatedRequests ?? 0;
    partialRequests += summary.partialRequests ?? 0;
    unavailableRequests += summary.unavailableRequests ?? 0;
    if (summary.featureCoverage) coverage.push(summary.featureCoverage);
  }
  return costSummary({
    amountUsd,
    estimatedTasks,
    partialTasks,
    unavailableTasks,
    estimatedRequests,
    partialRequests,
    unavailableRequests,
    coverage,
  });
}

function costSummary({
  amountUsd,
  estimatedTasks,
  partialTasks,
  unavailableTasks,
  estimatedRequests,
  partialRequests,
  unavailableRequests,
  coverage,
}) {
  const knownTasks = estimatedTasks + partialTasks;
  return {
    status: knownTasks === 0
      ? "unavailable"
      : partialTasks > 0 || unavailableTasks > 0
        ? "partial"
        : "estimated",
    amountUsd: knownTasks ? roundUsd(amountUsd) : null,
    currency: SUBSCRIPTION_PRICING_CATALOG.currency,
    basis: SUBSCRIPTION_PRICING_CATALOG.basis,
    policyVersion: SUBSCRIPTION_PRICING_CATALOG.policyVersion,
    estimatedTasks,
    partialTasks,
    unavailableTasks,
    estimatedRequests,
    partialRequests,
    unavailableRequests,
    featureCoverage: combineFeatureCoverageObjects(coverage),
  };
}

function resolveRateCard(model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const normalized = model.trim().toLowerCase();
  const alias = MODEL_ALIASES[normalized];
  if (alias) return { model: alias, card: RATE_CARDS[alias] };
  for (const candidate of Object.keys(RATE_CARDS).sort((left, right) => right.length - left.length)) {
    if (normalized === candidate || normalized.startsWith(`${candidate}-20`)) {
      return { model: candidate, card: RATE_CARDS[candidate] };
    }
  }
  return null;
}

function unavailableCost(reason, model, now, resolved = null) {
  return {
    status: "unavailable",
    amountUsd: null,
    currency: PRICING_CATALOG.currency,
    basis: PRICING_CATALOG.basis,
    catalogVersion: PRICING_CATALOG.version,
    catalogStale: isCatalogStale(now),
    requestedModel: model ?? null,
    pricedModel: resolved?.model ?? null,
    ratesPerMillion: null,
    components: null,
    sourceUrl: resolved?.card.sourceUrl ?? null,
    limitations: [...PRICING_CATALOG.limitations],
    reason,
  };
}

function rateCard(inputUsdPerMillion, cachedInputUsdPerMillion, outputUsdPerMillion, cacheWriteMultiplier, sourceUrl) {
  return Object.freeze({
    inputUsdPerMillion,
    cachedInputUsdPerMillion,
    outputUsdPerMillion,
    cacheWriteMultiplier,
    sourceUrl,
  });
}

function validTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function priceTokens(tokens, usdPerMillion) {
  return tokens * usdPerMillion / MILLION;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

function isCatalogStale(now) {
  const value = now instanceof Date ? now.valueOf() : Number(now);
  return !Number.isFinite(value) || value > Date.parse(PRICING_CATALOG.reviewAfter);
}

function historicalRate(
  model,
  effectiveFrom,
  effectiveUntil,
  input,
  cachedInput,
  output,
  rateVersion,
) {
  return Object.freeze({
    model,
    effectiveFrom,
    effectiveUntil,
    rateVersion,
    ratesPerMillion: Object.freeze({ input, cachedInput, output }),
    sourceUrl: historicalSourceForModel(model),
  });
}

function historicalSourceForModel(model) {
  if (model === "gpt-5.4") return SUBSCRIPTION_PRICING_CATALOG.sources[0];
  if (model === "gpt-5.5") return SUBSCRIPTION_PRICING_CATALOG.sources[1];
  return SUBSCRIPTION_PRICING_CATALOG.sources[2];
}

function validateHistoricalCatalog(records) {
  const byModel = new Map();
  for (const record of records) {
    const from = timestampMs(record.effectiveFrom);
    const until = record.effectiveUntil == null ? Number.POSITIVE_INFINITY : timestampMs(record.effectiveUntil);
    if (!Number.isFinite(from) || !(until > from)) {
      throw new Error(`Invalid pricing interval: ${record.rateVersion}`);
    }
    const list = byModel.get(record.model) ?? [];
    list.push({ record, from, until });
    byModel.set(record.model, list);
  }
  for (const [model, intervals] of byModel) {
    intervals.sort((left, right) => left.from - right.from);
    for (let index = 1; index < intervals.length; index += 1) {
      if (intervals[index].from < intervals[index - 1].until) {
        throw new Error(`Overlapping pricing intervals for ${model}`);
      }
    }
  }
}

function normalizeHistoricalModel(model, instant) {
  if (typeof model !== "string" || !model.trim()) return null;
  const normalized = model.trim().toLowerCase();
  for (const alias of HISTORICAL_MODEL_ALIASES) {
    if (normalized !== alias.alias) continue;
    if (intervalContains(alias, instant)) return alias.model;
    return null;
  }
  const models = [...new Set(HISTORICAL_RATE_INTERVALS.map((record) => record.model))]
    .sort((left, right) => right.length - left.length);
  for (const candidate of models) {
    if (normalized === candidate || normalized.startsWith(`${candidate}-20`)) return candidate;
  }
  return null;
}

function intervalContains(record, instant) {
  const from = timestampMs(record.effectiveFrom);
  const until = record.effectiveUntil == null
    ? Number.POSITIVE_INFINITY
    : timestampMs(record.effectiveUntil);
  return instant >= from && instant < until;
}

function validateRequestUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = validTokenCount(usage.inputTokens);
  const cachedInputTokens = validTokenCount(usage.cachedInputTokens);
  const outputTokens = validTokenCount(usage.outputTokens);
  const cacheWriteInputTokens = usage.cacheWriteInputTokens == null
    ? 0
    : validTokenCount(usage.cacheWriteInputTokens);
  const reasoningOutputTokens = usage.reasoningOutputTokens == null
    ? 0
    : validTokenCount(usage.reasoningOutputTokens);
  const totalTokens = usage.totalTokens == null ? null : validTokenCount(usage.totalTokens);
  if (
    inputTokens == null ||
    cachedInputTokens == null ||
    outputTokens == null ||
    cacheWriteInputTokens == null ||
    reasoningOutputTokens == null ||
    cachedInputTokens > inputTokens ||
    cacheWriteInputTokens > inputTokens - cachedInputTokens ||
    (totalTokens != null && inputTokens + outputTokens !== totalTokens)
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function supportsLongContext(model) {
  return model === "gpt-5.4" || model === "gpt-5.5" || model.startsWith("gpt-5.6-");
}

function fastMultiplierForModel(model) {
  if (model.startsWith("gpt-5.6-") || model === "gpt-5.5") return 2.5;
  if (model === "gpt-5.4") return 2;
  return null;
}

function unavailableRequestCost(reason, model, observedAt, rate = null) {
  return {
    status: "unavailable",
    amountUsd: null,
    currency: SUBSCRIPTION_PRICING_CATALOG.currency,
    basis: SUBSCRIPTION_PRICING_CATALOG.basis,
    policyVersion: SUBSCRIPTION_PRICING_CATALOG.policyVersion,
    requestedModel: model ?? null,
    pricedModel: rate?.model ?? null,
    rateVersion: rate?.rateVersion ?? null,
    observedAt: observedAt ?? null,
    serviceTier: "unknown",
    rawServiceTier: null,
    longContextStatus: "unknown",
    ratesPerMillion: rate?.ratesPerMillion ? { ...rate.ratesPerMillion } : null,
    multipliers: null,
    featureCoverage: {
      historicalRate: rate ? "verified" : "unavailable",
      requestBoundary: "unknown",
      serviceTier: "unknown",
    },
    components: null,
    limitations: [...SUBSCRIPTION_PRICING_CATALOG.limitations],
    reason,
  };
}

function pricingTaskKey(threadId, turnId) {
  return `${threadId ?? ""}\u0000${turnId ?? ""}`;
}

function aggregateFeatureCoverage(values) {
  const normalized = [...new Set((values ?? []).filter(Boolean))];
  if (normalized.length === 0) return "unknown";
  if (normalized.length === 1) return normalized[0];
  return "partial";
}

function combineFeatureCoverageObjects(items) {
  const keys = ["historicalRate", "requestBoundary", "serviceTier"];
  return Object.fromEntries(keys.map((key) => [
    key,
    aggregateFeatureCoverage((items ?? []).map((item) => item?.[key]).filter(Boolean)),
  ]));
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
