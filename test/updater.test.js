import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireUpdateLock, ManagedUpdater, UpdaterError } from "../src/updater.js";

test("development mode rejects update before release/network work", async () => {
  let fetched = false;
  const updater = new ManagedUpdater({
    layout: { mode: "development" },
    currentVersion: "1.2.0",
    releaseClient: { fetchLatestManifest: async () => { fetched = true; } },
  });
  await assert.rejects(
    updater.update(),
    (error) => error?.code === "managed_install_required",
  );
  assert.equal(fetched, false);
});

test("update lock is exclusive and does not delete a competing lock", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const first = await acquireUpdateLock(fixture.layout);
  t.after(() => first.release());
  await assert.rejects(
    acquireUpdateLock(fixture.layout),
    (error) => error?.code === "update_lock_conflict",
  );
  await first.release();
  const second = await acquireUpdateLock(fixture.layout);
  await second.release();
});

test("SHA-256 failure leaves current pointer and old version untouched", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("release-bytes");
  const manifest = releaseManifest({
    size: bytes.length,
    sha256: "0".repeat(64),
  });
  const updater = makeUpdater(fixture.layout, manifest, bytes);
  await assert.rejects(
    updater.update(),
    (error) => error?.code === "integrity_failed",
  );
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
  assert.equal(await readFile(join(fixture.layout.appRoot, "v1.2.0", "keep.txt"), "utf8"), "old");
});

test("target self-check failure leaves pointer unchanged and removes staging", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("release-self-check");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    selfCheckImpl: async () => {
      const error = new Error("broken target");
      error.code = "release_self_check_failed";
      throw error;
    },
  });
  await assert.rejects(updater.update(), /broken target/u);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
  const appEntries = await import("node:fs/promises").then(({ readdir }) => readdir(fixture.layout.appRoot));
  assert.deepEqual(appEntries.sort(), ["v1.2.0"]);
});

test("successful update commits immutable version, current pointer, bounded history, and retains previous version", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("release-success");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  let preflightCalls = 0;
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    storagePreflight: async () => {
      preflightCalls += 1;
      return { schemaBefore: 15, backup: null };
    },
  });
  const result = await updater.update();
  assert.equal(result.status, "updated");
  assert.equal(result.reused, false);
  assert.equal(preflightCalls, 1);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.1");
  assert.equal(await readFile(join(fixture.layout.appRoot, "v1.2.0", "keep.txt"), "utf8"), "old");
  assert.equal(JSON.parse(await readFile(join(fixture.layout.appRoot, "v1.2.1", "package.json"), "utf8")).version, "1.2.1");
  const history = JSON.parse(await readFile(join(fixture.layout.stateRoot, "history.json"), "utf8"));
  assert.equal(history.transitions.at(-1).from, "1.2.0");
  assert.equal(history.transitions.at(-1).to, "1.2.1");
  assert.equal(history.transitions.at(-1).schemaBefore, 15);
});

test("existing target version is reused only when embedded identity matches", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("unused-download");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  await createReleaseTree(join(fixture.layout.appRoot, "v1.2.1"), manifest);
  let downloads = 0;
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    releaseClient: {
      fetchLatestManifest: async () => manifest,
      downloadArtifact: async () => { downloads += 1; },
    },
  });
  const result = await updater.update();
  assert.equal(result.reused, true);
  assert.equal(downloads, 0);

  await writeFile(join(fixture.layout.stateRoot, "current"), "1.2.0\n");
  const buildPath = join(fixture.layout.appRoot, "v1.2.1", "build-manifest.json");
  const build = JSON.parse(await readFile(buildPath, "utf8"));
  build.commit = "c".repeat(40);
  await writeFile(buildPath, JSON.stringify(build));
  await assert.rejects(
    updater.update(),
    (error) => error instanceof UpdaterError && error.code === "integrity_failed",
  );
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
});

test("history failure after pointer write restores the original current pointer", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("release-history-failure");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    appendTransitionImpl: async () => {
      throw new Error("injected history write failure");
    },
  });
  await assert.rejects(updater.update(), /injected history write failure/u);
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.0");
});

test("update cache failure after committed pointer/history is warning-only", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("release-cache-warning");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    writeUpdateCheckImpl: async () => {
      const error = new Error("cache write failed");
      error.code = "cache_injected_failure";
      throw error;
    },
  });
  const result = await updater.update();
  assert.equal(result.status, "updated");
  assert.equal(result.updateStateWarning, "cache_injected_failure");
  assert.equal((await readFile(join(fixture.layout.stateRoot, "current"), "utf8")).trim(), "1.2.1");
});

test("managed background check is skipped for 24h after a successful check and failures are contained", async (t) => {
  const fixture = await createManagedFixture();
  t.after(fixture.cleanup);
  const bytes = Buffer.from("background-check");
  const manifest = releaseManifest({ size: bytes.length, sha256: sha256(bytes) });
  let fetches = 0;
  const updater = makeUpdater(fixture.layout, manifest, bytes, {
    releaseClient: {
      fetchLatestManifest: async () => {
        fetches += 1;
        return manifest;
      },
      downloadArtifact: async () => {},
    },
  });
  await updater.writeUpdateCheckImpl(fixture.layout, {
    currentVersion: "1.2.0",
    manifest,
    checkedAt: "2026-09-04T20:00:00.000Z",
  });
  updater.now = () => new Date("2026-09-05T19:59:59.000Z");
  assert.equal((await updater.checkIfDue()).status, "not-due");
  assert.equal(fetches, 0);
  updater.now = () => new Date("2026-09-05T20:00:01.000Z");
  assert.equal((await updater.checkIfDue()).status, "update-available");
  assert.equal(fetches, 1);

  const failing = makeUpdater(fixture.layout, manifest, bytes, {
    releaseClient: {
      fetchLatestManifest: async () => {
        const error = new Error("offline");
        error.code = "network_unavailable";
        throw error;
      },
      downloadArtifact: async () => {},
    },
  });
  failing.now = () => new Date("2026-09-07T20:00:01.000Z");
  assert.equal((await failing.checkIfDue()).status, "check-failed");
});

async function createManagedFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-updater-"));
  const layout = {
    mode: "managed",
    installRoot: root,
    mutableRoot: root,
    appRoot: join(root, "app"),
    stateRoot: join(root, "state"),
    downloadsRoot: join(root, "downloads"),
    backupsRoot: join(root, "backups"),
    dataRoot: join(root, "data"),
    databasePath: join(root, "data", "usage.sqlite"),
    currentVersion: "1.2.0",
  };
  await mkdir(join(layout.appRoot, "v1.2.0"), { recursive: true });
  await mkdir(layout.stateRoot, { recursive: true });
  await writeFile(join(layout.appRoot, "v1.2.0", "keep.txt"), "old");
  await writeFile(join(layout.stateRoot, "current"), "1.2.0\n");
  return { layout, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function makeUpdater(layout, manifest, bytes, overrides = {}) {
  return new ManagedUpdater({
    layout,
    currentVersion: "1.2.0",
    releaseClient: overrides.releaseClient ?? {
      fetchLatestManifest: async () => manifest,
      downloadArtifact: async (_manifest, destination) => writeFile(destination, bytes),
    },
    extractArchiveImpl: async (_archive, destination) => createReleaseTree(destination, manifest),
    archivePreflightImpl: overrides.archivePreflightImpl ?? (async () => {}),
    selfCheckImpl: overrides.selfCheckImpl ?? (async () => {}),
    storagePreflight: overrides.storagePreflight ?? (async () => ({ schemaBefore: 15, backup: null })),
    appendTransitionImpl: overrides.appendTransitionImpl,
    writeUpdateCheckImpl: overrides.writeUpdateCheckImpl,
    randomBytesImpl: () => Buffer.alloc(8, 7),
    now: () => new Date("2026-09-04T20:30:00.000Z"),
  });
}

async function createReleaseTree(root, manifest) {
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "codex-usage-monitor",
    version: manifest.version,
    engines: { node: manifest.runtime.node },
  }));
  await writeFile(join(root, "build-manifest.json"), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    tag: manifest.tag,
    commit: manifest.commit,
    runtime: manifest.runtime,
    storage: manifest.storage,
  }));
  await writeFile(join(root, "bin", "codex-usage-monitor.js"), "// bin\n");
  await writeFile(join(root, "src", "server.js"), "export const ok = true;\n");
  await writeFile(join(root, "public", "index.html"), "<!doctype html>\n");
}

function releaseManifest({ size, sha256: digest }) {
  return {
    schemaVersion: 1,
    name: "codex-usage-monitor",
    version: "1.2.1",
    tag: "v1.2.1",
    channel: "stable",
    commit: "a".repeat(40),
    publishedAt: "2026-09-04T20:00:00.000Z",
    runtime: { node: ">=24.0.0", platform: "win32" },
    storage: {
      schemaVersion: 15,
      compatibilityEpoch: 1,
      minMigratableSchemaVersion: 1,
      maxReadableSchemaVersion: 15,
    },
    artifact: {
      name: "codex-usage-monitor-v1.2.1-win.zip",
      sha256: digest,
      size,
    },
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
