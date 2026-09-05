import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { STORAGE_COMPATIBILITY } from "../src/storage-compatibility.js";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(scriptDirectory, "..");

export async function buildRelease({
  projectRoot = DEFAULT_PROJECT_ROOT,
  tag,
  commit,
  outputDir = join(projectRoot, "dist", "release"),
  publishedAt = new Date().toISOString(),
  installRuntimeDependencies = installRuntimeDependenciesDefault,
  createArchive = createArchiveDefault,
} = {}) {
  const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const lockMetadata = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  validateReleaseIdentity({ packageMetadata, lockMetadata, tag, commit });
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("publishedAt must be an ISO timestamp");

  await mkdir(outputDir, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-release-build-"));
  const stagingRoot = join(temporaryRoot, "runtime");
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const directory of ["bin", "src", "public"]) {
      await cp(join(projectRoot, directory), join(stagingRoot, directory), { recursive: true });
    }
    for (const file of ["package.json", "package-lock.json"]) {
      await cp(join(projectRoot, file), join(stagingRoot, file));
    }
    await installRuntimeDependencies({ stagingRoot, projectRoot });
    await compactRuntimeDependencies(stagingRoot, packageMetadata);

    const buildManifest = {
      schemaVersion: 1,
      name: "codex-usage-monitor",
      version: packageMetadata.version,
      tag,
      commit: commit.toLowerCase(),
      runtime: {
        node: packageMetadata.engines?.node,
        platform: "win32",
      },
      storage: STORAGE_COMPATIBILITY,
    };
    await writeFile(join(stagingRoot, "build-manifest.json"), `${JSON.stringify(buildManifest, null, 2)}\n`);

    const artifactName = `codex-usage-monitor-v${packageMetadata.version}-win.zip`;
    const artifactPath = join(outputDir, artifactName);
    await createArchive({ sourceRoot: stagingRoot, destination: artifactPath, projectRoot });
    const artifactStats = await stat(artifactPath);
    const sha256 = await sha256File(artifactPath);
    const releaseManifest = {
      schemaVersion: 1,
      name: "codex-usage-monitor",
      version: packageMetadata.version,
      tag,
      channel: "stable",
      commit: commit.toLowerCase(),
      publishedAt,
      runtime: buildManifest.runtime,
      storage: STORAGE_COMPATIBILITY,
      artifact: {
        name: artifactName,
        sha256,
        size: artifactStats.size,
      },
    };
    const manifestPath = join(outputDir, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
    await cp(join(projectRoot, "scripts", "install.ps1"), join(outputDir, "install.ps1"));
    return Object.freeze({
      artifactPath,
      manifestPath,
      installerPath: join(outputDir, "install.ps1"),
      buildManifest,
      releaseManifest,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateReleaseIdentity({ packageMetadata, lockMetadata, tag, commit }) {
  const version = packageMetadata?.version;
  if (packageMetadata?.name !== "codex-usage-monitor") throw new Error("package name mismatch");
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? "")) throw new Error("package version is not stable SemVer");
  if (tag !== `v${version}`) throw new Error(`tag ${tag ?? "missing"} does not match package version ${version}`);
  if (lockMetadata?.packages?.[""]?.version !== version || lockMetadata?.version !== version) {
    throw new Error("package-lock root version does not match package version");
  }
  if (!/^[0-9a-f]{40}$/iu.test(commit ?? "")) throw new Error("commit must be a 40-hex Git SHA");
  if (packageMetadata?.engines?.node !== ">=24.0.0") throw new Error("release Node range must be >=24.0.0");
  return true;
}

async function installRuntimeDependenciesDefault({ stagingRoot }) {
  if (process.platform === "win32") {
    await execFileAsync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npm ci --omit=dev --ignore-scripts --no-audit --no-fund"],
      { cwd: stagingRoot, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
    return;
  }
  await execFileAsync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stagingRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function compactRuntimeDependencies(stagingRoot, packageMetadata) {
  const dependencyNames = Object.keys(packageMetadata?.dependencies ?? {}).sort();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(["lucide"])) {
    throw new Error(`release runtime dependency allowlist is stale: ${dependencyNames.join(", ") || "none"}`);
  }
  const lucideSource = join(stagingRoot, "node_modules", "lucide", "dist", "umd", "lucide.min.js");
  const lucideBytes = await readFile(lucideSource).catch(() => {
    throw new Error("runtime dependency missing after npm ci: lucide/dist/umd/lucide.min.js");
  });
  const nodeModulesRoot = join(stagingRoot, "node_modules");
  await rm(nodeModulesRoot, { recursive: true, force: true });
  const lucideTargetRoot = join(nodeModulesRoot, "lucide", "dist", "umd");
  await mkdir(lucideTargetRoot, { recursive: true });
  await writeFile(join(lucideTargetRoot, "lucide.min.js"), lucideBytes);
}

async function createArchiveDefault({ sourceRoot, destination, projectRoot }) {
  void projectRoot;
  await createDeterministicZip({ sourceRoot, destination });
}

export async function createDeterministicZip({ sourceRoot, destination }) {
  const files = await listReleaseFiles(sourceRoot);
  if (files.length > 65_535) throw new Error("release ZIP exceeds classic ZIP entry limit");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.relativePath, "utf8");
    const data = await readFile(file.absolutePath);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    if (data.length > 0xffff_ffff || compressed.length > 0xffff_ffff || offset > 0xffff_ffff) {
      throw new Error("release ZIP exceeds classic ZIP size limit");
    }
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // 2000-01-01 in DOS date format.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(destination, Buffer.concat([...localParts, centralDirectory, end]));
}

async function listReleaseFiles(root) {
  const resolvedRoot = resolve(root);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release staging contains symlink: ${absolutePath}`);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`release staging contains unsupported entry: ${absolutePath}`);
      files.push({
        absolutePath,
        relativePath: relative(resolvedRoot, absolutePath).replaceAll("\\", "/"),
      });
    }
  }
  await walk(resolvedRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return files;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffff_ffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--tag", "--commit", "--output-dir", "--published-at"].includes(key) || value == null) {
      throw new Error(`invalid build-release argument: ${key}`);
    }
    values[key.slice(2)] = value;
    index += 1;
  }
  if (!values.tag || !values.commit) throw new Error("--tag and --commit are required");
  return values;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildRelease({
      tag: args.tag,
      commit: args.commit,
      outputDir: args["output-dir"] ? resolve(args["output-dir"]) : undefined,
      publishedAt: args["published-at"] ?? undefined,
    });
    process.stdout.write(`${result.artifactPath}\n${result.manifestPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
