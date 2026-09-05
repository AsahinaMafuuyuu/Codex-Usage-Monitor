import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildRelease } from "../scripts/build-release.js";
import { verifyRelease } from "../scripts/verify-release.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const COMMIT = "b".repeat(40);
const PUBLISHED_AT = "2026-09-04T23:00:00.000Z";

test("release build is deterministic and clean artifact verifies without npm install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRuntimeDependencies = async ({ stagingRoot }) => {
    const target = join(stagingRoot, "node_modules", "lucide", "dist", "umd");
    await mkdir(target, { recursive: true });
    await cp(
      join(PROJECT_ROOT, "node_modules", "lucide", "dist", "umd", "lucide.min.js"),
      join(target, "lucide.min.js"),
    );
  };
  const first = await buildRelease({
    tag: "v1.2.0",
    commit: COMMIT,
    outputDir: join(root, "one"),
    publishedAt: PUBLISHED_AT,
    installRuntimeDependencies,
  });
  const second = await buildRelease({
    tag: "v1.2.0",
    commit: COMMIT,
    outputDir: join(root, "two"),
    publishedAt: PUBLISHED_AT,
    installRuntimeDependencies,
  });
  assert.equal(first.releaseManifest.artifact.sha256, second.releaseManifest.artifact.sha256);
  assert.equal(first.releaseManifest.artifact.size, second.releaseManifest.artifact.size);
  assert.deepEqual(
    JSON.parse(await readFile(first.manifestPath, "utf8")),
    JSON.parse(await readFile(second.manifestPath, "utf8")),
  );

  const verified = await verifyRelease({
    manifestPath: first.manifestPath,
    artifactPath: first.artifactPath,
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.version, "1.2.0");
  assert.deepEqual(verified.forbiddenPaths, []);
});

test("release build rejects tag/package identity mismatch before producing an artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-release-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    buildRelease({
      tag: "v1.2.1",
      commit: COMMIT,
      outputDir: root,
      installRuntimeDependencies: async () => {},
    }),
    /does not match package version/u,
  );
});
