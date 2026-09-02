import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCED_USAGE_DIAGNOSTICS_POLICY,
  analyzeAdvancedUsageDiagnostics,
} from "../src/advanced-diagnostics.js";

function requestFact({
  requestId,
  rootSessionId,
  observedAt,
  inputTokens,
  cachedInputTokens = Math.round(inputTokens * 0.8),
  projectPath = "D:\\work\\alpha",
  model = "gpt-5.6-sol",
  effort = "high",
  serviceTier = "standard",
  amountUsd = inputTokens / 500_000,
  rateVersion = "gpt-5.6-sol-2026-08-01",
} = {}) {
  return {
    requestId,
    rootSessionId,
    threadId: `${rootSessionId}-thread`,
    turnId: `${rootSessionId}-turn`,
    observedAt,
    classification: "verified_increment",
    quality: "complete",
    projectPath,
    model,
    effort,
    serviceTier,
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
      reasoningOutputTokens: 100,
      totalTokens: inputTokens + 1_000,
    },
    costEstimate: {
      status: "estimated",
      amountUsd,
      serviceTier,
      rateVersion,
      longContextCandidate: false,
      longContextStatus: "normal",
    },
  };
}

test("Historical Context candidate uses strict prior-session median/MAD and robust Z", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `history-${index + 1}`,
    rootSessionId: `history-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    inputTokens: (81 + index) * 1_000,
  }));
  const current = requestFact({
    requestId: "current-1",
    rootSessionId: "current-session",
    observedAt: "2026-08-25T10:00:00.000Z",
    inputTokens: 150_000,
  });

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts: [current],
    historicalFacts,
    scope: { type: "session" },
  }, ADVANCED_USAGE_DIAGNOSTICS_POLICY);

  const candidate = report.candidates.find((entry) => entry.type === "historical_context_inflation");
  assert.ok(candidate);
  assert.equal(candidate.requestId, "current-1");
  assert.equal(candidate.baseline.sampleCount, 20);
  assert.equal(candidate.baseline.median, 90_500);
  assert.equal(candidate.baseline.mad, 5_000);
  assert.ok(Math.abs(candidate.baseline.robustZ - 8.026428025) < 1e-9);
  assert.deepEqual(candidate.effect, {
    absolute: 59_500,
    ratio: 150_000 / 90_500,
    percentagePoints: null,
  });
  assert.equal(candidate.shadowSeverity, "warning");
  assert.equal(report.policy.version, "advanced-usage-diagnostics-v1");
  assert.equal(report.policy.frozen, true);
  const finding = report.findings.find((entry) => entry.type === "historical_context_inflation");
  assert.ok(finding);
  assert.equal(finding.severity, "warning");
  assert.equal(finding.policyVersion, "advanced-usage-diagnostics-v1");
  assert.equal(finding.threadId, "current-session-thread");
  assert.equal(finding.turnId, "current-session-turn");
  assert.equal(finding.locator.requestOrdinalInScope, 1);
  const repeated = analyzeAdvancedUsageDiagnostics({
    currentFacts: [current],
    historicalFacts,
    scope: { type: "session" },
  }).findings.find((entry) => entry.type === "historical_context_inflation");
  assert.equal(repeated.findingId, finding.findingId);
  assert.equal(candidate.cohort.projectPath, "D:\\work\\alpha");
  assert.equal(candidate.cohort.model, "gpt-5.6-sol");
  assert.equal(candidate.cohort.effort, "high");
});

test("MAD=0 is reported as degenerate and never converted to Infinity", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `flat-${index + 1}`,
    rootSessionId: `flat-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
    inputTokens: 100_000,
  }));
  const current = requestFact({
    requestId: "flat-current",
    rootSessionId: "flat-current-session",
    observedAt: "2026-08-25T09:00:00.000Z",
    inputTokens: 200_000,
  });

  const report = analyzeAdvancedUsageDiagnostics({ currentFacts: [current], historicalFacts });
  const candidate = report.candidates.find((entry) => entry.type === "historical_context_inflation");
  assert.ok(candidate);
  assert.equal(candidate.baseline.status, "degenerate");
  assert.equal(candidate.baseline.mad, 0);
  assert.equal(candidate.baseline.robustZ, null);
  assert.equal(report.coverage.degenerateMad, 3);
});

test("strict cohort refuses unknown effort and reports insufficient history without fallback", () => {
  const sparseHistory = Array.from({ length: 19 }, (_, index) => requestFact({
    requestId: `sparse-${index + 1}`,
    rootSessionId: `sparse-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    inputTokens: 90_000 + index * 500,
  }));
  const currentKnown = requestFact({
    requestId: "sparse-current",
    rootSessionId: "sparse-current-session",
    observedAt: "2026-08-25T08:00:00.000Z",
    inputTokens: 180_000,
  });
  const currentUnknown = requestFact({
    requestId: "unknown-current",
    rootSessionId: "unknown-current-session",
    observedAt: "2026-08-25T08:05:00.000Z",
    inputTokens: 180_000,
    effort: null,
  });

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts: [currentKnown, currentUnknown],
    historicalFacts: sparseHistory,
  });

  assert.equal(report.candidates.length, 0);
  assert.equal(report.coverage.insufficientHistory, 1);
  assert.equal(report.coverage.unknownEffort, 1);
});

test("Historical Cache candidate uses a lower-tail robust baseline with a minimum-input gate", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `cache-${index + 1}`,
    rootSessionId: `cache-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T07:00:00.000Z`,
    inputTokens: 100_000,
    cachedInputTokens: (70_000 + index * 1_000),
  }));
  const current = requestFact({
    requestId: "cache-current",
    rootSessionId: "cache-current-session",
    observedAt: "2026-08-25T07:00:00.000Z",
    inputTokens: 100_000,
    cachedInputTokens: 40_000,
  });

  const report = analyzeAdvancedUsageDiagnostics({ currentFacts: [current], historicalFacts });
  const candidate = report.candidates.find((entry) => entry.type === "historical_cache_regression");
  assert.ok(candidate);
  assert.equal(candidate.metric.current, 0.4);
  assert.equal(candidate.baseline.median, 0.795);
  assert.ok(Math.abs(candidate.baseline.mad - 0.05) < 1e-12);
  assert.ok(candidate.baseline.robustZ < -5);
});

test("Historical Cost candidate isolates service tier and pricing rate version", () => {
  const comparable = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `cost-${index + 1}`,
    rootSessionId: `cost-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T06:00:00.000Z`,
    inputTokens: 100_000,
    amountUsd: 0.18 + index * 0.002,
    serviceTier: "standard",
    rateVersion: "rate-a",
  }));
  const incompatible = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `cost-fast-${index + 1}`,
    rootSessionId: `cost-fast-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T06:05:00.000Z`,
    inputTokens: 100_000,
    amountUsd: 4 + index,
    serviceTier: "fast",
    rateVersion: "rate-b",
  }));
  const current = requestFact({
    requestId: "cost-current",
    rootSessionId: "cost-current-session",
    observedAt: "2026-08-25T06:00:00.000Z",
    inputTokens: 100_000,
    amountUsd: 0.5,
    serviceTier: "standard",
    rateVersion: "rate-a",
  });

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts: [current],
    historicalFacts: [...comparable, ...incompatible],
  });
  const candidate = report.candidates.find((entry) => entry.type === "historical_cost_spike");
  assert.ok(candidate);
  assert.equal(candidate.baseline.sampleCount, 20);
  assert.equal(candidate.cohort.serviceTier, "standard");
  assert.equal(candidate.cohort.rateVersion, "rate-a");
  assert.ok(candidate.baseline.robustZ > 10);
});

test("Cross-session Context baseline gives each prior session slice exactly one sample", () => {
  const historicalSessionFacts = [];
  for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
    const rootSessionId = `slice-history-${sessionIndex + 1}`;
    const center = 80_000 + sessionIndex * 2_000;
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      historicalSessionFacts.push(requestFact({
        requestId: `${rootSessionId}-request-${requestIndex + 1}`,
        rootSessionId,
        observedAt: `2026-07-${String(sessionIndex + 10).padStart(2, "0")}T0${requestIndex}:00:00.000Z`,
        inputTokens: center + (requestIndex - 1) * 1_000,
      }));
    }
  }
  // This session is deliberately much larger in request count; it must still contribute one slice sample.
  for (let requestIndex = 3; requestIndex < 30; requestIndex += 1) {
    historicalSessionFacts.push(requestFact({
      requestId: `slice-history-10-request-${requestIndex + 1}`,
      rootSessionId: "slice-history-10",
      observedAt: `2026-07-19T12:${String(requestIndex).padStart(2, "0")}:00.000Z`,
      inputTokens: 98_000,
    }));
  }
  const currentFacts = [149_000, 150_000, 151_000].map((inputTokens, index) => requestFact({
    requestId: `slice-current-${index + 1}`,
    rootSessionId: "slice-current",
    observedAt: `2026-08-25T12:0${index}:00.000Z`,
    inputTokens,
  }));

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts,
    historicalFacts: [],
    historicalSessionFacts,
    scope: { type: "session" },
  });
  const candidate = report.candidates.find((entry) => entry.type === "cross_session_context_regression");
  assert.ok(candidate);
  assert.equal(candidate.family, "cross_session");
  assert.equal(candidate.baseline.sampleCount, 10);
  assert.equal(candidate.metric.current, 150_000);
  assert.equal(candidate.subject.rootSessionId, "slice-current");
  assert.equal(candidate.subject.requestCount, 3);
  assert.ok(candidate.supportingLocator?.requestId);
});

test("Cross-session Cache uses weighted cached/input totals instead of averaging request rates", () => {
  const historicalSessionFacts = [];
  for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
    const rootSessionId = `cache-slice-history-${sessionIndex + 1}`;
    const cacheRate = 0.60 + sessionIndex * 0.02;
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      historicalSessionFacts.push(requestFact({
        requestId: `${rootSessionId}-${requestIndex + 1}`,
        rootSessionId,
        observedAt: `2026-07-${String(sessionIndex + 10).padStart(2, "0")}T0${requestIndex}:30:00.000Z`,
        inputTokens: 100_000,
        cachedInputTokens: Math.round(100_000 * cacheRate),
      }));
    }
  }
  const currentFacts = [
    requestFact({
      requestId: "cache-slice-current-1",
      rootSessionId: "cache-slice-current",
      observedAt: "2026-08-25T13:00:00.000Z",
      inputTokens: 10_000,
      cachedInputTokens: 0,
    }),
    requestFact({
      requestId: "cache-slice-current-2",
      rootSessionId: "cache-slice-current",
      observedAt: "2026-08-25T13:01:00.000Z",
      inputTokens: 100_000,
      cachedInputTokens: 20_000,
    }),
    requestFact({
      requestId: "cache-slice-current-3",
      rootSessionId: "cache-slice-current",
      observedAt: "2026-08-25T13:02:00.000Z",
      inputTokens: 100_000,
      cachedInputTokens: 20_000,
    }),
  ];

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts,
    historicalFacts: [],
    historicalSessionFacts,
  });
  const candidate = report.candidates.find((entry) => entry.type === "cross_session_cache_regression");
  assert.ok(candidate);
  assert.ok(Math.abs(candidate.metric.current - (40_000 / 210_000)) < 1e-12);
  assert.equal(candidate.baseline.sampleCount, 10);
  assert.ok(candidate.baseline.robustZ < -5);
});

test("Cross-session Cost compares only session slices with the same tier and rate version", () => {
  const historicalSessionFacts = [];
  for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
    const rootSessionId = `cost-slice-history-${sessionIndex + 1}`;
    const center = 0.10 + sessionIndex * 0.01;
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      historicalSessionFacts.push(requestFact({
        requestId: `${rootSessionId}-${requestIndex + 1}`,
        rootSessionId,
        observedAt: `2026-07-${String(sessionIndex + 10).padStart(2, "0")}T1${requestIndex}:00:00.000Z`,
        inputTokens: 100_000,
        amountUsd: center + (requestIndex - 1) * 0.001,
        serviceTier: "standard",
        rateVersion: "cross-rate-a",
      }));
      historicalSessionFacts.push(requestFact({
        requestId: `${rootSessionId}-fast-${requestIndex + 1}`,
        rootSessionId,
        observedAt: `2026-07-${String(sessionIndex + 10).padStart(2, "0")}T1${requestIndex}:30:00.000Z`,
        inputTokens: 100_000,
        amountUsd: 10 + sessionIndex,
        serviceTier: "fast",
        rateVersion: "cross-rate-b",
      }));
    }
  }
  const currentFacts = [0.49, 0.50, 0.51].map((amountUsd, index) => requestFact({
    requestId: `cost-slice-current-${index + 1}`,
    rootSessionId: "cost-slice-current",
    observedAt: `2026-08-25T14:0${index}:00.000Z`,
    inputTokens: 100_000,
    amountUsd,
    serviceTier: "standard",
    rateVersion: "cross-rate-a",
  }));

  const report = analyzeAdvancedUsageDiagnostics({
    currentFacts,
    historicalFacts: [],
    historicalSessionFacts,
  });
  const candidate = report.candidates.find((entry) => entry.type === "cross_session_cost_regression");
  assert.ok(candidate);
  assert.equal(candidate.metric.current, 0.5);
  assert.equal(candidate.baseline.sampleCount, 10);
  assert.equal(candidate.cohort.serviceTier, "standard");
  assert.equal(candidate.cohort.rateVersion, "cross-rate-a");
  assert.ok(candidate.baseline.robustZ > 5);
});
