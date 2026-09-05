import { execFile } from "node:child_process";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";

const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const execFileAsync = promisify(execFile);

export async function requestHttps(url, {
  method = "GET",
  headers = {},
  signal,
  redirect = "manual",
  proxyResolver = resolveProxyForUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    const error = new Error(`HTTPS transport 不允许 ${target.protocol} URL`);
    error.code = "https_required";
    throw error;
  }
  const proxyUrl = await proxyResolver(target.href);
  if (!proxyUrl) {
    if (typeof fetchImpl !== "function") {
      const error = new Error("当前运行时不支持 fetch");
      error.code = "fetch_unavailable";
      throw error;
    }
    return fetchImpl(target.href, { method, headers, signal, redirect });
  }
  return requestHttpsThroughProxy(target, { method, headers, signal }, proxyUrl);
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
  const environmentProxy = environment.HTTPS_PROXY ?? environment.https_proxy
    ?? environment.ALL_PROXY ?? environment.all_proxy;
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

async function requestHttpsThroughProxy(target, options, proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") {
    const error = new Error(`暂不支持 ${proxy.protocol} 系统代理`);
    error.code = "proxy_protocol_unsupported";
    throw error;
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
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
          else if (value != null) headers.set(key, String(value));
        }
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          headers,
          url: target.href,
          json: async () => JSON.parse(body.toString("utf8")),
          text: async () => body.toString("utf8"),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
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
    const tlsSocket = tlsConnect({ socket, servername: target.hostname });
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
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("system proxy closed the CONNECT tunnel")); };
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
    const onEvent = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error(`socket closed before ${event}`)); };
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
  return String(noProxyValue ?? "").split(",")
    .map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const candidate = entry.split(":", 1)[0].replace(/^\./u, "");
      return host === candidate || host.endsWith(`.${candidate}`);
    });
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
