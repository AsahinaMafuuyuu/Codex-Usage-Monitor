import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUsageDiagnostics } from "../src/diagnostics.js";

function fact(index, {
  inputTokens = 100_000,
  cachedInputTokens = 80_000,
  costEstimate = estimatedCost(0.2),
  model = "gpt-5.6-sol",
  effort = "high",
  serviceTier = "standard",
  threadId = "thread-1",
  turnId = "turn-1",
  classification = "verified_increment",
  inScope = true,
  observedAt = `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`,
} = {}) {
  return {
    requestId: `request-${String(index).padStart(2, "0")}`,
    rootSessionId: "session-1",
    threadId,
    turnId,
    observedAt,
    classification,
    quality: "complete",
    model,
    effort,
    serviceTier,
    inScope,
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + 1_000,
    },
    costEstimate,
  };
}

function estimatedCost(amountUsd, overrides = {}) {
  return {
    status: "estimated",
    amountUsd,
    serviceTier: "standard",
    longContextCandidate: false,
    longContextStatus: "normal",
    ...overrides,
  };
}

test("Usage Diagnostics does not report local-baseline anomalies before three prior samples", () => {
  const report = analyzeUsageDiagnostics([
    fact(1),
    fact(2),
    fact(3, { inputTokens: 300_000 }),
  ]);
  assert.equal(report.findings.some((finding) => finding.type === "context_inflation"), false);
});

test("Context Inflation requires both the relative and absolute growth gates", () => {
  const report = analyzeUsageDiagnostics([
    fact(1),
    fact(2),
    fact(3),
    fact(4, { inputTokens: 134_000 }),
    fact(5, { inputTokens: 135_000 }),
  ]);
  const findings = report.findings.filter((finding) => finding.type === "context_inflation");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].requestId, "request-05");
  assert.equal(findings[0].severity, "warning");
  assert.equal(findings[0].metric.baseline, 100_000);
  assert.equal(findings[0].metric.absoluteDelta, 35_000);
  assert.equal(findings[0].baseline.sampleCount, 4);
});

test("rolling median resists one extreme input sample", () => {
  const report = analyzeUsageDiagnostics([
    fact(1),
    fact(2),
    fact(3, { inputTokens: 1_000_000 }),
    fact(4),
    fact(5, { inputTokens: 135_000 }),
  ]);
  const finding = report.findings.find((candidate) => candidate.type === "context_inflation" && candidate.requestId === "request-05");
  assert.ok(finding);
  assert.equal(finding.metric.baseline, 100_000);
});

test("Cache Regression uses percentage-point drop with an exact 20pp warning boundary", () => {
  const below = analyzeUsageDiagnostics([
    fact(1, { cachedInputTokens: 90_000 }),
    fact(2, { cachedInputTokens: 90_000 }),
    fact(3, { cachedInputTokens: 90_000 }),
    fact(4, { cachedInputTokens: 71_000 }),
  ]);
  assert.equal(below.findings.some((finding) => finding.type === "cache_regression"), false);

  const atBoundary = analyzeUsageDiagnostics([
    fact(1, { cachedInputTokens: 90_000 }),
    fact(2, { cachedInputTokens: 90_000 }),
    fact(3, { cachedInputTokens: 90_000 }),
    fact(4, { cachedInputTokens: 70_000 }),
  ]);
  const finding = atBoundary.findings.find((candidate) => candidate.type === "cache_regression");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
  assert.equal(finding.metric.baseline, 0.9);
  assert.equal(finding.metric.current, 0.7);
  assert.equal(finding.evidence.breakpointCandidate, true);
});

test("Cache Regression ignores current requests below the minimum input threshold", () => {
  const report = analyzeUsageDiagnostics([
    fact(1, { cachedInputTokens: 90_000 }),
    fact(2, { cachedInputTokens: 90_000 }),
    fact(3, { cachedInputTokens: 90_000 }),
    fact(4, { inputTokens: 7_000, cachedInputTokens: 0 }),
  ]);
  assert.equal(report.findings.some((finding) => finding.type === "cache_regression"), false);
});

test("Cache Regression marks only the first significant drop as the breakpoint candidate", () => {
  const report = analyzeUsageDiagnostics([
    fact(1, { cachedInputTokens: 90_000 }),
    fact(2, { cachedInputTokens: 90_000 }),
    fact(3, { cachedInputTokens: 90_000 }),
    fact(4, { cachedInputTokens: 50_000 }),
    fact(5, { cachedInputTokens: 50_000 }),
    fact(6, { cachedInputTokens: 50_000 }),
  ]);
  const findings = report.findings.filter((finding) => finding.type === "cache_regression");
  assert.equal(findings.length, 3);
  assert.equal(findings[0].requestId, "request-04");
  assert.equal(findings[0].evidence.breakpointCandidate, true);
  assert.equal(findings[1].evidence.breakpointCandidate, false);
  assert.equal(findings[2].evidence.breakpointCandidate, false);
});

test("Cost Spike uses the enriched request cost and requires the ratio plus absolute gates", () => {
  const below = analyzeUsageDiagnostics([
    fact(1, { costEstimate: estimatedCost(0.20) }),
    fact(2, { costEstimate: estimatedCost(0.20) }),
    fact(3, { costEstimate: estimatedCost(0.20) }),
    fact(4, { costEstimate: estimatedCost(0.34) }),
  ]);
  assert.equal(below.findings.some((finding) => finding.type === "cost_spike"), false);

  const atBoundary = analyzeUsageDiagnostics([
    fact(1, { costEstimate: estimatedCost(0.20) }),
    fact(2, { costEstimate: estimatedCost(0.20) }),
    fact(3, { costEstimate: estimatedCost(0.20) }),
    fact(4, { costEstimate: estimatedCost(0.35) }),
  ]);
  const finding = atBoundary.findings.find((candidate) => candidate.type === "cost_spike");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
  assert.equal(finding.metric.baseline, 0.20);
  assert.equal(finding.metric.current, 0.35);
  assert.equal(finding.evidence.pricingStatus, "estimated");
});

test("Cost Spike excludes partial costs from both the current candidate and the baseline", () => {
  const partialBaseline = analyzeUsageDiagnostics([
    fact(1, { costEstimate: estimatedCost(0.20) }),
    fact(2, { costEstimate: estimatedCost(0.20) }),
    fact(3, { costEstimate: estimatedCost(10, { status: "partial" }) }),
    fact(4, { costEstimate: estimatedCost(0.35) }),
  ]);
  assert.equal(partialBaseline.findings.some((finding) => finding.type === "cost_spike"), false);

  const partialCurrent = analyzeUsageDiagnostics([
    fact(1, { costEstimate: estimatedCost(0.20) }),
    fact(2, { costEstimate: estimatedCost(0.20) }),
    fact(3, { costEstimate: estimatedCost(0.20) }),
    fact(4, { costEstimate: estimatedCost(1, { status: "partial" }) }),
  ]);
  assert.equal(partialCurrent.findings.some((finding) => finding.type === "cost_spike"), false);
});

test("Cost Spike does not mix standard and fast service-tier baselines", () => {
  const report = analyzeUsageDiagnostics([
    fact(1, { costEstimate: estimatedCost(0.20, { serviceTier: "standard" }) }),
    fact(2, { costEstimate: estimatedCost(0.20, { serviceTier: "standard" }) }),
    fact(3, { costEstimate: estimatedCost(0.20, { serviceTier: "standard" }) }),
    fact(4, {
      serviceTier: "fast",
      costEstimate: estimatedCost(0.60, { serviceTier: "fast" }),
    }),
  ]);
  assert.equal(report.findings.some((finding) => finding.type === "cost_spike"), false);
});

test("Long Context Trigger consumes pricing feature evidence instead of reimplementing the token threshold", () => {
  const pricingCandidate = analyzeUsageDiagnostics([
    fact(1, {
      inputTokens: 100_000,
      costEstimate: estimatedCost(0.2, {
        status: "partial",
        longContextCandidate: true,
        longContextStatus: "candidate",
      }),
    }),
  ]);
  const finding = pricingCandidate.findings.find((candidate) => candidate.type === "long_context_trigger");
  assert.ok(finding);
  assert.equal(finding.severity, "info");
  assert.equal(finding.evidence.longContextStatus, "candidate");

  const rawTokenOnly = analyzeUsageDiagnostics([
    fact(1, {
      inputTokens: 300_000,
      costEstimate: estimatedCost(1.5, {
        longContextCandidate: false,
        longContextStatus: "normal",
      }),
    }),
  ]);
  assert.equal(rawTokenOnly.findings.some((candidate) => candidate.type === "long_context_trigger"), false);
});

test("non-canonical duplicate evidence never becomes a diagnostic sample or finding", () => {
  const report = analyzeUsageDiagnostics([
    fact(1),
    fact(2),
    fact(3),
    fact(4, {
      inputTokens: 500_000,
      cachedInputTokens: 0,
      costEstimate: estimatedCost(5, { longContextCandidate: true, longContextStatus: "long" }),
      classification: "duplicate",
    }),
  ]);
  assert.deepEqual(report.summary, { high: 0, warning: 0, info: 0 });
  assert.equal(report.findings.length, 0);
});

test("same request and policy produce a deterministic finding id", () => {
  const facts = [fact(1), fact(2), fact(3), fact(4, { inputTokens: 200_000 })];
  const first = analyzeUsageDiagnostics(facts).findings.find((finding) => finding.type === "context_inflation");
  const second = analyzeUsageDiagnostics(facts).findings.find((finding) => finding.type === "context_inflation");
  assert.ok(first);
  assert.equal(first.findingId, second.findingId);
  assert.equal(first.policyVersion, "usage-diagnostics-v1");
});

test("day output filtering preserves pre-day baseline semantics for the same request", () => {
  const preDay = [
    fact(1, { observedAt: "2026-08-25T20:00:00.000Z" }),
    fact(2, { observedAt: "2026-08-25T21:00:00.000Z" }),
    fact(3, { observedAt: "2026-08-25T22:00:00.000Z" }),
  ];
  const target = fact(4, { observedAt: "2026-08-26T08:00:00.000Z", inputTokens: 200_000 });
  const sessionFinding = analyzeUsageDiagnostics([...preDay, target]).findings
    .find((finding) => finding.type === "context_inflation" && finding.requestId === target.requestId);
  const dayFinding = analyzeUsageDiagnostics([
    ...preDay.map((entry) => ({ ...entry, inScope: false })),
    { ...target, inScope: true },
  ]).findings.find((finding) => finding.type === "context_inflation" && finding.requestId === target.requestId);
  assert.ok(sessionFinding);
  assert.ok(dayFinding);
  assert.deepEqual(dayFinding.metric, sessionFinding.metric);
  assert.deepEqual(dayFinding.baseline, sessionFinding.baseline);
  assert.equal(dayFinding.severity, sessionFinding.severity);
  assert.equal(dayFinding.locator.requestOrdinalInScope, 1);
});

test("day output filtering does not redefine a cache breakpoint that occurred before dayStart", () => {
  const facts = [
    fact(1, { cachedInputTokens: 90_000, observedAt: "2026-08-25T19:00:00.000Z" }),
    fact(2, { cachedInputTokens: 90_000, observedAt: "2026-08-25T20:00:00.000Z" }),
    fact(3, { cachedInputTokens: 90_000, observedAt: "2026-08-25T21:00:00.000Z" }),
    fact(4, { cachedInputTokens: 50_000, observedAt: "2026-08-25T22:00:00.000Z" }),
    fact(5, { cachedInputTokens: 50_000, observedAt: "2026-08-26T08:00:00.000Z" }),
  ];
  const sessionTarget = analyzeUsageDiagnostics(facts).findings.find(
    (finding) => finding.type === "cache_regression" && finding.requestId === "request-05",
  );
  const dayTarget = analyzeUsageDiagnostics(facts.map((entry, index) => ({
    ...entry,
    inScope: index === 4,
  }))).findings.find(
    (finding) => finding.type === "cache_regression" && finding.requestId === "request-05",
  );
  assert.ok(sessionTarget);
  assert.ok(dayTarget);
  assert.equal(sessionTarget.evidence.breakpointCandidate, false);
  assert.equal(dayTarget.evidence.breakpointCandidate, false);
});

test("task baseline falls back only to prior session requests with the same model and effort", () => {
  const report = analyzeUsageDiagnostics([
    fact(1, { threadId: "thread-a", turnId: "turn-a" }),
    fact(2, { threadId: "thread-a", turnId: "turn-a" }),
    fact(3, { threadId: "thread-a", turnId: "turn-a" }),
    fact(4, { threadId: "thread-b", turnId: "turn-b", inputTokens: 200_000 }),
  ]);
  const finding = report.findings.find((candidate) => candidate.type === "context_inflation" && candidate.requestId === "request-04");
  assert.ok(finding);
  assert.equal(finding.baseline.kind, "session_model_effort_rolling_median");

  const differentModel = analyzeUsageDiagnostics([
    fact(1),
    fact(2),
    fact(3),
    fact(4, { threadId: "thread-b", turnId: "turn-b", model: "gpt-5.6-terra", inputTokens: 200_000 }),
  ]);
  assert.equal(
    differentModel.findings.some((candidate) => candidate.type === "context_inflation" && candidate.requestId === "request-04"),
    false,
  );
});
