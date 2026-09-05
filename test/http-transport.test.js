import assert from "node:assert/strict";
import test from "node:test";
import { requestHttps, resolveProxyForUrl } from "../src/http-transport.js";

test("shared HTTPS transport preserves manual redirect and caller headers", async () => {
  const calls = [];
  const response = await requestHttps("https://github.com/example", {
    headers: { Accept: "application/json", "User-Agent": "codex-usage-monitor/1.2.0" },
    proxyResolver: async () => null,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 302, headers: { Location: "https://example.test/next" } });
    },
  });
  assert.equal(response.status, 302);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(Object.hasOwn(calls[0].options.headers, "Authorization"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "ChatGPT-Account-Id"), false);
});

test("shared transport rejects non-HTTPS destinations before network I/O", async () => {
  let requested = false;
  await assert.rejects(
    requestHttps("http://github.com/example", {
      proxyResolver: async () => null,
      fetchImpl: async () => { requested = true; },
    }),
    (error) => error?.code === "https_required",
  );
  assert.equal(requested, false);
});

test("proxy resolution keeps HTTPS_PROXY and NO_PROXY precedence", async () => {
  assert.equal(
    await resolveProxyForUrl("https://github.com/example", {
      environment: { HTTPS_PROXY: "127.0.0.1:7890" },
      platform: "linux",
    }),
    "http://127.0.0.1:7890",
  );
  assert.equal(
    await resolveProxyForUrl("https://github.com/example", {
      environment: { HTTPS_PROXY: "127.0.0.1:7890", NO_PROXY: "github.com" },
      platform: "linux",
    }),
    null,
  );
});
