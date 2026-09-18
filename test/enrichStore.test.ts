import { test } from "node:test";
import assert from "node:assert/strict";
import type { SqlSource } from "../src/corpus/sources.js";
import { openTempCatalog } from "./fixture.js";

const src = (over: Partial<SqlSource> = {}): SqlSource => ({
  id: "otbi:X", source: "otbi", title: "S.T", originalSql: "SELECT 1",
  sourceHash: "h1", raw: {}, ...over,
});
const enrichment = { cleanSql: "x", description: "d", tablesUsed: [], lookupTypes: [], joins: [], filters: [], securityPredicate: null };

test("pendingIds reports new and hash-changed rows only", async () => {
  const store = (await openTempCatalog("en-", false)).db.enrich;
  assert.equal((await store.pendingIds([src()])).length, 1);           // new
  await store.upsertSource(src());
  await store.setEnrichment("otbi:X", enrichment);
  assert.equal((await store.pendingIds([src()])).length, 0);           // same hash, enriched
  assert.equal((await store.pendingIds([src({ sourceHash: "h2" })])).length, 1); // changed
});

test("pendingIds re-selects a row that was upserted but never enriched", async () => {
  const store = (await openTempCatalog("en-", false)).db.enrich;
  await store.upsertSource(src());                 // source row, description still NULL
  assert.equal((await store.pendingIds([src()])).length, 1, "un-enriched row stays pending");
  await store.setEnrichment("otbi:X", enrichment);
  assert.equal((await store.pendingIds([src()])).length, 0, "enriched row no longer pending");
});

test("setEnrichment persists and is readable", async () => {
  const store = (await openTempCatalog("en-", false)).db.enrich;
  await store.upsertSource(src());
  await store.setEnrichment("otbi:X", {
    cleanSql: "SELECT a FROM t", description: "desc",
    tablesUsed: ["T"], lookupTypes: [], joins: [], filters: [], securityPredicate: null,
  });
  const row = (await store.get("otbi:X"))!;
  assert.equal(row.cleanSql, "SELECT a FROM t");
  assert.deepEqual(row.tablesUsed, ["T"]);
});
