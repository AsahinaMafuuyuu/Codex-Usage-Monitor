import { EventEmitter } from "node:events";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  readTaskPreview,
  scanLatestQuota,
  SessionRolloutParser,
} from "./rollout-parser.js";
import { addUsage, zeroUsage } from "./usage.js";

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
    return this.database.listSessions().map((session) => ({
      ...session,
      title: this.repository.getSession(session.id)?.title || "未命名会话",
    })).filter((session) => {
      if (!normalized) return true;
      return `${session.title} ${session.id} ${session.source ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
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
    const agentsById = new Map(stored.agents.map((agent) => [agent.threadId, { ...agent, tasks: [] }]));
    for (const task of stored.tasks) agentsById.get(task.threadId)?.tasks.push(task);
    const agents = [...agentsById.values()];
    const rootAgent = agents.find((agent) => agent.isRoot);
    let subagentUsage = zeroUsage();
    for (const agent of agents) {
      if (!agent.isRoot) subagentUsage = addUsage(subagentUsage, agent.ownUsage);
    }
    const qualityCounts = {};
    for (const task of stored.tasks) qualityCounts[task.quality] = (qualityCounts[task.quality] ?? 0) + 1;
    return {
      session: stored.session,
      agents,
      summary: {
        agentCount: agents.filter((agent) => !agent.isRoot).length,
        taskCount: stored.tasks.length,
        activeTasks: stored.tasks.filter((task) => task.status === "in_progress").length,
        totalUsage: rootAgent?.subtreeUsage ?? subagentUsage,
        subagentUsage,
        qualityCounts,
      },
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
