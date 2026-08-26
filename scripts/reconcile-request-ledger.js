import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../src/database.js";
import { UsageMonitor } from "../src/monitor.js";
import {
  aggregateVerifiedUsageByLocalDay,
  reconcileRequestLedger,
} from "../src/reconciliation.js";
import { CodexRepository } from "../src/repository.js";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-reconciliation-"));
const databasePath = join(directory, "usage.sqlite");
let database;
let monitor;

try {
  database = new MonitorDatabase(databasePath);
  const repository = new CodexRepository(codexHome, database);
  monitor = new UsageMonitor({ repository, database });
  await monitor.initialize();
  const primaryTimeline = await monitor.timeline();

  const sessionIds = database.db.prepare("SELECT id FROM sessions ORDER BY id").all().map((row) => row.id);
  const allEvents = [];
  const combined = {
    taskCount: 0,
    exact_match: 0,
    schema_limited_match: 0,
    mismatch: 0,
    recovered: 0,
    not_comparable: 0,
    eventCounts: {
      verified: 0,
      duplicate: 0,
      unverified: 0,
      anomaly: 0,
      unattributedVerified: 0,
    },
  };
  const mismatches = [];
  const recoveries = [];
  const notComparableByQuality = {};
  let notComparableWithRequestUsage = 0;

  for (const sessionId of sessionIds) {
    const stored = database.getSession(sessionId);
    if (!stored) continue;
    allEvents.push(...stored.modelUsageEvents);
    const report = reconcileRequestLedger(stored.tasks, stored.modelUsageEvents);
    for (const key of [
      "taskCount",
      "exact_match",
      "schema_limited_match",
      "mismatch",
      "recovered",
      "not_comparable",
    ]) combined[key] += report.summary[key];
    for (const [key, value] of Object.entries(report.summary.eventCounts)) {
      combined.eventCounts[key] += value;
    }
    mismatches.push(...report.tasks.filter((item) => item.status === "mismatch"));
    recoveries.push(...report.tasks.filter((item) => item.status === "recovered"));
    for (const item of report.tasks.filter((entry) => entry.status === "not_comparable")) {
      notComparableByQuality[item.taskQuality] = (notComparableByQuality[item.taskQuality] ?? 0) + 1;
      if (item.requestUsage?.totalTokens != null && item.requestUsage.totalTokens > 0) {
        notComparableWithRequestUsage += 1;
      }
    }
  }

  const days = aggregateVerifiedUsageByLocalDay(allEvents);
  console.log(JSON.stringify({
    codexHome,
    rolloutFiles: repository.summary().rolloutFiles,
    sessions: sessionIds.length,
    summary: combined,
    dayTotals: Object.fromEntries(
      Object.entries(days).map(([day, value]) => [day, value.usage.totalTokens]),
    ),
    requestCountsByDay: Object.fromEntries(
      Object.entries(days).map(([day, value]) => [day, value.requestCount]),
    ),
    primaryTimelineDayTotals: Object.fromEntries(
      primaryTimeline.months.flatMap((month) => month.days)
        .map((day) => [day.key, day.usage.totalTokens]),
    ),
    primaryTimelineRequestCounts: Object.fromEntries(
      primaryTimeline.months.flatMap((month) => month.days)
        .map((day) => [day.key, day.modelRequestCount]),
    ),
    notComparableByQuality,
    notComparableWithRequestUsage,
    mismatchSample: mismatches.slice(0, 20).map(compactTaskResult),
    recoverySample: recoveries.slice(0, 20).map(compactTaskResult),
  }, null, 2));
} finally {
  monitor?.close();
  database?.close();
  await rm(directory, { recursive: true, force: true });
}

function compactTaskResult(item) {
  return {
    rootSessionId: item.rootSessionId,
    threadId: item.threadId,
    turnId: item.turnId,
    taskQuality: item.taskQuality,
    status: item.status,
    requestCount: item.requestCount,
    mismatchFields: item.mismatchFields,
    unavailableFields: item.unavailableFields,
    boundaryTotalTokens: item.boundaryUsage?.totalTokens ?? null,
    requestTotalTokens: item.requestUsage?.totalTokens ?? null,
  };
}
