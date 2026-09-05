import { writeFile } from "node:fs/promises";
import { requestHttps } from "./http-transport.js";

export const RELEASE_SOURCE = Object.freeze({
  owner: "AsahinaMafuuyuu",
  repo: "Codex-Usage-Monitor",
  channel: "stable",
});
export const LATEST_MANIFEST_URL =
  "https://github.com/AsahinaMafuuyuu/Codex-Usage-Monitor/releases/latest/download/release-manifest.json";
export const RELEASE_REDIRECT_HOSTS = Object.freeze(new Set([
  "github.com",
  "release-assets.githubusercontent.com",
]));
export const MAX_RELEASE_REDIRECTS = 5;
export const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ReleaseClientError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReleaseClientError";
    this.code = code;
  }
}

export class ReleaseClient {
  constructor({
    requestImpl = requestHttps,
    timeoutMs = 15_000,
    userAgent = "codex-usage-monitor",
    allowedRedirectHosts = RELEASE_REDIRECT_HOSTS,
  } = {}) {
    this.requestImpl = requestImpl;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.allowedRedirectHosts = new Set(allowedRedirectHosts);
  }

  async fetchLatestManifest() {
    const response = await this.#requestFollowingRedirects(LATEST_MANIFEST_URL, {
      headers: { Accept: "application/json", "User-Agent": this.userAgent },
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
      throw new ReleaseClientError("release manifest 超过大小上限", "manifest_too_large");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ReleaseClientError("release manifest 不是合法 JSON", "manifest_invalid_json");
    }
    return validateReleaseManifest(payload);
  }

  async downloadArtifact(manifest, destination) {
    const validated = validateReleaseManifest(manifest);
    const assetUrl = `https://github.com/${RELEASE_SOURCE.owner}/${RELEASE_SOURCE.repo}/releases/download/${validated.tag}/${encodeURIComponent(validated.artifact.name)}`;
    const response = await this.#requestFollowingRedirects(assetUrl, {
      headers: { Accept: "application/octet-stream", "User-Agent": this.userAgent },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== validated.artifact.size) {
      throw new ReleaseClientError(
        `artifact size 不匹配：expected=${validated.artifact.size} actual=${buffer.length}`,
        "artifact_size_mismatch",
      );
    }
    await writeFile(destination, buffer);
    return { destination, bytes: buffer.length };
  }

  async #requestFollowingRedirects(initialUrl, { headers }) {
    let current = validateReleaseUrl(initialUrl, this.allowedRedirectHosts);
    const seen = new Set();
    for (let hop = 0; hop <= MAX_RELEASE_REDIRECTS; hop += 1) {
      if (seen.has(current.href)) {
        throw new ReleaseClientError("GitHub Release redirect loop", "redirect_loop");
      }
      seen.add(current.href);
      const response = await this.requestImpl(current.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (!response.ok) {
          throw new ReleaseClientError(
            `GitHub Release 请求失败（HTTP ${response.status}）`,
            "release_http_error",
          );
        }
        return response;
      }
      if (hop === MAX_RELEASE_REDIRECTS) {
        throw new ReleaseClientError("GitHub Release redirect 超过 5 跳", "redirect_limit_exceeded");
      }
      const location = response.headers?.get?.("location");
      if (!location) {
        throw new ReleaseClientError("GitHub Release redirect 缺少 Location", "redirect_location_missing");
      }
      current = validateReleaseUrl(new URL(location, current).href, this.allowedRedirectHosts);
    }
    throw new ReleaseClientError("GitHub Release redirect 失败", "redirect_invalid");
  }
}

export function validateReleaseManifest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ReleaseClientError("release manifest 必须是对象", "manifest_invalid");
  }
  if (payload.schemaVersion !== 1) invalidManifest("schemaVersion 必须为 1");
  if (payload.name !== "codex-usage-monitor") invalidManifest("package name 不匹配");
  const version = parseStableVersion(payload.version);
  if (payload.tag !== `v${payload.version}`) invalidManifest("tag 与 version 不匹配");
  if (payload.channel !== RELEASE_SOURCE.channel) invalidManifest("channel 不是 stable");
  if (!HEX_40.test(String(payload.commit ?? ""))) invalidManifest("commit 必须是 40 位小写 hex");
  if (!isIsoTimestamp(payload.publishedAt)) invalidManifest("publishedAt 无效");
  if (payload.runtime?.platform !== "win32") invalidManifest("runtime platform 必须是 win32");
  if (typeof payload.runtime?.node !== "string" || !payload.runtime.node.trim()) {
    invalidManifest("runtime.node 缺失");
  }
  const storage = payload.storage;
  for (const key of [
    "schemaVersion",
    "compatibilityEpoch",
    "minMigratableSchemaVersion",
    "maxReadableSchemaVersion",
  ]) {
    if (!Number.isInteger(storage?.[key]) || storage[key] < 1) invalidManifest(`storage.${key} 无效`);
  }
  if (storage.minMigratableSchemaVersion > storage.schemaVersion) {
    invalidManifest("storage minMigratableSchemaVersion 高于 schemaVersion");
  }
  if (storage.schemaVersion > storage.maxReadableSchemaVersion) {
    invalidManifest("storage schemaVersion 高于 maxReadableSchemaVersion");
  }
  const artifact = payload.artifact;
  if (!isSafeArtifactName(artifact?.name)) invalidManifest("artifact name 无效");
  if (!HEX_64.test(String(artifact?.sha256 ?? ""))) invalidManifest("artifact sha256 无效");
  if (!Number.isInteger(artifact?.size) || artifact.size < 1 || artifact.size > MAX_RELEASE_ARTIFACT_BYTES) {
    invalidManifest("artifact size 无效");
  }
  return Object.freeze({
    schemaVersion: 1,
    name: payload.name,
    version: version.text,
    tag: payload.tag,
    channel: payload.channel,
    commit: payload.commit,
    publishedAt: new Date(payload.publishedAt).toISOString(),
    runtime: Object.freeze({ node: payload.runtime.node.trim(), platform: "win32" }),
    storage: Object.freeze({
      schemaVersion: storage.schemaVersion,
      compatibilityEpoch: storage.compatibilityEpoch,
      minMigratableSchemaVersion: storage.minMigratableSchemaVersion,
      maxReadableSchemaVersion: storage.maxReadableSchemaVersion,
    }),
    artifact: Object.freeze({
      name: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
    }),
  });
}

export function parseStableVersion(value) {
  const match = String(value ?? "").match(STABLE_VERSION);
  if (!match) throw new ReleaseClientError("version 不是 stable SemVer", "version_invalid");
  return Object.freeze({
    text: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function validateReleaseUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReleaseClientError("Release URL 无效", "redirect_url_invalid");
  }
  if (url.protocol !== "https:") {
    throw new ReleaseClientError("Release redirect 禁止非 HTTPS", "redirect_https_required");
  }
  if (url.username || url.password) {
    throw new ReleaseClientError("Release URL 禁止 embedded credential", "redirect_credentials_forbidden");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ReleaseClientError(`Release redirect host 不受信任：${url.hostname}`, "redirect_host_denied");
  }
  return url;
}

function invalidManifest(message) {
  throw new ReleaseClientError(message, "manifest_invalid");
}

function isSafeArtifactName(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 180
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("..")
    && /^[A-Za-z0-9._-]+\.zip$/u.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
