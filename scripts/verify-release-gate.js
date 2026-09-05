import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyReleaseGate({ tag, root = projectRoot } = {}) {
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lockMetadata = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const version = packageMetadata.version;
  if (tag !== `v${version}`) throw new Error(`tag ${tag ?? "missing"} does not match package ${version}`);
  if (lockMetadata?.version !== version || lockMetadata?.packages?.[""]?.version !== version) {
    throw new Error("package-lock root version does not match package version");
  }
  const releaseNotePath = join(root, "docs", "releases", `${tag}.md`);
  await access(releaseNotePath, fsConstants.R_OK).catch(() => {
    throw new Error(`release note missing: docs/releases/${tag}.md`);
  });
  const releaseNote = await readFile(releaseNotePath, "utf8");
  if (!releaseNote.includes(tag)) throw new Error(`release note does not identify ${tag}`);
  return Object.freeze({ version, tag, releaseNotePath });
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--tag") throw new Error("usage: verify-release-gate --tag vX.Y.Z");
  return { tag: argv[1] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await verifyReleaseGate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Release gate identity OK: ${result.tag}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
