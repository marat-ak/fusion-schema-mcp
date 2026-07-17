import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openEnrichStore } from "../src/corpus/enrichStore.js";
import type { SqlSource } from "../src/corpus/sources.js";

const src = (over: Partial<SqlSource> = {}): SqlSource => ({
  id: "otbi:X", source: "otbi", title: "S.T", originalSql: "SELECT 1",
  sourceHash: "h1", raw: {}, ...over,
});

test("pendingIds reports new and hash-changed rows only", () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "en-")), "e.sqlite");
  const store = openEnrichStore(db);
  assert.equal(store.pendingIds([src()]).length, 1);           // new
  store.upsertSource(src());
  assert.equal(store.pendingIds([src()]).length, 0);           // same hash
  assert.equal(store.pendingIds([src({ sourceHash: "h2" })]).length, 1); // changed
});

test("setEnrichment persists and is readable", () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "en-")), "e.sqlite");
  const store = openEnrichStore(db);
  store.upsertSource(src());
  store.setEnrichment("otbi:X", {
    cleanSql: "SELECT a FROM t", description: "desc",
    tablesUsed: ["T"], lookupTypes: [], joins: [], filters: [], securityPredicate: null,
  });
  const row = store.get("otbi:X")!;
  assert.equal(row.cleanSql, "SELECT a FROM t");
  assert.deepEqual(row.tablesUsed, ["T"]);
});
