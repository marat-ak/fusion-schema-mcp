/**
 * Provider-contract suite: the FULL CatalogProvider method set exercised against the sqlite
 * provider on synthetic fixtures (deterministic unit vectors — no embedding model). One block per
 * API group + the semantic gates: KNN top-K equals brute-force cosine, text search set equality,
 * materialize replace-by-id, transactions serialize concurrent writers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openTempCatalog, dropScratchDbs, PROVIDER } from "./fixture.js";
import { EMBED_DIM } from "../src/corpus/embed.js";

// deterministic PRNG → unit vectors
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function vec(): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let n = 0;
  for (let i = 0; i < EMBED_DIM; i++) { v[i] = rnd() - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= n;
  return v;
}
function l2(a: Float32Array, b: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }

const { db, dir } = await openTempCatalog("contract-", false);
const SQLITE = PROVIDER === "sqlite";

test("meta: versions/set/stats/activeVersion", async () => {
  assert.equal(await db.meta.versions(), null);
  await db.meta.setVersions({ schema: "2", queries: "1", embedding: "bge-small-en-v1.5-384" });
  assert.deepEqual(await db.meta.versions(), { schema: "2", queries: "1", embedding: "bge-small-en-v1.5-384" });
  await db.meta.set("tables", "3");
  const s = await db.meta.stats();
  assert.equal(s.tables, "3"); assert.equal(s.schema_version, "2");
  assert.equal(db.meta.activeVersion(), SQLITE ? "" : "v2999_01", "sqlite has no version schema; postgres serves one");
  await db.meta.ensureDdl(); // idempotent (postgres: the upgrade job's explicit call, never boot)
  await db.meta.ensureIndexes();
});

test("schema: bulkLoad all targets + every read + FTS search sets", async () => {
  await db.schema.bulkLoad("tables", [
    { name: "AP_INVOICES_ALL", schema: "FUSION", type: "TABLE", module: "AP", remarks: "supplier invoice header", view_text: null },
    { name: "AP_INVOICES_ALL", schema: "OTHER", type: "TABLE", module: "AP", remarks: "dup must not win", view_text: null },
    { name: "AR_PAYMENT_SCHEDULES_ALL", schema: "FUSION", type: "TABLE", module: "AR", remarks: "customer receivable schedule", view_text: null },
    { name: "HZ_PARTIES", schema: "FUSION", type: "TABLE", module: "HZ", remarks: "party master", view_text: null },
    { name: "PER_ALL_PEOPLE_F", schema: "FUSION", type: "TABLE", module: "PER", remarks: "people date effective", view_text: null },
  ]);
  await db.schema.bulkLoad("columns", [
    ["AP_INVOICES_ALL", "INVOICE_ID", "NUMBER", 18, 0, "pk", 1],
    ["AP_INVOICES_ALL", "INVOICE_AMOUNT", "NUMBER", 18, 1, "amount", 2],
    ["AP_INVOICES_ALL", "VENDOR_ID", "NUMBER", 18, 1, "supplier", 3],
    ["PER_ALL_PEOPLE_F", "PERSON_ID", "NUMBER", 18, 0, null, 1],
    ["PER_ALL_PEOPLE_F", "EFFECTIVE_START_DATE", "DATE", 7, 0, null, 2],
    ["PER_ALL_PEOPLE_F", "EFFECTIVE_END_DATE", "DATE", 7, 0, null, 3],
  ]);
  await db.schema.bulkLoad("pkeys", [["AP_INVOICES_ALL", "INVOICE_ID", 1]]);
  await db.schema.bulkLoad("fkeys", [["AP_INVOICES_ALL", "HZ_PARTIES", "VENDOR_ID", 1, "AP_INV_PARTY_FK"]]);
  await db.schema.bulkLoad("indexes", [["AP_INVOICES_ALL", "AP_INVOICES_U1", 1, 1, "INVOICE_ID"], ["AP_INVOICES_ALL", "AP_INVOICES_N1", 0, 1, "VENDOR_ID"]]);
  await db.schema.bulkLoad("relationships_mined", [["AP_INVOICES_ALL", "VENDOR_ID", "HZ_PARTIES", "PARTY_ID", "join", 12, "HIGH"]]);
  await db.schema.bulkLoad("relationships_otbi", [["AR_PAYMENT_SCHEDULES_ALL", "CUSTOMER_ID", "HZ_PARTIES", "PARTY_ID", "x = y"]]);
  await db.schema.rebuildTablesFts();
  await db.schema.reloadTableNames();

  assert.deepEqual([...db.schema.tableNames()].sort(), ["AP_INVOICES_ALL", "AR_PAYMENT_SCHEDULES_ALL", "HZ_PARTIES", "PER_ALL_PEOPLE_F"]);
  const t = (await db.schema.getTable("AP_INVOICES_ALL"))!;
  assert.equal(t.schema, "FUSION", "FUSION row wins the upsert"); assert.equal(t.remarks, "supplier invoice header");
  assert.equal(await db.schema.getTable("NOPE"), null);
  assert.equal(await db.schema.moduleOf("AP_INVOICES_ALL"), "AP"); assert.equal(await db.schema.moduleOf("NOPE"), undefined);
  assert.deepEqual((await db.schema.columns("AP_INVOICES_ALL")).map((c) => c.name), ["INVOICE_ID", "INVOICE_AMOUNT", "VENDOR_ID"]);
  assert.equal(await db.schema.columnCount("AP_INVOICES_ALL"), 3);
  assert.deepEqual(await db.schema.primaryKey("AP_INVOICES_ALL"), ["INVOICE_ID"]);
  assert.equal((await db.schema.indexes("AP_INVOICES_ALL")).length, 2);
  const fk = await db.schema.fkeys("AP_INVOICES_ALL");
  assert.equal(fk.out[0].other, "HZ_PARTIES"); assert.equal((await db.schema.fkeys("HZ_PARTIES")).in[0].other, "AP_INVOICES_ALL");
  const rel = await db.schema.relationships("HZ_PARTIES");
  assert.equal(rel.to.length, 2); assert.equal(rel.from.length, 0);
  assert.equal((await db.schema.columnSignals()).filter((c) => c.col === "effective_start_date").length, 1);

  // text search: AND narrows, OR widens; sets compared against a brute-force token match
  const and = await db.schema.searchTables(["SUPPLIER", "INVOICE"], "and", 20);
  assert.deepEqual(and.map((r) => r.name), ["AP_INVOICES_ALL"]);
  const or = await db.schema.searchTables(["CUSTOMER", "PARTY"], "or", 20);
  assert.deepEqual(or.map((r) => r.name).sort(), ["AR_PAYMENT_SCHEDULES_ALL", "HZ_PARTIES"]);
  assert.deepEqual((await db.schema.searchTables(["ZZZ"], "and", 20)), []);
});

const N = 30;
const rows = Array.from({ length: N }, (_v, i) => ({
  id: `sql:${i}`, title: i < 3 ? "Shared.Title" : `Area.T${i}`, originalSql: `SELECT ${i} FROM T${i}`, cleanSql: "x".repeat(i * 200 + 10),
  description: `desc ${i}`, tablesUsed: ["AP_INVOICES_ALL", `T${i}`], lookupTypes: [], joins: ["a=b"], filters: [`T${i}.FLAG = 'Y'`, "AP_INVOICES_ALL.STATUS = 'OPEN'"],
  source: i % 3 === 0 ? "otbi" : "bip-report", intents: [`intent ${i}`], mechanics: i % 2 ? "mech" : null,
}));
const vecs = rows.map(() => [vec(), vec()]); // description vector + one intent vector

test("corpus: materialize (replace-by-id), lookups, KNN == brute force, queues, export/import", async () => {
  const r1 = await db.corpus.materialize(rows, vecs);
  assert.deepEqual(r1, { inserted: N, replaced: 0 });
  const r2 = await db.corpus.materialize(rows.slice(0, 5), vecs.slice(0, 5));
  assert.deepEqual(r2, { inserted: 5, replaced: 5 }, "re-materializing replaces by id");
  assert.equal(await db.corpus.count(), N);
  assert.equal((await db.corpus.ids()).size, N);
  assert.equal(await db.corpus.hasMultiVectors(), true);

  const q = vec();
  // 1-vector KNN vs brute force on the description vectors
  const brute = rows.map((r, i) => ({ id: r.id, d: l2(q, vecs[i][0]) })).sort((a, b) => a.d - b.d);
  const hits = await db.corpus.knn(q, 10);
  assert.deepEqual(hits.map((h) => h.id), brute.slice(0, 10).map((b) => b.id));
  hits.forEach((h, k) => assert.ok(Math.abs(h.distance - brute[k].d) < 1e-5));
  // multi-vector KNN: best phrasing per row, dedup by qrid gives the same top ids as brute force over all vectors
  const bruteMulti = rows.map((r, i) => ({ id: r.id, d: Math.min(...vecs[i].map((v) => l2(q, v))) })).sort((a, b) => a.d - b.d);
  const mh = await db.corpus.knn(q, 60, { multi: true });
  const seen = new Map<number, any>(); for (const h of mh) if (!seen.has(h.qrid!)) seen.set(h.qrid!, h);
  assert.deepEqual([...seen.values()].slice(0, 10).map((h) => h.id), bruteMulti.slice(0, 10).map((b) => b.id));
  // source filter
  for (const h of await db.corpus.knn(q, 5, { source: "otbi" })) assert.equal(h.source, "otbi");
  for (const h of await db.corpus.knn(q, 30, { source: "otbi", multi: true })) assert.equal(h.source, "otbi");

  assert.equal((await db.corpus.byTitle("Shared.Title"))!.id, "sql:2", "largest SQL wins");
  assert.equal((await db.corpus.byId("sql:7"))!.title, "Area.T7");
  assert.equal(await db.corpus.byId("nope"), null);
  assert.deepEqual((await db.corpus.siblings("Shared.Title")).map((s) => s.id), ["sql:2", "sql:1", "sql:0"]);
  assert.equal((await db.corpus.byTitlePrefix("Area.%", 5)).length, 5);
  assert.ok((await db.corpus.nearTitles("%T1%")).length > 0);
  assert.equal((await db.corpus.titleAndSql("sql:4"))!.sql, rows[4].cleanSql);

  // re-enrich queues: mechanics IS NULL rows only, redo = degraded big rows
  const pend = await db.corpus.reenrichQueue(["bip-report", "otbi"], 100);
  assert.equal(pend.length, rows.filter((r) => !r.mechanics).length);
  await db.corpus.updateEnrichment("sql:20", { description: "new", intents: ["i1", "i2"], mechanics: "(no notable mechanics)" }, [vec(), vec(), vec()]);
  assert.equal((await db.corpus.byId("sql:20"))!.description, "new");
  assert.equal(await db.corpus.updateEnrichment("nope", { description: "n", intents: [], mechanics: null }, [vec()]), false);
  const redo = await db.corpus.redoQueue(["bip-report", "otbi"], 100);
  assert.deepEqual(redo.map((r) => r.id), ["sql:20"], "degraded row (>3000 chars, placeholder mechanics)");
  const c = await db.corpus.reenrichCounts(["bip-report", "otbi"]);
  assert.equal(c.total, N); assert.equal(c.pending, pend.length - 1);

  // registry inputs
  assert.equal((await db.corpus.rowsForGrain()).length, N);
  assert.equal((await db.corpus.rowsForUsage()).length, N);
  assert.equal((await db.corpus.rowsForPredicates()).length, N);
  assert.deepEqual(await db.corpus.joinColumnStats("AP_INVOICES_ALL", 8), [], "absent dev-only rollup table = no stats");

  // export/import round trip (data + full)
  const data: any[] = []; for await (const r of db.corpus.export("data")) data.push(r);
  assert.equal(data.length, N); assert.ok(!("embedding" in data[0]));
  const full: any[] = []; for await (const r of db.corpus.export("full", "otbi")) full.push(r);
  assert.ok(full.length > 0 && full.every((r) => r.source === "otbi" && typeof r.embedding === "string"));
  const b64 = Buffer.from(full[0].embedding, "base64"); const dec = new Float32Array(b64.byteLength / 4); Buffer.from(dec.buffer).set(b64);
  const imp = await db.corpus.importRows([{ ...full[0], id: "imp:1" }, { ...data[1], id: data[1].id }], [dec, vec()]);
  assert.deepEqual(imp, { imported: 2, replaced: 1 });
  assert.equal(await db.corpus.count(), N + 1);
});

test("corpus: bulkLoad + embedding maintenance + seed refresh", async () => {
  const n0 = await db.corpus.count();
  await db.corpus.bulkLoad([{ id: "bulk:1", source: "view", title: "V1", originalSql: "s", cleanSql: null, description: "d", tablesUsed: [], joins: [], filters: [], lookupTypes: [], securityPredicate: null, approved: 1 }], [vec()]);
  assert.equal(await db.corpus.count(), n0 + 1);
  assert.equal((await db.corpus.rowsMissingEmbedding(["view"])).length, 0);
  const all = await db.corpus.allRowsForEmbedding();
  assert.equal(all.length, n0 + 1);
  await db.corpus.setEmbeddings(all.slice(0, 3).map((r) => ({ rid: r.rid, vec: vec() })));
  await db.corpus.rebuildVectorIndex();
  assert.equal((await db.corpus.knn(vec(), 5)).length, 5);
  if (!SQLITE) {
    await assert.rejects(() => db.corpus.replaceSourcesFromSeed("/nope.sqlite", ["otbi"]), /sqlite-only/);
    return;
  }
  // seed refresh: a second catalog acts as the seed for the otbi rows
  const seedCat = await openTempCatalog("seed-", false);
  await seedCat.db.corpus.materialize([{ id: "seed:1", source: "otbi", title: "S1", originalSql: "s", cleanSql: "s", description: "seed row", tablesUsed: [], lookupTypes: [] }], [[vec()]]);
  await seedCat.db.close();
  const otbiBefore = (await db.corpus.export("data", "otbi"));
  let nb = 0; for await (const _r of otbiBefore) nb++;
  assert.ok(nb > 0);
  const replaced = await db.corpus.replaceSourcesFromSeed(path.join(seedCat.dir, "reports.sqlite"), ["otbi"]);
  assert.equal(replaced, 1);
  let na = 0; for await (const r of db.corpus.export("data", "otbi")) { na++; assert.equal(r.id, "seed:1"); }
  assert.equal(na, 1);
  assert.equal((await db.corpus.rowsMissingEmbedding(["otbi"])).length, 0, "seed rows carry their blob");
});

test("registries: replaceAll x3, reads, version stamps", async () => {
  for (const k of ["grain", "usage", "predicates"] as const) {
    assert.equal(await db.registries.version(k), null); assert.equal(await db.registries.count(k), 0);
    await db.registries.setVersion(k, "7"); assert.equal(await db.registries.version(k), "7");
  }
  await db.registries.replaceAll("grain", [{ table_name: "PER_ALL_PEOPLE_F", grain: "effective_dated", multi_row: 1, dedup: "SYSDATE BETWEEN", signals: '["effective_start_date"]', corpus_evidence: 3, note: "n", updated_at: "t" }]);
  await db.registries.replaceAll("grain", [{ table_name: "PER_ALL_PEOPLE_F", grain: "effective_dated", multi_row: 1, dedup: "SYSDATE BETWEEN", signals: "[]", corpus_evidence: 4, note: "n2", updated_at: "t2" }]);
  assert.equal(await db.registries.count("grain"), 1);
  assert.equal((await db.registries.grain("PER_ALL_PEOPLE_F"))!.corpus_evidence, 4);
  assert.equal(await db.registries.grain("NOPE"), null);
  await db.registries.replaceAll("usage", [
    { table_name: "AP_INVOICES_ALL", query_id: "sql:7", source: "bip-report", title: "Area.T7", sql_chars: 1410, score: 301410 },
    { table_name: "AP_INVOICES_ALL", query_id: "sql:3", source: "otbi", title: "Area.T3", sql_chars: 610, score: 100610 },
  ]);
  assert.equal(await db.registries.usageCount("AP_INVOICES_ALL"), 2);
  const u = await db.registries.usages("AP_INVOICES_ALL", 1);
  assert.equal(u.length, 1); assert.equal(u[0].id, "sql:7"); assert.ok(u[0].clean_sql);
  await db.registries.replaceAll("predicates", [
    { table_name: "AP_INVOICES_ALL", column_name: "STATUS", op: "=", literal: "'OPEN'", occurrences: 30, role: "structural" },
    { table_name: "AP_INVOICES_ALL", column_name: "TYPE", op: "=", literal: "'A'", occurrences: 2, role: "discriminator" },
  ]);
  assert.equal((await db.registries.predicates("AP_INVOICES_ALL")).length, 2);
  assert.deepEqual(await db.registries.topPredicates("AP_INVOICES_ALL", 1), [{ column: "STATUS", op: "=", literal: "'OPEN'", occurrences: 30 }]);
});

test("flex: snapshots, queries, counts, config-report merge", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  const n = await db.flex.replaceSnapshot("flexfields", "admin-export", [
    [1, "DFF", "AP_INVOICES", "DEPLOYED", "Global Data Elements", "Y", null, null, "SEG1", "ATTRIBUTE1", 1, "Pallet Qty", "Pallet", "TEXT", 100, "N", "Y", "admin-export", now],
    [1, "EFF", "DOO_FULFILL_LINES_ADD_INFO", "DEPLOYED", "CTX", "Y", "N", "N", "SEG2", "ATTRIBUTE_CHAR1", 1, "Dealer", "Dealer", "TEXT", null, "N", "Y", "admin-export", now],
  ]);
  assert.equal(n, 2);
  await db.flex.replaceSnapshot("flexfields", "admin-export", [
    [1, "DFF", "AP_INVOICES", "DEPLOYED", "Global Data Elements", "Y", null, null, "SEG1", "ATTRIBUTE1", 1, "Pallet Qty", "Pallet", "TEXT", 100, "N", "Y", "admin-export", now],
  ]);
  const fc = await db.flex.flexfieldsCount();
  assert.equal(fc.total, 1, "snapshot replaced"); assert.equal(fc.dff, 1);
  assert.equal((await db.flex.queryFlexfields({ search: "pallet" }, 10)).length, 1);
  assert.equal((await db.flex.queryFlexfields({ type: "EFF" }, 10)).length, 0);
  await db.flex.replaceSnapshot("adf_extensions", "admin-export", [
    ["Ticket_c", "HZ_REF_ENTITIES", "CONTEXT", "AccountOwner_c", "EXTN_ATTRIBUTE_CHAR001", "ticket account owner", "admin-export", now],
    [null, "SVC_SERVICE_REQUESTS", null, "Grade_c", "EXTN_ATTRIBUTE_CHAR002", "grade", "admin-export", now],
  ]);
  const ac = await db.flex.adfCount();
  assert.deepEqual(ac, { total: 2, customObjects: 1, builtinTables: 1 });
  assert.equal((await db.flex.queryAdf({ object: "Ticket", objectHint: "ticket" }, 10)).length, 1);
  assert.equal((await db.flex.queryAdf({ search: "account owner", searchWords: ["account", "owner"] }, 10)).length, 1);
  const cr = await db.flex.applyConfigReport([
    { objName: "Ticket_c", isCustomObject: true, objDisplay: "Ticket", tableName: "HZ_REF_ENTITIES", fieldName: "AccountOwner_c", colName: "EXTN_ATTRIBUTE_CHAR001", fieldDisplay: "Account Owner", hintAdd: "ticket account owner", hint: "h" },
    { objName: "ServiceRequest", isCustomObject: false, objDisplay: null, tableName: "SVC_SERVICE_REQUESTS", fieldName: "RecordName", colName: "RECORD_NAME", fieldDisplay: "Plan Name", hintAdd: "plan name", hint: "record name plan name" },
  ], now);
  assert.deepEqual(cr, { displayUpdated: 1, inserted: 1 });
  const t = await db.flex.queryAdf({ object: "Ticket", objectHint: "ticket" }, 10);
  assert.equal(t[0].field_display, "Account Owner");
  assert.equal((await db.flex.adfCount()).total, 3);
});

test("layout: hash gate, replaceAll, KNN, get, count", async () => {
  assert.equal(await db.layout.jsonlHash(), null);
  const pats = Array.from({ length: 4 }, (_v, i) => ({
    id: `lp:technique:t${i}`, kind: "technique" as const, name: `T${i}`, format: "rtf" as const, dslSupport: "supported" as const,
    description: `d${i}`, whenToUse: "w", intents: ["a", "b"], recipe: { blocks: [i] }, verified: "render" as const,
  }));
  const pv = pats.map(() => [vec(), vec(), vec()]);
  assert.equal(await db.layout.replaceAll(pats, pv, "h1"), 4);
  assert.equal(await db.layout.jsonlHash(), "h1");
  assert.equal(await db.layout.count(), 4);
  const q = vec();
  const brute = pats.map((p, i) => ({ id: p.id, d: Math.min(...pv[i].map((v) => l2(q, v))) })).sort((a, b) => a.d - b.d);
  const hits = await db.layout.knn(q, 40);
  const seen = new Map<number, any>(); for (const h of hits) if (!seen.has(h.rid)) seen.set(h.rid, h);
  assert.deepEqual([...seen.values()].map((h) => h.id), brute.map((b) => b.id));
  assert.equal((await db.layout.get("lp:technique:t2"))!.recipe, JSON.stringify({ blocks: [2] }));
  assert.equal(await db.layout.get("nope"), null);
  await db.layout.replaceAll(pats.slice(0, 2), pv.slice(0, 2), "h2");
  assert.equal(await db.layout.count(), 2);
});

test("rules: upsert (insert/update), byId, forTable, list, delete", async () => {
  const r = await db.rules.upsert({ table: "doo_headers_all", kind: "grain", grain: "revision_suspect", dedup: "submitted_flag='Y'", note: "n", author: "me" }, "2026-01-01T00:00:00.000Z");
  assert.equal(r.table, "DOO_HEADERS_ALL"); assert.equal(r.enabled, true); assert.equal(r.source, "human");
  const r2 = await db.rules.upsert({ id: r.id, table: "DOO_HEADERS_ALL", kind: "grain", dedup: "x", enabled: false }, "2026-01-02T00:00:00.000Z");
  assert.equal(r2.dedup, "x"); assert.equal(r2.enabled, false); assert.equal(r2.author, "me", "COALESCE keeps author");
  assert.equal((await db.rules.forTable("DOO_HEADERS_ALL")).length, 0, "disabled rules are not served");
  assert.equal((await db.rules.list("DOO_HEADERS_ALL")).length, 1);
  assert.equal((await db.rules.list()).length, 1);
  assert.equal((await db.rules.byId(r.id))!.id, r.id);
  assert.equal(await db.rules.delete(r.id), true); assert.equal(await db.rules.delete(r.id), false);
});

test("enrich: stage/upsert/pending/setEnrichment/iterate/counts/usage/jobs", async () => {
  const e = db.enrich;
  const s = { id: "sql:h1", source: "catalog" as const, title: "R1", originalSql: "SELECT 1", sourceHash: "h1", raw: {} };
  assert.equal(await e.stage(s, { path: "/r1", index: 0 }), true);
  assert.equal(await e.stage(s, { path: "/r2", index: 0 }), false, "same SQL from a second report = reference merge");
  assert.equal((await e.get("sql:h1"))!.reports.length, 2);
  await e.upsertSource({ ...s, id: "sql:h2", sourceHash: "h2" });
  assert.equal((await e.pendingIds([s, { ...s, id: "sql:h3" }])).length, 2);
  assert.deepEqual((await e.counts()), { pending: 2, enriched: 0 });
  await e.setEnrichment("sql:h1", { cleanSql: "c", description: "d", tablesUsed: ["T"], lookupTypes: [], joins: [], filters: [], securityPredicate: null, intents: ["i"], mechanics: "m" });
  assert.deepEqual((await e.counts()), { pending: 1, enriched: 1 });
  assert.equal((await e.pendingRows())[0].id, "sql:h2");
  assert.equal((await e.all()).length, 2);
  const it: any[] = []; for await (const r of e.iterateEnriched()) it.push(r);
  assert.equal(it.length, 1); assert.deepEqual(it[0].intents, ["i"]); assert.equal(it[0].mechanics, "m");
  await e.upsertSource({ ...s, sourceHash: "changed" });
  assert.equal((await e.get("sql:h1"))!.description, null, "hash change invalidates enrichment");

  await e.recordUsage({ ts: "t", model: "gemini-flash", nItems: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, batchId: "b1" });
  await e.recordUsage({ ts: "t", model: "claude-opus-5", nItems: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal((await e.usageByModelLike("gemini%"))[0].i, 10);
  assert.equal((await e.usagePerModel()).length, 2);
  await e.clearBatchUsage("b1");
  assert.equal((await e.usageByModelLike("gemini%")).length, 0);

  const j = e.jobs;
  await j.insertBatchJob({ batchId: "mb1", model: "claude-opus-5", n: 1, submittedAt: "t", status: "in_progress" }, [{ customId: "c1", rowId: "sql:0" }]);
  assert.equal((await j.runningBatchJobs()).length, 1); assert.equal((await j.batchModel("mb1")), "claude-opus-5");
  assert.deepEqual(await j.batchItems("mb1"), [{ custom_id: "c1", row_id: "sql:0" }]);
  assert.equal((await db.corpus.reenrichQueue(["bip-report", "otbi"], 100)).some((r) => r.id === "sql:0"), false, "in-flight rows are excluded from the queue");
  await j.setBatchStatus("mb1", "ended"); await j.finishBatchJob("mb1", "t2", "ok=1");
  assert.equal((await j.finishedBatchJobs()).length, 1); assert.equal((await j.allBatchJobs()).length, 1);
  await j.insertGeminiJob({ name: "g1", model: "gemini-flash-lite-latest", n: 1, submittedAt: "t", status: "JOB_STATE_PENDING" }, [{ idx: 0, rowId: "sql:3" }]);
  assert.equal((await j.openGeminiJobs()).length, 1); assert.equal(await j.geminiModel("g1"), "gemini-flash-lite-latest");
  assert.deepEqual(await j.geminiItems("g1"), [{ idx: 0, row_id: "sql:3" }]);
  await j.setGeminiStatus("g1", "JOB_STATE_RUNNING"); await j.finishGeminiJob("g1", "ok");
  assert.equal((await j.openGeminiJobs()).length, 0); assert.equal((await j.allGeminiJobs()).length, 1);
  assert.equal(await j.getGeminiControl(), null);
  await j.setGeminiControl({ active: 1, sources: "otbi", model: "m", cap: 22, wave: 2000, batch_size: 100 });
  await j.setGeminiControl({ active: 0, sources: "otbi", model: "m", cap: 22, wave: 2000, batch_size: 100 });
  assert.equal((await j.getGeminiControl())!.active, 0);
});

test("colCache: put/get/wipe", async () => {
  const v = vec();
  await db.colCache.put([{ hash: "h1", vec: v }, { hash: "h1", vec: vec() }]);
  const got = await db.colCache.get(["h1", "h2"]);
  assert.equal(got.size, 1); assert.ok(l2(got.get("h1")!, v) < 1e-7, "first write wins (ignore on conflict)");
  await db.colCache.wipe();
  assert.equal((await db.colCache.get(["h1"])).size, 0);
});

test("tx: concurrent writers serialize (no interleaving, consistent final state)", async () => {
  const a = Array.from({ length: 150 }, (_v, i) => ({ id: `tx:${i}`, title: "t", originalSql: "s", cleanSql: "s", description: "d", tablesUsed: [], lookupTypes: [] }));
  const b = Array.from({ length: 150 }, (_v, i) => ({ id: `tx:${i + 100}`, title: "t", originalSql: "s", cleanSql: "s", description: "d", tablesUsed: [], lookupTypes: [] }));
  const before = await db.corpus.count();
  const [ra, rb] = await Promise.all([
    db.corpus.materialize(a, a.map(() => [vec()])),
    db.corpus.materialize(b, b.map(() => [vec()])),
    db.corpus.count(), db.corpus.ids(),
  ]);
  assert.equal(ra.inserted, 150); assert.equal(rb.inserted, 150);
  assert.equal(await db.corpus.count(), before + 250, "the 50 overlapping ids are replaced, never duplicated");
  await db.close();
  if (SQLITE) assert.ok(fs.existsSync(path.join(dir, "facts.sqlite")));
  else await dropScratchDbs();
});
