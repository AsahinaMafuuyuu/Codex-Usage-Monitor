export const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

export const MODEL_USAGE_EVENT_CLASSIFICATIONS = [
  "verified_increment",
  "duplicate",
  "generation_start",
  "unverified",
  "anomaly",
];

const WIRE_FIELDS = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cached_input_tokens",
  cacheWriteInputTokens: "cache_write_input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
  totalTokens: "total_tokens",
};

export function zeroUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const result = {};
  let present = 0;
  for (const field of USAGE_FIELDS) {
    const value = raw[WIRE_FIELDS[field]] ?? raw[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[field] = value;
      present += 1;
    } else {
      result[field] = null;
    }
  }
  return present ? result : null;
}

export function isMonotonic(previous, next) {
  if (!previous || !next) return true;
  return USAGE_FIELDS.every((field) => {
    if (previous[field] == null || next[field] == null) return true;
    return next[field] >= previous[field];
  });
}

export function classifyModelUsageEvent(previousTotal, currentTotal, lastUsage) {
  if (!currentTotal) {
    return usageEventResult("unverified", null, "missing_total_usage");
  }

  if (previousTotal && comparableUsageEquals(previousTotal, currentTotal)) {
    return usageEventResult("duplicate", zeroVerifiedUsage(previousTotal, currentTotal), "unchanged_total");
  }

  if (!lastUsage || currentTotal.totalTokens == null || lastUsage.totalTokens == null) {
    return usageEventResult("unverified", null, "missing_verifier_fields");
  }

  const generation = compareSnapshotToLast(currentTotal, lastUsage);
  if (!previousTotal) {
    if (generation.matches) {
      return usageEventResult(
        "generation_start",
        generation.verifiedUsage,
        "zero_baseline_proven",
        generation,
      );
    }
    return usageEventResult("unverified", null, "missing_baseline", generation);
  }

  const delta = compareDeltaToLast(previousTotal, currentTotal, lastUsage);
  if (!delta.rollbackFields.length && delta.matches) {
    return usageEventResult(
      "verified_increment",
      delta.verifiedUsage,
      "cumulative_delta_matches_last",
      delta,
    );
  }

  if (delta.rollbackFields.length && generation.matches) {
    return usageEventResult(
      "generation_start",
      generation.verifiedUsage,
      "rollback_to_proven_generation_start",
      {
        ...generation,
        rollbackFields: delta.rollbackFields,
      },
    );
  }

  if (
    delta.rollbackFields.length &&
    currentTotal.totalTokens === 0 &&
    lastUsage.totalTokens > 0
  ) {
    return usageEventResult(
      "unverified",
      null,
      "unproven_generation_start",
      delta,
    );
  }

  return usageEventResult(
    "anomaly",
    null,
    delta.rollbackFields.length ? "unexplained_rollback" : "delta_last_mismatch",
    delta,
  );
}

export function addUsage(left, right) {
  const result = {};
  for (const field of USAGE_FIELDS) {
    const a = left?.[field];
    const b = right?.[field];
    if (a == null && b == null) result[field] = null;
    else result[field] = (a ?? 0) + (b ?? 0);
  }
  return result;
}

export function sumTaskUsage(tasks) {
  let result = zeroUsage();
  let hasValue = false;
  for (const task of tasks) {
    if (!task.deltaUsage) continue;
    result = addUsage(result, task.deltaUsage);
    hasValue = true;
  }
  return hasValue ? result : zeroUsage();
}

export function normalizeTimestamp(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (fallback) return normalizeTimestamp(fallback, null);
  return null;
}

export function normalizeRateLimits(raw, observedAt, sourcePath) {
  if (!raw || typeof raw !== "object") return null;
  const normalizeWindow = (window) => {
    if (!window || typeof window !== "object") return null;
    return {
      usedPercent: numberOrNull(window.used_percent ?? window.usedPercent),
      windowMinutes: numberOrNull(window.window_minutes ?? window.windowMinutes),
      resetsAt: normalizeTimestamp(window.resets_at ?? window.resetsAt),
    };
  };
  const snapshot = {
    limitId: raw.limit_id ?? raw.limitId ?? "codex",
    limitName: raw.limit_name ?? raw.limitName ?? null,
    planType: raw.plan_type ?? raw.planType ?? null,
    primary: normalizeWindow(raw.primary),
    secondary: normalizeWindow(raw.secondary),
    credits: raw.credits ?? null,
    observedAt: normalizeTimestamp(observedAt) ?? new Date().toISOString(),
    sourcePath,
  };
  return snapshot.primary || snapshot.secondary ? snapshot : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareDeltaToLast(previous, current, last) {
  const verifiedUsage = {};
  const comparedFields = [];
  const missingFields = [];
  const mismatchFields = [];
  const rollbackFields = [];

  for (const field of USAGE_FIELDS) {
    const previousValue = previous?.[field];
    const currentValue = current?.[field];
    const lastValue = last?.[field];
    if (previousValue == null || currentValue == null || lastValue == null) {
      verifiedUsage[field] = null;
      missingFields.push(field);
      continue;
    }
    comparedFields.push(field);
    if (currentValue < previousValue) {
      verifiedUsage[field] = null;
      rollbackFields.push(field);
      continue;
    }
    const value = currentValue - previousValue;
    verifiedUsage[field] = value;
    if (value !== lastValue) mismatchFields.push(field);
  }

  const totalCompared = comparedFields.includes("totalTokens");
  return {
    matches: totalCompared && mismatchFields.length === 0 && rollbackFields.length === 0,
    verifiedUsage,
    comparedFields,
    missingFields,
    mismatchFields,
    rollbackFields,
  };
}

function compareSnapshotToLast(current, last) {
  const verifiedUsage = {};
  const comparedFields = [];
  const missingFields = [];
  const mismatchFields = [];

  for (const field of USAGE_FIELDS) {
    const currentValue = current?.[field];
    const lastValue = last?.[field];
    if (currentValue == null || lastValue == null) {
      verifiedUsage[field] = null;
      missingFields.push(field);
      continue;
    }
    comparedFields.push(field);
    verifiedUsage[field] = currentValue;
    if (currentValue !== lastValue) mismatchFields.push(field);
  }

  return {
    matches: comparedFields.includes("totalTokens") && mismatchFields.length === 0,
    verifiedUsage,
    comparedFields,
    missingFields,
    mismatchFields,
    rollbackFields: [],
  };
}

function comparableUsageEquals(left, right) {
  let compared = 0;
  for (const field of USAGE_FIELDS) {
    if (left?.[field] == null || right?.[field] == null) continue;
    compared += 1;
    if (left[field] !== right[field]) return false;
  }
  return compared > 0 && left?.totalTokens != null && right?.totalTokens != null;
}

function zeroVerifiedUsage(left, right) {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, left?.[field] != null && right?.[field] != null ? 0 : null]),
  );
}

function usageEventResult(classification, usage, reason, details = {}) {
  return {
    classification,
    usage,
    reason,
    comparedFields: details.comparedFields ?? [],
    missingFields: details.missingFields ?? [],
    mismatchFields: details.mismatchFields ?? [],
    rollbackFields: details.rollbackFields ?? [],
  };
}
