import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBootstrapProof } from "../src/browser-auth.js";
import { startApplication } from "../src/server.js";

test("exact loopback port fails fast on EADDRINUSE and does not drift", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fixed-port-"));
  const codexHome = join(directory, ".codex");
  await mkdir(codexHome, { recursive: true });
  const occupied = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(49_320, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    startApplication({
      codexHome,
      databasePath: join(directory, "usage.sqlite"),
      projectRoot: directory,
      environment: {},
      port: 49_320,
      browserAuthSecret: Buffer.alloc(32, 11),
    }),
    (error) => error?.code === "port_in_use" && error?.systemCode === "EADDRINUSE",
  );
  const driftProbe = createServer((_request, response) => response.end("free"));
  await new Promise((resolve, reject) => {
    driftProbe.once("error", reject);
    driftProbe.listen(49_321, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => driftProbe.close(resolve));
});

test("browser cookie remains valid after monitor restart with the persistent local secret", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cookie-restart-"));
  const codexHome = join(directory, ".codex");
  await mkdir(codexHome, { recursive: true });
  const secret = Buffer.alloc(32, 12);
  let app = null;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    codexHome,
    databasePath: join(directory, "usage.sqlite"),
    projectRoot: directory,
    environment: {},
    port: 49_322,
    browserAuthSecret: secret,
  };
  app = await startApplication(options);
  const cookie = await authorize(app, secret);
  const first = await fetch(`${app.origin}/api/sessions`, { headers: { Cookie: cookie } });
  assert.equal(first.status, 200);
  await app.close();
  app = null;

  app = await startApplication(options);
  const second = await fetch(`${app.origin}/api/sessions`, { headers: { Cookie: cookie } });
  assert.equal(second.status, 200);
  assert.equal(app.accessUrl, "http://127.0.0.1:49322/");
  assert.doesNotMatch(app.accessUrl, /\?/u);
});

test("only challenge/bootstrap are anonymous; favicon and application routes remain authorized", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-auth-routes-"));
  const codexHome = join(directory, ".codex");
  await mkdir(codexHome, { recursive: true });
  const app = await startApplication({
    codexHome,
    databasePath: join(directory, "usage.sqlite"),
    projectRoot: directory,
    environment: {},
    port: 49_323,
    browserAuthSecret: Buffer.alloc(32, 13),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${app.origin}/auth/challenge`)).status, 200);
  assert.equal((await fetch(`${app.origin}/`)).status, 401);
  assert.equal((await fetch(`${app.origin}/favicon.ico`)).status, 401);
  assert.equal((await fetch(`${app.origin}/api/health`)).status, 401);
});

async function authorize(app, secret) {
  const response = await fetch(`${app.origin}/auth/challenge`);
  const challenge = await response.json();
  const proof = createBootstrapProof({
    secret,
    origin: app.origin,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
    protocolVersion: challenge.protocolVersion,
  });
  const url = new URL("/auth/bootstrap", app.origin);
  url.searchParams.set("version", String(challenge.protocolVersion));
  url.searchParams.set("challenge", challenge.challenge);
  url.searchParams.set("expiresAt", String(challenge.expiresAt));
  url.searchParams.set("proof", proof);
  const exchange = await fetch(url, { redirect: "manual" });
  assert.equal(exchange.status, 302);
  const setCookie = exchange.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  assert.match(setCookie, /Max-Age=15552000/iu);
  return setCookie.split(";", 1)[0];
}
