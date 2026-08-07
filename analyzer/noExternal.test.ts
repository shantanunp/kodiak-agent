import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Network policy: the UI must be fully self-contained — no CDN fonts, no
 * external scripts/styles. The only network calls in the whole system are
 * npm install, the model API (only when a key is configured), and GitHub
 * (only with --remote).
 */
test("UI makes no external network calls (no CDN fonts/scripts/styles)", () => {
  const offenders: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(html|css|js)$/.test(name)) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
        const url = m[0];
        if (/localhost|127\.0\.0\.1|www\.w3\.org/.test(url)) continue;
        offenders.push(`${full}: ${url}`);
      }
    }
  }
  walk("ui");
  walk("mock");
  assert.deepEqual(offenders, [], "external URLs found in UI assets");
});
