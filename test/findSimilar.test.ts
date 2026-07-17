import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed, EMBED_DIM } from "../src/corpus/embed.js";

test("findSimilarQueries ranks the semantically closest row first, and source filter over-fetches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-"));
  const dbPath = path.join(dir, "catalog.sqlite");
  const db = new Database(dbPath); loadVec(db);
  // minimal tables the query layer touches
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
  const docs = [
    { id: "a", source: "catalog", desc: "unpaid supplier invoices older than 90 days from AP_INVOICES_ALL" },
    { id: "b", source: "catalog", desc: "employee absence leave donation balances" },
    // seeded so it is NOT the global nearest neighbor to the query intent below, but is the
    // only row with source:"otbi" — exercises the over-fetch-then-filter fix (Fix 2).
    { id: "c", source: "otbi", desc: "purchase order approval history for procurement buyers" },
  ];
  const vecs = await embed(docs.map((d) => d.desc));
  docs.forEach((d, i) => {
    db.prepare("INSERT INTO report_queries(rowid,id,source,title,description,clean_sql,tables_used,joins,filters,lookup_types) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(BigInt(i + 1), d.id, d.source, d.id, d.desc, "SELECT 1", "[]", "[]", "[]", "[]");
    db.prepare("INSERT INTO report_queries_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(i + 1), Buffer.from(vecs[i].buffer));
  });
  db.close();

  process.env.CATALOG_DB = dbPath;
  const { findSimilarQueries } = await import("../src/catalog.js");

  const res = await findSimilarQueries("which suppliers have invoices past due 90 days", { limit: 1 });
  assert.equal(res[0].id, "a");

  // source-filtered search must still return a row even though "c" is not the global nearest.
  const srcRes = await findSimilarQueries("which suppliers have invoices past due 90 days", { source: "otbi", limit: 1 });
  assert.equal(srcRes.length, 1, "source-filtered search should still return a row");
  assert.equal(srcRes[0].source, "otbi");
  assert.equal(srcRes[0].id, "c");
});
