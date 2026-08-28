import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { materializeRequestLedgerTasks } from "./request-ledger.js";
import { resolveCanonicalRequestOwnership } from "./request-ownership.js";
import { combineCostSummaries, SUBSCRIPTION_PRICING_CATALOG } from "./pricing.js";
import { materializeCalendarSlices } from "./snapshot-scope.js";
import { recoverLegacySourceKey } from "./source-locator.js";
import { addUsage, normalizeTimestamp, sumTaskUsage, USAGE_FIELDS, zeroUsage } from "./usage.js";

const SCHEMA_VERSION = 14;
const REQUEST_LEDGER_SCHEMA_VERSION = 9;
const PARSER_VERSION = 15;
const PROJECTION_VERSION = 2;
const QUALITY_KEYS = ["complete", "provisional", "partial", "unknown"];

export class MonitorDatabase {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.path = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA cache_size=-2000;
      PRAGMA mmap_size=0;
      PRAGMA wal_autocheckpoint=256;
      PRAGMA journal_size_limit=2097152;
    `);
    this.migrate();
  }

  migrate() {
    const previousVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version ?? 0);
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
        rollout_key TEXT,
        rollout_path TEXT,
        parse_status TEXT NOT NULL DEFAULT 'not_imported',
        imported_at TEXT,
        agent_count INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER NOT NULL DEFAULT ${PARSER_VERSION}
      );

      CREATE TABLE IF NOT EXISTS agents (
        root_session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        parent_thread_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        nickname TEXT,
        role TEXT,
        agent_path TEXT,
        rollout_key TEXT,
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
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER,
        model TEXT,
        effort TEXT,
        source_key TEXT,
        source_path TEXT,
        start_ordinal INTEGER,
        end_ordinal INTEGER,
        start_line INTEGER,
        end_line INTEGER,
        start_byte INTEGER,
        end_byte INTEGER,
        zero_usage_verified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, turn_id),
        FOREIGN KEY (root_session_id, thread_id)
          REFERENCES agents(root_session_id, thread_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quota_snapshots (
        observed_at TEXT NOT NULL,
        limit_id TEXT NOT NULL,
        plan_type TEXT,
        source_key TEXT,
        source_path TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (observed_at, limit_id)
      );

      CREATE TABLE IF NOT EXISTS ingest_cursors (
        source_key TEXT NOT NULL PRIMARY KEY,
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
        pricing_context TEXT,
        parsed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_day_usage (
        day TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        model_request_count INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        active_task_count INTEGER NOT NULL DEFAULT 0,
        complete_count INTEGER NOT NULL DEFAULT 0,
        provisional_count INTEGER NOT NULL DEFAULT 0,
        partial_count INTEGER NOT NULL DEFAULT 0,
        unknown_count INTEGER NOT NULL DEFAULT 0,
        cost_amount_usd REAL,
        cost_status TEXT,
        estimated_tasks INTEGER NOT NULL DEFAULT 0,
        partial_tasks INTEGER NOT NULL DEFAULT 0,
        unavailable_tasks INTEGER NOT NULL DEFAULT 0,
        estimated_requests INTEGER NOT NULL DEFAULT 0,
        partial_requests INTEGER NOT NULL DEFAULT 0,
        unavailable_requests INTEGER NOT NULL DEFAULT 0,
        cost_feature_coverage TEXT,
        pricing_policy_version TEXT,
        projection_version INTEGER NOT NULL DEFAULT ${PROJECTION_VERSION},
        PRIMARY KEY (day, root_session_id),
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS model_usage_events (
        source_key TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        root_session_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        event_ordinal INTEGER,
        observed_at TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        classification TEXT NOT NULL,
        quality TEXT NOT NULL,
        reason TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        model TEXT,
        service_tier TEXT,
        pricing_context_quality TEXT,
        request_identity TEXT,
        request_identity_kind TEXT,
        request_identity_reason TEXT,
        request_native_field TEXT,
        PRIMARY KEY (source_key, line_number),
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_ownership (
        root_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        owner_thread_id TEXT,
        status TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        PRIMARY KEY (root_session_id, turn_id),
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS event_ownership (
        source_key TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        root_session_id TEXT NOT NULL,
        owner_thread_id TEXT,
        status TEXT NOT NULL,
        canonical_request_id TEXT,
        PRIMARY KEY (source_key, line_number),
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS canonical_requests (
        request_id TEXT PRIMARY KEY,
        root_session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_ordinal INTEGER,
        observed_at TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        classification TEXT NOT NULL,
        quality TEXT NOT NULL,
        reason TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        model TEXT,
        service_tier TEXT,
        pricing_context_quality TEXT,
        identity_kind TEXT NOT NULL,
        native_field TEXT,
        origin_source_key TEXT NOT NULL,
        origin_line_number INTEGER NOT NULL,
        FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS derived_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_root ON agents(root_session_id, depth, thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_session_id, thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_tasks_unattributed ON tasks(root_session_id)
        WHERE started_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_session_day_usage_day
        ON session_day_usage(day DESC, total_tokens DESC, root_session_id);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_root
        ON model_usage_events(root_session_id, thread_id, turn_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_root_observed
        ON model_usage_events(root_session_id, observed_at, classification);
      CREATE INDEX IF NOT EXISTS idx_model_usage_events_observed
        ON model_usage_events(observed_at, classification);
      CREATE INDEX IF NOT EXISTS idx_task_ownership_root_status
        ON task_ownership(root_session_id, status, owner_thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_event_ownership_root_status
        ON event_ownership(root_session_id, status, owner_thread_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_requests_root_day
        ON canonical_requests(root_session_id, observed_at, turn_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_requests_task_observed
        ON canonical_requests(root_session_id, thread_id, turn_id, observed_at, request_id);
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
    if (!cursorColumns.some((column) => column.name === "pricing_context")) {
      this.db.exec("ALTER TABLE ingest_cursors ADD COLUMN pricing_context TEXT;");
    }
    if (addedWarningCounters || addedUsageState || addedDiscontinuityState) {
      // A pre-v5 cursor cannot prove that diagnostics or cumulative usage state were complete.
      // Invalidate non-empty offsets once so the parser safely replays and rebuilds them.
      this.db.exec("UPDATE ingest_cursors SET line_number=0 WHERE byte_offset>0;");
    }

    const calendarColumns = this.db.prepare("PRAGMA table_info(session_day_usage)").all();
    if (!calendarColumns.some((column) => column.name === "model_request_count")) {
      this.db.exec("ALTER TABLE session_day_usage ADD COLUMN model_request_count INTEGER NOT NULL DEFAULT 0;");
    }
    const calendarProjectionColumns = [
      ["cost_amount_usd", "REAL"],
      ["cost_status", "TEXT"],
      ["estimated_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["partial_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["unavailable_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["estimated_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["partial_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["unavailable_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["cost_feature_coverage", "TEXT"],
      ["pricing_policy_version", "TEXT"],
      ["projection_version", `INTEGER NOT NULL DEFAULT ${PROJECTION_VERSION}`],
    ];
    for (const [name, definition] of calendarProjectionColumns) {
      if (!calendarColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE session_day_usage ADD COLUMN ${name} ${definition};`);
      }
    }

    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "zero_usage_verified")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN zero_usage_verified INTEGER NOT NULL DEFAULT 0;");
    }

    const usageEventColumns = this.db.prepare("PRAGMA table_info(model_usage_events)").all();
    if (!usageEventColumns.some((column) => column.name === "model")) {
      this.db.exec("ALTER TABLE model_usage_events ADD COLUMN model TEXT;");
    }
    if (!usageEventColumns.some((column) => column.name === "service_tier")) {
      this.db.exec("ALTER TABLE model_usage_events ADD COLUMN service_tier TEXT;");
    }
    if (!usageEventColumns.some((column) => column.name === "pricing_context_quality")) {
      this.db.exec("ALTER TABLE model_usage_events ADD COLUMN pricing_context_quality TEXT;");
    }
    for (const [name, definition] of [
      ["request_identity", "TEXT"],
      ["request_identity_kind", "TEXT"],
      ["request_identity_reason", "TEXT"],
      ["request_native_field", "TEXT"],
    ]) {
      if (!usageEventColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE model_usage_events ADD COLUMN ${name} ${definition};`);
      }
    }

    const eventOwnershipColumns = this.db.prepare("PRAGMA table_info(event_ownership)").all();
    if (!eventOwnershipColumns.some((column) => column.name === "canonical_request_id")) {
      this.db.exec("ALTER TABLE event_ownership ADD COLUMN canonical_request_id TEXT;");
    }

    if (previousVersion < 8) this.migratePortableSourceLocators();
    if (previousVersion < 11) this.retireBoundaryLedgerStorage();
    this.ensurePhase18ProjectionColumns();
    if (previousVersion < 12) this.normalizeStoredUsageEventTimestamps();

    const timezone = localTimezone();
    const storedTimezone = this.db.prepare("SELECT value FROM derived_state WHERE key='calendar_timezone'").get()?.value;
    const storedProjectionVersion = Number(
      this.db.prepare("SELECT value FROM derived_state WHERE key='projection_version'").get()?.value ?? 0,
    );
    const storedPricingPolicyVersion = this.db.prepare(
      "SELECT value FROM derived_state WHERE key='pricing_policy_version'",
    ).get()?.value ?? null;
    if (
      previousVersion < 14 ||
      storedTimezone !== timezone ||
      storedProjectionVersion !== PROJECTION_VERSION ||
      storedPricingPolicyVersion !== SUBSCRIPTION_PRICING_CATALOG.policyVersion
    ) {
      this.rebuildAllCanonicalProjections();
    }
    if (previousVersion < 11) {
      const roots = this.db.prepare("SELECT id FROM sessions").all();
      for (const row of roots) this.refreshAggregates(row.id);
    }
    this.db.prepare(`
      INSERT INTO derived_state (key, value) VALUES ('calendar_timezone', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(timezone);
    this.db.prepare(`
      INSERT INTO derived_state (key, value) VALUES ('projection_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(PROJECTION_VERSION));
    this.db.prepare(`
      INSERT INTO derived_state (key, value) VALUES ('pricing_policy_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(SUBSCRIPTION_PRICING_CATALOG.policyVersion);
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
    // Session names can be derived from prompt text. Keep them in the live read-only
    // repository index, never in the monitor's durable archive.
    this.db.exec("UPDATE sessions SET title='' WHERE title<>'';");

    this.statements = {
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (id, title, source, project_path, created_at, updated_at, archived, cli_version, rollout_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END,
          source=COALESCE(excluded.source, sessions.source),
          project_path=COALESCE(excluded.project_path, sessions.project_path),
          created_at=COALESCE(excluded.created_at, sessions.created_at),
          updated_at=COALESCE(excluded.updated_at, sessions.updated_at),
          archived=excluded.archived,
          cli_version=COALESCE(excluded.cli_version, sessions.cli_version),
          rollout_key=COALESCE(excluded.rollout_key, sessions.rollout_key)
      `),
      insertAgent: this.db.prepare(`
        INSERT INTO agents (
          root_session_id, thread_id, parent_thread_id, depth, nickname, role,
          agent_path, rollout_key, is_root, cli_version, first_seen_at, last_seen_at,
          own_usage, subtree_usage, task_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_session_id, thread_id) DO UPDATE SET
          parent_thread_id=COALESCE(excluded.parent_thread_id, agents.parent_thread_id),
          depth=excluded.depth,
          nickname=COALESCE(excluded.nickname, agents.nickname),
          role=COALESCE(excluded.role, agents.role),
          agent_path=COALESCE(excluded.agent_path, agents.agent_path),
          rollout_key=COALESCE(excluded.rollout_key, agents.rollout_key),
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
          root_session_id, thread_id, turn_id, sequence, status,
          started_at, completed_at, duration_ms, model, effort, source_key,
          start_ordinal, end_ordinal, start_line, end_line, start_byte, end_byte,
          zero_usage_verified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          root_session_id=excluded.root_session_id,
          sequence=excluded.sequence,
          status=CASE
            WHEN tasks.status IN ('completed', 'interrupted') AND excluded.status='in_progress'
              THEN tasks.status
            ELSE excluded.status
          END,
          started_at=COALESCE(excluded.started_at, tasks.started_at),
          completed_at=COALESCE(excluded.completed_at, tasks.completed_at),
          duration_ms=COALESCE(excluded.duration_ms, tasks.duration_ms),
          model=COALESCE(excluded.model, tasks.model),
          effort=COALESCE(excluded.effort, tasks.effort),
          source_key=COALESCE(excluded.source_key, tasks.source_key),
          start_ordinal=COALESCE(excluded.start_ordinal, tasks.start_ordinal),
          end_ordinal=COALESCE(excluded.end_ordinal, tasks.end_ordinal),
          start_line=COALESCE(excluded.start_line, tasks.start_line),
          end_line=COALESCE(excluded.end_line, tasks.end_line),
          start_byte=COALESCE(excluded.start_byte, tasks.start_byte),
          end_byte=COALESCE(excluded.end_byte, tasks.end_byte),
          zero_usage_verified=excluded.zero_usage_verified
      `),
      upsertCursor: this.db.prepare(`
        INSERT INTO ingest_cursors (
          source_key, root_session_id, thread_id, byte_offset, line_number, file_size,
          modified_at_ms, last_ordinal, invalid_lines, partial_bytes, unknown_records,
          skipped_records, discontinuities, last_usage, pricing_context, parsed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
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
          pricing_context=excluded.pricing_context,
          parsed_at=excluded.parsed_at
      `),
      upsertQuota: this.db.prepare(`
        INSERT INTO quota_snapshots (observed_at, limit_id, plan_type, source_key, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(observed_at, limit_id) DO UPDATE SET
          plan_type=excluded.plan_type,
          source_key=COALESCE(excluded.source_key, quota_snapshots.source_key),
          payload=excluded.payload
      `),
      upsertModelUsageEvent: this.db.prepare(`
        INSERT INTO model_usage_events (
          source_key, line_number, root_session_id, thread_id, turn_id,
          event_ordinal, observed_at, generation, classification, quality, reason,
          input_tokens, cached_input_tokens, cache_write_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens,
          model, service_tier, pricing_context_quality,
          request_identity, request_identity_kind, request_identity_reason, request_native_field
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key, line_number) DO UPDATE SET
          root_session_id=excluded.root_session_id,
          thread_id=excluded.thread_id,
          turn_id=excluded.turn_id,
          event_ordinal=excluded.event_ordinal,
          observed_at=excluded.observed_at,
          generation=excluded.generation,
          classification=excluded.classification,
          quality=excluded.quality,
          reason=excluded.reason,
          input_tokens=excluded.input_tokens,
          cached_input_tokens=excluded.cached_input_tokens,
          cache_write_input_tokens=excluded.cache_write_input_tokens,
          output_tokens=excluded.output_tokens,
          reasoning_output_tokens=excluded.reasoning_output_tokens,
          total_tokens=excluded.total_tokens,
          model=excluded.model,
          service_tier=excluded.service_tier,
          pricing_context_quality=excluded.pricing_context_quality,
          request_identity=excluded.request_identity,
          request_identity_kind=excluded.request_identity_kind,
          request_identity_reason=excluded.request_identity_reason,
          request_native_field=excluded.request_native_field
      `),
    };
  }

  ensurePhase18ProjectionColumns() {
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "zero_usage_verified")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN zero_usage_verified INTEGER NOT NULL DEFAULT 0;");
    }
    const calendarColumns = this.db.prepare("PRAGMA table_info(session_day_usage)").all();
    const definitions = [
      ["cost_amount_usd", "REAL"],
      ["cost_status", "TEXT"],
      ["estimated_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["partial_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["unavailable_tasks", "INTEGER NOT NULL DEFAULT 0"],
      ["estimated_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["partial_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["unavailable_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["cost_feature_coverage", "TEXT"],
      ["pricing_policy_version", "TEXT"],
      ["projection_version", `INTEGER NOT NULL DEFAULT ${PROJECTION_VERSION}`],
    ];
    for (const [name, definition] of definitions) {
      if (!calendarColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE session_day_usage ADD COLUMN ${name} ${definition};`);
      }
    }
  }

  migratePortableSourceLocators() {
    const locatorColumns = [
      ["sessions", "rollout_key", "rollout_path"],
      ["agents", "rollout_key", "rollout_path"],
      ["tasks", "source_key", "source_path"],
      ["quota_snapshots", "source_key", "source_path"],
    ];
    for (const [table, keyColumn] of locatorColumns) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === keyColumn)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${keyColumn} TEXT;`);
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, keyColumn, pathColumn] of locatorColumns) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((column) => column.name === pathColumn)) continue;
        const rows = this.db.prepare(`
          SELECT rowid AS row_id, ${keyColumn} AS source_key, ${pathColumn} AS legacy_path
          FROM ${table}
          WHERE ${keyColumn} IS NOT NULL OR ${pathColumn} IS NOT NULL
        `).all();
        const update = this.db.prepare(`UPDATE ${table} SET ${keyColumn}=?, ${pathColumn}=NULL WHERE rowid=?`);
        for (const row of rows) {
          const sourceKey = recoverLegacySourceKey(row.source_key) ?? recoverLegacySourceKey(row.legacy_path);
          update.run(sourceKey, row.row_id);
        }
      }

      const quotaRows = this.db.prepare(`
        SELECT rowid AS row_id, source_key, payload FROM quota_snapshots
      `).all();
      const updateQuota = this.db.prepare(`
        UPDATE quota_snapshots SET source_key=?, source_path=NULL, payload=? WHERE rowid=?
      `);
      for (const row of quotaRows) {
        const payload = parseJson(row.payload) ?? {};
        const sourceKey =
          recoverLegacySourceKey(row.source_key) ??
          recoverLegacySourceKey(payload.sourceKey) ??
          recoverLegacySourceKey(payload.sourcePath);
        delete payload.sourcePath;
        if (sourceKey) payload.sourceKey = sourceKey;
        else delete payload.sourceKey;
        updateQuota.run(sourceKey, json(payload), row.row_id);
      }

      const cursorColumns = this.db.prepare("PRAGMA table_info(ingest_cursors)").all();
      if (cursorColumns.some((column) => column.name === "path")) {
        const legacyRows = this.db.prepare("SELECT * FROM ingest_cursors ORDER BY parsed_at, path").all();
        this.db.exec(`
          DROP TABLE IF EXISTS ingest_cursors_v8;
          CREATE TABLE ingest_cursors_v8 (
            source_key TEXT NOT NULL PRIMARY KEY,
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
            pricing_context TEXT,
            parsed_at TEXT NOT NULL
          );
        `);
        const insertCursor = this.db.prepare(`
          INSERT OR REPLACE INTO ingest_cursors_v8 (
            source_key, root_session_id, thread_id, byte_offset, line_number, file_size,
            modified_at_ms, last_ordinal, invalid_lines, partial_bytes, unknown_records,
            skipped_records, discontinuities, last_usage, pricing_context, parsed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of legacyRows) {
          const sourceKey = recoverLegacySourceKey(row.source_key) ?? recoverLegacySourceKey(row.path);
          if (!sourceKey) continue;
          insertCursor.run(
            sourceKey,
            row.root_session_id ?? null,
            row.thread_id ?? null,
            Number(row.byte_offset ?? 0),
            Number(row.line_number ?? 0),
            Number(row.file_size ?? 0),
            row.modified_at_ms ?? null,
            row.last_ordinal ?? null,
            Number(row.invalid_lines ?? 0),
            Number(row.partial_bytes ?? 0),
            Number(row.unknown_records ?? 0),
            Number(row.skipped_records ?? 0),
            Number(row.discontinuities ?? 0),
            row.last_usage ?? null,
            row.pricing_context ?? null,
            row.parsed_at ?? new Date(0).toISOString(),
          );
        }
        this.db.exec(`
          DROP TABLE ingest_cursors;
          ALTER TABLE ingest_cursors_v8 RENAME TO ingest_cursors;
        `);
      }

      this.db.prepare(`
        INSERT INTO derived_state (key, value) VALUES ('source_locator_layout', 'codex-relative-v1')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retireBoundaryLedgerStorage() {
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    const hasBoundaryTaskColumns = taskColumns.some((column) => [
      "quality",
      "baseline_usage",
      "end_usage",
      "delta_usage",
      "delta_input_tokens",
      "delta_cached_input_tokens",
      "delta_cache_write_input_tokens",
      "delta_output_tokens",
      "delta_reasoning_output_tokens",
      "delta_total_tokens",
    ].includes(column.name));
    const calendarColumns = this.db.prepare("PRAGMA table_info(session_day_usage)").all();
    const hasBoundaryCalendarColumns = calendarColumns.some((column) =>
      column.name === "estimated_count" || column.name === "discontinuity_count"
    );
    if (!hasBoundaryTaskColumns && !hasBoundaryCalendarColumns) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasBoundaryTaskColumns) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_tasks_root;
          DROP INDEX IF EXISTS idx_tasks_unattributed;
          ALTER TABLE tasks RENAME TO tasks_boundary_v10;
          CREATE TABLE tasks (
            root_session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            duration_ms INTEGER,
            model TEXT,
            effort TEXT,
            source_key TEXT,
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
          INSERT INTO tasks (
            root_session_id, thread_id, turn_id, sequence, status,
            started_at, completed_at, duration_ms, model, effort,
            source_key, source_path, start_ordinal, end_ordinal,
            start_line, end_line, start_byte, end_byte
          )
          SELECT
            root_session_id, thread_id, turn_id, sequence, status,
            started_at, completed_at, duration_ms, model, effort,
            source_key, source_path, start_ordinal, end_ordinal,
            start_line, end_line, start_byte, end_byte
          FROM tasks_boundary_v10;
          DROP TABLE tasks_boundary_v10;
          CREATE INDEX idx_tasks_root ON tasks(root_session_id, thread_id, sequence);
          CREATE INDEX idx_tasks_unattributed ON tasks(root_session_id)
            WHERE started_at IS NULL;
        `);
      }

      if (hasBoundaryCalendarColumns) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_session_day_usage_day;
          ALTER TABLE session_day_usage RENAME TO session_day_usage_v10;
          CREATE TABLE session_day_usage (
            day TEXT NOT NULL,
            root_session_id TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cached_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            model_request_count INTEGER NOT NULL DEFAULT 0,
            task_count INTEGER NOT NULL DEFAULT 0,
            active_task_count INTEGER NOT NULL DEFAULT 0,
            complete_count INTEGER NOT NULL DEFAULT 0,
            provisional_count INTEGER NOT NULL DEFAULT 0,
            partial_count INTEGER NOT NULL DEFAULT 0,
            unknown_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, root_session_id),
            FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          INSERT INTO session_day_usage (
            day, root_session_id,
            input_tokens, cached_input_tokens, cache_write_input_tokens,
            output_tokens, reasoning_output_tokens, total_tokens,
            model_request_count, task_count, active_task_count,
            complete_count, provisional_count, partial_count, unknown_count
          )
          SELECT
            day, root_session_id,
            input_tokens, cached_input_tokens, cache_write_input_tokens,
            output_tokens, reasoning_output_tokens, total_tokens,
            model_request_count, task_count, active_task_count,
            complete_count, provisional_count, partial_count, unknown_count
          FROM session_day_usage_v10;
          DROP TABLE session_day_usage_v10;
          CREATE INDEX idx_session_day_usage_day
            ON session_day_usage(day DESC, total_tokens DESC, root_session_id);
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
          session.rolloutKey ?? recoverLegacySourceKey(session.rolloutPath) ?? null,
        );
      }
    });
  }

  replaceSession(snapshot, { persistQuotas = true } = {}) {
    const rootId = snapshot.session.id;
    const authoritativeSourceKeys = [...new Set([
      ...(snapshot.cursors ?? [])
        .map((cursor) => cursor.sourceKey ?? recoverLegacySourceKey(cursor.path)),
      ...(snapshot.modelUsageEvents ?? [])
        .map((event) => event?.sourceKey ?? recoverLegacySourceKey(event?.sourcePath)),
    ].filter(Boolean))];
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
        snapshot.session.rolloutKey ?? recoverLegacySourceKey(snapshot.session.rolloutPath) ?? null,
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
          agent.rolloutKey ?? recoverLegacySourceKey(agent.rolloutPath) ?? null,
          agent.isRoot ? 1 : 0,
          agent.cliVersion ?? null,
          agent.firstSeenAt ?? null,
          agent.lastSeenAt ?? null,
          json(zeroUsage()),
          json(zeroUsage()),
          agent.taskCount ?? 0,
        );
      }

      // A source that is present in the current parser snapshot is authoritative:
      // remove its previous derived Task/Event rows before writing the new parse.
      // Rows whose source is absent are deliberately preserved as historical evidence.
      const deleteTasksForSource = this.db.prepare(`
        DELETE FROM tasks WHERE root_session_id=? AND source_key=?
      `);
      const deleteEventsForSource = this.db.prepare(`
        DELETE FROM model_usage_events WHERE root_session_id=? AND source_key=?
      `);
      for (const sourceKey of authoritativeSourceKeys) {
        deleteTasksForSource.run(rootId, sourceKey);
        deleteEventsForSource.run(rootId, sourceKey);
      }

      for (const task of snapshot.tasks) {
        this.statements.insertTask.run(
          rootId,
          task.threadId,
          task.turnId,
          task.sequence,
          task.status,
          task.startedAt ?? null,
          task.completedAt ?? null,
          task.durationMs ?? null,
          task.model ?? null,
          task.effort ?? null,
          task.sourceKey ?? recoverLegacySourceKey(task.sourcePath) ?? null,
          task.startOrdinal ?? null,
          task.endOrdinal ?? null,
          task.startLine ?? null,
          task.endLine ?? null,
          task.startByte ?? null,
          task.endByte ?? null,
          task.zeroUsageVerified ? 1 : 0,
        );
      }

      for (const cursor of snapshot.cursors) {
        const sourceKey = cursor.sourceKey ?? recoverLegacySourceKey(cursor.path);
        if (!sourceKey) continue;
        this.statements.upsertCursor.run(
          sourceKey,
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
          jsonOrNull(cursor.pricingContext),
          new Date().toISOString(),
        );
      }

      for (const event of snapshot.modelUsageEvents ?? []) {
        if (!event?.sourceKey || event.lineNumber == null) continue;
        const usage = event.usage ?? null;
        this.statements.upsertModelUsageEvent.run(
          event.sourceKey,
          event.lineNumber,
          rootId,
          event.threadId ?? null,
          event.turnId ?? null,
          event.eventOrdinal ?? null,
          normalizeTimestamp(event.observedAt) ?? null,
          event.generation ?? 0,
          event.classification,
          event.quality,
          event.reason ?? null,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.cacheWriteInputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.reasoningOutputTokens ?? null,
          usage?.totalTokens ?? null,
          event.model ?? null,
          event.serviceTier ?? null,
          event.pricingContextQuality ?? null,
          event.requestIdentity ?? null,
          event.requestIdentityKind ?? null,
          event.requestIdentityReason ?? null,
          event.requestNativeField ?? null,
        );
      }

      this.rebuildCalendarForSession(rootId);

      const counts = this.refreshAggregates(rootId);

      this.db.prepare(`
        UPDATE sessions SET parse_status=?, imported_at=?, agent_count=?, task_count=?, parser_version=?
        WHERE id=?
      `).run(
        snapshot.health.status,
        new Date().toISOString(),
        counts.agents,
        counts.tasks,
        PARSER_VERSION,
        rootId,
      );
    });

    if (persistQuotas) {
      for (const quota of snapshot.quotas ?? []) this.saveQuota(quota);
    }
  }

  saveQuota(quota) {
    if (!quota) return;
    const portableQuota = toPortableQuota(quota);
    this.statements.upsertQuota.run(
      portableQuota.observedAt,
      portableQuota.limitId,
      portableQuota.planType ?? null,
      portableQuota.sourceKey ?? null,
      json(portableQuota),
    );
  }

  listSessions() {
    return this.db.prepare(`
      SELECT id, title, source, created_at, updated_at, archived, cli_version,
             project_path, rollout_key, parse_status, imported_at, agent_count, task_count
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
      SELECT t.*
      FROM tasks t
      INNER JOIN task_ownership o
        ON o.root_session_id=t.root_session_id
       AND o.turn_id=t.turn_id
       AND o.status='canonical'
       AND o.owner_thread_id=t.thread_id
      WHERE t.root_session_id=?
      ORDER BY t.thread_id, t.sequence
    `).all(id).map(mapTask);
    const modelUsageEvents = this.getCanonicalModelUsageEvents(id);
    return { session: mapSession(sessionRow), agents, tasks, modelUsageEvents };
  }

  getRawSession(id) {
    const sessionRow = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!sessionRow) return null;
    const agents = this.db.prepare(`
      SELECT * FROM agents WHERE root_session_id=? ORDER BY depth, first_seen_at, thread_id
    `).all(id).map(mapAgent);
    const tasks = this.db.prepare(`
      SELECT * FROM tasks WHERE root_session_id=? ORDER BY thread_id, sequence
    `).all(id).map(mapTask);
    return {
      session: mapSession(sessionRow),
      agents,
      tasks,
      modelUsageEvents: this.getModelUsageEvents(id),
    };
  }

  getSessionDay(id, range) {
    const sessionRow = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!sessionRow) return null;
    const startAt = new Date(range.startMs).toISOString();
    const endAt = new Date(range.endMs).toISOString();
    const agents = this.db.prepare(`
      SELECT * FROM agents WHERE root_session_id=? ORDER BY depth, first_seen_at, thread_id
    `).all(id).map(mapAgent);
    const tasks = this.db.prepare(`
      SELECT DISTINCT t.*
      FROM tasks t
      INNER JOIN task_ownership o
        ON o.root_session_id=t.root_session_id
       AND o.turn_id=t.turn_id
       AND o.status='canonical'
       AND o.owner_thread_id=t.thread_id
      INNER JOIN canonical_requests r
        ON r.root_session_id=t.root_session_id
       AND r.thread_id=t.thread_id
       AND r.turn_id=t.turn_id
      WHERE t.root_session_id=?
        AND r.observed_at>=?
        AND r.observed_at<?
      ORDER BY t.thread_id, t.sequence
    `).all(id, startAt, endAt).map(mapTask);
    const modelUsageEvents = this.db.prepare(`
      SELECT
        origin_source_key AS source_key,
        origin_line_number AS line_number,
        root_session_id, thread_id, turn_id, event_ordinal, observed_at,
        generation, classification, quality, reason,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        model, service_tier, pricing_context_quality,
        request_id AS request_identity,
        identity_kind AS request_identity_kind,
        'canonical_projection' AS request_identity_reason,
        native_field AS request_native_field
      FROM canonical_requests
      WHERE root_session_id=? AND observed_at>=? AND observed_at<?
      ORDER BY observed_at, request_id
    `).all(id, startAt, endAt).map(mapModelUsageEvent);
    return { session: mapSession(sessionRow), agents, tasks, modelUsageEvents };
  }

  getTask(threadId, turnId) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE thread_id=? AND turn_id=?").get(threadId, turnId);
    return row ? mapTask(row) : null;
  }

  getCursors(rootSessionId) {
    return this.db.prepare(`
      SELECT source_key, root_session_id, thread_id, byte_offset, line_number, file_size,
             modified_at_ms, last_ordinal, invalid_lines, partial_bytes, unknown_records,
             skipped_records, discontinuities, last_usage, pricing_context, parsed_at
      FROM ingest_cursors WHERE root_session_id=? ORDER BY source_key
    `).all(rootSessionId).map((row) => ({
      sourceKey: row.source_key,
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
      pricingContext: parseJson(row.pricing_context),
      parsedAt: row.parsed_at ?? null,
    }));
  }

  getModelUsageEvents(rootSessionId) {
    return this.db.prepare(`
      SELECT *
      FROM model_usage_events
      WHERE root_session_id=?
      ORDER BY source_key, line_number
    `).all(rootSessionId).map(mapModelUsageEvent);
  }

  getCanonicalModelUsageEvents(rootSessionId) {
    return this.db.prepare(`
      SELECT
        origin_source_key AS source_key,
        origin_line_number AS line_number,
        root_session_id, thread_id, turn_id, event_ordinal, observed_at,
        generation, classification, quality, reason,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        model, service_tier, pricing_context_quality,
        request_id AS request_identity,
        identity_kind AS request_identity_kind,
        'canonical_projection' AS request_identity_reason,
        native_field AS request_native_field
      FROM canonical_requests
      WHERE root_session_id=?
      ORDER BY observed_at, request_id
    `).all(rootSessionId).map(mapModelUsageEvent);
  }

  getCanonicalTaskRequests(rootSessionId, threadId, turnId, {
    range = null,
    limit = 200,
    after = null,
    page = null,
  } = {}) {
    const conditions = [
      "root_session_id=?",
      "thread_id=?",
      "turn_id=?",
    ];
    const parameters = [rootSessionId, threadId, turnId];
    if (range) {
      conditions.push("observed_at>=?", "observed_at<?");
      parameters.push(
        new Date(range.startMs).toISOString(),
        new Date(range.endMs).toISOString(),
      );
    }
    if (after) {
      conditions.push("(observed_at>? OR (observed_at=? AND request_id>?))");
      parameters.push(after.observedAt, after.observedAt, after.requestId);
    }
    let pagination = null;
    let rowLimit = limit + 1;
    let offset = null;
    if (page != null) {
      const countParameters = parameters.slice();
      const totalItems = Number(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM canonical_requests
        WHERE ${conditions.join(" AND ")}
      `).get(...countParameters)?.count ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);
      pagination = {
        page,
        pageSize: limit,
        totalItems,
        totalPages,
      };
      rowLimit = limit;
      offset = (page - 1) * limit;
    }
    parameters.push(rowLimit);
    if (offset != null) parameters.push(offset);
    const rows = this.db.prepare(`
      SELECT
        request_id,
        origin_source_key AS source_key,
        origin_line_number AS line_number,
        root_session_id, thread_id, turn_id, event_ordinal, observed_at,
        generation, classification, quality, reason,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        model, service_tier, pricing_context_quality,
        request_id AS request_identity,
        identity_kind AS request_identity_kind,
        'canonical_projection' AS request_identity_reason,
        native_field AS request_native_field
      FROM canonical_requests
      WHERE ${conditions.join(" AND ")}
      ORDER BY observed_at, request_id
      LIMIT ?${offset == null ? "" : " OFFSET ?"}
    `).all(...parameters);
    const hasMore = page == null && rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const requests = visibleRows.map((row) => ({
      requestId: row.request_id,
      ...mapModelUsageEvent(row),
    }));
    const last = requests.at(-1) ?? null;
    return {
      requests,
      nextAfter: hasMore && last
        ? { observedAt: last.observedAt, requestId: last.requestId }
        : null,
      pagination,
    };
  }

  getLatestQuota() {
    const row = this.db.prepare(`
      SELECT payload FROM quota_snapshots ORDER BY observed_at DESC LIMIT 1
    `).get();
    return row ? parseJson(row.payload) : null;
  }

  getSessionIndexState(rootSessionId) {
    const session = this.db.prepare(`
      SELECT parse_status, parser_version, imported_at FROM sessions WHERE id=?
    `).get(rootSessionId);
    if (!session) return null;
    const cursorCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM ingest_cursors WHERE root_session_id=?
    `).get(rootSessionId)?.count ?? 0);
    const parserVersion = Number(session.parser_version ?? 0);
    return {
      parseStatus: session.parse_status ?? "not_imported",
      parserVersion,
      requestLedgerReady: parserVersion >= REQUEST_LEDGER_SCHEMA_VERSION,
      parserCurrent: parserVersion >= PARSER_VERSION,
      importedAt: session.imported_at ?? null,
      cursorCount,
    };
  }

  getTimeline(sessionMetadata = new Map()) {
    const rows = this.db.prepare(`
      SELECT day, root_session_id,
             input_tokens, cached_input_tokens, cache_write_input_tokens,
             output_tokens, reasoning_output_tokens, total_tokens,
             model_request_count,
             task_count, active_task_count,
             complete_count, provisional_count, partial_count, unknown_count,
             cost_amount_usd, cost_status,
             estimated_tasks, partial_tasks, unavailable_tasks,
             estimated_requests, partial_requests, unavailable_requests,
             cost_feature_coverage, pricing_policy_version, projection_version
      FROM session_day_usage
      ORDER BY day DESC, total_tokens DESC, root_session_id
    `).all();
    const unattributedTasks = this.db.prepare(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_ownership o
        ON o.root_session_id=t.root_session_id
       AND o.turn_id=t.turn_id
       AND o.status='canonical'
       AND o.owner_thread_id=t.thread_id
      WHERE t.started_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM model_usage_events attributed
          INNER JOIN event_ownership attributed_owner
            ON attributed_owner.source_key=attributed.source_key
           AND attributed_owner.line_number=attributed.line_number
           AND attributed_owner.status='canonical'
          WHERE attributed.root_session_id=t.root_session_id
            AND attributed.thread_id=t.thread_id
            AND attributed.turn_id=t.turn_id
            AND attributed.observed_at IS NOT NULL
        )
      ORDER BY t.thread_id, t.sequence
    `).all().map(mapTask);
    const unattributedEvents = this.db.prepare(`
      SELECT m.source_key, m.line_number, m.root_session_id, m.thread_id, m.turn_id,
             m.event_ordinal, m.observed_at, m.generation, m.classification, m.quality, m.reason,
             m.input_tokens, m.cached_input_tokens, m.cache_write_input_tokens,
             m.output_tokens, m.reasoning_output_tokens, m.total_tokens,
             m.model, m.service_tier, m.pricing_context_quality
      FROM model_usage_events m
      INNER JOIN event_ownership eo
        ON eo.source_key=m.source_key
       AND eo.line_number=m.line_number
       AND eo.status='canonical'
      INNER JOIN tasks t
        ON t.root_session_id=m.root_session_id
       AND t.thread_id=m.thread_id
       AND t.turn_id=m.turn_id
      INNER JOIN task_ownership o
        ON o.root_session_id=t.root_session_id
       AND o.turn_id=t.turn_id
       AND o.status='canonical'
       AND o.owner_thread_id=t.thread_id
      WHERE t.started_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM model_usage_events attributed
          INNER JOIN event_ownership attributed_owner
            ON attributed_owner.source_key=attributed.source_key
           AND attributed_owner.line_number=attributed.line_number
           AND attributed_owner.status='canonical'
          WHERE attributed.root_session_id=t.root_session_id
            AND attributed.thread_id=t.thread_id
            AND attributed.turn_id=t.turn_id
            AND attributed.observed_at IS NOT NULL
        )
      ORDER BY m.source_key, m.line_number
    `).all().map(mapModelUsageEvent);
    const unattributedRows = materializeRequestLedgerTasks(
      unattributedTasks,
      unattributedEvents,
    );

    const months = new Map();
    const overallUsage = zeroUsage();
    const qualityCounts = emptyQualityCounts();
    let overallCostEstimate = null;
    for (const row of rows) {
      const usage = usageFromCalendarRow(row);
      const rowQuality = qualityFromCalendarRow(row);
      const monthKey = row.day.slice(0, 7);
      const month = months.get(monthKey) ?? createCalendarMonth(monthKey);
      const day = month.days.get(row.day) ?? createCalendarDay(row.day);
      const metadata = sessionMetadata.get(row.root_session_id) ?? {};
      const session = {
        id: row.root_session_id,
        title: metadata.title || "未命名会话",
        projectPath: metadata.projectPath ?? null,
        updatedAt: metadata.updatedAt ?? null,
        date: row.day,
        usage,
        modelRequestCount: Number(row.model_request_count ?? 0),
        tokensPerModelRequest: tokensPerRequest(usage, row.model_request_count),
        taskCount: Number(row.task_count ?? 0),
        activeTaskCount: Number(row.active_task_count ?? 0),
        qualityCounts: rowQuality,
        costEstimate: row.cost_status ? {
          status: row.cost_status,
          amountUsd: row.cost_amount_usd == null ? null : Number(row.cost_amount_usd),
          currency: "USD",
          basis: "subscription-standard-equivalent",
          policyVersion: row.pricing_policy_version ?? null,
          estimatedTasks: Number(row.estimated_tasks ?? 0),
          partialTasks: Number(row.partial_tasks ?? 0),
          unavailableTasks: Number(row.unavailable_tasks ?? 0),
          estimatedRequests: Number(row.estimated_requests ?? 0),
          partialRequests: Number(row.partial_requests ?? 0),
          unavailableRequests: Number(row.unavailable_requests ?? 0),
          featureCoverage: parseJson(row.cost_feature_coverage) ?? {
            historicalRate: "unknown",
            requestBoundary: "unknown",
            serviceTier: "unknown",
          },
          projectionVersion: Number(row.projection_version ?? 1),
        } : null,
      };
      day.sessions.push(session);
      mergeCalendarCost(day, session.costEstimate);
      day.usage = addUsage(day.usage, usage);
      day.modelRequestCount += session.modelRequestCount;
      day.taskCount += session.taskCount;
      day.activeTaskCount += session.activeTaskCount;
      addQualityCounts(day.qualityCounts, rowQuality);
      month.usage = addUsage(month.usage, usage);
      mergeCalendarCost(month, session.costEstimate);
      month.modelRequestCount += session.modelRequestCount;
      month.taskCount += session.taskCount;
      month.activeTaskCount += session.activeTaskCount;
      addQualityCounts(month.qualityCounts, rowQuality);
      overallUsageFrom(overallUsage, usage);
      overallCostEstimate = mergeCostEstimate(overallCostEstimate, session.costEstimate);
      addQualityCounts(qualityCounts, rowQuality);
      month.days.set(row.day, day);
      months.set(monthKey, month);
    }

    const unattributed = {
      taskCount: 0,
      modelRequestCount: 0,
      usage: zeroUsage(),
      qualityCounts: emptyQualityCounts(),
    };
    for (const row of unattributedRows) {
      const quality = QUALITY_KEYS.includes(row.quality) ? row.quality : "unknown";
      const usage = row.deltaUsage ?? null;
      unattributed.taskCount += 1;
      unattributed.modelRequestCount += row.requestCount ?? 0;
      unattributed.qualityCounts[quality] += 1;
      qualityCounts[quality] += 1;
      if (usage) {
        unattributed.usage = addUsage(unattributed.usage, usage);
        overallUsageFrom(overallUsage, usage);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      timezone: localTimezone(),
      projection: this.getProjectionState(),
      usage: overallUsage,
      modelRequestCount: [...months.values()].reduce(
        (sum, month) => sum + month.modelRequestCount,
        0,
      ) + unattributed.modelRequestCount,
      tokensPerModelRequest: tokensPerRequest(
        overallUsage,
        [...months.values()].reduce((sum, month) => sum + month.modelRequestCount, 0) +
          unattributed.modelRequestCount,
      ),
      qualityCounts,
      costEstimate: overallCostEstimate,
      unattributed,
      months: [...months.values()]
        .sort((left, right) => right.key.localeCompare(left.key))
        .map(materializeCalendarMonth),
    };
  }

  getTimelineCostTasks() {
    const tasks = this.db.prepare(`
      SELECT * FROM tasks ORDER BY root_session_id, thread_id, sequence
    `).all().map(mapTask);
    const events = this.db.prepare(`
      SELECT source_key, line_number, root_session_id, thread_id, turn_id,
             event_ordinal, observed_at, generation, classification, quality, reason,
             input_tokens, cached_input_tokens, cache_write_input_tokens,
             output_tokens, reasoning_output_tokens, total_tokens,
             model, service_tier, pricing_context_quality
      FROM model_usage_events
      ORDER BY root_session_id, observed_at, source_key, line_number
    `).all().map(mapModelUsageEvent);
    const tasksByRoot = groupByRootSession(tasks);
    const eventsByRoot = groupByRootSession(events);
    const roots = new Set([...tasksByRoot.keys(), ...eventsByRoot.keys()]);
    const result = [];
    for (const rootSessionId of roots) {
      for (const slice of materializeCalendarSlices({
        tasks: tasksByRoot.get(rootSessionId) ?? [],
        modelUsageEvents: eventsByRoot.get(rootSessionId) ?? [],
      })) {
        for (const task of slice.tasks) {
          result.push({ ...task, rootSessionId, day: slice.day });
        }
      }
    }
    return result;
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
    const pageSize = Number(this.db.prepare("PRAGMA page_size").get().page_size ?? 0);
    const pageCount = Number(this.db.prepare("PRAGMA page_count").get().page_count ?? 0);
    const freelistCount = Number(this.db.prepare("PRAGMA freelist_count").get().freelist_count ?? 0);
    const cacheSize = Number(this.db.prepare("PRAGMA cache_size").get().cache_size ?? 0);
    const walAutoCheckpoint = Number(this.db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint ?? 0);
    const mmapSize = Number(this.db.prepare("PRAGMA mmap_size").get().mmap_size ?? 0);
    const calendarRows = Number(this.db.prepare("SELECT COUNT(*) AS count FROM session_day_usage").get().count ?? 0);
    const modelUsageEventRows = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM model_usage_events").get().count ?? 0,
    );
    const canonicalRequestRows = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM canonical_requests").get().count ?? 0,
    );
    const ownershipRows = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status='canonical' THEN 1 ELSE 0 END) AS canonical_events,
        SUM(CASE WHEN status='inherited_copy' THEN 1 ELSE 0 END) AS inherited_events,
        SUM(CASE WHEN status='unresolved' THEN 1 ELSE 0 END) AS unresolved_events
      FROM event_ownership
    `).get();
    const requestOwnershipRows = this.db.prepare(`
      SELECT
        SUM(CASE WHEN eo.status='inherited_copy' THEN 1 ELSE 0 END) AS inherited_requests,
        SUM(CASE WHEN eo.status='unresolved' THEN 1 ELSE 0 END) AS unresolved_requests
      FROM event_ownership eo
      INNER JOIN model_usage_events m
        ON m.source_key=eo.source_key AND m.line_number=eo.line_number
      WHERE m.classification IN ('verified_increment', 'generation_start')
    `).get();
    const taskOwnershipRows = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status='canonical' THEN 1 ELSE 0 END) AS canonical_tasks,
        SUM(CASE WHEN status='canonical' THEN duplicate_count ELSE 0 END) AS inherited_tasks,
        SUM(CASE WHEN status='unresolved' THEN duplicate_count + 1 ELSE 0 END) AS unresolved_tasks
      FROM task_ownership
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
      calendarRows,
      modelUsageEventRows,
      canonicalRequestRows,
      projection: this.getProjectionState(),
      ownership: {
        canonicalEvents: Number(ownershipRows.canonical_events ?? 0),
        inheritedEvents: Number(ownershipRows.inherited_events ?? 0),
        unresolvedEvents: Number(ownershipRows.unresolved_events ?? 0),
        canonicalRequests: canonicalRequestRows,
        inheritedRequestCopies: Number(requestOwnershipRows.inherited_requests ?? 0),
        unresolvedRequests: Number(requestOwnershipRows.unresolved_requests ?? 0),
        canonicalTasks: Number(taskOwnershipRows.canonical_tasks ?? 0),
        inheritedTaskCopies: Number(taskOwnershipRows.inherited_tasks ?? 0),
        unresolvedTasks: Number(taskOwnershipRows.unresolved_tasks ?? 0),
      },
      pageSize,
      pageCount,
      freelistCount,
      cacheSize,
      walAutoCheckpoint,
      mmapSize,
    };
  }

  rebuildAllCalendarIndex() {
    this.rebuildAllCanonicalProjections();
  }

  rebuildAllCanonicalProjections() {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM session_day_usage;
        DELETE FROM task_ownership;
        DELETE FROM event_ownership;
        DELETE FROM canonical_requests;
      `);
      const roots = this.db.prepare(`
        SELECT id
        FROM sessions
        ORDER BY created_at IS NULL, created_at, updated_at, id
      `).all();
      for (const row of roots) this.rebuildCalendarForSession(row.id);
    });
  }

  rebuildOwnershipForSession(rootId) {
    const session = this.db.prepare("SELECT created_at FROM sessions WHERE id=?").get(rootId);
    const agents = this.db.prepare(`
      SELECT * FROM agents WHERE root_session_id=? ORDER BY depth, first_seen_at, thread_id
    `).all(rootId).map(mapAgent);
    const tasks = this.db.prepare(`
      SELECT * FROM tasks WHERE root_session_id=? ORDER BY thread_id, sequence
    `).all(rootId).map(mapTask);
    const events = this.getModelUsageEvents(rootId);
    let resolved = resolveCanonicalRequestOwnership({
      agents,
      tasks,
      events,
      rootCreatedAt: session?.created_at ?? null,
    });
    const findExternalCanonicalRequest = this.db.prepare(`
      SELECT request_id
      FROM canonical_requests
      WHERE request_id=? AND root_session_id<>?
    `);
    const externalCanonicalRequestIds = new Set();
    for (const row of resolved.provenance) {
      const requestId = row.requestIdentity;
      if (!requestId || externalCanonicalRequestIds.has(requestId)) continue;
      if (findExternalCanonicalRequest.get(requestId, rootId)) {
        externalCanonicalRequestIds.add(requestId);
      }
    }
    if (externalCanonicalRequestIds.size > 0) {
      resolved = resolveCanonicalRequestOwnership({
        agents,
        tasks,
        events,
        rootCreatedAt: session?.created_at ?? null,
        externalCanonicalRequestIds,
      });
    }

    this.db.prepare("DELETE FROM task_ownership WHERE root_session_id=?").run(rootId);
    this.db.prepare("DELETE FROM event_ownership WHERE root_session_id=?").run(rootId);
    this.db.prepare("DELETE FROM canonical_requests WHERE root_session_id=?").run(rootId);
    const insertTaskOwnership = this.db.prepare(`
      INSERT INTO task_ownership (
        root_session_id, turn_id, owner_thread_id, status, duplicate_count, reason
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertEventOwnership = this.db.prepare(`
      INSERT INTO event_ownership (
        source_key, line_number, root_session_id, owner_thread_id, status, canonical_request_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateEventIdentity = this.db.prepare(`
      UPDATE model_usage_events
      SET request_identity=?, request_identity_kind=?, request_identity_reason=?, request_native_field=?
      WHERE source_key=? AND line_number=? AND root_session_id=?
    `);
    const insertCanonicalRequest = this.db.prepare(`
      INSERT INTO canonical_requests (
        request_id, root_session_id, thread_id, turn_id, event_ordinal, observed_at, generation,
        classification, quality, reason,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        model, service_tier, pricing_context_quality,
        identity_kind, native_field, origin_source_key, origin_line_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findCanonicalRequest = this.db.prepare(`
      SELECT request_id FROM canonical_requests WHERE request_id=?
    `);
    for (const row of resolved.ownership) {
      insertTaskOwnership.run(
        rootId,
        row.turnId,
        row.ownerThreadId ?? null,
        row.status,
        row.duplicateCount ?? 0,
        row.reason ?? null,
      );
    }
    for (const row of resolved.provenance) {
      if (!row.sourceKey || row.lineNumber == null) continue;
      updateEventIdentity.run(
        row.requestIdentity ?? null,
        row.requestIdentityKind ?? null,
        row.requestIdentityReason ?? null,
        row.requestNativeField ?? null,
        row.sourceKey,
        row.lineNumber,
        rootId,
      );
      insertEventOwnership.run(
        row.sourceKey,
        row.lineNumber,
        rootId,
        row.ownerThreadId ?? null,
        row.status,
        row.canonicalRequestId ?? (
          row.requestIdentity && row.status === "inherited_copy"
            ? findCanonicalRequest.get(row.requestIdentity)?.request_id ?? null
            : null
        ),
      );
    }
    for (const event of resolved.requests) {
      if (!event.requestIdentity || !event.threadId || !event.turnId || !event.sourceKey || event.lineNumber == null) continue;
      const usage = event.usage ?? null;
      insertCanonicalRequest.run(
        event.requestIdentity,
        rootId,
        event.threadId,
        event.turnId,
        event.eventOrdinal ?? null,
        event.observedAt ?? null,
        event.generation ?? 0,
        event.classification,
        event.quality,
        event.reason ?? null,
        usage?.inputTokens ?? null,
        usage?.cachedInputTokens ?? null,
        usage?.cacheWriteInputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.reasoningOutputTokens ?? null,
        usage?.totalTokens ?? null,
        event.model ?? null,
        event.serviceTier ?? null,
        event.pricingContextQuality ?? null,
        event.requestIdentityKind ?? "reconstructed",
        event.requestNativeField ?? null,
        event.sourceKey,
        event.lineNumber,
      );
    }
    this.db.exec(`
      UPDATE event_ownership
      SET canonical_request_id = (
        SELECT canonical_requests.request_id
        FROM model_usage_events
        INNER JOIN canonical_requests
          ON canonical_requests.request_id=model_usage_events.request_identity
        WHERE model_usage_events.source_key=event_ownership.source_key
          AND model_usage_events.line_number=event_ownership.line_number
      )
      WHERE status='inherited_copy'
        AND canonical_request_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM model_usage_events
          INNER JOIN canonical_requests
            ON canonical_requests.request_id=model_usage_events.request_identity
          WHERE model_usage_events.source_key=event_ownership.source_key
            AND model_usage_events.line_number=event_ownership.line_number
        )
    `);
    this.db.prepare(`
      INSERT INTO derived_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(`ownership_reconciliation:${rootId}`, JSON.stringify(resolved.reconciliation));
    return resolved;
  }

  normalizeStoredUsageEventTimestamps() {
    const rows = this.db.prepare(`
      SELECT source_key, line_number, observed_at
      FROM model_usage_events
      WHERE observed_at IS NOT NULL
    `).all();
    const update = this.db.prepare(`
      UPDATE model_usage_events SET observed_at=? WHERE source_key=? AND line_number=?
    `);
    this.transaction(() => {
      for (const row of rows) {
        const normalized = normalizeTimestamp(row.observed_at);
        if (normalized && normalized !== row.observed_at) {
          update.run(normalized, row.source_key, row.line_number);
        }
      }
    });
  }

  rebuildCalendarForSession(rootId) {
    this.db.prepare("DELETE FROM session_day_usage WHERE root_session_id=?").run(rootId);
    const ownership = this.rebuildOwnershipForSession(rootId);
    const stored = {
      session: this.db.prepare("SELECT * FROM sessions WHERE id=?").get(rootId),
      agents: this.db.prepare("SELECT * FROM agents WHERE root_session_id=?").all(rootId).map(mapAgent),
      tasks: ownership.tasks,
      modelUsageEvents: ownership.events,
    };
    const slices = materializeCalendarSlices(stored, { ownershipResolved: true });
    const insert = this.db.prepare(`
      INSERT INTO session_day_usage (
        day, root_session_id,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens,
        model_request_count,
        task_count, active_task_count,
        complete_count, provisional_count, partial_count, unknown_count,
        cost_amount_usd, cost_status,
        estimated_tasks, partial_tasks, unavailable_tasks,
        estimated_requests, partial_requests, unavailable_requests,
        cost_feature_coverage, pricing_policy_version, projection_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const aggregate of slices) {
      const cost = aggregate.costEstimate;
      insert.run(
        aggregate.day,
        rootId,
        aggregate.usage.inputTokens ?? 0,
        aggregate.usage.cachedInputTokens ?? 0,
        aggregate.usage.cacheWriteInputTokens ?? 0,
        aggregate.usage.outputTokens ?? 0,
        aggregate.usage.reasoningOutputTokens ?? 0,
        aggregate.usage.totalTokens ?? 0,
        aggregate.modelRequestCount,
        aggregate.taskCount,
        aggregate.activeTaskCount,
        aggregate.qualityCounts.complete,
        aggregate.qualityCounts.provisional,
        aggregate.qualityCounts.partial,
        aggregate.qualityCounts.unknown,
        cost?.amountUsd ?? null,
        cost?.status ?? null,
        cost?.estimatedTasks ?? 0,
        cost?.partialTasks ?? 0,
        cost?.unavailableTasks ?? 0,
        cost?.estimatedRequests ?? 0,
        cost?.partialRequests ?? 0,
        cost?.unavailableRequests ?? 0,
        jsonOrNull(cost?.featureCoverage),
        cost?.policyVersion ?? null,
        PROJECTION_VERSION,
      );
    }
    this.advanceProjectionGeneration();
  }

  advanceProjectionGeneration() {
    const current = Number(
      this.db.prepare("SELECT value FROM derived_state WHERE key='projection_generation'").get()?.value ?? 0,
    );
    const next = Number.isSafeInteger(current) ? current + 1 : 1;
    this.db.prepare(`
      INSERT INTO derived_state (key, value) VALUES ('projection_generation', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(String(next));
    return next;
  }

  getProjectionState() {
    const generation = Number(
      this.db.prepare("SELECT value FROM derived_state WHERE key='projection_generation'").get()?.value ?? 0,
    );
    return {
      version: PROJECTION_VERSION,
      generation: Number.isSafeInteger(generation) ? generation : 0,
    };
  }

  refreshAggregates(rootId) {
    const agentRows = this.db.prepare(`
      SELECT thread_id, parent_thread_id, depth FROM agents WHERE root_session_id=?
    `).all(rootId);
    const storedTaskRows = this.db.prepare(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_ownership o
        ON o.root_session_id=t.root_session_id
       AND o.turn_id=t.turn_id
       AND o.status='canonical'
       AND o.owner_thread_id=t.thread_id
      WHERE t.root_session_id=?
      ORDER BY t.thread_id, t.sequence
    `).all(rootId).map(mapTask);
    const taskRows = materializeRequestLedgerTasks(
      storedTaskRows,
      this.getCanonicalModelUsageEvents(rootId),
    );
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
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Closing must still release the database even if a checkpoint cannot complete.
    }
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
    rolloutKey: row.rollout_key ?? null,
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
    rolloutKey: row.rollout_key ?? null,
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
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    model: row.model ?? null,
    effort: row.effort ?? null,
    sourceKey: row.source_key ?? null,
    startOrdinal: row.start_ordinal == null ? null : Number(row.start_ordinal),
    endOrdinal: row.end_ordinal == null ? null : Number(row.end_ordinal),
    startLine: row.start_line == null ? null : Number(row.start_line),
    endLine: row.end_line == null ? null : Number(row.end_line),
    startByte: row.start_byte == null ? null : Number(row.start_byte),
    endByte: row.end_byte == null ? null : Number(row.end_byte),
    zeroUsageVerified: Boolean(row.zero_usage_verified),
  };
}

function mapModelUsageEvent(row) {
  return {
    sourceKey: row.source_key,
    lineNumber: Number(row.line_number),
    rootSessionId: row.root_session_id,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    eventOrdinal: row.event_ordinal == null ? null : Number(row.event_ordinal),
    observedAt: row.observed_at ?? null,
    generation: Number(row.generation ?? 0),
    classification: row.classification,
    quality: row.quality,
    reason: row.reason ?? null,
    usage: usageFromModelUsageRow(row),
    model: row.model ?? null,
    serviceTier: row.service_tier ?? null,
    pricingContextQuality: row.pricing_context_quality ?? null,
    requestIdentity: row.request_identity ?? null,
    requestIdentityKind: row.request_identity_kind ?? null,
    requestIdentityReason: row.request_identity_reason ?? null,
    requestNativeField: row.request_native_field ?? null,
  };
}

function usageFromModelUsageRow(row) {
  const values = {
    inputTokens: numberOrNull(row.input_tokens),
    cachedInputTokens: numberOrNull(row.cached_input_tokens),
    cacheWriteInputTokens: numberOrNull(row.cache_write_input_tokens),
    outputTokens: numberOrNull(row.output_tokens),
    reasoningOutputTokens: numberOrNull(row.reasoning_output_tokens),
    totalTokens: numberOrNull(row.total_tokens),
  };
  return Object.values(values).some((value) => value != null) ? values : null;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function toPortableQuota(quota) {
  const portable = { ...quota };
  const sourceKey = recoverLegacySourceKey(portable.sourceKey) ?? recoverLegacySourceKey(portable.sourcePath);
  delete portable.sourcePath;
  if (sourceKey) portable.sourceKey = sourceKey;
  else delete portable.sourceKey;
  return portable;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createCalendarAggregate() {
  return {
    usage: zeroUsage(),
    modelRequestCount: 0,
    taskCount: 0,
    activeTaskCount: 0,
    qualityCounts: emptyQualityCounts(),
    costEstimate: null,
  };
}

function createCalendarMonth(key) {
  return { key, ...createCalendarAggregate(), days: new Map() };
}

function createCalendarDay(key) {
  return { key, ...createCalendarAggregate(), sessions: [] };
}

function emptyQualityCounts() {
  return Object.fromEntries(QUALITY_KEYS.map((key) => [key, 0]));
}

function groupByRootSession(rows) {
  const groups = new Map();
  for (const row of rows) {
    const rootSessionId = row.rootSessionId;
    if (!rootSessionId) continue;
    const group = groups.get(rootSessionId) ?? [];
    group.push(row);
    groups.set(rootSessionId, group);
  }
  return groups;
}

function addQualityCounts(target, source) {
  for (const key of QUALITY_KEYS) target[key] += Number(source?.[key] ?? 0);
}

function mergeCalendarCost(target, source) {
  target.costEstimate = mergeCostEstimate(target.costEstimate, source);
}

function mergeCostEstimate(left, right) {
  if (!right) return left;
  if (!left) return structuredClone(right);
  return combineCostSummaries([left, right]);
}

function usageFromCalendarRow(row) {
  return {
    inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    cacheWriteInputTokens: Number(row.cache_write_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
  };
}

function qualityFromCalendarRow(row) {
  return {
    complete: Number(row.complete_count ?? 0),
    provisional: Number(row.provisional_count ?? 0),
    partial: Number(row.partial_count ?? 0),
    unknown: Number(row.unknown_count ?? 0),
  };
}

function overallUsageFrom(target, usage) {
  for (const field of USAGE_FIELDS) target[field] += usage?.[field] ?? 0;
}

function materializeCalendarMonth(month) {
  return {
    key: month.key,
    usage: month.usage,
    modelRequestCount: month.modelRequestCount,
    tokensPerModelRequest: tokensPerRequest(month.usage, month.modelRequestCount),
    taskCount: month.taskCount,
    activeTaskCount: month.activeTaskCount,
    qualityCounts: month.qualityCounts,
    costEstimate: month.costEstimate,
    days: [...month.days.values()]
      .sort((left, right) => right.key.localeCompare(left.key))
      .map((day) => ({
        key: day.key,
        usage: day.usage,
        modelRequestCount: day.modelRequestCount,
        tokensPerModelRequest: tokensPerRequest(day.usage, day.modelRequestCount),
        taskCount: day.taskCount,
        activeTaskCount: day.activeTaskCount,
        qualityCounts: day.qualityCounts,
        costEstimate: day.costEstimate,
        sessions: day.sessions.sort(compareCalendarSessions),
      })),
  };
}

function tokensPerRequest(usage, count) {
  const requestCount = Number(count ?? 0);
  const totalTokens = usage?.totalTokens;
  if (!Number.isFinite(totalTokens) || requestCount <= 0) return null;
  return totalTokens / requestCount;
}

function compareCalendarSessions(left, right) {
  return (right.usage.totalTokens ?? -1) - (left.usage.totalTokens ?? -1) ||
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
    left.id.localeCompare(right.id);
}

function localDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "当地时区";
}

function numberOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export { SCHEMA_VERSION };
