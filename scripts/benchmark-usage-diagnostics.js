import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "../src/server.js";

const accessUrl = process.argv[2];
if (!accessUrl) throw new Error("Usage: node scripts/benchmark-usage-diagnostics.js <launch-token-url>");

const databasePath = resolveDatabasePath(readArgument("--database"));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);
const sessionSamples = selectSessionSamples(databasePath);
const authenticated = await authenticate(accessUrl);
const results = [];
for (const sample of sessionSamples) {
  results.push(await benchmarkSession(authenticated.baseUrl, authenticated.cookie, sample));
}

console.log(JSON.stringify({
  samples: results,
  target: {
    commonWarmP95Ms: 150,
  },
}, null, 2));

function selectSessionSamples(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON;");
    const rows = db.prepare(`
      SELECT root_session_id AS session_id, COUNT(*) AS request_count
      FROM canonical_requests
      GROUP BY root_session_id
      HAVING COUNT(*) > 0
      ORDER BY request_count, session_id
    `).all().map((row) => ({
      sessionId: row.session_id,
      requestCount: Number(row.request_count),
    }));
    if (!rows.length) throw new Error("No canonical Request sessions are available for benchmarking");
    const common = rows[Math.floor((rows.length - 1) * 0.5)];
    const large = rows.at(-1);
    return common.sessionId === large.sessionId
      ? [{ label: "common", ...common }]
      : [{ label: "common", ...common }, { label: "largest", ...large }];
  } finally {
    db.close();
  }
}

async function authenticate(url) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`Launch-token authentication returned HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Launch-token authentication did not return a session cookie");
  const cookie = setCookie.split(";", 1)[0];
  const parsed = new URL(url);
  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    cookie,
  };
}

async function benchmarkSession(baseUrl, cookie, sample) {
  const endpoint = `${baseUrl}/api/sessions/${encodeURIComponent(sample.sessionId)}/diagnostics`;
  for (let index = 0; index < 5; index += 1) await timedFetch(endpoint, cookie);
  const timings = [];
  let lastPayload = null;
  let payloadBytes = 0;
  for (let index = 0; index < 40; index += 1) {
    const result = await timedFetch(endpoint, cookie);
    timings.push(result.elapsedMs);
    lastPayload = result.payload;
    payloadBytes = result.payloadBytes;
  }
  timings.sort((left, right) => left - right);
  return {
    ...sample,
    findingCount: lastPayload?.findings?.length ?? 0,
    payloadBytes,
    p50Ms: round(percentile(timings, 0.50)),
    p95Ms: round(percentile(timings, 0.95)),
    maxMs: round(timings.at(-1) ?? 0),
    minMs: round(timings[0] ?? 0),
  };
}

async function timedFetch(url, cookie) {
  const started = performance.now();
  const response = await fetch(url, { headers: { Cookie: cookie } });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`Diagnostics benchmark returned HTTP ${response.status}: ${text}`);
  return {
    elapsedMs,
    payloadBytes: Buffer.byteLength(text),
    payload: JSON.parse(text),
  };
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1));
  return sorted[index];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
