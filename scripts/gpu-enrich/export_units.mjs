/**
 * Export otbi+bip units for GPU round-1 enrichment: one JSONL row per unit with everything the
 * model needs (SQL + round-0 facts + table CARDS) — the model on the GPU box has no DB access.
 *
 * Exclusions (recorded, not deleted): units with lexical &PARAMs = dynamic SQL (program-driven) —
 * flagged excluded_reason='dynamic_lexical' here (the step-5 prelude), skipped from export.
 *
 * Run in WSL:
 *   docker run --rm -v /opt/fusion-catalog-v2:/app/v2 --entrypoint node \
 *     gnimsys/fusion-schema-mcp:latest /app/v2/export_units.mjs
 * Output: /opt/fusion-catalog-v2/enrich_input.jsonl  (~92k rows; gzip before scp)
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const V2 = "/app/v2";
const db = new Database(`${V2}/sqls.sqlite`);
db.pragma("journal_mode = WAL");
db.exec(`ATTACH DATABASE '${V2}/schema.sqlite' AS sv2`);

// ---- prelude: flag dynamic-lexical units (idempotent) ----
try { db.exec("ALTER TABLE sql_units ADD COLUMN excluded_reason TEXT"); } catch { /* present */ }
const flagged = db.prepare(`
  UPDATE sql_units SET excluded_reason='dynamic_lexical'
  WHERE excluded_reason IS NULL AND id IN (SELECT DISTINCT unit_id FROM x_params WHERE kind='lexical')`).run();
console.log(`[prelude] dynamic_lexical flagged now: ${flagged.changes} (total: ${
  db.prepare("SELECT COUNT(*) c FROM sql_units WHERE excluded_reason='dynamic_lexical'").get().c})`);

// ---- card lookup (remarks preferred, else generated) ----
const cardStmt = db.prepare(`
  SELECT name, type, module,
         COALESCE(NULLIF(remarks,''), description_generated) AS card, origin
  FROM sv2.tables WHERE name = ?`);
const cardCache = new Map();
function card(name) {
  if (cardCache.has(name)) return cardCache.get(name);
  const r = cardStmt.get(name);
  const c = r
    ? { name, type: r.type, module: r.module, card: (r.card ?? "").slice(0, 400), origin: r.origin }
    : { name, type: "UNKNOWN", module: null, card: "", origin: "absent" };
  cardCache.set(name, c);
  return c;
}

const qTables = db.prepare("SELECT table_name FROM x_tables WHERE unit_id=? AND is_cte=0 ORDER BY table_name");
const qJoins = db.prepare("SELECT from_t, from_c, to_t, to_c, join_type FROM x_joins WHERE unit_id=?");
const qPreds = db.prepare("SELECT seq, table_name, column_name, op, literal, found_in FROM x_predicates WHERE unit_id=? ORDER BY seq");
const qProj = db.prepare("SELECT seq, alias, source_expr FROM x_projection WHERE unit_id=? ORDER BY seq LIMIT 60");
const qBinds = db.prepare("SELECT DISTINCT name FROM x_params WHERE unit_id=? AND kind='bind'");

// artifact aliases to drop from facts (extraction noise; keep in sync with runbook)
const ARTIFACT = /^(XMLTABLE|DUAL|SAWITH\d+)$/;

// wave depth per view (built by the view-wave analysis; 0 when absent)
let depthOf = new Map();
try {
  depthOf = new Map(db.prepare("SELECT view_name, depth FROM view_waves").all().map((r) => [r.view_name, r.depth]));
  console.log(`[export] view_waves loaded: ${depthOf.size}`);
} catch { console.log("[export] no view_waves table — views default to depth 0"); }

const out = fs.createWriteStream(`${V2}/enrich_input.jsonl`);
// PHASE ORDER (processed with barriers by the client): views by wave depth FIRST — a generated
// view description becomes an overlay CARD for later waves and for otbi/bip — then otbi, then bip.
// Views not yet enriched only (semantics_json IS NULL) so a paused subscription run resumes cleanly.
const rows = db.prepare(`
  SELECT id, source, name, title, COALESCE(sql_for_parse, original_sql) AS sql, parse_quality
  FROM sql_units
  WHERE excluded_reason IS NULL AND (
          (source='view' AND (semantics_json IS NULL OR semantics_json=''))
       OR source IN ('otbi','bip-report'))
  ORDER BY CASE source WHEN 'view' THEN 0 WHEN 'otbi' THEN 1 ELSE 2 END, id`);
let n = 0;
const SQL_CLIP = { view: 40000, otbi: 12000, "bip-report": 12000 }; // views need FULL text (CE_CP lesson)
for (const u of rows.iterate()) {
  const tables = qTables.all(u.id).map((r) => r.table_name).filter((t) => !ARTIFACT.test(t));
  const clip = SQL_CLIP[u.source] ?? 12000;
  const sql = u.sql ?? "";
  const row = {
    id: u.id,
    source: u.source,
    phase: u.source === "view" ? 0 : u.source === "otbi" ? 1 : 2,
    wave: u.source === "view" ? (depthOf.get(u.name) ?? 0) : 0,
    name: u.name ?? null,
    title: u.title,
    parseQuality: u.parse_quality,
    sql: sql.slice(0, clip),
    sqlTruncated: sql.length > clip,
    tables: tables.map(card),
    joins: qJoins.all(u.id).map((j) => `${j.from_t}.${j.from_c}=${j.to_t}.${j.to_c}[${j.join_type}]`),
    predicates: qPreds.all(u.id).map((p) => ({ seq: p.seq, t: p.table_name, c: p.column_name, op: p.op, lit: p.literal, in: p.found_in })),
    projection: qProj.all(u.id).map((p) => ({ i: p.seq, a: p.alias, e: (p.source_expr ?? "").slice(0, 120) })),
    binds: qBinds.all(u.id).map((b) => b.name),
  };
  out.write(JSON.stringify(row) + "\n");
  n++;
  if (n % 10000 === 0) console.log(`[export] ${n}`);
}
out.end(() => {
  const mb = (fs.statSync(`${V2}/enrich_input.jsonl`).size / 1048576).toFixed(1);
  console.log(`[export] DONE ${n} units -> enrich_input.jsonl (${mb} MB). gzip it before scp.`);
});
