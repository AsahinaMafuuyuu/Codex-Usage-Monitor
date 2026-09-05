import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { resolveDatabasePath } from "../src/server.js";

const accessUrl = process.argv[2];
if (!accessUrl) throw new Error("Usage: node scripts/benchmark-diagnostic-alerts.js <launch-token-url> [--iterations 20]");
const databasePath = resolveDatabasePath(readArgument("--database"));
const iterations = Math.max(1, Math.min(100, Number(readArgument("--iterations") ?? 20) || 20));
if (!existsSync(databasePath)) throw new Error(`Monitor database not found: ${databasePath}`);

const samples = selectSamples(databasePath);
const authenticated = await authenticate(accessUrl);
const results = [];
for (const sample of samples) {
  results.push(await benchmarkSession(authenticated.baseUrl, authenticated.cookie, sample, iterations));
}

console.log(JSON.stringify({
  databasePath,
  iterations,
  samples: results,
  goals: {
    commonWarmP95Ms: 300,
    largestRealProjectSessionP95Ms: 1000,
  },
}, null, 2));

function selectSamples(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON;");
    const rows = db.prepare(`
      SELECT s.id AS session_id, s.project_path, COUNT(r.request_id) AS request_count,
             MAX(r.observed_at) AS last_observed_at
      FROM sessions s
      JOIN canonical_requests r ON r.root_session_id=s.id
      WHERE s.project_path IS NOT NULL AND s.project_path!=''
      GROUP BY s.id, s.project_path
      ORDER BY request_count, s.id
    `).all();
    if (!rows.length) throw new Error("No canonical Request sessions are available for alert benchmark");
    const common = rows[Math.floor(rows.length / 2)];
    const largestProject = db.prepare(`
      SELECT s.project_path, COUNT(r.request_id) AS request_count
      FROM sessions s
      JOIN canonical_requests r ON r.root_session_id=s.id
      WHERE s.project_path IS NOT NULL AND s.project_path!=''
      GROUP BY s.project_path
      ORDER BY request_count DESC, s.project_path
      LIMIT 1
    `).get();
    const largestProjectLatest = db.prepare(`
      SELECT s.id AS session_id, s.project_path, COUNT(r.request_id) AS request_count,
             MAX(r.observed_at) AS last_observed_at
      FROM sessions s
      JOIN canonical_requests r ON r.root_session_id=s.id
      WHERE s.project_path=?
      GROUP BY s.id, s.project_path
      ORDER BY last_observed_at DESC, s.id DESC
      LIMIT 1
    `).get(largestProject.project_path);
    return dedupe([
      { label: "common", ...mapSample(common) },
      { label: "largest-project-latest-session", ...mapSample(largestProjectLatest) },
    ]);
  } finally {
    db.close();
  }
}

function mapSample(row) {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    requestCount: Number(row.request_count ?? 0),
  };
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value.sessionId || seen.has(value.sessionId)) return false;
    seen.add(value.sessionId);
    return true;
  });
}

async function authenticate(url) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`Launch-token authentication returned HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Launch-token authentication did not return a session cookie");
  const parsed = new URL(url);
  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    cookie: setCookie.split(";", 1)[0],
  };
}

async function benchmarkSession(baseUrl, cookie, sample, count) {
  const endpoint = `${baseUrl}/api/sessions/${encodeURIComponent(sample.sessionId)}/diagnostic-alerts`;
  for (let index = 0; index < 3; index += 1) await timedFetch(endpoint, cookie);
  const timings = [];
  let payload = null;
  let payloadBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const result = await timedFetch(endpoint, cookie);
    timings.push(result.elapsedMs);
    payload = result.payload;
    payloadBytes = result.payloadBytes;
  }
  timings.sort((left, right) => left - right);
  return {
    ...sample,
    alertCount: payload?.alerts?.length ?? 0,
    suppressedBySnooze: payload?.suppressedBySnooze ?? 0,
    payloadBytes,
    p50Ms: round(percentile(timings, 0.50)),
    p95Ms: round(percentile(timings, 0.95)),
    maxMs: round(timings.at(-1) ?? 0),
  };
}

async function timedFetch(url, cookie) {
  const started = performance.now();
  const response = await fetch(url, { headers: { Cookie: cookie, Accept: "application/json" } });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`Alert benchmark returned HTTP ${response.status}: ${text}`);
  return {
    elapsedMs,
    payloadBytes: Buffer.byteLength(text),
    payload: JSON.parse(text),
  };
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
