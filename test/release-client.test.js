import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareStableVersions,
  LATEST_MANIFEST_URL,
  parseStableVersion,
  ReleaseClient,
  ReleaseClientError,
  validateReleaseManifest,
} from "../src/release-client.js";

test("stable SemVer comparison is numeric rather than lexical", () => {
  assert.equal(compareStableVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareStableVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareStableVersions("1.2.0", "1.2.0"), 0);
  assert.equal(parseStableVersion("1.2.3").minor, 2);
  assert.throws(() => parseStableVersion("v1.2.3"), /stable SemVer/u);
  assert.throws(() => parseStableVersion("1.2.3-beta.1"), /stable SemVer/u);
});

test("manifest validator freezes package, platform, artifact, and storage identity", () => {
  const manifest = validateReleaseManifest(validManifest());
  assert.equal(manifest.version, "1.2.1");
  assert.equal(manifest.runtime.platform, "win32");
  assert.equal(manifest.storage.compatibilityEpoch, 1);
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.name = "other"; },
    (value) => { value.version = "1.2.1-beta.1"; },
    (value) => { value.tag = "v1.2.0"; },
    (value) => { value.channel = "beta"; },
    (value) => { value.commit = "z".repeat(40); },
    (value) => { value.runtime.platform = "linux"; },
    (value) => { value.artifact.name = "../escape.zip"; },
    (value) => { value.artifact.sha256 = "0".repeat(63); },
    (value) => { value.artifact.size = 0; },
    (value) => { value.storage.compatibilityEpoch = 0; },
    (value) => { value.storage.minMigratableSchemaVersion = 16; },
    (value) => { value.storage.maxReadableSchemaVersion = 14; },
  ]) {
    const value = validManifest();
    mutate(value);
    assert.throws(() => validateReleaseManifest(value), ReleaseClientError);
  }
});

test("release client follows only the frozen GitHub redirect hosts and sends no Codex credentials", async () => {
  const requests = [];
  const client = new ReleaseClient({
    userAgent: "codex-usage-monitor/1.2.0",
    requestImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        assert.equal(url, LATEST_MANIFEST_URL);
        return redirect("https://release-assets.githubusercontent.com/release-manifest.json");
      }
      return textResponse(JSON.stringify(validManifest()));
    },
  });
  const manifest = await client.fetchLatestManifest();
  assert.equal(manifest.version, "1.2.1");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.redirect, "manual");
    assert.equal(request.options.headers["User-Agent"], "codex-usage-monitor/1.2.0");
    assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(request.options.headers, "ChatGPT-Account-Id"), false);
  }
});

test("redirect downgrade, foreign host, embedded credential, loops, and excess hops fail closed", async () => {
  for (const location of [
    "http://github.com/unsafe",
    "https://example.test/unsafe",
    "https://user:pass@github.com/unsafe",
  ]) {
    const client = new ReleaseClient({ requestImpl: async () => redirect(location) });
    await assert.rejects(client.fetchLatestManifest(), ReleaseClientError);
  }

  const loopClient = new ReleaseClient({
    requestImpl: async () => redirect(LATEST_MANIFEST_URL),
  });
  await assert.rejects(
    loopClient.fetchLatestManifest(),
    (error) => error?.code === "redirect_loop",
  );

  let counter = 0;
  const longClient = new ReleaseClient({
    requestImpl: async () => {
      counter += 1;
      return redirect(`https://github.com/hop-${counter}`);
    },
  });
  await assert.rejects(
    longClient.fetchLatestManifest(),
    (error) => error?.code === "redirect_limit_exceeded",
  );
});

test("artifact download uses the exact validated tag/name and exact manifest size", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-release-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("artifact-test");
  const manifest = validManifest({ artifactSize: bytes.length });
  const requests = [];
  const client = new ReleaseClient({
    requestImpl: async (url) => {
      requests.push(url);
      return binaryResponse(bytes);
    },
  });
  const destination = join(directory, "release.zip");
  await client.downloadArtifact(manifest, destination);
  assert.match(requests[0], /\/releases\/download\/v1\.2\.1\/codex-usage-monitor-v1\.2\.1-win\.zip$/u);
  assert.deepEqual(await readFile(destination), bytes);
});

function validManifest({ artifactSize = 123_456 } = {}) {
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
      sha256: "b".repeat(64),
      size: artifactSize,
    },
  };
}

function redirect(location) {
  return {
    ok: false,
    status: 302,
    headers: new Headers({ Location: location }),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function textResponse(text) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text).buffer,
  };
}

function binaryResponse(buffer) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}
