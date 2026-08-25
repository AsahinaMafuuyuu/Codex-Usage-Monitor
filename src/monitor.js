import { EventEmitter } from "node:events";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  combineCostSummaries,
  estimateTaskCost,
  pricingCatalogSummary,
  summarizeTaskCosts,
} from "./pricing.js";
import {
  readTaskPreview,
  scanLatestQuota,
  SessionRolloutParser,
} from "./rollout-parser.js";
import { addUsage, zeroUsage } from "./usage.js";

const QUALITY_KEYS = [
  "complete",
  "provisional",
  "estimated",
  "partial",
  "discontinuity",
  "unknown",
];

export class UsageMonitor extends EventEmitter {
  constructor({ repository, database }) {
    super();
    this.repository = repository;
    this.database = database;
    this.selectedSessionId = null;
    this.parser = null;
    this.selectedEntries = [];
    this.selectionPromise = null;
    this.watchers = [];
    this.pendingPaths = new Set();
    this.pendingTimer = null;
    this.pollTimer = null;
    this.reconcileTimer = null;
    this.lastUpdateAt = null;
    this.lastErrors = [];
    this.timelineCache = null;
    this.timelinePromise = null;
    this.timelineVersion = 0;
    this.closed = false;
  }

  async initialize() {
    await this.repository.initialize();
    await this.refreshGlobalQuota();
    this.startWatchers();
    this.pollTimer = setInterval(() => void this.pollSelectedFiles(), 1000);
    this.pollTimer.unref();
    this.reconcileTimer = setInterval(() => void this.reconcile(), 10_000);
    this.reconcileTimer.unref();
    return this.health();
  }

  listSessions(query = "") {
    const normalized = query.trim().toLocaleLowerCase();
    return this.database.listSessions().map((session) => {
      const indexed = this.repository.getSession(session.id);
      return {
        ...session,
        projectPath: indexed?.projectPath ?? session.projectPath,
        title: indexed?.title || "未命名会话",
      };
    }).filter((session) => {
      if (!normalized) return true;
      return `${session.title} ${session.id} ${session.source ?? ""} ${session.projectPath ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }

  async timeline() {
    if (this.timelineCache) return this.timelineCache;
    if (this.timelinePromise) return this.timelinePromise;
    this.timelinePromise = this.buildFreshTimeline();
    try {
      return await this.timelinePromise;
    } finally {
      this.timelinePromise = null;
    }
  }

  async buildFreshTimeline() {
    const version = this.timelineVersion;
    const timeline = await this.buildTimeline();
    if (version !== this.timelineVersion) return this.buildFreshTimeline();
    this.timelineCache = timeline;
    return timeline;
  }

  async buildTimeline() {
    const months = new Map();
    const overallUsage = zeroUsage();
    const qualityCounts = emptyQualityCounts();
    const unattributed = {
      taskCount: 0,
      usage: zeroUsage(),
      qualityCounts: emptyQualityCounts(),
    };

    for (const session of this.repository.sessions.values()) {
      const parser = new SessionRolloutParser(session.id, session);
      const parsed = await parser.parseFiles(this.repository.getFilesForRoot(session.id));
      const sessionsByDay = new Map();
      for (const task of parsed.tasks) {
        const quality = task.quality ?? "unknown";
        incrementQuality(qualityCounts, quality);
        if (!task.startedAt) {
          unattributed.taskCount += 1;
          incrementQuality(unattributed.qualityCounts, quality);
          if (task.deltaUsage) unattributed.usage = addUsage(unattributed.usage, task.deltaUsage);
          continue;
        }

        const date = localDayKey(task.startedAt);
        const monthKey = date.slice(0, 7);
        const month = months.get(monthKey) ?? createMonth(monthKey);
        const day = month.days.get(date) ?? createDay(date);
        const sessionSummary = sessionsByDay.get(date) ?? createTimelineSession(session, date);
        sessionSummary.taskCount += 1;
        incrementQuality(sessionSummary.qualityCounts, quality);
        if (task.status === "in_progress") sessionSummary.activeTaskCount += 1;
        if (task.deltaUsage) {
          sessionSummary.usage = addUsage(sessionSummary.usage, task.deltaUsage);
          month.usage = addUsage(month.usage, task.deltaUsage);
          day.usage = addUsage(day.usage, task.deltaUsage);
          overallUsage.inputTokens += task.deltaUsage.inputTokens ?? 0;
          overallUsage.cachedInputTokens += task.deltaUsage.cachedInputTokens ?? 0;
          overallUsage.cacheWriteInputTokens += task.deltaUsage.cacheWriteInputTokens ?? 0;
          overallUsage.outputTokens += task.deltaUsage.outputTokens ?? 0;
          overallUsage.reasoningOutputTokens += task.deltaUsage.reasoningOutputTokens ?? 0;
          overallUsage.totalTokens += task.deltaUsage.totalTokens ?? 0;
        }
        day.taskCount += 1;
        incrementQuality(day.qualityCounts, quality);
        if (task.status === "in_progress") day.activeTaskCount += 1;
        day.sessions.set(session.id, sessionSummary);
        month.days.set(date, day);
        month.taskCount += 1;
        incrementQuality(month.qualityCounts, quality);
        if (task.status === "in_progress") month.activeTaskCount += 1;
        sessionsByDay.set(date, sessionSummary);
        months.set(monthKey, month);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      timezone: localTimezone(),
      usage: overallUsage,
      qualityCounts,
      unattributed,
      months: [...months.values()]
        .sort((left, right) => right.key.localeCompare(left.key))
        .map(materializeMonth),
    };
  }

  async selectSession(sessionId) {
    if (this.selectionPromise) await this.selectionPromise;
    if (this.selectedSessionId === sessionId && this.parser) return this.snapshot(sessionId);
    const session = this.repository.getSession(sessionId) ?? this.database.getSession(sessionId)?.session;
    if (!session) return null;
    const files = this.repository.getFilesForRoot(sessionId);
    if (!files.length) {
      this.selectedSessionId = sessionId;
      this.parser = null;
      this.selectedEntries = [];
      return this.snapshot(sessionId);
    }

    this.selectionPromise = (async () => {
      const parser = new SessionRolloutParser(sessionId, session);
      const storedSnapshot = this.database.getSession(sessionId);
      const cursors = this.database.getCursors(sessionId);
      let parsed;
      if (storedSnapshot?.tasks.length && cursors.length) {
        const recovery = await parser.restore(storedSnapshot, cursors, files);
        const restoredPaths = new Set(recovery.restoredPaths);
        const replayPaths = new Set(recovery.replayPaths);
        for (const entry of files) {
          if (restoredPaths.has(entry.path) && !replayPaths.has(entry.path)) {
            await parser.tailFile(entry);
          } else {
            await parser.parseFile(entry, { reset: true });
          }
        }
        parsed = parser.snapshot();
      } else {
        parsed = await parser.parseFiles(files);
      }
      this.database.replaceSession(parsed);
      this.parser = parser;
      this.selectedSessionId = sessionId;
      this.selectedEntries = files;
      this.lastUpdateAt = new Date().toISOString();
      this.saveLatestParsedQuota(parsed.quotas);
    })();
    try {
      await this.selectionPromise;
    } catch (error) {
      this.recordError(`解析会话 ${sessionId} 失败`, error);
      throw error;
    } finally {
      this.selectionPromise = null;
    }
    const snapshot = this.snapshot(sessionId);
    this.emit("update", { sessionId, snapshot });
    return snapshot;
  }

  snapshot(sessionId = this.selectedSessionId) {
    const stored = sessionId ? this.database.getSession(sessionId) : null;
    if (!stored) return null;
    stored.session = {
      ...stored.session,
      ...(this.repository.getSession(sessionId) ?? {}),
      parseStatus: stored.session.parseStatus,
      importedAt: stored.session.importedAt,
      agentCount: stored.session.agentCount,
      taskCount: stored.session.taskCount,
    };
    const tasks = stored.tasks.map((task) => ({
      ...task,
      costEstimate: estimateTaskCost(task.model, task.deltaUsage),
    }));
    const agentsById = new Map(stored.agents.map((agent) => [agent.threadId, { ...agent, tasks: [] }]));
    for (const task of tasks) agentsById.get(task.threadId)?.tasks.push(task);
    const agents = [...agentsById.values()];
    for (const agent of agents) {
      agent.ownCostEstimate = summarizeTaskCosts(agent.tasks);
      agent.subtreeCostEstimate = { ...agent.ownCostEstimate };
    }
    for (const agent of [...agents].sort((left, right) => right.depth - left.depth)) {
      const parent = agentsById.get(agent.parentThreadId);
      if (parent) {
        parent.subtreeCostEstimate = combineCostSummaries([
          parent.subtreeCostEstimate,
          agent.subtreeCostEstimate,
        ]);
      }
    }
    const rootAgent = agents.find((agent) => agent.isRoot);
    let subagentUsage = zeroUsage();
    for (const agent of agents) {
      if (!agent.isRoot) subagentUsage = addUsage(subagentUsage, agent.ownUsage);
    }
    const qualityCounts = {};
    for (const task of tasks) qualityCounts[task.quality] = (qualityCounts[task.quality] ?? 0) + 1;
    return {
      session: stored.session,
      agents,
      summary: {
        agentCount: agents.filter((agent) => !agent.isRoot).length,
        taskCount: tasks.length,
        activeTasks: tasks.filter((task) => task.status === "in_progress").length,
        totalUsage: rootAgent?.subtreeUsage ?? subagentUsage,
        subagentUsage,
        qualityCounts,
        totalCostEstimate: summarizeTaskCosts(tasks),
        subagentCostEstimate: summarizeTaskCosts(tasks.filter((task) => {
          const agent = agentsById.get(task.threadId);
          return agent && !agent.isRoot;
        })),
      },
      pricing: pricingCatalogSummary(),
      quota: this.quota(),
      health: this.health(),
    };
  }

  quota() {
    const quota = this.database.getLatestQuota();
    if (!quota) return null;
    const ageMs = Date.now() - Date.parse(quota.observedAt);
    return { ...quota, stale: !Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000, ageMs };
  }

  async taskPreview(threadId, turnId) {
    const task = this.database.getTask(threadId, turnId);
    if (!task) return null;
    return readTaskPreview(task);
  }

  health() {
    const parserHealth = this.parser?.snapshot().health ?? null;
    return {
      status: this.lastErrors.length || parserHealth?.status === "warning" ? "warning" : "healthy",
      observerMode: "rollout-file-observer",
      selectedSessionId: this.selectedSessionId,
      liveWatching: this.watchers.length > 0 || Boolean(this.pollTimer),
      lastUpdateAt: this.lastUpdateAt,
      repository: this.repository.summary(),
      storage: this.database.getHealthStats(),
      parser: parserHealth,
      recentErrors: this.lastErrors.slice(-5),
    };
  }

  startWatchers() {
    for (const root of [
      join(this.repository.codexHome, "sessions"),
      join(this.repository.codexHome, "archived_sessions"),
    ]) {
      if (!existsSync(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename || !String(filename).endsWith(".jsonl")) return;
          this.schedulePath(join(root, String(filename)));
        });
        watcher.on("error", (error) => this.recordError("文件监听异常", error));
        this.watchers.push(watcher);
      } catch (error) {
        this.recordError(`无法监听 ${root}`, error);
      }
    }
  }

  schedulePath(filePath) {
    this.pendingPaths.add(filePath);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => void this.processPendingPaths(), 220);
    this.pendingTimer.unref();
  }

  async processPendingPaths() {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    this.pendingTimer = null;
    let selectedChanged = false;
    let requiresRebuild = false;
    for (const path of paths) {
      try {
        const entry = this.repository.getEntry(path) ?? await this.repository.refreshFile(path);
        if (!entry) continue;
        this.invalidateTimeline();
        if (this.parser && entry.rootSessionId === this.selectedSessionId) {
          const result = await this.parser.tailFile(entry);
          selectedChanged ||= result.changed;
          requiresRebuild ||= result.rebuilt;
          if (!this.selectedEntries.some((item) => item.path === entry.path)) this.selectedEntries.push(entry);
        } else {
          await this.refreshQuotaFromFile(entry.path);
        }
      } catch (error) {
        this.recordError(`处理文件更新失败：${path}`, error);
      }
    }
    if (requiresRebuild && this.selectedSessionId) {
      const id = this.selectedSessionId;
      this.selectedSessionId = null;
      await this.selectSession(id);
      return;
    }
    if (selectedChanged) this.persistAndBroadcast();
  }

  async pollSelectedFiles() {
    if (this.closed || !this.parser || this.selectionPromise) return;
    let changed = false;
    let requiresRebuild = false;
    for (const entry of this.selectedEntries) {
      try {
        const result = await this.parser.tailFile(entry);
        changed ||= result.changed;
        requiresRebuild ||= result.rebuilt;
        if (result.changed) this.invalidateTimeline();
      } catch (error) {
        if (error?.code !== "ENOENT") this.recordError(`轮询失败：${entry.path}`, error);
      }
    }
    if (requiresRebuild && this.selectedSessionId) {
      const id = this.selectedSessionId;
      this.selectedSessionId = null;
      await this.selectSession(id);
    } else if (changed) {
      this.persistAndBroadcast();
    }
  }

  persistAndBroadcast() {
    if (!this.parser || !this.selectedSessionId) return;
    const parsed = this.parser.snapshot();
    this.database.replaceSession(parsed);
    this.saveLatestParsedQuota(parsed.quotas);
    this.lastUpdateAt = new Date().toISOString();
    const snapshot = this.snapshot(this.selectedSessionId);
    this.emit("update", { sessionId: this.selectedSessionId, snapshot });
  }

  async reconcile() {
    if (this.closed) return;
    try {
      const additions = await this.repository.discoverNewFiles();
      if (additions.length) this.invalidateTimeline();
      for (const entry of additions) {
        if (entry.rootSessionId === this.selectedSessionId) this.schedulePath(entry.path);
      }
      await this.refreshGlobalQuota();
    } catch (error) {
      this.recordError("后台校验失败", error);
    }
  }

  async refreshGlobalQuota() {
    const recent = this.repository
      .allFiles()
      .sort((a, b) => (b.modifiedAtMs ?? 0) - (a.modifiedAtMs ?? 0))
      .slice(0, 12);
    let latest = this.database.getLatestQuota();
    for (const entry of recent) {
      try {
        const quota = await scanLatestQuota(entry.path);
        if (quota && (!latest || quota.observedAt > latest.observedAt)) latest = quota;
      } catch (error) {
        if (error?.code !== "ENOENT") this.recordError(`额度扫描失败：${entry.path}`, error);
      }
    }
    if (latest) this.database.saveQuota(latest);
    return latest;
  }

  async refreshQuotaFromFile(path) {
    try {
      const quota = await scanLatestQuota(path);
      if (!quota) return;
      const current = this.database.getLatestQuota();
      if (!current || quota.observedAt >= current.observedAt) {
        this.database.saveQuota(quota);
        this.emit("quota", this.quota());
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  saveLatestParsedQuota(quotas) {
    const latest = [...(quotas ?? [])].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1);
    if (latest) this.database.saveQuota(latest);
  }

  invalidateTimeline() {
    this.timelineCache = null;
    this.timelineVersion += 1;
  }

  recordError(context, error) {
    this.lastErrors.push({
      at: new Date().toISOString(),
      context,
      message: error?.message ?? String(error),
    });
    if (this.lastErrors.length > 20) this.lastErrors.shift();
    this.emit("health", this.health());
  }

  close() {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}

function createMonth(key) {
  return {
    key,
    usage: zeroUsage(),
    taskCount: 0,
    activeTaskCount: 0,
    qualityCounts: emptyQualityCounts(),
    days: new Map(),
  };
}

function createDay(key) {
  return {
    key,
    usage: zeroUsage(),
    taskCount: 0,
    activeTaskCount: 0,
    qualityCounts: emptyQualityCounts(),
    sessions: new Map(),
  };
}

function createTimelineSession(session, date) {
  return {
    id: session.id,
    title: session.title || "未命名会话",
    projectPath: session.projectPath ?? null,
    updatedAt: session.updatedAt ?? null,
    date,
    usage: zeroUsage(),
    taskCount: 0,
    activeTaskCount: 0,
    qualityCounts: emptyQualityCounts(),
  };
}

function materializeMonth(month) {
  return {
    key: month.key,
    usage: month.usage,
    taskCount: month.taskCount,
    activeTaskCount: month.activeTaskCount,
    qualityCounts: month.qualityCounts,
    days: [...month.days.values()]
      .sort((left, right) => right.key.localeCompare(left.key))
      .map((day) => ({
        key: day.key,
        usage: day.usage,
        taskCount: day.taskCount,
        activeTaskCount: day.activeTaskCount,
        qualityCounts: day.qualityCounts,
        sessions: [...day.sessions.values()]
          .sort(compareTimelineSessions)
          .map((session) => ({
            ...session,
            qualityCounts: session.qualityCounts,
          })),
      })),
  };
}

function compareTimelineSessions(left, right) {
  return (right.usage.totalTokens ?? -1) - (left.usage.totalTokens ?? -1) ||
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
    left.id.localeCompare(right.id);
}

function emptyQualityCounts() {
  return Object.fromEntries(QUALITY_KEYS.map((key) => [key, 0]));
}

function incrementQuality(counts, quality) {
  const key = QUALITY_KEYS.includes(quality) ? quality : "unknown";
  counts[key] += 1;
}

function localDayKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "当地时区";
}
