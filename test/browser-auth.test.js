import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_AUTH_PROTOCOL_VERSION,
  createBootstrapProof,
  createBrowserAuth,
  ensureBrowserAuthSecret,
} from "../src/browser-auth.js";

test("browser auth secret is persistent, exactly 32 bytes, and corrupt state fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-browser-auth-secret-"));
  const stateRoot = join(root, "data", "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = ensureBrowserAuthSecret({ stateRoot, mutableRoot: root });
  const second = ensureBrowserAuthSecret({ stateRoot, mutableRoot: root });
  assert.equal(first.length, 32);
  assert.deepEqual(second, first);
  await writeFile(join(stateRoot, "browser-auth.key"), Buffer.alloc(31));
  assert.throws(
    () => ensureBrowserAuthSecret({ stateRoot, mutableRoot: root }),
    /格式损坏/u,
  );
});

test("bootstrap challenge is one-shot, expiring, and origin-bound", () => {
  let now = 1_000_000;
  const secret = Buffer.alloc(32, 7);
  const auth = createBrowserAuth({ secret, now: () => now, randomBytes: (size) => Buffer.alloc(size, 8) });
  const origin = "http://127.0.0.1:47832";
  const challenge = auth.createBootstrapChallenge(origin);
  const proof = createBootstrapProof({ secret, origin, ...challenge });
  assert.equal(auth.consumeBootstrapProof({ origin, proof, ...challenge }), true);
  assert.equal(auth.consumeBootstrapProof({ origin, proof, ...challenge }), false);

  const wrongOriginChallenge = auth.createBootstrapChallenge(origin);
  const wrongOriginProof = createBootstrapProof({ secret, origin, ...wrongOriginChallenge });
  assert.equal(auth.consumeBootstrapProof({
    origin: "http://localhost:47832",
    proof: wrongOriginProof,
    ...wrongOriginChallenge,
  }), false);

  const expired = auth.createBootstrapChallenge(origin);
  const expiredProof = createBootstrapProof({ secret, origin, ...expired });
  now = expired.expiresAt + 1;
  assert.equal(auth.consumeBootstrapProof({ origin, proof: expiredProof, ...expired }), false);
});

test("persistent cookie MAC is origin-bound and expires without process-local state", () => {
  let now = 5_000_000;
  const secret = Buffer.alloc(32, 3);
  const origin = "http://127.0.0.1:47832";
  const firstProcess = createBrowserAuth({ secret, now: () => now });
  const cookie = firstProcess.issueCookie(origin);
  assert.equal(firstProcess.verifyCookie(cookie, origin), true);
  assert.equal(firstProcess.verifyCookie(cookie, "http://localhost:47832"), false);
  const secondProcess = createBrowserAuth({ secret, now: () => now });
  assert.equal(secondProcess.verifyCookie(cookie, origin), true);
  now += 181 * 24 * 60 * 60 * 1000;
  assert.equal(secondProcess.verifyCookie(cookie, origin), false);
});

test("bootstrap proof protocol version is explicit", () => {
  const secret = Buffer.alloc(32, 1);
  const proof = createBootstrapProof({
    secret,
    origin: "http://127.0.0.1:47832",
    challenge: "abc",
    expiresAt: 123,
    protocolVersion: BROWSER_AUTH_PROTOCOL_VERSION,
  });
  assert.match(proof, /^[A-Za-z0-9_-]+$/u);
});
