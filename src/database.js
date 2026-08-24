import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addUsage, sumTaskUsage } from "./usage.js";

const SCHEMA_VERSION = 6;

export class MonitorDatabase {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.path = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        source TEXT,
        project_path TEXT,
        created_at TEXT,
        updated_at TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        cli_version TEXT,
        rollout_path TEXT,
        parse_status TEXT NOT NULL DEFAULT 'not_imported',
        imported_at TEXT,
        agent_count INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION}
      );

      CREATE TABLE IF NOT EXISTS agents (
        root_session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        parent_thread_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        nickname TEXT,
        role TEXT,
        agent_path TEXT,
        rollout_path TEXT,
        is_root INTEGER NOT NULL DEFAULT 0,
        cli_version TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        own_usage TEXT NOT NULL,
        subtree_usage TEXT NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (root_session_id, thread_id),
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        root_session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        quality TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER,
        model TEXT,
        effort TEXT,
        baseline_usage TEXT,
        end_usage TEXT,
        delta_usage TEXT,
        source_path TEXT,
        start_ordinal INTEGER,
        end_ordinal INTEGER,
        start_line INTEGER,
        end_line INTEGER,
        start_byte INTEGER,
        end_byte INTEGER,
        PRIMARY KEY (thread_id, turn_id),
        FOREIGN KEY (root_session_id, thread_id)
          REFERENCES agents(root_session_id, thread_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quota_snapshots (
        observed_at TEXT NOT NULL,
        limit_id TEXT NOT NULL,
        plan_type TEXT,
        source_path TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (observed_at, limit_id)
      );

      CREATE TABLE IF NOT EXISTS ingest_cursors (
        path TEXT PRIMARY KEY,
        root_session_id TEXT,
        thread_id TEXT,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_number INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        modified_at_ms REAL,
        last_ordinal INTEGER,
        invalid_lines INTEGER NOT NULL DEFAULT 0,
        partial_bytes INTEGER NOT NULL DEFAULT 0,
        unknown_records INTEGER NOT NULL DEFAULT 0,
        skipped_records INTEGER NOT NULL DEFAULT 0,
        discontinuities INTEGER NOT NULL DEFAULT 0,
        last_usage TEXT,
        parsed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_root ON agents(root_session_id, depth, thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_session_id, thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_quota_observed ON quota_snapshots(observed_at DESC);
    `);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionColumns.some((column) => column.name === "project_path")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN project_path TEXT;");
    }
    const cursorColumns = this.db.prepare("PRAGMA table_info(ingest_cursors)").all();
    const addedWarningCounters = !cursorColumns.some((column) => column.name === "unknown_records") ||
      !cursorColumns.some((column) => column.name === "skipped_records");
    const addedUsageState = !cursorColumns.some((column) => column.name === "last_usage");
    const addedDiscontinuityState = !cursorColumns.some((column) => column.name === "discontinuities");
    if (!cursorColumns.some((column) => column.name === "line_number")) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN line_number INTEGER NOT NULL DEFAULT 0;");
    }
    if (!cursorColumns.some((column) => column.name === "unknown_records")) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN unknown_records INTEGER NOT NULL DEFAULT 0;");
    }
    if (!cursorColumns.some((column) => column.name === "skipped_records")) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN skipped_records INTEGER NOT NULL DEFAULT 0;");
    }
    if (addedUsageState) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN last_usage TEXT;");
    }
    if (addedDiscontinuityState) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN discontinuities INTEGER NOT NULL DEFAULT 0;");
    }
    if (addedWarningCounters || addedUsageState || addedDiscontinuityState) {
      // A pre-v5 cursor cannot prove that diagnostics or cumulative usage state were complete.
      // Invalidate non-empty offsets once so the parser safely replays and rebuilds them.
      this.db.exec("UPDATE ingest_cursors SET line_number=0 WHERE byte_offset>0;");
    }
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
    // Session names can be derived from prompt text. Keep them in the live read-only
    // repository index, never in the monitor's durable archive.
    this.db.exec("UPDATE sessions SET title='' WHERE title<>'';");

    this.statements = {
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (id, title, source, project_path, created_at, updated_at, archived, cli_version, rollout_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END,
          source=COALESCE(excluded.source, sessions.source),
          project_path=COALESCE(excluded.project_path, sessions.project_path),
          created_at=COALESCE(excluded.created_at, sessions.created_at),
          updated_at=COALESCE(excluded.updated_at, sessions.updated_at),
          archived=excluded.archived,
          cli_version=COALESCE(excluded.cli_version, sessions.cli_version),
          rollout_path=COALESCE(excluded.rollout_path, sessions.rollout_path)
      `),
      insertAgent: this.db.prepare(`
        INSERT INTO agents (
          root_session_id, thread_id, parent_thread_id, depth, nickname, role,
          agent_path, rollout_path, is_root, cli_version, first_seen_at, last_seen_at,
          own_usage, subtree_usage, task_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_session_id, thread_id) DO UPDATE SET
          parent_thread_id=COALESCE(excluded.parent_thread_id, agents.parent_thread_id),
          depth=excluded.depth,
          nickname=COALESCE(excluded.nickname, agents.nickname),
          role=COALESCE(excluded.role, agents.role),
          agent_path=COALESCE(excluded.agent_path, agents.agent_path),
          rollout_path=COALESCE(excluded.rollout_path, agents.rollout_path),
          is_root=excluded.is_root,
          cli_version=COALESCE(excluded.cli_version, agents.cli_version),
          first_seen_at=COALESCE(agents.first_seen_at, excluded.first_seen_at),
          last_seen_at=COALESCE(excluded.last_seen_at, agents.last_seen_at),
          own_usage=excluded.own_usage,
          subtree_usage=excluded.subtree_usage,
          task_count=excluded.task_count
      `),
      insertTask: this.db.prepare(`
        INSERT INTO tasks (
          root_session_id, thread_id, turn_id, sequence, status, quality,
          started_at, completed_at, duration_ms, model, effort,
          baseline_usage, end_usage, delta_usage, source_path,
          start_ordinal, end_ordinal, start_line, end_line, start_byte, end_byte
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          root_session_id=excluded.root_session_id,
          sequence=excluded.sequence,
          status=CASE
            WHEN tasks.status IN ('completed', 'interrupted') AND excluded.status='in_progress'
              THEN tasks.status
            ELSE excluded.status
          END,
          quality=CASE
            WHEN excluded.delta_usage IS NULL AND tasks.delta_usage IS NOT NULL THEN tasks.quality
            ELSE excluded.quality
          END,
          started_at=COALESCE(excluded.started_at, tasks.started_at),
          completed_at=COALESCE(excluded.completed_at, tasks.completed_at),
          duration_ms=COALESCE(excluded.duration_ms, tasks.duration_ms),
          model=COALESCE(excluded.model, tasks.model),
          effort=COALESCE(excluded.effort, tasks.effort),
          baseline_usage=COALESCE(excluded.baseline_usage, tasks.baseline_usage),
          end_usage=COALESCE(excluded.end_usage, tasks.end_usage),
          delta_usage=COALESCE(excluded.delta_usage, tasks.delta_usage),
          source_path=COALESCE(excluded.source_path, tasks.source_path),
          start_ordinal=COALESCE(excluded.start_ordinal, tasks.start_ordinal),
          end_ordinal=COALESCE(excluded.end_ordinal, tasks.end_ordinal),
          start_line=COALESCE(excluded.start_line, tasks.start_line),
          end_line=COALESCE(excluded.end_line, tasks.end_line),
          start_byte=COALESCE(excluded.start_byte, tasks.start_byte),
          end_byte=COALESCE(excluded.end_byte, tasks.end_byte)
      `),
      upsertCursor: this.db.prepare(`
        INSERT INTO ingest_cursors (
          path, root_session_id, thread_id, byte_offset, line_number, file_size,
          modified_at_ms, last_ordinal, invalid_lines, partial_bytes, unknown_records,
          skipped_records, discontinuities, last_usage, parsed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          root_session_id=excluded.root_session_id,
          thread_id=excluded.thread_id,
          byte_offset=excluded.byte_offset,
          line_number=excluded.line_number,
          file_size=excluded.file_size,
          modified_at_ms=excluded.modified_at_ms,
          last_ordinal=excluded.last_ordinal,
          invalid_lines=excluded.invalid_lines,
          partial_bytes=excluded.partial_bytes,
          unknown_records=excluded.unknown_records,
          skipped_records=excluded.skipped_records,
          discontinuities=excluded.discontinuities,
          last_usage=excluded.last_usage,
          parsed_at=excluded.parsed_at
      `),
      upsertQuota: this.db.prepare(`
        INSERT INTO quota_snapshots (observed_at, limit_id, plan_type, source_path, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(observed_at, limit_id) DO UPDATE SET payload=excluded.payload
      `),
    };
  }

  upsertSessions(sessions) {
    this.transaction(() => {
      for (const session of sessions) {
        this.statements.upsertSession.run(
          session.id,
          "",
          session.source ?? null,
          session.projectPath ?? null,
          session.createdAt ?? null,
          session.updatedAt ?? null,
          session.archived ? 1 : 0,
          session.cliVersion ?? null,
          session.rolloutPath ?? null,
        );
      }
    });
  }

  replaceSession(snapshot) {
    const rootId = snapshot.session.id;
    this.transaction(() => {
      this.statements.upsertSession.run(
        rootId,
        "",
        snapshot.session.source ?? null,
        snapshot.session.projectPath ?? null,
        snapshot.session.createdAt ?? null,
        snapshot.session.updatedAt ?? null,
        snapshot.session.archived ? 1 : 0,
        snapshot.session.cliVersion ?? null,
        snapshot.session.rolloutPath ?? null,
      );

      for (const agent of snapshot.agents) {
        this.statements.insertAgent.run(
          rootId,
          agent.threadId,
          agent.parentThreadId ?? null,
          agent.depth ?? 0,
          agent.nickname ?? null,
          agent.role ?? null,
          agent.agentPath ?? null,
          agent.rolloutPath ?? null,
          agent.isRoot ? 1 : 0,
          agent.cliVersion ?? null,
          agent.firstSeenAt ?? null,
          agent.lastSeenAt ?? null,
          json(agent.ownUsage),
          json(agent.subtreeUsage),
          agent.taskCount ?? 0,
        );
      }

      for (const task of snapshot.tasks) {
        this.statements.insertTask.run(
          rootId,
          task.threadId,
          task.turnId,
          task.sequence,
          task.status,
          task.quality,
          task.startedAt ?? null,
          task.completedAt ?? null,
          task.durationMs ?? null,
          task.model ?? null,
          task.effort ?? null,
          jsonOrNull(task.baselineUsage),
          jsonOrNull(task.endUsage),
          jsonOrNull(task.deltaUsage),
          task.sourcePath ?? null,
          task.startOrdinal ?? null,
          task.endOrdinal ?? null,
          task.startLine ?? null,
          task.endLine ?? null,
          task.startByte ?? null,
          task.endByte ?? null,
        );
      }

      for (const cursor of snapshot.cursors) {
        this.statements.upsertCursor.run(
          cursor.path,
          rootId,
          cursor.threadId ?? null,
          cursor.byteOffset,
          cursor.lineNumber ?? 0,
          cursor.fileSize,
          cursor.modifiedAtMs ?? null,
          cursor.lastOrdinal ?? null,
          cursor.invalidLines ?? 0,
          cursor.partialBytes ?? 0,
          cursor.unknownRecords ?? 0,
          cursor.skippedRecords ?? 0,
          cursor.discontinuities ?? 0,
          jsonOrNull(cursor.lastUsage),
          new Date().toISOString(),
        );
      }

      const counts = this.refreshAggregates(rootId);

      this.db.prepare(`
        UPDATE sessions SET parse_status=?, imported_at=?, agent_count=?, task_count=?, parser_version=?
        WHERE id=?
      `).run(
        snapshot.health.status,
        new Date().toISOString(),
        counts.agents,
        counts.tasks,
        SCHEMA_VERSION,
        rootId,
      );
    });

    for (const quota of snapshot.quotas ?? []) this.saveQuota(quota);
  }

  saveQuota(quota) {
    if (!quota) return;
    this.statements.upsertQuota.run(
      quota.observedAt,
      quota.limitId,
      quota.planType ?? null,
      quota.sourcePath ?? null,
      json(quota),
    );
  }

  listSessions() {
    return this.db.prepare(`
      SELECT id, title, source, created_at, updated_at, archived, cli_version,
             project_path, rollout_path, parse_status, imported_at, agent_count, task_count
      FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC
    `).all().map(mapSession);
  }

  getSession(id) {
    const sessionRow = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!sessionRow) return null;
    const agents = this.db.prepare(`
      SELECT * FROM agents WHERE root_session_id=? ORDER BY depth, first_seen_at, thread_id
    `).all(id).map(mapAgent);
    const tasks = this.db.prepare(`
      SELECT * FROM tasks WHERE root_session_id=? ORDER BY thread_id, sequence
    `).all(id).map(mapTask);
    return { session: mapSession(sessionRow), agents, tasks };
  }

  getTask(threadId, turnId) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE thread_id=? AND turn_id=?").get(threadId, turnId);
    return row ? mapTask(row) : null;
  }

  getCursors(rootSessionId) {
    return this.db.prepare(`
      SELECT path, root_session_id, thread_id, byte_offset, line_number, file_size,
             modified_at_ms, last_ordinal, invalid_lines, partial_bytes, unknown_records,
             skipped_records, discontinuities, last_usage, parsed_at
      FROM ingest_cursors WHERE root_session_id=? ORDER BY path
    `).all(rootSessionId).map((row) => ({
      path: row.path,
      rootSessionId: row.root_session_id ?? null,
      threadId: row.thread_id ?? null,
      byteOffset: Number(row.byte_offset ?? 0),
      lineNumber: Number(row.line_number ?? 0),
      fileSize: Number(row.file_size ?? 0),
      modifiedAtMs: row.modified_at_ms == null ? null : Number(row.modified_at_ms),
      lastOrdinal: row.last_ordinal == null ? null : Number(row.last_ordinal),
      invalidLines: Number(row.invalid_lines ?? 0),
      partialBytes: Number(row.partial_bytes ?? 0),
      unknownRecords: Number(row.unknown_records ?? 0),
      skippedRecords: Number(row.skipped_records ?? 0),
      discontinuities: Number(row.discontinuities ?? 0),
      lastUsage: parseJson(row.last_usage),
      parsedAt: row.parsed_at ?? null,
    }));
  }

  getLatestQuota() {
    const row = this.db.prepare(`
      SELECT payload FROM quota_snapshots ORDER BY observed_at DESC LIMIT 1
    `).get();
    return row ? parseJson(row.payload) : null;
  }

  getHealthStats() {
    const cursors = this.db.prepare(`
      SELECT COUNT(*) AS files, COALESCE(SUM(invalid_lines), 0) AS invalid_lines,
             COALESCE(SUM(partial_bytes), 0) AS partial_bytes,
             COALESCE(SUM(unknown_records), 0) AS unknown_records,
             COALESCE(SUM(skipped_records), 0) AS skipped_records,
             COALESCE(SUM(discontinuities), 0) AS discontinuities,
             MAX(parsed_at) AS last_parsed_at
      FROM ingest_cursors
    `).get();
    return {
      databasePath: this.path,
      schemaVersion: SCHEMA_VERSION,
      indexedFiles: Number(cursors.files),
      invalidLines: Number(cursors.invalid_lines),
      partialBytes: Number(cursors.partial_bytes),
      unknownRecords: Number(cursors.unknown_records),
      skippedRecords: Number(cursors.skipped_records),
      discontinuities: Number(cursors.discontinuities),
      lastParsedAt: cursors.last_parsed_at ?? null,
    };
  }

  refreshAggregates(rootId) {
    const agentRows = this.db.prepare(`
      SELECT thread_id, parent_thread_id, depth FROM agents WHERE root_session_id=?
    `).all(rootId);
    const taskRows = this.db.prepare(`
      SELECT * FROM tasks WHERE root_session_id=? ORDER BY thread_id, sequence
    `).all(rootId).map(mapTask);
    const tasksByThread = new Map();
    for (const task of taskRows) {
      if (!tasksByThread.has(task.threadId)) tasksByThread.set(task.threadId, []);
      tasksByThread.get(task.threadId).push(task);
    }

    const summaries = new Map(agentRows.map((row) => {
      const ownUsage = sumTaskUsage(tasksByThread.get(row.thread_id) ?? []);
      return [row.thread_id, {
        threadId: row.thread_id,
        parentThreadId: row.parent_thread_id ?? null,
        depth: Number(row.depth ?? 0),
        ownUsage,
        subtreeUsage: structuredClone(ownUsage),
        taskCount: tasksByThread.get(row.thread_id)?.length ?? 0,
      }];
    }));
    for (const summary of [...summaries.values()].sort((a, b) => b.depth - a.depth)) {
      const parent = summaries.get(summary.parentThreadId);
      if (parent) parent.subtreeUsage = addUsage(parent.subtreeUsage, summary.subtreeUsage);
    }

    const update = this.db.prepare(`
      UPDATE agents SET own_usage=?, subtree_usage=?, task_count=?
      WHERE root_session_id=? AND thread_id=?
    `);
    for (const summary of summaries.values()) {
      update.run(
        json(summary.ownUsage),
        json(summary.subtreeUsage),
        summary.taskCount,
        rootId,
        summary.threadId,
      );
    }
    return { agents: agentRows.length, tasks: taskRows.length };
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      callback();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

function mapSession(row) {
  return {
    id: row.id,
    title: row.title ?? "",
    source: row.source ?? null,
    projectPath: row.project_path ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    archived: Boolean(row.archived),
    cliVersion: row.cli_version ?? null,
    rolloutPath: row.rollout_path ?? null,
    parseStatus: row.parse_status ?? "not_imported",
    importedAt: row.imported_at ?? null,
    agentCount: Number(row.agent_count ?? 0),
    taskCount: Number(row.task_count ?? 0),
  };
}

function mapAgent(row) {
  return {
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    parentThreadId: row.parent_thread_id ?? null,
    depth: Number(row.depth ?? 0),
    nickname: row.nickname ?? null,
    role: row.role ?? null,
    agentPath: row.agent_path ?? null,
    rolloutPath: row.rollout_path ?? null,
    isRoot: Boolean(row.is_root),
    cliVersion: row.cli_version ?? null,
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    ownUsage: parseJson(row.own_usage),
    subtreeUsage: parseJson(row.subtree_usage),
    taskCount: Number(row.task_count ?? 0),
  };
}

function mapTask(row) {
  return {
    rootSessionId: row.root_session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sequence: Number(row.sequence),
    status: row.status,
    quality: row.quality,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    model: row.model ?? null,
    effort: row.effort ?? null,
    baselineUsage: parseJson(row.baseline_usage),
    endUsage: parseJson(row.end_usage),
    deltaUsage: parseJson(row.delta_usage),
    sourcePath: row.source_path ?? null,
    startOrdinal: row.start_ordinal == null ? null : Number(row.start_ordinal),
    endOrdinal: row.end_ordinal == null ? null : Number(row.end_ordinal),
    startLine: row.start_line == null ? null : Number(row.start_line),
    endLine: row.end_line == null ? null : Number(row.end_line),
    startByte: row.start_byte == null ? null : Number(row.start_byte),
    endByte: row.end_byte == null ? null : Number(row.end_byte),
  };
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export { SCHEMA_VERSION };
