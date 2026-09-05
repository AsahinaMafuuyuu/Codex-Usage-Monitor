import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

test("installer is pinned to the official stable source and managed shim never uses Git", async () => {
  const script = await readFile(join(PROJECT_ROOT, "scripts", "install.ps1"), "utf8");
  assert.match(script, /AsahinaMafuuyuu\/Codex-Usage-Monitor\/releases\/latest\/download\/release-manifest\.json/u);
  assert.match(script, /release-assets\.githubusercontent\.com/u);
  assert.match(script, /set "CODEX_MONITOR_INSTALL_ROOT=%ROOT%"/u);
  assert.match(script, /node "%ENTRY%" %\*/u);
  assert.doesNotMatch(script, /git\s+(?:pull|reset|checkout)/iu);
});

test("local artifact install smoke creates managed layout, migrates SQLite online, and runs the stable shim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = join(root, "release-tree");
  const localAppData = join(root, "local-app-data");
  const sourceCheckout = join(root, "source-checkout");
  const artifactPath = join(root, "codex-usage-monitor-v1.2.0-win.zip");
  const manifestPath = join(root, "release-manifest.json");
  await createReleaseFixture(fixtureRoot);
  await mkdir(join(sourceCheckout, "data"), { recursive: true });
  const sourceDatabase = join(sourceCheckout, "data", "usage.sqlite");
  createMigrationDatabase(sourceDatabase);

  const compressed = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${fixtureRoot.replaceAll("'", "''")}\\*' -DestinationPath '${artifactPath.replaceAll("'", "''")}' -Force`,
  ], { encoding: "utf8" });
  assert.equal(compressed.status, 0, compressed.stderr || compressed.stdout);
  const artifact = await readFile(artifactPath);
  const manifest = releaseManifest(artifact.length, createHash("sha256").update(artifact).digest("hex"));
  await writeFile(manifestPath, JSON.stringify(manifest));

  const command = [
    `. '${join(PROJECT_ROOT, "scripts", "install.ps1").replaceAll("'", "''")}'`,
    `$r=Install-CodexUsageMonitorFromArtifact -ManifestPath '${manifestPath.replaceAll("'", "''")}' -ArtifactPath '${artifactPath.replaceAll("'", "''")}' -LocalAppData '${localAppData.replaceAll("'", "''")}' -MigrateFrom '${sourceCheckout.replaceAll("'", "''")}' -UpdateUserPath $false`,
    `$r | ConvertTo-Json -Depth 5`,
  ].join("; ");
  const installed = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const installRoot = join(localAppData, "CodexUsageMonitor");
  assert.equal((await readFile(join(installRoot, "state", "current"), "utf8")).trim(), "1.2.0");
  const marker = JSON.parse(await readFile(join(installRoot, "state", "install.json"), "utf8"));
  assert.equal(marker.name, "codex-usage-monitor");
  assert.equal(marker.migration.sourceSchema, 15);
  assert.equal(marker.migration.destinationSchema, 15);
  assert.equal((await stat(sourceDatabase)).isFile(), true);
  const managedDatabase = new DatabaseSync(join(installRoot, "data", "usage.sqlite"), { readOnly: true });
  assert.equal(managedDatabase.prepare("PRAGMA user_version").get().user_version, 15);
  assert.equal(managedDatabase.prepare("SELECT value FROM install_smoke WHERE id=1").get().value, "source-preserved");
  managedDatabase.close();

  const shimPath = join(installRoot, "bin", "codex-usage-monitor.cmd");
  const shimRun = spawnSync("cmd.exe", ["/d", "/c", shimPath, "--version"], {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(shimRun.status, 0, shimRun.stderr || shimRun.stdout);
  assert.match(shimRun.stdout, /Codex Usage Monitor 1\.2\.0/u);
});

async function createReleaseFixture(root) {
  await mkdir(root, { recursive: true });
  for (const directory of ["bin", "src", "public"]) {
    await cp(join(PROJECT_ROOT, directory), join(root, directory), { recursive: true });
  }
  const lucideTarget = join(root, "node_modules", "lucide", "dist", "umd");
  await mkdir(lucideTarget, { recursive: true });
  await cp(
    join(PROJECT_ROOT, "node_modules", "lucide", "dist", "umd", "lucide.min.js"),
    join(lucideTarget, "lucide.min.js"),
  );
  await cp(join(PROJECT_ROOT, "package.json"), join(root, "package.json"));
  await cp(join(PROJECT_ROOT, "package-lock.json"), join(root, "package-lock.json"));
  await writeFile(join(root, "build-manifest.json"), JSON.stringify({
    name: "codex-usage-monitor",
    version: "1.2.0",
    tag: "v1.2.0",
    commit: "a".repeat(40),
    runtime: { node: ">=24.0.0", platform: "win32" },
    storage: {
      schemaVersion: 15,
      compatibilityEpoch: 1,
      minMigratableSchemaVersion: 1,
      maxReadableSchemaVersion: 15,
    },
  }));
}

function createMigrationDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE install_smoke(id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  database.prepare("INSERT INTO install_smoke(id, value) VALUES(1, ?)").run("source-preserved");
  database.exec("PRAGMA user_version=15;");
  database.close();
}

function releaseManifest(size, sha256) {
  return {
    schemaVersion: 1,
    name: "codex-usage-monitor",
    version: "1.2.0",
    tag: "v1.2.0",
    channel: "stable",
    commit: "a".repeat(40),
    publishedAt: "2026-09-04T00:00:00.000Z",
    runtime: { node: ">=24.0.0", platform: "win32" },
    storage: {
      schemaVersion: 15,
      compatibilityEpoch: 1,
      minMigratableSchemaVersion: 1,
      maxReadableSchemaVersion: 15,
    },
    artifact: { name: "codex-usage-monitor-v1.2.0-win.zip", sha256, size },
  };
}
