import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { getAppVersion } from "./app-version.js";
import {
  assertRollbackCodeCompatibility,
  createEmergencyBackupPath,
  prepareDatabaseForUpdate,
  readDatabaseCompatibility,
  readInstalledBuildManifest,
  resolveBackupLocator,
  restoreDatabase,
} from "./database-backup.js";
import {
  compareStableVersions,
  ReleaseClient,
  validateReleaseManifest,
} from "./release-client.js";
import { assertContainedPath, isPathInside } from "./runtime-layout.js";
import {
  appendTransition,
  atomicWriteText,
  readUpdateState,
  readTransitionHistory,
  writeUpdateCheck,
} from "./update-state.js";

const execFileAsync = promisify(execFile);
const LOCK_NAME = "update.lock";

export class UpdaterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UpdaterError";
    this.code = code;
  }
}

export class ManagedUpdater {
  constructor({
    layout,
    releaseClient = new ReleaseClient({ userAgent: `codex-usage-monitor/${getAppVersion()}` }),
    currentVersion = getAppVersion(),
    extractArchiveImpl = extractArchive,
    archivePreflightImpl = assertSafeZipArchive,
    selfCheckImpl = runTargetSelfCheck,
    storagePreflight = prepareDatabaseForUpdate,
    appendTransitionImpl = appendTransition,
    writeUpdateCheckImpl = writeUpdateCheck,
    readDatabaseCompatibilityImpl = readDatabaseCompatibility,
    restoreDatabaseImpl = restoreDatabase,
    now = () => new Date(),
    randomBytesImpl = randomBytes,
    port = 47_832,
  }) {
    this.layout = layout;
    this.releaseClient = releaseClient;
    this.currentVersion = currentVersion;
    this.extractArchiveImpl = extractArchiveImpl;
    this.archivePreflightImpl = archivePreflightImpl;
    this.selfCheckImpl = selfCheckImpl;
    this.storagePreflight = storagePreflight;
    this.appendTransitionImpl = appendTransitionImpl;
    this.writeUpdateCheckImpl = writeUpdateCheckImpl;
    this.readDatabaseCompatibilityImpl = readDatabaseCompatibilityImpl;
    this.restoreDatabaseImpl = restoreDatabaseImpl;
    this.now = now;
    this.randomBytesImpl = randomBytesImpl;
    this.port = port;
  }

  async check() {
    const manifest = await this.releaseClient.fetchLatestManifest();
    return {
      currentVersion: this.currentVersion,
      latestVersion: manifest.version,
      status: compareStableVersions(manifest.version, this.currentVersion) > 0
        ? "update-available"
        : "up-to-date",
      manifest,
    };
  }

  async checkIfDue({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.#assertManaged();
    const state = await readUpdateState(this.layout);
    const lastSuccessful = state?.lastSuccessfulCheckedAt
      ?? (state && state.status !== "check-failed" ? state.lastCheckedAt : null);
    if (lastSuccessful) {
      const age = this.now().getTime() - Date.parse(lastSuccessful);
      if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
        return { status: "not-due", lastSuccessfulCheckedAt: lastSuccessful };
      }
    }
    try {
      const manifest = await this.releaseClient.fetchLatestManifest();
      const status = compareStableVersions(manifest.version, this.currentVersion) > 0
        ? "update-available"
        : "up-to-date";
      await this.writeUpdateCheckImpl(this.layout, {
        currentVersion: this.currentVersion,
        manifest,
        checkedAt: this.now().toISOString(),
      });
      return { status, latestVersion: manifest.version, manifest };
    } catch (error) {
      await this.writeUpdateCheckImpl(this.layout, {
        currentVersion: this.currentVersion,
        manifest: null,
        checkedAt: this.now().toISOString(),
        errorCode: error?.code ?? "release_check_failed",
      }).catch(() => {});
      return { status: "check-failed", errorCode: error?.code ?? "release_check_failed" };
    }
  }

  async update() {
    this.#assertManaged();
    const lock = await acquireUpdateLock(this.layout, { now: this.now });
    let downloadPath = null;
    let stagingPath = null;
    try {
      const manifest = await this.releaseClient.fetchLatestManifest();
      await lock.setTargetVersion(manifest.version);
      const comparison = compareStableVersions(manifest.version, this.currentVersion);
      if (comparison < 0) {
        throw new UpdaterError("latest stable version 低于当前版本；update 禁止降级", "downgrade_forbidden");
      }
      if (comparison === 0) {
        await this.writeUpdateCheckImpl(this.layout, { currentVersion: this.currentVersion, manifest });
        return { code: 0, status: "up-to-date", version: this.currentVersion };
      }
      if (manifest.runtime.platform !== "win32") {
        throw new UpdaterError("目标 Release 不是 win32", "runtime_incompatible");
      }
      if (!nodeRangeSatisfied(manifest.runtime.node, process.versions.node)) {
        throw new UpdaterError(
          `Node ${process.versions.node} 不满足目标 ${manifest.runtime.node}`,
          "runtime_incompatible",
        );
      }

      await mkdir(this.layout.appRoot, { recursive: true });
      await mkdir(this.layout.downloadsRoot, { recursive: true });
      const targetPath = assertContainedPath(
        this.layout.installRoot,
        join(this.layout.appRoot, `v${manifest.version}`),
        "target version directory",
      );
      let candidatePath = null;
      let reused = false;
      if (await pathExists(targetPath)) {
        await validateReleaseTree(targetPath, manifest);
        candidatePath = targetPath;
        reused = true;
      } else {
        const nonce = this.randomBytesImpl(8).toString("hex");
        downloadPath = assertContainedPath(
          this.layout.installRoot,
          join(this.layout.downloadsRoot, `${manifest.artifact.name}.tmp-${process.pid}-${nonce}.zip`),
          "release download",
        );
        stagingPath = assertContainedPath(
          this.layout.installRoot,
          join(this.layout.appRoot, `v${manifest.version}.staging-${nonce}`),
          "release staging",
        );
        await rm(stagingPath, { recursive: true, force: true });
        await this.releaseClient.downloadArtifact(manifest, downloadPath);
        const actualSha = await sha256File(downloadPath);
        if (actualSha !== manifest.artifact.sha256) {
          throw new UpdaterError("Release artifact SHA-256 不匹配", "integrity_failed");
        }
        await this.archivePreflightImpl(downloadPath);
        await mkdir(stagingPath, { recursive: true });
        await this.extractArchiveImpl(downloadPath, stagingPath);
        await validateReleaseTree(stagingPath, manifest);
        candidatePath = stagingPath;
      }

      await this.selfCheckImpl(candidatePath);
      if (typeof this.storagePreflight !== "function") {
        throw new UpdaterError("数据库 compatibility preflight 尚未绑定", "storage_preflight_required");
      }
      const storageResult = await this.storagePreflight({
        layout: this.layout,
        manifest,
        fromVersion: this.currentVersion,
        toVersion: manifest.version,
      });
      if (!storageResult || !Number.isInteger(storageResult.schemaBefore)) {
        throw new UpdaterError("数据库 compatibility preflight 返回无效", "storage_preflight_invalid");
      }

      if (!reused) {
        await rename(stagingPath, targetPath);
        stagingPath = null;
      }
      const switchedAt = this.now().toISOString();
      await this.#commitPointerAndHistory({
        fromVersion: this.currentVersion,
        toVersion: manifest.version,
        transition: {
          from: this.currentVersion,
          to: manifest.version,
          switchedAt,
          schemaBefore: storageResult.schemaBefore,
          schemaAfterExpected: manifest.storage.schemaVersion,
          compatibilityEpoch: manifest.storage.compatibilityEpoch,
          backup: storageResult.backup ?? null,
        },
      });
      let updateStateWarning = null;
      try {
        await this.writeUpdateCheckImpl(this.layout, {
          currentVersion: manifest.version,
          manifest,
          checkedAt: switchedAt,
        });
      } catch (error) {
        updateStateWarning = error?.code ?? "update_state_write_failed";
      }
      return {
        code: 0,
        status: "updated",
        fromVersion: this.currentVersion,
        toVersion: manifest.version,
        reused,
        backup: storageResult.backup ?? null,
        updateStateWarning,
      };
    } finally {
      if (downloadPath) await rm(downloadPath, { force: true }).catch(() => {});
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      await lock.release();
    }
  }

  async rollback({ restoreData = false } = {}) {
    this.#assertManaged();
    const lock = await acquireUpdateLock(this.layout, { now: this.now });
    try {
      const history = await readTransitionHistory(this.layout);
      const sourceTransition = [...history.transitions]
        .reverse()
        .find((transition) => transition.to === this.currentVersion);
      if (!sourceTransition) {
        throw new UpdaterError("没有可回退的已记录版本", "rollback_target_missing");
      }
      const targetVersion = sourceTransition.from;
      await lock.setTargetVersion(targetVersion);
      const targetRoot = assertContainedPath(
        this.layout.installRoot,
        join(this.layout.appRoot, `v${targetVersion}`),
        "rollback target",
      );
      if (!await pathExists(targetRoot)) {
        throw new UpdaterError(`rollback target v${targetVersion} 不存在`, "rollback_target_missing");
      }
      const currentRoot = this.layout.currentAppRoot
        ?? join(this.layout.appRoot, `v${this.currentVersion}`);
      const targetBuild = await readInstalledBuildManifest(targetRoot);
      const currentBuild = await readInstalledBuildManifest(currentRoot);
      if (targetBuild.version !== targetVersion || currentBuild.version !== this.currentVersion) {
        throw new UpdaterError("rollback installed manifest identity mismatch", "integrity_failed");
      }
      await this.selfCheckImpl(targetRoot);
      const databaseBefore = await this.readDatabaseCompatibilityImpl(this.layout.databasePath);

      if (!restoreData) {
        assertRollbackCodeCompatibility({
          targetBuildManifest: targetBuild,
          currentBuildManifest: currentBuild,
          database: databaseBefore,
        });
        await this.#commitRollback({
          targetVersion,
          targetBuild,
          schemaBefore: databaseBefore.schemaVersion,
          backup: null,
        });
        return {
          code: 0,
          status: "rolled-back",
          fromVersion: this.currentVersion,
          toVersion: targetVersion,
          dataRestored: false,
        };
      }

      if (!sourceTransition.backup) {
        throw new UpdaterError("该版本切换没有可用 pre-update backup", "rollback_backup_missing");
      }
      if (await isLoopbackPortListening(this.port)) {
        throw new UpdaterError("monitor server 仍在运行；请先停止后再 restore data", "database_writer_active");
      }
      const backupPath = resolveBackupLocator(this.layout, sourceTransition.backup);
      const backupCompatibility = await this.readDatabaseCompatibilityImpl(backupPath);
      if (!backupCompatibility.exists) {
        throw new UpdaterError("rollback backup 不存在", "rollback_backup_missing");
      }
      if (backupCompatibility.schemaVersion > targetBuild.storage.maxReadableSchemaVersion) {
        throw new UpdaterError(
          `rollback backup schema ${backupCompatibility.schemaVersion} 超出 target readable range`,
          "storage_incompatible",
        );
      }
      await mkdir(this.layout.backupsRoot, { recursive: true });
      const emergencyPath = createEmergencyBackupPath(this.layout, this.currentVersion, this.now());
      const restored = await this.restoreDatabaseImpl({
        backupPath,
        destinationPath: this.layout.databasePath,
        emergencyBackupPath: emergencyPath,
      });
      const emergencyLocator = databaseBefore.exists
        ? relative(this.layout.installRoot, emergencyPath).replaceAll("\\", "/")
        : null;
      try {
        await this.#commitRollback({
          targetVersion,
          targetBuild,
          schemaBefore: databaseBefore.schemaVersion,
          backup: emergencyLocator,
        });
      } catch (commitError) {
        if (databaseBefore.exists) {
          const abortBackupPath = createEmergencyBackupPath(this.layout, targetVersion, this.now());
          try {
            await this.restoreDatabaseImpl({
              backupPath: emergencyPath,
              destinationPath: this.layout.databasePath,
              emergencyBackupPath: abortBackupPath,
            });
          } catch (recoveryError) {
            throw new AggregateError(
              [commitError, recoveryError],
              "rollback data restore committed locally but pointer/history commit failed and DB recovery also failed",
            );
          }
        }
        throw commitError;
      }
      return {
        code: 0,
        status: "rolled-back",
        fromVersion: this.currentVersion,
        toVersion: targetVersion,
        dataRestored: true,
        emergencyBackup: emergencyLocator,
      };
    } finally {
      await lock.release();
    }
  }

  async doctor() {
    this.#assertManaged();
    return { status: "ok", mode: "managed", currentVersion: this.layout.currentVersion };
  }

  async #commitRollback({ targetVersion, targetBuild, schemaBefore, backup }) {
    await this.#commitPointerAndHistory({
      fromVersion: this.currentVersion,
      toVersion: targetVersion,
      transition: {
        from: this.currentVersion,
        to: targetVersion,
        switchedAt: this.now().toISOString(),
        schemaBefore,
        schemaAfterExpected: targetBuild.storage.schemaVersion,
        compatibilityEpoch: targetBuild.storage.compatibilityEpoch,
        backup,
      },
    });
  }

  async #commitPointerAndHistory({ fromVersion, toVersion, transition }) {
    const currentPath = join(this.layout.stateRoot, "current");
    await atomicWriteText(currentPath, `${toVersion}\n`, this.layout.stateRoot);
    try {
      await this.appendTransitionImpl(this.layout, transition);
    } catch (error) {
      try {
        await atomicWriteText(currentPath, `${fromVersion}\n`, this.layout.stateRoot);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `current pointer switched to ${toVersion}, history write failed, and pointer recovery failed`,
        );
      }
      throw error;
    }
  }

  #assertManaged() {
    if (this.layout?.mode !== "managed" || !this.layout.installRoot) {
      throw new UpdaterError("update/rollback 只允许 Managed Install", "managed_install_required");
    }
    if (this.layout.currentVersion && this.layout.currentVersion !== this.currentVersion) {
      throw new UpdaterError("运行版本与 managed current pointer 不一致", "managed_identity_mismatch");
    }
  }
}

export async function validateReleaseTree(root, externalManifest) {
  const manifest = validateReleaseManifest(externalManifest);
  const resolvedRoot = await realpath(root);
  const required = [
    "package.json",
    "build-manifest.json",
    "bin/codex-usage-monitor.js",
    "src/server.js",
    "public/index.html",
  ];
  for (const relativePath of required) {
    const path = resolve(resolvedRoot, relativePath);
    if (!isPathInside(resolvedRoot, path, { allowRoot: false })) {
      throw new UpdaterError("Release required path escape", "integrity_failed");
    }
    await access(path, fsConstants.R_OK).catch(() => {
      throw new UpdaterError(`Release 缺少 ${relativePath}`, "integrity_failed");
    });
  }
  await validateTreeContainment(resolvedRoot, resolvedRoot);
  let packageMetadata;
  let buildManifest;
  try {
    packageMetadata = JSON.parse(await readFile(join(resolvedRoot, "package.json"), "utf8"));
    buildManifest = JSON.parse(await readFile(join(resolvedRoot, "build-manifest.json"), "utf8"));
  } catch {
    throw new UpdaterError("Release metadata JSON 无效", "integrity_failed");
  }
  if (packageMetadata?.name !== manifest.name || packageMetadata?.version !== manifest.version) {
    throw new UpdaterError("Release package identity 与 manifest 不一致", "integrity_failed");
  }
  compareBuildIdentity(buildManifest, manifest);
  return { packageMetadata, buildManifest };
}

export function compareBuildIdentity(buildManifest, externalManifest) {
  const expected = {
    name: externalManifest?.name,
    version: externalManifest?.version,
    tag: externalManifest?.tag,
    commit: externalManifest?.commit,
    runtime: externalManifest?.runtime,
    storage: externalManifest?.storage,
  };
  const actual = {
    name: buildManifest?.name,
    version: buildManifest?.version,
    tag: buildManifest?.tag,
    commit: buildManifest?.commit,
    runtime: buildManifest?.runtime,
    storage: buildManifest?.storage,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new UpdaterError("embedded build-manifest identity 不匹配", "integrity_failed");
  }
  return true;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function acquireUpdateLock(layout, { now = () => new Date() } = {}) {
  if (layout?.mode !== "managed") throw new UpdaterError("Managed Install required", "managed_install_required");
  await mkdir(layout.stateRoot, { recursive: true });
  const path = assertContainedPath(layout.installRoot, join(layout.stateRoot, LOCK_NAME), "update lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new UpdaterError("已有 updater lock", "update_lock_conflict");
    throw error;
  }
  const startedAt = now().toISOString();
  const writeLock = async (targetVersion) => {
    const body = Buffer.from(`${JSON.stringify({
      pid: process.pid,
      startedAt,
      targetVersion,
    })}\n`, "utf8");
    await handle.write(body, 0, body.length, 0);
    await handle.truncate(body.length);
    await handle.sync();
  };
  await writeLock(null);
  let released = false;
  return {
    path,
    async setTargetVersion(version) { await writeLock(version); },
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => {});
      await rm(path, { force: true });
    },
  };
}

export function nodeRangeSatisfied(range, nodeVersion) {
  const required = String(range ?? "").match(/^>=(\d+)\.(\d+)\.(\d+)$/u);
  const actual = String(nodeVersion ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  if (!required || !actual) return false;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(actual[index]);
    const right = Number(required[index]);
    if (left !== right) return left > right;
  }
  return true;
}

async function validateTreeContainment(root, current) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new UpdaterError(`Release tree 包含 symlink/reparse: ${relative(root, path)}`, "integrity_failed");
    }
    const actual = await realpath(path);
    if (!isPathInside(root, actual, { allowRoot: false })) {
      throw new UpdaterError(`Release tree escape: ${relative(root, path)}`, "integrity_failed");
    }
    if (entry.isDirectory()) await validateTreeContainment(root, path);
  }
}

async function extractArchive(archivePath, destinationPath) {
  const script = "Expand-Archive -LiteralPath $env:CODEX_MONITOR_ARCHIVE -DestinationPath $env:CODEX_MONITOR_DESTINATION -Force";
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CODEX_MONITOR_ARCHIVE: archivePath,
        CODEX_MONITOR_DESTINATION: destinationPath,
      },
    },
  );
}

export async function assertSafeZipArchive(archivePath) {
  const script = String.raw`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:CODEX_MONITOR_ARCHIVE)
try {
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    $parts = $name.Split('/')
    if (
      [string]::IsNullOrWhiteSpace($name) -or
      $name.StartsWith('/') -or
      $name.StartsWith('//') -or
      $name -match '^[A-Za-z]:' -or
      $name.Contains(':') -or
      ($parts -contains '..')
    ) {
      throw "unsafe archive entry: $name"
    }
  }
} finally {
  $archive.Dispose()
}`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_MONITOR_ARCHIVE: archivePath },
      },
    );
  } catch (error) {
    throw new UpdaterError(
      `Release archive path validation failed: ${error?.stderr?.trim?.() || error?.message || "invalid archive"}`,
      "integrity_failed",
    );
  }
}

async function runTargetSelfCheck(root) {
  await execFileAsync(
    process.execPath,
    [join(root, "bin", "codex-usage-monitor.js"), "doctor", "--release-self-check"],
    { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isLoopbackPortListening(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
