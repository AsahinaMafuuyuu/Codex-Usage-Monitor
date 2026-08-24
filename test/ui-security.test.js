import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the static UI does not require inline styles under the self-only CSP", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /\sstyle\s*=/iu);
  assert.doesNotMatch(html, /<style\b/iu);
  assert.doesNotMatch(script, /\sstyle\s*=/iu);
  assert.doesNotMatch(script, /\.style(?:\.|\[)/u);
  assert.doesNotMatch(script, /\.style\s*=/u);
  assert.doesNotMatch(script, /setAttribute\(\s*["']style["']/u);
  assert.doesNotMatch(script, /\.cssText\b|\.setProperty\(|\.insertRule\(/u);
  assert.match(script, /<progress\b/u);
  assert.match(script, /task\.model/u);
  assert.match(script, /task\.effort/u);
  assert.match(script, /task\.costEstimate/u);
  assert.match(script, /summary\.totalCostEstimate/u);
  assert.match(script, /agent\.ownCostEstimate/u);
  assert.match(script, /agent\.subtreeCostEstimate/u);
  assert.match(html, /id="session-cost"/u);
  assert.match(script, /colspan="14"/u);
});
