/**
 * Step 5 (deterministic, zero-LLM): (A) prelude — flag dynamic-lexical units as excluded_reason;
 * (B) relationships_v2 in schema.sqlite, aggregated from round-0 x_joins.
 *
 * relationships_v2 per canonical column pair (t1.c1 <-> t2.c2, alphabetized so A-B == B-A):
 *   occurrences   = DISTINCT units using this join
 *   n_view/n_otbi/n_bip = distinct-unit source split (provenance; view-joins are Oracle-authored)
 *   outer_share   = fraction of join instances that are outer joins
 *   matches_declared = 1 if a declared FK connects the same tables on the same column
 *   confidence    = >=3 units HIGH, 2 MEDIUM, 1 LOW
 * Replaces the old mined_relationships.json join tier AND drops the pk-name-guess tier. Declared FKs
 * stay separate (fkeys). Artifact aliases (XMLTABLE/DUAL/SAWITHn) and non-real tables excluded.
 *
 * Run:  docker run --rm -v /opt/fusion-catalog-v2:/app/v2 --entrypoint node \
 *         gnimsys/fusion-schema-mcp:latest /app/v2/step5_relations.mjs
 */
import Database from "better-sqlite3";

const V2 = "/app/v2";
const db = new Database(`${V2}/sqls.sqlite`);
db.pragma("journal_mode = WAL");
const sdb = new Database(`${V2}/schema.sqlite`);

// ---- (A) prelude: exclude dynamic-lexical (program-driven) units from all downstream ----
try { db.exec("ALTER TABLE sql_units ADD COLUMN excluded_reason TEXT"); } catch { /* present */ }
const flag = db.prepare(
  "UPDATE sql_units SET excluded_reason='dynamic_lexical' WHERE excluded_reason IS NULL AND id IN (SELECT DISTINCT unit_id FROM x_params WHERE kind='lexical')",
).run();
const exTot = db.prepare("SELECT COUNT(*) c FROM sql_units WHERE excluded_reason='dynamic_lexical'").get().c;
console.log(`[prelude] dynamic_lexical flagged now=${flag.changes} total=${exTot}`);

// ---- (B) relationships_v2 ----
const real = new Set(sdb.prepare("SELECT name FROM tables").all().map((r) => r.name.toUpperCase()));
const ARTIFACT = /^(XMLTABLE|DUAL|SAWITH\d+)$/;

// declared FK pairs (canonical) for matches_declared
const fkSet = new Set();
for (const f of sdb.prepare("SELECT child_table, parent_table, column_name FROM fkeys").all()) {
  let t1 = (f.child_table || "").toUpperCase(), c1 = (f.column_name || "").toUpperCase();
  let t2 = (f.parent_table || "").toUpperCase(), c2 = c1;
  if (t1 > t2 || (t1 === t2 && c1 > c2)) { [t1, c1, t2, c2] = [t2, c2, t1, c1]; }
  fkSet.add(`${t1}.${c1}|${t2}.${c2}`);
}
console.log(`[rel] declared FK pairs: ${fkSet.size}`);

const rows = db.prepare(`
  SELECT j.from_t, j.from_c, j.to_t, j.to_c, j.join_type, j.unit_id, u.source
  FROM x_joins j JOIN sql_units u ON u.id = j.unit_id
  WHERE u.excluded_reason IS NULL`).all();

const agg = new Map();
for (const r of rows) {
  let t1 = (r.from_t || "").toUpperCase(), c1 = (r.from_c || "").toUpperCase();
  let t2 = (r.to_t || "").toUpperCase(), c2 = (r.to_c || "").toUpperCase();
  if (!t1 || !t2 || ARTIFACT.test(t1) || ARTIFACT.test(t2)) continue;
  if (!real.has(t1) || !real.has(t2)) continue;
  if (t1 > t2 || (t1 === t2 && c1 > c2)) { [t1, c1, t2, c2] = [t2, c2, t1, c1]; }
  const key = `${t1}.${c1}|${t2}.${c2}`;
  let e = agg.get(key);
  if (!e) { e = { t1, c1, t2, c2, units: new Set(), v: new Set(), o: new Set(), b: new Set(), outer: 0, total: 0 }; agg.set(key, e); }
  e.units.add(r.unit_id);
  (r.source === "view" ? e.v : r.source === "otbi" ? e.o : e.b).add(r.unit_id);
  e.total++;
  if (/LEFT|RIGHT|FULL|OUTER/i.test(r.join_type || "")) e.outer++;
}

sdb.exec(`CREATE TABLE IF NOT EXISTS relationships_v2 (
  t1 TEXT, c1 TEXT, t2 TEXT, c2 TEXT,
  occurrences INTEGER, n_view INTEGER, n_otbi INTEGER, n_bip INTEGER,
  outer_share REAL, matches_declared INTEGER, confidence TEXT)`);
sdb.exec("DELETE FROM relationships_v2");
sdb.exec("CREATE INDEX IF NOT EXISTS ix_relv2_t1 ON relationships_v2(t1)");
sdb.exec("CREATE INDEX IF NOT EXISTS ix_relv2_t2 ON relationships_v2(t2)");
const ins = sdb.prepare(`INSERT INTO relationships_v2
  (t1,c1,t2,c2,occurrences,n_view,n_otbi,n_bip,outer_share,matches_declared,confidence)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0, hi = 0, matched = 0;
const tx = sdb.transaction(() => {
  for (const e of agg.values()) {
    const occ = e.units.size;
    const conf = occ >= 3 ? "HIGH" : occ === 2 ? "MEDIUM" : "LOW";
    const md = fkSet.has(`${e.t1}.${e.c1}|${e.t2}.${e.c2}`) ? 1 : 0;
    ins.run(e.t1, e.c1, e.t2, e.c2, occ, e.v.size, e.o.size, e.b.size, e.total ? e.outer / e.total : 0, md, conf);
    n++; if (conf === "HIGH") hi++; if (md) matched++;
  }
});
tx();
console.log(`[rel] relationships_v2 = ${n} edges (HIGH ${hi}), match declared FK = ${matched}`);
console.log("[rel] top 8 by occurrences:");
for (const r of sdb.prepare("SELECT t1,c1,t2,c2,occurrences,n_view,n_otbi,n_bip,confidence,matches_declared FROM relationships_v2 ORDER BY occurrences DESC LIMIT 8").all()) {
  console.log(`   ${r.t1}.${r.c1} = ${r.t2}.${r.c2}  occ=${r.occurrences} (v${r.n_view}/o${r.n_otbi}/b${r.n_bip}) ${r.confidence}${r.matches_declared ? " [declaredFK]" : ""}`);
}
sdb.close(); db.close();
