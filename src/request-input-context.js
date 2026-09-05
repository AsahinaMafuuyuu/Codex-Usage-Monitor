import { open, stat } from "node:fs/promises";
import { readRequestContent } from "./request-content.js";

export const REQUEST_INPUT_CONTEXT_LIMITS = Object.freeze({
  maxSourceSegments: 16,
  maxHistoryScanBytes: 32 * 1024 * 1024,
  maxContextItems: 800,
  maxItemCharacters: 64 * 1024,
  maxProjectedCharacters: 1024 * 1024,
});

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Reconstruct the locally observable input context for one canonical Request.
 * This never claims to recover the provider serialization and never allocates
 * official token accounting to individual context items.
 */
export async function readReconstructedInputContext({
  locator,
  resolveSource,
  limits = REQUEST_INPUT_CONTEXT_LIMITS,
}) {
  const bounded = normalizeLimits(limits);
  const base = createBaseResult(locator);
  if (!locator || locator.sourceChainStatus !== "ok" || !Array.isArray(locator.sourceChain)) {
    return unavailable(base, locator?.sourceChainStatus ?? "boundary_ambiguous");
  }
  if (locator.sourceChain.length === 0 || locator.sourceChain.length > bounded.maxSourceSegments) {
    return unavailable(base, "boundary_ambiguous");
  }

  const currentPath = resolveSource(locator.sourceKey);
  let currentContent = null;
  if (currentPath) {
    currentContent = await readRequestContent({ sourcePath: currentPath, locator });
  }

  const state = {
    historyItems: [],
    compaction: [],
    gaps: [],
    scanBytes: 0,
    sourceMissingCount: 0,
    compactionCount: 0,
    supersededItemCount: 0,
    truncatedItemCount: 0,
    projectedCharacters: 0,
    truncated: false,
    fullyObservedFromThreadStart: true,
    lastExplicitCompaction: null,
  };

  const chunks = await collectHistoricalChunks({ locator, resolveSource, limits: bounded, state });
  for (const chunk of chunks) processHistoricalChunk(chunk, state, bounded);

  const currentInput = projectCurrentItems(currentContent, "observed_input", "direct_current", locator, bounded);
  const runtimeContext = projectCurrentItems(currentContent, "runtime_context", "runtime_context", locator, bounded);
  const historyGroups = groupHistoryItems(enforceHistoryBounds(state, bounded));
  const cut = currentContent?.preModelCut ?? {
    status: "unavailable",
    kind: null,
    lineNumber: null,
    recordKind: null,
  };
  if (!currentPath) {
    addGap(state, { reason: "source_missing", sourceKey: locator.sourceKey, rebasable: false });
  }
  if (!currentContent?.available) {
    addGap(state, {
      reason: currentContent?.reason ?? (currentPath ? "current_content_unavailable" : "source_missing"),
      sourceKey: locator.sourceKey,
      rebasable: false,
    });
  } else if (cut.status !== "observed") {
    addGap(state, { reason: "current_cut_unavailable", sourceKey: locator.sourceKey, rebasable: false });
  }

  const finalGaps = state.gaps.map((gap, index) => ({
    id: `gap-${index + 1}`,
    kind: "coverage_gap",
    provenance: { level: "coverage_gap", sourceKey: gap.sourceKey ?? null },
    reason: gap.reason,
    sourceKey: gap.sourceKey ?? null,
  }));
  const rolloutCoverage = resolveRolloutCoverage(state, cut, currentContent);
  return {
    ...base,
    available: true,
    reason: null,
    evidence: {
      kind: "reconstructed_input_context",
      providerPayloadReconstructed: false,
      providerSerializationKnown: false,
      rolloutCoverage,
      sourceSegmentCount: locator.sourceChain.length,
      sourceOrdering: locator.sourceOrdering,
      compactionCount: state.compactionCount,
      truncated: state.truncated,
    },
    reconstructionCut: {
      status: cut.status,
      kind: cut.kind,
      sourceKey: locator.sourceKey,
      lineNumber: cut.lineNumber,
      recordKind: cut.recordKind ?? null,
    },
    sections: {
      currentInput,
      runtimeContext,
      historyGroups,
      compaction: state.compaction,
      gaps: finalGaps,
    },
    summary: {
      itemCount: currentInput.length + runtimeContext.length + historyGroups.reduce((sum, group) => sum + group.itemCount, 0),
      visibleCharacters: state.projectedCharacters + bodyCharacters(currentInput) + bodyCharacters(runtimeContext),
      sourceSegmentCount: locator.sourceChain.length,
      missingSourceCount: state.sourceMissingCount,
      compactionCount: state.compactionCount,
      supersededItemCount: state.supersededItemCount,
      truncatedItemCount: state.truncatedItemCount,
      historyScanBytes: state.scanBytes,
    },
  };
}

function createBaseResult(locator) {
  return {
    version: 1,
    request: null,
    requestId: locator?.requestId ?? null,
  };
}

function unavailable(base, reason) {
  return {
    ...base,
    available: false,
    reason,
    evidence: {
      kind: "reconstructed_input_context",
      providerPayloadReconstructed: false,
      providerSerializationKnown: false,
      rolloutCoverage: "unavailable",
      sourceSegmentCount: 0,
      compactionCount: 0,
      truncated: false,
    },
    reconstructionCut: { status: "unavailable", kind: null, sourceKey: null, lineNumber: null, recordKind: null },
    sections: { currentInput: [], runtimeContext: [], historyGroups: [], compaction: [], gaps: [] },
    summary: emptySummary(),
  };
}

async function collectHistoricalChunks({ locator, resolveSource, limits, state }) {
  const currentIndex = locator.sourceChain.findIndex((segment) => segment.current);
  if (currentIndex < 0) {
    addGap(state, { reason: "boundary_ambiguous", sourceKey: locator.sourceKey, rebasable: false });
    return [];
  }
  const chunksNewestFirst = [];
  let remaining = limits.maxHistoryScanBytes;
  const historyEndLine = historyEndLineFor(locator);

  if (historyEndLine >= Number(locator.task?.startLine ?? Infinity) && remaining > 0) {
    const path = resolveSource(locator.sourceKey);
    if (!path) {
      state.sourceMissingCount += 1;
      addGap(state, { reason: "source_missing", sourceKey: locator.sourceKey, rebasable: true });
    } else {
      const taskChunk = await readForwardLineRange({
        path,
        sourceKey: locator.sourceKey,
        startByte: Number(locator.task.startByte),
        startLine: Number(locator.task.startLine),
        endLine: historyEndLine,
        maxBytes: remaining,
      });
      state.scanBytes += taskChunk.bytesRead;
      remaining -= taskChunk.bytesRead;
      if (taskChunk.truncated) markBoundedTruncation(state, locator.sourceKey);
      if (taskChunk.records.length) chunksNewestFirst.push(taskChunk);
      if (!taskChunk.truncated && hasUsableCompaction(taskChunk.records)) {
        return chunksNewestFirst.reverse();
      }
    }
  }

  const taskStartByte = Number(locator.task?.startByte ?? 0);
  const taskStartLine = Number(locator.task?.startLine ?? 1);
  if (taskStartByte > 0 && remaining > 0) {
    const path = resolveSource(locator.sourceKey);
    if (!path) {
      state.sourceMissingCount += 1;
      addGap(state, { reason: "source_missing", sourceKey: locator.sourceKey, rebasable: true });
    } else {
      const prefixChunk = await readTailRange({
        path,
        sourceKey: locator.sourceKey,
        endByte: taskStartByte,
        endLine: taskStartLine - 1,
        maxBytes: remaining,
      });
      state.scanBytes += prefixChunk.bytesRead;
      remaining -= prefixChunk.bytesRead;
      if (prefixChunk.truncated) markBoundedTruncation(state, locator.sourceKey);
      if (prefixChunk.records.length) chunksNewestFirst.push(prefixChunk);
      if (hasUsableCompaction(prefixChunk.records)) {
        return chunksNewestFirst.reverse();
      }
    }
  }

  for (let index = currentIndex - 1; index >= 0 && remaining > 0; index -= 1) {
    const segment = locator.sourceChain[index];
    const path = resolveSource(segment.sourceKey);
    if (!path) {
      state.sourceMissingCount += 1;
      state.fullyObservedFromThreadStart = false;
      addGap(state, { reason: "source_missing", sourceKey: segment.sourceKey, rebasable: true });
      continue;
    }
    const endByte = finitePositiveInteger(segment.parsedByteOffset)
      ? segment.parsedByteOffset
      : segment.fileSize;
    const chunk = await readTailRange({
      path,
      sourceKey: segment.sourceKey,
      endByte,
      endLine: segment.lastKnownLine,
      maxBytes: remaining,
    });
    state.scanBytes += chunk.bytesRead;
    remaining -= chunk.bytesRead;
    if (chunk.truncated) markBoundedTruncation(state, segment.sourceKey);
    if (chunk.records.length) chunksNewestFirst.push(chunk);
    if (hasUsableCompaction(chunk.records)) break;
  }

  if (currentIndex > 0 && remaining <= 0) markBoundedTruncation(state, locator.sourceChain[0]?.sourceKey ?? null);
  return chunksNewestFirst.reverse();
}

function hasUsableCompaction(records) {
  return records.some(({ record }) =>
    record?.type === "compacted" &&
    Array.isArray(record.payload?.replacement_history ?? record.payload?.replacementHistory),
  );
}

function historyEndLineFor(locator) {
  if (locator.previousBoundary?.lineNumber != null) return Number(locator.previousBoundary.lineNumber);
  return Number(locator.task?.startLine ?? 1) - 1;
}

async function readForwardLineRange({ path, sourceKey, startByte, startLine, endLine, maxBytes }) {
  if (endLine < startLine || maxBytes <= 0) return { sourceKey, records: [], bytesRead: 0, truncated: false };
  const handle = await open(path, "r");
  const records = [];
  let cursor = startByte;
  let pendingChunks = [];
  let pendingLength = 0;
  let bytesRead = 0;
  let lineNumber = startLine - 1;
  let reachedEnd = false;
  try {
    while (bytesRead < maxBytes && !reachedEnd) {
      const length = Math.min(READ_CHUNK_BYTES, maxBytes - bytesRead);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, cursor);
      if (result.bytesRead <= 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      bytesRead += result.bytesRead;
      cursor += result.bytesRead;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) {
          const tail = chunk.subarray(start);
          if (tail.length) {
            pendingChunks.push(tail);
            pendingLength += tail.length;
          }
          break;
        }
        const segment = chunk.subarray(start, newline);
        let raw;
        if (pendingLength === 0) {
          raw = stripCr(segment);
        } else {
          if (segment.length) pendingChunks.push(segment);
          raw = stripCr(Buffer.concat(pendingChunks, pendingLength + segment.length));
          pendingChunks = [];
          pendingLength = 0;
        }
        lineNumber += 1;
        if (lineNumber > endLine) {
          reachedEnd = true;
          break;
        }
        records.push({ lineNumber, record: parseRecord(raw) });
        if (lineNumber === endLine) {
          reachedEnd = true;
          break;
        }
        start = newline + 1;
      }
    }
  } finally {
    await handle.close();
  }
  return { sourceKey, records, bytesRead, truncated: !reachedEnd };
}

async function readTailRange({ path, sourceKey, endByte, endLine, maxBytes }) {
  const file = await stat(path);
  const boundedEnd = Math.min(file.size, finitePositiveInteger(endByte) ? endByte : file.size);
  const length = Math.min(boundedEnd, maxBytes);
  if (length <= 0) return { sourceKey, records: [], bytesRead: 0, truncated: boundedEnd > 0 };
  const start = boundedEnd - length;
  const handle = await open(path, "r");
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, start + offset);
      if (result.bytesRead <= 0) break;
      offset += result.bytesRead;
    }
    buffer = buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
  const truncated = start > 0;
  const recordsNewestFirst = [];
  let lineNumber = finitePositiveInteger(endLine) ? endLine : countNewlines(buffer);
  let lineEnd = buffer.length;
  if (lineEnd > 0 && buffer[lineEnd - 1] === 0x0a) lineEnd -= 1;
  while (lineEnd >= 0 && lineNumber > 0) {
    const previousNewline = buffer.lastIndexOf(0x0a, lineEnd - 1);
    if (truncated && previousNewline < 0) break;
    const lineStart = previousNewline + 1;
    const raw = stripCr(buffer.subarray(lineStart, lineEnd));
    const record = parseRecord(raw);
    recordsNewestFirst.push({ lineNumber, record });
    if (
      record?.type === "compacted" &&
      Array.isArray(record.payload?.replacement_history ?? record.payload?.replacementHistory)
    ) {
      break;
    }
    lineNumber -= 1;
    if (previousNewline < 0) break;
    lineEnd = previousNewline;
  }
  return { sourceKey, records: recordsNewestFirst.reverse(), bytesRead: length, truncated };
}

function processHistoricalChunk(chunk, state, limits) {
  const toolByCallId = new Map();
  for (const entry of chunk.records) {
    const record = entry.record;
    if (!record) {
      addGap(state, { reason: "partial_unsupported_shape", sourceKey: chunk.sourceKey, rebasable: true });
      continue;
    }
    if (record.type === "compacted") {
      applyCompaction(record.payload ?? {}, entry, chunk.sourceKey, state, limits);
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "context_compacted") {
      if (
        state.lastExplicitCompaction?.sourceKey === chunk.sourceKey &&
        entry.lineNumber > state.lastExplicitCompaction.lineNumber &&
        entry.lineNumber - state.lastExplicitCompaction.lineNumber <= 4
      ) {
        continue;
      }
      state.compactionCount += 1;
      state.supersededItemCount += state.historyItems.length;
      state.historyItems = [];
      state.compaction.push({
        id: `compaction-${state.compaction.length + 1}`,
        kind: "compaction_signal",
        provenance: { level: "coverage_gap", sourceKey: chunk.sourceKey, lineStart: entry.lineNumber, lineEnd: entry.lineNumber },
        label: "Compaction signal observed; replacement snapshot unavailable.",
      });
      addGap(state, { reason: "partial_compaction_snapshot_unavailable", sourceKey: chunk.sourceKey, rebasable: true });
      continue;
    }
    const item = projectHistoricalRecord(record, toolByCallId, limits);
    if (!item) continue;
    pushHistoryItem(state, {
      ...item,
      id: `history-${state.historyItems.length + 1}-${entry.lineNumber}`,
      provenance: {
        level: "historical_rollout",
        sourceKey: chunk.sourceKey,
        lineStart: entry.lineNumber,
        lineEnd: entry.lineNumber,
      },
    }, limits);
  }
}

function applyCompaction(payload, entry, sourceKey, state, limits) {
  state.compactionCount += 1;
  const replacement = payload.replacement_history ?? payload.replacementHistory ?? null;
  if (!Array.isArray(replacement)) {
    state.supersededItemCount += state.historyItems.length;
    state.historyItems = [];
    state.compaction.push({
      id: `compaction-${state.compaction.length + 1}`,
      kind: "compaction_signal",
      provenance: { level: "coverage_gap", sourceKey, lineStart: entry.lineNumber, lineEnd: entry.lineNumber },
      label: "Compaction observed without a readable replacement history snapshot.",
    });
    addGap(state, { reason: "partial_compaction_snapshot_unavailable", sourceKey, rebasable: true });
    return;
  }
  const toolByCallId = new Map();
  const replacementItems = [];
  for (let index = 0; index < replacement.length; index += 1) {
    const item = projectReplacementEntry(replacement[index], toolByCallId, limits);
    if (!item) continue;
    replacementItems.push({
      ...item,
      id: `compaction-${state.compactionCount}-item-${index + 1}`,
      provenance: {
        level: "compaction_snapshot",
        sourceKey,
        lineStart: entry.lineNumber,
        lineEnd: entry.lineNumber,
      },
    });
  }
  state.supersededItemCount += state.historyItems.length;
  state.historyItems = [];
  state.projectedCharacters = 0;
  state.gaps = state.gaps.filter((gap) => !gap.rebasable);
  state.fullyObservedFromThreadStart = true;
  state.truncated = state.gaps.some((gap) => gap.reason === "partial_bounded_truncation");
  state.truncatedItemCount = 0;
  state.lastExplicitCompaction = { sourceKey, lineNumber: entry.lineNumber };
  for (const item of replacementItems) pushHistoryItem(state, item, limits);
  state.compaction.push({
    id: `compaction-${state.compaction.length + 1}`,
    kind: "compaction_snapshot",
    provenance: { level: "compaction_snapshot", sourceKey, lineStart: entry.lineNumber, lineEnd: entry.lineNumber },
    label: `Explicit replacement history snapshot · ${state.historyItems.length} projected items`,
    itemCount: state.historyItems.length,
  });
}

function projectHistoricalRecord(record, toolByCallId, limits) {
  if (record.type !== "response_item") return null;
  return projectResponsePayload(record.payload ?? {}, toolByCallId, limits);
}

function projectReplacementEntry(entry, toolByCallId, limits) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "response_item") return projectResponsePayload(entry.payload ?? {}, toolByCallId, limits);
  if (entry.type === "message" || entry.type === "agent_message" || entry.role) {
    return projectResponsePayload({
      ...entry,
      type: entry.type === "agent_message" ? "agent_message" : "message",
    }, toolByCallId, limits);
  }
  if (["custom_tool_call", "function_call", "custom_tool_call_output", "function_call_output"].includes(entry.type)) {
    return projectResponsePayload(entry, toolByCallId, limits);
  }
  return null;
}

function projectResponsePayload(payload, toolByCallId, limits) {
  if (payload.type === "reasoning") return null;
  if (payload.type === "message" || payload.type === "agent_message") {
    const text = extractText(payload.content);
    if (!text) return null;
    const bounded = boundText(text, limits.maxItemCharacters);
    return {
      kind: "message",
      role: payload.type === "agent_message" ? "assistant" : normalizeRole(payload.role),
      text: bounded.text,
      truncated: bounded.truncated,
    };
  }
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const tool = toolName(payload);
    if (payload.call_id) toolByCallId.set(payload.call_id, tool);
    const raw = payload.type === "function_call" ? payload.arguments : payload.input;
    const bounded = boundText(describeArguments(raw), limits.maxItemCharacters);
    return {
      kind: "tool_call",
      tool,
      callId: payload.call_id ?? null,
      text: bounded.text,
      truncated: bounded.truncated,
    };
  }
  if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
    const raw = outputText(payload.output);
    const bounded = boundText(raw, limits.maxItemCharacters);
    return {
      kind: "tool_result",
      tool: toolByCallId.get(payload.call_id) ?? "unknown_tool",
      callId: payload.call_id ?? null,
      text: bounded.text,
      lineCount: lineCount(raw),
      truncated: bounded.truncated,
    };
  }
  return null;
}

function projectCurrentItems(content, section, level, locator, limits) {
  if (!content?.available) return [];
  const items = (content.items ?? []).filter((item) => item.section === section);
  return items.map((item, index) => {
    const clone = structuredClone(item);
    clone.id = `${level}-${index + 1}`;
    clone.provenance = {
      level,
      sourceKey: locator.sourceKey,
      lineStart: content.evidence?.startLine ?? null,
      lineEnd: content.preModelCut?.lineNumber != null ? content.preModelCut.lineNumber - 1 : null,
    };
    if (itemBodyCharacters(clone) > limits.maxItemCharacters) clone.truncated = true;
    return clone;
  });
}

function pushHistoryItem(state, item, limits) {
  if (state.historyItems.length >= limits.maxContextItems) {
    state.truncated = true;
    state.truncatedItemCount += 1;
    addGap(state, { reason: "partial_bounded_truncation", sourceKey: item.provenance?.sourceKey ?? null, rebasable: true });
    return;
  }
  const characters = itemBodyCharacters(item);
  if (state.projectedCharacters + characters > limits.maxProjectedCharacters) {
    state.truncated = true;
    state.truncatedItemCount += 1;
    addGap(state, { reason: "partial_bounded_truncation", sourceKey: item.provenance?.sourceKey ?? null, rebasable: true });
    return;
  }
  if (item.truncated) state.truncatedItemCount += 1;
  state.projectedCharacters += characters;
  state.historyItems.push(item);
}

function enforceHistoryBounds(state, limits) {
  if (state.historyItems.length <= limits.maxContextItems) return state.historyItems;
  state.truncated = true;
  const omitted = state.historyItems.length - limits.maxContextItems;
  state.truncatedItemCount += omitted;
  return state.historyItems.slice(-limits.maxContextItems);
}

function groupHistoryItems(items) {
  const groups = [];
  for (const item of items) {
    const key = `${item.provenance?.level ?? "historical_rollout"}\u0000${item.provenance?.sourceKey ?? "unknown"}`;
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = {
        key,
        id: `history-group-${groups.length + 1}`,
        label: item.provenance?.level === "compaction_snapshot" ? "Compaction snapshot" : "Historical rollout",
        provenance: item.provenance?.level ?? "historical_rollout",
        sourceKey: item.provenance?.sourceKey ?? null,
        itemCount: 0,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
    group.itemCount += 1;
  }
  return groups.map(({ key: _key, ...group }) => group);
}

function markBoundedTruncation(state, sourceKey) {
  state.truncated = true;
  state.fullyObservedFromThreadStart = false;
  addGap(state, { reason: "partial_bounded_truncation", sourceKey, rebasable: true });
}

function addGap(state, gap) {
  const exists = state.gaps.some((candidate) =>
    candidate.reason === gap.reason && candidate.sourceKey === gap.sourceKey,
  );
  if (!exists) state.gaps.push(gap);
}

function resolveRolloutCoverage(state, cut, currentContent) {
  const reasons = state.gaps.map((gap) => gap.reason);
  if (!currentContent?.available) return "unavailable";
  if (reasons.includes("partial_compaction_snapshot_unavailable")) return "partial_compaction_snapshot_unavailable";
  if (reasons.includes("source_missing")) return "partial_source_missing";
  if (reasons.includes("partial_unsupported_shape")) return "partial_unsupported_shape";
  if (reasons.includes("partial_bounded_truncation")) return "partial_bounded_truncation";
  if (cut.status !== "observed") return "current_cut_unavailable";
  return state.fullyObservedFromThreadStart ? "complete_observed_history" : "partial";
}

function describeArguments(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return describeStructured(parsed);
    } catch {
      return value;
    }
  }
  return describeStructured(value);
}

function describeStructured(value, depth = 0) {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    if (value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) return value.map(String).join(" · ");
    return `Structured list · ${value.length} items`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (depth >= 2) return `Structured value · ${keys.length} fields`;
    const entries = Object.entries(value).slice(0, 8).map(
      ([key, entry]) => `${key}: ${describeStructured(entry, depth + 1)}`,
    );
    return entries.join("\n");
  }
  return String(value);
}

function outputText(value) {
  if (typeof value === "string") return value;
  return describeStructured(value);
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (!["input_text", "output_text", "text"].includes(part.type)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

function toolName(payload) {
  const name = typeof payload.name === "string" && payload.name ? payload.name : "unknown_tool";
  const namespace = typeof payload.namespace === "string" && payload.namespace ? payload.namespace : null;
  return namespace ? `${namespace}.${name}` : name;
}

function normalizeRole(value) {
  return typeof value === "string" && value ? value : "unknown";
}

function boundText(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit
    ? { text, truncated: false }
    : { text: text.slice(0, limit), truncated: true };
}

function itemBodyCharacters(item) {
  let total = typeof item?.text === "string" ? item.text.length : 0;
  if (Array.isArray(item?.fields)) {
    for (const field of item.fields) total += typeof field?.value === "string" ? field.value.length : 0;
  }
  return total;
}

function bodyCharacters(items) {
  return items.reduce((sum, item) => sum + itemBodyCharacters(item), 0);
}

function lineCount(value) {
  if (!value) return 0;
  return String(value).split(/\r?\n/u).length;
}

function parseRecord(buffer) {
  if (!buffer?.length) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function stripCr(buffer) {
  return buffer.length && buffer.at(-1) === 0x0d ? buffer.subarray(0, -1) : buffer;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

function normalizeLimits(limits) {
  const result = { ...REQUEST_INPUT_CONTEXT_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(REQUEST_INPUT_CONTEXT_LIMITS)) {
    if (!finitePositiveInteger(result[key])) throw new RangeError(`${key} must be a positive integer`);
  }
  return result;
}

function finitePositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function emptySummary() {
  return {
    itemCount: 0,
    visibleCharacters: 0,
    sourceSegmentCount: 0,
    missingSourceCount: 0,
    compactionCount: 0,
    supersededItemCount: 0,
    truncatedItemCount: 0,
    historyScanBytes: 0,
  };
}
