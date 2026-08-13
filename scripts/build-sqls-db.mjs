/**
 * Build sqls.sqlite (the v2 corpus store) from:
 *   - schema-v2  (/app/v2/schema.sqlite)      -> view units (SQL = decoded view_text, feed-#1 truth)
 *   - old corpus (/app/old/reports.sqlite RO) -> otbi + bip units verbatim + carried enrichment;
 *                                                also carries old view enrichment onto the view units.
 *
 * Decode policy (locked): only VIEW SQL is entity-decoded (systemic contamination); otbi/bip text is
 * copied byte-for-byte (bip "entities" are string literals inside REPLACE() — must not be touched).
 *
 * Run inside the fusion-schema-mcp image:
 *   docker run --rm -v /opt/fusion-catalog-v2:/app/v2 -v /opt/fusion-catalog-test:/app/old:ro \
 *     --entrypoint node gnimsys/fusion-schema-mcp:latest /app/v2/build-sqls-db.mjs
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const V2_DIR = "/app/v2";
const SCHEMA_V2 = `${V2_DIR}/schema.sqlite`;
// Snapshot copy made by the orchestrator (plain rw-capable file inside the v2 workspace —
// ATTACH-with-URI-readonly fails on a :ro bind mount, and we never touch v1 directly).
const OLD_REPORTS = `${V2_DIR}/_old_reports_snapshot.sqlite`;
const OUT = `${V2_DIR}/sqls.sqlite`;

// Same decode as src/xmlEntities.ts (script is standalone inside the container).
function decodeXmlEntities(s) {
  if (!s || s.indexOf("&") === -1) return s;
  return s
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

if (!fs.existsSync(SCHEMA_V2)) throw new Error(`schema-v2 missing at ${SCHEMA_V2}`);
if (!fs.existsSync(OLD_REPORTS)) throw new Error(`old reports missing at ${OLD_REPORTS}`);
if (fs.existsSync(OUT)) fs.rmSync(OUT);

const db = new Database(OUT);
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");
db.exec(`ATTACH DATABASE '${SCHEMA_V2}' AS sv2`);
// Separate READ connection to the old-corpus snapshot: better-sqlite3 forbids writing on a
// connection while an iterator/cursor is open on it, so reads (old) and writes (new) are split.
const oldDb = new Database(OLD_REPORTS, { readonly: true });

db.exec(`
  CREATE TABLE sql_units (
    id TEXT PRIMARY KEY,           -- view:NAME | sql:<hash> (old ids preserved)
    source TEXT NOT NULL,          -- view | otbi | bip-report
    name TEXT,                     -- view name (views only)
    title TEXT,
    original_sql TEXT,
    clean_sql TEXT,                -- gemini-cleaned (carried; analysis/compare)
    sql_for_parse TEXT,            -- what round-0 parses: view_text (views) / original_sql (rest)
    parse_quality TEXT,            -- NULL until extracted: full | full_lex | fallback | failed
    parse_error TEXT,
    -- carried enrichment (paid; verbatim from old corpus)
    description TEXT,
    description_generated TEXT,    -- views: filled by step-6 ordered enrichment (A/B)
    intents TEXT,
    mechanics TEXT,
    embedding BLOB,
    reports TEXT,
    -- old extraction fields, carried ONLY for calibration of round-0 (never served)
    tables_used_old TEXT,
    joins_old TEXT,
    filters_old TEXT,
    security_predicate_old TEXT
  );
  CREATE TABLE x_tables     (unit_id TEXT, table_name TEXT, is_cte INTEGER DEFAULT 0);
  CREATE TABLE x_columns    (unit_id TEXT, table_name TEXT, column_name TEXT, context TEXT);
  CREATE TABLE x_joins      (unit_id TEXT, from_t TEXT, from_c TEXT, to_t TEXT, to_c TEXT, join_type TEXT);
  CREATE TABLE x_predicates (unit_id TEXT, seq INTEGER, table_name TEXT, column_name TEXT, op TEXT, literal TEXT, found_in TEXT);
  CREATE TABLE x_params     (unit_id TEXT, name TEXT, kind TEXT);
  CREATE TABLE x_projection (unit_id TEXT, seq INTEGER, alias TEXT, source_expr TEXT);
  CREATE INDEX ix_xt ON x_tables(unit_id);      CREATE INDEX ix_xt_n ON x_tables(table_name);
  CREATE INDEX ix_xc ON x_columns(unit_id);
  CREATE INDEX ix_xj ON x_joins(unit_id);
  CREATE INDEX ix_xp ON x_predicates(unit_id);  CREATE INDEX ix_xp_t ON x_predicates(table_name);
  CREATE INDEX ix_xpar ON x_params(unit_id);
  CREATE INDEX ix_xproj ON x_projection(unit_id);
`);

const ins = db.prepare(`
  INSERT INTO sql_units (id, source, name, title, original_sql, clean_sql, sql_for_parse,
    description, description_generated, intents, mechanics, embedding, reports,
    tables_used_old, joins_old, filters_old, security_predicate_old)
  VALUES (@id,@source,@name,@title,@original_sql,@clean_sql,@sql_for_parse,
    @description,NULL,@intents,@mechanics,@embedding,@reports,
    @tables_used_old,@joins_old,@filters_old,@security_predicate_old)`);

// ---- 1) views: truth = schema-v2 view_text (compile already decoded it); carry old enrichment ----
const oldViewByName = new Map(
  oldDb.prepare(`SELECT title, clean_sql, description, intents, mechanics, embedding, reports,
                     tables_used, joins, filters, security_predicate
              FROM report_queries WHERE source='view'`).all().map((r) => [r.title, r]),
);
const views = db.prepare(
  `SELECT name, view_text FROM sv2.tables WHERE type='VIEW' AND view_text IS NOT NULL AND view_text <> ''`,
).all();
let vNew = 0, vCarried = 0;
const txV = db.transaction(() => {
  for (const v of views) {
    const o = oldViewByName.get(v.name);
    if (o) vCarried++; else vNew++;
    ins.run({
      id: `view:${v.name}`, source: "view", name: v.name, title: v.name,
      original_sql: v.view_text,
      clean_sql: o ? decodeXmlEntities(o.clean_sql) : null,   // view rows: decode is safe+required
      sql_for_parse: v.view_text,
      description: o?.description ?? null,
      intents: o?.intents ?? null, mechanics: o?.mechanics ?? null,
      embedding: o?.embedding ?? null, reports: o?.reports ?? null,
      tables_used_old: o?.tables_used ?? null, joins_old: o?.joins ?? null,
      filters_old: o?.filters ?? null, security_predicate_old: o?.security_predicate ?? null,
    });
  }
});
txV();
console.log(`views: ${views.length} units (enrichment carried for ${vCarried}, new/unenriched ${vNew})`);
const orphans = [...oldViewByName.keys()].filter(
  (n) => !views.some((v) => v.name === n),
).length;
if (orphans) console.log(`note: ${orphans} old corpus views have no view_text in schema-v2 (not loaded)`);

// ---- 2) otbi + bip: verbatim copy (NO decode — see header) ----
// rowid-paginated reads on oldDb; writes batched on db — no cursor open across a write.
let n2 = 0;
const readBatch = oldDb.prepare(
  `SELECT rowid AS rid, id, source, title, original_sql, clean_sql, description, intents, mechanics,
          embedding, reports, tables_used, joins, filters, security_predicate
   FROM report_queries WHERE source IN ('otbi','bip-report') AND rowid > ?
   ORDER BY rowid LIMIT 2000`,
);
const txR = db.transaction((chunk) => {
  for (const r of chunk) {
    ins.run({
      id: r.id, source: r.source, name: null, title: r.title,
      original_sql: r.original_sql, clean_sql: r.clean_sql,
      sql_for_parse: r.original_sql ?? r.clean_sql,
      description: r.description, intents: r.intents, mechanics: r.mechanics,
      embedding: r.embedding, reports: r.reports,
      tables_used_old: r.tables_used, joins_old: r.joins, filters_old: r.filters,
      security_predicate_old: r.security_predicate,
    });
    n2++;
  }
});
let lastRid = 0;
for (;;) {
  const chunk = readBatch.all(lastRid);
  if (!chunk.length) break;
  txR(chunk);
  lastRid = chunk[chunk.length - 1].rid;
}
console.log(`otbi+bip: ${n2} units carried verbatim`);

const stats = db.prepare("SELECT source, COUNT(*) c, SUM(description IS NOT NULL) enr FROM sql_units GROUP BY source").all();
for (const s of stats) console.log(`  ${s.source}: units=${s.c} withDescription=${s.enr}`);

oldDb.close();
db.exec("DETACH DATABASE sv2");
db.pragma("journal_mode = WAL");
db.exec("VACUUM"); db.exec("ANALYZE");
db.close();
console.log(`DONE -> ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
