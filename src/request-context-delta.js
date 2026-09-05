import { createHash } from "node:crypto";

export const REQUEST_CONTEXT_DELTA_LIMITS = Object.freeze({
  maxComparableItemsPerSide: 800,
  maxDetailedDeltaItems: 200,
  maxProjectedCharacters: 512 * 1024,
  maxDiffWorkUnits: 250_000,
});

export const REQUEST_CONTEXT_DELTA_POLICY = Object.freeze({
  version: "request-context-delta-v1",
  minimumCacheHitDropPoints: 0,
  cacheStableTolerancePoints: 0,
});

const EXACT_CAUSALITY_LIMITATION = "Exact provider cache causality unavailable.";
const COMPLETE_CONTEXT_COVERAGE = "complete_observed_history";
const COMPARABLE_ITEM_KINDS = new Set(["message", "assistant_message", "tool_call", "tool_result"]);

/**
 * Compare two canonical Requests using only Phase 26 reconstructed input
 * contexts plus canonical token accounting. The supplied reconstruction
 * function is the sole context source; this module never reparses rollout.
 */
export async function analyzeRequestContextDelta({
  pairLocator,
  reconstructInputContext,
  limits = REQUEST_CONTEXT_DELTA_LIMITS,
  policy = REQUEST_CONTEXT_DELTA_POLICY,
}) {
  const bounded = normalizeLimits(limits);
  if (!pairLocator || typeof pairLocator !== "object" || !pairLocator.current) {
    throw new TypeError("pairLocator with current Request is required");
  }
  if (typeof reconstructInputContext !== "function") {
    throw new TypeError("reconstructInputContext must be a function");
  }

  const pairStatus = normalizePairStatus(pairLocator.status);
  const accounting = buildAccounting(pairLocator.previous?.usage, pairLocator.current?.usage);
  const base = {
    version: 1,
    policyVersion: policy.version ?? REQUEST_CONTEXT_DELTA_POLICY.version,
    pair: {
      currentRequestId: pairLocator.current.requestId ?? null,
      previousRequestId: pairLocator.previous?.requestId ?? null,
      threadId: pairLocator.threadId ?? pairLocator.current.threadId ?? null,
      status: publicPairStatus(pairStatus),
    },
    evidence: {
      kind: "context_delta_cache_correlation",
      providerCacheKeyKnown: false,
      providerSerializationKnown: false,
      exactCacheCausalityKnown: false,
      comparisonCoverage: pairCoverageFromLocator(pairStatus),
      diffTruncated: false,
    },
    accounting,
    contextDelta: emptyContextDelta(),
    correlationSignals: [],
    limitations: limitations(),
  };

  if (pairStatus !== "ok" || !pairLocator.previous) return base;

  const [previousContext, currentContext] = await Promise.all([
    reconstructInputContext(pairLocator.previous),
    reconstructInputContext(pairLocator.current),
  ]);
  const comparisonCoverage = resolveComparisonCoverage(previousContext, currentContext);
  const diff = computeSemanticDelta({
    previousContext,
    currentContext,
    previousLocator: pairLocator.previous,
    currentLocator: pairLocator.current,
    limits: bounded,
  });
  const correlationSignals = classifyCorrelationSignals({
    accounting,
    contextDelta: diff.contextDelta,
    comparisonCoverage,
    policy,
  });

  return {
    ...base,
    evidence: {
      ...base.evidence,
      comparisonCoverage,
      diffTruncated: diff.diffTruncated,
    },
    contextDelta: diff.contextDelta,
    correlationSignals,
  };
}

function computeSemanticDelta({
  previousContext,
  currentContext,
  previousLocator,
  currentLocator,
  limits,
}) {
  const previousSequence = boundedComparableSequence(previousContext, limits.maxComparableItemsPerSide);
  const currentSequence = boundedComparableSequence(currentContext, limits.maxComparableItemsPerSide);
  const match = sequenceMatch(previousSequence.items, currentSequence.items, limits.maxDiffWorkUnits);
  const previousMatched = new Set(match.matches.map(([previousIndex]) => previousIndex));
  const currentMatched = new Set(match.matches.map(([, currentIndex]) => currentIndex));
  const removed = previousSequence.items.filter((_item, index) => !previousMatched.has(index));
  const added = currentSequence.items.filter((_item, index) => !currentMatched.has(index));
  const runtimeChanges = compareRuntimeContext(previousContext, currentContext);
  const compaction = newCompactionEvidence(previousContext, currentContext);
  const explicitCompaction = compaction.some((item) => item.kind === "compaction_snapshot");
  const signalOnlyCompaction = !explicitCompaction && compaction.some((item) => item.kind === "compaction_signal");
  const sourceTransitions = previousLocator.sourceKey !== currentLocator.sourceKey
    ? [{
        kind: "source_transition",
        fromSourceKey: previousLocator.sourceKey ?? null,
        toSourceKey: currentLocator.sourceKey ?? null,
        sourceOrdering: "rollout_filename_timestamp",
      }]
    : [];
  const previousCoverage = previousContext?.evidence?.rolloutCoverage ?? "unavailable";
  const currentCoverage = currentContext?.evidence?.rolloutCoverage ?? "unavailable";
  const coverageChanges = previousCoverage !== currentCoverage
    ? [{ kind: "coverage_changed", previous: previousCoverage, current: currentCoverage }]
    : [];

  const detailBudget = { items: 0, characters: 0, truncated: false };
  const addedDetails = projectDetailItems(
    added,
    "added",
    detailBudget,
    limits,
  );
  const removedDetails = projectDetailItems(
    removed,
    explicitCompaction
      ? "superseded_by_compaction"
      : signalOnlyCompaction
        ? "unresolved_due_to_compaction_gap"
        : "removed_or_not_observed",
    detailBudget,
    limits,
  );
  const previousVisibleCharacters = finiteNumber(previousContext?.summary?.visibleCharacters);
  const currentVisibleCharacters = finiteNumber(currentContext?.summary?.visibleCharacters);
  const visibleCharactersDelta = previousVisibleCharacters != null && currentVisibleCharacters != null
    ? currentVisibleCharacters - previousVisibleCharacters
    : null;
  const diffTruncated = previousSequence.truncated || currentSequence.truncated || match.truncated || detailBudget.truncated;

  return {
    diffTruncated,
    contextDelta: {
      summary: {
        retainedItems: match.matches.length,
        addedItems: added.length,
        removedOrSupersededItems: removed.length,
        previousVisibleCharacters,
        currentVisibleCharacters,
        visibleCharactersDelta,
      },
      added: addedDetails,
      removedOrSuperseded: removedDetails,
      runtimeChanges,
      compaction,
      sourceTransitions,
      coverageChanges,
    },
  };
}

function boundedComparableSequence(context, limit) {
  const source = comparableItems(context);
  if (source.length <= limit) return { items: source, truncated: false };
  return { items: source.slice(-limit), truncated: true };
}

function comparableItems(context) {
  if (!context?.available) return [];
  const history = (context.sections?.historyGroups ?? []).flatMap((group) => group.items ?? []);
  const current = context.sections?.currentInput ?? [];
  return [...history, ...current]
    .filter((item) => COMPARABLE_ITEM_KINDS.has(item?.kind))
    .map((item) => ({ item, fingerprint: semanticFingerprint(item) }));
}

function semanticFingerprint(item) {
  const canonicalKind = item.kind === "assistant_message" ? "message" : item.kind;
  const body = {
    kind: canonicalKind,
    role: canonicalKind === "message"
      ? normalizeText(item.kind === "assistant_message" ? "assistant" : item.role ?? "unknown")
      : null,
    tool: canonicalKind === "tool_call" || canonicalKind === "tool_result"
      ? normalizeText(item.tool ?? "unknown_tool")
      : null,
    callId: canonicalKind === "tool_call" || canonicalKind === "tool_result"
      ? normalizeText(item.callId ?? "")
      : null,
    text: normalizeText(item.text ?? ""),
    fields: Array.isArray(item.fields)
      ? item.fields.map((field) => ({
          key: normalizeText(field.key ?? field.label ?? ""),
          value: normalizeText(field.value ?? ""),
        }))
      : [],
    provenance: semanticProvenanceLevel(item.provenance?.level),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("base64url");
}

function sequenceMatch(previous, current, maxWorkUnits) {
  const matches = [];
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < current.length &&
    previous[prefix].fingerprint === current[prefix].fingerprint
  ) {
    matches.push([prefix, prefix]);
    prefix += 1;
  }

  let previousEnd = previous.length - 1;
  let currentEnd = current.length - 1;
  const suffix = [];
  while (
    previousEnd >= prefix &&
    currentEnd >= prefix &&
    previous[previousEnd].fingerprint === current[currentEnd].fingerprint
  ) {
    suffix.push([previousEnd, currentEnd]);
    previousEnd -= 1;
    currentEnd -= 1;
  }

  const previousMiddle = previousEnd - prefix + 1;
  const currentMiddle = currentEnd - prefix + 1;
  const workUnits = Math.max(0, previousMiddle) * Math.max(0, currentMiddle);
  if (workUnits > maxWorkUnits) {
    return { matches: [...matches, ...suffix.reverse()], truncated: true, workUnits };
  }

  if (previousMiddle > 0 && currentMiddle > 0) {
    const matrix = Array.from(
      { length: previousMiddle + 1 },
      () => new Uint16Array(currentMiddle + 1),
    );
    for (let left = 1; left <= previousMiddle; left += 1) {
      for (let right = 1; right <= currentMiddle; right += 1) {
        if (
          previous[prefix + left - 1].fingerprint ===
          current[prefix + right - 1].fingerprint
        ) {
          matrix[left][right] = matrix[left - 1][right - 1] + 1;
        } else {
          matrix[left][right] = Math.max(matrix[left - 1][right], matrix[left][right - 1]);
        }
      }
    }
    let left = previousMiddle;
    let right = currentMiddle;
    const middleMatches = [];
    while (left > 0 && right > 0) {
      if (
        previous[prefix + left - 1].fingerprint ===
        current[prefix + right - 1].fingerprint
      ) {
        middleMatches.push([prefix + left - 1, prefix + right - 1]);
        left -= 1;
        right -= 1;
      } else if (matrix[left - 1][right] >= matrix[left][right - 1]) {
        left -= 1;
      } else {
        right -= 1;
      }
    }
    matches.push(...middleMatches.reverse());
  }
  matches.push(...suffix.reverse());
  return { matches, truncated: false, workUnits };
}

function compareRuntimeContext(previousContext, currentContext) {
  const previous = runtimeFieldMap(previousContext);
  const current = runtimeFieldMap(currentContext);
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const left = previous.get(key) ?? null;
    const right = current.get(key) ?? null;
    if (left?.value === right?.value) continue;
    changes.push({
      kind: "runtime_changed",
      key,
      label: right?.label ?? left?.label ?? key,
      previousValue: left?.value ?? null,
      currentValue: right?.value ?? null,
    });
  }
  return changes;
}

function runtimeFieldMap(context) {
  const result = new Map();
  for (const item of context?.sections?.runtimeContext ?? []) {
    if (item?.kind !== "runtime_context") continue;
    for (const field of item.fields ?? []) {
      const key = String(field.key ?? field.label ?? "");
      if (!key) continue;
      result.set(key, {
        label: String(field.label ?? key),
        value: normalizeText(field.value ?? ""),
      });
    }
  }
  return result;
}

function newCompactionEvidence(previousContext, currentContext) {
  const previous = new Set(
    (previousContext?.sections?.compaction ?? []).map(compactionIdentity),
  );
  return (currentContext?.sections?.compaction ?? [])
    .filter((item) => !previous.has(compactionIdentity(item)))
    .map((item) => ({
      kind: item.kind === "compaction_snapshot" ? "compaction_snapshot" : "compaction_signal",
      label: String(item.label ?? "Observed compaction evidence"),
      provenance: publicProvenance(item.provenance),
    }));
}

function compactionIdentity(item) {
  return JSON.stringify([
    item?.kind ?? null,
    item?.provenance?.sourceKey ?? null,
    item?.provenance?.lineStart ?? null,
    item?.provenance?.lineEnd ?? null,
  ]);
}

function projectDetailItems(entries, disposition, budget, limits) {
  const output = [];
  for (const entry of entries) {
    if (budget.items >= limits.maxDetailedDeltaItems) {
      budget.truncated = true;
      break;
    }
    const projected = clonePublicItem(entry.item, disposition, budget, limits.maxProjectedCharacters);
    if (!projected) {
      budget.truncated = true;
      break;
    }
    output.push(projected);
    budget.items += 1;
  }
  if (output.length < entries.length) budget.truncated = true;
  return output;
}

function clonePublicItem(item, disposition, budget, maxCharacters) {
  const projected = {
    kind: item.kind,
    deltaDisposition: disposition,
    ...(item.role != null ? { role: item.role } : {}),
    ...(item.tool != null ? { tool: item.tool } : {}),
    ...(item.callId != null ? { callId: item.callId } : {}),
    ...(item.lineCount != null ? { lineCount: Number(item.lineCount) } : {}),
    ...(item.provenance ? { provenance: publicProvenance(item.provenance) } : {}),
  };
  let remaining = maxCharacters - budget.characters;
  if (remaining <= 0 && itemBodyCharacters(item) > 0) return null;
  if (typeof item.text === "string") {
    const text = normalizeText(item.text);
    projected.text = text.slice(0, Math.max(0, remaining));
    if (projected.text.length < text.length) projected.truncated = true;
    budget.characters += projected.text.length;
    remaining -= projected.text.length;
  }
  if (Array.isArray(item.fields)) {
    projected.fields = [];
    for (const field of item.fields) {
      if (remaining <= 0 && String(field.value ?? "").length > 0) {
        projected.truncated = true;
        break;
      }
      const raw = normalizeText(field.value ?? "");
      const value = raw.slice(0, Math.max(0, remaining));
      projected.fields.push({
        key: field.key ?? null,
        label: field.label ?? field.key ?? "Field",
        value,
        format: field.format ?? "text",
        ...(value.length < raw.length ? { truncated: true } : {}),
      });
      if (value.length < raw.length) projected.truncated = true;
      budget.characters += value.length;
      remaining -= value.length;
    }
  }
  if (item.truncated) projected.truncated = true;
  return projected;
}

function publicProvenance(provenance) {
  return {
    level: provenance?.level ?? "coverage_gap",
    sourceKey: provenance?.sourceKey ?? null,
    lineStart: finiteNumber(provenance?.lineStart),
    lineEnd: finiteNumber(provenance?.lineEnd),
  };
}

function buildAccounting(previousUsage, currentUsage) {
  const previous = accountingSide(previousUsage);
  const current = accountingSide(currentUsage);
  return {
    previous,
    current,
    delta: {
      inputTokens: numericDelta(previous.inputTokens, current.inputTokens),
      cachedInputTokens: numericDelta(previous.cachedInputTokens, current.cachedInputTokens),
      cacheHitRatePoints: previous.cacheHitRate != null && current.cacheHitRate != null
        ? roundPercentagePoints((current.cacheHitRate - previous.cacheHitRate) * 100)
        : null,
    },
  };
}

function accountingSide(usage) {
  const inputTokens = nonNegativeFinite(usage?.inputTokens);
  const cachedInputTokens = nonNegativeFinite(usage?.cachedInputTokens);
  let coverage = "complete";
  let cacheHitRate = null;
  if (inputTokens == null || cachedInputTokens == null) {
    coverage = "accounting_missing";
  } else if (cachedInputTokens > inputTokens) {
    coverage = "accounting_inconsistent";
  } else if (inputTokens === 0) {
    cacheHitRate = cachedInputTokens === 0 ? 0 : null;
    if (cacheHitRate == null) coverage = "accounting_inconsistent";
  } else {
    cacheHitRate = cachedInputTokens / inputTokens;
  }
  return { inputTokens, cachedInputTokens, cacheHitRate, coverage };
}

function classifyCorrelationSignals({ accounting, contextDelta, comparisonCoverage, policy }) {
  const signals = [];
  const delta = accounting.delta;
  const summary = contextDelta.summary;
  const cacheHitDrop = delta.cacheHitRatePoints != null &&
    delta.cacheHitRatePoints < -Number(policy.minimumCacheHitDropPoints ?? 0);
  const visibleContextChanged = summary.addedItems > 0 ||
    summary.removedOrSupersededItems > 0 ||
    contextDelta.runtimeChanges.length > 0 ||
    contextDelta.compaction.length > 0;
  const contextGrowth = summary.visibleCharactersDelta != null && summary.visibleCharactersDelta > 0;
  const cacheStableTolerance = Number(policy.cacheStableTolerancePoints ?? 0);
  const cacheStable = delta.cachedInputTokens === 0 &&
    delta.cacheHitRatePoints != null &&
    Math.abs(delta.cacheHitRatePoints) <= cacheStableTolerance;
  const cacheChanged = (delta.cachedInputTokens != null && delta.cachedInputTokens !== 0) ||
    (delta.cacheHitRatePoints != null && delta.cacheHitRatePoints !== 0) ||
    (delta.inputTokens != null && delta.inputTokens !== 0);

  if (cacheHitDrop && contextGrowth) {
    signals.push(correlationSignal("cache_hit_drop_with_context_growth", accounting, contextDelta, comparisonCoverage));
  }
  if (cacheHitDrop && contextDelta.compaction.length > 0) {
    signals.push(correlationSignal("cache_hit_drop_with_compaction", accounting, contextDelta, comparisonCoverage));
  }
  if (cacheHitDrop && contextDelta.runtimeChanges.length > 0) {
    signals.push(correlationSignal("cache_hit_drop_with_runtime_change", accounting, contextDelta, comparisonCoverage));
  }
  if ((delta.cachedInputTokens ?? 0) < 0 && contextDelta.sourceTransitions.length > 0) {
    signals.push(correlationSignal("cached_input_drop_with_source_transition", accounting, contextDelta, comparisonCoverage));
  }
  if (visibleContextChanged && cacheStable) {
    signals.push(correlationSignal("context_changed_cache_stable", accounting, contextDelta, comparisonCoverage));
  }
  if (!visibleContextChanged && cacheChanged) {
    signals.push(correlationSignal("cache_changed_without_visible_context_change", accounting, contextDelta, comparisonCoverage));
  }
  if (comparisonCoverage !== "complete_pair") {
    signals.push(correlationSignal("insufficient_context_coverage", accounting, contextDelta, comparisonCoverage));
  }
  return signals;
}

function correlationSignal(type, accounting, contextDelta, comparisonCoverage) {
  return {
    type,
    policyVersion: REQUEST_CONTEXT_DELTA_POLICY.version,
    accountingDelta: { ...accounting.delta },
    contextEvidence: {
      addedItems: contextDelta.summary.addedItems,
      removedOrSupersededItems: contextDelta.summary.removedOrSupersededItems,
      visibleCharactersDelta: contextDelta.summary.visibleCharactersDelta,
      runtimeChangeCount: contextDelta.runtimeChanges.length,
      compactionCount: contextDelta.compaction.length,
      sourceTransitionCount: contextDelta.sourceTransitions.length,
    },
    evidenceCoverage: comparisonCoverage,
    limitation: EXACT_CAUSALITY_LIMITATION,
  };
}

function resolveComparisonCoverage(previousContext, currentContext) {
  const previousComplete = previousContext?.available === true &&
    previousContext?.evidence?.rolloutCoverage === COMPLETE_CONTEXT_COVERAGE;
  const currentComplete = currentContext?.available === true &&
    currentContext?.evidence?.rolloutCoverage === COMPLETE_CONTEXT_COVERAGE;
  if (previousComplete && currentComplete) return "complete_pair";
  if (!previousComplete && !currentComplete) return "both_context_partial";
  if (!previousComplete) return "previous_context_partial";
  return "current_context_partial";
}

function pairCoverageFromLocator(status) {
  if (status === "no_predecessor") return "no_predecessor";
  if (status === "predecessor_unavailable") return "predecessor_unavailable";
  if (status === "boundary_ambiguous") return "boundary_ambiguous";
  return "complete_pair";
}

function publicPairStatus(status) {
  return status === "ok" ? "complete_pair" : status;
}

function normalizePairStatus(status) {
  if (["ok", "no_predecessor", "predecessor_unavailable", "boundary_ambiguous"].includes(status)) {
    return status;
  }
  return "boundary_ambiguous";
}

function emptyContextDelta() {
  return {
    summary: {
      retainedItems: 0,
      addedItems: 0,
      removedOrSupersededItems: 0,
      previousVisibleCharacters: null,
      currentVisibleCharacters: null,
      visibleCharactersDelta: null,
    },
    added: [],
    removedOrSuperseded: [],
    runtimeChanges: [],
    compaction: [],
    sourceTransitions: [],
    coverageChanges: [],
  };
}

function limitations() {
  return [
    "Context changes are reconstructed from local rollout evidence.",
    "Cache metrics are canonical accounting facts; no item-level token allocation is performed.",
    EXACT_CAUSALITY_LIMITATION,
    "Provider cache key and provider serialization are unavailable.",
  ];
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n");
}

function semanticProvenanceLevel(value) {
  if (value === "compaction_snapshot") return "compaction_snapshot";
  if (value === "coverage_gap") return "coverage_gap";
  if (value === "runtime_context") return "runtime_context";
  return "observed_rollout";
}

function itemBodyCharacters(item) {
  let total = typeof item?.text === "string" ? item.text.length : 0;
  for (const field of item?.fields ?? []) total += typeof field?.value === "string" ? field.value.length : 0;
  return total;
}

function numericDelta(previous, current) {
  return previous != null && current != null ? current - previous : null;
}

function roundPercentagePoints(value) {
  return Number(value.toFixed(6));
}

function nonNegativeFinite(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function finiteNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLimits(limits) {
  const result = { ...REQUEST_CONTEXT_DELTA_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(REQUEST_CONTEXT_DELTA_LIMITS)) {
    if (!Number.isInteger(result[key]) || result[key] <= 0) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
  return result;
}
