import { test } from "node:test";
import assert from "node:assert/strict";
import { embed, EMBED_DIM } from "../src/corpus/embed.js";

test("embed returns normalized 384-dim vectors", async () => {
  const keepAlive = setInterval(() => {}, 1 << 30); // embed.ts unref()s its worker — pin the loop while embedding
  const [v] = await embed(["supplier invoices unpaid over 90 days"]);
  clearInterval(keepAlive);
  assert.equal(v.length, EMBED_DIM);
  const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${norm}`);
});
