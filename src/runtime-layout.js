import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = resolve(moduleDirectory, "..");
export const MANAGED_INSTALL_NAME = "CodexUsageMonitor";
const PACKAGE_NAME = "codex-usage-monitor";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function resolveRuntimeLayout({
  entryPath = process.argv[1] ?? join(DEFAULT_PROJECT_ROOT, "bin", "codex-usage-monitor.js"),
  environment = process.env,
  localAppData = environment.LOCALAPPDATA,
  projectRoot = DEFAULT_PROJECT_ROOT,
} = {}) {
  const resolvedProjectRoot = resolve(projectRoot);
  const development = createDevelopmentLayout(resolvedProjectRoot);
  const installRoot = resolveManagedInstallRoot(environment.CODEX_MONITOR_INSTALL_ROOT, localAppData);
  if (!installRoot) return development;

  const proof = readManagedProof({ installRoot, entryPath });
  if (!proof.valid) {
    return {
      ...development,
      managedCandidateRoot: installRoot,
      managedProof: proof,
    };
  }

  const appRoot = join(installRoot, "app");
  const stateRoot = join(installRoot, "state");
  const dataRoot = join(installRoot, "data");
  const downloadsRoot = join(installRoot, "downloads");
  const backupsRoot = join(installRoot, "backups");
  for (const candidate of [appRoot, stateRoot, dataRoot, downloadsRoot, backupsRoot]) {
    assertContainedPath(installRoot, candidate, "managed runtime path");
  }
  return Object.freeze({
    mode: "managed",
    projectRoot: resolvedProjectRoot,
    installRoot,
    appRoot,
    mutableRoot: installRoot,
    dataRoot,
    stateRoot,
    downloadsRoot,
    backupsRoot,
    databasePath: join(dataRoot, "usage.sqlite"),
    currentVersion: proof.currentVersion,
    currentAppRoot: proof.currentAppRoot,
    marker: proof.marker,
    managedCandidateRoot: installRoot,
    managedProof: proof,
  });
}

export function resolveDatabaseStorage({
  layout = resolveRuntimeLayout(),
  optionValue = null,
  environment = process.env,
} = {}) {
  if (optionValue) {
    return {
      path: isAbsolute(optionValue)
        ? resolve(optionValue)
        : resolve(layout.dataRoot, optionValue),
      source: "option",
      warning: null,
    };
  }

  const configured = environment.CODEX_MONITOR_DB;
  if (!configured) {
    return { path: layout.databasePath, source: `${layout.mode}-default`, warning: null };
  }
  const candidate = isAbsolute(configured)
    ? resolve(configured)
    : resolve(layout.dataRoot, configured);
  if (isPathInside(layout.mutableRoot, candidate, { allowRoot: false })) {
    return { path: candidate, source: "environment", warning: null };
  }
  return {
    path: layout.databasePath,
    source: `${layout.mode}-default`,
    warning: `CODEX_MONITOR_DB 超出当前 runtime 可写根目录，已改用：${layout.databasePath}`,
  };
}

export function isPathInside(root, candidate, { allowRoot = true } = {}) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const relativePath = relative(rootPath, candidatePath);
  if (relativePath === "") return allowRoot;
  if (isAbsolute(relativePath)) return false;
  const first = relativePath.split(/[\\/]/u)[0];
  return first !== "..";
}

export function assertContainedPath(root, candidate, label = "path") {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${label} 超出允许根目录：${candidate}`);
  }
  return resolve(candidate);
}

function createDevelopmentLayout(projectRoot) {
  const dataRoot = join(projectRoot, "data");
  const stateRoot = join(dataRoot, "state");
  return Object.freeze({
    mode: "development",
    projectRoot,
    installRoot: null,
    appRoot: projectRoot,
    mutableRoot: projectRoot,
    dataRoot,
    stateRoot,
    downloadsRoot: join(stateRoot, "downloads"),
    backupsRoot: join(stateRoot, "backups"),
    databasePath: join(dataRoot, "usage.sqlite"),
    currentVersion: null,
    currentAppRoot: projectRoot,
    marker: null,
    managedCandidateRoot: null,
    managedProof: { valid: false, reason: "development" },
  });
}

function resolveManagedInstallRoot(explicitRoot, localAppData) {
  if (typeof explicitRoot === "string" && explicitRoot.trim()) return resolve(explicitRoot.trim());
  if (typeof localAppData === "string" && localAppData.trim()) {
    return resolve(localAppData.trim(), MANAGED_INSTALL_NAME);
  }
  return null;
}

function readManagedProof({ installRoot, entryPath }) {
  const markerPath = join(installRoot, "state", "install.json");
  const currentPath = join(installRoot, "state", "current");
  let marker;
  let currentVersion;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
    currentVersion = readFileSync(currentPath, "utf8").trim();
  } catch (error) {
    return { valid: false, reason: "managed-marker-missing", errorCode: error?.code ?? null };
  }
  if (marker?.name !== PACKAGE_NAME) {
    return { valid: false, reason: "managed-marker-invalid" };
  }
  if (!STABLE_VERSION_PATTERN.test(currentVersion)) {
    return { valid: false, reason: "managed-current-invalid" };
  }
  const currentAppRoot = join(installRoot, "app", `v${currentVersion}`);
  const resolvedEntry = resolve(entryPath);
  if (!existsSync(resolvedEntry)) {
    return { valid: false, reason: "managed-entry-missing", currentVersion, currentAppRoot };
  }
  if (!isPathInside(currentAppRoot, resolvedEntry, { allowRoot: false })) {
    return { valid: false, reason: "managed-entry-mismatch", currentVersion, currentAppRoot };
  }
  return Object.freeze({
    valid: true,
    reason: "managed-proof-valid",
    currentVersion,
    currentAppRoot,
    marker,
  });
}
