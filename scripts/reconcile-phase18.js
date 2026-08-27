import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorDatabase } from "../src/database.js";
import { resolveCanonicalRequestOwnership } from "../src/request-ownership.js";
import { scanRolloutMetadata, SessionRolloutParser } from "../src/rollout-parser.js";
import { materializeScopedSnapshot, resolveLocalDayRange } from "../src/snapshot-scope.js";
import { CodexSourceLocator } from "../src/source-locator.js";

const sessionId = readArgument("--session");
if (!sessionId) throw new Error("Usage: npm run reconcile:phase18 -- --session <root-session-id>");

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const locator = new CodexSourceLocator(codexHome);
const candidates = (await Promise.all([
  findJsonlFiles(join(codexHome, "sessions")),
  findJsonlFiles(join(codexHome, "archived_sessions")),
])).flat().sort();

const entries = [];
for (const path of candidates) {
  const scanned = await scanRolloutMetadata(path);
  if (!scanned?.meta) continue;
  const rootSessionId = scanned.meta.session_id ?? scanned.meta.id;
  if (rootSessionId !== sessionId) continue;
  entries.push({
    path,
    sourceKey: locator.keyForPath(path),
    threadId: scanned.meta.id,
    rootSessionId,
    meta: scanned.meta,
    envelopeTimestamp: scanned.envelopeTimestamp,
    createdAt: scanned.meta.timestamp ?? scanned.envelopeTimestamp ?? null,
    fileSize: scanned.fileSize,
    modifiedAtMs: scanned.modifiedAtMs,
  });
}
if (!entries.length) throw new Error(`No rollout files found for ${sessionId}`);

const before = new Map();
for (const entry of entries) before.set(entry.path, await hashFile(entry.path));
const beforeManifestSha256 = manifestHash(entries, before);

const started = performance.now();
const parser = new SessionRolloutParser(sessionId, { id: sessionId });
const parsed = await parser.parseFiles(entries);
const resolved = resolveCanonicalRequestOwnership({
  agents: parsed.agents,
  tasks: parsed.tasks,
  events: parsed.modelUsageEvents,
});
const parseMs = performance.now() - started;
const classificationCounts = {};
for (const event of parsed.modelUsageEvents ?? []) {
  classificationCounts[event.classification] = (classificationCounts[event.classification] ?? 0) + 1;
}

const taskCounts = { raw: parsed.tasks.length, canonical: 0, inherited: 0, unresolved: 0 };
for (const row of resolved.ownership) {
  if (row.status === "canonical") {
    taskCounts.canonical += 1;
    taskCounts.inherited += Number(row.duplicateCount ?? 0);
  } else {
    taskCounts.unresolved += Number(row.duplicateCount ?? 0) + 1;
  }
}

let hashChangedFiles = 0;
const after = new Map();
for (const entry of entries) {
  const hash = await hashFile(entry.path);
  after.set(entry.path, hash);
  if (hash !== before.get(entry.path)) hashChangedFiles += 1;
}
const afterManifestSha256 = manifestHash(entries, after);

const projection = await benchmarkProjection(parsed, resolved.requests);

console.log(JSON.stringify({
  sessionId,
  rolloutFiles: entries.length,
  parseMs: Math.round(parseMs * 100) / 100,
  parser: {
    modelUsageEvents: parsed.modelUsageEvents?.length ?? 0,
    classificationCounts,
    health: parsed.health,
  },
  nativeIdentity: {
    nativeRequests: resolved.requests.filter((event) => event.requestIdentityKind === "native").length,
    reconstructedRequests: resolved.requests.filter((event) => event.requestIdentityKind === "reconstructed").length,
  },
  tasks: taskCounts,
  requests: {
    rawVerifiedEvidence: resolved.reconciliation.rawVerifiedEvents,
    canonicalRequests: resolved.requests.length,
    inheritedCopies: resolved.reconciliation.inheritedVerifiedEvents,
    unresolved: resolved.reconciliation.unresolvedVerifiedEvents,
  },
  usage: {
    rawObserved: resolved.reconciliation.rawUsage,
    canonicalBusiness: resolved.reconciliation.canonicalUsage,
    inheritedProvenance: resolved.reconciliation.inheritedUsage,
    unresolved: resolved.reconciliation.unresolvedUsage,
    conserved: resolved.reconciliation.conserved,
  },
  projection,
  beforeManifestSha256,
  afterManifestSha256,
  hashChangedFiles,
}, null, 2));

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function findJsonlFiles(root) {
  let rows;
  try {
    rows = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const row of rows) {
    const path = join(root, row.name);
    if (row.isDirectory()) files.push(...await findJsonlFiles(path));
    else if (row.isFile() && row.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function benchmarkProjection(parsed, canonicalRequests) {
  const directory = await mkdtemp(join(tmpdir(), "codex-phase18-projection-"));
  const databasePath = join(directory, "usage.sqlite");
  const database = new MonitorDatabase(databasePath);
  try {
    const persistStarted = performance.now();
    database.replaceSession(parsed, { persistQuotas: false });
    const persistMs = performance.now() - persistStarted;
    const day = latestLocalDay(canonicalRequests);
    const range = day ? resolveLocalDayRange(day) : null;
    const timelineSamples = [];
    const detailSamples = [];
    for (let index = 0; index < 20; index += 1) {
      let started = performance.now();
      database.getTimeline(new Map([[sessionId, parsed.session]]));
      timelineSamples.push(performance.now() - started);
      if (range) {
        started = performance.now();
        const stored = database.getSessionDay(sessionId, range);
        materializeScopedSnapshot(stored, { type: "day", day, range });
        detailSamples.push(performance.now() - started);
      }
    }
    const health = database.getHealthStats();
    const databaseBytes = (await stat(databasePath)).size;
    let walBytes = 0;
    try {
      walBytes = (await stat(`${databasePath}-wal`)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      persistMs: rounded(persistMs),
      benchmarkDay: day,
      warmTimelineP95Ms: percentile(timelineSamples, 0.95),
      warmSessionDayP95Ms: percentile(detailSamples, 0.95),
      rawEvidenceRows: health.modelUsageEventRows,
      canonicalRequestRows: health.canonicalRequestRows,
      projectionRows: health.calendarRows,
      databaseBytes,
      walBytes,
    };
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function latestLocalDay(events) {
  const days = events.map((event) => localDay(event.observedAt)).filter(Boolean).sort();
  return days.at(-1) ?? null;
}

function localDay(value) {
  const date = new Date(value ?? "");
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]);
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function manifestHash(entries, hashes) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.sourceKey}|${hashes.get(entry.path)}\n`);
  }
  return hash.digest("hex");
}
