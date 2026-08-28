import {
  combineCostSummaries,
  priceTasksByRequestEvents,
  summarizeTaskCosts,
} from "./pricing.js";
import { materializeRequestLedgerTasks } from "./request-ledger.js";
import { resolveCanonicalRequestOwnership } from "./request-ownership.js";
import { addUsage, sumTaskUsage, zeroUsage } from "./usage.js";

const QUALITY_KEYS = ["complete", "provisional", "partial", "unknown"];

export function resolveLocalDayRange(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    throw new TypeError("day 必须使用 YYYY-MM-DD 格式");
  }
  const [year, month, date] = day.split("-").map(Number);
  const start = new Date(0);
  start.setFullYear(year, month - 1, date);
  start.setHours(0, 0, 0, 0);
  if (formatLocalDay(start) !== day) {
    throw new TypeError("day 不是合法本地日期");
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    day,
    startMs: start.getTime(),
    endMs: end.getTime(),
    timezone: localTimezone(),
  };
}

export function materializeScopedSnapshot(
  stored,
  scope = { type: "session" },
  { ownershipResolved = false } = {},
) {
  const normalized = normalizeScope(scope);
  const ownership = resolveCanonicalRequestOwnership({
    agents: stored?.agents ?? [],
    tasks: stored?.tasks ?? [],
    events: stored?.modelUsageEvents ?? [],
    rootCreatedAt: ownershipResolved
      ? null
      : stored?.session?.createdAt ?? stored?.session?.created_at ?? null,
  });
  const sourceTasks = ownership.tasks;
  const sourceEvents = ownership.events;
  const tasks = normalized.type === "day"
    ? materializeTaskDaySlices(sourceTasks, sourceEvents, normalized.range)
    : priceTasksByRequestEvents(
      materializeRequestLedgerTasks(sourceTasks, sourceEvents),
      sourceEvents,
    );
  const agents = materializeAgents(stored?.agents ?? [], tasks, normalized.type);
  const agentsById = new Map(agents.map((agent) => [agent.threadId, agent]));
  const rootAgent = agents.find((agent) => agent.isRoot);
  let subagentUsage = zeroUsage();
  for (const agent of agents) {
    if (!agent.isRoot) subagentUsage = addUsage(subagentUsage, agent.ownUsage);
  }
  const totalUsage = rootAgent?.subtreeUsage ?? sumTaskUsage(tasks);
  const modelRequestCount = tasks.reduce((sum, task) => sum + (task.requestCount ?? 0), 0);
  const subagentTasks = tasks.filter((task) => {
    const agent = agentsById.get(task.threadId);
    return agent && !agent.isRoot;
  });
  const subagentModelRequestCount = subagentTasks.reduce(
    (sum, task) => sum + (task.requestCount ?? 0),
    0,
  );
  const qualityCounts = emptyQualityCounts();
  for (const task of tasks) {
    const quality = QUALITY_KEYS.includes(task.quality) ? task.quality : "unknown";
    qualityCounts[quality] += 1;
  }

  return {
    session: stored?.session ?? null,
    agents,
    scope: normalized.type === "day"
      ? { type: "day", day: normalized.day, timezone: normalized.range.timezone }
      : { type: "session" },
    summary: {
      agentCount: agents.filter((agent) => !agent.isRoot).length,
      taskCount: tasks.length,
      activeTasks: tasks.filter((task) => task.status === "in_progress").length,
      totalUsage,
      subagentUsage,
      modelRequestCount,
      tokensPerModelRequest: tokensPerRequest(totalUsage, modelRequestCount),
      subagentModelRequestCount,
      subagentTokensPerModelRequest: tokensPerRequest(subagentUsage, subagentModelRequestCount),
      qualityCounts,
      totalCostEstimate: summarizeTaskCosts(tasks),
      subagentCostEstimate: summarizeTaskCosts(subagentTasks),
      ownershipReconciliation: ownership.reconciliation,
    },
  };
}

export function materializeCalendarSlices(
  stored,
  { now = Date.now(), ownershipResolved = false } = {},
) {
  const ownership = resolveCanonicalRequestOwnership({
    agents: stored?.agents ?? [],
    tasks: stored?.tasks ?? [],
    events: stored?.modelUsageEvents ?? [],
    rootCreatedAt: ownershipResolved
      ? null
      : stored?.session?.createdAt ?? stored?.session?.created_at ?? null,
  });
  const sourceTasks = ownership.tasks;
  const sourceEvents = ownership.events;
  const tasksByDay = materializeCalendarTaskSlices(sourceTasks, sourceEvents, now);
  return [...tasksByDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, tasks]) => {
      const usage = sumTaskUsage(tasks);
      const modelRequestCount = tasks.reduce((sum, task) => sum + (task.requestCount ?? 0), 0);
      const qualityCounts = emptyQualityCounts();
      for (const task of tasks) {
        const quality = QUALITY_KEYS.includes(task.quality) ? task.quality : "unknown";
        qualityCounts[quality] += 1;
      }
      return {
        day,
        usage,
        modelRequestCount,
        taskCount: tasks.length,
        activeTaskCount: tasks.filter((task) => task.status === "in_progress").length,
        qualityCounts,
        costEstimate: summarizeTaskCosts(tasks),
        tasks,
      };
    });
}

function materializeTaskDaySlices(tasks, events, range) {
  const knownTasks = new Map(tasks.map((task) => [taskKey(task.threadId, task.turnId), task]));
  const scopedEvents = events.filter((event) => eventInRange(event, range));
  const eventBackedTaskKeys = new Set();
  for (const event of scopedEvents) {
    const key = taskKey(event.threadId, event.turnId);
    if (knownTasks.has(key)) eventBackedTaskKeys.add(key);
  }
  const scopedTasks = tasks.filter((task) =>
    eventBackedTaskKeys.has(taskKey(task.threadId, task.turnId))
  );
  return priceTasksByRequestEvents(
    materializeRequestLedgerTasks(scopedTasks, scopedEvents),
    scopedEvents,
  );
}

function materializeAgents(sourceAgents, tasks, scopeType) {
  const allAgentsById = new Map(sourceAgents.map((agent) => [agent.threadId, agent]));
  const visibleIds = scopeType === "day"
    ? collectVisibleAgentIds(tasks, allAgentsById)
    : new Set(sourceAgents.map((agent) => agent.threadId));
  const agents = sourceAgents
    .filter((agent) => visibleIds.has(agent.threadId))
    .map((agent) => ({
      ...agent,
      tasks: [],
      ownUsage: zeroUsage(),
      subtreeUsage: zeroUsage(),
      ownModelRequestCount: 0,
      subtreeModelRequestCount: 0,
      ownTokensPerModelRequest: null,
      subtreeTokensPerModelRequest: null,
      ownCostEstimate: null,
      subtreeCostEstimate: null,
    }));
  const byId = new Map(agents.map((agent) => [agent.threadId, agent]));
  for (const task of tasks) byId.get(task.threadId)?.tasks.push(task);
  for (const agent of agents) {
    agent.taskCount = agent.tasks.length;
    agent.ownUsage = sumTaskUsage(agent.tasks);
    agent.subtreeUsage = structuredClone(agent.ownUsage);
    agent.ownModelRequestCount = agent.tasks.reduce(
      (sum, task) => sum + (task.requestCount ?? 0),
      0,
    );
    agent.subtreeModelRequestCount = agent.ownModelRequestCount;
    agent.ownTokensPerModelRequest = tokensPerRequest(agent.ownUsage, agent.ownModelRequestCount);
    agent.subtreeTokensPerModelRequest = agent.ownTokensPerModelRequest;
    agent.ownCostEstimate = summarizeTaskCosts(agent.tasks);
    agent.subtreeCostEstimate = { ...agent.ownCostEstimate };
  }
  for (const agent of [...agents].sort((left, right) => right.depth - left.depth)) {
    const parent = byId.get(agent.parentThreadId);
    if (!parent) continue;
    parent.subtreeUsage = addUsage(parent.subtreeUsage, agent.subtreeUsage);
    parent.subtreeModelRequestCount += agent.subtreeModelRequestCount;
    parent.subtreeCostEstimate = combineCostSummaries([
      parent.subtreeCostEstimate,
      agent.subtreeCostEstimate,
    ]);
  }
  for (const agent of agents) {
    agent.subtreeTokensPerModelRequest = tokensPerRequest(
      agent.subtreeUsage,
      agent.subtreeModelRequestCount,
    );
  }
  return agents;
}

function collectVisibleAgentIds(tasks, agentsById) {
  const visible = new Set();
  for (const task of tasks) {
    let threadId = task.threadId;
    const visited = new Set();
    while (threadId && !visited.has(threadId)) {
      visited.add(threadId);
      const agent = agentsById.get(threadId);
      if (!agent) break;
      visible.add(threadId);
      threadId = agent.parentThreadId;
    }
  }
  return visible;
}

function materializeCalendarTaskSlices(tasks, events, now) {
  const knownTasks = new Map(tasks.map((task) => [taskKey(task.threadId, task.turnId), task]));
  const slices = new Map();
  const ranges = new Map();
  const ensureSlice = (day, task) => {
    const daySlices = slices.get(day) ?? new Map();
    const key = taskKey(task.threadId, task.turnId);
    const slice = daySlices.get(key) ?? { task, events: [] };
    daySlices.set(key, slice);
    slices.set(day, daySlices);
    return slice;
  };
  const rangeFor = (day) => {
    const cached = ranges.get(day);
    if (cached) return cached;
    const range = resolveLocalDayRange(day);
    ranges.set(day, range);
    return range;
  };

  for (const event of events) {
    const task = knownTasks.get(taskKey(event.threadId, event.turnId));
    if (!task) continue;
    const day = localDayForInstant(event.observedAt);
    if (!day) continue;
    ensureSlice(day, task).events.push(event);
  }

  const result = new Map();
  for (const [day, daySlices] of slices) {
    const materialized = [];
    for (const { task, events: taskEvents } of daySlices.values()) {
      const [slice] = materializeRequestLedgerTasks([task], taskEvents);
      if (slice) materialized.push(priceTasksByRequestEvents([slice], taskEvents)[0]);
    }
    result.set(day, materialized);
  }
  return result;
}

function taskLifecycleIntersects(task, range) {
  const startMs = timestampMs(task.startedAt);
  if (!Number.isFinite(startMs)) return false;
  const completedMs = timestampMs(task.completedAt);
  const endMs = Number.isFinite(completedMs) ? completedMs : Number.POSITIVE_INFINITY;
  return startMs < range.endMs && endMs > range.startMs;
}

function eventInRange(event, range) {
  const observedMs = timestampMs(event?.observedAt);
  return Number.isFinite(observedMs) && observedMs >= range.startMs && observedMs < range.endMs;
}

function normalizeScope(scope) {
  if (!scope || scope.type === "session") return { type: "session" };
  if (scope.type !== "day") throw new TypeError("未知 snapshot scope");
  const range = scope.range ?? resolveLocalDayRange(scope.day);
  return { type: "day", day: range.day, range };
}

function emptyQualityCounts() {
  return Object.fromEntries(QUALITY_KEYS.map((key) => [key, 0]));
}

function tokensPerRequest(usage, count) {
  const requestCount = Number(count ?? 0);
  const totalTokens = usage?.totalTokens;
  return Number.isFinite(totalTokens) && requestCount > 0 ? totalTokens / requestCount : null;
}

function taskKey(threadId, turnId) {
  return `${threadId ?? ""}\u0000${turnId ?? ""}`;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function localDayForInstant(value) {
  const milliseconds = typeof value === "number" ? value : timestampMs(value);
  if (!Number.isFinite(milliseconds)) return null;
  return formatLocalDay(new Date(milliseconds));
}

function formatLocalDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "当地时区";
}
