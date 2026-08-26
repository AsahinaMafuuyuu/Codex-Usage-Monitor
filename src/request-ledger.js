import { USAGE_FIELDS, zeroUsage } from "./usage.js";

const VERIFIED_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export function materializeRequestLedgerTasks(tasks = [], events = []) {
  const states = buildTaskEventStates(events);
  return tasks.map((task) => {
    const state = states.get(taskKey(task.threadId, task.turnId));
    const requestUsage = state?.verifiedCount ? materializeUsageAccumulator(state) : null;
    const unresolvedCount = (state?.unverifiedCount ?? 0) + (state?.anomalyCount ?? 0);
    let quality;
    let deltaUsage = null;
    if (requestUsage) {
      deltaUsage = requestUsage;
      const hasUnavailableField = USAGE_FIELDS.some((field) => requestUsage[field] == null);
      quality = unresolvedCount > 0 || hasUnavailableField
        ? "partial"
        : task.status === "in_progress"
          ? "provisional"
          : "complete";
    } else if (unresolvedCount > 0) {
      quality = "partial";
    } else {
      quality = task.status === "in_progress" ? "unknown" : "partial";
    }
    return {
      ...task,
      deltaUsage,
      quality,
      usageSource: "request_ledger",
      requestCount: state?.verifiedCount ?? 0,
      tokensPerModelRequest:
        requestUsage?.totalTokens != null && (state?.verifiedCount ?? 0) > 0
          ? requestUsage.totalTokens / state.verifiedCount
          : null,
      requestLedgerCoverage: {
        verified: state?.verifiedCount ?? 0,
        duplicate: state?.duplicateCount ?? 0,
        unverified: state?.unverifiedCount ?? 0,
        anomaly: state?.anomalyCount ?? 0,
      },
    };
  });
}

export function aggregateVerifiedUsageByLocalDay(events = []) {
  const days = new Map();
  for (const event of events) {
    if (!VERIFIED_CLASSIFICATIONS.has(event.classification) || !event.usage) continue;
    const day = localDay(event.observedAt);
    if (!day) continue;
    const state = days.get(day) ?? createUsageAccumulator();
    accumulateUsage(state, event.usage);
    state.requestCount += 1;
    days.set(day, state);
  }
  return Object.fromEntries(
    [...days.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, state]) => [day, {
        usage: materializeUsageAccumulator(state),
        requestCount: state.requestCount,
      }]),
  );
}

function createUsageAccumulator() {
  return {
    usage: zeroUsage(),
    unavailable: new Set(),
    requestCount: 0,
  };
}

function buildTaskEventStates(events) {
  const states = new Map();
  for (const event of events) {
    if (!event?.threadId || !event?.turnId) continue;
    const key = taskKey(event.threadId, event.turnId);
    const state = states.get(key) ?? {
      ...createUsageAccumulator(),
      verifiedCount: 0,
      duplicateCount: 0,
      unverifiedCount: 0,
      anomalyCount: 0,
    };
    if (VERIFIED_CLASSIFICATIONS.has(event.classification) && event.usage) {
      accumulateUsage(state, event.usage);
      state.verifiedCount += 1;
    } else if (event.classification === "duplicate") {
      state.duplicateCount += 1;
    } else if (event.classification === "anomaly") {
      state.anomalyCount += 1;
    } else {
      state.unverifiedCount += 1;
    }
    states.set(key, state);
  }
  return states;
}

function accumulateUsage(state, usage) {
  for (const field of USAGE_FIELDS) {
    if (usage?.[field] == null) state.unavailable.add(field);
    else state.usage[field] += usage[field];
  }
}

function materializeUsageAccumulator(state) {
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, state.unavailable.has(field) ? null : state.usage[field]]),
  );
}

function taskKey(threadId, turnId) {
  return `${threadId}\u0000${turnId}`;
}

function localDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
