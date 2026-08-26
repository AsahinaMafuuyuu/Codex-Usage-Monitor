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
import { materializeRequestLedgerTasks } from "./request-ledger.js";
import { addUsage, reconcileRateLimitSnapshots, zeroUsage } from "./usage.js";

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
    this.timelinePromise = null;
    this.timelineDirtySessions = new Set();
    this.timelineStats = {
      dirtySessions: 0,
      sessionsSynced: 0,
      replayedFiles: 0,
      tailedFiles: 0,
      lastSyncMs: 0,
      lastSyncAt: null,
    };
    this.currentQuota = null;
    this.closed = false;
  }

  async initialize() {
    await this.repository.initialize();
    this.refreshTimelineDirtySessions();
    this.currentQuota = this.database.getLatestQuota();
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
    if (this.timelinePromise) return this.timelinePromise;
    this.timelinePromise = this.buildSqlTimeline();
    try {
      return await this.timelinePromise;
    } finally {
      this.timelinePromise = null;
    }
  }

  async buildSqlTimeline() {
    const started = Date.now();
    const dirtySessions = [...this.timelineDirtySessions];
    let replayedFiles = 0;
    let tailedFiles = 0;
    let sessionsSynced = 0;
    for (const sessionId of dirtySessions) {
      this.timelineDirtySessions.delete(sessionId);
      try {
        const result = await this.syncTimelineSession(sessionId);
        replayedFiles += result.replayedFiles;
        tailedFiles += result.tailedFiles;
        sessionsSynced += 1;
      } catch (error) {
        this.timelineDirtySessions.add(sessionId);
        this.recordError(`日期索引增量同步失败：${sessionId}`, error);
        throw error;
      }
    }
    this.timelineStats = {
      dirtySessions: this.timelineDirtySessions.size,
      sessionsSynced,
      replayedFiles,
      tailedFiles,
      lastSyncMs: Date.now() - started,
      lastSyncAt: new Date().toISOString(),
    };
    return this.database.getTimeline(this.repository.sessions);
  }

  refreshTimelineDirtySessions() {
    this.timelineDirtySessions.clear();
    for (const session of this.repository.sessions.values()) {
      if (!this.isTimelineSessionCurrent(session.id)) this.timelineDirtySessions.add(session.id);
    }
    this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
  }

  isTimelineSessionCurrent(sessionId) {
    const files = this.repository.getFilesForRoot(sessionId);
    if (!files.length) return true;
    const indexState = this.database.getSessionIndexState(sessionId);
    if (!indexState || indexState.parseStatus === "not_imported") return false;
    if (!indexState.requestLedgerReady) return false;
    const cursors = new Map(
      this.database.getCursors(sessionId).map((cursor) => [cursor.sourceKey, cursor]),
    );
    return files.every((entry) => {
      const cursor = cursors.get(entry.sourceKey);
      if (!cursor || cursor.fileSize !== entry.fileSize) return false;
      if (cursor.modifiedAtMs == null || entry.modifiedAtMs == null) return true;
      return Math.abs(cursor.modifiedAtMs - entry.modifiedAtMs) < 1;
    });
  }

  markTimelineDirty(sessionId) {
    if (!sessionId) return;
    this.timelineDirtySessions.add(sessionId);
    this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
  }

  async syncTimelineSession(sessionId) {
    const session = this.repository.getSession(sessionId) ?? this.database.getSession(sessionId)?.session;
    if (!session) return { replayedFiles: 0, tailedFiles: 0 };
    const files = this.repository.getFilesForRoot(sessionId);
    if (!files.length) return { replayedFiles: 0, tailedFiles: 0 };

    if (this.parser && this.selectedSessionId === sessionId) {
      let changed = false;
      let requiresRebuild = false;
      for (const entry of files) {
        const result = await this.parser.tailFile(entry);
        changed ||= result.changed;
        requiresRebuild ||= result.rebuilt;
      }
      if (requiresRebuild) {
        this.selectedSessionId = null;
        await this.selectSession(sessionId);
        return { replayedFiles: files.length, tailedFiles: 0 };
      }
      if (changed) this.persistAndBroadcast();
      return { replayedFiles: 0, tailedFiles: files.length };
    }

    const parser = new SessionRolloutParser(sessionId, session);
    const storedSnapshot = this.database.getSession(sessionId);
    const cursors = this.database.getCursors(sessionId);
    const indexState = this.database.getSessionIndexState(sessionId);
    let parsed;
    let replayedFiles = 0;
    let tailedFiles = 0;
    if (storedSnapshot && cursors.length && indexState?.requestLedgerReady) {
      const recovery = await parser.restore(storedSnapshot, cursors, files);
      const restoredPaths = new Set(recovery.restoredPaths);
      const replayPaths = new Set(recovery.replayPaths);
      for (const entry of files) {
        if (restoredPaths.has(entry.path) && !replayPaths.has(entry.path)) {
          await parser.tailFile(entry);
          tailedFiles += 1;
        } else {
          await parser.parseFile(entry, { reset: true });
          replayedFiles += 1;
        }
      }
      parsed = parser.snapshot();
    } else {
      parsed = await parser.parseFiles(files);
      replayedFiles = files.length;
    }
    this.database.replaceSession(parsed, { persistQuotas: false });
    return { replayedFiles, tailedFiles };
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
      const indexState = this.database.getSessionIndexState(sessionId);
      let parsed;
      if (storedSnapshot?.tasks.length && cursors.length && indexState?.requestLedgerReady) {
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
      this.timelineDirtySessions.delete(sessionId);
      this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
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
    const tasks = materializeRequestLedgerTasks(stored.tasks, stored.modelUsageEvents).map((task) => ({
      ...task,
      costEstimate: estimateTaskCost(task.model, task.deltaUsage),
    }));
    const agentsById = new Map(stored.agents.map((agent) => [agent.threadId, { ...agent, tasks: [] }]));
    for (const task of tasks) agentsById.get(task.threadId)?.tasks.push(task);
    const agents = [...agentsById.values()];
    for (const agent of agents) {
      agent.ownCostEstimate = summarizeTaskCosts(agent.tasks);
      agent.subtreeCostEstimate = { ...agent.ownCostEstimate };
      agent.ownModelRequestCount = agent.tasks.reduce(
        (sum, task) => sum + (task.requestCount ?? 0),
        0,
      );
      agent.subtreeModelRequestCount = agent.ownModelRequestCount;
      agent.ownTokensPerModelRequest =
        agent.ownModelRequestCount > 0
          ? agent.ownUsage.totalTokens / agent.ownModelRequestCount
          : null;
      agent.subtreeTokensPerModelRequest = agent.ownTokensPerModelRequest;
    }
    for (const agent of [...agents].sort((left, right) => right.depth - left.depth)) {
      const parent = agentsById.get(agent.parentThreadId);
      if (parent) {
        parent.subtreeCostEstimate = combineCostSummaries([
          parent.subtreeCostEstimate,
          agent.subtreeCostEstimate,
        ]);
        parent.subtreeModelRequestCount += agent.subtreeModelRequestCount;
      }
    }
    for (const agent of agents) {
      agent.subtreeTokensPerModelRequest =
        agent.subtreeModelRequestCount > 0
          ? agent.subtreeUsage.totalTokens / agent.subtreeModelRequestCount
          : null;
    }
    const rootAgent = agents.find((agent) => agent.isRoot);
    let subagentUsage = zeroUsage();
    for (const agent of agents) {
      if (!agent.isRoot) subagentUsage = addUsage(subagentUsage, agent.ownUsage);
    }
    const qualityCounts = {};
    for (const task of tasks) qualityCounts[task.quality] = (qualityCounts[task.quality] ?? 0) + 1;
    const totalUsage = rootAgent?.subtreeUsage ?? subagentUsage;
    const modelRequestCount = tasks.reduce((sum, task) => sum + (task.requestCount ?? 0), 0);
    const subagentModelRequestCount = tasks.reduce((sum, task) => {
      const agent = agentsById.get(task.threadId);
      return sum + (agent && !agent.isRoot ? (task.requestCount ?? 0) : 0);
    }, 0);
    return {
      session: stored.session,
      agents,
      summary: {
        agentCount: agents.filter((agent) => !agent.isRoot).length,
        taskCount: tasks.length,
        activeTasks: tasks.filter((task) => task.status === "in_progress").length,
        totalUsage,
        subagentUsage,
        modelRequestCount,
        tokensPerModelRequest:
          modelRequestCount > 0 ? totalUsage.totalTokens / modelRequestCount : null,
        subagentModelRequestCount,
        subagentTokensPerModelRequest:
          subagentModelRequestCount > 0
            ? subagentUsage.totalTokens / subagentModelRequestCount
            : null,
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
    const quota = this.currentQuota ?? this.database.getLatestQuota();
    if (!quota) return null;
    const ageMs = Date.now() - Date.parse(quota.observedAt);
    return { ...quota, stale: !Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000, ageMs };
  }

  async taskPreview(threadId, turnId) {
    const task = this.database.getTask(threadId, turnId);
    if (!task) return null;
    const sourcePath = this.repository.resolveSourceKey(task.sourceKey);
    if (!sourcePath) {
      return { available: false, text: null, reason: "原始任务位置无法绑定到当前 Codex 目录" };
    }
    return readTaskPreview({ ...task, sourcePath });
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
      timeline: {
        ...this.timelineStats,
        dirtySessions: this.timelineDirtySessions.size,
      },
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
        const entry = await this.repository.refreshFile(path);
        if (!entry) continue;
        this.markTimelineDirty(entry.rootSessionId);
        if (this.parser && entry.rootSessionId === this.selectedSessionId) {
          const result = await this.parser.tailFile(entry);
          selectedChanged ||= result.changed;
          requiresRebuild ||= result.rebuilt;
          if (!this.selectedEntries.some((item) => item.path === entry.path)) this.selectedEntries.push(entry);
        } else {
          await this.refreshQuotaFromFile(entry);
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
        if (result.changed) this.markTimelineDirty(entry.rootSessionId);
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
    this.timelineDirtySessions.delete(this.selectedSessionId);
    this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
    this.saveLatestParsedQuota(parsed.quotas);
    this.lastUpdateAt = new Date().toISOString();
    const snapshot = this.snapshot(this.selectedSessionId);
    this.emit("update", { sessionId: this.selectedSessionId, snapshot });
  }

  async reconcile() {
    if (this.closed) return;
    try {
      const additions = await this.repository.discoverNewFiles();
      for (const entry of additions) {
        this.markTimelineDirty(entry.rootSessionId);
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
    let latest = this.currentQuota ?? this.database.getLatestQuota();
    for (const entry of recent) {
      try {
        const quota = await scanLatestQuota(entry.path, undefined, entry.sourceKey);
        if (!quota) continue;
        this.database.saveQuota(quota);
        latest = reconcileRateLimitSnapshots(latest, quota);
      } catch (error) {
        if (error?.code !== "ENOENT") this.recordError(`额度扫描失败：${entry.path}`, error);
      }
    }
    this.currentQuota = latest;
    return latest;
  }

  async refreshQuotaFromFile(entry) {
    try {
      const quota = await scanLatestQuota(entry.path, undefined, entry.sourceKey);
      if (!quota) return;
      this.database.saveQuota(quota);
      this.currentQuota = reconcileRateLimitSnapshots(
        this.currentQuota ?? this.database.getLatestQuota(),
        quota,
      );
      this.emit("quota", this.quota());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  saveLatestParsedQuota(quotas) {
    const snapshots = [...(quotas ?? [])].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let current = this.currentQuota ?? this.database.getLatestQuota();
    for (const quota of snapshots) {
      this.database.saveQuota(quota);
      current = reconcileRateLimitSnapshots(current, quota);
    }
    this.currentQuota = current;
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
