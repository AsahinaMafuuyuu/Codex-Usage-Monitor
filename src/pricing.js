const MILLION = 1_000_000;

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

export function pricingCatalogSummary(now = Date.now()) {
  return {
    ...PRICING_CATALOG,
    limitations: [...PRICING_CATALOG.limitations],
    sources: [...PRICING_CATALOG.sources],
    stale: isCatalogStale(now),
    supportedModels: Object.keys(RATE_CARDS),
  };
}

export function summarizeTaskCosts(tasks) {
  let amountUsd = 0;
  let estimatedTasks = 0;
  let unavailableTasks = 0;
  for (const task of tasks) {
    if (task.costEstimate?.status === "estimated") {
      amountUsd += task.costEstimate.amountUsd;
      estimatedTasks += 1;
    } else {
      unavailableTasks += 1;
    }
  }
  return costSummary(amountUsd, estimatedTasks, unavailableTasks);
}

export function combineCostSummaries(summaries) {
  let amountUsd = 0;
  let estimatedTasks = 0;
  let unavailableTasks = 0;
  for (const summary of summaries) {
    if (!summary) continue;
    amountUsd += summary.amountUsd ?? 0;
    estimatedTasks += summary.estimatedTasks ?? 0;
    unavailableTasks += summary.unavailableTasks ?? 0;
  }
  return costSummary(amountUsd, estimatedTasks, unavailableTasks);
}

function costSummary(amountUsd, estimatedTasks, unavailableTasks) {
  return {
    status: estimatedTasks === 0
      ? "unavailable"
      : unavailableTasks > 0
        ? "partial"
        : "estimated",
    amountUsd: estimatedTasks ? roundUsd(amountUsd) : null,
    currency: PRICING_CATALOG.currency,
    estimatedTasks,
    unavailableTasks,
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
