import { isAbsolute, relative, resolve } from "node:path";

const SOURCE_ROOTS = new Set(["sessions", "archived_sessions"]);
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/u;

export class CodexSourceLocator {
  constructor(codexHome) {
    this.codexHome = resolve(codexHome);
  }

  keyForPath(filePath) {
    const absolutePath = resolve(filePath);
    const relativePath = relative(this.codexHome, absolutePath);
    if (!relativePath || relativePath.split(/[\\/]/u)[0] === ".." || isAbsolute(relativePath)) return null;
    return normalizeSourceKey(relativePath);
  }

  pathForKey(sourceKey) {
    const normalizedKey = normalizeSourceKey(sourceKey);
    if (!normalizedKey) return null;
    const absolutePath = resolve(this.codexHome, ...normalizedKey.split("/"));
    const relativePath = relative(this.codexHome, absolutePath);
    if (!relativePath || relativePath.split(/[\\/]/u)[0] === ".." || isAbsolute(relativePath)) return null;
    return absolutePath;
  }
}

export function normalizeSourceKey(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().split("\\").join("/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/u.test(normalized)) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2 || !SOURCE_ROOTS.has(segments[0])) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (!ROLLOUT_NAME.test(segments.at(-1))) return null;
  return segments.join("/");
}

export function recoverLegacySourceKey(value) {
  const direct = normalizeSourceKey(value);
  if (direct) return direct;
  if (typeof value !== "string" || !value.trim()) return null;
  const segments = value.trim().split("\\").join("/").split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!SOURCE_ROOTS.has(segments[index])) continue;
    const candidate = normalizeSourceKey(segments.slice(index).join("/"));
    if (candidate) return candidate;
  }
  return null;
}
