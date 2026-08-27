import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  estimateRequestCost,
  estimateTaskCost,
} from "../src/pricing.js";
import { scanRolloutMetadata, SessionRolloutParser } from "../src/rollout-parser.js";

const VERIFIED = new Set(["verified_increment", "generation_start"]);
const CURRENT_STANDARD_INSTANT = "2026-08-26T00:00:00.000Z";
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");
const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
const files = (await Promise.all(roots.map(findJsonlFiles))).flat().sort();
const beforeHashes = new Map();
for (const path of files) beforeHashes.set(path, await hashFile(path));

const entriesByRoot = new Map();
let metadataSkippedFiles = 0;
for (const path of files) {
  const scanned = await scanRolloutMetadata(path);
  const meta = scanned?.meta;
  const rootSessionId = meta?.session_id ?? meta?.id ?? null;
  if (!meta?.id || !rootSessionId) {
    metadataSkippedFiles += 1;
    continue;
  }
  const entries = entriesByRoot.get(rootSessionId) ?? [];
  entries.push({
    path,
    sourceKey: path,
    threadId: meta.id,
    rootSessionId,
    parentThreadId: meta.parent_thread_id ?? null,
    meta,
    envelopeTimestamp: scanned.envelopeTimestamp,
    createdAt: meta.timestamp ?? scanned.envelopeTimestamp,
  });
  entriesByRoot.set(rootSessionId, entries);
}

const report = createReport();
report.rolloutFiles = files.length;
report.metadataSkippedFiles = metadataSkippedFiles;
report.rootSessions = entriesByRoot.size;

for (const [rootSessionId, entries] of entriesByRoot) {
  const parser = new SessionRolloutParser(rootSessionId, { id: rootSessionId });
  await parser.parseFiles(entries);
  const snapshot = parser.snapshot();
  report.tasks += snapshot.tasks.length;
  const eventsByTask = groupEventsByTask(snapshot.modelUsageEvents);

  for (const event of snapshot.modelUsageEvents) inventoryEvent(report, event);

  for (const task of snapshot.tasks) {
    const events = eventsByTask.get(taskKey(task.threadId, task.turnId)) ?? [];
    const oldCost = estimateTaskCost(task.model, task.deltaUsage);
    const stage = stageRequestCosts(events);
    if (
      oldCost.status === "estimated" && Number.isFinite(oldCost.amountUsd) &&
      stage.currentSubscription != null && stage.historicalBase != null &&
      stage.longContext != null && stage.newAmount != null
    ) {
      report.comparableTasks += 1;
      report.reconciliation.oldCurrentApiEquivalentUsd += oldCost.amountUsd;
      report.reconciliation.subscriptionPolicyAdjustmentUsd += stage.currentSubscription - oldCost.amountUsd;
      report.reconciliation.historicalRateAdjustmentUsd += stage.historicalBase - stage.currentSubscription;
      report.reconciliation.longContextAdjustmentUsd += stage.longContext - stage.historicalBase;
      report.reconciliation.fastAdjustmentUsd += stage.newAmount - stage.longContext;
      report.reconciliation.newSubscriptionStandardEquivalentUsd += stage.newAmount;
    } else {
      report.unavailableComparisonTasks += 1;
    }
  }
}

for (const key of Object.keys(report.reconciliation)) {
  report.reconciliation[key] = roundUsd(report.reconciliation[key]);
}
report.knownNewAmountUsd = roundUsd(report.knownNewAmountUsd);
report.reconciliation.reconstructedNewUsd = roundUsd(
  report.reconciliation.oldCurrentApiEquivalentUsd +
  report.reconciliation.subscriptionPolicyAdjustmentUsd +
  report.reconciliation.historicalRateAdjustmentUsd +
  report.reconciliation.longContextAdjustmentUsd +
  report.reconciliation.fastAdjustmentUsd,
);
report.reconciliation.additivityDeltaUsd = roundUsd(
  report.reconciliation.newSubscriptionStandardEquivalentUsd -
  report.reconciliation.reconstructedNewUsd,
);

for (const bucket of Object.values(report.serviceTierInventory)) finalizeInventory(bucket);
finalizeInventory(report.longContextCandidates);
finalizeInventory(report.unknownModelInventory);

let hashChangedFiles = 0;
for (const path of files) {
  if ((await hashFile(path)) !== beforeHashes.get(path)) hashChangedFiles += 1;
}
report.hashChangedFiles = hashChangedFiles;
report.sourceReadOnly = hashChangedFiles === 0;

console.log(JSON.stringify(report, null, 2));

function stageRequestCosts(events) {
  let currentSubscription = 0;
  let historicalBase = 0;
  let longContext = 0;
  let newAmount = 0;
  let count = 0;
  for (const event of events) {
    if (!VERIFIED.has(event.classification) || !event.usage) continue;
    const current = estimateRequestCost(
      { ...event, observedAt: CURRENT_STANDARD_INSTANT, serviceTier: "default" },
      { applyFeaturePolicy: false },
    );
    const historical = estimateRequestCost(
      { ...event, serviceTier: "default" },
      { applyFeaturePolicy: false },
    );
    const longOnly = estimateRequestCost({ ...event, serviceTier: "default" });
    const actual = estimateRequestCost(event);
    if (![current, historical, longOnly, actual].every((cost) => Number.isFinite(cost.amountUsd))) {
      return { currentSubscription: null, historicalBase: null, longContext: null, newAmount: null };
    }
    currentSubscription += current.amountUsd;
    historicalBase += historical.amountUsd;
    longContext += longOnly.amountUsd;
    newAmount += actual.amountUsd;
    count += 1;
  }
  if (count === 0) return { currentSubscription: null, historicalBase: null, longContext: null, newAmount: null };
  return { currentSubscription, historicalBase, longContext, newAmount };
}

function inventoryEvent(report, event) {
  if (!VERIFIED.has(event?.classification) || !event?.usage) return;
  report.verifiedUsageUnits += 1;
  report.verifiedTokens += event.usage.totalTokens ?? 0;
  const rawTier = typeof event.serviceTier === "string" ? event.serviceTier.toLowerCase() : "unknown";
  const tierKey = rawTier === "default" || rawTier === "fast" || rawTier === "priority"
    ? rawTier
    : "unknown";
  addInventory(report.serviceTierInventory[tierKey], event);
  if ((event.usage.inputTokens ?? 0) > 272_000) addInventory(report.longContextCandidates, event);
  const priced = estimateRequestCost(event);
  if (priced.reason === "missing_model" || priced.reason === "historical_rate_unavailable") {
    addInventory(report.unknownModelInventory, event);
  }
  if (priced.reason) {
    report.pricingReasonCounts[priced.reason] = (report.pricingReasonCounts[priced.reason] ?? 0) + 1;
  }
  if (Number.isFinite(priced.amountUsd)) report.knownNewAmountUsd += priced.amountUsd;
  if (priced.status === "estimated") report.estimatedUsageUnits += 1;
  else if (priced.status === "partial") report.partialUsageUnits += 1;
  else report.unavailableUsageUnits += 1;
}

function createReport() {
  return {
    codexHome,
    policy: "subscription-standard-equivalent",
    policyVersion: "2026-08-26",
    requestBoundaryGate: "model_sampling_usage_boundary_verified",
    rolloutFiles: 0,
    metadataSkippedFiles: 0,
    rootSessions: 0,
    tasks: 0,
    comparableTasks: 0,
    unavailableComparisonTasks: 0,
    verifiedUsageUnits: 0,
    verifiedTokens: 0,
    estimatedUsageUnits: 0,
    partialUsageUnits: 0,
    unavailableUsageUnits: 0,
    knownNewAmountUsd: 0,
    reconciliation: {
      oldCurrentApiEquivalentUsd: 0,
      subscriptionPolicyAdjustmentUsd: 0,
      historicalRateAdjustmentUsd: 0,
      longContextAdjustmentUsd: 0,
      fastAdjustmentUsd: 0,
      newSubscriptionStandardEquivalentUsd: 0,
    },
    longContextCandidates: emptyInventory(),
    serviceTierInventory: {
      default: emptyInventory(),
      fast: emptyInventory(),
      priority: emptyInventory(),
      unknown: emptyInventory(),
    },
    unknownModelInventory: emptyInventory(),
    pricingReasonCounts: {},
    hashChangedFiles: null,
    sourceReadOnly: null,
  };
}

function emptyInventory() {
  return { count: 0, tokens: 0, inputTokens: 0, amountUsd: 0 };
}

function addInventory(bucket, event) {
  bucket.count += 1;
  bucket.tokens += event.usage?.totalTokens ?? 0;
  bucket.inputTokens += event.usage?.inputTokens ?? 0;
  const priced = estimateRequestCost(event);
  if (Number.isFinite(priced.amountUsd)) bucket.amountUsd += priced.amountUsd;
}

function finalizeInventory(bucket) {
  bucket.amountUsd = roundUsd(bucket.amountUsd);
}

function groupEventsByTask(events) {
  const grouped = new Map();
  for (const event of events ?? []) {
    const key = taskKey(event.threadId, event.turnId);
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }
  return grouped;
}

function taskKey(threadId, turnId) {
  return `${threadId ?? ""}\u0000${turnId ?? ""}`;
}

async function findJsonlFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findJsonlFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) result.push(path);
  }
  return result;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}
