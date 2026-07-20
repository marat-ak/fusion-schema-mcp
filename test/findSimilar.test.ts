import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed, EMBED_DIM } from "../src/corpus/embed.js";

// nearest candidate whether the result came back ambiguous (candidates) or not (matches)
function top(res: any) {
  return res.ambiguous ? res.candidates?.[0] : res.matches?.[0];
}

// One shared catalog for the whole file: catalog.ts binds its DB handle at module-eval time
// from CATALOG_DB, so we seed once and import once.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-"));
const dbPath = path.join(dir, "catalog.sqlite");

const DOCS = [
  { id: "a", source: "catalog", desc: "unpaid supplier invoices older than 90 days from AP_INVOICES_ALL", tables: ["AP_INVOICES_ALL", "AP_SUPPLIERS"] },
  { id: "b", source: "catalog", desc: "employee absence leave donation balances", tables: ["PER_ALL_PEOPLE_F", "ANC_PER_ACRL_ENTRY"] },
  // only source:"otbi" row — exercises the over-fetch-then-filter path.
  { id: "c", source: "otbi", desc: "purchase order approval history for procurement buyers", tables: ["PO_HEADERS_ALL", "POZ_SUPPLIERS_V"] },
  { id: "fin", source: "catalog", desc: "department segment of the chart of accounts budget balances", tables: ["GL_SEG_VAL_HIER_CF", "FND_VS_TYPED_VALUES_VL"] },
  { id: "hcm", source: "catalog", desc: "department org unit headcount of employees", tables: ["HR_ALL_ORGANIZATION_UNITS_F", "PER_ALL_ASSIGNMENTS_M"] },
  // sub-ledger ambiguity pair: same word "invoice", AP vs AR
  { id: "ap-inv", source: "catalog", desc: "supplier invoice aging outstanding amounts report", tables: ["AP_INVOICES_ALL", "AP_INVOICE_PAYMENTS_ALL"] },
  { id: "ar-inv", source: "catalog", desc: "customer invoice aging outstanding amounts report", tables: ["RA_CUSTOMER_TRX_ALL", "AR_PAYMENT_SCHEDULES_ALL"] },
];

test("seed the shared catalog", async () => {
  const db = new Database(dbPath); loadVec(db);
  db.exec(`CREATE TABLE tables(name TEXT PRIMARY KEY, schema TEXT, type TEXT, module TEXT, remarks TEXT, view_text TEXT);
    CREATE TABLE meta(key TEXT, value TEXT);
    CREATE TABLE columns(table_name TEXT, name TEXT, data_type TEXT, size INTEGER, nullable INTEGER, remarks TEXT, ordinal INTEGER);
    CREATE TABLE pkeys(table_name TEXT, column_name TEXT, seq INTEGER);
    CREATE TABLE fkeys(child_table TEXT, parent_table TEXT, column_name TEXT, seq INTEGER, name TEXT);
    CREATE TABLE indexes(table_name TEXT, index_name TEXT, is_unique INTEGER, ordinal INTEGER, column_name TEXT);
    CREATE TABLE relationships(from_table TEXT, from_col TEXT, to_table TEXT, to_col TEXT, evidence TEXT, occurrences INTEGER, confidence TEXT, predicate TEXT, source TEXT);
    CREATE TABLE report_queries(id TEXT,source TEXT,title TEXT,original_sql TEXT,clean_sql TEXT,
      description TEXT,tables_used TEXT,joins TEXT,filters TEXT,lookup_types TEXT,security_predicate TEXT,approved INTEGER);
    CREATE VIRTUAL TABLE report_queries_vec USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIM}]);`);
  const vecs = await embed(DOCS.map((d) => d.desc));
  DOCS.forEach((d, i) => {
    db.prepare("INSERT INTO report_queries(rowid,id,source,title,description,clean_sql,tables_used,joins,filters,lookup_types) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(BigInt(i + 1), d.id, d.source, d.id, d.desc, `SELECT * FROM ${d.tables[0]}`,
           JSON.stringify(d.tables), "[]", "[]", "[]");
    db.prepare("INSERT INTO report_queries_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(i + 1), Buffer.from(vecs[i].buffer));
  });
  db.close();
  process.env.CATALOG_DB = dbPath;
});

test("ranks the semantically closest row first, and source filter over-fetches", async () => {
  const { findSimilarQueries } = await import("../src/catalog.js");

  const res = await findSimilarQueries("which suppliers have invoices past due 90 days", { limit: 1 });
  assert.equal(top(res).id, "a", "closest row ranks first regardless of ambiguity");

  // source-filtered search must still return a row even though "c" is not the global nearest.
  const srcRes: any = await findSimilarQueries("which suppliers have invoices past due 90 days", { source: "otbi", limit: 1 });
  // otbi corpus has a single domain (Procurement) -> unambiguous, returns matches.
  assert.equal(srcRes.ambiguous, false);
  assert.equal(srcRes.matches.length, 1, "source-filtered search should still return a row");
  assert.equal(srcRes.matches[0].source, "otbi");
  assert.equal(srcRes.matches[0].id, "c");
});

test("domain filter returns only that domain's rows, WITH clean SQL", async () => {
  const { findSimilarQueries } = await import("../src/catalog.js");
  const res: any = await findSimilarQueries("department headcount by org", { domain: "HCM", limit: 5 });
  assert.equal(res.ambiguous, false);
  assert.equal(res.domain, "HCM");
  assert.ok(res.matches.length >= 1, "at least one HCM row");
  for (const m of res.matches) {
    assert.equal(m.domain, "HCM", "only HCM rows returned");
    assert.ok(m.cleanSql, "domain-targeted result includes clean SQL");
  }
});

test("'invoice' splits AP vs AR (sub-domain ambiguity), resolvable via domain:'AP'", async () => {
  const { findSimilarQueries } = await import("../src/catalog.js");

  const res: any = await findSimilarQueries("invoice aging outstanding amounts report", { limit: 2 });
  assert.equal(res.ambiguous, true, "AP vs AR near-tied pair must be flagged ambiguous");
  assert.ok(res.candidates.every((c: any) => !("cleanSql" in c)), "no SQL leaked while ambiguous");
  const doms = res.domainBreakdown.map((b: any) => b.domain);
  assert.ok(doms.includes("Financials/AP") && doms.includes("Financials/AR"),
    `breakdown names both sub-ledgers, got: ${doms}`);

  // sub-domain shorthand "AP" resolves the split and returns full SQL
  const ap: any = await findSimilarQueries("invoice aging outstanding amounts report", { domain: "AP", limit: 5 });
  assert.equal(ap.ambiguous, false);
  assert.ok(ap.matches.length >= 1, "at least one AP row");
  for (const m of ap.matches) {
    assert.equal(m.domain, "Financials/AP", "only AP rows returned");
    assert.ok(m.cleanSql, "resolved result includes clean SQL");
  }
});
