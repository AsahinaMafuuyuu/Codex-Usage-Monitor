import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRequestIdentities,
  extractNativeRequestIdentity,
  resolveRequestIdentity,
} from "../src/request-identity.js";

const cumulative = {
  inputTokens: 120,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  outputTokens: 30,
  reasoningOutputTokens: 10,
  totalTokens: 150,
};

const last = {
  inputTokens: 40,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 0,
  outputTokens: 10,
  reasoningOutputTokens: 4,
  totalTokens: 50,
};

test("T-ID-002 native request identity is stable across repeated broadcasts", () => {
  const first = resolveRequestIdentity({
    nativeRequestIdentity: { field: "request_id", value: "req-stable" },
    turnId: "turn-a",
    observedAt: "2026-08-01T12:00:00.000Z",
    sourceKey: "root.jsonl",
    lineNumber: 10,
  });
  const repeated = resolveRequestIdentity({
    nativeRequestIdentity: { field: "request_id", value: "req-stable" },
    turnId: "turn-a",
    observedAt: "2026-08-02T01:00:00.000Z",
    sourceKey: "child.jsonl",
    lineNumber: 900,
  });

  assert.equal(first.kind, "native");
  assert.equal(first.id, repeated.id);
});

test("T-ID-003/004 deterministic reconstruction survives fork copy when native identity is absent", () => {
  const first = resolveRequestIdentity({
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: cumulative,
    lastUsage: last,
    observedAt: "2026-08-01T12:00:00.000Z",
    threadId: "root",
    sourceKey: "root.jsonl",
    lineNumber: 10,
  });
  const copied = resolveRequestIdentity({
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: cumulative,
    lastUsage: last,
    observedAt: "2026-08-02T01:00:00.000Z",
    threadId: "child",
    sourceKey: "child.jsonl",
    lineNumber: 900,
  });

  assert.equal(first.kind, "reconstructed");
  assert.equal(first.id, copied.id);
  assert.match(first.id, /^reqr_[0-9a-f]{64}$/u);
});

test("T-ID-005 envelope timestamp and source location never participate in reconstructed identity", () => {
  const base = {
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: cumulative,
    lastUsage: last,
  };
  const left = resolveRequestIdentity({
    ...base,
    observedAt: "2026-08-01T23:59:59.000Z",
    sourceKey: "a.jsonl",
    lineNumber: 1,
  });
  const right = resolveRequestIdentity({
    ...base,
    observedAt: "2026-08-02T00:00:01.000Z",
    sourceKey: "b.jsonl",
    lineNumber: 999,
  });

  assert.equal(left.id, right.id);
});

test("T-ID-004 distinct cumulative request evidence produces a distinct reconstruction", () => {
  const first = resolveRequestIdentity({
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: cumulative,
    lastUsage: last,
  });
  const second = resolveRequestIdentity({
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: { ...cumulative, inputTokens: 160, totalTokens: 200 },
    lastUsage: last,
  });
  assert.notEqual(first.id, second.id);
});

test("T-ID-001 call_id is not accepted as model request identity on token_count", () => {
  const record = {
    type: "event_msg",
    timestamp: "2026-08-01T12:00:00.000Z",
    payload: {
      type: "token_count",
      call_id: "tool-call-only",
      info: {
        total_token_usage: {},
        last_token_usage: {},
      },
    },
  };
  assert.equal(extractNativeRequestIdentity(record), null);
});

test("T-ID-001 strong request_id is accepted only from token_count evidence", () => {
  const token = {
    type: "event_msg",
    payload: { type: "token_count", request_id: "req-1", info: {} },
  };
  const tool = {
    type: "response_item",
    payload: { type: "function_call", request_id: "req-1" },
  };
  assert.deepEqual(extractNativeRequestIdentity(token), { field: "request_id", value: "req-1" });
  assert.equal(extractNativeRequestIdentity(tool), null);
});

test("T-ID-006 persisted reconstructed identity is authoritative during restore attachment", () => {
  const persisted = resolveRequestIdentity({
    turnId: "turn-a",
    generation: 2,
    cumulativeUsage: cumulative,
    lastUsage: last,
  });
  const [attached] = attachRequestIdentities([{
    sourceKey: "sessions/later.jsonl",
    lineNumber: 500,
    threadId: "thread-a",
    turnId: "turn-a",
    generation: 2,
    classification: "verified_increment",
    usage: last,
    requestIdentity: persisted.id,
    requestIdentityKind: persisted.kind,
    requestIdentityReason: persisted.reason,
    requestNativeField: persisted.nativeField,
  }]);

  assert.equal(attached.requestIdentity, persisted.id);
  assert.equal(attached.requestIdentityKind, "reconstructed");
  assert.equal(attached.requestIdentityReason, "deterministic_request_reconstruction");
});
