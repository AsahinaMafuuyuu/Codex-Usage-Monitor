import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { addUsage, classifyModelUsageEvent, normalizeUsage, zeroUsage } from "../src/usage.js";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
const files = (await Promise.all(roots.map((root) => findJsonlFiles(root)))).flat().sort();
const classificationCounts = Object.fromEntries(
  ["verified_increment", "duplicate", "generation_start", "unverified", "anomaly"].map((key) => [key, 0]),
);
const reasonCounts = {};
const dayUsage = new Map();
let tokenCount = 0;
let hashChangedFiles = 0;

for (const path of files) {
  const beforeHash = await hashFile(path);
  let previousTotal = null;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.type === "event_msg" ? record.payload : null;
    if (payload?.type !== "token_count") continue;
    tokenCount += 1;
    const currentTotal = normalizeUsage(payload.info?.total_token_usage);
    const lastUsage = normalizeUsage(payload.info?.last_token_usage);
    const result = classifyModelUsageEvent(previousTotal, currentTotal, lastUsage);
    classificationCounts[result.classification] += 1;
    reasonCounts[result.reason] = (reasonCounts[result.reason] ?? 0) + 1;
    if (
      result.usage &&
      (result.classification === "verified_increment" || result.classification === "generation_start")
    ) {
      const day = localDay(record.timestamp);
      if (day) dayUsage.set(day, addUsage(dayUsage.get(day) ?? zeroUsage(), result.usage));
    }
    if (currentTotal) previousTotal = currentTotal;
  }
  if ((await hashFile(path)) !== beforeHash) hashChangedFiles += 1;
}

const verifiedUsageEvents =
  classificationCounts.verified_increment + classificationCounts.generation_start;
console.log(JSON.stringify({
  codexHome,
  rolloutFiles: files.length,
  tokenCount,
  verifiedUsageEvents,
  classificationCounts,
  reasonCounts,
  hashChangedFiles,
  dayTotals: Object.fromEntries(
    [...dayUsage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, usage]) => [day, usage.totalTokens]),
  ),
}, null, 2));

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

function localDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
