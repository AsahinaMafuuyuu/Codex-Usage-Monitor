import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertContainedPath } from "./runtime-layout.js";
import { compareStableVersions, parseStableVersion } from "./release-client.js";

export const UPDATE_STATE_SCHEMA_VERSION = 1;
export const UPDATE_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const UPDATE_HISTORY_LIMIT = 10;

export async function readUpdateState(layout) {
  if (layout?.mode !== "managed") return null;
  const path = updateStatePath(layout);
  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  return validateUpdateState(payload) ? payload : null;
}

export async function readFreshUpdateNotice(layout, currentVersion, {
  now = Date.now(),
  maxAgeMs = UPDATE_NOTICE_MAX_AGE_MS,
} = {}) {
  const state = await readUpdateState(layout);
  if (!state) return null;
  const checkedAt = Date.parse(state.lastCheckedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt < 0 || now - checkedAt > maxAgeMs) return null;
  if (state.status !== "update-available") return null;
  if (compareStableVersions(state.latestVersion, currentVersion) <= 0) return null;
  return Object.freeze({ version: state.latestVersion, tag: state.latestTag, checkedAt: state.lastCheckedAt });
}

export async function writeUpdateCheck(layout, {
  currentVersion,
  manifest,
  checkedAt = new Date().toISOString(),
  errorCode = null,
}) {
  if (layout?.mode !== "managed") {
    const error = new Error("Development mode 不允许写 managed update state");
    error.code = "managed_install_required";
    throw error;
  }
  parseStableVersion(currentVersion);
  const previous = await readUpdateState(layout);
  const status = errorCode
    ? "check-failed"
    : compareStableVersions(manifest.version, currentVersion) > 0
      ? "update-available"
      : "up-to-date";
  const payload = {
    schemaVersion: UPDATE_STATE_SCHEMA_VERSION,
    channel: "stable",
    lastCheckedAt: checkedAt,
    lastSuccessfulCheckedAt: errorCode
      ? previous?.lastSuccessfulCheckedAt
        ?? (previous && previous.status !== "check-failed" ? previous.lastCheckedAt : null)
      : checkedAt,
    latestVersion: manifest?.version ?? null,
    latestTag: manifest?.tag ?? null,
    latestPublishedAt: manifest?.publishedAt ?? null,
    status,
    lastErrorCode: errorCode,
  };
  await atomicWriteJson(updateStatePath(layout), payload, layout.stateRoot);
  return payload;
}

export async function readTransitionHistory(layout) {
  if (layout?.mode !== "managed") return { schemaVersion: 1, transitions: [] };
  const path = historyStatePath(layout);
  try {
    const payload = JSON.parse(await readFile(path, "utf8"));
    if (payload?.schemaVersion !== 1 || !Array.isArray(payload.transitions)) {
      return { schemaVersion: 1, transitions: [] };
    }
    return {
      schemaVersion: 1,
      transitions: payload.transitions.filter(isTransition).slice(-UPDATE_HISTORY_LIMIT),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { schemaVersion: 1, transitions: [] };
    }
    throw error;
  }
}

export async function appendTransition(layout, transition) {
  if (layout?.mode !== "managed") {
    const error = new Error("Development mode 不允许写 managed transition history");
    error.code = "managed_install_required";
    throw error;
  }
  if (!isTransition(transition)) throw new Error("update transition 无效");
  const history = await readTransitionHistory(layout);
  const payload = {
    schemaVersion: 1,
    transitions: [...history.transitions, transition].slice(-UPDATE_HISTORY_LIMIT),
  };
  await atomicWriteJson(historyStatePath(layout), payload, layout.stateRoot);
  return payload;
}

export async function atomicWriteText(path, text, stateRoot) {
  await mkdir(stateRoot, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(String(text), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(path, payload, stateRoot) {
  await mkdir(stateRoot, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function updateStatePath(layout) {
  return assertContainedPath(layout.mutableRoot, join(layout.stateRoot, "update.json"), "update state");
}

function historyStatePath(layout) {
  return assertContainedPath(layout.mutableRoot, join(layout.stateRoot, "history.json"), "update history");
}

function validateUpdateState(payload) {
  if (payload?.schemaVersion !== UPDATE_STATE_SCHEMA_VERSION || payload?.channel !== "stable") return false;
  if (!Number.isFinite(Date.parse(payload.lastCheckedAt))) return false;
  if (
    payload.lastSuccessfulCheckedAt != null
    && !Number.isFinite(Date.parse(payload.lastSuccessfulCheckedAt))
  ) return false;
  if (!["up-to-date", "update-available", "check-failed"].includes(payload.status)) return false;
  if (payload.latestVersion != null) {
    try { parseStableVersion(payload.latestVersion); } catch { return false; }
  }
  if (payload.latestTag != null && payload.latestTag !== `v${payload.latestVersion}`) return false;
  if (payload.latestPublishedAt != null && !Number.isFinite(Date.parse(payload.latestPublishedAt))) return false;
  return payload.lastErrorCode == null || typeof payload.lastErrorCode === "string";
}

function isTransition(value) {
  if (!value || typeof value !== "object") return false;
  try {
    parseStableVersion(value.from);
    parseStableVersion(value.to);
  } catch {
    return false;
  }
  return Number.isFinite(Date.parse(value.switchedAt))
    && Number.isInteger(value.schemaBefore)
    && value.schemaBefore >= 0
    && Number.isInteger(value.schemaAfterExpected)
    && value.schemaAfterExpected >= 1
    && Number.isInteger(value.compatibilityEpoch)
    && value.compatibilityEpoch >= 1
    && (value.backup == null || typeof value.backup === "string");
}
