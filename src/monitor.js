import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { CodexUsageClient, CodexUsageUnavailableError } from "./codex-usage-client.js";
import {
  ADVANCED_USAGE_DIAGNOSTICS_POLICY,
  analyzeAdvancedUsageDiagnostics,
} from "./advanced-diagnostics.js";
import {
  BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY,
  analyzeBehavioralUsageDiagnostics,
} from "./behavioral-diagnostics.js";
import { analyzeUsageDiagnostics } from "./diagnostics.js";
import { estimateRequestCost, pricingCatalogSummary } from "./pricing.js";
import {
  readTaskPreview,
  SessionRolloutParser,
} from "./rollout-parser.js";
import { materializeScopedSnapshot, resolveLocalDayRange } from "./snapshot-scope.js";
import { reconcileRateLimitSnapshots } from "./usage.js";

export class UsageMonitor extends EventEmitter {
  constructor({
    repository,
    database,
    quotaClient = new CodexUsageClient({ codexHome: repository.codexHome }),
    quotaRefreshIntervalMs = 60_000,
  }) {
    super();
    this.repository = repository;
    this.database = database;
    this.quotaClient = quotaClient;
    this.quotaRefreshIntervalMs = quotaRefreshIntervalMs;
    this.selectedSessionId = null;
    this.parser = null;
    this.selectedEntries = [];
    this.selectionPromise = null;
    this.watchers = [];
    this.pendingPaths = new Set();
    this.pendingTimer = null;
    this.pollTimer = null;
    this.reconcileTimer = null;
    this.quotaPollTimer = null;
    this.quotaRefreshPromise = null;
    this.lastUpdateAt = null;
    this.lastErrors = [];
    this.timelinePromise = null;
    this.indexerPromise = null;
    this.pendingProcessPromise = null;
    this.closePromise = null;
    this.diagnosticAlertCache = new Map();
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
    const persistedQuota = this.database.getLatestQuota();
    this.currentQuota = persistedQuota?.source === "official-usage-api" ? persistedQuota : null;
    this.startWatchers();
    this.pollTimer = setInterval(() => void this.pollSelectedFiles(), 1000);
    this.pollTimer.unref();
    this.reconcileTimer = setInterval(() => void this.reconcile(), 10_000);
    this.reconcileTimer.unref();
    this.quotaPollTimer = setInterval(
      () => void this.refreshQuotaFromOfficial({ emit: true }),
      this.quotaRefreshIntervalMs,
    );
    this.quotaPollTimer.unref();
    void this.refreshQuotaFromOfficial({ emit: true });
    void this.runBackgroundIndexer();
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
    let timeline = this.database.getTimeline(this.repository.sessions);
    if (
      (timeline.months?.length ?? 0) === 0 &&
      (this.timelineDirtySessions.size > 0 || this.indexerPromise)
    ) {
      await this.runBackgroundIndexer();
      timeline = this.database.getTimeline(this.repository.sessions);
      return timeline;
    }
    void this.runBackgroundIndexer();
    return timeline;
  }

  async buildSqlTimeline() {
    void this.runBackgroundIndexer();
    return this.database.getTimeline(this.repository.sessions);
  }

  async runBackgroundIndexer() {
    if (this.closed) return null;
    if (this.indexerPromise) return this.indexerPromise;
    if (this.timelineDirtySessions.size === 0) return this.timelineStats;
    this.indexerPromise = (async () => {
      const started = Date.now();
    let replayedFiles = 0;
    let tailedFiles = 0;
    let sessionsSynced = 0;
      while (!this.closed && this.timelineDirtySessions.size > 0) {
        const sessionId =
          this.selectedSessionId && this.timelineDirtySessions.has(this.selectedSessionId)
            ? this.selectedSessionId
            : this.timelineDirtySessions.values().next().value;
        if (!sessionId) break;
      this.timelineDirtySessions.delete(sessionId);
      try {
        const result = await this.syncTimelineSession(sessionId);
        replayedFiles += result.replayedFiles;
        tailedFiles += result.tailedFiles;
        sessionsSynced += 1;
          if (sessionId === this.selectedSessionId) this.emit("update", { sessionId });
      } catch (error) {
        this.timelineDirtySessions.add(sessionId);
          this.recordError(`后台索引同步失败：${sessionId}`, error);
          break;
      }
        await new Promise((resolve) => setImmediate(resolve));
    }
    this.timelineStats = {
      dirtySessions: this.timelineDirtySessions.size,
      sessionsSynced,
      replayedFiles,
      tailedFiles,
      lastSyncMs: Date.now() - started,
      lastSyncAt: new Date().toISOString(),
    };
      return this.timelineStats;
    })();
    try {
      return await this.indexerPromise;
    } finally {
      this.indexerPromise = null;
      if (!this.closed && this.timelineDirtySessions.size > 0) {
        queueMicrotask(() => void this.runBackgroundIndexer());
      }
    }
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
    if (!indexState.parserCurrent) return false;
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
    queueMicrotask(() => void this.runBackgroundIndexer());
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
    const storedSnapshot = this.database.getRawSession(sessionId);
    const cursors = this.database.getCursors(sessionId);
    const indexState = this.database.getSessionIndexState(sessionId);
    let parsed;
    let replayedFiles = 0;
    let tailedFiles = 0;
    if (
      storedSnapshot &&
      cursors.length &&
      indexState?.requestLedgerReady &&
      indexState?.parserCurrent
    ) {
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
    if (this.closed) return { replayedFiles, tailedFiles };
    this.database.replaceSession(parsed, { persistQuotas: false });
    return { replayedFiles, tailedFiles };
  }

  async selectSession(sessionId, scope = { type: "session" }) {
    if (this.selectionPromise) await this.selectionPromise;
    if (this.selectedSessionId === sessionId && this.parser) return this.snapshot(sessionId, scope);
    let indexState = this.database.getSessionIndexState(sessionId);
    let cached = hasImportedRequestProjection(indexState) ? this.snapshot(sessionId, scope) : null;
    if (!cached && (this.timelineDirtySessions.has(sessionId) || this.indexerPromise)) {
      this.markTimelineDirty(sessionId);
      await this.runBackgroundIndexer();
      indexState = this.database.getSessionIndexState(sessionId);
      cached = hasImportedRequestProjection(indexState) ? this.snapshot(sessionId, scope) : null;
    }
    if (cached) {
      this.selectedSessionId = sessionId;
      this.parser = null;
      this.selectedEntries = this.repository.getFilesForRoot(sessionId);
      if (!this.isTimelineSessionCurrent(sessionId)) this.markTimelineDirty(sessionId);
      return cached;
    }
    const session = this.repository.getSession(sessionId) ?? this.database.getSession(sessionId)?.session;
    if (!session) return null;
    const files = this.repository.getFilesForRoot(sessionId);
    if (!files.length) {
      this.selectedSessionId = sessionId;
      this.parser = null;
      this.selectedEntries = [];
      return this.snapshot(sessionId, scope);
    }

    this.selectionPromise = (async () => {
      const parser = new SessionRolloutParser(sessionId, session);
      const storedSnapshot = this.database.getRawSession(sessionId);
      const cursors = this.database.getCursors(sessionId);
      const indexState = this.database.getSessionIndexState(sessionId);
      let parsed;
      if (
        storedSnapshot?.tasks.length &&
        cursors.length &&
        indexState?.requestLedgerReady &&
        indexState?.parserCurrent
      ) {
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
      if (this.closed) return;
      this.database.replaceSession(parsed, { persistQuotas: false });
      this.timelineDirtySessions.delete(sessionId);
      this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
      this.parser = parser;
      this.selectedSessionId = sessionId;
      this.selectedEntries = files;
      this.lastUpdateAt = new Date().toISOString();
    })();
    try {
      await this.selectionPromise;
    } catch (error) {
      this.recordError(`解析会话 ${sessionId} 失败`, error);
      throw error;
    } finally {
      this.selectionPromise = null;
    }
    const snapshot = this.snapshot(sessionId, scope);
    this.emit("update", { sessionId });
    return snapshot;
  }

  snapshot(sessionId = this.selectedSessionId, scope = { type: "session" }) {
    const normalizedScope = scope?.type === "day"
      ? { type: "day", day: scope.day, range: scope.range ?? resolveLocalDayRange(scope.day) }
      : { type: "session" };
    const stored = sessionId
      ? normalizedScope.type === "day"
        ? this.database.getSessionDay(sessionId, normalizedScope.range)
        : this.database.getSession(sessionId)
      : null;
    if (!stored) return null;
    stored.session = {
      ...stored.session,
      ...(this.repository.getSession(sessionId) ?? {}),
      parseStatus: stored.session.parseStatus,
      importedAt: stored.session.importedAt,
      agentCount: stored.session.agentCount,
      taskCount: stored.session.taskCount,
    };
    const materialized = materializeScopedSnapshot(
      stored,
      normalizedScope,
      { ownershipResolved: true },
    );
    return {
      ...materialized,
      pricing: pricingCatalogSummary(),
      quota: this.quota(),
      health: this.health(),
    };
  }

  quota() {
    const quota = this.currentQuota;
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

  taskRequests(sessionId, threadId, turnId, {
    day = null,
    range = null,
    limit = 200,
    after = null,
    page = null,
  } = {}) {
    const task = this.database.getTask(threadId, turnId);
    if (!task || task.rootSessionId !== sessionId) return null;
    const requestPage = this.database.getCanonicalTaskRequests(sessionId, threadId, turnId, {
      range,
      limit,
      after,
      page,
    });
    const projection = this.database.getProjectionState();
    return {
      task: {
        rootSessionId: task.rootSessionId,
        threadId: task.threadId,
        turnId: task.turnId,
        sequence: task.sequence,
        status: task.status,
      },
      scope: day
        ? { type: "day", day, timezone: range?.timezone ?? null }
        : { type: "session" },
      requests: requestPage.requests.map((request) => ({
        requestId: request.requestId,
        observedAt: request.observedAt,
        usage: request.usage,
        model: request.model,
        serviceTier: request.serviceTier,
        pricingContextQuality: request.pricingContextQuality,
        quality: request.quality,
        costEstimate: estimateRequestCost(request),
      })),
      nextAfter: requestPage.nextAfter,
      pagination: requestPage.pagination,
      projectionGeneration: Number(projection?.generation ?? 0),
    };
  }

  diagnostics(sessionId, scope = { type: "session" }) {
    const indexState = this.database.getSessionIndexState(sessionId);
    if (!hasImportedRequestProjection(indexState)) return null;
    const normalizedScope = scope?.type === "day"
      ? {
          type: "day",
          day: scope.day,
          range: scope.range ?? resolveLocalDayRange(scope.day),
        }
      : { type: "session" };
    const facts = this.database.getDiagnosticFacts(sessionId, {
      range: normalizedScope.type === "day" ? normalizedScope.range : null,
    });
    const enrichedFacts = facts.map((fact) => Object.freeze({
      ...fact,
      costEstimate: estimateRequestCost(fact),
    }));
    const report = analyzeUsageDiagnostics(enrichedFacts);
    const projection = this.database.getProjectionState();
    return {
      scope: normalizedScope.type === "day"
        ? {
            type: "day",
            day: normalizedScope.day,
            timezone: normalizedScope.range?.timezone ?? null,
          }
        : { type: "session" },
      projectionGeneration: Number(projection?.generation ?? 0),
      stale: this.timelineDirtySessions.has(sessionId) || !this.isTimelineSessionCurrent(sessionId),
      ...report,
    };
  }

  advancedDiagnostics(sessionId, scope = { type: "session" }) {
    const indexState = this.database.getSessionIndexState(sessionId);
    if (!hasImportedRequestProjection(indexState)) return null;
    const normalizedScope = scope?.type === "day"
      ? {
          type: "day",
          day: scope.day,
          range: scope.range ?? resolveLocalDayRange(scope.day),
        }
      : { type: "session" };
    const currentFacts = this.database.getDiagnosticFacts(sessionId, {
      range: normalizedScope.type === "day" ? normalizedScope.range : null,
    });
    const projectPath = currentFacts.find((fact) => fact.projectPath)?.projectPath ?? null;
    const observedTimes = currentFacts
      .map((fact) => Date.parse(fact.observedAt))
      .filter(Number.isFinite);
    const firstObservedMs = observedTimes.length ? Math.min(...observedTimes) : null;
    const lastObservedMs = observedTimes.length ? Math.max(...observedTimes) : null;
    let historicalFacts = [];
    let historicalSessionFacts = [];
    if (projectPath && firstObservedMs != null && lastObservedMs != null) {
      const before = new Date(lastObservedMs + 1).toISOString();
      historicalFacts = this.database.getHistoricalDiagnosticFacts(sessionId, {
        projectPath,
        after: new Date(
          firstObservedMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays * 86_400_000,
        ).toISOString(),
        before,
        maxSamplesPerCohort: ADVANCED_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
      });
      if (normalizedScope.type === "session") {
        historicalSessionFacts = this.database.getHistoricalDiagnosticSessionFacts(sessionId, {
          projectPath,
          after: new Date(
            firstObservedMs - ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.horizonDays * 86_400_000,
          ).toISOString(),
          before,
          maxSlicesPerCohort: ADVANCED_USAGE_DIAGNOSTICS_POLICY.sessionHistory.maxSlicesPerCohort,
        });
      }
    }
    const enrich = (facts) => facts.map((fact) => Object.freeze({
      ...fact,
      costEstimate: estimateRequestCost(fact),
    }));
    const report = analyzeAdvancedUsageDiagnostics({
      currentFacts: enrich(currentFacts),
      historicalFacts: enrich(historicalFacts),
      historicalSessionFacts: enrich(historicalSessionFacts),
      scope: normalizedScope.type === "day"
        ? {
            type: "day",
            day: normalizedScope.day,
            startAt: new Date(normalizedScope.range.startMs).toISOString(),
            endAt: new Date(normalizedScope.range.endMs).toISOString(),
          }
        : { type: "session" },
    });
    const { candidates: _shadowCandidates, ...publicReport } = report;
    const projection = this.database.getProjectionState();
    return {
      scope: normalizedScope.type === "day"
        ? {
            type: "day",
            day: normalizedScope.day,
            timezone: normalizedScope.range?.timezone ?? null,
          }
        : { type: "session" },
      projectionGeneration: Number(projection?.generation ?? 0),
      stale: this.timelineDirtySessions.has(sessionId) || !this.isTimelineSessionCurrent(sessionId),
      ...publicReport,
    };
  }

  behavioralDiagnostics(sessionId, scope = { type: "session" }) {
    const indexState = this.database.getSessionIndexState(sessionId);
    if (!hasImportedRequestProjection(indexState)) return null;
    const normalizedScope = scope?.type === "day"
      ? {
          type: "day",
          day: scope.day,
          range: scope.range ?? resolveLocalDayRange(scope.day),
        }
      : { type: "session" };
    const currentFacts = this.database.getDiagnosticFacts(sessionId, {
      range: normalizedScope.type === "day" ? normalizedScope.range : null,
    });
    const projectPath = currentFacts.find((fact) => fact.projectPath)?.projectPath ?? null;
    const observedTimes = currentFacts
      .map((fact) => Date.parse(fact.observedAt))
      .filter(Number.isFinite);
    const firstObservedMs = observedTimes.length ? Math.min(...observedTimes) : null;
    const lastObservedMs = observedTimes.length ? Math.max(...observedTimes) : null;
    let historicalFacts = [];
    let historicalSessionFacts = [];
    let historicalAmplificationSamples = [];
    if (projectPath && firstObservedMs != null && lastObservedMs != null) {
      const before = new Date(lastObservedMs + 1).toISOString();
      historicalFacts = this.database.getHistoricalDiagnosticFacts(sessionId, {
        projectPath,
        after: new Date(
          firstObservedMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.requestHistory.horizonDays * 86_400_000,
        ).toISOString(),
        before,
        maxSamplesPerCohort: BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.requestHistory.maxSamplesPerCohort,
      });
      if (normalizedScope.type === "session") {
        historicalSessionFacts = this.database.getHistoricalDiagnosticSessionFacts(sessionId, {
          projectPath,
          after: new Date(
            firstObservedMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.burst.horizonDays * 86_400_000,
          ).toISOString(),
          before,
          maxSlicesPerCohort: BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.burst.maxSlicesPerCohort,
        });
        historicalAmplificationSamples = this.database.getHistoricalSubagentAmplificationSamples(sessionId, {
          projectPath,
          after: new Date(
            firstObservedMs - BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.subagentAmplification.horizonDays * 86_400_000,
          ).toISOString(),
          before,
          maxSessions: BEHAVIORAL_USAGE_DIAGNOSTICS_POLICY.subagentAmplification.maxSessions,
        });
      }
    }
    const report = analyzeBehavioralUsageDiagnostics({
      currentFacts,
      historicalFacts,
      historicalSessionFacts,
      historicalAmplificationSamples,
      scope: normalizedScope.type === "day"
        ? {
            type: "day",
            day: normalizedScope.day,
            startAt: new Date(normalizedScope.range.startMs).toISOString(),
            endAt: new Date(normalizedScope.range.endMs).toISOString(),
          }
        : { type: "session" },
    });
    const { candidates: _shadowCandidates, ...publicReport } = report;
    const projection = this.database.getProjectionState();
    return {
      scope: normalizedScope.type === "day"
        ? {
            type: "day",
            day: normalizedScope.day,
            timezone: normalizedScope.range?.timezone ?? null,
          }
        : { type: "session" },
      projectionGeneration: Number(projection?.generation ?? 0),
      stale: this.timelineDirtySessions.has(sessionId) || !this.isTimelineSessionCurrent(sessionId),
      ...publicReport,
    };
  }

  diagnosticAlerts(sessionId, { includeAcknowledged = false } = {}) {
    const indexState = this.database.getSessionIndexState(sessionId);
    if (!hasImportedRequestProjection(indexState)) return null;
    const projectionGeneration = Number(this.database.getProjectionState()?.generation ?? 0);
    const cached = this.diagnosticAlertCache.get(sessionId);
    if (cached?.projectionGeneration === projectionGeneration) {
      return materializeDiagnosticAlertReport(cached, {
        includeAcknowledged,
        stale: this.timelineDirtySessions.has(sessionId) || !this.isTimelineSessionCurrent(sessionId),
      });
    }
    const snapshot = this.snapshot(sessionId, { type: "session" });
    if (!snapshot) return null;
    const projectPath = snapshot.session?.projectPath ?? null;
    if (!projectPath) return null;
    const policy = {
      sessionCostBudgetUsd: null,
      minimumSeverity: "high",
      cooldownMinutes: 60,
      snoozedUntil: null,
      updatedAt: null,
      ...(this.database.getDiagnosticAlertPolicy(projectPath) ?? {}),
      projectPath,
    };
    const acknowledgements = new Map(
      this.database.getDiagnosticAlertAcknowledgements(sessionId)
        .map((entry) => [entry.alertId, entry.acknowledgedAt]),
    );
    const local = this.diagnostics(sessionId);
    const advanced = this.advancedDiagnostics(sessionId);
    const behavioral = this.behavioralDiagnostics(sessionId);
    const findings = [
      ...(local?.findings ?? []),
      ...(advanced?.findings ?? []),
      ...(behavioral?.findings ?? []),
    ];
    const minimumSeverityRank = diagnosticSeverityRank(policy.minimumSeverity);
    const alerts = findings
      .filter((finding) => diagnosticSeverityRank(finding.severity) >= minimumSeverityRank)
      .map((finding) => diagnosticFindingAlert(sessionId, finding, acknowledgements));
    const cost = snapshot.summary?.totalCostEstimate ?? null;
    if (
      Number.isFinite(policy.sessionCostBudgetUsd) &&
      policy.sessionCostBudgetUsd > 0 &&
      cost?.status === "estimated" &&
      Number.isFinite(cost.amountUsd) &&
      cost.amountUsd >= policy.sessionCostBudgetUsd
    ) {
      alerts.push(diagnosticBudgetAlert({
        sessionId,
        projectPath,
        budgetUsd: policy.sessionCostBudgetUsd,
        amountUsd: cost.amountUsd,
        pricingPolicyVersion: pricingCatalogSummary().policyVersion,
        acknowledgements,
      }));
    }
    alerts.sort(compareDiagnosticAlerts);
    const snoozed = Number.isFinite(Date.parse(policy.snoozedUntil)) && Date.parse(policy.snoozedUntil) > Date.now();
    const cacheEntry = {
      sessionId,
      projectPath,
      projectionGeneration,
      policy: {
        sessionCostBudgetUsd: policy.sessionCostBudgetUsd,
        minimumSeverity: policy.minimumSeverity,
        cooldownMinutes: policy.cooldownMinutes,
        snoozedUntil: policy.snoozedUntil,
        updatedAt: policy.updatedAt,
      },
      snoozed,
      allAlerts: alerts,
    };
    this.diagnosticAlertCache.set(sessionId, cacheEntry);
    if (this.diagnosticAlertCache.size > 32) {
      this.diagnosticAlertCache.delete(this.diagnosticAlertCache.keys().next().value);
    }
    return materializeDiagnosticAlertReport(cacheEntry, {
      includeAcknowledged,
      stale: this.timelineDirtySessions.has(sessionId) || !this.isTimelineSessionCurrent(sessionId),
    });
  }

  updateDiagnosticAlertPolicy(sessionId, input = {}) {
    const snapshot = this.snapshot(sessionId, { type: "session" });
    const projectPath = snapshot?.session?.projectPath ?? null;
    if (!projectPath) return null;
    const current = this.database.getDiagnosticAlertPolicy(projectPath) ?? {};
    const sessionCostBudgetUsd = input.sessionCostBudgetUsd == null || input.sessionCostBudgetUsd === ""
      ? null
      : Number(input.sessionCostBudgetUsd);
    if (sessionCostBudgetUsd != null && (!Number.isFinite(sessionCostBudgetUsd) || sessionCostBudgetUsd <= 0 || sessionCostBudgetUsd > 1_000_000)) {
      throw new RangeError("sessionCostBudgetUsd 必须为空或位于 (0, 1000000] USD");
    }
    const minimumSeverity = input.minimumSeverity ?? current.minimumSeverity ?? "high";
    if (!new Set(["warning", "high"]).has(minimumSeverity)) {
      throw new RangeError("minimumSeverity 仅支持 warning/high");
    }
    const cooldownMinutes = input.cooldownMinutes == null
      ? Number(current.cooldownMinutes ?? 60)
      : Number(input.cooldownMinutes);
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 5 || cooldownMinutes > 1_440) {
      throw new RangeError("cooldownMinutes 必须是 5..1440 的整数");
    }
    const policy = this.database.upsertDiagnosticAlertPolicy(projectPath, {
      sessionCostBudgetUsd,
      minimumSeverity,
      cooldownMinutes,
      snoozedUntil: current.snoozedUntil ?? null,
    });
    this.diagnosticAlertCache.clear();
    return policy;
  }

  acknowledgeDiagnosticAlert(sessionId, alertId) {
    const report = this.diagnosticAlerts(sessionId, { includeAcknowledged: true });
    if (!report) return null;
    const alert = report.alerts.find((candidate) => candidate.alertId === alertId);
    if (!alert) return false;
    const acknowledgement = this.database.acknowledgeDiagnosticAlert(sessionId, alertId);
    this.diagnosticAlertCache.delete(sessionId);
    return acknowledgement;
  }

  snoozeDiagnosticAlerts(sessionId) {
    const snapshot = this.snapshot(sessionId, { type: "session" });
    const projectPath = snapshot?.session?.projectPath ?? null;
    if (!projectPath) return null;
    const current = this.database.getDiagnosticAlertPolicy(projectPath) ?? {
      sessionCostBudgetUsd: null,
      minimumSeverity: "high",
      cooldownMinutes: 60,
    };
    const cooldownMinutes = Number(current.cooldownMinutes ?? 60);
    const snoozedUntil = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    const policy = this.database.upsertDiagnosticAlertPolicy(projectPath, {
      sessionCostBudgetUsd: current.sessionCostBudgetUsd ?? null,
      minimumSeverity: current.minimumSeverity ?? "high",
      cooldownMinutes,
      snoozedUntil,
    });
    this.diagnosticAlertCache.clear();
    return policy;
  }

  health() {
    const parserHealth = this.parser?.snapshot().health ?? null;
    const storage = this.database.getHealthStats();
    const ownership = storage.ownership ?? {};
    const degradedOwnership = Number(ownership.unresolvedRequests ?? 0) > 0;
    return {
      status: this.lastErrors.length || parserHealth?.status === "warning" || degradedOwnership
        ? "warning"
        : "healthy",
      observerMode: "rollout-file-observer",
      selectedSessionId: this.selectedSessionId,
      liveWatching: this.watchers.length > 0 || Boolean(this.pollTimer),
      lastUpdateAt: this.lastUpdateAt,
      repository: this.repository.summary(),
      projectionVersion: storage.projection?.version ?? null,
      projectionGeneration: storage.projection?.generation ?? 0,
      canonicalRequests: ownership.canonicalRequests ?? 0,
      inheritedRequestCopies: ownership.inheritedRequestCopies ?? 0,
      unresolvedRequests: ownership.unresolvedRequests ?? 0,
      canonicalTasks: ownership.canonicalTasks ?? 0,
      inheritedTaskCopies: ownership.inheritedTaskCopies ?? 0,
      unresolvedTasks: ownership.unresolvedTasks ?? 0,
      pricingProjectionVersion: pricingCatalogSummary().policyVersion ?? null,
      storage,
      timeline: {
        ...this.timelineStats,
        dirtySessions: this.timelineDirtySessions.size,
        projectionDirtySessions: this.timelineDirtySessions.size,
        indexQueueLength: this.timelineDirtySessions.size,
        activeIndexJobs: this.indexerPromise ? 1 : 0,
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
    if (this.pendingProcessPromise) return this.pendingProcessPromise;
    this.pendingProcessPromise = this.processPendingPathsInternal();
    try {
      return await this.pendingProcessPromise;
    } finally {
      this.pendingProcessPromise = null;
    }
  }

  async processPendingPathsInternal() {
    if (this.closed) return;
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
    if (this.closed || !this.parser || !this.selectedSessionId) return;
    const parsed = this.parser.snapshot();
    this.database.replaceSession(parsed, { persistQuotas: false });
    this.timelineDirtySessions.delete(this.selectedSessionId);
    this.timelineStats.dirtySessions = this.timelineDirtySessions.size;
    this.lastUpdateAt = new Date().toISOString();
    this.emit("update", { sessionId: this.selectedSessionId });
  }

  async reconcile() {
    if (this.closed) return;
    try {
      const additions = await this.repository.discoverNewFiles();
      for (const entry of additions) {
        this.markTimelineDirty(entry.rootSessionId);
        if (entry.rootSessionId === this.selectedSessionId) this.schedulePath(entry.path);
      }
      for (const entry of this.repository.allFiles()) {
        try {
          const fileStat = await stat(entry.path);
          if (
            fileStat.size !== entry.fileSize ||
            entry.modifiedAtMs == null ||
            Math.abs(fileStat.mtimeMs - entry.modifiedAtMs) >= 1
          ) {
            const refreshed = await this.repository.refreshFile(entry.path);
            if (refreshed) this.markTimelineDirty(refreshed.rootSessionId);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") this.recordError(`后台 stat 校验失败：${entry.path}`, error);
        }
      }
    } catch (error) {
      this.recordError("后台校验失败", error);
    }
  }

  async refreshQuotaNow() {
    return this.refreshQuotaFromOfficial({ emit: true, throwOnError: true });
  }

  async refreshQuotaFromOfficial({ emit = true, throwOnError = false } = {}) {
    if (this.quotaRefreshPromise) return this.quotaRefreshPromise;
    this.quotaRefreshPromise = (async () => {
      let candidate;
      try {
        candidate = await this.quotaClient.fetchQuota();
      } catch (error) {
        const isMissingAuth =
          error instanceof CodexUsageUnavailableError
          && error.code === "chatgpt_auth_unavailable";
        if (throwOnError) throw error;
        if (!isMissingAuth) this.recordError("官方 Codex Usage 额度查询失败", error);
        return this.quota();
      }
      this.database.saveQuota(candidate);
      this.currentQuota = reconcileRateLimitSnapshots(
        this.currentQuota,
        candidate,
      );
      const quota = this.quota();
      if (emit && quota) this.emit("quota", quota);
      return quota;
    })();
    try {
      return await this.quotaRefreshPromise;
    } finally {
      this.quotaRefreshPromise = null;
    }
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
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.quotaPollTimer) clearInterval(this.quotaPollTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.pendingPaths.clear();
    this.timelineDirtySessions.clear();
    this.timelineStats.dirtySessions = 0;
    const active = [
      this.pendingProcessPromise,
      this.selectionPromise,
      this.indexerPromise,
      this.quotaRefreshPromise,
    ].filter(Boolean);
    this.closePromise = Promise.allSettled(active).then(() => undefined);
    return this.closePromise;
  }
}

function hasImportedRequestProjection(indexState) {
  return Boolean(indexState?.requestLedgerReady && indexState.parseStatus !== "not_imported");
}

function diagnosticSeverityRank(value) {
  if (value === "high") return 2;
  if (value === "warning") return 1;
  return 0;
}

function diagnosticFindingAlert(sessionId, finding, acknowledgements) {
  const alertId = `alert_${finding.findingId}`;
  return {
    alertId,
    kind: "diagnostic_finding",
    severity: finding.severity,
    type: finding.type,
    family: finding.family ?? "local",
    findingId: finding.findingId,
    title: finding.type,
    observedAt: finding.observedAt ?? null,
    locator: finding.locator ?? finding.supportingLocator ?? null,
    acknowledgedAt: acknowledgements.get(alertId) ?? null,
    sessionId,
  };
}

function diagnosticBudgetAlert({
  sessionId,
  projectPath,
  budgetUsd,
  amountUsd,
  pricingPolicyVersion,
  acknowledgements,
}) {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionId, projectPath, budgetUsd, pricingPolicyVersion]))
    .digest("hex")
    .slice(0, 24);
  const alertId = `budget_${digest}`;
  return {
    alertId,
    kind: "session_cost_budget",
    severity: "high",
    type: "session_cost_budget",
    family: "operational",
    title: "Session 等值费用超过预算",
    budgetUsd,
    amountUsd,
    ratio: budgetUsd > 0 ? amountUsd / budgetUsd : null,
    pricingPolicyVersion,
    acknowledgedAt: acknowledgements.get(alertId) ?? null,
    sessionId,
  };
}

function compareDiagnosticAlerts(left, right) {
  const severity = diagnosticSeverityRank(right.severity) - diagnosticSeverityRank(left.severity);
  if (severity !== 0) return severity;
  return String(right.observedAt ?? "").localeCompare(String(left.observedAt ?? ""));
}

function materializeDiagnosticAlertReport(cacheEntry, { includeAcknowledged, stale }) {
  const visible = cacheEntry.allAlerts.filter(
    (alert) => includeAcknowledged || !alert.acknowledgedAt,
  );
  return {
    sessionId: cacheEntry.sessionId,
    projectPath: cacheEntry.projectPath,
    projectionGeneration: cacheEntry.projectionGeneration,
    stale,
    policy: cacheEntry.policy,
    snoozed: cacheEntry.snoozed,
    alerts: cacheEntry.snoozed ? [] : visible,
    suppressedBySnooze: cacheEntry.snoozed ? visible.length : 0,
    acknowledgedCount: cacheEntry.allAlerts.filter((alert) => alert.acknowledgedAt).length,
  };
}
