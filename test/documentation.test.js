import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/DELIVERY.md",
  "docs/ARCHITECTURE.md",
  "docs/API.md",
  "docs/OPERATIONS.md",
  "docs/VERIFICATION.md",
  "docs/ROADMAP.md",
  "docs/RELEASE-CHECKLIST.md",
  "docs/decisions/README.md",
];

test("delivery documentation and multi-agent contract are complete", () => {
  for (const file of requiredFiles) {
    assert.equal(existsSync(resolve(root, file)), true, `${file} should exist`);
  }

  const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
  for (const invariant of [
    ".codex",
    "total_token_usage",
    "last_token_usage",
    "subagent_history_start_ordinal",
    "同一文件只能有一个写入 owner",
    "npm test",
  ]) {
    assert.match(agents, new RegExp(escapeRegExp(invariant), "u"));
  }

  const ignore = readFileSync(resolve(root, ".gitignore"), "utf8");
  for (const pattern of ["data/*.sqlite", "data/*.sqlite-wal", ".impeccable/"]) {
    assert.match(ignore, new RegExp(escapeRegExp(pattern), "u"));
  }
});

test("decision ADRs contain a valid lifecycle status and required sections", () => {
  const decisionDirectory = resolve(root, "docs/decisions");
  const adrs = readdirSync(decisionDirectory).filter((name) => /^\d{4}-.+\.md$/u.test(name));
  assert.equal(adrs.length >= 6, true);
  for (const name of adrs) {
    const content = readFileSync(resolve(decisionDirectory, name), "utf8");
    assert.match(
      content,
      /\*\*Status:\*\* (?:Accepted|Superseded by ADR-\d{4})/u,
      `${name} has an invalid ADR lifecycle status`,
    );
    for (const section of [
      "**Date:**",
      "## Context",
      "## Decision",
      "## Alternatives considered",
      "## Consequences",
    ]) {
      assert.match(content, new RegExp(escapeRegExp(section), "u"), `${name} is missing ${section}`);
    }
  }
});

test("relative inline Markdown links resolve to repository files", () => {
  const markdownFiles = collectMarkdownFiles(root);
  const broken = [];
  for (const file of markdownFiles) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1].trim();
      if (!target || target.startsWith("#") || /^[a-z]+:/iu.test(target)) continue;
      const path = target.split("#", 1)[0];
      if (path && !existsSync(resolve(dirname(file), decodeURIComponent(path)))) {
        broken.push(`${file}: ${target}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".impeccable" || entry.name === "data") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
