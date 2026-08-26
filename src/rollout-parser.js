import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { recoverLegacySourceKey } from "./source-locator.js";
import {
  addUsage,
  classifyModelUsageEvent,
  normalizeRateLimits,
  normalizeTimestamp,
  normalizeUsage,
  subtractUsage,
  sumTaskUsage,
  usageEquals,
  zeroUsage,
} from "./usage.js";

const START_EVENTS = new Set(["task_started", "turn_started"]);
const COMPLETE_EVENTS = new Set(["task_complete", "turn_complete", "turn_completed"]);
const ABORT_EVENTS = new Set([
  "task_aborted",
  "turn_aborted",
  "task_interrupted",
  "turn_interrupted",
  "task_cancelled",
  "turn_cancelled",
]);
const KNOWN_RECORD_TYPES = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);
const IGNORED_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "item_completed",
  "mcp_tool_call_end",
  "sub_agent_activity",
  "thread_settings_applied",
]);

export class SessionRolloutParser {
  constructor(rootSessionId, sessionMetadata = {}) {
    this.rootSessionId = rootSessionId;
    this.sessionMetadata = sessionMetadata;
    this.threads = new Map();
    this.fileContexts = new Map();
    this.quotaStates = new Map();
    this.health = {
      invalidLines: 0,
      unknownRecords: 0,
      skippedRecords: 0,
      discontinuities: 0,
      partialBytes: 0,
      files: 0,
      restoredFiles: 0,
      replayedFiles: 0,
      cliVersions: new Set(),
    };
  }

  async parseFiles(entries) {
    const sorted = [...entries].sort(compareEntries);
    this.health.replayedFiles = sorted.length;
    for (const entry of sorted) await this.parseFile(entry, { reset: true });
    return this.snapshot();
  }

  async restore(storedSnapshot = {}, cursors = [], entries = []) {
    this.threads.clear();
    this.fileContexts.clear();
    this.quotaStates.clear();
    this.health.invalidLines = 0;
    this.health.unknownRecords = 0;
    this.health.skippedRecords = 0;
    this.health.discontinuities = 0;
    this.health.partialBytes = 0;
    this.health.files = 0;
    this.health.restoredFiles = 0;
    this.health.replayedFiles = 0;
    this.health.cliVersions.clear();
    this.sessionMetadata = { ...(storedSnapshot.session ?? {}), ...this.sessionMetadata };

    const sortedEntries = [...entries].sort(compareEntries);
    const cursorsBySource = new Map(cursors.map((cursor) => [cursorIdentity(cursor), cursor]));
    const validationBySource = new Map();
    const replayThreadIds = new Set();
    for (const entry of sortedEntries) {
      const sourceIdentity = entryIdentity(entry);
      const cursor = cursorsBySource.get(sourceIdentity);
      const usable = await isCursorUsable(cursor, entry);
      validationBySource.set(sourceIdentity, usable);
      if (!usable) replayThreadIds.add(entryThreadId(entry));
    }

    const replayPaths = [];
    const restoredPaths = [];
    for (const entry of sortedEntries) {
      if (!validationBySource.get(entryIdentity(entry)) || replayThreadIds.has(entryThreadId(entry))) {
        replayPaths.push(entry.path);
      } else {
        restoredPaths.push(entry.path);
      }
    }

    const entriesByThread = new Map(
      sortedEntries.map((entry) => [entryThreadId(entry), entry]),
    );
    const currentSources = new Set(sortedEntries.map((entry) => entryIdentity(entry)));
    const tasksByThread = new Map();
    for (const storedTask of storedSnapshot.tasks ?? []) {
      const list = tasksByThread.get(storedTask.threadId) ?? [];
      list.push(storedTask);
      tasksByThread.set(storedTask.threadId, list);
    }

    for (const storedAgent of storedSnapshot.agents ?? []) {
      if (replayThreadIds.has(storedAgent.threadId)) continue;
      const entry = entriesByThread.get(storedAgent.threadId);
      const source = parseMaybeJson(entry?.meta?.source ?? entry?.source);
      const storedTasks = (tasksByThread.get(storedAgent.threadId) ?? [])
        .slice()
        .sort((left, right) => left.sequence - right.sequence);
      const taskMap = new Map();
      let sequence = 0;
      let currentTaskId = null;
      let lastUsage = null;
      for (const storedTask of storedTasks) {
        const task = restoreTask(storedTask, entry);
        taskMap.set(task.turnId, task);
        sequence = Math.max(sequence, task.sequence);
        if (task.status === "in_progress") currentTaskId = task.turnId;
        const latestUsage = task.endUsage ?? task.baselineUsage;
        if (latestUsage) lastUsage = structuredClone(latestUsage);
      }
      const isRoot = Boolean(storedAgent.isRoot);
      const firstBaseline = storedTasks[0]?.baselineUsage ?? null;
      const thread = {
        rootSessionId: storedAgent.rootSessionId ?? this.rootSessionId,
        threadId: storedAgent.threadId,
        parentThreadId: storedAgent.parentThreadId ?? null,
        depth: numberOrNull(storedAgent.depth) ?? (isRoot ? 0 : 1),
        nickname: storedAgent.nickname ?? null,
        role: storedAgent.role ?? null,
        agentPath: storedAgent.agentPath ?? null,
        rolloutKey:
          storedAgent.rolloutKey ??
          entry?.sourceKey ??
          recoverLegacySourceKey(storedAgent.rolloutPath),
        rolloutPath: entry?.path ?? null,
        isRoot,
        cliVersion: storedAgent.cliVersion ?? null,
        firstSeenAt: normalizeTimestamp(storedAgent.firstSeenAt),
        lastSeenAt: normalizeTimestamp(storedAgent.lastSeenAt, storedAgent.firstSeenAt),
        tasks: taskMap,
        sequence,
        currentTaskId,
        lastUsage,
        safeZeroBaseline:
          isRoot ||
          Boolean(source?.subagent?.thread_spawn) ||
          usageEquals(firstBaseline, zeroUsage()),
      };
      if (thread.cliVersion) this.health.cliVersions.add(thread.cliVersion);
      this.threads.set(thread.threadId, thread);
    }

    for (const entry of sortedEntries) {
      if (!restoredPaths.includes(entry.path)) continue;
      const cursor = cursorsBySource.get(entryIdentity(entry));
      const context = {
        path: entry.path,
        sourceKey: entry.sourceKey ?? cursorIdentity(cursor),
        threadId: cursor.threadId ?? entryThreadId(entry),
        historyStartOrdinal: numberOrNull(entry.meta?.subagent_history_start_ordinal),
        byteOffset: cursor.byteOffset,
        lineNumber: cursor.lineNumber,
        lastOrdinal: numberOrNull(cursor.lastOrdinal),
        invalidLines: numberOrNull(cursor.invalidLines) ?? 0,
        partialBytes: numberOrNull(cursor.partialBytes) ?? 0,
        unknownRecords: numberOrNull(cursor.unknownRecords) ?? 0,
        skippedRecords: numberOrNull(cursor.skippedRecords) ?? 0,
        discontinuities: numberOrNull(cursor.discontinuities) ?? 0,
        lastUsage: normalizeUsage(cursor.lastUsage),
        fileSize: cursor.fileSize,
        modifiedAtMs: cursor.modifiedAtMs,
        firstMetaSeen: true,
      };
      this.fileContexts.set(entry.path, context);
      this.health.invalidLines += context.invalidLines;
      this.health.partialBytes += context.partialBytes;
      this.health.unknownRecords += context.unknownRecords;
      this.health.skippedRecords += context.skippedRecords;
      this.health.discontinuities += context.discontinuities;
      const thread = this.threads.get(context.threadId);
      if (thread && context.lastUsage) thread.lastUsage = structuredClone(context.lastUsage);
    }
    for (const cursor of cursors) {
      if (currentSources.has(cursorIdentity(cursor)) || replayThreadIds.has(cursor.threadId)) continue;
      this.health.unknownRecords += numberOrNull(cursor.unknownRecords) ?? 0;
      this.health.skippedRecords += numberOrNull(cursor.skippedRecords) ?? 0;
      this.health.discontinuities += numberOrNull(cursor.discontinuities) ?? 0;
    }
    this.health.files = this.fileContexts.size;
    this.health.restoredFiles = restoredPaths.length;
    this.health.replayedFiles = replayPaths.length;
    return { restoredPaths, replayPaths };
  }

  async tailFile(entry) {
    const context = this.fileContexts.get(entry.path);
    if (!context) {
      await this.parseFile(entry, { reset: true });
      return { rebuilt: false, changed: true };
    }
    const fileStat = await stat(entry.path);
    if (fileStat.size < context.byteOffset) return { rebuilt: true, changed: false };
    if (fileStat.size === context.byteOffset) return { rebuilt: false, changed: false };
    await this.parseFile(entry, { reset: false });
    return { rebuilt: false, changed: true };
  }

  async parseFile(entry, { reset }) {
    let context = this.fileContexts.get(entry.path);
    if (!context || reset) {
      context = {
        path: entry.path,
        sourceKey: entry.sourceKey ?? entry.path,
        threadId: entry.threadId ?? entry.meta?.id ?? null,
        historyStartOrdinal: numberOrNull(entry.meta?.subagent_history_start_ordinal),
        byteOffset: 0,
        lineNumber: 0,
        lastOrdinal: null,
        invalidLines: 0,
        partialBytes: 0,
        unknownRecords: 0,
        skippedRecords: 0,
        discontinuities: 0,
        lastUsage: null,
        fileSize: 0,
        modifiedAtMs: null,
        firstMetaSeen: false,
      };
      this.fileContexts.set(entry.path, context);
      this.health.files = this.fileContexts.size;
    }

    const result = await readCompleteJsonLines(
      entry.path,
      context.byteOffset,
      context.lineNumber,
      ({ record, lineNumber, lineStartOffset, lineEndOffset }) => {
        this.processRecord(entry, context, record, {
          lineNumber,
          lineStartOffset,
          lineEndOffset,
        });
      },
    );

    context.byteOffset = result.byteOffset;
    context.lineNumber = result.lineNumber;
    context.fileSize = result.fileSize;
    context.modifiedAtMs = result.modifiedAtMs;
    context.partialBytes = result.partialBytes;
    context.invalidLines += result.invalidLines;
    this.health.invalidLines += result.invalidLines;
    this.health.partialBytes = [...this.fileContexts.values()].reduce(
      (total, item) => total + item.partialBytes,
      0,
    );
  }

  processRecord(entry, context, record, position) {
    const payload = record?.payload ?? {};
    const ordinal = numberOrNull(record?.ordinal);
    if (ordinal != null) context.lastOrdinal = ordinal;

    if (record?.type === "session_meta" && !context.firstMetaSeen) {
      context.firstMetaSeen = true;
      context.threadId = payload.id ?? context.threadId;
      context.historyStartOrdinal = numberOrNull(payload.subagent_history_start_ordinal);
      this.ensureThread(entry, payload, record.timestamp);
      return;
    }

    if (
      context.historyStartOrdinal != null &&
      ordinal != null &&
      ordinal < context.historyStartOrdinal
    ) {
      return;
    }

    const thread = this.ensureThread(entry, entry.meta ?? {}, record?.timestamp);
    thread.lastSeenAt = normalizeTimestamp(record?.timestamp, thread.lastSeenAt);

    if (record?.type === "turn_context") {
      if (!this.applyTurnContext(thread, payload)) this.countSkipped(context);
      return;
    }

    if (record?.type !== "event_msg") {
      if (!KNOWN_RECORD_TYPES.has(record?.type)) {
        if (typeof record?.type === "string") this.countUnknown(context);
        else this.countSkipped(context);
      }
      return;
    }
    const eventType = payload.type;
    if (typeof eventType !== "string") {
      this.countSkipped(context);
      return;
    }
    if (START_EVENTS.has(eventType)) {
      this.startTask(
        thread,
        payload,
        record,
        position,
        entry.path,
        entry.sourceKey ?? entry.path,
        ordinal,
        context,
      );
      return;
    }
    if (COMPLETE_EVENTS.has(eventType)) {
      this.completeTask(thread, payload, record, position, ordinal, "completed", context);
      return;
    }
    if (ABORT_EVENTS.has(eventType)) {
      this.completeTask(thread, payload, record, position, ordinal, "interrupted", context);
      return;
    }
    if (eventType === "token_count") {
      this.applyTokenCount(
        thread,
        payload,
        record,
        position,
        ordinal,
        entry.path,
        entry.sourceKey ?? entry.path,
        context,
      );
      return;
    }
    if (!IGNORED_EVENT_TYPES.has(eventType)) this.countUnknown(context);
  }

  countUnknown(context) {
    context.unknownRecords = (context.unknownRecords ?? 0) + 1;
    this.health.unknownRecords += 1;
  }

  countSkipped(context) {
    context.skippedRecords = (context.skippedRecords ?? 0) + 1;
    this.health.skippedRecords += 1;
  }

  ensureThread(entry, meta, timestamp) {
    const threadId = meta.id ?? entry.threadId;
    if (!threadId) throw new Error(`Rollout has no thread id: ${entry.path}`);
    let thread = this.threads.get(threadId);
    if (thread) return thread;

    const source = parseMaybeJson(meta.source ?? entry.source);
    const subagent = extractSubagent(source);
    const rootSessionId = meta.session_id ?? entry.rootSessionId ?? this.rootSessionId;
    const parentThreadId =
      meta.parent_thread_id ??
      subagent?.parent_thread_id ??
      entry.parentThreadId ??
      null;
    const isRoot = threadId === rootSessionId;
    const firstSeenAt = normalizeTimestamp(meta.timestamp ?? timestamp ?? entry.createdAt);
    const cliVersion = meta.cli_version ?? entry.cliVersion ?? null;
    if (cliVersion) this.health.cliVersions.add(cliVersion);

    thread = {
      rootSessionId,
      threadId,
      parentThreadId,
      depth: numberOrNull(subagent?.depth ?? entry.depth) ?? (isRoot ? 0 : 1),
      nickname: meta.agent_nickname ?? subagent?.agent_nickname ?? entry.nickname ?? null,
      role: meta.agent_role ?? subagent?.agent_role ?? entry.role ?? null,
      agentPath: meta.agent_path ?? subagent?.agent_path ?? entry.agentPath ?? null,
      rolloutKey: entry.sourceKey ?? recoverLegacySourceKey(entry.path),
      rolloutPath: entry.path,
      isRoot,
      cliVersion,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      tasks: new Map(),
      sequence: 0,
      currentTaskId: null,
      lastUsage: null,
      safeZeroBaseline: isRoot || Boolean(source?.subagent?.thread_spawn),
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  startTask(thread, payload, record, position, sourcePath, sourceKey, ordinal, context) {
    const turnId = payload.turn_id ?? payload.turnId ?? payload.id;
    if (!turnId) {
      this.countSkipped(context);
      return;
    }

    const previous = thread.currentTaskId ? thread.tasks.get(thread.currentTaskId) : null;
    if (previous && previous.turnId !== turnId && previous.status === "in_progress") {
      previous.status = "interrupted";
      previous.completedAt = normalizeTimestamp(record.timestamp);
      previous.endLine = Math.max(previous.startLine, position.lineNumber - 1);
      previous.endByte = position.lineStartOffset;
    }

    let task = thread.tasks.get(turnId);
    if (!task) {
      thread.sequence += 1;
      const baseline = thread.lastUsage
        ? structuredClone(thread.lastUsage)
        : thread.tasks.size === 0 && thread.safeZeroBaseline
          ? zeroUsage()
          : null;
      task = {
        rootSessionId: this.rootSessionId,
        threadId: thread.threadId,
        turnId,
        sequence: thread.sequence,
        status: "in_progress",
        startedAt: normalizeTimestamp(payload.started_at ?? payload.startedAt, record.timestamp),
        completedAt: null,
        durationMs: null,
        model: null,
        effort: null,
        baselineUsage: baseline,
        endUsage: null,
        deltaUsage: null,
        quality: baseline ? "unknown" : "partial",
        sourceKey,
        sourcePath,
        startOrdinal: ordinal,
        endOrdinal: null,
        startLine: position.lineNumber,
        endLine: null,
        startByte: position.lineStartOffset,
        endByte: null,
        sawUsage: false,
        discontinuity: false,
      };
      thread.tasks.set(turnId, task);
    } else {
      task.status = "in_progress";
    }
    thread.currentTaskId = turnId;
  }

  applyTurnContext(thread, payload) {
    const turnId = payload.turn_id ?? payload.turnId ?? thread.currentTaskId;
    const task = turnId ? thread.tasks.get(turnId) : null;
    if (!task) return false;
    task.model = payload.model ?? task.model;
    task.effort = payload.effort ?? task.effort;
    return true;
  }

  applyTokenCount(thread, payload, record, position, ordinal, sourcePath, sourceKey, context) {
    const quota = normalizeRateLimits(payload.rate_limits, record.timestamp, sourcePath);
    if (quota) {
      quota.sourceKey = sourceKey;
      delete quota.sourcePath;
      this.recordQuota(quota);
    }

    const usage = normalizeUsage(payload.info?.total_token_usage);
    if (!usage) return;
    const lastUsage = normalizeUsage(payload.info?.last_token_usage);
    const usageEvent = classifyModelUsageEvent(thread.lastUsage, usage, lastUsage);
    context.lastUsage = structuredClone(usage);
    const task = thread.currentTaskId ? thread.tasks.get(thread.currentTaskId) : null;
    if (usageEvent.classification === "duplicate") {
      if (task) {
        task.sawUsage = true;
        task.endUsage = structuredClone(usage);
        task.endOrdinal = ordinal;
        task.endLine = position.lineNumber;
        task.endByte = position.lineEndOffset;
      }
      return;
    }

    if (
      usageEvent.classification === "anomaly" &&
      usageEvent.rollbackFields.length > 0
    ) {
      this.health.discontinuities += 1;
      context.discontinuities = (context.discontinuities ?? 0) + 1;
      if (task) task.discontinuity = true;
    }
    thread.lastUsage = structuredClone(usage);
    if (task) {
      task.sawUsage = true;
      task.endUsage = structuredClone(usage);
      task.endOrdinal = ordinal;
      task.endLine = position.lineNumber;
      task.endByte = position.lineEndOffset;
    }
  }

  completeTask(thread, payload, record, position, ordinal, status, context) {
    const turnId = payload.turn_id ?? payload.turnId ?? thread.currentTaskId;
    if (!turnId) {
      this.countSkipped(context);
      return;
    }
    let task = thread.tasks.get(turnId);
    if (!task) {
      thread.sequence += 1;
      task = {
        rootSessionId: this.rootSessionId,
        threadId: thread.threadId,
        turnId,
        sequence: thread.sequence,
        status,
        startedAt: normalizeTimestamp(payload.started_at ?? payload.startedAt),
        completedAt: null,
        durationMs: null,
        model: null,
        effort: null,
        baselineUsage: null,
        endUsage: null,
        deltaUsage: null,
        quality: "partial",
        sourceKey: thread.rolloutKey,
        sourcePath: thread.rolloutPath,
        startOrdinal: null,
        endOrdinal: ordinal,
        startLine: position.lineNumber,
        endLine: position.lineNumber,
        startByte: position.lineStartOffset,
        endByte: position.lineEndOffset,
        sawUsage: false,
        discontinuity: false,
      };
      thread.tasks.set(turnId, task);
    }
    task.status = status;
    task.completedAt = normalizeTimestamp(
      payload.completed_at ?? payload.completedAt,
      record.timestamp,
    );
    task.startedAt = task.startedAt ?? normalizeTimestamp(payload.started_at ?? payload.startedAt);
    task.durationMs = numberOrNull(payload.duration_ms ?? payload.durationMs);
    task.endOrdinal = ordinal ?? task.endOrdinal;
    task.endLine = position.lineNumber;
    task.endByte = position.lineEndOffset;
    if (thread.currentTaskId === turnId) thread.currentTaskId = null;
  }

  recordQuota(quota) {
    const key = JSON.stringify({
      id: quota.limitId,
      primary: quota.primary,
      secondary: quota.secondary,
      plan: quota.planType,
    });
    const previous = this.quotaStates.get(key);
    if (!previous || previous.observedAt < quota.observedAt) this.quotaStates.set(key, quota);
  }

  snapshot() {
    const tasks = [];
    const agents = [];
    for (const thread of this.threads.values()) {
      const threadTasks = [...thread.tasks.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map((task) => materializeTask(task));
      tasks.push(...threadTasks);
      agents.push({
        rootSessionId: this.rootSessionId,
        threadId: thread.threadId,
        parentThreadId: thread.parentThreadId,
        depth: thread.depth,
        nickname: thread.nickname,
        role: thread.role,
        agentPath: thread.agentPath,
        rolloutKey: thread.rolloutKey,
        rolloutPath: thread.rolloutPath,
        isRoot: thread.isRoot,
        cliVersion: thread.cliVersion,
        firstSeenAt: thread.firstSeenAt,
        lastSeenAt: thread.lastSeenAt,
        ownUsage: sumTaskUsage(threadTasks),
        subtreeUsage: zeroUsage(),
        taskCount: threadTasks.length,
      });
    }

    computeSubtreeUsage(agents);
    const cursors = [...this.fileContexts.values()].map((context) => ({
      sourceKey: context.sourceKey,
      threadId: context.threadId,
      byteOffset: context.byteOffset,
      fileSize: context.fileSize,
      modifiedAtMs: context.modifiedAtMs,
      lineNumber: context.lineNumber,
      lastOrdinal: context.lastOrdinal,
      invalidLines: context.invalidLines,
      partialBytes: context.partialBytes,
      unknownRecords: context.unknownRecords ?? 0,
      skippedRecords: context.skippedRecords ?? 0,
      discontinuities: context.discontinuities ?? 0,
      lastUsage: context.lastUsage ? structuredClone(context.lastUsage) : null,
    }));
    const warningCount =
      this.health.invalidLines +
      this.health.unknownRecords +
      this.health.skippedRecords +
      this.health.discontinuities +
      this.health.partialBytes;
    return {
      session: this.sessionMetadata,
      agents: agents.sort((a, b) => a.depth - b.depth || compareText(a.threadId, b.threadId)),
      tasks: tasks.sort(
        (a, b) => compareText(a.threadId, b.threadId) || a.sequence - b.sequence,
      ),
      quotas: [...this.quotaStates.values()].sort((a, b) =>
        compareText(a.observedAt, b.observedAt),
      ),
      cursors,
      health: {
        status: warningCount ? "warning" : "healthy",
        invalidLines: this.health.invalidLines,
        unknownRecords: this.health.unknownRecords,
        skippedRecords: this.health.skippedRecords,
        discontinuities: this.health.discontinuities,
        partialBytes: this.health.partialBytes,
        files: this.health.files,
        restoredFiles: this.health.restoredFiles,
        replayedFiles: this.health.replayedFiles,
        cliVersions: [...this.health.cliVersions].sort(),
      },
    };
  }
}

export async function scanRolloutMetadata(filePath) {
  const line = await readFirstCompleteLine(filePath);
  if (!line) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record.type !== "session_meta" || !record.payload?.id) return null;
  const fileStat = await stat(filePath);
  return {
    meta: record.payload,
    envelopeTimestamp: normalizeTimestamp(record.timestamp),
    fileSize: fileStat.size,
    modifiedAtMs: fileStat.mtimeMs,
  };
}

export async function scanLatestQuota(filePath, maxBytes = 2 * 1024 * 1024, sourceKey = null) {
  const fileStat = await stat(filePath);
  const start = Math.max(0, fileStat.size - maxBytes);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(fileStat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(line);
        const payload = record.payload ?? {};
        if (record.type === "event_msg" && payload.type === "token_count") {
          const quota = normalizeRateLimits(payload.rate_limits, record.timestamp, filePath);
          if (quota) {
            if (sourceKey) {
              quota.sourceKey = sourceKey;
              delete quota.sourcePath;
            }
            return quota;
          }
        }
      } catch {
        // The first line can be partial because the tail starts mid-record.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function readTaskPreview(task, maxCharacters = 120) {
  if (!task?.sourcePath || task.startByte == null) {
    return { available: false, text: null, reason: "原始任务位置不可用" };
  }
  try {
    const fileStat = await stat(task.sourcePath);
    if (task.startByte >= fileStat.size) {
      return { available: false, text: null, reason: "原始日志已变更" };
    }
    const metadata = await scanRolloutMetadata(task.sourcePath);
    const route = parentInstructionRoute(metadata?.meta, task);
    if (!route) {
      return { available: false, text: null, reason: "无法确认该任务的父子代理路由" };
    }
    const end = Math.min(fileStat.size - 1, task.startByte + 2 * 1024 * 1024);
    const stream = createReadStream(task.sourcePath, { start: task.startByte, end });
    let pending = Buffer.alloc(0);
    let linesSeen = 0;
    let fallback = null;
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const rawLine = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        linesSeen += 1;
        if (linesSeen > 80) return previewResult(fallback, maxCharacters);
        let record;
        try {
          record = JSON.parse(stripCarriageReturn(rawLine).toString("utf8"));
        } catch {
          continue;
        }
        const payload = record.payload ?? {};
        if (
          linesSeen > 1 &&
          record.type === "event_msg" &&
          START_EVENTS.has(payload.type)
        ) {
          return previewResult(fallback, maxCharacters);
        }
        if (record.type !== "response_item") continue;
        const text = extractInputText(payload);
        if (!text) continue;
        if (
          payload.type === "agent_message" &&
          payload.author === route.parentPath &&
          payload.recipient === route.childPath &&
          isParentInstructionEnvelope(text, route.parentPath)
        ) {
          const routed = previewResult(text, maxCharacters);
          if (routed.available) return routed;
        }
        if (
          payload.type === "message" &&
          payload.role === "user" &&
          !fallback &&
          isParentInstructionEnvelope(text, route.parentPath)
        ) {
          fallback = text;
        }
      }
    }
    return previewResult(fallback, maxCharacters);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false, text: null, reason: "原始日志已不存在" };
    }
    return { available: false, text: null, reason: "无法读取原始任务" };
  }
}

export async function readCompleteJsonLines(filePath, startOffset, initialLineNumber, onRecord) {
  const fileStat = await stat(filePath);
  if (fileStat.size < startOffset) {
    return {
      byteOffset: 0,
      lineNumber: 0,
      fileSize: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
      partialBytes: 0,
      invalidLines: 0,
    };
  }
  if (fileStat.size === startOffset) {
    return {
      byteOffset: startOffset,
      lineNumber: initialLineNumber,
      fileSize: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
      partialBytes: 0,
      invalidLines: 0,
    };
  }

  const stream = createReadStream(filePath, { start: startOffset });
  let pending = Buffer.alloc(0);
  let byteOffset = startOffset;
  let lineNumber = initialLineNumber;
  let invalidLines = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const rawLine = stripCarriageReturn(pending.subarray(0, newline));
      const lineStartOffset = byteOffset;
      const lineEndOffset = byteOffset + newline + 1;
      pending = pending.subarray(newline + 1);
      byteOffset = lineEndOffset;
      lineNumber += 1;
      if (!rawLine.length) continue;
      try {
        onRecord({
          record: JSON.parse(rawLine.toString("utf8")),
          lineNumber,
          lineStartOffset,
          lineEndOffset,
        });
      } catch {
        invalidLines += 1;
      }
    }
  }
  return {
    byteOffset,
    lineNumber,
    fileSize: fileStat.size,
    modifiedAtMs: fileStat.mtimeMs,
    partialBytes: pending.length,
    invalidLines,
  };
}

function materializeTask(task) {
  const active = task.status === "in_progress";
  const result = subtractUsage(task.baselineUsage, task.sawUsage ? task.endUsage : null, {
    active,
    discontinuity: task.discontinuity,
  });
  return {
    rootSessionId: task.rootSessionId,
    threadId: task.threadId,
    turnId: task.turnId,
    sequence: task.sequence,
    status: task.status,
    quality: result.quality,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    durationMs: task.durationMs,
    model: task.model,
    effort: task.effort,
    baselineUsage: task.baselineUsage,
    endUsage: task.sawUsage ? task.endUsage : null,
    deltaUsage: result.delta,
    sourceKey: task.sourceKey,
    sourcePath: task.sourcePath,
    startOrdinal: task.startOrdinal,
    endOrdinal: task.endOrdinal,
    startLine: task.startLine,
    endLine: task.endLine,
    startByte: task.startByte,
    endByte: task.endByte,
  };
}

function restoreTask(storedTask, entry = null) {
  return {
    rootSessionId: storedTask.rootSessionId,
    threadId: storedTask.threadId,
    turnId: storedTask.turnId,
    sequence: numberOrNull(storedTask.sequence) ?? 0,
    status: storedTask.status,
    startedAt: storedTask.startedAt ?? null,
    completedAt: storedTask.completedAt ?? null,
    durationMs: numberOrNull(storedTask.durationMs),
    model: storedTask.model ?? null,
    effort: storedTask.effort ?? null,
    baselineUsage: storedTask.baselineUsage
      ? structuredClone(storedTask.baselineUsage)
      : null,
    endUsage: storedTask.endUsage ? structuredClone(storedTask.endUsage) : null,
    deltaUsage: storedTask.deltaUsage ? structuredClone(storedTask.deltaUsage) : null,
    quality: storedTask.quality ?? "unknown",
    sourceKey:
      storedTask.sourceKey ??
      entry?.sourceKey ??
      recoverLegacySourceKey(storedTask.sourcePath),
    sourcePath: entry?.path ?? null,
    startOrdinal: numberOrNull(storedTask.startOrdinal),
    endOrdinal: numberOrNull(storedTask.endOrdinal),
    startLine: numberOrNull(storedTask.startLine),
    endLine: numberOrNull(storedTask.endLine),
    startByte: numberOrNull(storedTask.startByte),
    endByte: numberOrNull(storedTask.endByte),
    sawUsage: Boolean(storedTask.endUsage),
    discontinuity: storedTask.quality === "discontinuity",
  };
}

function computeSubtreeUsage(agents) {
  const byId = new Map(agents.map((agent) => [agent.threadId, agent]));
  const children = new Map();
  for (const agent of agents) {
    if (!agent.parentThreadId || !byId.has(agent.parentThreadId)) continue;
    const list = children.get(agent.parentThreadId) ?? [];
    list.push(agent.threadId);
    children.set(agent.parentThreadId, list);
  }
  const visiting = new Set();
  const calculate = (threadId) => {
    const agent = byId.get(threadId);
    if (!agent) return zeroUsage();
    if (visiting.has(threadId)) return agent.ownUsage;
    visiting.add(threadId);
    let total = agent.ownUsage;
    for (const childId of children.get(threadId) ?? []) total = addUsage(total, calculate(childId));
    visiting.delete(threadId);
    agent.subtreeUsage = total;
    return total;
  };
  for (const agent of agents) calculate(agent.threadId);
}

function extractSubagent(source) {
  const subagent = source?.subagent;
  if (!subagent || typeof subagent !== "object") return null;
  for (const value of Object.values(subagent)) {
    if (value && typeof value === "object") return value;
  }
  return null;
}

function extractInputText(payload) {
  const parts = Array.isArray(payload.content) ? payload.content : [];
  return parts
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parentInstructionRoute(meta, task) {
  if (!meta?.id || meta.id !== task.threadId) return null;
  const source = parseMaybeJson(meta.source);
  const subagent = extractSubagent(source);
  const childPath = meta.agent_path ?? subagent?.agent_path;
  if (typeof childPath !== "string" || !childPath.startsWith("/")) return null;
  const separator = childPath.lastIndexOf("/");
  if (separator <= 0) return null;
  const parentPath = childPath.slice(0, separator);
  return { childPath, parentPath };
}

function isParentInstructionEnvelope(text, parentPath) {
  const header = text.slice(0, 4_096);
  const type = header.match(/^Message Type:\s*([^\r\n]+)\s*$/mu)?.[1];
  const sender = header.match(/^Sender:\s*([^\r\n]+)\s*$/mu)?.[1];
  return (
    new Set(["NEW_TASK", "MESSAGE", "FOLLOWUP_TASK"]).has(type) &&
    sender === parentPath &&
    /^Task name:\s*\S+/mu.test(header) &&
    /^Payload:\s*$/mu.test(header)
  );
}

function previewResult(text, maxCharacters) {
  if (!text) return { available: false, text: null, reason: "该任务没有可显示的本地指令" };
  let normalized = text.replace(/\s+/gu, " ").trim();
  const payloadMarker = normalized.match(/\bPayload:\s*/u);
  if (payloadMarker && payloadMarker.index < 320) {
    normalized = normalized.slice(payloadMarker.index + payloadMarker[0].length).trim();
  }
  if (!normalized) {
    return { available: false, text: null, reason: "该任务的父代理指令未持久化" };
  }
  const characters = [...normalized];
  return {
    available: true,
    text: characters.length > maxCharacters
      ? `${characters.slice(0, maxCharacters).join("")}…`
      : normalized,
    reason: null,
  };
}

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { kind: value };
  }
}

async function isCursorUsable(cursor, entry) {
  const filePath = entry.path;
  if (!cursor || cursorIdentity(cursor) !== entryIdentity(entry)) return false;
  if (
    !isNonNegativeNumber(cursor.byteOffset) ||
    !isNonNegativeNumber(cursor.fileSize) ||
    !isNonNegativeNumber(cursor.lineNumber) ||
    !Number.isFinite(cursor.modifiedAtMs) ||
    (cursor.byteOffset > 0 && cursor.lineNumber === 0) ||
    (cursor.byteOffset > 0 && !normalizeUsage(cursor.lastUsage))
  ) {
    return false;
  }
  try {
    const fileStat = await stat(filePath);
    return (
      fileStat.size >= cursor.fileSize &&
      fileStat.size >= cursor.byteOffset &&
      fileStat.mtimeMs + 2 >= cursor.modifiedAtMs
    );
  } catch {
    return false;
  }
}

function entryIdentity(entry) {
  return entry?.sourceKey ?? entry?.path ?? null;
}

function cursorIdentity(cursor) {
  return cursor?.sourceKey ?? cursor?.path ?? null;
}

function entryThreadId(entry) {
  return entry.threadId ?? entry.meta?.id ?? null;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stripCarriageReturn(buffer) {
  return buffer.length && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, buffer.length - 1)
    : buffer;
}

async function readFirstCompleteLine(filePath) {
  const handle = await open(filePath, "r");
  try {
    const chunks = [];
    let position = 0;
    while (position < 8 * 1024 * 1024) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        return stripCarriageReturn(Buffer.concat(chunks)).toString("utf8");
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    return chunks.length ? stripCarriageReturn(Buffer.concat(chunks)).toString("utf8") : null;
  } finally {
    await handle.close();
  }
}

function compareEntries(left, right) {
  const leftTime = left.meta?.timestamp ?? left.envelopeTimestamp ?? left.createdAt ?? "";
  const rightTime = right.meta?.timestamp ?? right.envelopeTimestamp ?? right.createdAt ?? "";
  return compareText(leftTime, rightTime) || compareText(left.path, right.path);
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
