import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { MonitorDatabase } from "./database.js";
import { UsageMonitor } from "./monitor.js";
import { CodexRepository } from "./repository.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "..");
const publicDirectory = join(projectRoot, "public");
const STATIC_FILES = new Map([
  ["/", { path: join(publicDirectory, "index.html"), type: "text/html; charset=utf-8" }],
  ["/styles.css", { path: join(publicDirectory, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: join(publicDirectory, "app.js"), type: "text/javascript; charset=utf-8" }],
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;

export async function startApplication(options = {}) {
  const codexHome = resolve(
    options.codexHome ?? process.env.CODEX_MONITOR_HOME ?? join(homedir(), ".codex"),
  );
  const databasePath = resolve(
    options.databasePath ?? process.env.CODEX_MONITOR_DB ?? join(projectRoot, "data", "usage.sqlite"),
  );
  const preferredPort = Number(
    options.port ?? process.env.CODEX_MONITOR_PORT ?? 47_832,
  );
  if (!existsSync(codexHome)) throw new Error(`Codex 数据目录不存在：${codexHome}`);

  const database = new MonitorDatabase(databasePath);
  const repository = new CodexRepository(codexHome, database);
  const monitor = new UsageMonitor({ repository, database });
  await monitor.initialize();

  let launchToken = randomBytes(24).toString("base64url");
  const sessionSecret = randomBytes(24).toString("base64url");
  let boundPort = preferredPort;
  let server;

  const handler = async (request, response) => {
    try {
      applySecurityHeaders(response);
      if (!isAllowedHost(request.headers.host, boundPort)) return sendText(response, 403, "Host 不受信任");
      if (!isAllowedOrigin(request)) return sendText(response, 403, "Origin 不受信任");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        return sendText(response, 405, "只支持只读请求");
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname === "/favicon.ico") return sendEmpty(response, 204);
      if (url.pathname === "/" && launchToken && url.searchParams.get("token") === launchToken) {
        launchToken = null;
        response.statusCode = 302;
        response.setHeader(
          "Set-Cookie",
          `codex_monitor=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
        );
        response.setHeader("Location", "/");
        return response.end();
      }

      if (!hasValidSession(request, sessionSecret)) {
        return sendText(response, 401, "请使用启动命令输出的本次访问链接");
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi({ request, response, url, monitor });
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

  ({ server, port: boundPort } = await listenOnAvailable(handler, preferredPort));
  const accessUrl = `http://127.0.0.1:${boundPort}/?token=${launchToken}`;
  if (options.openBrowser !== false) openBrowser(accessUrl);

  const close = async () => {
    monitor.close();
    await new Promise((done) => server.close(done));
    database.close();
  };

  return { server, port: boundPort, accessUrl, codexHome, databasePath, monitor, close };
}

async function handleApi({ request, response, url, monitor }) {
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/api/sessions") {
    return sendJson(response, 200, { sessions: monitor.listSessions(url.searchParams.get("q") ?? "") });
  }
  if (url.pathname === "/api/quota") return sendJson(response, 200, { quota: monitor.quota() });
  if (url.pathname === "/api/health") return sendJson(response, 200, { health: monitor.health() });

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/u);
  if (sessionMatch) {
    const sessionId = decodeAndValidateId(sessionMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const snapshot = await monitor.selectSession(sessionId);
    return snapshot
      ? sendJson(response, 200, snapshot)
      : sendJson(response, 404, { error: "找不到该会话" });
  }

  const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/u);
  if (eventsMatch) {
    const sessionId = decodeAndValidateId(eventsMatch[1]);
    if (!sessionId) return sendJson(response, 400, { error: "会话 ID 无效" });
    const snapshot = await monitor.selectSession(sessionId);
    if (!snapshot) return sendJson(response, 404, { error: "找不到该会话" });
    return openEventStream(request, response, monitor, sessionId, snapshot);
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

function openEventStream(request, response, monitor, sessionId, snapshot) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  sendEvent(response, "snapshot", snapshot);

  const onUpdate = (event) => {
    if (event.sessionId === sessionId) sendEvent(response, "snapshot", event.snapshot);
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

function sendEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function listenOnAvailable(handler, preferredPort) {
  for (let port = preferredPort; port < preferredPort + 11; port += 1) {
    const server = createServer((request, response) => void handler(request, response));
    const result = await new Promise((resolveListen) => {
      const onError = (error) => resolveListen({ error });
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolveListen({ server });
      });
    });
    if (result.server) return { server: result.server, port };
    server.close();
    if (result.error?.code !== "EADDRINUSE") throw result.error;
  }
  throw new Error(`端口 ${preferredPort}-${preferredPort + 10} 均被占用`);
}

function openBrowser(url) {
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function hasValidSession(request, sessionSecret) {
  const cookies = parseCookies(request.headers.cookie ?? "");
  return cookies.codex_monitor === sessionSecret;
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

function sendText(response, status, text) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function sendEmpty(response, status) {
  response.statusCode = status;
  response.end();
}

async function main() {
  const openBrowser = !process.argv.includes("--no-open");
  const app = await startApplication({ openBrowser });
  process.stdout.write(`Codex Usage Monitor\n${app.accessUrl}\n`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
