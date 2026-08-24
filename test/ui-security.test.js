import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the static UI does not require inline styles under the self-only CSP", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
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
  assert.match(script, /session\.projectPath/u);
  assert.match(script, /replace\(\/\^\\\\\\\\\\\?\\\\\/u, ""\)/u);
  assert.match(script, /const sessionUsage = snapshot\.summary\.totalUsage/u);
  assert.match(script, /formatCacheHitRate\(sessionUsage\)/u);
  assert.match(script, /formatCacheHitRate\(agent\.ownUsage\)/u);
  assert.match(script, /formatCacheHitRate\(task\.deltaUsage\)/u);
  assert.doesNotMatch(script, /data-preview-thread|<th>指令<\/th>/u);
  assert.match(script, /cached \/ input/u);
  assert.match(html, /id="session-cost"/u);
  assert.match(html, /id="input-total"/u);
  assert.match(html, /id="output-total"/u);
  assert.match(html, /id="cache-hit-rate"/u);
  assert.match(html, /content="light"/u);
  assert.match(html, /id="session-project"/u);
  assert.match(script, /class="agent-branch/u);
  assert.match(script, /class="agent-children/u);
  assert.match(script, /role-badge/u);
  assert.match(script, /<colgroup>/u);
  assert.match(styles, /--parchment:\s*#f4f1ea/iu);
  assert.match(styles, /--text-identifier:\s*10px/iu);
  assert.match(styles, /--text-utility:\s*11px/iu);
  assert.match(styles, /--text-label:\s*12px/iu);
  assert.match(styles, /--text-body:\s*14px/iu);
  assert.match(styles, /--text-data:\s*12px/iu);
  assert.match(styles, /--text-entity:\s*20px/iu);
  assert.doesNotMatch(styles, /font-size:\s*(?:8|9)px\b/iu);
  assert.match(styles, /\.eyebrow\s*\{[^}]*font-family:\s*var\(--body\)/isu);
  assert.match(styles, /\.role-badge\s*\{[^}]*font-family:\s*var\(--body\)/isu);
  assert.match(styles, /\.task-table th\s*\{[^}]*font-family:\s*var\(--body\)/isu);
  assert.match(styles, /\.task-table td\s*\{[^}]*font-family:\s*var\(--mono\)/isu);
  assert.match(styles, /\.role-reviewer/u);
  assert.match(styles, /\.role-test-worker/u);
  assert.match(styles, /--lineage-rail-offset:\s*18px/iu);
  assert.match(styles, /--lineage-elbow-width:\s*14px/iu);
  assert.match(styles, /\.agent-children\s*\{[^}]*margin-left:\s*var\(--lineage-rail-offset\)[^}]*padding-left:\s*var\(--lineage-elbow-width\)/isu);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.agent-tree\s*\{[^}]*--lineage-rail-offset:\s*10px;[^}]*--lineage-elbow-width:\s*8px/iu);
  assert.match(styles, /font-variant-numeric:\s*tabular-nums/iu);
  assert.match(styles, /prefers-reduced-motion/u);
});
