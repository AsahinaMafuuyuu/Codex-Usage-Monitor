import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareBuildIdentity } from "./updater.js";
import { STORAGE_COMPATIBILITY } from "./storage-compatibility.js";

export const REQUIRED_RELEASE_FILES = Object.freeze([
  "package.json",
  "build-manifest.json",
  "bin/codex-usage-monitor.js",
  "src/server.js",
  "src/cli.js",
  "src/release-client.js",
  "src/updater.js",
  "public/index.html",
]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export async function runReleaseSelfCheck({ root = resolve(moduleDirectory, "..") } = {}) {
  const releaseRoot = resolve(root);
  for (const relativePath of REQUIRED_RELEASE_FILES) {
    await access(join(releaseRoot, relativePath), fsConstants.R_OK);
  }
  const packageMetadata = JSON.parse(await readFile(join(releaseRoot, "package.json"), "utf8"));
  const buildManifest = JSON.parse(await readFile(join(releaseRoot, "build-manifest.json"), "utf8"));
  if (packageMetadata?.name !== "codex-usage-monitor") throw selfCheckError("package name mismatch");
  if (packageMetadata?.version !== buildManifest?.version) throw selfCheckError("package/build version mismatch");
  if (buildManifest?.name !== packageMetadata.name) throw selfCheckError("build package name mismatch");
  if (buildManifest?.tag !== `v${packageMetadata.version}`) throw selfCheckError("build tag mismatch");
  if (!nodeRangeSatisfied(buildManifest?.runtime?.node, process.versions.node)) {
    throw selfCheckError(`Node ${process.versions.node} does not satisfy ${buildManifest?.runtime?.node ?? "unknown"}`);
  }
  if (buildManifest?.runtime?.platform !== "win32") throw selfCheckError("build platform is not win32");
  if (JSON.stringify(buildManifest?.storage) !== JSON.stringify(STORAGE_COMPATIBILITY)) {
    throw selfCheckError("build storage compatibility metadata does not match runtime code");
  }

  compareBuildIdentity(buildManifest, {
    name: buildManifest.name,
    version: buildManifest.version,
    tag: buildManifest.tag,
    commit: buildManifest.commit,
    runtime: buildManifest.runtime,
    storage: buildManifest.storage,
  });

  for (const relativePath of ["src/server.js", "src/cli.js", "src/release-client.js", "src/updater.js"]) {
    await import(`${pathToFileURL(join(releaseRoot, relativePath)).href}?release-self-check=${Date.now()}`);
  }
  return Object.freeze({
    status: "ok",
    version: packageMetadata.version,
    tag: buildManifest.tag,
    commit: buildManifest.commit,
  });
}

export function nodeRangeSatisfied(range, nodeVersion) {
  const match = String(range ?? "").trim().match(/^>=(\d+)\.(\d+)\.(\d+)$/u);
  const version = String(nodeVersion ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match || !version) return false;
  const required = match.slice(1).map(Number);
  const actual = version.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function selfCheckError(message) {
  const error = new Error(`release self-check failed: ${message}`);
  error.code = "release_self_check_failed";
  return error;
}
