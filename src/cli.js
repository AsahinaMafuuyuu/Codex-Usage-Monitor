import { spawn } from "node:child_process";
import { getAppIdentity } from "./app-version.js";
import {
  BROWSER_AUTH_PROTOCOL_VERSION,
  createBootstrapProof,
  ensureBrowserAuthSecret,
} from "./browser-auth.js";
import { resolveRuntimeLayout } from "./runtime-layout.js";
import { compareStableVersions, ReleaseClient, ReleaseClientError } from "./release-client.js";
import { readFreshUpdateNotice, writeUpdateCheck } from "./update-state.js";

const HELP_TEXT = `Codex Usage Monitor

Usage:
  codex-usage-monitor [start] [--no-open]
  codex-usage-monitor open
  codex-usage-monitor --version | -V
  codex-usage-monitor --help | -h
  codex-usage-monitor --update | update [--check]
  codex-usage-monitor rollback [--restore-data]
  codex-usage-monitor doctor
`;

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
    this.code = "invalid_usage";
  }
}

export function parseCliArgs(argv = []) {
  const args = [...argv];
  if (args.length === 0) return { command: "start", flags: { noOpen: false } };
  if (args.length === 1 && args[0] === "--no-open") {
    return { command: "start", flags: { noOpen: true } };
  }
  if (args.length === 1 && ["--version", "-V"].includes(args[0])) {
    return { command: "version", flags: {} };
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return { command: "help", flags: {} };
  }
  if (args.length === 1 && args[0] === "--update") {
    return { command: "update", flags: {} };
  }

  const [command, ...rest] = args;
  if (command === "start") {
    if (rest.length === 0) return { command: "start", flags: { noOpen: false } };
    if (rest.length === 1 && rest[0] === "--no-open") {
      return { command: "start", flags: { noOpen: true } };
    }
    throw new CliUsageError("start 只支持 --no-open");
  }
  if (command === "open" && rest.length === 0) return { command: "open", flags: {} };
  if (command === "update") {
    if (rest.length === 0) return { command: "update", flags: {} };
    if (rest.length === 1 && rest[0] === "--check") {
      return { command: "update-check", flags: {} };
    }
    throw new CliUsageError("update 只支持 --check");
  }
  if (command === "rollback") {
    if (rest.length === 0) return { command: "rollback", flags: { restoreData: false } };
    if (rest.length === 1 && rest[0] === "--restore-data") {
      return { command: "rollback", flags: { restoreData: true } };
    }
    throw new CliUsageError("rollback 只支持 --restore-data");
  }
  if (command === "doctor" && rest.length === 0) return { command: "doctor", flags: {} };
  if (command === "doctor" && rest.length === 1 && rest[0] === "--release-self-check") {
    return { command: "release-self-check", flags: {} };
  }
  throw new CliUsageError(`未知命令或参数：${args.join(" ")}`);
}

export async function runCli(argv = [], dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    stderr.write(`${error.message}\n\n${HELP_TEXT}`);
    return { code: 2, status: "invalid-usage", command: null };
  }

  const getAppIdentityImpl = dependencies.getAppIdentityImpl ?? getAppIdentity;
  if (parsed.command === "version") {
    const identity = getAppIdentityImpl();
    stdout.write(`${identity.displayName} ${identity.version}\n`);
    const environment = dependencies.environment ?? process.env;
    const resolveRuntimeLayoutImpl = dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout;
    const readFreshUpdateNoticeImpl = dependencies.readFreshUpdateNoticeImpl ?? readFreshUpdateNotice;
    const runtimeLayout = resolveRuntimeLayoutImpl({ environment });
    const notice = await readFreshUpdateNoticeImpl(runtimeLayout, identity.version);
    if (notice) {
      stdout.write(`Update available: ${notice.version}\nRun: codex-usage-monitor --update\n`);
    }
    return { code: 0, status: "success", command: "version", version: identity.version };
  }
  if (parsed.command === "help") {
    stdout.write(HELP_TEXT);
    return { code: 0, status: "success", command: "help" };
  }
  if (parsed.command === "open") {
    return runOpenCommand(dependencies);
  }
  if (parsed.command === "release-self-check") {
    const runReleaseSelfCheckImpl = dependencies.runReleaseSelfCheckImpl
      ?? (await import("./release-self-check.js")).runReleaseSelfCheck;
    const result = await runReleaseSelfCheckImpl();
    stdout.write(`Release self-check OK: ${result.version}\n`);
    return { code: 0, status: "success", command: "release-self-check", ...result };
  }
  if (parsed.command === "update-check") {
    return runUpdateCheckCommand(dependencies);
  }
  if (parsed.command === "update") {
    return runManagedUpdateCommand(dependencies);
  }
  if (parsed.command === "rollback") {
    return runRollbackCommand(parsed.flags, dependencies);
  }
  if (parsed.command === "doctor") {
    return runDoctorCommand(dependencies);
  }
  if (parsed.command !== "start") {
    const handler = dependencies.commandHandlers?.[parsed.command];
    if (!handler) {
      stderr.write(`命令尚未可用：${parsed.command}\n`);
      return { code: 1, status: "not-implemented", command: parsed.command };
    }
    return handler(parsed.flags);
  }

  const environment = dependencies.environment ?? process.env;
  const resolveRuntimeLayoutImpl = dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout;
  const ensureBrowserAuthSecretImpl = dependencies.ensureBrowserAuthSecretImpl ?? ensureBrowserAuthSecret;
  const runtimeLayout = resolveRuntimeLayoutImpl({ environment });
  const browserAuthSecret = ensureBrowserAuthSecretImpl({
    stateRoot: runtimeLayout.stateRoot,
    mutableRoot: runtimeLayout.mutableRoot,
  });
  const startApplicationImpl = dependencies.startApplicationImpl
    ?? (await import("./server.js")).startApplication;
  const app = await startApplicationImpl({ runtimeLayout, browserAuthSecret, environment });
  stdout.write(`Codex Usage Monitor\n${app.accessUrl}\n`);
  if (app.codexHomeResolution?.warning) stderr.write(`${app.codexHomeResolution.warning}\n`);
  if (app.databaseResolution?.warning) stderr.write(`${app.databaseResolution.warning}\n`);
  if (runtimeLayout.mode === "managed") {
    const backgroundUpdateCheckImpl = dependencies.backgroundUpdateCheckImpl ?? runBackgroundUpdateCheck;
    const background = backgroundUpdateCheckImpl({
      runtimeLayout,
      version: getAppIdentityImpl().version,
      environment,
      dependencies,
    });
    void Promise.resolve(background).then((result) => {
      if (result?.status === "update-available") {
        stdout.write(`Update available: ${result.latestVersion}\nRun: codex-usage-monitor --update\n`);
      }
    }).catch(() => {});
  }
  if (!parsed.flags.noOpen) {
    const opened = await bootstrapBrowser({
      origin: app.origin ?? app.accessUrl.replace(/\/$/u, ""),
      secret: browserAuthSecret,
      fetchImpl: dependencies.fetchImpl,
      spawnImpl: dependencies.spawnImpl,
    });
    if (opened.status !== "opened") stderr.write(`${opened.message}\n`);
  }
  installShutdownHandlers(app, dependencies.processControl ?? process);
  return { code: 0, status: "running", command: "start", app };
}

async function runUpdateCheckCommand(dependencies) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = dependencies.environment ?? process.env;
  const identity = (dependencies.getAppIdentityImpl ?? getAppIdentity)();
  const runtimeLayout = (dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout)({ environment });
  const releaseClient = dependencies.releaseClient ?? new ReleaseClient({
    userAgent: `codex-usage-monitor/${identity.version}`,
  });
  const writeUpdateCheckImpl = dependencies.writeUpdateCheckImpl ?? writeUpdateCheck;
  let manifest;
  try {
    manifest = await releaseClient.fetchLatestManifest();
  } catch (error) {
    if (runtimeLayout.mode === "managed") {
      await writeUpdateCheckImpl(runtimeLayout, {
        currentVersion: identity.version,
        manifest: null,
        errorCode: error?.code ?? "release_check_failed",
      }).catch(() => {});
    }
    stderr.write(`Update check failed: ${error.message}\n`);
    return {
      code: error instanceof ReleaseClientError && error.code?.startsWith("manifest_") ? 4 : 3,
      status: "check-failed",
      command: "update-check",
      errorCode: error?.code ?? "release_check_failed",
    };
  }
  const status = compareStableVersions(manifest.version, identity.version) > 0
    ? "update-available"
    : "up-to-date";
  if (runtimeLayout.mode === "managed") {
    await writeUpdateCheckImpl(runtimeLayout, {
      currentVersion: identity.version,
      manifest,
    });
  }
  stdout.write(`Current: ${identity.version}\nLatest:  ${manifest.version}\nStatus:  ${status}\n`);
  return {
    code: 0,
    status,
    command: "update-check",
    currentVersion: identity.version,
    latestVersion: manifest.version,
  };
}

async function runManagedUpdateCommand(dependencies) {
  const identity = (dependencies.getAppIdentityImpl ?? getAppIdentity)();
  const environment = dependencies.environment ?? process.env;
  const layout = (dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout)({ environment });
  if (layout.mode !== "managed") return writeManagedRequired(dependencies, "update");
  const ManagedUpdaterImpl = dependencies.ManagedUpdaterImpl ?? (await import("./updater.js")).ManagedUpdater;
  const updater = dependencies.updater ?? new ManagedUpdaterImpl({
    layout,
    currentVersion: identity.version,
    port: Number(environment.CODEX_MONITOR_PORT ?? 47_832),
  });
  try {
    const result = await updater.update();
    const stdout = dependencies.stdout ?? process.stdout;
    if (result.status === "up-to-date") stdout.write(`Already up to date: ${result.version}\n`);
    else stdout.write(`Updated: ${result.fromVersion} -> ${result.toVersion}\n`);
    return { ...result, command: "update" };
  } catch (error) {
    return renderManagedCommandError(error, "update", dependencies);
  }
}

async function runBackgroundUpdateCheck({ runtimeLayout, version, environment, dependencies }) {
  const ManagedUpdaterImpl = dependencies.ManagedUpdaterImpl ?? (await import("./updater.js")).ManagedUpdater;
  const updater = dependencies.backgroundUpdater ?? new ManagedUpdaterImpl({
    layout: runtimeLayout,
    currentVersion: version,
    port: Number(environment.CODEX_MONITOR_PORT ?? 47_832),
  });
  return updater.checkIfDue({ ttlMs: 24 * 60 * 60 * 1000 });
}

async function runRollbackCommand(flags, dependencies) {
  const identity = (dependencies.getAppIdentityImpl ?? getAppIdentity)();
  const environment = dependencies.environment ?? process.env;
  const layout = (dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout)({ environment });
  if (layout.mode !== "managed") return writeManagedRequired(dependencies, "rollback");
  const ManagedUpdaterImpl = dependencies.ManagedUpdaterImpl ?? (await import("./updater.js")).ManagedUpdater;
  const updater = dependencies.updater ?? new ManagedUpdaterImpl({
    layout,
    currentVersion: identity.version,
    port: Number(environment.CODEX_MONITOR_PORT ?? 47_832),
  });
  try {
    const result = await updater.rollback({ restoreData: flags.restoreData });
    (dependencies.stdout ?? process.stdout).write(
      `Rolled back: ${result.fromVersion} -> ${result.toVersion}${result.dataRestored ? " (data restored)" : ""}\n`,
    );
    return { ...result, command: "rollback" };
  } catch (error) {
    return renderManagedCommandError(error, "rollback", dependencies);
  }
}

async function runDoctorCommand(dependencies) {
  const stdout = dependencies.stdout ?? process.stdout;
  const environment = dependencies.environment ?? process.env;
  const identity = (dependencies.getAppIdentityImpl ?? getAppIdentity)();
  const layout = (dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout)({ environment });
  const runDoctorImpl = dependencies.runDoctorImpl ?? (await import("./doctor.js")).runDoctor;
  const result = await runDoctorImpl({
    layout,
    appVersion: identity.version,
    environment,
  });
  stdout.write([
    `Status: ${result.status}`,
    `Version: ${result.appVersion}`,
    `Mode: ${result.mode}`,
    `Node: ${result.nodeVersion}`,
    `Install root: ${result.installRoot ?? "development"}`,
    `Current: ${result.currentVersion ?? result.appVersion}`,
    `SQLite: ${result.database.exists ? `schema ${result.database.schemaVersion} / ${result.database.quickCheck}` : "not created"}`,
    `.codex: ${result.codexReachable ? "reachable" : "unavailable"}`,
  ].join("\n") + "\n");
  return { code: result.status === "ok" ? 0 : 5, command: "doctor", ...result };
}

function writeManagedRequired(dependencies, command) {
  (dependencies.stderr ?? process.stderr).write(`${command} requires a Managed Install\n`);
  return { code: 5, status: "managed-install-required", command };
}

function renderManagedCommandError(error, command, dependencies) {
  (dependencies.stderr ?? process.stderr).write(`${command} failed: ${error.message}\n`);
  let code = 1;
  if (error instanceof ReleaseClientError) {
    code = error.code?.startsWith("manifest_") ? 4 : 3;
  } else if (error?.name === "DatabaseCompatibilityError") {
    code = 5;
  } else if (error?.name === "UpdaterError") {
    code = ["integrity_failed", "release_self_check_failed"].includes(error.code) ? 4 : 5;
  }
  return { code, status: "failed", command, errorCode: error?.code ?? "internal_error" };
}

async function runOpenCommand(dependencies) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = dependencies.environment ?? process.env;
  const resolveRuntimeLayoutImpl = dependencies.resolveRuntimeLayoutImpl ?? resolveRuntimeLayout;
  const ensureBrowserAuthSecretImpl = dependencies.ensureBrowserAuthSecretImpl ?? ensureBrowserAuthSecret;
  const runtimeLayout = resolveRuntimeLayoutImpl({ environment });
  const secret = ensureBrowserAuthSecretImpl({
    stateRoot: runtimeLayout.stateRoot,
    mutableRoot: runtimeLayout.mutableRoot,
  });
  const port = parseExactPort(environment.CODEX_MONITOR_PORT ?? 47_832);
  const origin = `http://127.0.0.1:${port}`;
  const result = await bootstrapBrowser({
    origin,
    secret,
    fetchImpl: dependencies.fetchImpl,
    spawnImpl: dependencies.spawnImpl,
  });
  if (result.status !== "opened") {
    stderr.write(`${result.message}\n`);
    return { code: 5, status: result.status, command: "open" };
  }
  stdout.write(`Opening ${origin}/\n`);
  return { code: 0, status: "opened", command: "open" };
}

export async function bootstrapBrowser({
  origin,
  secret,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
}) {
  let response;
  try {
    response = await fetchImpl(`${origin}/auth/challenge`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return {
      status: "monitor-not-running",
      message: `无法连接 ${origin}/；请先运行 codex-usage-monitor start`,
    };
  }
  if (!response?.ok) {
    return {
      status: "monitor-not-running",
      message: `监控器未在 ${origin}/ 提供授权服务；请先运行 codex-usage-monitor start`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: "auth-protocol-error", message: "本机监控器授权协议响应无效" };
  }
  if (
    payload?.protocolVersion !== BROWSER_AUTH_PROTOCOL_VERSION
    || typeof payload?.challenge !== "string"
    || !Number.isFinite(payload?.expiresAt)
  ) {
    return { status: "auth-protocol-error", message: "本机监控器授权协议版本不兼容" };
  }
  const proof = createBootstrapProof({
    secret,
    origin,
    challenge: payload.challenge,
    expiresAt: payload.expiresAt,
    protocolVersion: payload.protocolVersion,
  });
  const bootstrapUrl = new URL("/auth/bootstrap", origin);
  bootstrapUrl.searchParams.set("version", String(payload.protocolVersion));
  bootstrapUrl.searchParams.set("challenge", payload.challenge);
  bootstrapUrl.searchParams.set("expiresAt", String(payload.expiresAt));
  bootstrapUrl.searchParams.set("proof", proof);
  try {
    const child = spawnImpl("rundll32.exe", ["url.dll,FileProtocolHandler", bootstrapUrl.href], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child?.unref?.();
  } catch {
    return { status: "browser-open-failed", message: "无法启动本机默认浏览器" };
  }
  return { status: "opened", bootstrapUrl: bootstrapUrl.href };
}

function parseExactPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError("CODEX_MONITOR_PORT 必须是 1-65535 的整数");
  }
  return port;
}

function installShutdownHandlers(app, processControl) {
  if (typeof processControl?.once !== "function" || typeof app?.close !== "function") return;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      if (typeof processControl.exit === "function") processControl.exit(0);
    } catch (error) {
      if (typeof processControl.stderr?.write === "function") {
        processControl.stderr.write(`${error.stack ?? error.message}\n`);
      }
      processControl.exitCode = 1;
    }
  };
  processControl.once("SIGINT", () => void shutdown());
  processControl.once("SIGTERM", () => void shutdown());
}

export { HELP_TEXT };
