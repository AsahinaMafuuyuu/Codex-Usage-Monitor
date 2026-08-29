import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexRepository } from "../src/repository.js";

const ROOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TIMESTAMP = "2026-08-29T12:00:00.000Z";

test("a session named after monitor startup is named when its rollout is discovered", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await fixture.repository.initialize();
  await writeSessionIndex(fixture.codexHome, "已经命名的会话");
  await writeRootRollout(fixture.sessionsDirectory);

  await fixture.repository.discoverNewFiles();

  assert.equal(fixture.repository.getSession(ROOT)?.title, "已经命名的会话");
});

test("session index renames refresh even when the rollout itself is unchanged", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await writeSessionIndex(fixture.codexHome, "旧标题");
  await writeRootRollout(fixture.sessionsDirectory);
  await fixture.repository.initialize();
  assert.equal(fixture.repository.getSession(ROOT)?.title, "旧标题");

  await writeSessionIndex(fixture.codexHome, "新标题");
  const additions = await fixture.repository.discoverNewFiles();

  assert.equal(additions.length, 0);
  assert.equal(fixture.repository.getSession(ROOT)?.title, "新标题");
});

async function createRepositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-monitor-session-title-"));
  const codexHome = join(directory, ".codex");
  const sessionsDirectory = join(codexHome, "sessions", "2026", "08", "29");
  await mkdir(sessionsDirectory, { recursive: true });
  return {
    directory,
    codexHome,
    sessionsDirectory,
    repository: new CodexRepository(codexHome, { upsertSessions() {} }),
  };
}

async function writeSessionIndex(codexHome, title) {
  await writeFile(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: ROOT, thread_name: title, updated_at: TIMESTAMP })}\n`,
  );
}

async function writeRootRollout(sessionsDirectory) {
  const events = [
    {
      timestamp: TIMESTAMP,
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: ROOT,
        session_id: ROOT,
        timestamp: TIMESTAMP,
        cwd: "D:\\paper",
      },
    },
    {
      timestamp: TIMESTAMP,
      ordinal: 1,
      type: "event_msg",
      payload: { type: "task_started", turn_id: TURN },
    },
  ];
  await writeFile(
    join(sessionsDirectory, `rollout-session-title-${ROOT}.jsonl`),
    `${events.map(JSON.stringify).join("\n")}\n`,
  );
}
