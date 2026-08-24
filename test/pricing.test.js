import assert from "node:assert/strict";
import test from "node:test";
import {
  combineCostSummaries,
  estimateTaskCost,
  pricingCatalogSummary,
  summarizeTaskCosts,
} from "../src/pricing.js";

const CATALOG_DATE = Date.parse("2026-08-24T00:00:00.000Z");

test("GPT-5.6 cost separates cached reads and cache writes without double-counting reasoning", () => {
  const estimate = estimateTaskCost("gpt-5.6-sol", {
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 50_000,
    reasoningOutputTokens: 40_000,
    totalTokens: 1_050_000,
  }, CATALOG_DATE);

  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.amountUsd, 4.38);
  assert.deepEqual(estimate.components, {
    uncachedInputTokens: 700_000,
    cachedInputTokens: 200_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 50_000,
    uncachedInputUsd: 2.8,
    cachedInputUsd: 0.08,
    cacheWriteInputUsd: 0.5,
    outputUsd: 1,
  });
  assert.equal(estimate.catalogStale, false);
});

test("aliases and dated snapshots resolve only to documented model families", () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 100_000,
  };
  assert.equal(estimateTaskCost("gpt-5.6", usage, CATALOG_DATE).pricedModel, "gpt-5.6-sol");
  assert.equal(estimateTaskCost("gpt-5.5-2026-04-23", usage, CATALOG_DATE).amountUsd, 7.1);
  assert.equal(estimateTaskCost("codex-auto-review", usage, CATALOG_DATE).status, "unavailable");
  assert.equal(estimateTaskCost("codex-auto-review", usage, CATALOG_DATE).reason, "unsupported_model");
});

test("incomplete or inconsistent token breakdowns never produce false precision", () => {
  const incomplete = estimateTaskCost("gpt-5.6-terra", {
    inputTokens: 100,
    cachedInputTokens: null,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
  }, CATALOG_DATE);
  const inconsistent = estimateTaskCost("gpt-5.6-luna", {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 30,
    outputTokens: 20,
    totalTokens: 120,
  }, CATALOG_DATE);
  const totalOnly = estimateTaskCost("gpt-5.6-luna", {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 20,
  }, CATALOG_DATE);
  assert.equal(incomplete.reason, "incomplete_usage_breakdown");
  assert.equal(inconsistent.reason, "inconsistent_usage_breakdown");
  assert.equal(totalOnly.reason, "inconsistent_usage_breakdown");
  assert.equal(incomplete.amountUsd, null);
  assert.equal(inconsistent.amountUsd, null);
  assert.equal(totalOnly.amountUsd, null);
});

test("task cost summaries disclose partial coverage and catalog review state", () => {
  const tasks = [
    { costEstimate: { status: "estimated", amountUsd: 1.25 } },
    { costEstimate: { status: "unavailable", amountUsd: null } },
  ];
  assert.deepEqual(summarizeTaskCosts(tasks), {
    status: "partial",
    amountUsd: 1.25,
    currency: "USD",
    estimatedTasks: 1,
    unavailableTasks: 1,
  });
  assert.equal(pricingCatalogSummary(Date.parse("2026-11-22T00:00:00.000Z")).stale, true);
});

test("cost rollups sum known amounts while preserving unavailable coverage", () => {
  assert.deepEqual(combineCostSummaries([
    {
      status: "estimated",
      amountUsd: 1.25,
      currency: "USD",
      estimatedTasks: 2,
      unavailableTasks: 0,
    },
    {
      status: "partial",
      amountUsd: 0.5,
      currency: "USD",
      estimatedTasks: 1,
      unavailableTasks: 2,
    },
    {
      status: "unavailable",
      amountUsd: null,
      currency: "USD",
      estimatedTasks: 0,
      unavailableTasks: 0,
    },
  ]), {
    status: "partial",
    amountUsd: 1.75,
    currency: "USD",
    estimatedTasks: 3,
    unavailableTasks: 2,
  });
});
