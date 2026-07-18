import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { EMBED_DIM } from "../src/corpus/embed.js";

test("getReportQuery + listQueriesForSubjectArea: exact title lookup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-"));
  const dbPath = path.join(dir, "catalog.sqlite");
  const db = new Database(dbPath); loadVec(db);
  db.exec(`CREATE TABLE tables(name TEXT PRIMARY KEY, schema TEXT, type TEXT, module TEXT, remarks TEXT, view_text TEXT);
    CREATE TABLE meta(key TEXT, value TEXT);
    CREATE TABLE columns(table_name TEXT,name TEXT,data_type TEXT,size INTEGER,nullable INTEGER,remarks TEXT,ordinal INTEGER);
    CREATE TABLE pkeys(table_name TEXT,column_name TEXT,seq INTEGER);
    CREATE TABLE fkeys(child_table TEXT,parent_table TEXT,column_name TEXT,seq INTEGER,name TEXT);
    CREATE TABLE indexes(table_name TEXT,index_name TEXT,is_unique INTEGER,ordinal INTEGER,column_name TEXT);
    CREATE TABLE relationships(from_table TEXT,from_col TEXT,to_table TEXT,to_col TEXT,evidence TEXT,occurrences INTEGER,confidence TEXT,predicate TEXT,source TEXT);
    CREATE TABLE report_queries(id TEXT,source TEXT,title TEXT,original_sql TEXT,clean_sql TEXT,
      description TEXT,tables_used TEXT,joins TEXT,filters TEXT,lookup_types TEXT,security_predicate TEXT,approved INTEGER);
    CREATE VIRTUAL TABLE report_queries_vec USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIM}]);`);
  const ins = db.prepare(`INSERT INTO report_queries(id,source,title,original_sql,clean_sql,description,tables_used,joins,filters,lookup_types) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run("otbi:SA__Contracts", "otbi", "Absence.Contracts", "SELECT c1 FROM machine", "SELECT DESCRIPTION FROM PER_CONTRACTS_F", "worker contracts", '["PER_CONTRACTS_F"]', "[]", "[]", "[]");
  ins.run("otbi:SA__Business Unit", "otbi", "Absence.Business Unit", "SELECT c1 FROM m2", "SELECT NAME FROM HR_ALL_ORGANIZATION_UNITS_F", "business units", '["HR_ALL_ORGANIZATION_UNITS_F"]', "[]", "[]", "[]");
  db.close();

  process.env.CATALOG_DB = dbPath;
  const { getReportQuery, listQueriesForSubjectArea } = await import("../src/catalog.js");

  const q = getReportQuery("Absence.Contracts") as any;
  assert.equal(q.found, true);
  assert.equal(q.originalSql, "SELECT c1 FROM machine");
  assert.match(q.cleanSql, /PER_CONTRACTS_F/);
  assert.deepEqual(q.tablesUsed, ["PER_CONTRACTS_F"]);

  const miss = getReportQuery("Absence.Contract") as any; // near-miss
  assert.equal(miss.found, false);
  assert.ok(miss.suggestions.includes("Absence.Contracts"));

  const list = listQueriesForSubjectArea("Absence");
  assert.equal(list.length, 2);
  assert.ok(list.map((x: any) => x.title).includes("Absence.Business Unit"));
});
