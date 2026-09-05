import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isPathInside,
  resolveDatabaseStorage,
  resolveRuntimeLayout,
} from "../src/runtime-layout.js";

test("development layout remains project-local without managed proof", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-layout-dev-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const entryPath = join(projectRoot, "bin", "codex-usage-monitor.js");
  await mkdir(join(projectRoot, "bin"), { recursive: true });
  await writeFile(entryPath, "// dev\n");
  const layout = resolveRuntimeLayout({
    projectRoot,
    entryPath,
    environment: { CODEX_MONITOR_INSTALL_ROOT: join(projectRoot, "fake-managed") },
  });
  assert.equal(layout.mode, "development");
  assert.equal(layout.databasePath, join(projectRoot, "data", "usage.sqlite"));
  assert.equal(layout.stateRoot, join(projectRoot, "data", "state"));
  assert.equal(layout.managedProof.valid, false);
});

test("managed mode requires marker, stable current pointer, and matching version entry path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-layout-managed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managedRoot = join(root, "CodexUsageMonitor");
  const entryPath = join(managedRoot, "app", "v1.2.0", "bin", "codex-usage-monitor.js");
  await mkdir(join(managedRoot, "state"), { recursive: true });
  await mkdir(join(managedRoot, "app", "v1.2.0", "bin"), { recursive: true });
  await writeFile(join(managedRoot, "state", "install.json"), JSON.stringify({ name: "codex-usage-monitor" }));
  await writeFile(join(managedRoot, "state", "current"), "1.2.0\n");
  await writeFile(entryPath, "// managed\n");

  const managed = resolveRuntimeLayout({
    projectRoot: root,
    entryPath,
    environment: { CODEX_MONITOR_INSTALL_ROOT: managedRoot },
  });
  assert.equal(managed.mode, "managed");
  assert.equal(managed.currentVersion, "1.2.0");
  assert.equal(managed.databasePath, join(managedRoot, "data", "usage.sqlite"));
  assert.equal(managed.mutableRoot, managedRoot);

  const wrongEntry = join(managedRoot, "app", "v1.2.1", "bin", "codex-usage-monitor.js");
  await mkdir(join(managedRoot, "app", "v1.2.1", "bin"), { recursive: true });
  await writeFile(wrongEntry, "// wrong\n");
  const mismatch = resolveRuntimeLayout({
    projectRoot: root,
    entryPath: wrongEntry,
    environment: { CODEX_MONITOR_INSTALL_ROOT: managedRoot },
  });
  assert.equal(mismatch.mode, "development");
  assert.equal(mismatch.managedProof.reason, "managed-entry-mismatch");
});

test("CODEX_MONITOR_DB is contained by the runtime mutable root", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-layout-db-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-layout-db-outside-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const layout = resolveRuntimeLayout({ projectRoot, environment: {}, entryPath: import.meta.filename });
  const relative = resolveDatabaseStorage({
    layout,
    environment: { CODEX_MONITOR_DB: "nested\\usage.sqlite" },
  });
  assert.equal(relative.path, resolve(layout.dataRoot, "nested\\usage.sqlite"));
  assert.equal(relative.source, "environment");

  const escaped = resolveDatabaseStorage({
    layout,
    environment: { CODEX_MONITOR_DB: join(outside, "usage.sqlite") },
  });
  assert.equal(escaped.path, layout.databasePath);
  assert.match(escaped.warning, /超出当前 runtime 可写根目录/u);
  assert.equal(isPathInside(projectRoot, join(projectRoot, "data", "usage.sqlite")), true);
  assert.equal(isPathInside(projectRoot, join(projectRoot, "..", "escape.sqlite")), false);
});

test("explicit databasePath remains an injectable test/runtime seam while env override is contained", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-layout-option-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-layout-option-outside-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const layout = resolveRuntimeLayout({ projectRoot, environment: {}, entryPath: import.meta.filename });
  const explicit = resolveDatabaseStorage({
    layout,
    optionValue: join(outside, "fixture.sqlite"),
    environment: {},
  });
  assert.equal(explicit.path, join(outside, "fixture.sqlite"));
  assert.equal(explicit.source, "option");
});
