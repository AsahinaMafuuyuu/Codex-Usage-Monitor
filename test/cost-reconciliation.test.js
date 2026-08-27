import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("T-COST-080..083 reconciliation separates policy effects and keeps rollout read-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cost-reconcile-"));
  const codexHome = join(directory, ".codex");
  const sessionDir = join(codexHome, "sessions", "2026", "08", "01");
  await mkdir(sessionDir, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fixtures = [
    {
      root: "11111111-1111-4111-8111-111111111111",
      turn: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      timestamp: "2026-07-29T12:00:00.000Z",
      tier: "default",
      usage: wireUsage(100_000, 20_000, 10_000, 10_000),
    },
    {
      root: "22222222-2222-4222-8222-222222222222",
      turn: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      timestamp: "2026-08-01T12:00:00.000Z",
      tier: "fast",
      usage: wireUsage(100_000, 0, 0, 10_000),
    },
    {
      root: "33333333-3333-4333-8333-333333333333",
      turn: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      timestamp: "2026-08-01T13:00:00.000Z",
      tier: "default",
      usage: wireUsage(300_000, 0, 0, 10_000),
    },
  ];
  for (const fixture of fixtures) {
    await writeFile(
      join(sessionDir, `rollout-${fixture.root}.jsonl`),
      rollout(fixture),
    );
  }

  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "scripts/reconcile-subscription-cost.js"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sourceReadOnly, true);
  assert.equal(report.hashChangedFiles, 0);
  assert.equal(report.rootSessions, 3);
  assert.equal(report.verifiedUsageUnits, 3);
  assert.equal(report.longContextCandidates.count, 1);
  assert.equal(report.serviceTierInventory.default.count, 2);
  assert.equal(report.serviceTierInventory.fast.count, 1);
  assert.notEqual(report.reconciliation.subscriptionPolicyAdjustmentUsd, 0);
  assert.notEqual(report.reconciliation.historicalRateAdjustmentUsd, 0);
  assert.ok(report.reconciliation.longContextAdjustmentUsd > 0);
  assert.ok(report.reconciliation.fastAdjustmentUsd > 0);
  assert.equal(report.reconciliation.additivityDeltaUsd, 0);
});

function rollout({ root, turn, timestamp, tier, usage }) {
  return [
    {
      timestamp,
      ordinal: 0,
      type: "session_meta",
      payload: { id: root, session_id: root, timestamp, cwd: "C:\\fixture" },
    },
    { timestamp, ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { timestamp, ordinal: 2, type: "turn_context", payload: { turn_id: turn, model: "gpt-5.6-terra", effort: "high" } },
    { timestamp, ordinal: 3, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } } },
    {
      timestamp,
      ordinal: 4,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    },
    { timestamp, ordinal: 5, type: "event_msg", payload: { type: "task_complete", turn_id: turn } },
  ].map(JSON.stringify).join("\n") + "\n";
}

function wireUsage(input, cached, cacheWrite, output) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}
