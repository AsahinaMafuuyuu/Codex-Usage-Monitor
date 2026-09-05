import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedUpdater } from "../src/updater.js";

test("code-only rollback requires same epoch/readable schema and switches only the pointer", async (t) => {
  const fixture = await rollbackFixture({
    currentVersion: "1.2.1",
    currentStorage: storage(15, 1),
    targetVersion: "1.2.0",
    targetStorage: storage(15, 1),
    databaseSchema: 15,
    backupSchema: null,
  });
  t.after(fixture.cleanup);
  const updater = new ManagedUpdater({
    layout: fixture.layout,
    currentVersion: "1.2.1",
    releaseClient: {},
    selfCheckImpl: async () => {},
    port: 49_880,
    now: () => new Date("2026-09-04T22:00:00.000Z"),
  });
  const result = await updater.rollback();
  assert.equal(result.status, "rolled-back");
  assert.equal(result.dataRestored, false);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
  const database = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 15);
  database.close();
});

test("incompatible rollback is blocked unless restore-data uses the recorded pre-update backup", async (t) => {
  const fixture = await rollbackFixture({
    currentVersion: "1.3.0",
    currentStorage: storage(16, 2),
    targetVersion: "1.2.0",
    targetStorage: storage(15, 1),
    databaseSchema: 16,
    backupSchema: 15,
  });
  t.after(fixture.cleanup);
  const updater = new ManagedUpdater({
    layout: fixture.layout,
    currentVersion: "1.3.0",
    releaseClient: {},
    selfCheckImpl: async () => {},
    port: 49_881,
    now: () => new Date("2026-09-04T22:10:00.000Z"),
  });
  await assert.rejects(
    updater.rollback(),
    (error) => error?.code === "storage_incompatible",
  );
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.3.0");

  const result = await updater.rollback({ restoreData: true });
  assert.equal(result.dataRestored, true);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
  const restored = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
  assert.equal(restored.prepare("PRAGMA user_version").get().user_version, 15);
  restored.close();
  const backups = await readdir(fixture.layout.backupsRoot);
  assert.equal(backups.some((name) => name.startsWith("emergency-v1.3.0-")), true);
});

test("restore-data rejects an incompatible backup before changing DB or current pointer", async (t) => {
  const fixture = await rollbackFixture({
    currentVersion: "1.3.0",
    currentStorage: storage(16, 2),
    targetVersion: "1.2.0",
    targetStorage: storage(15, 1),
    databaseSchema: 16,
    backupSchema: 16,
  });
  t.after(fixture.cleanup);
  const updater = new ManagedUpdater({
    layout: fixture.layout,
    currentVersion: "1.3.0",
    releaseClient: {},
    selfCheckImpl: async () => {},
    port: 49_882,
  });

  await assert.rejects(
    updater.rollback({ restoreData: true }),
    (error) => error?.code === "storage_incompatible",
  );
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.3.0");
  const database = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 16);
  database.close();
});

test("rollback history failure restores the original current pointer", async (t) => {
  const fixture = await rollbackFixture({
    currentVersion: "1.2.1",
    currentStorage: storage(15, 1),
    targetVersion: "1.2.0",
    targetStorage: storage(15, 1),
    databaseSchema: 15,
    backupSchema: null,
  });
  t.after(fixture.cleanup);
  const updater = new ManagedUpdater({
    layout: fixture.layout,
    currentVersion: "1.2.1",
    releaseClient: {},
    selfCheckImpl: async () => {},
    appendTransitionImpl: async () => {
      const error = new Error("injected history failure");
      error.code = "history_injected_failure";
      throw error;
    },
    port: 49_883,
  });

  await assert.rejects(updater.rollback(), /injected history failure/u);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.1");
});

test("restore-data commit failure restores both the original DB and current pointer", async (t) => {
  const fixture = await rollbackFixture({
    currentVersion: "1.3.0",
    currentStorage: storage(16, 2),
    targetVersion: "1.2.0",
    targetStorage: storage(15, 1),
    databaseSchema: 16,
    backupSchema: 15,
  });
  t.after(fixture.cleanup);
  const updater = new ManagedUpdater({
    layout: fixture.layout,
    currentVersion: "1.3.0",
    releaseClient: {},
    selfCheckImpl: async () => {},
    appendTransitionImpl: async () => { throw new Error("injected rollback history failure"); },
    port: 49_884,
    now: () => new Date("2026-09-04T22:20:00.000Z"),
  });

  await assert.rejects(
    updater.rollback({ restoreData: true }),
    /injected rollback history failure/u,
  );
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.3.0");
  const database = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 16);
  database.close();
});

async function rollbackFixture({
  currentVersion,
  currentStorage,
  targetVersion,
  targetStorage,
  databaseSchema,
  backupSchema,
}) {
  const root = await mkdtemp(join(tmpdir(), "codex-rollback-"));
  const layout = {
    mode: "managed",
    installRoot: root,
    mutableRoot: root,
    appRoot: join(root, "app"),
    stateRoot: join(root, "state"),
    dataRoot: join(root, "data"),
    backupsRoot: join(root, "backups"),
    downloadsRoot: join(root, "downloads"),
    databasePath: join(root, "data", "usage.sqlite"),
    currentVersion,
    currentAppRoot: join(root, "app", `v${currentVersion}`),
  };
  await mkdir(layout.currentAppRoot, { recursive: true });
  await mkdir(join(layout.appRoot, `v${targetVersion}`), { recursive: true });
  await mkdir(layout.stateRoot, { recursive: true });
  await mkdir(layout.dataRoot, { recursive: true });
  await mkdir(layout.backupsRoot, { recursive: true });
  await writeBuild(join(layout.appRoot, `v${currentVersion}`), currentVersion, currentStorage);
  await writeBuild(join(layout.appRoot, `v${targetVersion}`), targetVersion, targetStorage);
  await writeFile(join(layout.stateRoot, "current"), `${currentVersion}\n`);
  createDatabase(layout.databasePath, databaseSchema);
  let backup = null;
  if (backupSchema != null) {
    const backupPath = join(layout.backupsRoot, "pre-update.sqlite");
    createDatabase(backupPath, backupSchema);
    backup = "backups/pre-update.sqlite";
  }
  await writeFile(join(layout.stateRoot, "history.json"), JSON.stringify({
    schemaVersion: 1,
    transitions: [{
      from: targetVersion,
      to: currentVersion,
      switchedAt: "2026-09-04T21:00:00.000Z",
      schemaBefore: targetStorage.schemaVersion,
      schemaAfterExpected: currentStorage.schemaVersion,
      compatibilityEpoch: currentStorage.compatibilityEpoch,
      backup,
    }],
  }));
  return { layout, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeBuild(root, version, storageMetadata) {
  await writeFile(join(root, "build-manifest.json"), JSON.stringify({
    name: "codex-usage-monitor",
    version,
    tag: `v${version}`,
    commit: "a".repeat(40),
    runtime: { node: ">=24.0.0", platform: "win32" },
    storage: storageMetadata,
  }));
}

function createDatabase(path, schemaVersion) {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample DEFAULT VALUES;");
  database.exec(`PRAGMA user_version=${schemaVersion};`);
  database.close();
}

function storage(schemaVersion, compatibilityEpoch) {
  return {
    schemaVersion,
    compatibilityEpoch,
    minMigratableSchemaVersion: 1,
    maxReadableSchemaVersion: schemaVersion,
  };
}
