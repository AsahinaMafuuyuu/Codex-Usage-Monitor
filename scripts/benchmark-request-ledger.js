import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../src/database.js";
import { UsageMonitor } from "../src/monitor.js";
import { CodexRepository } from "../src/repository.js";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-request-ledger-"));
const databasePath = join(directory, "usage.sqlite");
let database;
let monitor;

try {
  database = new MonitorDatabase(databasePath);
  const repository = new CodexRepository(codexHome, database);
  monitor = new UsageMonitor({ repository, database });
  const startedAt = performance.now();
  await monitor.initialize();
  await monitor.timeline();
  const elapsedMs = performance.now() - startedAt;
  const stats = database.getHealthStats();
  const taskRows = Number(database.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count ?? 0);
  const verifiedRows = Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM model_usage_events
    WHERE classification IN ('verified_increment', 'generation_start')
  `).get().count ?? 0);
  const duplicateRows = Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM model_usage_events WHERE classification='duplicate'
  `).get().count ?? 0);
  const unverifiedRows = Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM model_usage_events WHERE classification='unverified'
  `).get().count ?? 0);
  const anomalyRows = Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM model_usage_events WHERE classification='anomaly'
  `).get().count ?? 0);
  const beforeCloseBytes = (await stat(databasePath)).size;

  monitor.close();
  monitor = null;
  database.close();
  database = null;

  const afterCloseBytes = (await stat(databasePath)).size;
  console.log(JSON.stringify({
    codexHome,
    rolloutFiles: repository.summary().rolloutFiles,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    taskRows,
    modelUsageEventRows: stats.modelUsageEventRows,
    verifiedRows,
    duplicateRows,
    unverifiedRows,
    anomalyRows,
    databaseBytesBeforeClose: beforeCloseBytes,
    databaseBytesAfterClose: afterCloseBytes,
    pageSize: stats.pageSize,
    pageCount: stats.pageCount,
    cacheSize: stats.cacheSize,
    mmapSize: stats.mmapSize,
    walAutoCheckpoint: stats.walAutoCheckpoint,
  }, null, 2));
} finally {
  monitor?.close();
  database?.close();
  await rm(directory, { recursive: true, force: true });
}
