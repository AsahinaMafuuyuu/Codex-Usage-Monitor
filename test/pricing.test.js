import assert from "node:assert/strict";
import test from "node:test";
import {
  combineCostSummaries,
  estimateRequestCost,
  normalizeServiceTier,
  pricingCatalogSummary,
  resolveHistoricalRate,
  summarizeTaskCosts,
} from "../src/pricing.js";

const AT = (value) => `${value}T00:00:00.000Z`;

function request({
  model = "gpt-5.6-sol",
  observedAt = AT("2026-08-26"),
  serviceTier = "default",
  inputTokens = 1_000_000,
  cachedInputTokens = 800_000,
  cacheWriteInputTokens = 0,
  outputTokens = 100_000,
  reasoningOutputTokens = 0,
  totalTokens = inputTokens + outputTokens,
} = {}) {
  return {
    classification: "verified_increment",
    model,
    observedAt,
    serviceTier,
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
    },
  };
}

test("T-COST-001 GPT-5.6 launch standard rates", () => {
  assert.deepEqual(resolveHistoricalRate("gpt-5.6-sol", AT("2026-07-09")).ratesPerMillion, {
    input: 5,
    cachedInput: 0.5,
    output: 30,
  });
  assert.deepEqual(resolveHistoricalRate("gpt-5.6-terra", AT("2026-07-09")).ratesPerMillion, {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
  });
  assert.deepEqual(resolveHistoricalRate("gpt-5.6-luna", AT("2026-07-09")).ratesPerMillion, {
    input: 1,
    cachedInput: 0.1,
    output: 6,
  });
});

test("T-COST-002 Terra/Luna switch rates at 2026-07-30", () => {
  assert.equal(
    resolveHistoricalRate("gpt-5.6-terra", "2026-07-29T23:59:59.999Z").ratesPerMillion.input,
    2.5,
  );
  assert.deepEqual(resolveHistoricalRate("gpt-5.6-terra", AT("2026-07-30")).ratesPerMillion, {
    input: 2,
    cachedInput: 0.2,
    output: 12,
  });
  assert.deepEqual(resolveHistoricalRate("gpt-5.6-luna", AT("2026-07-30")).ratesPerMillion, {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
  });
});

test("T-COST-003 Sol API promotion never changes subscription-standard rate", () => {
  for (const observedAt of [AT("2026-08-20"), AT("2026-08-21"), AT("2026-08-26")]) {
    assert.deepEqual(resolveHistoricalRate("gpt-5.6-sol", observedAt).ratesPerMillion, {
      input: 5,
      cachedInput: 0.5,
      output: 30,
    });
  }
});

test("T-COST-004 historical GPT-5.5/GPT-5.4 honor their proven start dates", () => {
  assert.deepEqual(resolveHistoricalRate("gpt-5.5", AT("2026-04-23")).ratesPerMillion, {
    input: 5,
    cachedInput: 0.5,
    output: 30,
  });
  assert.deepEqual(resolveHistoricalRate("gpt-5.4", AT("2026-03-05")).ratesPerMillion, {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
  });
  assert.equal(resolveHistoricalRate("gpt-5.5", AT("2026-04-22")), null);
  assert.equal(resolveHistoricalRate("gpt-5.4", AT("2026-03-04")), null);
});

test("T-COST-005 aliases and dated model ids resolve only inside proven intervals", () => {
  assert.equal(resolveHistoricalRate("gpt-5.6", AT("2026-07-09")).model, "gpt-5.6-sol");
  assert.equal(resolveHistoricalRate("gpt-5.6", AT("2026-07-08")), null);
  assert.equal(resolveHistoricalRate("gpt-5.5-2026-04-23", AT("2026-08-26")).model, "gpt-5.5");
  assert.equal(resolveHistoricalRate("codex-auto-review", AT("2026-08-26")), null);
});

test("T-COST-006 unsupported dates do not fall back to nearest rate", () => {
  assert.equal(resolveHistoricalRate("gpt-5.6-terra", AT("2026-07-08")), null);
  assert.equal(resolveHistoricalRate("unknown-model", AT("2026-08-26")), null);
});

test("T-COST-010 cached input is a subset of input", () => {
  const estimate = estimateRequestCost(request(), { applyFeaturePolicy: false });
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.amountUsd, 4.4);
  assert.equal(estimate.components.uncachedInputTokens, 200_000);
  assert.equal(estimate.components.cachedInputTokens, 800_000);
  assert.equal(estimate.components.outputTokens, 100_000);
});

test("T-COST-011 reasoning tokens are not charged twice", () => {
  const withoutReasoning = estimateRequestCost(request({ reasoningOutputTokens: 0 }), {
    applyFeaturePolicy: false,
  });
  const withReasoning = estimateRequestCost(request({ reasoningOutputTokens: 90_000 }), {
    applyFeaturePolicy: false,
  });
  assert.equal(withReasoning.amountUsd, withoutReasoning.amountUsd);
  assert.equal(withReasoning.components.outputTokens, 100_000);
});

test("T-COST-012 subscription policy does not add API cache-write surcharge", () => {
  const withoutWrite = estimateRequestCost(request({ cacheWriteInputTokens: 0 }), {
    applyFeaturePolicy: false,
  });
  const withWrite = estimateRequestCost(request({ cacheWriteInputTokens: 150_000 }), {
    applyFeaturePolicy: false,
  });
  assert.equal(withWrite.amountUsd, withoutWrite.amountUsd);
  assert.equal(withWrite.components.cacheWriteInputTokens, 150_000);
  assert.equal(withWrite.components.uncachedInputTokens, 200_000);
  assert.equal(withWrite.components.cacheWriteInputUsd, 0);
});

test("T-COST-013 inconsistent usage never produces false precision", () => {
  const cachedTooLarge = estimateRequestCost(request({
    inputTokens: 100,
    cachedInputTokens: 101,
    outputTokens: 10,
    totalTokens: 110,
  }));
  const badTotal = estimateRequestCost(request({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    totalTokens: 999,
  }));
  const missingUsage = estimateRequestCost({
    classification: "verified_increment",
    model: "gpt-5.6-sol",
    observedAt: AT("2026-08-26"),
    serviceTier: "default",
    usage: null,
  });
  for (const estimate of [cachedTooLarge, badTotal, missingUsage]) {
    assert.equal(estimate.status, "unavailable");
    assert.equal(estimate.amountUsd, null);
  }
});

test("T-COST-030 service tier normalization is evidence preserving", () => {
  assert.equal(normalizeServiceTier("default"), "standard");
  assert.equal(normalizeServiceTier("fast"), "fast");
  assert.equal(normalizeServiceTier("priority"), "fast");
  assert.equal(normalizeServiceTier(null), "unknown");
  assert.equal(normalizeServiceTier("mystery"), "unknown");
});

test("T-COST-020 long context uses a strict greater-than 272K boundary", () => {
  const normal = estimateRequestCost(request({
    inputTokens: 272_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 272_000,
  }));
  const long = estimateRequestCost(request({
    inputTokens: 272_001,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 272_001,
  }));
  assert.equal(normal.longContextStatus, "normal");
  assert.equal(normal.multipliers.input, 1);
  assert.equal(long.longContextStatus, "long");
  assert.equal(long.multipliers.input, 2);
  assert.equal(long.multipliers.output, 1.5);
});

test("T-COST-021 long-context multipliers apply to the full request", () => {
  const estimate = estimateRequestCost(request({
    inputTokens: 300_000,
    cachedInputTokens: 250_000,
    outputTokens: 10_000,
    totalTokens: 310_000,
  }));
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.amountUsd, 1.2);
  assert.equal(estimate.components.uncachedInputUsd, 0.5);
  assert.equal(estimate.components.cachedInputUsd, 0.25);
  assert.equal(estimate.components.outputUsd, 0.45);
});

test("T-COST-022 task aggregate above 272K does not make ordinary requests long", () => {
  const first = estimateRequestCost(request({
    inputTokens: 200_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 200_000,
  }));
  const second = estimateRequestCost(request({
    inputTokens: 200_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 200_000,
  }));
  assert.equal(first.longContextStatus, "normal");
  assert.equal(second.longContextStatus, "normal");
  assert.equal(first.amountUsd + second.amountUsd, 2);
});

test("T-COST-023 mixed task applies long multiplier only to the qualifying request", () => {
  const long = estimateRequestCost(request({
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 300_000,
  }));
  const normal = estimateRequestCost(request({
    inputTokens: 100_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 100_000,
  }));
  assert.equal(long.longContextStatus, "long");
  assert.equal(long.amountUsd, 3);
  assert.equal(normal.longContextStatus, "normal");
  assert.equal(normal.amountUsd, 0.5);
  assert.equal(long.amountUsd + normal.amountUsd, 3.5);
});

test("T-COST-024 unproven request boundary reports a candidate without applying surcharge", () => {
  const estimate = estimateRequestCost(request({
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 300_000,
  }), { requestBoundaryVerified: false });
  assert.equal(estimate.status, "partial");
  assert.equal(estimate.longContextStatus, "candidate");
  assert.equal(estimate.amountUsd, 1.5);
  assert.equal(estimate.multipliers.input, 1);
  assert.equal(estimate.featureCoverage.requestBoundary, "unproven");
  assert.equal(estimate.reason, "long_context_request_boundary_unproven");
});

test("T-COST-025 an unsupported long-context model is never guessed into a priced family", () => {
  const estimate = estimateRequestCost(request({
    model: "unknown-long-model",
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 300_000,
  }));
  assert.equal(estimate.status, "unavailable");
  assert.equal(estimate.amountUsd, null);
  assert.equal(estimate.reason, "historical_rate_unavailable");
});

test("T-COST-031 Fast multiplier follows model family", () => {
  const cases = [
    ["gpt-5.6-sol", AT("2026-08-26"), 1.25, 2.5],
    ["gpt-5.5", AT("2026-08-26"), 1.25, 2.5],
    ["gpt-5.4", AT("2026-08-26"), 0.5, 2],
  ];
  for (const [model, observedAt, amountUsd, multiplier] of cases) {
    const estimate = estimateRequestCost(request({
      model,
      observedAt,
      serviceTier: "fast",
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 100_000,
    }));
    assert.equal(estimate.status, "estimated");
    assert.equal(estimate.amountUsd, amountUsd);
    assert.equal(estimate.multipliers.fast, multiplier);
  }
});

test("T-COST-032 missing tier keeps known base amount but lowers feature coverage", () => {
  const estimate = estimateRequestCost(request({
    serviceTier: null,
    inputTokens: 100_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 100_000,
  }));
  assert.equal(estimate.status, "partial");
  assert.equal(estimate.amountUsd, 0.5);
  assert.equal(estimate.featureCoverage.serviceTier, "unknown");
  assert.equal(estimate.reason, "service_tier_unknown");
});

test("T-COST-034 Fast and long context are never multiplied together", () => {
  const estimate = estimateRequestCost(request({
    serviceTier: "priority",
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 10_000,
    totalTokens: 310_000,
  }));
  assert.equal(estimate.status, "partial");
  assert.equal(estimate.reason, "unsupported_feature_combination");
  assert.equal(estimate.amountUsd, 1.8);
  assert.equal(estimate.multipliers.input, 1);
  assert.equal(estimate.multipliers.output, 1);
  assert.equal(estimate.multipliers.fast, 1);
});

test("legacy rollup helpers remain stable before the public contract cutover", () => {
  assert.equal(pricingCatalogSummary().basis, "openai-standard-api-short-context");
  assert.deepEqual(summarizeTaskCosts([
    { costEstimate: { status: "estimated", amountUsd: 1.25 } },
    { costEstimate: { status: "unavailable", amountUsd: null } },
  ]), {
    status: "partial",
    amountUsd: 1.25,
    currency: "USD",
    estimatedTasks: 1,
    unavailableTasks: 1,
  });
  assert.deepEqual(combineCostSummaries([
    { status: "estimated", amountUsd: 1.25, estimatedTasks: 2, unavailableTasks: 0 },
    { status: "partial", amountUsd: 0.5, estimatedTasks: 1, unavailableTasks: 2 },
  ]), {
    status: "partial",
    amountUsd: 1.75,
    currency: "USD",
    estimatedTasks: 3,
    unavailableTasks: 2,
  });
});
