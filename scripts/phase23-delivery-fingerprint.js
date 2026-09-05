import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "../src/server.js";

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const codexHome = process.env.CODEX_HOME || process.env.CODEX_MONITOR_HOME || join(homedir(), ".codex");

const db = new DatabaseSync(databasePath, { readOnly: true });
let accounting;
try {
  db.exec("PRAGMA query_only=ON;");
  const canonical = db.prepare(`
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM canonical_requests
  `).get();
  const days = db.prepare(`
    SELECT
      COALESCE(SUM(model_request_count), 0) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      ROUND(COALESCE(SUM(cost_amount_usd), 0), 8) AS known_cost_amount_usd,
      COALESCE(SUM(estimated_requests), 0) AS estimated_requests,
      COALESCE(SUM(partial_requests), 0) AS partial_requests,
      COALESCE(SUM(unavailable_requests), 0) AS unavailable_requests
    FROM session_day_usage
  `).get();
  const projection = Object.fromEntries(db.prepare(`
    SELECT key, value
    FROM derived_state
    WHERE key IN ('projection_generation', 'projection_version', 'pricing_policy_version')
    ORDER BY key
  `).all().map((row) => [row.key, row.value]));
  accounting = {
    canonical: numericRow(canonical),
    calendar: numericRow(days),
    projection,
    canonicalEqualsCalendar: usageFingerprint(canonical) === usageFingerprint(days),
  };
} finally {
  db.close();
}

const rolloutFiles = (await Promise.all([
  collectJsonl(join(codexHome, "sessions")),
  collectJsonl(join(codexHome, "archived_sessions")),
])).flat().sort();
const manifest = createHash("sha256");
for (const path of rolloutFiles) {
  manifest.update(relative(codexHome, path).replaceAll("\\", "/"));
  manifest.update("\u0000");
  manifest.update(await hashFile(path));
  manifest.update("\n");
}

console.log(JSON.stringify({
  databasePath,
  accounting,
  rollout: {
    codexHome,
    fileCount: rolloutFiles.length,
    manifestSha256: manifest.digest("hex"),
  },
}, null, 2));

function usageFingerprint(row) {
  return [
    "request_count",
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ].map((key) => String(Number(row?.[key] ?? 0))).join("|");
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [
    key,
    typeof value === "number" ? value : Number(value),
  ]));
}

async function collectJsonl(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await collectJsonl(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) paths.push(path);
  }
  return paths;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
