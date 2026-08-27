import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { scanRolloutMetadata } from "../src/rollout-parser.js";

const sessionId = readArgument("--session");
if (!sessionId) throw new Error("Usage: node scripts/audit-unknown-records.js --session <root-session-id>");

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const files = (await Promise.all([
  findJsonlFiles(join(codexHome, "sessions")),
  findJsonlFiles(join(codexHome, "archived_sessions")),
])).flat().sort();

const targetFiles = [];
for (const path of files) {
  const scanned = await scanRolloutMetadata(path);
  if (!scanned?.meta) continue;
  if ((scanned.meta.session_id ?? scanned.meta.id) === sessionId) targetFiles.push(path);
}

const knownRecordTypes = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);
const handledEventTypes = new Set([
  "task_started",
  "turn_started",
  "task_complete",
  "turn_complete",
  "turn_completed",
  "task_aborted",
  "turn_aborted",
  "task_interrupted",
  "turn_interrupted",
  "task_cancelled",
  "turn_cancelled",
  "token_count",
  "thread_settings_applied",
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "item_completed",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "thread_rolled_back",
  "user_message",
  "web_search_end",
]);
const auditedNonAccountingEventTypes = new Set([
  "patch_apply_end",
  "thread_rolled_back",
  "user_message",
  "web_search_end",
]);

const counts = new Map();
const keyShapes = new Map();
const nonAccountingCounts = new Map();
let unknownRecords = 0;
let parsedRecords = 0;

for (const path of targetFiles) {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    parsedRecords += 1;
    if (record?.type === "event_msg" && auditedNonAccountingEventTypes.has(record?.payload?.type)) {
      const eventType = record.payload.type;
      nonAccountingCounts.set(eventType, (nonAccountingCounts.get(eventType) ?? 0) + 1);
    }
    let bucket = null;
    if (!knownRecordTypes.has(record?.type)) {
      bucket = `record:${String(record?.type ?? "<missing>")}`;
    } else if (record.type === "event_msg") {
      const eventType = record?.payload?.type;
      if (typeof eventType === "string" && !handledEventTypes.has(eventType)) {
        bucket = `event:${eventType}`;
      }
    }
    if (!bucket) continue;
    unknownRecords += 1;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    const shape = [
      ...Object.keys(record ?? {}).map((key) => `record.${key}`),
      ...Object.keys(record?.payload ?? {}).map((key) => `payload.${key}`),
    ].sort().join(",");
    const shapes = keyShapes.get(bucket) ?? new Map();
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    keyShapes.set(bucket, shapes);
  }
}

const clusters = [...counts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([type, count]) => ({
    type,
    count,
    keyShapes: [...(keyShapes.get(type) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([keys, shapeCount]) => ({ count: shapeCount, keys })),
  }));

console.log(JSON.stringify({
  sessionId,
  rolloutFiles: targetFiles.length,
  parsedRecords,
  auditedNonAccountingRecords: [...nonAccountingCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => ({ type, count })),
  auditedNonAccountingTotal: [...nonAccountingCounts.values()].reduce((sum, count) => sum + count, 0),
  unknownRecords,
  clusters,
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
  const result = [];
  for (const row of rows) {
    const path = join(root, row.name);
    if (row.isDirectory()) result.push(...await findJsonlFiles(path));
    else if (row.isFile() && row.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}
