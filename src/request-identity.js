import { createHash } from "node:crypto";

import { addUsage, USAGE_FIELDS, zeroUsage } from "./usage.js";

const STRONG_NATIVE_FIELDS = ["request_id", "model_request_id", "response_id"];

export function extractNativeRequestIdentity(record) {
  const payload = record?.type === "event_msg" ? record.payload : null;
  if (payload?.type !== "token_count") return null;

  for (const container of [payload, payload.info, record]) {
    if (!container || typeof container !== "object") continue;
    for (const field of STRONG_NATIVE_FIELDS) {
      const value = nonEmptyIdentity(container[field]);
      if (value) return { field, value };
    }
  }
  return null;
}

export function resolveRequestIdentity(evidence = {}) {
  const native = normalizeNativeIdentity(evidence.nativeRequestIdentity);
  if (native) {
    return {
      id: `reqn_${hashIdentity([native.field, native.value])}`,
      kind: "native",
      nativeField: native.field,
      reason: "native_request_identity",
    };
  }

  const turnId = nonEmptyIdentity(evidence.turnId);
  const generation = finiteInteger(evidence.generation);
  const cumulativeUsage = normalizeIdentityUsage(evidence.cumulativeUsage);
  const lastUsage = normalizeIdentityUsage(evidence.lastUsage);
  if (!turnId) {
    return unresolved("missing_turn_id");
  }
  if (!cumulativeUsage || cumulativeUsage.totalTokens == null) {
    return unresolved("missing_cumulative_usage");
  }
  if (!lastUsage || lastUsage.totalTokens == null) {
    return unresolved("missing_last_usage");
  }

  const reconstruction = {
    turnId,
    generation: generation ?? 0,
    cumulativeUsage,
    lastUsage,
  };
  return {
    id: `reqr_${hashIdentity(reconstruction)}`,
    kind: "reconstructed",
    nativeField: null,
    reason: "deterministic_request_reconstruction",
  };
}

export function attachRequestIdentities(events = []) {
  const indexed = events.map((event, index) => ({ event, index }));
  indexed.sort((left, right) =>
    compareText(left.event?.threadId, right.event?.threadId) ||
    compareText(left.event?.sourceKey, right.event?.sourceKey) ||
    numberOrMax(left.event?.lineNumber) - numberOrMax(right.event?.lineNumber) ||
    left.index - right.index
  );

  const result = new Array(events.length);
  const stateByThread = new Map();
  for (const { event, index } of indexed) {
    const classification = event?.classification;
    const verified = classification === "verified_increment" || classification === "generation_start";
    let identity = existingRequestIdentity(event);
    const threadKey = event?.threadId ?? "";
    let state = stateByThread.get(threadKey);
    const generation = finiteInteger(event?.generation) ?? 0;
    if (!state || state.generation !== generation || classification === "generation_start") {
      state = { generation, cumulativeUsage: zeroUsage() };
      stateByThread.set(threadKey, state);
    }

    if (verified && event?.usage) {
      state.cumulativeUsage = classification === "generation_start"
        ? cloneUsage(event.usage)
        : addUsage(state.cumulativeUsage, event.usage);
      if (!identity) {
        identity = resolveRequestIdentity({
          turnId: event.turnId,
          generation,
          cumulativeUsage: state.cumulativeUsage,
          lastUsage: event.usage,
        });
      }
    }

    result[index] = {
      ...event,
      requestIdentity: identity?.id ?? null,
      requestIdentityKind: identity?.kind ?? "unresolved",
      requestIdentityReason: identity?.reason ?? (verified ? "identity_unresolved" : "not_verified_request"),
      requestNativeField: identity?.nativeField ?? event?.requestNativeField ?? null,
    };
  }
  return result;
}

function normalizeNativeIdentity(value) {
  if (!value || typeof value !== "object") return null;
  if (!STRONG_NATIVE_FIELDS.includes(value.field)) return null;
  const normalized = nonEmptyIdentity(value.value);
  return normalized ? { field: value.field, value: normalized } : null;
}

function existingRequestIdentity(event) {
  const id = typeof event?.requestIdentity === "string" ? event.requestIdentity : null;
  const kind = event?.requestIdentityKind;
  if (kind === "native" && /^reqn_[0-9a-f]{64}$/u.test(id ?? "")) {
    return {
      id,
      kind,
      nativeField: event.requestNativeField ?? null,
      reason: event.requestIdentityReason ?? "native_request_identity",
    };
  }
  if (kind === "reconstructed" && /^reqr_[0-9a-f]{64}$/u.test(id ?? "")) {
    return {
      id,
      kind,
      nativeField: null,
      reason: event.requestIdentityReason ?? "deterministic_request_reconstruction",
    };
  }
  return null;
}

function normalizeIdentityUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  let present = 0;
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[field] = value;
      present += 1;
    } else {
      result[field] = null;
    }
  }
  return present ? result : null;
}

function hashIdentity(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function cloneUsage(usage) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, usage?.[field] ?? null]));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function unresolved(reason) {
  return { id: null, kind: "unresolved", nativeField: null, reason };
}

function nonEmptyIdentity(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function numberOrMax(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}
