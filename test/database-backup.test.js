import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRollbackCodeCompatibility,
  backupDatabase,
  DatabaseCompatibilityError,
  migrateDatabase,
  prepareDatabaseForUpdate,
  readDatabaseCompatibility,
  restoreDatabase,
} from "../src/database-backup.js";

test("read-only database compatibility reports user_version and quick_check without migration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-db-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "usage.sqlite");
  createFixtureDatabase(path, 14, 3);
  const result = await readDatabaseCompatibility(path);
  assert.deepEqual(result, { exists: true, schemaVersion: 14, quickCheck: "ok" });
  const after = new DatabaseSync(path, { readOnly: true });
  assert.equal(after.prepare("PRAGMA user_version").get().user_version, 14);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 3);
  after.close();
});

test("node:sqlite backup produces a consistent standalone snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-db-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.sqlite");
  const destination = join(root, "backups", "backup.sqlite");
  createFixtureDatabase(source, 15, 7);
  const result = await backupDatabase({ sourcePath: source, destinationPath: destination });
  assert.equal(result.sourceSchemaVersion, 15);
  assert.equal(result.destinationSchemaVersion, 15);
  const copied = new DatabaseSync(destination, { readOnly: true });
  assert.equal(copied.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 7);
  copied.close();
});

test("managed migration refuses to overwrite an existing destination and leaves source unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-db-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.sqlite");
  const destination = join(root, "destination.sqlite");
  createFixtureDatabase(source, 15, 2);
  const migrated = await migrateDatabase({ sourcePath: source, destinationPath: destination });
  assert.equal(migrated.destinationSchemaVersion, 15);
  await assert.rejects(
    migrateDatabase({ sourcePath: source, destinationPath: destination }),
    (error) => error?.code === "migration_destination_exists",
  );
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  assert.equal(sourceDb.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 2);
  sourceDb.close();
});

test("update storage preflight backs up only across a schema/epoch boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-db-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = await createLayout(root, { currentSchema: 15, currentEpoch: 1 });
  createFixtureDatabase(layout.databasePath, 15, 5);
  const noBoundary = await prepareDatabaseForUpdate({
    layout,
    manifest: { storage: storage(15, 1) },
    fromVersion: "1.2.0",
    toVersion: "1.2.1",
    now: new Date("2026-09-04T21:00:00.000Z"),
  });
  assert.equal(noBoundary.backup, null);

  const boundary = await prepareDatabaseForUpdate({
    layout,
    manifest: { storage: storage(16, 2, { maxReadable: 15 }) },
    fromVersion: "1.2.0",
    toVersion: "1.3.0",
    now: new Date("2026-09-04T21:00:00.000Z"),
  });
  assert.match(boundary.backup, /^backups\/pre-v1\.3\.0-from-v1\.2\.0-/u);
  await access(join(root, ...boundary.backup.split("/")));
});

test("rollback code gate blocks epoch mismatch and unreadable schema", () => {
  const target = { version: "1.2.0", storage: storage(15, 1) };
  const current = { version: "1.3.0", storage: storage(16, 2, { maxReadable: 16 }) };
  assert.throws(
    () => assertRollbackCodeCompatibility({
      targetBuildManifest: target,
      currentBuildManifest: current,
      database: { exists: true, schemaVersion: 16 },
    }),
    DatabaseCompatibilityError,
  );
  const sameEpoch = { version: "1.3.0", storage: storage(16, 1, { maxReadable: 16 }) };
  assert.throws(
    () => assertRollbackCodeCompatibility({
      targetBuildManifest: target,
      currentBuildManifest: sameEpoch,
      database: { exists: true, schemaVersion: 16 },
    }),
    /不能读取 SQLite schema/u,
  );
});

test("restore creates emergency backup then atomically installs the selected snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-db-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "usage.sqlite");
  const selected = join(root, "selected.sqlite");
  const emergency = join(root, "emergency.sqlite");
  createFixtureDatabase(current, 16, 9);
  createFixtureDatabase(selected, 15, 4);
  const result = await restoreDatabase({
    backupPath: selected,
    destinationPath: current,
    emergencyBackupPath: emergency,
  });
  assert.equal(result.restored.schemaVersion, 15);
  const restored = new DatabaseSync(current, { readOnly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 4);
  restored.close();
  const emergencyDb = new DatabaseSync(emergency, { readOnly: true });
  assert.equal(emergencyDb.prepare("PRAGMA user_version").get().user_version, 16);
  assert.equal(emergencyDb.prepare("SELECT COUNT(*) AS count FROM sample").get().count, 9);
  emergencyDb.close();
});

function createFixtureDatabase(path, schemaVersion, rows) {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT);");
  const insert = database.prepare("INSERT INTO sample(value) VALUES (?)");
  for (let index = 0; index < rows; index += 1) insert.run(`row-${index}`);
  database.exec(`PRAGMA user_version=${schemaVersion};`);
  database.close();
}

async function createLayout(root, { currentSchema, currentEpoch }) {
  const layout = {
    mode: "managed",
    installRoot: root,
    mutableRoot: root,
    appRoot: join(root, "app"),
    currentAppRoot: join(root, "app", "v1.2.0"),
    stateRoot: join(root, "state"),
    dataRoot: join(root, "data"),
    backupsRoot: join(root, "backups"),
    databasePath: join(root, "data", "usage.sqlite"),
  };
  await mkdir(layout.currentAppRoot, { recursive: true });
  await mkdir(layout.dataRoot, { recursive: true });
  await writeFile(join(layout.currentAppRoot, "build-manifest.json"), JSON.stringify({
    name: "codex-usage-monitor",
    version: "1.2.0",
    storage: storage(currentSchema, currentEpoch),
  }));
  return layout;
}

function storage(schemaVersion, compatibilityEpoch, { maxReadable = schemaVersion } = {}) {
  return {
    schemaVersion,
    compatibilityEpoch,
    minMigratableSchemaVersion: 1,
    maxReadableSchemaVersion: maxReadable,
  };
}
