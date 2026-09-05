import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assertContainedPath, isPathInside } from "./runtime-layout.js";

export class DatabaseCompatibilityError extends Error {
  constructor(message, code = "storage_incompatible") {
    super(message);
    this.name = "DatabaseCompatibilityError";
    this.code = code;
  }
}

export async function readDatabaseCompatibility(databasePath) {
  try {
    await access(databasePath, fsConstants.R_OK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ exists: false, schemaVersion: 0, quickCheck: "not-applicable" });
    }
    throw error;
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    const quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check ?? null;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw new DatabaseCompatibilityError("SQLite user_version 无效", "database_invalid");
    }
    if (quickCheck !== "ok") {
      throw new DatabaseCompatibilityError(`SQLite quick_check failed: ${quickCheck ?? "unknown"}`, "database_corrupt");
    }
    return Object.freeze({ exists: true, schemaVersion, quickCheck: "ok" });
  } finally {
    database?.close();
  }
}

export async function backupDatabase({ sourcePath, destinationPath }) {
  const source = await readDatabaseCompatibility(sourcePath);
  if (!source.exists) {
    throw new DatabaseCompatibilityError("source SQLite database 不存在", "database_missing");
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { force: true });
  const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqliteBackup(sourceDatabase, destinationPath);
  } finally {
    sourceDatabase.close();
  }
  const destination = await readDatabaseCompatibility(destinationPath);
  if (destination.schemaVersion !== source.schemaVersion) {
    await rm(destinationPath, { force: true }).catch(() => {});
    throw new DatabaseCompatibilityError("SQLite backup schema mismatch", "database_backup_invalid");
  }
  return Object.freeze({
    sourceSchemaVersion: source.schemaVersion,
    destinationSchemaVersion: destination.schemaVersion,
    destinationPath,
  });
}

export async function migrateDatabase({ sourcePath, destinationPath }) {
  try {
    await access(destinationPath);
    throw new DatabaseCompatibilityError("managed destination DB 已存在，拒绝覆盖迁移", "migration_destination_exists");
  } catch (error) {
    if (error instanceof DatabaseCompatibilityError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  return backupDatabase({ sourcePath, destinationPath });
}

export async function restoreDatabase({ backupPath, destinationPath, emergencyBackupPath }) {
  const backupCompatibility = await readDatabaseCompatibility(backupPath);
  if (!backupCompatibility.exists) {
    throw new DatabaseCompatibilityError("rollback backup 不存在", "rollback_backup_missing");
  }
  const current = await readDatabaseCompatibility(destinationPath);
  let emergency = null;
  if (current.exists) {
    if (!emergencyBackupPath) {
      throw new DatabaseCompatibilityError("restore 必须先指定 emergency backup", "emergency_backup_required");
    }
    emergency = await backupDatabase({ sourcePath: destinationPath, destinationPath: emergencyBackupPath });
  }
  const temporary = `${destinationPath}.restore-${process.pid}-${Date.now()}`;
  let replacedDestination = false;
  try {
    await backupDatabase({ sourcePath: backupPath, destinationPath: temporary });
    await readDatabaseCompatibility(temporary);
    await rename(temporary, destinationPath);
    replacedDestination = true;
    const restored = await readDatabaseCompatibility(destinationPath);
    return Object.freeze({ restored, emergency });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (replacedDestination) {
      try {
        if (current.exists && emergencyBackupPath) {
          const recoveryTemporary = `${destinationPath}.recover-${process.pid}-${Date.now()}`;
          await backupDatabase({ sourcePath: emergencyBackupPath, destinationPath: recoveryTemporary });
          await rename(recoveryTemporary, destinationPath);
          await readDatabaseCompatibility(destinationPath);
        } else {
          await rm(destinationPath, { force: true });
        }
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "SQLite restore failed and emergency recovery also failed",
        );
      }
    }
    throw error;
  }
}

export async function prepareDatabaseForUpdate({
  layout,
  manifest,
  fromVersion,
  toVersion,
  now = new Date(),
}) {
  const database = await readDatabaseCompatibility(layout.databasePath);
  const currentBuild = await readInstalledBuildManifest(layout.currentAppRoot);
  const targetStorage = manifest.storage;
  if (database.exists) {
    if (
      database.schemaVersion < targetStorage.minMigratableSchemaVersion
      || database.schemaVersion > targetStorage.maxReadableSchemaVersion
    ) {
      throw new DatabaseCompatibilityError(
        `SQLite schema ${database.schemaVersion} 不在 target migratable/readable range`,
      );
    }
  }
  const crossesBoundary = database.exists && (
    currentBuild.storage.compatibilityEpoch !== targetStorage.compatibilityEpoch
    || currentBuild.storage.schemaVersion !== targetStorage.schemaVersion
  );
  let backup = null;
  if (crossesBoundary) {
    await mkdir(layout.backupsRoot, { recursive: true });
    const stamp = normalizeUtcStamp(now);
    const backupPath = assertContainedPath(
      layout.installRoot,
      join(layout.backupsRoot, `pre-v${toVersion}-from-v${fromVersion}-${stamp}.sqlite`),
      "pre-update database backup",
    );
    await backupDatabase({ sourcePath: layout.databasePath, destinationPath: backupPath });
    backup = relative(layout.installRoot, backupPath).replaceAll("\\", "/");
  }
  return Object.freeze({
    schemaBefore: database.schemaVersion,
    backup,
    compatibilityEpochBefore: currentBuild.storage.compatibilityEpoch,
    compatibilityEpochAfter: targetStorage.compatibilityEpoch,
  });
}

export async function readInstalledBuildManifest(appRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(appRoot, "build-manifest.json"), "utf8"));
  } catch (error) {
    throw new DatabaseCompatibilityError(
      `installed build-manifest 不可读：${error?.code ?? "invalid-json"}`,
      "installed_manifest_invalid",
    );
  }
  const storage = manifest?.storage;
  if (
    manifest?.name !== "codex-usage-monitor"
    || typeof manifest?.version !== "string"
    || !Number.isInteger(storage?.schemaVersion)
    || !Number.isInteger(storage?.compatibilityEpoch)
    || !Number.isInteger(storage?.minMigratableSchemaVersion)
    || !Number.isInteger(storage?.maxReadableSchemaVersion)
  ) {
    throw new DatabaseCompatibilityError("installed build-manifest storage metadata 无效", "installed_manifest_invalid");
  }
  return manifest;
}

export function assertRollbackCodeCompatibility({ targetBuildManifest, currentBuildManifest, database }) {
  const target = targetBuildManifest.storage;
  const current = currentBuildManifest.storage;
  if (!database.exists) return true;
  if (target.compatibilityEpoch !== current.compatibilityEpoch) {
    throw new DatabaseCompatibilityError("rollback compatibility epoch 不一致");
  }
  if (database.schemaVersion > target.maxReadableSchemaVersion) {
    throw new DatabaseCompatibilityError(
      `target v${targetBuildManifest.version} 不能读取 SQLite schema ${database.schemaVersion}`,
    );
  }
  return true;
}

export function resolveBackupLocator(layout, locator) {
  if (typeof locator !== "string" || !locator) {
    throw new DatabaseCompatibilityError("rollback history 缺少 backup locator", "rollback_backup_missing");
  }
  const candidate = resolve(layout.installRoot, locator);
  if (!isPathInside(layout.backupsRoot, candidate, { allowRoot: false })) {
    throw new DatabaseCompatibilityError("rollback backup locator 越界", "rollback_backup_invalid");
  }
  return candidate;
}

export function createEmergencyBackupPath(layout, version, now = new Date()) {
  const filename = `emergency-v${version}-${normalizeUtcStamp(now)}.sqlite`;
  return assertContainedPath(layout.installRoot, join(layout.backupsRoot, filename), "emergency backup");
}

function normalizeUtcStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid backup timestamp");
  return date.toISOString().replace(/[:.]/gu, "-");
}
