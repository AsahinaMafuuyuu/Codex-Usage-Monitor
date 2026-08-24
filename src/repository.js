import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanRolloutMetadata } from "./rollout-parser.js";
import { normalizeTimestamp } from "./usage.js";

export class CodexRepository {
  constructor(codexHome, database) {
    this.codexHome = resolve(codexHome);
    this.database = database;
    this.entriesByPath = new Map();
    this.entriesByRoot = new Map();
    this.sessions = new Map();
    this.state = { threads: new Map(), parentByChild: new Map(), errors: [] };
    this.indexErrors = [];
    this.lastIndexedAt = null;
  }

  async initialize() {
    this.state = await readCodexState(this.codexHome);
    const names = readSessionIndex(join(this.codexHome, "session_index.jsonl"));
    const files = await findRolloutFiles(this.codexHome);
    const scanned = await mapWithConcurrency(files, 12, async (path) => {
      try {
        const result = await scanRolloutMetadata(path);
        return result ? this.makeEntry(path, result) : null;
      } catch (error) {
        this.indexErrors.push({ path, message: error.message });
        return null;
      }
    });

    for (const entry of scanned) if (entry) this.addEntry(entry);
    this.addStateOnlyRoots();
    this.rebuildSessions(names);
    this.database.upsertSessions([...this.sessions.values()]);
    this.lastIndexedAt = new Date().toISOString();
    return this.summary();
  }

  async discoverNewFiles() {
    const files = await findRolloutFiles(this.codexHome);
    const additions = [];
    for (const path of files) {
      if (this.entriesByPath.has(normalizePath(path))) continue;
      const entry = await this.refreshFile(path);
      if (entry) additions.push(entry);
    }
    this.lastIndexedAt = new Date().toISOString();
    return additions;
  }

  async refreshFile(filePath) {
    const normalizedPath = normalizePath(filePath);
    if (!isInside(this.codexHome, normalizedPath) || !isRolloutPath(normalizedPath)) return null;
    if (!existsSync(normalizedPath)) return null;
    try {
      const result = await scanRolloutMetadata(normalizedPath);
      if (!result) return null;
      const entry = this.makeEntry(normalizedPath, result);
      this.addEntry(entry);
      const session = this.buildSession(entry.rootSessionId, new Map());
      if (session) {
        this.sessions.set(session.id, session);
        this.database.upsertSessions([session]);
      }
      return entry;
    } catch (error) {
      this.indexErrors.push({ path: normalizedPath, message: error.message });
      return null;
    }
  }

  makeEntry(path, result) {
    const meta = result.meta;
    const stateThread = this.state.threads.get(meta.id);
    const source = parseMaybeJson(meta.source ?? stateThread?.source);
    const subagent = extractSubagent(source);
    const parentThreadId =
      meta.parent_thread_id ??
      subagent?.parent_thread_id ??
      this.state.parentByChild.get(meta.id) ??
      null;
    const rootSessionId =
      meta.session_id ?? this.findRootThread(meta.id) ?? meta.id;
    return {
      path: normalizePath(path),
      threadId: meta.id,
      rootSessionId,
      parentThreadId,
      depth: numberOrNull(subagent?.depth),
      nickname: meta.agent_nickname ?? subagent?.agent_nickname ?? stateThread?.agent_nickname ?? null,
      role: meta.agent_role ?? subagent?.agent_role ?? stateThread?.agent_role ?? null,
      agentPath: meta.agent_path ?? subagent?.agent_path ?? stateThread?.agent_path ?? null,
      cliVersion: meta.cli_version ?? stateThread?.cli_version ?? null,
      source,
      meta,
      envelopeTimestamp: result.envelopeTimestamp,
      createdAt: normalizeTimestamp(meta.timestamp ?? stateThread?.created_at),
      updatedAt: normalizeTimestamp(stateThread?.updated_at) ?? result.envelopeTimestamp,
      archived: path.toLowerCase().includes(`${normalize("archived_sessions").toLowerCase()}`),
      fileSize: result.fileSize,
      modifiedAtMs: result.modifiedAtMs,
    };
  }

  addEntry(entry) {
    const key = normalizePath(entry.path);
    const previous = this.entriesByPath.get(key);
    if (previous && previous.rootSessionId !== entry.rootSessionId) {
      const old = this.entriesByRoot.get(previous.rootSessionId) ?? [];
      this.entriesByRoot.set(
        previous.rootSessionId,
        old.filter((item) => normalizePath(item.path) !== key),
      );
    }
    this.entriesByPath.set(key, entry);
    const group = this.entriesByRoot.get(entry.rootSessionId) ?? [];
    const next = group.filter((item) => normalizePath(item.path) !== key);
    next.push(entry);
    next.sort(compareEntries);
    this.entriesByRoot.set(entry.rootSessionId, next);
  }

  addStateOnlyRoots() {
    for (const thread of this.state.threads.values()) {
      const rootId = this.findRootThread(thread.id);
      if (rootId !== thread.id || this.entriesByRoot.has(rootId)) continue;
      this.entriesByRoot.set(rootId, []);
    }
  }

  rebuildSessions(names) {
    const roots = new Set([
      ...this.entriesByRoot.keys(),
      ...[...this.state.threads.keys()].map((id) => this.findRootThread(id)),
    ]);
    for (const rootId of roots) {
      const session = this.buildSession(rootId, names);
      if (session) this.sessions.set(rootId, session);
    }
  }

  buildSession(rootId, names) {
    if (!rootId) return null;
    const rootThread = this.state.threads.get(rootId);
    const entries = this.entriesByRoot.get(rootId) ?? [];
    const rootEntry = entries.find((entry) => entry.threadId === rootId);
    const fallbackEntry = rootEntry ?? entries[0];
    const title =
      names.get(rootId)?.threadName ??
      rootThread?.name ??
      rootThread?.title ??
      rootThread?.first_user_message ??
      "";
    const updatedCandidates = [
      normalizeTimestamp(rootThread?.updated_at_ms),
      normalizeTimestamp(rootThread?.updated_at),
      names.get(rootId)?.updatedAt,
      ...entries.map((entry) => entry.updatedAt),
    ].filter(Boolean);
    const createdCandidates = [
      normalizeTimestamp(rootThread?.created_at_ms),
      normalizeTimestamp(rootThread?.created_at),
      fallbackEntry?.createdAt,
    ].filter(Boolean);
    return {
      id: rootId,
      title,
      source: typeof rootThread?.source === "string" ? rootThread.source : fallbackEntry?.source?.kind ?? null,
      projectPath: nonEmptyText(rootThread?.cwd) ?? nonEmptyText(rootEntry?.meta?.cwd),
      createdAt: createdCandidates.sort()[0] ?? null,
      updatedAt: updatedCandidates.sort().at(-1) ?? null,
      archived: Boolean(rootThread?.archived) || entries.some((entry) => entry.archived),
      cliVersion: rootThread?.cli_version ?? fallbackEntry?.cliVersion ?? null,
      rolloutPath: rootThread?.rollout_path ?? fallbackEntry?.path ?? null,
    };
  }

  findRootThread(threadId) {
    let current = threadId;
    const seen = new Set();
    while (this.state.parentByChild.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.state.parentByChild.get(current);
    }
    return current;
  }

  getFilesForRoot(rootId) {
    return [...(this.entriesByRoot.get(rootId) ?? [])].sort(compareEntries);
  }

  getEntry(filePath) {
    return this.entriesByPath.get(normalizePath(filePath)) ?? null;
  }

  getSession(rootId) {
    return this.sessions.get(rootId) ?? null;
  }

  allFiles() {
    return [...this.entriesByPath.values()];
  }

  summary() {
    return {
      codexHome: this.codexHome,
      sessions: this.sessions.size,
      rolloutFiles: this.entriesByPath.size,
      stateDatabase: this.state.databasePath ?? null,
      stateThreads: this.state.threads.size,
      stateEdges: this.state.parentByChild.size,
      indexErrors: this.indexErrors.length + this.state.errors.length,
      lastIndexedAt: this.lastIndexedAt,
    };
  }
}

async function readCodexState(codexHome) {
  const result = {
    threads: new Map(),
    parentByChild: new Map(),
    errors: [],
    databasePath: null,
  };
  try {
    const candidates = (await readdir(codexHome, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/u.test(entry.name))
      .map((entry) => join(codexHome, entry.name));
    const withStats = await Promise.all(
      candidates.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })),
    );
    withStats.sort((a, b) => b.modified - a.modified);
    const databasePath = withStats[0]?.path;
    if (!databasePath) return result;
    result.databasePath = databasePath;
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
      for (const row of db.prepare("SELECT * FROM threads").all()) result.threads.set(row.id, row);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.some((row) => row.name === "thread_spawn_edges")) {
        for (const edge of db.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all()) {
          result.parentByChild.set(edge.child_thread_id, edge.parent_thread_id);
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    result.errors.push(error.message);
  }
  return result;
}

function readSessionIndex(filePath) {
  const result = new Map();
  if (!existsSync(filePath)) return result;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (!record.id) continue;
      result.set(record.id, {
        threadName: record.thread_name ?? "",
        updatedAt: normalizeTimestamp(record.updated_at),
      });
    } catch {
      // A malformed index line should not prevent rollout discovery.
    }
  }
  return result;
}

async function findRolloutFiles(codexHome) {
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  const files = [];
  for (const root of roots) await walk(root, files);
  return files;
}

async function walk(directory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile() && isRolloutPath(path)) output.push(path);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRolloutPath(path) {
  return /^rollout-.*\.jsonl$/u.test(basename(path));
}

function normalizePath(path) {
  return normalize(resolve(path));
}

function isInside(root, path) {
  const normalizedRoot = `${normalizePath(root).toLowerCase()}\\`;
  const normalizedPath = normalizePath(path).toLowerCase();
  return normalizedPath.startsWith(normalizedRoot);
}

function extractSubagent(source) {
  const subagent = source?.subagent;
  if (!subagent || typeof subagent !== "object") return null;
  for (const value of Object.values(subagent)) {
    if (value && typeof value === "object") return value;
  }
  return null;
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

function compareEntries(left, right) {
  const leftTime = left.meta?.timestamp ?? left.envelopeTimestamp ?? left.createdAt ?? "";
  const rightTime = right.meta?.timestamp ?? right.envelopeTimestamp ?? right.createdAt ?? "";
  return String(leftTime).localeCompare(String(rightTime)) || left.path.localeCompare(right.path);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
