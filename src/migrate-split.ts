/**
 * One-shot migration: legacy catalog.sqlite  ->  schema.sqlite + reports.sqlite.
 *
 * The running deployment's ~1.4G catalog.sqlite holds schema + otbi/view + polled bip-report rows
 * that CANNOT be recompiled (the polled+enriched corpus lives only there). This splits it into the
 * two files the new layout expects, READ-ONLY on the source (never modified).
 *
 *  - schema tables  -> schema.sqlite (+ version meta from the VERSION file)
 *  - report_queries* -> reports.sqlite, backfilling report_queries.embedding from report_queries_vec
 *    (read each rowid's vector from vec0, store as a BLOB) so future vec rebuilds need no re-embed.
 *
 * Run:  node dist/migrate-split.js [<catalog.sqlite>] [--schema <out>] [--reports <out>]
 * Env:  CATALOG_DB (source, if arg omitted) · SCHEMA_DB / REPORTS_DB (outputs).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { SCHEMA_DB, REPORTS_DB, sqlQuote } from "./dbPaths.js";
import { EMBED_DIM } from "./corpus/embed.js";
import { readVersionFile } from "./version.js";

function log(m: string) { console.error(`[migrate-split] ${m}`); }
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SRC =
  process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : (process.env.CATALOG_DB ?? "catalog.sqlite");
const SCHEMA_OUT = argVal("--schema") ?? SCHEMA_DB;
const REPORTS_OUT = argVal("--reports") ?? REPORTS_DB;

function buildSchema() {
  log(`building schema.sqlite from ${SRC} ...`);
  const s = new Database(SCHEMA_OUT);
  s.pragma("journal_mode = OFF");
  s.pragma("synchronous = OFF");
  s.pragma("temp_store = MEMORY");
  s.exec(`
    CREATE TABLE tables (
      name TEXT PRIMARY KEY, schema TEXT, type TEXT, module TEXT, remarks TEXT, view_text TEXT
    );
    CREATE TABLE columns (
      table_name TEXT, name TEXT, data_type TEXT, size INTEGER, nullable INTEGER, remarks TEXT, ordinal INTEGER
    );
    CREATE TABLE pkeys (table_name TEXT, column_name TEXT, seq INTEGER);
    CREATE TABLE fkeys (child_table TEXT, parent_table TEXT, column_name TEXT, seq INTEGER, name TEXT);
    CREATE TABLE indexes (table_name TEXT, index_name TEXT, is_unique INTEGER, ordinal INTEGER, column_name TEXT);
    CREATE TABLE relationships (
      from_table TEXT, from_col TEXT, to_table TEXT, to_col TEXT,
      evidence TEXT, occurrences INTEGER, confidence TEXT, predicate TEXT, source TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  s.exec(`ATTACH DATABASE '${sqlQuote(SRC)}' AS src`);
  const copy = (t: string, cols: string) => {
    s.exec(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM src.${t}`);
  };
  copy("tables", "name, schema, type, module, remarks, view_text");
  copy("columns", "table_name, name, data_type, size, nullable, remarks, ordinal");
  copy("pkeys", "table_name, column_name, seq");
  copy("fkeys", "child_table, parent_table, column_name, seq, name");
  copy("indexes", "table_name, index_name, is_unique, ordinal, column_name");
  copy("relationships", "from_table, from_col, to_table, to_col, evidence, occurrences, confidence, predicate, source");

  s.exec(`
    CREATE INDEX idx_columns_table ON columns(table_name);
    CREATE INDEX idx_columns_name ON columns(name);
    CREATE INDEX idx_pkeys_table ON pkeys(table_name);
    CREATE INDEX idx_fkeys_child ON fkeys(child_table);
    CREATE INDEX idx_fkeys_parent ON fkeys(parent_table);
    CREATE INDEX idx_indexes_table ON indexes(table_name);
    CREATE INDEX idx_rel_from ON relationships(from_table);
    CREATE INDEX idx_rel_to ON relationships(to_table);
    CREATE VIRTUAL TABLE tables_fts USING fts5(name, remarks, module, content='');
  `);
  s.exec(`INSERT INTO tables_fts (rowid, name, remarks, module)
          SELECT rowid, name, COALESCE(remarks,''), COALESCE(module,'') FROM tables;`);

  // Carry the source meta forward, then stamp/refresh the version keys.
  const insMeta = s.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const srcMeta = s.prepare("SELECT key, value FROM src.meta").all() as { key: string; value: string }[];
  const mtx = s.transaction(() => { for (const r of srcMeta) insMeta.run(r.key, r.value); });
  mtx();
  const V = readVersionFile();
  insMeta.run("schema_version", V.schema);
  insMeta.run("queries_version", V.queries);
  insMeta.run("embedding_version", V.embedding);

  s.exec("DETACH DATABASE src");
  s.pragma("journal_mode = DELETE");
  s.exec("VACUUM");
  s.close();
  log(`schema.sqlite done -> ${SCHEMA_OUT}`);
}

function buildReports() {
  log(`building reports.sqlite from ${SRC} ...`);
  // Two connections (not ATTACH): read report_queries_vec from the source MAIN connection and write
  // report_queries_vec on the dest MAIN connection — vec0 KNN/IO is unreliable over an attached DB.
  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  loadVec(src);
  const r = new Database(REPORTS_OUT);
  loadVec(r);
  r.pragma("journal_mode = OFF");
  r.pragma("synchronous = OFF");
  r.pragma("temp_store = MEMORY");
  r.exec(`
    CREATE TABLE report_queries (
      id TEXT PRIMARY KEY, source TEXT, title TEXT,
      original_sql TEXT, clean_sql TEXT, description TEXT,
      tables_used TEXT, joins TEXT, filters TEXT, lookup_types TEXT,
      security_predicate TEXT, approved INTEGER, reports TEXT, embedding BLOB
    );
    CREATE VIRTUAL TABLE report_queries_fts USING fts5(title, description, tables_used, content='');
    CREATE VIRTUAL TABLE report_queries_vec USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIM}]);
  `);

  const cols = new Set((src.prepare("PRAGMA table_info(report_queries)").all() as any[]).map((c) => c.name));
  const has = (c: string) => cols.has(c);
  const sel = src.prepare(`
    SELECT q.rowid AS rowid, q.id, q.source, q.title, q.original_sql, q.clean_sql, q.description,
           q.tables_used, q.joins, q.filters, q.lookup_types, q.security_predicate, q.approved,
           ${has("reports") ? "q.reports" : "NULL"} AS reports,
           ${has("embedding") ? "q.embedding" : "NULL"} AS embedding,
           v.embedding AS vec
    FROM report_queries q
    LEFT JOIN report_queries_vec v ON v.rowid = q.rowid`);

  const insRq = r.prepare(`
    INSERT INTO report_queries
      (rowid, id, source, title, original_sql, clean_sql, description,
       tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding)
    VALUES (@rowid,@id,@source,@title,@original_sql,@clean_sql,@description,
            @tables_used,@joins,@filters,@lookup_types,@security_predicate,@approved,@reports,@embedding)`);
  const insFts = r.prepare("INSERT INTO report_queries_fts (rowid, title, description, tables_used) VALUES (?,?,?,?)");
  const insVec = r.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");

  let n = 0, backfilled = 0, withVec = 0;
  let batch: any[] = [];
  const flush = () => {
    if (!batch.length) return;
    const chunk = batch; batch = [];
    const tx = r.transaction(() => {
      for (const row of chunk) {
        // Prefer an existing embedding blob; else backfill it from the vec0 vector.
        let emb: Buffer | null = null;
        if (row.embedding) emb = Buffer.from(row.embedding);
        else if (row.vec) { emb = Buffer.from(row.vec); backfilled++; }
        insRq.run({
          rowid: BigInt(row.rowid), id: row.id, source: row.source, title: row.title,
          original_sql: row.original_sql, clean_sql: row.clean_sql, description: row.description,
          tables_used: row.tables_used, joins: row.joins, filters: row.filters,
          lookup_types: row.lookup_types, security_predicate: row.security_predicate,
          approved: row.approved ?? 1, reports: row.reports ?? "[]", embedding: emb,
        });
        let tu = "";
        try { const a = JSON.parse(row.tables_used ?? "[]"); tu = Array.isArray(a) ? a.join(" ") : ""; } catch { /* */ }
        insFts.run(BigInt(row.rowid), row.title, row.description, tu);
        if (emb) { insVec.run(BigInt(row.rowid), emb); withVec++; }
      }
    });
    tx();
  };
  for (const row of sel.iterate() as Iterable<any>) { batch.push(row); n++; if (batch.length >= 512) flush(); }
  flush();

  r.pragma("journal_mode = DELETE");
  r.exec("VACUUM");
  r.exec("ANALYZE");
  r.close();
  src.close();
  log(`reports.sqlite done -> ${REPORTS_OUT} (rows=${n}, vec=${withVec}, embedding backfilled=${backfilled})`);
}

function main() {
  if (!fs.existsSync(SRC)) { console.error(`[migrate-split] source ${SRC} not found`); process.exit(1); }
  for (const f of [SCHEMA_OUT, REPORTS_OUT]) {
    if (fs.existsSync(f)) fs.rmSync(f);
    fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
  }
  buildSchema();
  buildReports();
  log("migration complete");
}

main();
