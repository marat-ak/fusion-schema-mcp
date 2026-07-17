import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnrichPrompt, parseEnrichReply } from "../src/corpus/enrichPrompt.js";
import type { SqlSource } from "../src/corpus/sources.js";

const otbi: SqlSource = {
  id: "otbi:X", source: "otbi", title: "S.T", originalSql: "SELECT c1 FROM Y",
  sourceHash: "h", raw: { relations: { dbTables: ["PER_CONTRACTS_F"], lookupTypes: ["CONTRACT_STATUS"], filters: [] }, logicalColumns: ["Desc"] },
};

test("OTBI prompt asks for rewrite and seeds tables/lookups", () => {
  const p = buildEnrichPrompt(otbi);
  assert.match(p.user, /PER_CONTRACTS_F/);
  assert.match(p.user, /CONTRACT_STATUS/);
  assert.match(p.system, /clean|readable/i);
});

test("parseEnrichReply returns typed Enrichment", () => {
  const reply = JSON.stringify({ cleanSql: "SELECT a FROM t", description: "d", tablesUsed: ["T"], lookupTypes: [] });
  const e = parseEnrichReply(reply, otbi);
  assert.equal(e.cleanSql, "SELECT a FROM t");
  assert.deepEqual(e.tablesUsed, ["T"]);
});

test("catalog reply without cleanSql defaults to original", () => {
  const cat: SqlSource = { ...otbi, id: "catalog:R", source: "catalog", raw: {} };
  const e = parseEnrichReply(JSON.stringify({ description: "d" }), cat);
  assert.equal(e.cleanSql, cat.originalSql);
});
