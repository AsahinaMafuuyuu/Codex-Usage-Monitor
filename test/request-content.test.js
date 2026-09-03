import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  REQUEST_CONTENT_LIMITS,
  readRequestContent,
} from "../src/request-content.js";

const SOURCE_KEY = "sessions/2026/09/02/rollout-fixture.jsonl";

test("Request Content uses the previous canonical token_count as the observed slice boundary", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "first request user text" }],
    }),
    responseItem({
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec_command",
      input: JSON.stringify({ cmd: "git status --short", workingDirectory: "D:\\repo" }),
    }),
    tokenCount(),
    responseItem({
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: "Process exited with code 0.\n M public/app.js",
    }),
    responseItem({
      type: "reasoning",
      encrypted_content: "opaque-secret",
      summary: [{ type: "summary_text", text: "Checked the repository state." }],
    }),
    responseItem({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The change is safe to continue." }],
    }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 8,
        previousBoundary: { requestId: "request-a", sourceKey: SOURCE_KEY, lineNumber: 4 },
        task: task({ endLine: 8, endByte: byteLength }),
      }),
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.startLine, 5);
    assert.equal(result.evidence.endLine, 8);
    assert.equal(result.evidence.providerPayloadReconstructed, false);
    assert.equal(result.evidence.complete, true);
    assert.deepEqual(result.items.map((item) => item.kind), [
      "tool_result",
      "reasoning_summary",
      "assistant_message",
    ]);
    assert.equal(result.preModelCut.status, "observed");
    assert.equal(result.preModelCut.lineNumber, 6);
    assert.equal(result.items[0].section, "observed_input");
    assert.equal(result.items[1].section, "observed_interaction");
    assert.equal(result.items[0].tool, "unknown_tool");
    assert.equal(result.items[0].callId, "call-1");
    assert.doesNotMatch(JSON.stringify(result.items), /git status --short/u);
    assert.equal(result.items[1].text, "Checked the repository state.");
    assert.equal(result.items[1].opaqueContentPresent, true);
    assert.doesNotMatch(JSON.stringify(result), /opaque-secret/u);
    assert.equal(result.summary.toolResultCount, 1);
    assert.equal(result.summary.reasoningSummaryCount, 1);
  });
});

test("the first canonical Request falls back only to the proven same-source Task start", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "inspect this request" }],
    }),
    responseItem({
      type: "function_call",
      call_id: "call-fn",
      namespace: "tools",
      name: "read_file",
      arguments: JSON.stringify({ path: "README.md", limit: 80 }),
    }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 4,
        previousBoundary: null,
        task: task({ endLine: 4, endByte: byteLength }),
      }),
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.startLine, 1);
    assert.deepEqual(result.items.map((item) => item.kind), ["message", "tool_call"]);
    assert.deepEqual(result.items.map((item) => item.section), ["observed_input", "observed_interaction"]);
    assert.equal(result.items[0].role, "user");
    assert.equal(result.items[1].tool, "tools.read_file");
    assert.deepEqual(result.items[1].fields.map((field) => field.label), ["Path", "Limit"]);
  });
});

test("boundary/source mismatches degrade instead of reading across an unproven source", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const sourceMismatch = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 2,
        task: task({ sourceKey: "sessions/other.jsonl", endLine: 2, endByte: byteLength }),
      }),
    });
    assert.equal(sourceMismatch.available, false);
    assert.equal(sourceMismatch.reason, "boundary_ambiguous");

    const lineMismatch = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 1,
        task: task({ endLine: 2, endByte: byteLength }),
      }),
    });
    assert.equal(lineMismatch.available, false);
    assert.equal(lineMismatch.reason, "source_changed");
  });
});

test("unknown and malformed records produce semantic coverage signals without Raw JSON", async () => {
  const records = [
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    { timestamp: now(), ordinal: 2, type: "future_record", payload: { secret: "do-not-dump-me" } },
    "{not valid json",
    tokenCount(),
  ];
  await withRollout(records, async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 4,
        task: task({ endLine: 4, endByte: byteLength }),
      }),
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.complete, false);
    assert.equal(result.evidence.coverage, "record_parse_partial");
    assert.equal(result.summary.unknownRecordCount, 1);
    assert.equal(result.summary.malformedRecordCount, 1);
    assert.ok(result.items.some((item) => item.kind === "context_signal" && item.signal === "unrecognized_records"));
    assert.doesNotMatch(JSON.stringify(result), /do-not-dump-me/u);
  });
});

test("opaque reasoning is represented only as activity presence and never exposes encrypted content", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "reasoning", encrypted_content: "ciphertext-only", summary: [] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 3,
        task: task({ endLine: 3, endByte: byteLength }),
      }),
    });

    assert.equal(result.items[0].kind, "reasoning_activity");
    assert.equal(result.items[0].occurrenceCount, 1);
    assert.equal(result.items[0].opaqueContentPresent, true);
    assert.doesNotMatch(JSON.stringify(result), /ciphertext-only/u);
  });
});

test("pre-model evidence cut separates observed input, runtime context, and interaction", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "current question" }] }),
    {
      timestamp: now(),
      ordinal: 3,
      type: "turn_context",
      payload: {
        turn_id: "turn-request-content",
        model: "gpt-test",
        effort: "high",
        cwd: "D:\\repo",
        timezone: "America/Los_Angeles",
        sandbox_policy: { type: "workspace-write", secret: "must-not-dump" },
        hidden_prompt: "never expose this field",
      },
    },
    responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "Inspect evidence." }] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({ lineNumber: 5, task: task({ endLine: 5, endByte: byteLength }) }),
    });

    assert.equal(result.preModelCut.status, "observed");
    assert.equal(result.preModelCut.kind, "before_first_observed_model_output");
    assert.equal(result.preModelCut.lineNumber, 4);
    assert.equal(result.items[0].section, "observed_input");
    assert.equal(result.items[1].kind, "runtime_context");
    assert.equal(result.items[1].section, "runtime_context");
    assert.deepEqual(result.items[1].fields.map((field) => field.key), [
      "model", "effort", "timezone", "cwd", "sandbox_policy",
    ]);
    assert.equal(result.items[2].section, "observed_interaction");
    assert.doesNotMatch(JSON.stringify(result), /hidden_prompt|never expose this field|must-not-dump/u);
  });
});

test("without model-output evidence the cut stays unavailable and does not label the whole slice as input", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "recorded user text" }] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({ lineNumber: 3, task: task({ endLine: 3, endByte: byteLength }) }),
    });

    assert.equal(result.preModelCut.status, "unavailable");
    assert.equal(result.items[0].section, "observed_interaction");
    assert.equal(result.summary.observedInputItemCount, 0);
  });
});

test("identical adjacent reasoning summaries coalesce while preserving occurrence evidence", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "Same summary\r\n" }] }),
    eventMsg("item_completed"),
    responseItem({ type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "Same summary\n" }] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({ lineNumber: 5, task: task({ endLine: 5, endByte: byteLength }) }),
    });

    const reasoning = result.items.filter((item) => item.kind === "reasoning_summary");
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].occurrenceCount, 2);
    assert.equal(reasoning[0].opaqueContentPresent, true);
    assert.equal(result.summary.reasoningRecordCount, 2);
    assert.equal(result.summary.reasoningCardCount, 1);
  });
});

test("distinct or visibly separated reasoning summaries are not coalesced", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "A" }] }),
    responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "B" }] }),
    responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] }),
    responseItem({ type: "reasoning", summary: [{ type: "summary_text", text: "A" }] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({ lineNumber: 6, task: task({ endLine: 6, endByte: byteLength }) }),
    });
    assert.deepEqual(
      result.items.filter((item) => item.kind === "reasoning_summary").map((item) => item.text),
      ["A", "B", "A"],
    );
  });
});

test("adjacent opaque reasoning records coalesce only as activity count", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "reasoning", encrypted_content: "opaque-a", summary: [] }),
    responseItem({ type: "reasoning", encrypted_content: "opaque-b", summary: [] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({ lineNumber: 4, task: task({ endLine: 4, endByte: byteLength }) }),
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "reasoning_activity");
    assert.equal(result.items[0].occurrenceCount, 2);
    assert.doesNotMatch(JSON.stringify(result), /opaque-a|opaque-b/u);
  });
});

test("explicit compaction evidence becomes a context signal without exposing replacement history", async () => {
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    {
      timestamp: now(),
      ordinal: 2,
      type: "compacted",
      payload: {
        window_id: "window-2",
        previous_window_id: "window-1",
        replacement_history: [{ role: "user", content: "private-compacted-history" }],
      },
    },
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 3,
        task: task({ endLine: 3, endByte: byteLength }),
      }),
    });

    assert.equal(result.available, true);
    assert.ok(result.items.some((item) => item.kind === "context_signal" && item.signal === "compacted"));
    assert.doesNotMatch(JSON.stringify(result), /private-compacted-history/u);
  });
});

test("item and payload limits are hard bounds and truncation is explicit", async () => {
  const huge = "x".repeat(2_000);
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "custom_tool_call_output", call_id: "call-big", output: huge }),
    responseItem({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: huge }],
    }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 4,
        task: task({ endLine: 4, endByte: byteLength }),
      }),
      limits: {
        ...REQUEST_CONTENT_LIMITS,
        maxItemCharacters: 128,
        maxPayloadCharacters: 180,
      },
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.truncated, true);
    assert.equal(result.evidence.coverage, "content_truncated");
    assert.ok(result.summary.truncatedItemCount >= 1);
    assert.ok(JSON.stringify(result.items).length < huge.length);
  });
});

test("the scanner stops at the byte budget instead of replaying an unbounded Task", async () => {
  const filler = "z".repeat(1_024);
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: filler }] }),
    responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: filler }] }),
    tokenCount(),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 4,
        task: task({ endLine: 4, endByte: byteLength }),
      }),
      limits: { ...REQUEST_CONTENT_LIMITS, maxScanBytes: 256 },
    });

    assert.equal(result.available, false);
    assert.equal(result.reason, "content_truncated");
    assert.equal(result.evidence.truncated, true);
  });
});

test("the located interaction slice has its own byte budget independent of locator reachability", async () => {
  const huge = "s".repeat(2_500);
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    tokenCount(),
    responseItem({ type: "custom_tool_call_output", call_id: "slice-big", output: huge }),
    tokenCount(),
    eventMsg("task_complete", { turn_id: "turn-request-content" }),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 4,
        previousBoundary: { requestId: "request-a", sourceKey: SOURCE_KEY, lineNumber: 2 },
        task: task({ endLine: 5, endByte: byteLength }),
      }),
      limits: {
        ...REQUEST_CONTENT_LIMITS,
        maxWindowBytes: 8_192,
        maxScanBytes: 16_384,
        maxSliceBytes: 512,
      },
    });

    assert.equal(result.available, false);
    assert.equal(result.reason, "content_truncated");
    assert.equal(result.evidence.truncated, true);
    assert.ok(result.evidence.sliceBytes > 512);
    assert.ok(result.evidence.locateBytes > 0);
  });
});

test("late Requests can use the proven Task end anchor without scanning from the Task start", async () => {
  const huge = "m".repeat(4_000);
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: huge }] }),
    tokenCount(),
    responseItem({ type: "custom_tool_call_output", call_id: "late-call", output: "late tool result" }),
    tokenCount(),
    eventMsg("task_complete", { turn_id: "turn-request-content" }),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 5,
        previousBoundary: { requestId: "request-a", sourceKey: SOURCE_KEY, lineNumber: 3 },
        task: task({ endLine: 6, endByte: byteLength }),
      }),
      limits: {
        ...REQUEST_CONTENT_LIMITS,
        maxWindowBytes: 1_024,
        maxScanBytes: 2_048,
      },
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.anchor, "reverse");
    assert.ok(result.evidence.sliceBytes > 0);
    assert.equal(result.evidence.startLine, 4);
    assert.deepEqual(result.items.map((item) => item.kind), ["tool_result"]);
  });
});

test("a bounded second anchor is used when line proximity chooses the byte-heavy side", async () => {
  const huge = "b".repeat(6_000);
  await withRollout([
    eventMsg("task_started", { turn_id: "turn-request-content" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: huge }] }),
    tokenCount(),
    responseItem({ type: "custom_tool_call_output", call_id: "fallback-call", output: "fallback result" }),
    tokenCount(),
    eventMsg("item_completed"),
    eventMsg("item_completed"),
    eventMsg("item_completed"),
    eventMsg("item_completed"),
    eventMsg("task_complete", { turn_id: "turn-request-content" }),
  ], async ({ path, byteLength }) => {
    const result = await readRequestContent({
      sourcePath: path,
      locator: locator({
        lineNumber: 5,
        previousBoundary: { requestId: "request-a", sourceKey: SOURCE_KEY, lineNumber: 3 },
        task: task({ endLine: 10, endByte: byteLength }),
      }),
      limits: {
        ...REQUEST_CONTENT_LIMITS,
        maxWindowBytes: 2_048,
        maxScanBytes: 4_096,
      },
    });

    assert.equal(result.available, true);
    assert.equal(result.evidence.anchor, "reverse");
    assert.ok(result.evidence.locateBytes > 2_048);
    assert.deepEqual(result.items.map((item) => item.kind), ["tool_result"]);
  });
});

function locator({ lineNumber, previousBoundary = null, task: taskValue }) {
  return {
    requestId: "request-content-b",
    rootSessionId: "root-request-content",
    threadId: "thread-request-content",
    turnId: "turn-request-content",
    observedAt: now(),
    sourceKey: SOURCE_KEY,
    lineNumber,
    eventOrdinal: lineNumber,
    boundaryStatus: "ok",
    previousBoundary,
    task: taskValue,
  };
}

function task({ sourceKey = SOURCE_KEY, endLine, endByte, status = "completed" }) {
  return {
    sequence: 1,
    status,
    effort: "xhigh",
    sourceKey,
    startLine: 1,
    endLine,
    startByte: 0,
    endByte,
  };
}

function eventMsg(type, extra = {}) {
  return { timestamp: now(), ordinal: 1, type: "event_msg", payload: { type, ...extra } };
}

function responseItem(payload) {
  return { timestamp: now(), ordinal: 2, type: "response_item", payload };
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

async function withRollout(records, run) {
  const directory = await mkdtemp(join(tmpdir(), "request-content-"));
  const path = join(directory, "rollout.jsonl");
  const lines = records.map((record) => typeof record === "string" ? record : JSON.stringify(record));
  const text = `${lines.join("\n")}\n`;
  await writeFile(path, text, "utf8");
  try {
    await run({ path, byteLength: Buffer.byteLength(text) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
