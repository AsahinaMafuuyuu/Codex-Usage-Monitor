import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_PATH = resolve(moduleDirectory, "..", "package.json");
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function getAppIdentity({ packagePath = DEFAULT_PACKAGE_PATH } = {}) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取应用 package metadata：${packagePath}`, { cause: error });
  }
  if (metadata?.name !== "codex-usage-monitor") {
    throw new Error("package metadata 的 name 不是 codex-usage-monitor");
  }
  if (!STABLE_VERSION_PATTERN.test(String(metadata?.version ?? ""))) {
    throw new Error("package metadata 缺少合法 stable SemVer version");
  }
  if (typeof metadata?.engines?.node !== "string" || !metadata.engines.node.trim()) {
    throw new Error("package metadata 缺少 Node.js runtime range");
  }
  return Object.freeze({
    name: metadata.name,
    displayName: "Codex Usage Monitor",
    version: metadata.version,
    nodeRange: metadata.engines.node.trim(),
  });
}

export function getAppVersion(options) {
  return getAppIdentity(options).version;
}
