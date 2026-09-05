import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDatabaseCompatibility } from "./database-backup.js";
import { readUpdateState } from "./update-state.js";

export async function runDoctor({ layout, appVersion, environment = process.env } = {}) {
  const codexHome = environment.CODEX_HOME || join(homedir(), ".codex");
  const codexReachable = await isReadable(codexHome);
  let database;
  try {
    database = await readDatabaseCompatibility(layout.databasePath);
  } catch (error) {
    database = {
      exists: true,
      schemaVersion: null,
      quickCheck: "failed",
      errorCode: error?.code ?? "database_check_failed",
    };
  }
  const updateState = await readUpdateState(layout);
  const releaseManifest = layout.mode === "managed"
    ? await readJsonOrNull(join(layout.currentAppRoot, "build-manifest.json"))
    : null;
  const residues = layout.mode === "managed"
    ? await findUpdateResidues(layout)
    : { staging: [], updateLock: false };
  return Object.freeze({
    status: database.quickCheck === "failed" ? "degraded" : "ok",
    appVersion,
    mode: layout.mode,
    nodeVersion: process.versions.node,
    installRoot: layout.installRoot,
    currentVersion: layout.currentVersion,
    currentAppRoot: layout.currentAppRoot,
    databasePath: layout.databasePath,
    database,
    codexHome,
    codexReachable,
    releaseManifest,
    updateState,
    residues,
  });
}

async function findUpdateResidues(layout) {
  let appEntries = [];
  try {
    appEntries = await readdir(layout.appRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    staging: appEntries.filter((name) => name.includes(".staging-")),
    updateLock: await isReadable(join(layout.stateRoot, "update.lock")),
  };
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function isReadable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
