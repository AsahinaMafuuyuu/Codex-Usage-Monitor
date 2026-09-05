import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserAuth, ensureBrowserAuthSecret } from "./browser-auth.js";
import { CodexUsageUnavailableError } from "./codex-usage-client.js";
import { MonitorDatabase } from "./database.js";
import { UsageMonitor } from "./monitor.js";
import { CodexRepository } from "./repository.js";
import { resolveDatabaseStorage, resolveRuntimeLayout } from "./runtime-layout.js";
import { resolveLocalDayRange } from "./snapshot-scope.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "..");
const publicDirectory = join(projectRoot, "public");
const lucideDirectory = join(projectRoot, "node_modules", "lucide", "dist", "umd");
const STATIC_FILES = new Map([
  ["/", { path: join(publicDirectory, "index.html"), type: "text/html; charset=utf-8" }],
  ["/styles.css", { path: join(publicDirectory, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: join(publicDirectory, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/assets/mizuki.png", { path: join(publicDirectory, "assets", "mizuki.png"), type: "image/png" }],
  ["/vendor/lucide.min.js", { path: join(lucideDirectory, "lucide.min.js"), type: "text/javascript; charset=utf-8" }],
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;

export async function startApplication(options = {}) {
  const environment = options.environment ?? process.env;
  const runtimeLayout = options.runtimeLayout ?? resolveRuntimeLayout({
    entryPath: options.entryPath,
    environment,
    localAppData: options.localAppData ?? environment.LOCALAPPDATA,
    projectRoot: options.projectRoot ?? projectRoot,
  });
  const codexHomeResolution = resolveCodexHome(options.codexHome);
  const codexHome = codexHomeResolution.path;
  const databaseResolution = resolveDatabaseStorage({
    layout: runtimeLayout,
    optionValue: options.databasePath,
    environment,
  });
  const databasePath = databaseResolution.path;
  const preferredPort = Number(
    options.port ?? environment.CODEX_MONITOR_PORT ?? 47_832,
  );
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new RangeError("CODEX_MONITOR_PORT 必须是 1-65535 的整数");
  }
  const browserAuthSecret = options.browserAuthSecret ?? ensureBrowserAuthSecret({
    stateRoot: runtimeLayout.stateRoot,
    mutableRoot: runtimeLayout.mutableRoot,
  });
  const browserAuth = createBrowserAuth({
    secret: browserAuthSecret,
    now: options.browserAuthNow,
    randomBytes: options.browserAuthRandomBytes,
  });
  const database = new MonitorDatabase(databasePath);
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  await monitor.initialize();

  let boundPort = preferredPort;
  let server;

  const handler = async (request, response) => {
    try {
      applySecurityHeaders(response);
      if (!isAllowedHost(request.headers.host, boundPort)) return sendText(response, 403, "Host 不受信任");
      if (!isAllowedOrigin(request)) return sendText(response, 403, "Origin 不受信任");
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const requestOrigin = `http://${request.headers.host}`;
      const allowedMutation = request.method === "POST" && isAllowedApiMutationPath(url.pathname);
      if (request.method !== "GET" && request.method !== "HEAD" && !allowedMutation) {
        response.setHeader("Allow", "GET, HEAD");
        return sendText(response, 405, "只支持只读请求");
      }

      if (url.pathname === "/auth/challenge") {
        if (request.method !== "GET") return sendText(response, 405, "challenge 仅支持 GET");
        return sendJson(response, 200, browserAuth.createBootstrapChallenge(requestOrigin));
      }
      if (url.pathname === "/auth/bootstrap") {
        if (request.method !== "GET") return sendText(response, 405, "bootstrap 仅支持 GET");
        const protocolVersion = Number(url.searchParams.get("version"));
        const challenge = url.searchParams.get("challenge");
        const expiresAt = Number(url.searchParams.get("expiresAt"));
        const proof = url.searchParams.get("proof");
        if (!challenge || !proof || !Number.isFinite(expiresAt)) {
          return sendText(response, 400, "浏览器授权参数无效");
        }
        const valid = browserAuth.consumeBootstrapProof({
          origin: requestOrigin,
          challenge,
          proof,
          expiresAt,
          protocolVersion,
        });
        if (!valid) return sendText(response, 401, "浏览器授权已失效或无效");
        const cookieValue = browserAuth.issueCookie(requestOrigin);
        response.statusCode = 302;
        response.setHeader(
          "Set-Cookie",
          `codex_monitor=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000`,
        );
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Location", "/");
        return response.end();
      }

      if (!hasValidSession(request, browserAuth, requestOrigin)) {
        return sendText(response, 401, "浏览器尚未授权；请运行 codex-usage-monitor open");
      }
      if (url.pathname === "/favicon.ico") return sendEmpty(response, 204);

      if (url.pathname.startsWith("/api/")) {
        return await handleApi({ request, response, url, monitor });
      }
      const asset = STATIC_FILES.get(url.pathname);
      if (!asset) return sendText(response, 404, "页面不存在");
      response.statusCode = 200;
      response.setHeader("Content-Type", asset.type);
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "HEAD") return response.end();
      return response.end(readFileSync(asset.path));
    } catch (error) {
      monitor.recordError("HTTP 请求失败", error);
      if (!response.headersSent) return sendJson(response, 500, { error: "本地监控器处理请求失败" });
      response.end();
    }
  };

  try {
    ({ server, port: boundPort } = await listenExactly(handler, preferredPort));
  } catch (error) {
    await monitor.close().catch(() => {});
    database.close();
    throw error;
  }
  const origin = `http://127.0.0.1:${boundPort}`;
  const accessUrl = `${origin}/`;

  const close = async () => {
    await monitor.close();
    await new Promise((done) => server.close(done));
    database.close();
  };

  return {
    server,
    port: boundPort,
    accessUrl,
    origin,
    codexHome,
    codexHomeResolution,
    databasePath,
    databaseResolution,
    runtimeLayout,
    monitor,
    close,
  };
}

export function resolveCodexHome(
  optionValue,
  { environment = process.env, userHome = homedir() } = {},
) {
  if (optionValue) {
    const path = resolve(optionValue);
    if (!existsSync(path)) throw new Error(`Codex 数据目录不存在：${path}`);
    return { path, source: "option", warning: null };
  }

  const configured = environment.CODEX_MONITOR_HOME;
  if (configured) {
    const path = resolve(configured);
    if (existsSync(path)) return { path, source: "environment", warning: null };
  }

  const candidates = [join(userHome, ".codex")];
  if (environment.USERPROFILE) candidates.push(join(environment.USERPROFILE, ".codex"));
  for (const candidate of [...new Set(candidates.map((path) => resolve(path)))]) {
    if (!existsSync(candidate)) continue;
    return {
      path: candidate,
      source: "current-user",
      warning: configured
        ? `CODEX_MONITOR_HOME 指向不存在的位置，已改用当前用户目录：${candidate}`
        : null,
    };
  }

  const checked = [...new Set(candidates.map((path) => resolve(path)))].join("；");
  throw new Error(
    configured
      ? `Codex 数据目录不存在：${resolve(configured)}；当前用户目录也未发现 .codex（已检查：${checked}）`
      : `当前 Windows 用户目录未发现 .codex（已检查：${checked}）`,
  );
}

export function resolveDatabasePath(optionValue, environment = process.env) {
  const layout = resolveRuntimeLayout({ environment, projectRoot });
  return resolveDatabaseStorage({ layout, optionValue, environment }).path;
}

async function handleApi({ request, response, url, monitor }) {
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/api/sessions") {
    return sendJson(response, 200, { sessions: monitor.listSessions(url.searchParams.get("q") ?? "") });
  }
  if (url.pathname === "/api/timeline") {
    return sendJson(response, 200, await monitor.timeline());
  }
  if (url.pathname === "/api/quota") {
    try {
      const quota = url.searchParams.get("refresh") === "1"
        ? await monitor.refreshQuotaNow()
        : monitor.quota();
      return sendJson(response, 200, { quota });
    } catch (error) {
      if (error instanceof CodexUsageUnavailableError) {
        return sendJson(response, 503, { error: error.message, code: error.code });
      }
      throw error;
    }
  }
  if (url.pathname === "/api/health") return sendJson(response, 200, { health: monitor.health() });

  const alertPolicyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostic-alert-policy$/u);
  if (alertPolicyMatch) {
    const sessionId = decodeAndValidateId(alertPolicyMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    if (request.method !== "POST") return sendJson(response, 405, { error: "该接口仅支持 POST" });
    const body = await readJsonBody(request);
    if (body.error) return sendJson(response, body.status, { error: body.error });
    try {
      const policy = monitor.updateDiagnosticAlertPolicy(sessionId, body.value);
      return policy
        ? sendJson(response, 200, { policy })
        : sendJson(response, 404, { error: "找不到该会话或工程" });
    } catch (error) {
      if (error instanceof RangeError) return sendJson(response, 400, { error: error.message });
      throw error;
    }
  }

  const alertSnoozeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostic-alerts\/snooze$/u);
  if (alertSnoozeMatch) {
    const sessionId = decodeAndValidateId(alertSnoozeMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    if (request.method !== "POST") return sendJson(response, 405, { error: "该接口仅支持 POST" });
    const policy = monitor.snoozeDiagnosticAlerts(sessionId);
    return policy
      ? sendJson(response, 200, { policy })
      : sendJson(response, 404, { error: "找不到该会话或工程" });
  }

  const alertAckMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/diagnostic-alerts\/([^/]+)\/ack$/u,
  );
  if (alertAckMatch) {
    const sessionId = decodeAndValidateId(alertAckMatch[1]);
    const alertId = decodeAndValidateId(alertAckMatch[2]);
    if (!sessionId || !alertId) return sendJson(response, 400, { error: "会话或 Alert ID 无效" });
    if (request.method !== "POST") return sendJson(response, 405, { error: "该接口仅支持 POST" });
    const acknowledgement = monitor.acknowledgeDiagnosticAlert(sessionId, alertId);
    if (acknowledgement == null) return sendJson(response, 404, { error: "找不到该会话" });
    if (acknowledgement === false) return sendJson(response, 404, { error: "当前会话不存在该 Alert" });
    return sendJson(response, 200, { acknowledgement });
  }

  const alertsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostic-alerts$/u);
  if (alertsMatch) {
    const sessionId = decodeAndValidateId(alertsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    if (request.method !== "GET") return sendJson(response, 405, { error: "该接口仅支持 GET" });
    const payload = monitor.diagnosticAlerts(sessionId);
    return payload
      ? sendJson(response, 200, payload)
      : sendJson(response, 404, { error: "找不到该会话或工程" });
  }

  const taskRequestsMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/tasks\/([^/]+)\/([^/]+)\/requests$/u,
  );
  if (taskRequestsMatch) {
    const sessionId = decodeAndValidateId(taskRequestsMatch[1]);
    const threadId = decodeAndValidateId(taskRequestsMatch[2]);
    const turnId = decodeAndValidateId(taskRequestsMatch[3]);
    if (!sessionId || !threadId || !turnId) {
      return sendJson(response, 400, { error: "会话或任务 ID 无效" });
    }
    const requestPage = parseTaskRequestPage(url);
    if (requestPage.error) return sendJson(response, 400, { error: requestPage.error });
    const payload = monitor.taskRequests(sessionId, threadId, turnId, requestPage.value);
    if (!payload) return sendJson(response, 404, { error: "找不到该任务" });
    const { nextAfter, ...body } = payload;
    return sendJson(response, 200, {
      ...body,
      nextCursor: nextAfter ? encodeTaskRequestCursor(nextAfter) : null,
    });
  }

  const requestContentMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/content$/u,
  );
  if (requestContentMatch) {
    const sessionId = decodeAndValidateId(requestContentMatch[1]);
    const requestId = decodeAndValidateId(requestContentMatch[2]);
    if (!sessionId || !requestId) {
      return sendJson(response, 400, { error: "会话或 Request ID 无效" });
    }
    if ([...url.searchParams.keys()].length > 0) {
      return sendJson(response, 400, { error: "Request Content 接口不接受查询参数" });
    }
    const payload = await monitor.requestContent(sessionId, requestId);
    if (!payload) return sendJson(response, 404, { error: "找不到该 Request" });
    if (request.method === "HEAD") return sendJsonHead(response, 200);
    return sendJson(response, 200, payload);
  }

  const requestInputContextMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/input-context$/u,
  );
  if (requestInputContextMatch) {
    const sessionId = decodeAndValidateId(requestInputContextMatch[1]);
    const requestId = decodeAndValidateId(requestInputContextMatch[2]);
    if (!sessionId || !requestId) {
      return sendJson(response, 400, { error: "会话或 Request ID 无效" });
    }
    if ([...url.searchParams.keys()].length > 0) {
      return sendJson(response, 400, { error: "Input Context 接口不接受查询参数" });
    }
    const payload = await monitor.requestInputContext(sessionId, requestId);
    if (!payload) return sendJson(response, 404, { error: "找不到该 Request" });
    if (request.method === "HEAD") return sendJsonHead(response, 200);
    return sendJson(response, 200, payload);
  }

  const requestContextDeltaMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/context-delta$/u,
  );
  if (requestContextDeltaMatch) {
    const sessionId = decodeAndValidateId(requestContextDeltaMatch[1]);
    const requestId = decodeAndValidateId(requestContextDeltaMatch[2]);
    if (!sessionId || !requestId) {
      return sendJson(response, 400, { error: "会话或 Request ID 无效" });
    }
    if ([...url.searchParams.keys()].length > 0) {
      return sendJson(response, 400, { error: "Context Delta 接口不接受查询参数" });
    }
    const payload = await monitor.requestContextDelta(sessionId, requestId);
    if (!payload) return sendJson(response, 404, { error: "找不到该 Request" });
    if (request.method === "HEAD") return sendJsonHead(response, 200);
    return sendJson(response, 200, payload);
  }

  const diagnosticsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diagnostics$/u);
  if (diagnosticsMatch) {
    const sessionId = decodeAndValidateId(diagnosticsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const scope = parseSnapshotScope(url);
    if (scope.error) return sendJson(response, 400, { error: scope.error });
    const payload = monitor.diagnostics(sessionId, scope.value);
    return payload
      ? sendJson(response, 200, payload)
      : sendJson(response, 404, { error: "找不到该会话" });
  }

  const advancedDiagnosticsMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/advanced-diagnostics$/u,
  );
  if (advancedDiagnosticsMatch) {
    const sessionId = decodeAndValidateId(advancedDiagnosticsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const scope = parseSnapshotScope(url);
    if (scope.error) return sendJson(response, 400, { error: scope.error });
    const payload = monitor.advancedDiagnostics(sessionId, scope.value);
    return payload
      ? sendJson(response, 200, payload)
      : sendJson(response, 404, { error: "找不到该会话" });
  }

  const behavioralDiagnosticsMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/behavioral-diagnostics$/u,
  );
  if (behavioralDiagnosticsMatch) {
    const sessionId = decodeAndValidateId(behavioralDiagnosticsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const scope = parseSnapshotScope(url);
    if (scope.error) return sendJson(response, 400, { error: scope.error });
    const payload = monitor.behavioralDiagnostics(sessionId, scope.value);
    return payload
      ? sendJson(response, 200, payload)
      : sendJson(response, 404, { error: "找不到该会话" });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
  if (sessionMatch) {
    const sessionId = decodeAndValidateId(sessionMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const scope = parseSnapshotScope(url);
    if (scope.error) return sendJson(response, 400, { error: scope.error });
    const snapshot = await monitor.selectSession(sessionId, scope.value);
    return snapshot
      ? sendJson(response, 200, snapshot)
      : sendJson(response, 404, { error: "找不到该会话" });
  }

  const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/u);
  if (eventsMatch) {
    const sessionId = decodeAndValidateId(eventsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const scope = parseSnapshotScope(url);
    if (scope.error) return sendJson(response, 400, { error: scope.error });
    const snapshot = await monitor.selectSession(sessionId, scope.value);
    if (!snapshot) return sendJson(response, 404, { error: "找不到该会话" });
    return openEventStream(request, response, monitor, sessionId, scope.value, snapshot);
  }

  const previewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/preview$/u);
  if (previewMatch) {
    const threadId = decodeAndValidateId(previewMatch[1]);
    const turnId = decodeAndValidateId(previewMatch[2]);
    if (!threadId || !turnId) return sendJson(response, 400, { error: "任务 ID 无效" });
    const preview = await monitor.taskPreview(threadId, turnId);
    return preview
      ? sendJson(response, 200, preview)
      : sendJson(response, 404, { error: "找不到该任务" });
  }
  return sendJson(response, 404, { error: "接口不存在" });
}

function openEventStream(request, response, monitor, sessionId, scope, snapshot) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  sendEvent(response, "snapshot", snapshot);

  const onUpdate = (event) => {
    if (event.sessionId !== sessionId) return;
    const nextSnapshot = monitor.snapshot(sessionId, scope);
    if (nextSnapshot) sendEvent(response, "snapshot", nextSnapshot);
  };
  const onQuota = (quota) => sendEvent(response, "quota", quota);
  const onHealth = (health) => sendEvent(response, "health", health);
  monitor.on("update", onUpdate);
  monitor.on("quota", onQuota);
  monitor.on("health", onHealth);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();

  request.on("close", () => {
    clearInterval(heartbeat);
    monitor.off("update", onUpdate);
    monitor.off("quota", onQuota);
    monitor.off("health", onHealth);
  });
}

function parseSnapshotScope(url) {
  if (!url.searchParams.has("day")) return { value: { type: "session" }, error: null };
  const day = url.searchParams.get("day");
  try {
    const range = resolveLocalDayRange(day);
    return { value: { type: "day", day, range }, error: null };
  } catch {
    return { value: null, error: "day 必须是合法的 YYYY-MM-DD 本地日期" };
  }
}

function parseTaskRequestPage(url) {
  const scope = parseSnapshotScope(url);
  if (scope.error) return scope;
  const limitText = url.searchParams.get("limit");
  const limit = limitText == null || limitText === "" ? 200 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { value: null, error: "limit 必须是 1 到 500 的整数" };
  }
  let after = null;
  const cursor = url.searchParams.get("cursor");
  const pageText = url.searchParams.get("page");
  let page = null;
  if (pageText != null && pageText !== "") {
    page = Number(pageText);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
      return { value: null, error: "page 必须是 1 到 1000000 的整数" };
    }
  }
  if (cursor && page != null) {
    return { value: null, error: "cursor 与 page 不能同时使用" };
  }
  if (cursor) {
    after = decodeTaskRequestCursor(cursor);
    if (!after) return { value: null, error: "cursor 无效或已损坏" };
  }
  return {
    value: {
      day: scope.value.type === "day" ? scope.value.day : null,
      range: scope.value.type === "day" ? scope.value.range : null,
      limit,
      after,
      page,
    },
    error: null,
  };
}

function encodeTaskRequestCursor({ observedAt, requestId }) {
  return Buffer.from(JSON.stringify([observedAt, requestId]), "utf8").toString("base64url");
}

function decodeTaskRequestCursor(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 1024) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [observedAt, requestId] = decoded;
    if (
      typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt)) ||
      typeof requestId !== "string" || requestId.length < 1 || requestId.length > 256
    ) return null;
    return { observedAt, requestId };
  } catch {
    return null;
  }
}

function sendEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function listenExactly(handler, port) {
  const server = createServer((request, response) => void handler(request, response));
  const result = await new Promise((resolveListen) => {
    const onError = (error) => resolveListen({ error });
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen({ server });
    });
  });
  if (result.error) {
    server.close();
    if (result.error.code === "EADDRINUSE") {
      const error = new Error(`端口 ${port} 已被占用`);
      error.name = "PortInUseError";
      error.code = "port_in_use";
      error.systemCode = "EADDRINUSE";
      throw error;
    }
    throw result.error;
  }
  return { server, port };
}

function hasValidSession(request, browserAuth, origin) {
  const cookies = parseCookies(request.headers.cookie ?? "");
  return browserAuth.verifyCookie(cookies.codex_monitor, origin);
}

function parseCookies(header) {
  const cookies = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    cookies[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return cookies;
}

function isAllowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${request.headers.host}`;
}

function isAllowedApiMutationPath(pathname) {
  return Boolean(
    /^\/api\/sessions\/[^/]+\/diagnostic-alert-policy$/u.test(pathname) ||
    /^\/api\/sessions\/[^/]+\/diagnostic-alerts\/snooze$/u.test(pathname) ||
    /^\/api\/sessions\/[^/]+\/diagnostic-alerts\/[^/]+\/ack$/u.test(pathname)
  );
}

async function readJsonBody(request, { maxBytes = 8_192 } = {}) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return { error: "Content-Type 必须为 application/json", status: 415 };
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) return { error: "JSON 请求体过大", status: 413 };
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "JSON 请求体必须是对象", status: 400 };
    }
    return { value };
  } catch {
    return { error: "JSON 请求体无效", status: 400 };
  }
}

function decodeAndValidateId(raw) {
  try {
    const value = decodeURIComponent(raw);
    return ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function applySecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendJsonHead(response, status) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end();
}

function sendText(response, status, text) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function sendEmpty(response, status) {
  response.statusCode = status;
  response.end();
}
