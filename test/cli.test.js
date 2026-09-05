import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getAppIdentity, getAppVersion } from "../src/app-version.js";
import { parseCliArgs, runCli } from "../src/cli.js";

test("CLI parser freezes the Phase 28 command aliases", () => {
  assert.deepEqual(parseCliArgs([]), { command: "start", flags: { noOpen: false } });
  assert.deepEqual(parseCliArgs(["--no-open"]), { command: "start", flags: { noOpen: true } });
  assert.deepEqual(parseCliArgs(["start"]), { command: "start", flags: { noOpen: false } });
  assert.deepEqual(parseCliArgs(["start", "--no-open"]), { command: "start", flags: { noOpen: true } });
  assert.equal(parseCliArgs(["--version"]).command, "version");
  assert.equal(parseCliArgs(["-V"]).command, "version");
  assert.equal(parseCliArgs(["--help"]).command, "help");
  assert.equal(parseCliArgs(["open"]).command, "open");
  assert.equal(parseCliArgs(["--update"]).command, "update");
  assert.equal(parseCliArgs(["update", "--check"]).command, "update-check");
  assert.deepEqual(parseCliArgs(["rollback", "--restore-data"]), {
    command: "rollback",
    flags: { restoreData: true },
  });
  assert.equal(parseCliArgs(["doctor"]).command, "doctor");
  assert.throws(() => parseCliArgs(["start", "--update"]), /start 只支持/u);
  assert.throws(() => parseCliArgs(["wat"]), /未知命令/u);
});

test("--version and --help do not initialize server, DB, Codex home, or network dependencies", async () => {
  let started = 0;
  let commandHandlerCalls = 0;
  const stdout = capture();
  const stderr = capture();
  const dependencies = {
    stdout,
    stderr,
    getAppIdentityImpl: () => ({
      displayName: "Codex Usage Monitor",
      version: "9.8.7",
    }),
    startApplicationImpl: async () => {
      started += 1;
      throw new Error("must not start");
    },
    commandHandlers: new Proxy({}, {
      get() {
        commandHandlerCalls += 1;
        throw new Error("must not touch command dependencies");
      },
    }),
  };
  const version = await runCli(["--version"], dependencies);
  const help = await runCli(["--help"], dependencies);
  assert.equal(version.code, 0);
  assert.equal(help.code, 0);
  assert.equal(started, 0);
  assert.equal(commandHandlerCalls, 0);
  assert.equal(stderr.text, "");
  assert.match(stdout.text, /Codex Usage Monitor 9\.8\.7/u);
  assert.match(stdout.text, /Usage:/u);
});

test("start and --no-open preserve startup alias behavior through the CLI seam", async () => {
  const seen = [];
  const stdout = capture();
  const processControl = { once() {} };
  const runtimeLayout = {
    stateRoot: "C:\\runtime\\state",
    mutableRoot: "C:\\runtime",
  };
  const browserAuthSecret = Buffer.alloc(32, 1);
  let browserOpenCount = 0;
  const startApplicationImpl = async (options) => {
    seen.push(options);
    return {
      accessUrl: "http://127.0.0.1:47832/",
      origin: "http://127.0.0.1:47832",
      codexHomeResolution: { warning: null },
      databaseResolution: { warning: null },
      close: async () => {},
    };
  };
  const dependencies = {
    stdout,
    stderr: capture(),
    processControl,
    environment: {},
    startApplicationImpl,
    resolveRuntimeLayoutImpl: () => runtimeLayout,
    ensureBrowserAuthSecretImpl: () => browserAuthSecret,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        protocolVersion: 1,
        challenge: "challenge",
        expiresAt: Date.now() + 60_000,
      }),
    }),
    spawnImpl: () => ({
      unref() {
        browserOpenCount += 1;
      },
    }),
  };
  await runCli([], dependencies);
  await runCli(["--no-open"], dependencies);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].runtimeLayout, runtimeLayout);
  assert.deepEqual(seen[0].browserAuthSecret, browserAuthSecret);
  assert.deepEqual(seen[1].browserAuthSecret, browserAuthSecret);
  assert.equal(browserOpenCount, 1);
});

test("package.json is the only App Version source and invalid metadata fails closed", async (t) => {
  assert.equal(getAppVersion(), "1.2.0");
  assert.equal(getAppIdentity().version, "1.2.0");
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({
    name: "codex-usage-monitor",
    version: "1.2.0-beta.1",
    engines: { node: ">=24.0.0" },
  }));
  assert.throws(() => getAppIdentity({ packagePath }), /stable SemVer/u);
});

test("usage errors return exit code 2 without starting the application", async () => {
  let started = false;
  const stderr = capture();
  const result = await runCli(["start", "--update"], {
    stdout: capture(),
    stderr,
    startApplicationImpl: async () => {
      started = true;
    },
  });
  assert.equal(result.code, 2);
  assert.equal(started, false);
  assert.match(stderr.text, /Usage:/u);
});

test("open bootstraps a one-shot browser URL without printing the proof", async () => {
  const stdout = capture();
  const stderr = capture();
  const secret = Buffer.alloc(32, 5);
  let spawnedCommand = null;
  let spawnedArgs = null;
  let spawnedUrl = null;
  const result = await runCli(["open"], {
    stdout,
    stderr,
    environment: { CODEX_MONITOR_PORT: "47832" },
    resolveRuntimeLayoutImpl: () => ({ stateRoot: "C:\\state", mutableRoot: "C:\\" }),
    ensureBrowserAuthSecretImpl: () => secret,
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:47832/auth/challenge");
      return {
        ok: true,
        json: async () => ({
          protocolVersion: 1,
          challenge: "one-shot-challenge",
          expiresAt: 1_800_000_000_000,
        }),
      };
    },
    spawnImpl: (command, args) => {
      spawnedCommand = command;
      spawnedArgs = args;
      spawnedUrl = args.at(-1);
      return { unref() {} };
    },
  });
  assert.equal(result.code, 0);
  assert.match(stdout.text, /^Opening http:\/\/127\.0\.0\.1:47832\/$/mu);
  assert.equal(stderr.text, "");
  assert.equal(spawnedCommand, "rundll32.exe");
  assert.deepEqual(spawnedArgs.slice(0, 1), ["url.dll,FileProtocolHandler"]);
  assert.notEqual(spawnedCommand.toLowerCase(), "cmd.exe");
  assert.match(spawnedUrl, /\/auth\/bootstrap\?/u);
  assert.match(spawnedUrl, /version=1&challenge=/u);
  assert.match(spawnedUrl, /&expiresAt=/u);
  assert.match(spawnedUrl, /&proof=/u);
  assert.match(spawnedUrl, /proof=/u);
  const proof = new URL(spawnedUrl).searchParams.get("proof");
  assert.ok(proof);
  assert.doesNotMatch(stdout.text, new RegExp(proof, "u"));
});

test("open reports monitor-not-running without launching a browser", async () => {
  let spawned = false;
  const result = await runCli(["open"], {
    stdout: capture(),
    stderr: capture(),
    environment: {},
    resolveRuntimeLayoutImpl: () => ({ stateRoot: "C:\\state", mutableRoot: "C:\\" }),
    ensureBrowserAuthSecretImpl: () => Buffer.alloc(32, 2),
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    spawnImpl: () => {
      spawned = true;
    },
  });
  assert.equal(result.code, 5);
  assert.equal(result.status, "monitor-not-running");
  assert.equal(spawned, false);
});

test("--version uses only a fresh local managed cache for the update notice", async () => {
  const stdout = capture();
  let noticeReads = 0;
  const result = await runCli(["--version"], {
    stdout,
    stderr: capture(),
    environment: {},
    getAppIdentityImpl: () => ({ displayName: "Codex Usage Monitor", version: "1.2.0" }),
    resolveRuntimeLayoutImpl: () => ({ mode: "managed" }),
    readFreshUpdateNoticeImpl: async () => {
      noticeReads += 1;
      return { version: "1.2.1" };
    },
    releaseClient: new Proxy({}, {
      get() { throw new Error("version must never touch network client"); },
    }),
  });
  assert.equal(result.code, 0);
  assert.equal(noticeReads, 1);
  assert.match(stdout.text, /Codex Usage Monitor 1\.2\.0/u);
  assert.match(stdout.text, /Update available: 1\.2\.1/u);
  assert.match(stdout.text, /codex-usage-monitor --update/u);
});

test("update --check is one-shot in development and persists cache only in managed mode", async () => {
  const releaseClient = { fetchLatestManifest: async () => ({
    version: "1.2.1",
    tag: "v1.2.1",
    publishedAt: "2026-09-04T20:00:00.000Z",
  }) };
  let writes = 0;
  const common = {
    stdout: capture(),
    stderr: capture(),
    environment: {},
    getAppIdentityImpl: () => ({ displayName: "Codex Usage Monitor", version: "1.2.0" }),
    releaseClient,
    writeUpdateCheckImpl: async () => { writes += 1; },
  };
  const development = await runCli(["update", "--check"], {
    ...common,
    resolveRuntimeLayoutImpl: () => ({ mode: "development" }),
  });
  assert.equal(development.code, 0);
  assert.equal(development.status, "update-available");
  assert.equal(writes, 0);

  const managed = await runCli(["update", "--check"], {
    ...common,
    resolveRuntimeLayoutImpl: () => ({ mode: "managed" }),
  });
  assert.equal(managed.code, 0);
  assert.equal(managed.status, "update-available");
  assert.equal(writes, 1);
});

test("direct --version does not load node:sqlite or write warnings to stderr", () => {
  const projectRoot = resolve(import.meta.dirname, "..");
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, "bin", "codex-usage-monitor.js"), "--version"],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_MONITOR_INSTALL_ROOT: "", LOCALAPPDATA: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Codex Usage Monitor 1\.2\.0\r?\n$/u);
});

test("managed start schedules update check without awaiting it", async () => {
  let resolveBackground;
  const backgroundPending = new Promise((resolvePromise) => { resolveBackground = resolvePromise; });
  let backgroundCalls = 0;
  const stdout = capture();
  const app = { accessUrl: "http://127.0.0.1:47832/", close: async () => {} };
  const result = await runCli(["start", "--no-open"], {
    stdout,
    stderr: capture(),
    environment: {},
    getAppIdentityImpl: () => ({ displayName: "Codex Usage Monitor", version: "1.2.0" }),
    resolveRuntimeLayoutImpl: () => ({
      mode: "managed",
      stateRoot: "C:\\managed\\state",
      mutableRoot: "C:\\managed",
    }),
    ensureBrowserAuthSecretImpl: () => Buffer.alloc(32, 1),
    startApplicationImpl: async () => app,
    backgroundUpdateCheckImpl: () => {
      backgroundCalls += 1;
      return backgroundPending;
    },
    processControl: {},
  });
  assert.equal(result.status, "running");
  assert.equal(backgroundCalls, 1);
  resolveBackground({ status: "update-available", latestVersion: "1.2.1" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.match(stdout.text, /Update available: 1\.2\.1/u);
});

function capture() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
      return true;
    },
  };
}
