import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requestHttps, resolveProxyForUrl } from "./http-transport.js";
import { normalizeTimestamp } from "./usage.js";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_MS = 10_000;

export class CodexUsageUnavailableError extends Error {
  constructor(message, code = "usage_unavailable") {
    super(message);
    this.name = "CodexUsageUnavailableError";
    this.code = code;
  }
}

export class CodexUsageClient {
  constructor({
    codexHome,
    fetchImpl = null,
    proxyResolver = resolveProxyForUrl,
    now = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    this.codexHome = codexHome;
    this.fetchImpl = fetchImpl;
    this.proxyResolver = proxyResolver;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async fetchQuota() {
    const config = await readCodexUsageConfig(this.codexHome);
    const auth = await readCodexUsageAuth(this.codexHome);
    if (!auth) {
      throw new CodexUsageUnavailableError(
        "当前 Codex 全局认证不包含可用于 Usage 查询的 ChatGPT 登录凭据",
        "chatgpt_auth_unavailable",
      );
    }
    if (this.fetchImpl != null && typeof this.fetchImpl !== "function") {
      throw new CodexUsageUnavailableError("当前运行时不支持 fetch", "fetch_unavailable");
    }

    const url = resolveCodexUsageUrl(config.chatgptBaseUrl);
    let response;
    try {
      const requestOptions = {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-Id": auth.accountId,
          "User-Agent": "codex-cli",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      response = this.fetchImpl
        ? await this.fetchImpl(url, requestOptions)
        : await requestHttps(url, {
          ...requestOptions,
          redirect: "manual",
          proxyResolver: this.proxyResolver,
        });
    } catch (error) {
      throw new CodexUsageUnavailableError(
        error?.name === "TimeoutError"
          ? "Codex Usage 查询超时"
          : "无法连接 Codex Usage 服务",
        error?.name === "TimeoutError" ? "usage_timeout" : "usage_network_error",
      );
    }

    if (!response.ok) {
      throw new CodexUsageUnavailableError(
        `Codex Usage 查询失败（HTTP ${response.status}）`,
        response.status === 401 || response.status === 403
          ? "chatgpt_auth_rejected"
          : "usage_http_error",
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CodexUsageUnavailableError(
        "Codex Usage 返回了无法解析的 JSON",
        "usage_invalid_json",
      );
    }
    const quota = normalizeOfficialUsagePayload(payload, this.now());
    if (!quota) {
      throw new CodexUsageUnavailableError(
        "Codex Usage 响应中没有账号额度窗口",
        "usage_missing_rate_limit",
      );
    }
    return quota;
  }
}

export async function readCodexUsageConfig(codexHome) {
  const path = join(codexHome, "config.toml");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const configuredBaseUrl = readTopLevelTomlString(text, "chatgpt_base_url");
  return {
    chatgptBaseUrl: configuredBaseUrl || DEFAULT_CHATGPT_BASE_URL,
  };
}

export async function readCodexUsageAuth(codexHome) {
  const path = join(codexHome, "auth.json");
  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new CodexUsageUnavailableError("Codex auth.json 不是合法 JSON", "auth_invalid_json");
    }
    throw error;
  }
  const accessToken = nonEmptyText(payload?.tokens?.access_token);
  const accountId = nonEmptyText(payload?.tokens?.account_id);
  return accessToken && accountId ? { accessToken, accountId } : null;
}

export function resolveCodexUsageUrl(baseUrl = DEFAULT_CHATGPT_BASE_URL) {
  let normalized = nonEmptyText(baseUrl) || DEFAULT_CHATGPT_BASE_URL;
  normalized = normalized.replace(/\/+$/u, "");
  if (
    /^(?:https:\/\/)?(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/iu.test(normalized)
    && !normalized.includes("/backend-api")
  ) {
    normalized = `${normalized}/backend-api`;
  }
  return normalized.includes("/backend-api")
    ? `${normalized}/wham/usage`
    : `${normalized}/api/codex/usage`;
}

export { parseWindowsProxyRegistryOutput, resolveProxyForUrl } from "./http-transport.js";

export function normalizeOfficialUsagePayload(payload, observedAt = new Date()) {
  if (!payload || typeof payload !== "object") return null;
  const rateLimit = payload.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return null;
  const primary = normalizeOfficialWindow(rateLimit.primary_window);
  const secondary = normalizeOfficialWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return null;
  return {
    limitId: "codex",
    limitName: null,
    planType: nonEmptyText(payload.plan_type),
    primary,
    secondary,
    credits: payload.credits ?? null,
    observedAt: observedAt instanceof Date
      ? observedAt.toISOString()
      : normalizeTimestamp(observedAt) ?? new Date().toISOString(),
    source: "official-usage-api",
  };
}

function normalizeOfficialWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finiteNumber(window.used_percent);
  const seconds = finiteNumber(window.limit_window_seconds);
  const resetsAt = normalizeTimestamp(window.reset_at);
  if (usedPercent == null && seconds == null && resetsAt == null) return null;
  return {
    usedPercent,
    windowMinutes: seconds == null ? null : Math.ceil(seconds / 60),
    resetsAt,
  };
}

function readTopLevelTomlString(text, key) {
  let inTable = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(["'])(.*?)\2\s*$/u);
    if (match?.[1] === key) return match[3].trim();
  }
  return null;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === "#" && !quote) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
