import { open } from "node:fs/promises";

export const REQUEST_CONTENT_LIMITS = Object.freeze({
  maxWindowBytes: 12 * 1024 * 1024,
  maxScanBytes: 24 * 1024 * 1024,
  maxSliceBytes: 4 * 1024 * 1024,
  maxRecords: 500,
  maxItemCharacters: 64 * 1024,
  maxPayloadCharacters: 512 * 1024,
});

const TASK_START_TYPES = new Set(["task_started", "turn_started"]);
const TASK_END_TYPES = new Set([
  "task_aborted",
  "task_cancelled",
  "task_complete",
  "task_completed",
  "task_interrupted",
  "turn_aborted",
  "turn_cancelled",
  "turn_complete",
  "turn_completed",
  "turn_interrupted",
]);
const KNOWN_TOP_LEVEL_RECORD_TYPES = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);
const KNOWN_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "item_completed",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "task_aborted",
  "task_cancelled",
  "task_complete",
  "task_completed",
  "task_interrupted",
  "task_started",
  "thread_rolled_back",
  "thread_settings_applied",
  "token_count",
  "turn_aborted",
  "turn_cancelled",
  "turn_complete",
  "turn_completed",
  "turn_interrupted",
  "turn_started",
  "user_message",
  "web_search_end",
]);
const LOCATOR_CHUNK_BYTES = 256 * 1024;
const MAX_EVIDENCE_RECORD_BYTES = 1024 * 1024;

/**
 * Read one canonical Request's observed interaction from the original rollout.
 * The caller supplies only server-resolved evidence; no source path comes from HTTP input.
 */
export async function readRequestContent({
  sourcePath,
  locator,
  limits = REQUEST_CONTENT_LIMITS,
}) {
  const normalizedLimits = normalizeLimits(limits);
  const boundary = resolveBoundary(locator);
  if (!boundary.available) return boundary;

  let handle;
  try {
    handle = await open(sourcePath, "r");
  } catch (error) {
    return unavailable(
      error?.code === "ENOENT" ? "source_missing" : "source_rebind_failed",
      locator,
      boundary,
    );
  }

  try {
    const fileStat = await handle.stat();
    const task = locator.task;
    if (task.startByte >= fileStat.size) {
      return unavailable("source_changed", locator, boundary);
    }
    if (finiteInteger(task.endByte) && task.endByte > fileStat.size) {
      return unavailable("source_changed", locator, boundary);
    }
    const taskEndByte = finiteInteger(task.endByte) && task.endByte > task.startByte
      ? task.endByte
      : fileStat.size;
    const anchorOrder = chooseAnchorOrder(locator, boundary);
    let locateBytes = 0;
    let located = null;
    for (const anchorKind of anchorOrder) {
      const remainingBudget = normalizedLimits.maxScanBytes - locateBytes;
      if (remainingBudget <= 0) break;
      const windowBytes = Math.min(normalizedLimits.maxWindowBytes, remainingBudget);
      const attempt = anchorKind === "reverse"
        ? await locateFromTaskEnd(handle, locator, boundary, taskEndByte, windowBytes)
        : await locateFromTaskStart(handle, locator, boundary, taskEndByte, windowBytes);
      locateBytes += attempt.bytesRead;
      if (attempt.error) {
        return unavailable(attempt.error, locator, boundary, {
          scanBytes: locateBytes,
          locateBytes,
        });
      }
      if (attempt.found) {
        located = attempt;
        break;
      }
    }

    if (!located) {
      return unavailable("content_truncated", locator, boundary, {
        scanBytes: locateBytes,
        locateBytes,
        truncated: true,
      });
    }

    const validation = await validateLocatedEvidence(handle, locator, boundary, located, normalizedLimits);
    if (!validation.available) {
      return unavailable(validation.reason, locator, boundary, {
        scanBytes: locateBytes + validation.bytesRead,
        locateBytes,
        truncated: validation.reason === "content_truncated",
        anchor: located.anchorKind,
      });
    }

    const startByte = boundary.previousBoundary
      ? located.ranges.get(boundary.previousBoundary.lineNumber).end
      : task.startByte;
    const endByte = located.ranges.get(boundary.endLine).end;
    const sliceBytes = endByte - startByte;
    if (!finitePositiveInteger(sliceBytes)) {
      return unavailable("source_changed", locator, boundary, {
        scanBytes: locateBytes + validation.bytesRead,
        locateBytes,
        sliceBytes,
        anchor: located.anchorKind,
      });
    }
    if (sliceBytes > normalizedLimits.maxSliceBytes) {
      return unavailable("content_truncated", locator, boundary, {
        scanBytes: locateBytes + validation.bytesRead,
        locateBytes,
        sliceBytes,
        truncated: true,
        anchor: located.anchorKind,
      });
    }

    const sliceBuffer = await readExactRange(handle, startByte, sliceBytes);
    const expectedLineCount = boundary.endLine - boundary.startLine + 1;
    if (countNewlines(sliceBuffer) !== expectedLineCount) {
      return unavailable("source_changed", locator, boundary, {
        scanBytes: locateBytes + validation.bytesRead + sliceBytes,
        locateBytes,
        sliceBytes,
        anchor: located.anchorKind,
      });
    }
    const scan = createScanState(locator, boundary, normalizedLimits, "slice");
    processSliceBuffer(sliceBuffer, boundary.startLine - 1, scan);
    scan.scanBytes = locateBytes + validation.bytesRead + sliceBytes;

    if (scan.unknownRecordCount > 0) {
      addContextSignal(scan, {
        kind: "context_signal",
        signal: "unrecognized_records",
        label: `${scan.unknownRecordCount} 个未识别交互记录未展示`,
      });
    }
    finalizeSemanticProjection(scan);

    const coverage = resolveCoverage(scan);
    return {
      available: true,
      evidence: {
        kind: "rollout_observed_interaction",
        providerPayloadReconstructed: false,
        sourceKey: locator.sourceKey,
        startLine: boundary.startLine,
        endLine: boundary.endLine,
        complete: coverage === "complete",
        truncated: scan.truncated,
        coverage,
        scanBytes: scan.scanBytes,
        locateBytes,
        sliceBytes,
        anchor: located.anchorKind,
      },
      preModelCut: publicPreModelCut(scan),
      items: scan.items,
      summary: summarize(scan),
    };
  } catch (error) {
    return unavailable(
      error?.code === "ENOENT" ? "source_missing" : "source_rebind_failed",
      locator,
      boundary,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

async function locateFromTaskStart(handle, locator, boundary, taskEndByte, windowBytes) {
  const task = locator.task;
  const windowEnd = Math.min(taskEndByte, task.startByte + windowBytes);
  const desired = new Set([
    task.startLine,
    boundary.endLine,
    ...(boundary.previousBoundary ? [boundary.previousBoundary.lineNumber] : []),
  ]);
  const ranges = new Map();
  let cursor = task.startByte;
  let lineNumber = task.startLine;
  let lineStart = task.startByte;
  let bytesRead = 0;
  while (cursor < windowEnd && !allDesiredLinesFound(desired, ranges)) {
    const length = Math.min(LOCATOR_CHUNK_BYTES, windowEnd - cursor);
    const chunk = await readExactRange(handle, cursor, length);
    bytesRead += chunk.length;
    let searchOffset = 0;
    while (true) {
      const newline = chunk.indexOf(0x0a, searchOffset);
      if (newline === -1) break;
      const lineEnd = cursor + newline + 1;
      if (desired.has(lineNumber)) ranges.set(lineNumber, { start: lineStart, end: lineEnd });
      lineNumber += 1;
      lineStart = lineEnd;
      searchOffset = newline + 1;
      if (allDesiredLinesFound(desired, ranges)) break;
    }
    cursor += chunk.length;
  }
  return {
    found: allDesiredLinesFound(desired, ranges),
    ranges,
    bytesRead,
    anchorKind: "forward",
    error: null,
  };
}

async function locateFromTaskEnd(handle, locator, boundary, taskEndByte, windowBytes) {
  const task = locator.task;
  if (!finitePositiveInteger(task.endLine) || !finiteInteger(task.endByte) || task.endByte <= task.startByte) {
    return { found: false, ranges: new Map(), bytesRead: 0, anchorKind: "reverse", error: null };
  }
  const desired = new Set([
    task.endLine,
    boundary.endLine,
    ...(boundary.previousBoundary ? [boundary.previousBoundary.lineNumber] : []),
  ]);
  const ranges = new Map();
  const windowStart = Math.max(task.startByte, taskEndByte - windowBytes);
  let cursor = taskEndByte;
  let lineNumber = task.endLine;
  let lineEnd = taskEndByte;
  let bytesRead = 0;
  let firstChunk = true;
  while (cursor > windowStart && !allDesiredLinesFound(desired, ranges)) {
    const chunkStart = Math.max(windowStart, cursor - LOCATOR_CHUNK_BYTES);
    const chunk = await readExactRange(handle, chunkStart, cursor - chunkStart);
    bytesRead += chunk.length;
    let searchOffset = chunk.length - 1;
    if (firstChunk && searchOffset >= 0 && chunk[searchOffset] === 0x0a) searchOffset -= 1;
    firstChunk = false;
    while (searchOffset >= 0) {
      const newline = chunk.lastIndexOf(0x0a, searchOffset);
      if (newline === -1) break;
      const absoluteNewline = chunkStart + newline;
      const lineStart = absoluteNewline + 1;
      if (desired.has(lineNumber)) ranges.set(lineNumber, { start: lineStart, end: lineEnd });
      lineNumber -= 1;
      lineEnd = lineStart;
      searchOffset = newline - 1;
      if (allDesiredLinesFound(desired, ranges)) break;
    }
    cursor = chunkStart;
  }
  if (cursor === task.startByte && !allDesiredLinesFound(desired, ranges)) {
    if (desired.has(lineNumber)) ranges.set(lineNumber, { start: task.startByte, end: lineEnd });
  }
  return {
    found: allDesiredLinesFound(desired, ranges),
    ranges,
    bytesRead,
    anchorKind: "reverse",
    error: null,
  };
}

function allDesiredLinesFound(desired, ranges) {
  for (const line of desired) if (!ranges.has(line)) return false;
  return true;
}

async function validateLocatedEvidence(handle, locator, boundary, located, limits) {
  const cache = new Map();
  let bytesRead = 0;
  const readRecord = async (lineNumber) => {
    if (cache.has(lineNumber)) return cache.get(lineNumber);
    const range = located.ranges.get(lineNumber);
    if (!range) return { record: null, tooLarge: false };
    const length = range.end - range.start;
    if (length > Math.min(MAX_EVIDENCE_RECORD_BYTES, limits.maxSliceBytes)) {
      const result = { record: null, tooLarge: true };
      cache.set(lineNumber, result);
      return result;
    }
    const buffer = await readExactRange(handle, range.start, length);
    bytesRead += buffer.length;
    const rawLine = stripTrailingNewline(buffer);
    let record = null;
    try {
      record = JSON.parse(rawLine.toString("utf8"));
    } catch {
      // Validation below maps malformed evidence to source_changed.
    }
    const result = { record, tooLarge: false };
    cache.set(lineNumber, result);
    return result;
  };

  const taskAnchorLine = located.anchorKind === "reverse" ? locator.task.endLine : locator.task.startLine;
  const taskAnchor = await readRecord(taskAnchorLine);
  if (taskAnchor.tooLarge) return { available: false, reason: "content_truncated", bytesRead };
  const taskAnchorMatches = located.anchorKind === "reverse"
    ? isMatchingTaskEnd(
        taskAnchor.record,
        locator.turnId,
        locator.task.status,
        boundary.endLine === locator.task.endLine,
      )
    : isMatchingTaskStart(taskAnchor.record, locator.turnId);
  if (!taskAnchorMatches) return { available: false, reason: "source_changed", bytesRead };

  if (boundary.previousBoundary) {
    const previous = await readRecord(boundary.previousBoundary.lineNumber);
    if (previous.tooLarge) return { available: false, reason: "content_truncated", bytesRead };
    if (!isTokenCount(previous.record)) return { available: false, reason: "source_changed", bytesRead };
  }
  const current = await readRecord(boundary.endLine);
  if (current.tooLarge) return { available: false, reason: "content_truncated", bytesRead };
  if (!isTokenCount(current.record)) return { available: false, reason: "source_changed", bytesRead };
  return { available: true, bytesRead };
}

async function readExactRange(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (bytesRead <= 0) throw Object.assign(new Error("Unexpected end of rollout"), { code: "EIO" });
    offset += bytesRead;
  }
  return buffer;
}

function stripTrailingNewline(buffer) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 0x0a) end -= 1;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  return buffer.subarray(0, end);
}

function processSliceBuffer(buffer, initialLineNumber, scan) {
  let pending = buffer;
  let lineNumber = initialLineNumber;
  while (true) {
    const newline = pending.indexOf(0x0a);
    if (newline === -1) break;
    const rawLine = stripCarriageReturn(pending.subarray(0, newline));
    pending = pending.subarray(newline + 1);
    lineNumber += 1;
    processLine({ rawLine, lineNumber, scan });
  }
}

function chooseAnchorOrder(locator, boundary) {
  const task = locator.task;
  if (
    !boundary.previousBoundary ||
    !finitePositiveInteger(task.endLine) ||
    !finiteInteger(task.endByte) ||
    task.endByte <= task.startByte
  ) {
    return ["forward"];
  }
  const forwardLineDistance = boundary.endLine - task.startLine + 1;
  const reverseLineDistance = task.endLine - boundary.previousBoundary.lineNumber + 1;
  return forwardLineDistance <= reverseLineDistance
    ? ["forward", "reverse"]
    : ["reverse", "forward"];
}

function resolveBoundary(locator) {
  if (!locator || typeof locator !== "object") {
    return unavailable("request_locator_missing", locator ?? {});
  }
  if (locator.boundaryStatus && locator.boundaryStatus !== "ok") {
    return unavailable(locator.boundaryStatus, locator);
  }
  const task = locator.task;
  if (
    !task ||
    !locator.sourceKey ||
    !finitePositiveInteger(locator.lineNumber) ||
    !finitePositiveInteger(task.startLine) ||
    !finiteInteger(task.startByte) ||
    task.startByte < 0
  ) {
    return unavailable("task_boundary_unavailable", locator);
  }
  if (task.sourceKey !== locator.sourceKey) {
    return unavailable("boundary_ambiguous", locator);
  }
  if (locator.lineNumber < task.startLine) {
    return unavailable("boundary_ambiguous", locator);
  }
  if (finitePositiveInteger(task.endLine) && locator.lineNumber > task.endLine) {
    return unavailable("source_changed", locator);
  }

  const previousBoundary = locator.previousBoundary ?? null;
  let startLine = task.startLine;
  if (previousBoundary) {
    if (
      previousBoundary.sourceKey !== locator.sourceKey ||
      !finitePositiveInteger(previousBoundary.lineNumber) ||
      previousBoundary.lineNumber < task.startLine ||
      previousBoundary.lineNumber >= locator.lineNumber
    ) {
      return unavailable("boundary_ambiguous", locator);
    }
    startLine = previousBoundary.lineNumber + 1;
  }
  return {
    available: true,
    startLine,
    endLine: locator.lineNumber,
    previousBoundary,
  };
}

function createScanState(locator, boundary, limits, anchorKind) {
  return {
    locator,
    boundary,
    limits,
    anchorKind,
    items: [],
    projectedItems: [],
    toolByCallId: new Map(),
    preModelCutLine: null,
    preModelCutRecordKind: null,
    payloadCharacters: 0,
    observedRecordCount: 0,
    malformedRecordCount: 0,
    unknownRecordCount: 0,
    omittedRecordCount: 0,
    omittedItemCount: 0,
    truncatedItemCount: 0,
    messageCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    reasoningSummaryCount: 0,
    reasoningRecordCount: 0,
    reasoningCardCount: 0,
    runtimeContextItemCount: 0,
    observedInputItemCount: 0,
    observedInteractionItemCount: 0,
    contextSignalCount: 0,
    taskAnchorValidated: false,
    reachedTaskAnchor: false,
    previousBoundaryValidated: false,
    reachedPreviousBoundary: false,
    endBoundaryValidated: false,
    reachedEndBoundary: false,
    truncated: false,
    recordLimitReached: false,
    scanBytes: 0,
  };
}

function processLine({ rawLine, lineNumber, scan }) {
  const { locator, boundary } = scan;
  if (lineNumber > boundary.endLine && scan.anchorKind === "forward") return true;
  const isTaskAnchorLine = scan.anchorKind === "reverse"
    ? lineNumber === locator.task.endLine
    : lineNumber === locator.task.startLine;
  if (lineNumber > boundary.endLine && !isTaskAnchorLine) return false;
  let record = null;
  let malformed = false;
  if (rawLine.length) {
    try {
      record = JSON.parse(rawLine.toString("utf8"));
    } catch {
      malformed = true;
    }
  } else {
    malformed = true;
  }

  if (isTaskAnchorLine) {
    scan.reachedTaskAnchor = true;
    scan.taskAnchorValidated = !malformed && (
      scan.anchorKind === "reverse"
        ? isMatchingTaskEnd(record, locator.turnId, locator.task.status, boundary.endLine === locator.task.endLine)
        : isMatchingTaskStart(record, locator.turnId)
    );
  }

  if (boundary.previousBoundary && lineNumber === boundary.previousBoundary.lineNumber) {
    scan.reachedPreviousBoundary = true;
    scan.previousBoundaryValidated = !malformed && isTokenCount(record);
  }

  if (!malformed && record) rememberToolAssociation(scan, record);

  if (lineNumber >= boundary.startLine && lineNumber <= boundary.endLine) {
    scan.observedRecordCount += 1;
    if (scan.observedRecordCount > scan.limits.maxRecords) {
      scan.recordLimitReached = true;
      scan.truncated = true;
      scan.omittedRecordCount += 1;
    } else if (malformed) {
      scan.malformedRecordCount += 1;
    } else {
      rememberPreModelCut(scan, record, lineNumber);
      const projection = projectRecord(record, scan);
      if (!projection.recognized) scan.unknownRecordCount += 1;
      if (projection.item) scan.projectedItems.push({ ...projection.item, _lineNumber: lineNumber });
    }
  }

  if (lineNumber === boundary.endLine) {
    scan.reachedEndBoundary = true;
    scan.endBoundaryValidated = !malformed && isTokenCount(record);
    return scan.anchorKind === "forward";
  }
  if (scan.anchorKind === "reverse" && lineNumber === locator.task.endLine) return true;
  return false;
}

function projectRecord(record, scan) {
  const payload = record?.payload ?? {};
  if (record?.type === "response_item") {
    if (payload.type === "message" || payload.type === "agent_message") {
      return { recognized: true, item: projectMessage(payload, scan.limits) };
    }
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      return { recognized: true, item: projectToolCall(payload, scan.limits) };
    }
    if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
      return {
        recognized: true,
        item: projectToolResult(payload, scan.toolByCallId.get(payload.call_id), scan.limits),
      };
    }
    if (payload.type === "reasoning") {
      return { recognized: true, item: projectReasoning(payload, scan.limits) };
    }
    return { recognized: false, item: null };
  }
  if (record?.type === "compacted") {
    return {
      recognized: true,
      item: {
        kind: "context_signal",
        signal: "compacted",
        label: "检测到一次 context compaction 记录",
      },
    };
  }
  if (record?.type === "turn_context") {
    return {
      recognized: true,
      item: projectRuntimeContext(payload, scan.limits),
    };
  }
  if (record?.type === "event_msg") {
    if (payload.type === "context_compacted") {
      return {
        recognized: true,
        item: {
          kind: "context_signal",
          signal: "compacted",
          label: "检测到一次 context compaction 记录",
        },
      };
    }
    return { recognized: KNOWN_EVENT_TYPES.has(payload.type), item: null };
  }
  return { recognized: KNOWN_TOP_LEVEL_RECORD_TYPES.has(record?.type), item: null };
}

function projectMessage(payload, limits) {
  const rawText = extractTextParts(payload.content);
  if (!rawText) return null;
  const bounded = boundText(rawText, limits.maxItemCharacters);
  const isAssistant = payload.type === "message" && payload.role === "assistant";
  return {
    kind: isAssistant ? "assistant_message" : "message",
    ...(isAssistant ? {} : { role: normalizeRole(payload) }),
    text: bounded.text,
    ...(payload.type === "agent_message" && typeof payload.author === "string"
      ? { author: payload.author }
      : {}),
    ...(payload.type === "agent_message" && typeof payload.recipient === "string"
      ? { recipient: payload.recipient }
      : {}),
    ...(bounded.truncated ? { truncated: true, originalCharacters: bounded.originalCharacters } : {}),
  };
}

function projectToolCall(payload, limits) {
  const tool = toolName(payload);
  const rawArguments = payload.type === "function_call" ? payload.arguments : payload.input;
  const fields = projectToolFields(rawArguments, limits.maxItemCharacters);
  const truncated = fields.some((field) => field.truncated);
  return {
    kind: "tool_call",
    tool,
    callId: typeof payload.call_id === "string" ? payload.call_id : null,
    status: typeof payload.status === "string" ? payload.status : null,
    fields,
    ...(truncated ? { truncated: true } : {}),
  };
}

function projectToolResult(payload, rememberedTool, limits) {
  const rawText = toolOutputText(payload.output);
  const bounded = boundText(rawText, limits.maxItemCharacters);
  return {
    kind: "tool_result",
    tool: rememberedTool ?? "unknown_tool",
    callId: typeof payload.call_id === "string" ? payload.call_id : null,
    text: bounded.text,
    lineCount: lineCount(rawText),
    truncated: bounded.truncated,
    ...(bounded.truncated ? { originalCharacters: bounded.originalCharacters } : {}),
  };
}

function projectReasoning(payload, limits) {
  const summaryText = extractReasoningSummary(payload.summary);
  const opaqueContentPresent = hasOpaqueReasoning(payload);
  if (!summaryText) {
    return {
      kind: "reasoning_activity",
      opaqueContentPresent,
      occurrenceCount: 1,
    };
  }
  const bounded = boundText(summaryText, limits.maxItemCharacters);
  return {
    kind: "reasoning_summary",
    text: bounded.text,
    opaqueContentPresent,
    occurrenceCount: 1,
    ...(bounded.truncated ? { truncated: true, originalCharacters: bounded.originalCharacters } : {}),
  };
}

const RUNTIME_CONTEXT_FIELDS = Object.freeze([
  ["model", "Model"],
  ["effort", "Effort"],
  ["current_date", "Current date"],
  ["timezone", "Timezone"],
  ["cwd", "Working directory"],
  ["workspace_roots", "Workspace roots"],
  ["approval_policy", "Approval policy"],
  ["sandbox_policy", "Sandbox policy"],
  ["active_permission_profile", "Active permission profile"],
  ["personality", "Personality"],
  ["collaboration_mode", "Collaboration mode"],
]);

function projectRuntimeContext(payload, limits) {
  const fields = [];
  for (const [key, label] of RUNTIME_CONTEXT_FIELDS) {
    const value = runtimeContextValue(payload, key);
    if (value == null) continue;
    const bounded = boundText(describeStructuredValue(value), limits.maxItemCharacters);
    fields.push({
      key,
      label,
      value: bounded.text,
      format: key === "cwd" || key === "workspace_roots" ? "code" : "text",
      ...(bounded.truncated ? { truncated: true } : {}),
    });
  }
  if (!fields.length) return null;
  return {
    kind: "runtime_context",
    fields,
    ...(fields.some((field) => field.truncated) ? { truncated: true } : {}),
  };
}

function runtimeContextValue(payload, snakeKey) {
  if (!payload || typeof payload !== "object") return null;
  if (Object.hasOwn(payload, snakeKey)) return payload[snakeKey];
  const camelKey = snakeKey.replace(/_([a-z])/gu, (_match, character) => character.toUpperCase());
  return Object.hasOwn(payload, camelKey) ? payload[camelKey] : null;
}

function rememberPreModelCut(scan, record, lineNumber) {
  if (scan.preModelCutLine != null) return;
  const kind = modelOutputEvidenceKind(record);
  if (!kind) return;
  scan.preModelCutLine = lineNumber;
  scan.preModelCutRecordKind = kind;
}

function modelOutputEvidenceKind(record) {
  if (record?.type !== "response_item") return null;
  const payload = record.payload ?? {};
  if (payload.type === "reasoning") return "reasoning";
  if (payload.type === "custom_tool_call" || payload.type === "function_call") return "tool_call";
  if (payload.type === "agent_message") return "assistant_message";
  if (payload.type === "message" && payload.role === "assistant") return "assistant_message";
  return null;
}

function projectToolFields(rawArguments, maxCharacters) {
  const parsed = parseStructuredArguments(rawArguments);
  if (!parsed.structured) {
    const bounded = boundText(parsed.text, maxCharacters);
    return [{
      label: "Input",
      value: bounded.text,
      format: "code",
      ...(bounded.truncated ? { truncated: true } : {}),
    }];
  }
  if (Array.isArray(parsed.value)) {
    const bounded = boundText(describeStructuredValue(parsed.value), maxCharacters);
    return [{
      label: "Arguments",
      value: bounded.text,
      format: "text",
      ...(bounded.truncated ? { truncated: true } : {}),
    }];
  }
  const entries = Object.entries(parsed.value);
  if (!entries.length) return [];
  return entries.map(([key, value]) => {
    const bounded = boundText(describeStructuredValue(value), maxCharacters);
    return {
      label: toolFieldLabel(key),
      value: bounded.text,
      format: toolFieldFormat(key, value),
      ...(bounded.truncated ? { truncated: true } : {}),
    };
  });
}

function rememberToolAssociation(scan, record) {
  if (record?.type !== "response_item") return;
  const payload = record.payload ?? {};
  if (payload.type !== "custom_tool_call" && payload.type !== "function_call") return;
  if (typeof payload.call_id !== "string" || !payload.call_id) return;
  if (scan.toolByCallId.size >= scan.limits.maxRecords) return;
  scan.toolByCallId.set(payload.call_id, toolName(payload));
}

function addProjectedItem(scan, item) {
  if (!item) return;
  const perItemTruncated = Boolean(item.truncated) ||
    (Array.isArray(item.fields) && item.fields.some((field) => field.truncated));
  let candidate = item;
  const bodyCharacters = itemBodyCharacters(candidate);
  const remaining = Math.max(0, scan.limits.maxPayloadCharacters - scan.payloadCharacters);
  if (bodyCharacters > remaining) {
    candidate = fitItemToBodyBudget(candidate, remaining);
    scan.truncated = true;
    if (!candidate) {
      scan.omittedItemCount += 1;
      return;
    }
  }
  const budgetTruncated = itemBodyCharacters(candidate) < bodyCharacters;
  if (perItemTruncated || budgetTruncated) {
    scan.truncated = true;
    scan.truncatedItemCount += 1;
  }
  scan.payloadCharacters += itemBodyCharacters(candidate);
  scan.items.push(candidate);
  incrementKindCount(scan, candidate.kind);
}

function addContextSignal(scan, item) {
  const alreadyPresent = scan.projectedItems.some(
    (candidate) => candidate.kind === "context_signal" && candidate.signal === item.signal,
  );
  if (!alreadyPresent) scan.projectedItems.push(item);
}

function finalizeSemanticProjection(scan) {
  const sectioned = scan.projectedItems.map((item) => {
    const { _lineNumber: lineNumber = null, ...publicItem } = item;
    return {
      ...publicItem,
      section: assignSection(publicItem, lineNumber, scan.preModelCutLine),
    };
  });
  scan.reasoningRecordCount = sectioned.filter(isReasoningItem).length;
  const coalesced = coalesceReasoningItems(sectioned);
  for (const item of coalesced) addProjectedItem(scan, item);
  scan.reasoningCardCount = scan.items.filter(isReasoningItem).length;
}

function assignSection(item, lineNumber, cutLine) {
  if (item.kind === "runtime_context") return "runtime_context";
  if (
    cutLine != null &&
    lineNumber != null &&
    lineNumber < cutLine &&
    isObservedInputItem(item)
  ) {
    return "observed_input";
  }
  return "observed_interaction";
}

function isObservedInputItem(item) {
  if (item.kind === "tool_result") return true;
  if (item.kind !== "message") return false;
  return item.role !== "assistant" && item.role !== "agent";
}

function coalesceReasoningItems(items) {
  const output = [];
  for (const item of items) {
    const previous = output.at(-1);
    if (canCoalesceReasoning(previous, item)) {
      previous.occurrenceCount = (previous.occurrenceCount ?? 1) + (item.occurrenceCount ?? 1);
      previous.opaqueContentPresent = Boolean(previous.opaqueContentPresent || item.opaqueContentPresent);
      previous.truncated = Boolean(previous.truncated || item.truncated);
      if (item.originalCharacters != null) {
        previous.originalCharacters = Math.max(
          Number(previous.originalCharacters ?? 0),
          Number(item.originalCharacters ?? 0),
        );
      }
      continue;
    }
    output.push({ ...item });
  }
  return output;
}

function canCoalesceReasoning(left, right) {
  if (!left || !right || left.section !== right.section) return false;
  if (left.kind === "reasoning_activity" && right.kind === "reasoning_activity") return true;
  if (left.kind !== "reasoning_summary" || right.kind !== "reasoning_summary") return false;
  return normalizeReasoningSummary(left.text) === normalizeReasoningSummary(right.text);
}

function normalizeReasoningSummary(value) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function isReasoningItem(item) {
  return item?.kind === "reasoning_summary" || item?.kind === "reasoning_activity";
}

function publicPreModelCut(scan) {
  if (scan.preModelCutLine == null) {
    return { status: "unavailable", kind: null, lineNumber: null, recordKind: null };
  }
  return {
    status: "observed",
    kind: "before_first_observed_model_output",
    lineNumber: scan.preModelCutLine,
    recordKind: scan.preModelCutRecordKind,
  };
}

function fitItemToBodyBudget(item, remaining) {
  if (itemBodyCharacters(item) <= remaining) return item;
  if (remaining <= 0) return null;
  const next = structuredClone(item);
  if (typeof next.text === "string") {
    next.originalCharacters = next.originalCharacters ?? next.text.length;
    next.text = next.text.slice(0, remaining);
    next.truncated = true;
    return next;
  }
  if (Array.isArray(next.fields)) {
    let budget = remaining;
    for (const field of next.fields) {
      if (typeof field.value !== "string") continue;
      if (budget <= 0) {
        field.value = "";
        field.truncated = true;
        continue;
      }
      if (field.value.length > budget) {
        field.value = field.value.slice(0, budget);
        field.truncated = true;
      }
      budget -= field.value.length;
    }
    next.truncated = true;
    return next;
  }
  return item;
}

function incrementKindCount(scan, kind) {
  if (kind === "message" || kind === "assistant_message") scan.messageCount += 1;
  else if (kind === "tool_call") scan.toolCallCount += 1;
  else if (kind === "tool_result") scan.toolResultCount += 1;
  else if (kind === "reasoning_summary") scan.reasoningSummaryCount += 1;
  else if (kind === "context_signal") scan.contextSignalCount += 1;
  if (kind === "runtime_context") scan.runtimeContextItemCount += 1;
}

function summarize(scan) {
  scan.observedInputItemCount = scan.items.filter((item) => item.section === "observed_input").length;
  scan.observedInteractionItemCount = scan.items.filter((item) => item.section === "observed_interaction").length;
  return {
    observedItemCount: scan.items.length,
    observedRecordCount: scan.observedRecordCount,
    messageCount: scan.messageCount,
    toolCallCount: scan.toolCallCount,
    toolResultCount: scan.toolResultCount,
    reasoningSummaryCount: scan.reasoningSummaryCount,
    reasoningRecordCount: scan.reasoningRecordCount,
    reasoningCardCount: scan.reasoningCardCount,
    observedInputItemCount: scan.observedInputItemCount,
    runtimeContextItemCount: scan.runtimeContextItemCount,
    observedInteractionItemCount: scan.observedInteractionItemCount,
    contextSignalCount: scan.contextSignalCount,
    malformedRecordCount: scan.malformedRecordCount,
    unknownRecordCount: scan.unknownRecordCount,
    omittedRecordCount: scan.omittedRecordCount,
    omittedItemCount: scan.omittedItemCount,
    truncatedItemCount: scan.truncatedItemCount,
    payloadCharacters: scan.payloadCharacters,
  };
}

function resolveCoverage(scan) {
  if (scan.malformedRecordCount > 0) return "record_parse_partial";
  if (scan.truncated || scan.recordLimitReached) return "content_truncated";
  if (scan.unknownRecordCount > 0) return "unsupported_content_shape";
  return "complete";
}

function unavailable(reason, locator, boundary = null, extras = {}) {
  const startLine = boundary?.startLine ?? null;
  const endLine = boundary?.endLine ?? (finitePositiveInteger(locator?.lineNumber) ? locator.lineNumber : null);
  return {
    available: false,
    reason,
    evidence: {
      kind: "rollout_observed_interaction",
      providerPayloadReconstructed: false,
      sourceKey: locator?.sourceKey ?? null,
      startLine,
      endLine,
      complete: false,
      truncated: Boolean(extras.truncated),
      coverage: reason,
      ...(finiteInteger(extras.scanBytes) ? { scanBytes: extras.scanBytes } : {}),
      ...(finiteInteger(extras.locateBytes) ? { locateBytes: extras.locateBytes } : {}),
      ...(finiteInteger(extras.sliceBytes) ? { sliceBytes: extras.sliceBytes } : {}),
      ...(typeof extras.anchor === "string" ? { anchor: extras.anchor } : {}),
    },
    preModelCut: { status: "unavailable", kind: null, lineNumber: null, recordKind: null },
    items: [],
    summary: emptySummary(),
  };
}

function emptySummary() {
  return {
    observedItemCount: 0,
    observedRecordCount: 0,
    messageCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    reasoningSummaryCount: 0,
    reasoningRecordCount: 0,
    reasoningCardCount: 0,
    observedInputItemCount: 0,
    runtimeContextItemCount: 0,
    observedInteractionItemCount: 0,
    contextSignalCount: 0,
    malformedRecordCount: 0,
    unknownRecordCount: 0,
    omittedRecordCount: 0,
    omittedItemCount: 0,
    truncatedItemCount: 0,
    payloadCharacters: 0,
  };
}

function isMatchingTaskStart(record, turnId) {
  if (record?.type !== "event_msg") return false;
  const payload = record.payload ?? {};
  if (!TASK_START_TYPES.has(payload.type)) return false;
  const recordTurnId = payload.turn_id ?? payload.turnId ?? payload.id ?? null;
  return !turnId || recordTurnId === turnId;
}

function isMatchingTaskEnd(record, turnId, status, sameAsRequestBoundary) {
  if (sameAsRequestBoundary && isTokenCount(record)) return true;
  if (status === "in_progress") return isTokenCount(record);
  if (record?.type !== "event_msg") return false;
  const payload = record.payload ?? {};
  if (!TASK_END_TYPES.has(payload.type)) return false;
  const recordTurnId = payload.turn_id ?? payload.turnId ?? payload.id ?? null;
  return !turnId || recordTurnId === turnId;
}

function isTokenCount(record) {
  return record?.type === "event_msg" && record?.payload?.type === "token_count";
}

function normalizeRole(payload) {
  if (payload.type === "agent_message") return "agent";
  return typeof payload.role === "string" && payload.role ? payload.role : "unknown";
}

function extractTextParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (!["input_text", "output_text", "text"].includes(part.type)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

function extractReasoningSummary(summary) {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (part.type && part.type !== "summary_text" && part.type !== "text") return "";
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

function hasOpaqueReasoning(payload) {
  if (typeof payload?.encrypted_content === "string" && payload.encrypted_content.length > 0) return true;
  if (!Array.isArray(payload?.content)) return false;
  return payload.content.some((part) => part?.type === "encrypted_content");
}

function toolName(payload) {
  const name = typeof payload?.name === "string" && payload.name ? payload.name : "unknown_tool";
  const namespace = typeof payload?.namespace === "string" && payload.namespace ? payload.namespace : null;
  return namespace ? `${namespace}.${name}` : name;
}

function parseStructuredArguments(value) {
  if (value && typeof value === "object") return { structured: true, value };
  if (typeof value !== "string") return { structured: false, text: value == null ? "" : String(value) };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return { structured: true, value: parsed };
  } catch {
    // A plain string is a valid custom-tool input; keep it as bounded text.
  }
  return { structured: false, text: value };
}

function toolOutputText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return describeStructuredValue(value);
}

function describeStructuredValue(value) {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) {
      return value.map(String).join(" · ");
    }
    return `Structured list · ${value.length} items`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const preview = keys.slice(0, 4).join(" · ");
    return `Structured value · ${keys.length} fields${preview ? ` · ${preview}` : ""}`;
  }
  return String(value);
}

function toolFieldLabel(key) {
  const normalized = String(key);
  const known = {
    cmd: "Command",
    command: "Command",
    cwd: "Working directory",
    workingDirectory: "Working directory",
    working_directory: "Working directory",
    path: "Path",
    filePath: "File path",
    file_path: "File path",
    limit: "Limit",
    offset: "Offset",
    query: "Query",
    url: "URL",
  };
  if (known[normalized]) return known[normalized];
  return normalized
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function toolFieldFormat(key, value) {
  if (typeof value !== "string") return "text";
  return /^(?:cmd|command|path|filePath|file_path|cwd|workingDirectory|working_directory)$/u.test(key)
    ? "code"
    : "text";
}

function boundText(value, maxCharacters) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxCharacters) {
    return { text, truncated: false, originalCharacters: text.length };
  }
  return {
    text: text.slice(0, maxCharacters),
    truncated: true,
    originalCharacters: text.length,
  };
}

function itemBodyCharacters(item) {
  let count = typeof item?.text === "string" ? item.text.length : 0;
  if (Array.isArray(item?.fields)) {
    for (const field of item.fields) {
      if (typeof field?.value === "string") count += field.value.length;
    }
  }
  return count;
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\r?\n/u).length;
}

function normalizeLimits(limits) {
  const merged = { ...REQUEST_CONTENT_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(REQUEST_CONTENT_LIMITS)) {
    if (!finitePositiveInteger(merged[key])) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
  return merged;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

function stripCarriageReturn(buffer) {
  return buffer.length && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, buffer.length - 1)
    : buffer;
}

function finitePositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function finiteInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value);
}
