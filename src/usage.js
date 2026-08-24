export const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
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

export function usageEquals(left, right) {
  if (!left || !right) return false;
  return USAGE_FIELDS.every((field) => left[field] === right[field]);
}

export function isMonotonic(previous, next) {
  if (!previous || !next) return true;
  return USAGE_FIELDS.every((field) => {
    if (previous[field] == null || next[field] == null) return true;
    return next[field] >= previous[field];
  });
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

export function subtractUsage(baseline, end, { active = false, discontinuity = false } = {}) {
  if (discontinuity) {
    return { delta: null, quality: "discontinuity" };
  }
  if (!baseline || !end) {
    return { delta: null, quality: active ? "unknown" : "partial" };
  }

  const delta = {};
  let missing = false;
  let backwards = false;
  for (const field of USAGE_FIELDS) {
    const startValue = baseline[field];
    const endValue = end[field];
    if (startValue == null || endValue == null) {
      delta[field] = null;
      missing = true;
      continue;
    }
    if (endValue < startValue) {
      delta[field] = null;
      backwards = true;
      continue;
    }
    delta[field] = endValue - startValue;
  }
  if (backwards) return { delta: null, quality: "discontinuity" };

  const detailedFields = [
    "inputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ];
  const totalOnlyGrowth =
    (delta.totalTokens ?? 0) > 0 &&
    detailedFields.every((field) => (delta[field] ?? 0) === 0);

  if (active) return { delta, quality: "provisional" };
  if (totalOnlyGrowth) return { delta, quality: "estimated" };
  if (missing) return { delta, quality: "partial" };
  return { delta, quality: "complete" };
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
