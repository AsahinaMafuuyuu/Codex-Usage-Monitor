import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyReleaseGate } from "../scripts/verify-release-gate.js";

const ROOT = resolve(import.meta.dirname, "..");

test("release identity gate requires package, lock, tag, and release note agreement", async () => {
  const result = await verifyReleaseGate({ tag: "v1.2.0", root: ROOT });
  assert.equal(result.version, "1.2.0");
  await assert.rejects(
    verifyReleaseGate({ tag: "v1.2.1", root: ROOT }),
    /does not match package/u,
  );
});

test("GitHub release workflow gates a Draft release and never bumps, tags, pushes, or publishes", async () => {
  const workflow = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /tags:\s*\r?\n\s*- 'v\*\.\*\.\*'/u);
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /node-version: '24'/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /verify-release-gate\.js/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /git diff --check/u);
  assert.match(workflow, /build-release\.js/u);
  assert.match(workflow, /verify-release\.js/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--draft/u);
  assert.match(workflow, /needs: verify/u);
  assert.match(workflow, /contents: write/u);
  assert.doesNotMatch(workflow, /npm version|git\s+tag|git\s+push|gh\s+release\s+edit[^\n]*--draft=false/iu);
});
