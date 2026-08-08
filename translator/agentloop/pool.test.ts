import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPool } from "./pool.js";

test("mapPool respects concurrency and preserves order", async () => {
  let live = 0;
  let maxLive = 0;
  const items = [1, 2, 3, 4, 5, 6];
  const out = await mapPool(items, 2, async (n) => {
    live++;
    maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(maxLive <= 2, `maxLive=${maxLive}`);
});
