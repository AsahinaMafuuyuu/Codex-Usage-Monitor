import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexUsageClient,
  CodexUsageUnavailableError,
  normalizeOfficialUsagePayload,
  parseWindowsProxyRegistryOutput,
  resolveCodexUsageUrl,
  resolveProxyForUrl,
} from "../src/codex-usage-client.js";

test("official Codex usage URL follows the current backend-client path style", () => {
  assert.equal(
    resolveCodexUsageUrl("https://chatgpt.com"),
    "https://chatgpt.com/backend-api/wham/usage",
  );
  assert.equal(
    resolveCodexUsageUrl("https://chatgpt.com/backend-api/"),
    "https://chatgpt.com/backend-api/wham/usage",
  );
  assert.equal(
    resolveCodexUsageUrl("https://example.test"),
    "https://example.test/api/codex/usage",
  );
});

test("Windows system proxy is detected for HTTPS usage calls while NO_PROXY still wins", async () => {
  const parsed = parseWindowsProxyRegistryOutput(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
  `);
  assert.deepEqual(parsed, { enabled: true, server: "127.0.0.1:7890" });
  const proxy = await resolveProxyForUrl("https://chatgpt.com/backend-api/wham/usage", {
    environment: {},
    platform: "win32",
    registryReader: async () => parsed,
  });
  assert.equal(proxy, "http://127.0.0.1:7890");
  const bypassed = await resolveProxyForUrl("https://chatgpt.com/backend-api/wham/usage", {
    environment: { NO_PROXY: "chatgpt.com" },
    platform: "win32",
    registryReader: async () => parsed,
  });
  assert.equal(bypassed, null);
});

test("usage client rereads global Codex config and auth and sends only the official quota GET", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-client-"));
  const codexHome = join(directory, ".codex");
  await mkdir(codexHome, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(codexHome, "config.toml"),
    'model = "gpt-5.6-sol"\nchatgpt_base_url = "https://chatgpt.com"\n[features]\nnetwork_access = true\n',
  );
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "token-one", account_id: "account-one" } }),
  );

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000,
          reset_at: 1_788_000_000,
        },
        secondary_window: {
          used_percent: 7,
          limit_window_seconds: 604_800,
          reset_at: 1_788_600_000,
        },
      },
      credits: { has_credits: false, balance: "0" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new CodexUsageClient({
    codexHome,
    fetchImpl,
    now: () => new Date("2026-08-28T20:00:00.000Z"),
  });

  const first = await client.fetchQuota();
  assert.equal(requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.headers.Authorization, "Bearer token-one");
  assert.equal(requests[0].options.headers["ChatGPT-Account-Id"], "account-one");
  assert.equal(first.planType, "plus");
  assert.equal(first.primary.usedPercent, 42);
  assert.equal(first.primary.windowMinutes, 300);
  assert.equal(first.secondary.windowMinutes, 10_080);
  assert.equal(first.observedAt, "2026-08-28T20:00:00.000Z");
  assert.equal(first.source, "official-usage-api");

  await writeFile(join(codexHome, "config.toml"), 'chatgpt_base_url = "https://example.test"\n');
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "token-two", account_id: "account-two" } }),
  );
  await client.fetchQuota();
  assert.equal(requests[1].url, "https://example.test/api/codex/usage");
  assert.equal(requests[1].options.headers.Authorization, "Bearer token-two");
  assert.equal(requests[1].options.headers["ChatGPT-Account-Id"], "account-two");
});

test("usage client treats missing ChatGPT file credentials as unavailable without making a request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-client-no-auth-"));
  const codexHome = join(directory, ".codex");
  await mkdir(codexHome, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requested = false;
  const client = new CodexUsageClient({
    codexHome,
    fetchImpl: async () => {
      requested = true;
      throw new Error("should not run");
    },
  });
  await assert.rejects(
    client.fetchQuota(),
    (error) => error instanceof CodexUsageUnavailableError
      && error.code === "chatgpt_auth_unavailable",
  );
  assert.equal(requested, false);
});

test("official usage payload maps server seconds and reset timestamps to the monitor quota shape", () => {
  const quota = normalizeOfficialUsagePayload({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 12.5, limit_window_seconds: 301, reset_at: 1_700_000_000 },
    },
  }, "2026-08-28T20:00:00.000Z");
  assert.equal(quota.limitId, "codex");
  assert.equal(quota.primary.windowMinutes, 6);
  assert.equal(quota.primary.resetsAt, "2023-11-14T22:13:20.000Z");
  assert.equal(quota.observedAt, "2026-08-28T20:00:00.000Z");
});
