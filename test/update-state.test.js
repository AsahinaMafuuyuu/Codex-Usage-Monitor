import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFreshUpdateNotice, readUpdateState, writeUpdateCheck } from "../src/update-state.js";

test("managed update check cache is atomic, bounded to state root, and readable offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-update-state-"));
  const layout = managedLayout(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkedAt = "2026-09-04T20:00:00.000Z";
  const state = await writeUpdateCheck(layout, {
    currentVersion: "1.2.0",
    manifest: manifest("1.2.1"),
    checkedAt,
  });
  assert.equal(state.status, "update-available");
  assert.equal(state.lastSuccessfulCheckedAt, state.lastCheckedAt);
  assert.equal((await readUpdateState(layout)).latestVersion, "1.2.1");
  const serialized = await readFile(join(layout.stateRoot, "update.json"), "utf8");
  assert.doesNotMatch(serialized, /redirect|Authorization|account|session|project/iu);
  const notice = await readFreshUpdateNotice(layout, "1.2.0", {
    now: Date.parse(checkedAt) + 60_000,
  });
  assert.equal(notice.version, "1.2.1");
});

test("failed checks retain the last successful check timestamp", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-update-state-failed-"));
  const layout = managedLayout(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const latest = manifest("1.2.1");
  await writeUpdateCheck(layout, {
    currentVersion: "1.2.0",
    manifest: latest,
    checkedAt: "2026-09-04T10:00:00.000Z",
  });
  const failed = await writeUpdateCheck(layout, {
    currentVersion: "1.2.0",
    manifest: null,
    checkedAt: "2026-09-04T11:00:00.000Z",
    errorCode: "network_unavailable",
  });
  assert.equal(failed.status, "check-failed");
  assert.equal(failed.lastSuccessfulCheckedAt, "2026-09-04T10:00:00.000Z");
});

test("stale or non-newer cache never produces an offline update notice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-update-state-stale-"));
  const layout = managedLayout(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeUpdateCheck(layout, {
    currentVersion: "1.2.0",
    manifest: manifest("1.2.1"),
    checkedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(await readFreshUpdateNotice(layout, "1.2.0", {
    now: Date.parse("2026-09-20T00:00:00.000Z"),
  }), null);

  await writeUpdateCheck(layout, {
    currentVersion: "1.2.1",
    manifest: manifest("1.2.1"),
    checkedAt: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(await readFreshUpdateNotice(layout, "1.2.1", {
    now: Date.parse("2026-09-20T00:01:00.000Z"),
  }), null);
});

test("development layout refuses managed update-state writes", async () => {
  await assert.rejects(
    writeUpdateCheck({ mode: "development" }, {
      currentVersion: "1.2.0",
      manifest: manifest("1.2.1"),
    }),
    (error) => error?.code === "managed_install_required",
  );
});

function managedLayout(root) {
  return {
    mode: "managed",
    mutableRoot: root,
    stateRoot: join(root, "state"),
  };
}

function manifest(version) {
  return {
    version,
    tag: `v${version}`,
    publishedAt: "2026-09-04T20:00:00.000Z",
  };
}
