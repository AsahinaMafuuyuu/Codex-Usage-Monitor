import assert from "node:assert/strict";
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildRelease } from "../scripts/build-release.js";
import { runCli } from "../src/cli.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { ManagedUpdater } from "../src/updater.js";

const ROOT = resolve(import.meta.dirname, "..");

test("clean runtime artifacts install, update to a new managed version, and rollback atomically", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-release-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project120 = join(root, "project-1.2.0");
  const project121 = join(root, "project-1.2.1");
  await createProjectCopy(project120, "1.2.0");
  await createProjectCopy(project121, "1.2.1");

  const release120 = await buildRelease({
    projectRoot: project120,
    tag: "v1.2.0",
    commit: "1".repeat(40),
    outputDir: join(root, "release-1.2.0"),
    publishedAt: "2026-09-04T23:30:00.000Z",
  });
  const release121 = await buildRelease({
    projectRoot: project121,
    tag: "v1.2.1",
    commit: "2".repeat(40),
    outputDir: join(root, "release-1.2.1"),
    publishedAt: "2026-09-04T23:31:00.000Z",
  });

  const localAppData = join(root, "local-app-data");
  const installCommand = [
    `. '${release120.installerPath.replaceAll("'", "''")}'`,
    `Install-CodexUsageMonitorFromArtifact -ManifestPath '${release120.manifestPath.replaceAll("'", "''")}' -ArtifactPath '${release120.artifactPath.replaceAll("'", "''")}' -LocalAppData '${localAppData.replaceAll("'", "''")}' -UpdateUserPath $false | Out-Null`,
  ].join("; ");
  const install = spawnSync("powershell.exe", ["-NoProfile", "-Command", installCommand], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const installRoot = join(localAppData, "CodexUsageMonitor");
  const shimPath = join(installRoot, "bin", "codex-usage-monitor.cmd");
  assertVersion(shimPath, localAppData, "1.2.0");

  const environment = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    CODEX_MONITOR_INSTALL_ROOT: installRoot,
    CODEX_MONITOR_PORT: "49991",
  };
  const layout120 = resolveRuntimeLayout({
    entryPath: join(installRoot, "app", "v1.2.0", "bin", "codex-usage-monitor.js"),
    environment,
    projectRoot: project120,
  });
  assert.equal(layout120.mode, "managed");
  const manifest121 = JSON.parse(await readFile(release121.manifestPath, "utf8"));
  const updateReleaseClient = {
    fetchLatestManifest: async () => manifest121,
    downloadArtifact: async (_manifest, destination) => copyFile(release121.artifactPath, destination),
  };
  const updater120 = new ManagedUpdater({
    layout: layout120,
    currentVersion: "1.2.0",
    releaseClient: updateReleaseClient,
    port: 49_991,
  });
  const updateOutput = capture();
  const updateError = capture();
  const update = await runCli(["update"], {
    stdout: updateOutput,
    stderr: updateError,
    environment,
    getAppIdentityImpl: () => ({ displayName: "Codex Usage Monitor", version: "1.2.0" }),
    resolveRuntimeLayoutImpl: () => layout120,
    updater: updater120,
  });
  assert.equal(update.status, "updated", updateError.text || JSON.stringify(update));
  assert.match(updateOutput.text, /Updated: 1\.2\.0 -> 1\.2\.1/u);
  assertVersion(shimPath, localAppData, "1.2.1");

  const layout121 = resolveRuntimeLayout({
    entryPath: join(installRoot, "app", "v1.2.1", "bin", "codex-usage-monitor.js"),
    environment,
    projectRoot: project121,
  });
  assert.equal(layout121.mode, "managed");
  const updater121 = new ManagedUpdater({
    layout: layout121,
    currentVersion: "1.2.1",
    releaseClient: {},
    port: 49_991,
  });
  const rollbackOutput = capture();
  const rollbackError = capture();
  const rollback = await runCli(["rollback"], {
    stdout: rollbackOutput,
    stderr: rollbackError,
    environment,
    getAppIdentityImpl: () => ({ displayName: "Codex Usage Monitor", version: "1.2.1" }),
    resolveRuntimeLayoutImpl: () => layout121,
    updater: updater121,
  });
  assert.equal(rollback.status, "rolled-back", rollbackError.text || JSON.stringify(rollback));
  assert.match(rollbackOutput.text, /Rolled back: 1\.2\.1 -> 1\.2\.0/u);
  assertVersion(shimPath, localAppData, "1.2.0");

  const versions = (await readdir(join(installRoot, "app"))).sort();
  assert.deepEqual(versions, ["v1.2.0", "v1.2.1"]);
  assert.equal((await readFile(join(installRoot, "state", "current"), "utf8")).trim(), "1.2.0");
  assert.equal(await pathExists(join(installRoot, "state", "update.lock")), false);
  assert.deepEqual(await readdir(join(installRoot, "downloads")), []);

  const doctor = spawnSync("cmd.exe", ["/d", "/c", shimPath, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData, CODEX_MONITOR_PORT: "49991" },
  });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /Mode: managed/u);
  assert.match(doctor.stdout, /Current: 1\.2\.0/u);
});

async function createProjectCopy(destination, version) {
  await mkdir(destination, { recursive: true });
  for (const directory of ["bin", "src", "public"]) {
    await cp(join(ROOT, directory), join(destination, directory), { recursive: true });
  }
  await mkdir(join(destination, "scripts"), { recursive: true });
  await cp(join(ROOT, "scripts", "install.ps1"), join(destination, "scripts", "install.ps1"));
  const packageMetadata = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  packageMetadata.version = version;
  await writeFile(join(destination, "package.json"), `${JSON.stringify(packageMetadata, null, 2)}\n`);
  const lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  lock.version = version;
  lock.packages[""].version = version;
  await writeFile(join(destination, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

function assertVersion(shimPath, localAppData, version) {
  const result = spawnSync("cmd.exe", ["/d", "/c", shimPath, "--version"], {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`Codex Usage Monitor ${version.replaceAll(".", "\\.")}`, "u"));
}

function capture() {
  return {
    text: "",
    write(value) { this.text += String(value); },
  };
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
