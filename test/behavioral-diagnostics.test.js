import assert from "node:assert/strict";
import test from "node:test";

import {
  BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
  analyzeBehavioralUsageDiagnostics,
} from "../src/behavioral-diagnostics.js";

function requestFact({
  requestId,
  rootSessionId,
  observedAt,
  outputTokens = 1_000,
  reasoningOutputTokens = 250,
  totalTokens = 100_000,
  inputTokens = Math.max(1, totalTokens - outputTokens),
  projectPath = "D:\\work\\alpha",
  model = "gpt-5.6-sol",
  effort = "high",
  threadId = `${rootSessionId}-root`,
  turnId = `${requestId}-turn`,
  agentDepth = 0,
  isRootAgent = agentDepth === 0,
  inScope = true,
} = {}) {
  return {
    requestId,
    rootSessionId,
    threadId,
    turnId,
    observedAt,
    classification: "verified_increment",
    quality: "complete",
    projectPath,
    model,
    effort,
    agentDepth,
    isRootAgent,
    inScope,
    usage: {
      inputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
    },
  };
}

test("Reasoning Anomaly uses strict historical reasoning share plus an absolute reasoning-token effect gate", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `reason-history-${index + 1}`,
    rootSessionId: `reason-history-session-${index + 1}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    outputTokens: 2_000,
    reasoningOutputTokens: 400 + index * 20,
  }));
  const current = requestFact({
    requestId: "reason-current",
    rootSessionId: "reason-current-session",
    observedAt: "2026-08-25T08:00:00.000Z",
    outputTokens: 2_000,
    reasoningOutputTokens: 1_500,
  });

  const report = analyzeBehavioralUsageDiagnostics({
    currentFacts: [current],
    historicalFacts,
    scope: { type: "session" },
  });
  const candidate = report.candidates.find((entry) => entry.type === "reasoning_anomaly");
  assert.ok(candidate);
  assert.equal(candidate.metric.current, 0.75);
  assert.equal(candidate.baseline.sampleCount, 20);
  assert.equal(candidate.baseline.median, 0.295);
  assert.ok(Math.abs(candidate.baseline.mad - 0.05) < 1e-12);
  assert.ok(candidate.baseline.robustZ > 5);
  assert.equal(candidate.evidence.reasoningOutputTokens, 1_500);
  assert.equal(candidate.shadowSeverity, "high");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, "high");
  assert.equal(report.policy.version, "behavioral-usage-diagnostics-v1");
  assert.equal(report.policy.frozen, true);
});

test("Reasoning Anomaly refuses tiny output denominators and unknown effort instead of broadening cohort", () => {
  const history = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `reason-small-history-${index}`,
    rootSessionId: `reason-small-session-${index}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T07:00:00.000Z`,
    outputTokens: 1_000,
    reasoningOutputTokens: 250 + index,
  }));
  const tiny = requestFact({
    requestId: "reason-tiny",
    rootSessionId: "reason-current",
    observedAt: "2026-08-25T07:00:00.000Z",
    outputTokens: 64,
    reasoningOutputTokens: 64,
  });
  const unknown = requestFact({
    requestId: "reason-unknown-effort",
    rootSessionId: "reason-current",
    observedAt: "2026-08-25T07:01:00.000Z",
    outputTokens: 2_000,
    reasoningOutputTokens: 1_500,
    effort: null,
  });
  const report = analyzeBehavioralUsageDiagnostics({ currentFacts: [tiny, unknown], historicalFacts: history });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.coverage.reasoningIneligible, 1);
  assert.equal(report.coverage.unknownEffort, 1);
});

test("Request Burst compares the densest canonical 60-second window against prior Session slices", () => {
  const historicalSessionFacts = [];
  for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
    const rootSessionId = `burst-history-${sessionIndex + 1}`;
    const requestCount = 6 + sessionIndex;
    for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
      historicalSessionFacts.push(requestFact({
        requestId: `${rootSessionId}-${requestIndex}`,
        rootSessionId,
        observedAt: `2026-07-${String(sessionIndex + 10).padStart(2, "0")}T10:00:${String(requestIndex * 3).padStart(2, "0")}.000Z`,
      }));
    }
  }
  const currentFacts = Array.from({ length: 30 }, (_, index) => requestFact({
    requestId: `burst-current-${index}`,
    rootSessionId: "burst-current",
    observedAt: `2026-08-25T10:00:${String(index).padStart(2, "0")}.000Z`,
  }));

  const report = analyzeBehavioralUsageDiagnostics({
    currentFacts,
    historicalFacts: [],
    historicalSessionFacts,
    scope: { type: "session" },
  });
  const candidate = report.candidates.find((entry) => entry.type === "request_burst");
  assert.ok(candidate);
  assert.equal(candidate.metric.current, 30);
  assert.equal(candidate.baseline.sampleCount, 10);
  assert.ok(candidate.baseline.robustZ > 5);
  assert.equal(candidate.evidence.windowMs, 60_000);
  assert.equal(candidate.evidence.requestCount, 30);
  assert.ok(candidate.supportingLocator?.requestId);
  assert.equal(candidate.shadowSeverity, "high");
});

test("Subagent Amplification requires exact-project historical multi-agent samples and absolute descendant work", () => {
  const currentFacts = [
    requestFact({
      requestId: "amp-root-1",
      rootSessionId: "amp-current",
      observedAt: "2026-08-25T11:00:00.000Z",
      totalTokens: 1_000_000,
      threadId: "amp-root",
      agentDepth: 0,
      isRootAgent: true,
    }),
    ...Array.from({ length: 60 }, (_, index) => requestFact({
      requestId: `amp-desc-${index}`,
      rootSessionId: "amp-current",
      observedAt: `2026-08-25T11:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      totalTokens: 100_000,
      threadId: `amp-child-${index % 3}`,
      agentDepth: 1,
      isRootAgent: false,
    })),
  ];
  const historicalAmplificationSamples = [0.5, 0.6, 0.7, 0.8, 0.9].map((tokenRatio, index) => ({
    rootSessionId: `amp-history-${index}`,
    projectPath: "D:\\work\\alpha",
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T11:00:00.000Z`,
    tokenRatio,
    rootTokens: 1_000_000,
    descendantTokens: tokenRatio * 1_000_000,
    rootRequests: 10,
    descendantRequests: 20,
    descendantAgents: 2,
    maxDepth: 1,
  }));

  const report = analyzeBehavioralUsageDiagnostics({
    currentFacts,
    historicalFacts: [],
    historicalSessionFacts: [],
    historicalAmplificationSamples,
    scope: { type: "session" },
  });
  const candidate = report.candidates.find((entry) => entry.type === "subagent_amplification");
  assert.ok(candidate);
  assert.equal(candidate.metric.current, 6);
  assert.equal(candidate.baseline.sampleCount, 5);
  assert.equal(candidate.baseline.median, 0.7);
  assert.ok(candidate.baseline.robustZ > 5);
  assert.equal(candidate.evidence.descendantRequests, 60);
  assert.equal(candidate.evidence.descendantTokens, 6_000_000);
  assert.ok(candidate.supportingLocator?.requestId);
  assert.equal(candidate.shadowSeverity, "high");
});

test("Day scope returns request-level Reasoning only and never Session-level Burst or Amplification", () => {
  const history = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `day-history-${index}`,
    rootSessionId: `day-history-session-${index}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T06:00:00.000Z`,
    outputTokens: 2_000,
    reasoningOutputTokens: 400 + index * 20,
  }));
  const currentFacts = Array.from({ length: 30 }, (_, index) => requestFact({
    requestId: `day-current-${index}`,
    rootSessionId: "day-current",
    observedAt: `2026-08-25T06:00:${String(index).padStart(2, "0")}.000Z`,
    outputTokens: 2_000,
    reasoningOutputTokens: index === 0 ? 1_500 : 500,
    inScope: index === 0,
    agentDepth: index === 0 ? 0 : 1,
    isRootAgent: index === 0,
  }));
  const report = analyzeBehavioralUsageDiagnostics({
    currentFacts,
    historicalFacts: history,
    historicalSessionFacts: history,
    historicalAmplificationSamples: [],
    scope: { type: "day", day: "2026-08-25" },
  });
  assert.ok(report.candidates.some((entry) => entry.type === "reasoning_anomaly"));
  assert.ok(!report.candidates.some((entry) => entry.type === "request_burst"));
  assert.ok(!report.candidates.some((entry) => entry.type === "subagent_amplification"));
});

test("Behavioral Request locator ordinal is Task-scoped rather than Session-scoped", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `locator-history-${index}`,
    rootSessionId: `locator-history-session-${index}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T04:00:00.000Z`,
    outputTokens: 2_000,
    reasoningOutputTokens: 400 + index * 20,
  }));
  const currentFacts = [
    requestFact({
      requestId: "locator-task-a",
      rootSessionId: "locator-current",
      threadId: "locator-root",
      turnId: "task-a",
      observedAt: "2026-08-25T04:00:00.000Z",
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
    }),
    requestFact({
      requestId: "locator-task-b",
      rootSessionId: "locator-current",
      threadId: "locator-child",
      turnId: "task-b",
      observedAt: "2026-08-25T04:00:01.000Z",
      outputTokens: 2_000,
      reasoningOutputTokens: 1_500,
      agentDepth: 1,
      isRootAgent: false,
    }),
  ];
  const report = analyzeBehavioralUsageDiagnostics({ currentFacts, historicalFacts });
  const finding = report.findings.find((entry) => entry.requestId === "locator-task-b");
  assert.ok(finding);
  assert.equal(finding.locator.requestOrdinalInScope, 1);
});

test("frozen behavioral policy materializes deterministic finding ids without changing candidate identity", () => {
  const historicalFacts = Array.from({ length: 20 }, (_, index) => requestFact({
    requestId: `frozen-history-${index}`,
    rootSessionId: `frozen-history-session-${index}`,
    observedAt: `2026-08-${String(index + 1).padStart(2, "0")}T05:00:00.000Z`,
    outputTokens: 2_000,
    reasoningOutputTokens: 400 + index * 20,
  }));
  const current = requestFact({
    requestId: "frozen-current",
    rootSessionId: "frozen-current-session",
    observedAt: "2026-08-25T05:00:00.000Z",
    outputTokens: 2_000,
    reasoningOutputTokens: 1_500,
  });
  const frozenPolicy = {
    ...BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
    version: "behavioral-usage-diagnostics-v1-test",
    frozen: true,
  };
  const first = analyzeBehavioralUsageDiagnostics({ currentFacts: [current], historicalFacts }, frozenPolicy);
  const second = analyzeBehavioralUsageDiagnostics({ currentFacts: [current], historicalFacts }, frozenPolicy);
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].findingId, second.findings[0].findingId);
  assert.equal(first.findings[0].requestId, "frozen-current");
});
