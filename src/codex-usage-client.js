import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { normalizeTimestamp } from "./usage.js";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_MS = 10_000;
const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const execFileAsync = promisify(execFile);

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
        : await fetchWithSystemProxy(url, requestOptions, this.proxyResolver);
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

export async function resolveProxyForUrl(
  targetUrl,
  {
    environment = process.env,
    platform = process.platform,
    registryReader = readWindowsInternetProxy,
  } = {},
) {
  const target = new URL(targetUrl);
  if (isNoProxyHost(target.hostname, environment.NO_PROXY ?? environment.no_proxy)) return null;
  const environmentProxy =
    environment.HTTPS_PROXY
    ?? environment.https_proxy
    ?? environment.ALL_PROXY
    ?? environment.all_proxy;
  if (nonEmptyText(environmentProxy)) return normalizeProxyUrl(environmentProxy);
  if (platform !== "win32") return null;
  const windowsProxy = await registryReader();
  if (!windowsProxy?.enabled) return null;
  return proxyServerForProtocol(windowsProxy.server, target.protocol);
}

export function parseWindowsProxyRegistryOutput(output) {
  const text = String(output ?? "");
  const enableMatch = text.match(/^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/imu);
  const serverMatch = text.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/imu);
  return {
    enabled: enableMatch ? Number.parseInt(enableMatch[1], 16) !== 0 : false,
    server: serverMatch?.[1]?.trim() || null,
  };
}

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

async function fetchWithSystemProxy(url, options, proxyResolver) {
  const proxyUrl = await proxyResolver(url);
  if (!proxyUrl) return globalThis.fetch(url, options);
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new CodexUsageUnavailableError(
      "当前系统代理路径只支持 HTTPS Codex Usage",
      "usage_proxy_protocol_unsupported",
    );
  }
  return requestHttpsThroughProxy(target, options, proxyUrl);
}

async function requestHttpsThroughProxy(target, options, proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") {
    throw new CodexUsageUnavailableError(
      `暂不支持 ${proxy.protocol} 系统代理`,
      "usage_proxy_protocol_unsupported",
    );
  }
  const agent = new HttpsAgent({ keepAlive: false });
  agent.createConnection = (_requestOptions, callback) => {
    createProxyTunnel(target, proxy, options.signal).then(
      (socket) => callback(null, socket),
      (error) => callback(error),
    );
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method: options.method ?? "GET",
      headers: options.headers,
      agent,
      signal: options.signal,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode ?? 0,
          json: async () => JSON.parse(body),
          text: async () => body,
        });
      });
    });
    request.on("error", reject);
    request.end();
  }).finally(() => agent.destroy());
}

async function createProxyTunnel(target, proxy, signal) {
  const proxyPort = Number(proxy.port || 80);
  const targetPort = Number(target.port || 443);
  const socket = netConnect({ host: proxy.hostname, port: proxyPort });
  const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await onceSocket(socket, "connect");
    const proxyAuthorization = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
      : "";
    socket.write(
      `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n`
      + `Host: ${target.hostname}:${targetPort}\r\n`
      + "Proxy-Connection: Keep-Alive\r\n"
      + proxyAuthorization
      + "\r\n",
    );
    const remainder = await readProxyConnectResponse(socket);
    if (remainder.length) socket.unshift(remainder);
    const tlsSocket = tlsConnect({
      socket,
      servername: target.hostname,
    });
    await onceSocket(tlsSocket, "secureConnect");
    return tlsSocket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function readProxyConnectResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("system proxy closed the CONNECT tunnel"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 32 * 1024) {
        cleanup();
        reject(new Error("system proxy returned an oversized CONNECT response"));
        return;
      }
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      cleanup();
      const header = buffer.subarray(0, boundary).toString("latin1");
      const status = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/u)?.[1]);
      if (status !== 200) {
        reject(new Error(`system proxy CONNECT failed with HTTP ${status || "unknown"}`));
        return;
      }
      resolve(buffer.subarray(boundary + 4));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function onceSocket(socket, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onEvent);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed before ${event}`));
    };
    socket.once(event, onEvent);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function readWindowsInternetProxy() {
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", WINDOWS_INTERNET_SETTINGS],
      { encoding: "utf8", windowsHide: true },
    );
    return parseWindowsProxyRegistryOutput(stdout);
  } catch {
    return { enabled: false, server: null };
  }
}

function proxyServerForProtocol(value, protocol) {
  const text = nonEmptyText(value);
  if (!text) return null;
  if (!text.includes("=")) return normalizeProxyUrl(text);
  const entries = new Map(
    text.split(";")
      .map((entry) => entry.trim().split("=", 2))
      .filter(([key, server]) => key && server)
      .map(([key, server]) => [key.toLowerCase(), server.trim()]),
  );
  const key = protocol === "https:" ? "https" : "http";
  return normalizeProxyUrl(entries.get(key) ?? entries.get("http"));
}

function normalizeProxyUrl(value) {
  const text = nonEmptyText(value);
  if (!text) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`;
}

function isNoProxyHost(hostname, noProxyValue) {
  const host = hostname.toLowerCase();
  return String(noProxyValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const candidate = entry.split(":", 1)[0].replace(/^\./u, "");
      return host === candidate || host.endsWith(`.${candidate}`);
    });
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
