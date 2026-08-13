// Import the GPU-enrichment outputs into a SERVING catalog (reports.sqlite/report_queries + vec/FTS),
// reusing the EXISTING corpus writer (ingestStore.materialize: embeds description+intents, writes row +
// single vec + multi vec, replace-by-id). Runs INSIDE the fusion-schema-mcp image so dist/ + bge-small +
// sqlite-vec are present:
//
//   docker run --rm --network host \
//     -v /opt/fusion-catalog-v2:/app/data -v /root/enrich-run:/work -w /work \
//     -e DATA_DIR=/app/data [-e SOURCES=view,bip-report] [-e PRUNE=1] \
//     --entrypoint node gnimsys/fusion-schema-mcp:latest /work/import_serving.mjs
//
// Inputs (run dir /work): sqls.sqlite (sql_units + x_tables/x_joins + unit_aliases), enrich_output.*.jsonl.
// Target (/app/data): reports.sqlite — a COPY of the v1 serving DB (never the live v1 file itself!).
// Idempotent: re-running replaces the same ids. Run again after otbi round-2 lands with SOURCES=otbi.
import fs from "node:fs";
import path from "node:path";
import Database from "/app/node_modules/better-sqlite3/lib/index.js";
import { load as loadVec } from "/app/node_modules/sqlite-vec/index.mjs";

process.env.DATA_DIR = process.env.DATA_DIR || "/app/data";
const { materialize } = await import("/app/dist/corpus/ingestStore.js");

// embed.ts unref()s its worker thread (fine under the long-lived server; fatal in a one-shot script:
// the event loop drains at the first embed await and Node exits "unsettled"). Pin the loop open.
const keepAlive = setInterval(() => {}, 1 << 30);

const WORK = process.env.WORK_DIR || "/work";
const SQLS = path.join(WORK, "sqls.sqlite");
const REPORTS = path.join(process.env.DATA_DIR, "reports.sqlite");
const SOURCES = (process.env.SOURCES || "view,bip-report,otbi").split(",").map(s => s.trim()).filter(Boolean);
const PRUNE = process.env.PRUNE !== "0";      // remove stale rows of the imported sources (old alias-id copies)
const CHUNK = 200;

// ---- gather build-side meta ------------------------------------------------------------------
const b = new Database(SQLS, { readonly: true });
const meta = new Map();                        // id -> {source,title,original_sql,clean_sql}
for (const r of b.prepare("SELECT id,source,title,original_sql,COALESCE(clean_sql,sql_for_parse,original_sql) AS clean_sql FROM sql_units WHERE excluded_reason IS NULL").iterate())
  meta.set(r.id, r);
// parser artifacts leak into x_tables with is_cte=0 on giant truncated SQLs (4,067 SAWITH rows) — same
// filter the export pipeline applies (export_wave.py ARTIFACT), extended with TABLE\d+ derived-table names.
const ARTIFACT = /^(XMLTABLE|DUAL|SAWITH\d+|TABLE\d+)$/i;
const tablesBy = new Map();                    // id -> [table,...]
for (const r of b.prepare("SELECT unit_id,table_name FROM x_tables WHERE is_cte=0").iterate()) {
  if (ARTIFACT.test(r.table_name || "")) continue;
  if (!tablesBy.has(r.unit_id)) tablesBy.set(r.unit_id, new Set());
  tablesBy.get(r.unit_id).add(r.table_name);
}
const joinsBy = new Map();                     // id -> ["A.b=C.d[type]",...]
for (const r of b.prepare("SELECT unit_id,from_t,from_c,to_t,to_c,join_type FROM x_joins").iterate()) {
  if (!joinsBy.has(r.unit_id)) joinsBy.set(r.unit_id, []);
  joinsBy.get(r.unit_id).push(`${r.from_t}.${r.from_c}=${r.to_t}.${r.to_c}[${r.join_type}]`);
}
let aliases = [];
try { aliases = b.prepare("SELECT alias_id,unit_id,title,subject_area,source FROM unit_aliases").all(); } catch { /* pre-dedup DB */ }
const aliasTitlesBy = new Map();
for (const a of aliases) {
  if (!aliasTitlesBy.has(a.unit_id)) aliasTitlesBy.set(a.unit_id, []);
  aliasTitlesBy.get(a.unit_id).push(a.title);
}

// ---- newest ok result per id from the output jsonls ------------------------------------------
const files = fs.readdirSync(WORK).filter(f => /^enrich_output\..*\.jsonl$/.test(f) && !/round1/.test(f)).sort();
const results = new Map();                     // id -> result (later files/lines win; ok only)
for (const f of files) {
  for (const line of fs.readFileSync(path.join(WORK, f), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o?.ok || !o?.result) continue;
    const m = meta.get(o.id);
    if (!m || !SOURCES.includes(m.source)) continue;
    results.set(o.id, o.result);
  }
}
if (process.env.ONLY_IDS) {                    // targeted re-materialize (e.g. artifact-pollution repair): newline-separated id file
  const want = new Set(fs.readFileSync(process.env.ONLY_IDS, "utf-8").split("\n").map(s => s.trim()).filter(Boolean));
  for (const id of [...results.keys()]) if (!want.has(id)) results.delete(id);
  console.log(`[import] ONLY_IDS: restricted to ${results.size} ids`);
}
console.log(`[import] sources=${SOURCES.join(",")} candidate results=${results.size} (files: ${files.join(", ")})`);

// ---- semantics -> compact mechanics digest (served alongside description/intents) -------------
function mechanicsOf(res) {
  const out = [];
  for (const s of res.security || []) out.push(`security(${s.mechanism}${s.sessionDependent ? ",session" : ""}): seq ${(s.predicateSeqs || []).join(",")}`);
  for (const c of res.currentRow || []) out.push(`currentRow: ${c.meaning} (seq ${(c.predicateSeqs || []).join(",")})`);
  for (const g of res.grainHandling || []) out.push(`grain ${g.table}: ${g.method}`);
  for (const d0 of res.dateLogic || []) out.push(`date: ${d0.pattern}${d0.detail ? " — " + d0.detail : ""}`);
  for (const fx of res.flexfield || []) out.push(`flexfield ${fx.table}${fx.contextCode ? " @" + fx.contextCode : ""}${fx.meaning ? ": " + fx.meaning : ""}`);
  for (const p of res.params || []) out.push(`param :${p.name}${p.purpose ? " — " + p.purpose : ""}`);
  if (res.outputGrain) out.push(`output grain: ${res.outputGrain}`);
  return out.length ? out.join("\n") : null;
}
const lowConf = (res) => ((res.missingRemarks || []).length > 0) || res.tablesConfirmed === false || ((res.qualityFlags || []).length > 0);

// ---- prune stale rows of the imported sources (old per-path alias ids etc.) -------------------
const s = new Database(REPORTS);
s.pragma("busy_timeout = 10000");
loadVec(s);                                    // vec0 vtables (report_queries_vec*) need the extension on THIS connection too
if (PRUNE) {
  const keep = new Set(results.keys());
  let pruned = 0;
  // bulk prune: per-row vec0 deletes are far too slow (74k rows never finished in 100 min) — stage the
  // stale rowids in a temp table and let three bulk DELETEs do it inside one transaction.
  s.exec("CREATE TEMP TABLE stale_rowids(rowid INTEGER PRIMARY KEY)");
  const insStale = s.prepare("INSERT INTO stale_rowids(rowid) VALUES (?)");
  const del = s.transaction(() => {
    for (const src of SOURCES) {
      const stale = s.prepare("SELECT rowid,id FROM report_queries WHERE source=?").all(src)
                     .filter(r => !keep.has(r.id));
      for (const r of stale) insStale.run(r.rowid);
      pruned += stale.length;
    }
    s.exec("DELETE FROM report_queries_vec WHERE rowid IN (SELECT rowid FROM stale_rowids)");
    try { s.exec("DELETE FROM report_queries_vec_multi WHERE qrowid IN (SELECT rowid FROM stale_rowids)"); } catch {}
    s.exec("DELETE FROM report_queries WHERE rowid IN (SELECT rowid FROM stale_rowids)");
  });
  del();
  s.exec("DROP TABLE stale_rowids");
  console.log(`[import] pruned ${pruned} stale rows of ${SOURCES.join(",")}`);
}
// additive columns (serving code ignores them until a reader exists) + alias pointer table
try { s.exec("ALTER TABLE report_queries ADD COLUMN semantics_json TEXT"); } catch {}
try { s.exec("ALTER TABLE report_queries ADD COLUMN low_confidence INTEGER"); } catch {}
s.exec(`CREATE TABLE IF NOT EXISTS unit_aliases(
  alias_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, title TEXT, subject_area TEXT, source TEXT);
  CREATE INDEX IF NOT EXISTS ix_unit_aliases_unit ON unit_aliases(unit_id)`);
if (aliases.length) {
  const ins = s.prepare("INSERT OR REPLACE INTO unit_aliases(alias_id,unit_id,title,subject_area,source) VALUES (?,?,?,?,?)");
  const tx = s.transaction(() => { for (const a of aliases) ins.run(a.alias_id, a.unit_id, a.title, a.subject_area, a.source); });
  tx();
  console.log(`[import] unit_aliases: ${aliases.length} path pointers`);
}
s.close();                                     // materialize opens its own writable connection

// ---- feed the EXISTING writer in chunks -------------------------------------------------------
const rows = [];
for (const [id, res] of results) {
  const m = meta.get(id);
  const paths = aliasTitlesBy.get(id) || [];
  rows.push({
    id, source: m.source, title: m.title || res.titleHuman || id,
    originalSql: m.original_sql || "", cleanSql: res.rewrittenSql || m.clean_sql || m.original_sql || "",
    description: res.description || "",
    tablesUsed: [...(tablesBy.get(id) || [])].sort(),
    joins: joinsBy.get(id) || [],
    filters: [], lookupTypes: [],
    securityPredicate: null,
    reports: paths.slice(0, 50),               // path pointers (full set lives in unit_aliases)
    intents: res.intents || [], mechanics: mechanicsOf(res),
  });
}
let done = 0, replacedTot = 0;
for (let i = 0; i < rows.length; i += CHUNK) {
  const r = await materialize(rows.slice(i, i + CHUNK));
  done += r.inserted; replacedTot += r.replaced;
  if ((i / CHUNK) % 10 === 0) console.log(`[import] materialized ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}
console.log(`[import] materialize done: inserted=${done} (replaced ${replacedTot})`);

// ---- post-pass: additive enrichment columns + FTS rebuild ------------------------------------
const s2 = new Database(REPORTS);
s2.pragma("busy_timeout = 10000");
loadVec(s2);
const upd = s2.prepare("UPDATE report_queries SET semantics_json=?, low_confidence=? WHERE id=?");
const tx2 = s2.transaction(() => {
  for (const [id, res] of results) upd.run(JSON.stringify(res), lowConf(res) ? 1 : 0, id);
});
tx2();
// contentless FTS5 (title, description, tables_used) — rebuilt whole, matches compile.ts shape
s2.exec("INSERT INTO report_queries_fts(report_queries_fts) VALUES('delete-all')");
s2.exec("INSERT INTO report_queries_fts(rowid,title,description,tables_used) SELECT rowid,title,description,tables_used FROM report_queries");
const counts = s2.prepare("SELECT source, COUNT(*) n, SUM(low_confidence) lc FROM report_queries GROUP BY source ORDER BY n DESC").all();
console.log("[import] serving corpus now:", counts.map(c => `${c.source}=${c.n}(lowConf ${c.lc ?? 0})`).join("  "));
try {   // vec0 tables need the sqlite-vec extension (loaded in materialize's connection, not this plain one)
  console.log("[import] vec rows:", s2.prepare("SELECT COUNT(*) n FROM report_queries_vec").get().n,
              " multi:", s2.prepare("SELECT COUNT(*) n FROM report_queries_vec_multi").get().n);
} catch { console.log("[import] vec counts skipped (vec0 ext not loaded here — vectors written by materialize)"); }
console.log("[import] fts:", s2.prepare("SELECT COUNT(*) n FROM report_queries_fts").get().n);
// ---- LAST STEP: table-level corpus stats from the round-0 facts (all SQLs now imported) -------
// mostlyUsedFilters source: table_predicates rebuilt DIRECTLY from x_predicates — no regex round-trip,
// NO skip-lists (pseudocolumns, every op, every literal count; the agent judges relevance, not us).
// mostlyUsedJoinFilters source: table_join_columns — column PARTICIPATION share in join conditions
// (exact pairs fragment: the same EFFECTIVE_START_DATE joins different columns in different tables).
const DISCRIMINATOR_MIN_DISTINCT = 8;          // mirrors predicateMiner role semantics (read-path compat)
const JOIN_SHARE_MIN = 0.20;                   // surface columns joined in >=20% of the table's queries
{
  const preds = new Map();                     // table\0col\0op\0lit -> Set(unit)
  for (const r of b.prepare("SELECT unit_id,table_name,column_name,op,COALESCE(literal,'(non-literal)') AS lit FROM x_predicates").iterate()) {
    const k = `${r.table_name}\0${r.column_name}\0${r.op}\0${String(r.lit).slice(0, 80)}`;
    if (!preds.has(k)) preds.set(k, new Set());
    preds.get(k).add(r.unit_id);
  }
  const perCol = new Map();                    // table\0col -> distinct literal count (role classification)
  for (const k of preds.keys()) {
    const [t, c] = k.split("\0");
    const ck = `${t}\0${c}`;
    perCol.set(ck, (perCol.get(ck) ?? 0) + 1);
  }
  const unitsByTable = new Map();              // table -> Set(unit) (denominator for shares)
  for (const r of b.prepare("SELECT unit_id,table_name FROM x_tables WHERE is_cte=0").iterate()) {
    if (!unitsByTable.has(r.table_name)) unitsByTable.set(r.table_name, new Set());
    unitsByTable.get(r.table_name).add(r.unit_id);
  }
  const joins = new Map();                     // table\0col -> Set(unit)  (both sides of every join pair)
  for (const r of b.prepare("SELECT unit_id,from_t,from_c,to_t,to_c FROM x_joins").iterate()) {
    for (const [t, c] of [[r.from_t, r.from_c], [r.to_t, r.to_c]]) {
      if (!t || !c) continue;
      const k = `${t}\0${c}`;
      if (!joins.has(k)) joins.set(k, new Set());
      joins.get(k).add(r.unit_id);
    }
  }
  const s3 = new Database(REPORTS);
  s3.pragma("busy_timeout = 15000");
  s3.exec(`CREATE TABLE IF NOT EXISTS table_predicates (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL, op TEXT NOT NULL, literal TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'structural');
    CREATE INDEX IF NOT EXISTS ix_table_predicates ON table_predicates(table_name);
    CREATE TABLE IF NOT EXISTS table_join_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL,
      units INTEGER NOT NULL, share REAL NOT NULL, PRIMARY KEY (table_name, column_name));
    CREATE INDEX IF NOT EXISTS ix_table_join_columns ON table_join_columns(table_name)`);
  const insP = s3.prepare("INSERT INTO table_predicates(table_name,column_name,op,literal,occurrences,role) VALUES (?,?,?,?,?,?)");
  const insJ = s3.prepare("INSERT OR REPLACE INTO table_join_columns(table_name,column_name,units,share) VALUES (?,?,?,?)");
  let np = 0, nj = 0;
  const tx3 = s3.transaction(() => {
    s3.exec("DELETE FROM table_predicates");
    for (const [k, units] of preds) {
      const [t, c, op, lit] = k.split("\0");
      const role = (perCol.get(`${t}\0${c}`) ?? 1) >= DISCRIMINATOR_MIN_DISTINCT ? "discriminator" : "structural";
      insP.run(t, c, op, lit, units.size, role);
      np++;
    }
    s3.exec("DELETE FROM table_join_columns");
    for (const [k, units] of joins) {
      const [t, c] = k.split("\0");
      const denom = unitsByTable.get(t)?.size ?? 0;
      if (!denom) continue;
      const share = units.size / denom;
      if (share >= JOIN_SHARE_MIN) { insJ.run(t, c, units.size, Math.round(share * 1000) / 1000); nj++; }
    }
  });
  tx3();
  console.log(`[import] rollups: table_predicates=${np} rows (${new Set([...preds.keys()].map(k => k.split("\0")[0])).size} tables), table_join_columns=${nj} rows (share>=${JOIN_SHARE_MIN})`);
  s3.close();
}
b.close();
clearInterval(keepAlive);
console.log("[import] DONE");
process.exit(0);   // the unref'd embed worker may still idle — exit explicitly
