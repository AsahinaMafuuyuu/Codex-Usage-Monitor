import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  REQUEST_INPUT_CONTEXT_LIMITS,
  readReconstructedInputContext,
} from "../src/request-input-context.js";

const ROOT = "root-request-context";
const THREAD = "thread-request-context";
const TURN = "turn-request-context";
const SOURCE_A = "sessions/2026/09/02/rollout-2026-09-02T10-00-00-root-a.jsonl";
const SOURCE_B = "sessions/2026/09/02/rollout-2026-09-02T11-00-00-root-b.jsonl";

test("reconstructs historical rollout plus current pre-model input with explicit provenance", async () => {
  await withSources({
    [SOURCE_A]: [
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "older user context" }] }),
      responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "older assistant context" }] }),
      responseItem({ type: "reasoning", encrypted_content: "historical-secret", summary: [{ type: "summary_text", text: "hidden reasoning" }] }),
    ],
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current question" }] }),
      responseItem({ type: "reasoning", encrypted_content: "current-secret", summary: [{ type: "summary_text", text: "current reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    const result = await readReconstructedInputContext({
      locator: locator({ metadata, currentSource: SOURCE_B, lineNumber: 4, taskStartLine: 1, taskEndLine: 4 }),
      resolveSource: (key) => paths.get(key) ?? null,
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.providerPayloadReconstructed, false);
    assert.equal(result.evidence.providerSerializationKnown, false);
    assert.equal(result.evidence.rolloutCoverage, "complete_observed_history");
    assert.equal(result.reconstructionCut.status, "observed");
    assert.equal(result.sections.currentInput.length, 1);
    assert.equal(result.sections.currentInput[0].text, "current question");
    assert.equal(result.sections.currentInput[0].provenance.level, "direct_current");
    const history = result.sections.historyGroups.flatMap((group) => group.items);
    assert.deepEqual(history.map((item) => item.text), ["older user context", "older assistant context"]);
    assert.ok(history.every((item) => item.provenance.level === "historical_rollout"));
    assert.doesNotMatch(JSON.stringify(result), /historical-secret|current-secret|hidden reasoning|current reasoning/u);
  });
});

test("same-source previous Request history is retained while current tool result stays direct-current", async () => {
  await withSources({
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "first turn" }] }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "first reasoning" }] }),
      tokenCount(),
      responseItem({ type: "custom_tool_call_output", call_id: "previous-call", output: "tool output for next request" }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "second reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    const result = await readReconstructedInputContext({
      locator: locator({
        metadata,
        currentSource: SOURCE_B,
        lineNumber: 7,
        previousBoundary: { requestId: "request-1", sourceKey: SOURCE_B, lineNumber: 4 },
        taskStartLine: 1,
        taskEndLine: 7,
      }),
      resolveSource: (key) => paths.get(key) ?? null,
    });

    const history = result.sections.historyGroups.flatMap((group) => group.items);
    assert.equal(history.some((item) => item.text === "first turn"), true);
    assert.equal(result.sections.currentInput[0].kind, "tool_result");
    assert.equal(result.sections.currentInput[0].tool, "unknown_tool");
    assert.equal(result.sections.currentInput[0].callId, "previous-call");
  });
});

test("explicit compaction replacement snapshot rebases retained history", async () => {
  await withSources({
    [SOURCE_A]: [
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "superseded old history" }] }),
      {
        timestamp: now(),
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "compacted retained summary" }] },
          ],
        },
      },
      responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "after compaction" }] }),
    ],
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current" }] }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    const result = await readReconstructedInputContext({
      locator: locator({ metadata, currentSource: SOURCE_B, lineNumber: 4, taskStartLine: 1, taskEndLine: 4 }),
      resolveSource: (key) => paths.get(key) ?? null,
    });
    const history = result.sections.historyGroups.flatMap((group) => group.items);
    assert.equal(history.some((item) => item.text === "superseded old history"), false);
    assert.equal(history.some((item) => item.text === "compacted retained summary"), true);
    assert.equal(history.find((item) => item.text === "compacted retained summary").provenance.level, "compaction_snapshot");
    assert.equal(result.sections.compaction[0].kind, "compaction_snapshot");
    assert.equal(result.evidence.rolloutCoverage, "complete_observed_history");
  });
});

test("context_compacted within four lines after an explicit snapshot is treated as its lifecycle echo", async () => {
  await withSources({
    [SOURCE_A]: [
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "before compact" }] }),
      {
        timestamp: now(),
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "retained snapshot" }] },
          ],
        },
      },
      eventMsg("item_completed"),
      eventMsg("item_completed"),
      eventMsg("context_compacted"),
      responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "after compact" }] }),
    ],
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current" }] }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    const result = await readReconstructedInputContext({
      locator: locator({ metadata, currentSource: SOURCE_B, lineNumber: 4, taskStartLine: 1, taskEndLine: 4 }),
      resolveSource: (key) => paths.get(key) ?? null,
    });
    assert.equal(result.evidence.rolloutCoverage, "complete_observed_history");
    assert.equal(result.summary.compactionCount, 1);
    assert.equal(result.sections.compaction.length, 1);
    assert.equal(result.sections.gaps.length, 0);
  });
});

test("signal-only compaction becomes an explicit coverage gap instead of retaining pre-compaction history", async () => {
  await withSources({
    [SOURCE_A]: [
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "before signal" }] }),
      eventMsg("context_compacted"),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "after signal" }] }),
    ],
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current" }] }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    const result = await readReconstructedInputContext({
      locator: locator({ metadata, currentSource: SOURCE_B, lineNumber: 4, taskStartLine: 1, taskEndLine: 4 }),
      resolveSource: (key) => paths.get(key) ?? null,
    });
    const history = result.sections.historyGroups.flatMap((group) => group.items);
    assert.equal(history.some((item) => item.text === "before signal"), false);
    assert.equal(history.some((item) => item.text === "after signal"), true);
    assert.equal(result.evidence.rolloutCoverage, "partial_compaction_snapshot_unavailable");
    assert.ok(result.sections.gaps.some((gap) => gap.reason === "partial_compaction_snapshot_unavailable"));
  });
});

test("missing historical source and bounded truncation are visible and never guessed", async () => {
  await withSources({
    [SOURCE_B]: [
      eventMsg("task_started", { turn_id: TURN }),
      responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current" }] }),
      responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "reasoning" }] }),
      tokenCount(),
    ],
  }, async ({ paths, metadata }) => {
    metadata.set(SOURCE_A, { byteLength: 1024, lineCount: 10 });
    const result = await readReconstructedInputContext({
      locator: locator({ metadata, currentSource: SOURCE_B, lineNumber: 4, taskStartLine: 1, taskEndLine: 4 }),
      resolveSource: (key) => paths.get(key) ?? null,
      limits: { ...REQUEST_INPUT_CONTEXT_LIMITS, maxHistoryScanBytes: 256 },
    });
    assert.equal(result.evidence.rolloutCoverage, "partial_source_missing");
    assert.equal(result.summary.missingSourceCount, 1);
    assert.ok(result.sections.gaps.some((gap) => gap.reason === "source_missing"));
  });
});

function locator({
  metadata,
  currentSource,
  lineNumber,
  previousBoundary = null,
  taskStartLine,
  taskEndLine,
}) {
  const currentMeta = metadata.get(currentSource);
  const sourceChain = [...metadata.entries()].map(([sourceKey, meta]) => ({
    sourceKey,
    rootSessionId: ROOT,
    threadId: THREAD,
    firstKnownLine: 1,
    lastKnownLine: meta.lineCount,
    fileSize: meta.byteLength,
    parsedByteOffset: meta.byteLength,
    chronologyKey: sourceKey.includes("10-00-00") ? "2026-09-02T10-00-00" : "2026-09-02T11-00-00",
    current: sourceKey === currentSource,
  })).sort((left, right) => left.chronologyKey.localeCompare(right.chronologyKey));
  return {
    requestId: "request-context-2",
    rootSessionId: ROOT,
    threadId: THREAD,
    turnId: TURN,
    observedAt: now(),
    sourceKey: currentSource,
    lineNumber,
    eventOrdinal: lineNumber,
    boundaryStatus: "ok",
    sourceChainStatus: "ok",
    sourceOrdering: "rollout_filename_timestamp",
    sourceChain,
    previousBoundary,
    task: {
      sequence: 1,
      status: "completed",
      effort: "xhigh",
      sourceKey: currentSource,
      startLine: taskStartLine,
      endLine: taskEndLine,
      startByte: 0,
      endByte: currentMeta.byteLength,
    },
  };
}

function responseItem(payload) {
  return { timestamp: now(), type: "response_item", payload };
}

function eventMsg(type, extra = {}) {
  return { timestamp: now(), type: "event_msg", payload: { type, ...extra } };
}

function tokenCount() {
  return eventMsg("token_count", {
    info: {
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 50,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 120,
      },
    },
  });
}

function now() {
  return "2026-09-02T12:00:00.000Z";
}

async function withSources(sourceRecords, run) {
  const directory = await mkdtemp(join(tmpdir(), "request-input-context-"));
  const paths = new Map();
  const metadata = new Map();
  try {
    let index = 0;
    for (const [sourceKey, records] of Object.entries(sourceRecords)) {
      index += 1;
      const path = join(directory, `source-${index}.jsonl`);
      const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await writeFile(path, text, "utf8");
      paths.set(sourceKey, path);
      metadata.set(sourceKey, { byteLength: Buffer.byteLength(text), lineCount: records.length });
    }
    await run({ paths, metadata });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
