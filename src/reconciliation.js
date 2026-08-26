import { USAGE_FIELDS, zeroUsage } from "./usage.js";

const VERIFIED_CLASSIFICATIONS = new Set(["verified_increment", "generation_start"]);

export function reconcileRequestLedger(tasks = [], events = []) {
  const byTask = new Map();
  const eventCounts = {
    verified: 0,
    duplicate: 0,
    unverified: 0,
    anomaly: 0,
    unattributedVerified: 0,
  };

  for (const event of events) {
    if (VERIFIED_CLASSIFICATIONS.has(event.classification) && event.usage) {
      eventCounts.verified += 1;
      if (!event.threadId || !event.turnId) {
        eventCounts.unattributedVerified += 1;
        continue;
      }
      const key = taskKey(event.threadId, event.turnId);
      const state = byTask.get(key) ?? createUsageAccumulator();
      accumulateUsage(state, event.usage);
      state.requestCount += 1;
      byTask.set(key, state);
    } else if (event.classification === "duplicate") {
      eventCounts.duplicate += 1;
    } else if (event.classification === "anomaly") {
      eventCounts.anomaly += 1;
    } else {
      eventCounts.unverified += 1;
    }
  }

  const results = [];
  const statusCounts = {
    exact_match: 0,
    schema_limited_match: 0,
    mismatch: 0,
    recovered: 0,
    not_comparable: 0,
  };
  for (const task of tasks) {
    const state = byTask.get(taskKey(task.threadId, task.turnId));
    const requestUsage = state ? materializeUsageAccumulator(state) : null;
    const comparison = compareUsage(task.deltaUsage, requestUsage);
    let status = "not_comparable";
    if (task.quality === "complete" && task.deltaUsage && requestUsage) {
      if (comparison.mismatchFields.length) status = "mismatch";
      else if (comparison.unavailableFields.length) status = "schema_limited_match";
      else status = "exact_match";
    } else if (
      task.quality === "discontinuity" &&
      requestUsage &&
      requestUsage.totalTokens != null &&
      requestUsage.totalTokens > 0
    ) {
      status = "recovered";
    }
    statusCounts[status] += 1;
    results.push({
      rootSessionId: task.rootSessionId ?? null,
      threadId: task.threadId,
      turnId: task.turnId,
      taskQuality: task.quality,
      status,
      boundaryUsage: task.deltaUsage ?? null,
      requestUsage,
      requestCount: state?.requestCount ?? 0,
      comparedFields: comparison.comparedFields,
      unavailableFields: comparison.unavailableFields,
      mismatchFields: comparison.mismatchFields,
    });
  }

  return {
    tasks: results,
    summary: {
      taskCount: results.length,
      ...statusCounts,
      eventCounts,
    },
  };
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

function compareUsage(boundaryUsage, requestUsage) {
  const comparedFields = [];
  const unavailableFields = [];
  const mismatchFields = [];
  for (const field of USAGE_FIELDS) {
    const boundary = boundaryUsage?.[field];
    const request = requestUsage?.[field];
    if (boundary == null || request == null) {
      unavailableFields.push(field);
      continue;
    }
    comparedFields.push(field);
    if (boundary !== request) mismatchFields.push(field);
  }
  return { comparedFields, unavailableFields, mismatchFields };
}

function createUsageAccumulator() {
  return {
    usage: zeroUsage(),
    unavailable: new Set(),
    requestCount: 0,
  };
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
