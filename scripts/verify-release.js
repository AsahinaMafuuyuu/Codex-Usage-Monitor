import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateReleaseManifest } from "../src/release-client.js";
import { validateReleaseTree } from "../src/updater.js";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(scriptDirectory, "..");

export async function verifyRelease({
  manifestPath,
  artifactPath,
  projectRoot = DEFAULT_PROJECT_ROOT,
  extractArchive = extractArchiveDefault,
} = {}) {
  const manifest = validateReleaseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const stats = await stat(artifactPath);
  if (stats.size !== manifest.artifact.size) throw new Error("release artifact size mismatch");
  const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  if (digest !== manifest.artifact.sha256) throw new Error("release artifact SHA-256 mismatch");

  const extractRoot = await mkdtemp(join(tmpdir(), "codex-release-verify-"));
  try {
    await extractArchive({ artifactPath, extractRoot, projectRoot });
    await validateReleaseTree(extractRoot, manifest);
    await access(join(extractRoot, "node_modules", "lucide", "dist", "umd", "lucide.min.js"), fsConstants.R_OK);
    const forbidden = await findForbiddenFiles(extractRoot);
    if (forbidden.length) throw new Error(`release artifact contains forbidden paths: ${forbidden.join(", ")}`);

    const version = await execFileAsync(
      process.execPath,
      [join(extractRoot, "bin", "codex-usage-monitor.js"), "--version"],
      { cwd: extractRoot, windowsHide: true },
    );
    if (version.stderr !== "" || version.stdout.trim() !== `Codex Usage Monitor ${manifest.version}`) {
      throw new Error(`release --version failed: ${version.stderr || version.stdout}`);
    }
    const selfCheck = await execFileAsync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(extractRoot, "bin", "codex-usage-monitor.js"), "doctor", "--release-self-check"],
      { cwd: extractRoot, windowsHide: true },
    );
    if (!selfCheck.stdout.includes(`Release self-check OK: ${manifest.version}`)) {
      throw new Error(`release self-check failed: ${selfCheck.stderr || selfCheck.stdout}`);
    }
    return Object.freeze({
      status: "verified",
      version: manifest.version,
      sha256: digest,
      size: stats.size,
      forbiddenPaths: forbidden,
    });
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

async function extractArchiveDefault({ artifactPath, extractRoot }) {
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${escapePowerShell(artifactPath)}' -DestinationPath '${escapePowerShell(extractRoot)}' -Force`],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function findForbiddenFiles(root) {
  const forbidden = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      const parts = rel.split("/");
      if (entry.isDirectory()) {
        if ([".git", ".codex", "data", "state", "downloads", "backups"].includes(entry.name)) {
          forbidden.push(rel);
          continue;
        }
        await walk(full);
        continue;
      }
      if (
        /(?:\.sqlite(?:-wal|-shm)?|\.log)$/iu.test(entry.name)
        || entry.name === "browser-auth.key"
        || parts.includes(".git")
        || parts.includes(".codex")
      ) forbidden.push(rel);
    }
  }
  await walk(root);
  return forbidden;
}

function escapePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--manifest", "--artifact"].includes(key) || value == null) throw new Error(`invalid verify-release argument: ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  if (!values.manifest || !values.artifact) throw new Error("--manifest and --artifact are required");
  return values;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifyRelease({
      manifestPath: resolve(args.manifest),
      artifactPath: resolve(args.artifact),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
