/**
 * Import round-1 GPU output back into sqls.sqlite with validation gates.
 * Gates (drop/flag, never trust blindly):
 *   - JSON well-formed + required keys (guided_json should guarantee; verify anyway)
 *   - every predicateSeq referenced exists in x_predicates for that unit
 *   - every table named in security/grainHandling/flexfield/missing/extra is sane (uppercase word)
 *   - missingTables aggregated into a convergence report (round-2 input)
 * Writes: sql_units.semantics_json (FULL v3.1 JSON), description_v2, needs_review; paid v1 fields untouched.
 *
 * Run in WSL after scp'ing enrich_output.jsonl to /opt/fusion-catalog-v2/:
 *   docker run --rm -v /opt/fusion-catalog-v2:/app/v2 --entrypoint node \
 *     gnimsys/fusion-schema-mcp:latest /app/v2/import_validate.mjs
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import readline from "node:readline";

const V2 = "/app/v2";
const db = new Database(`${V2}/sqls.sqlite`);
db.pragma("journal_mode = WAL");
// schema.sqlite opened WRITABLE too: view descriptions land there (tables.description_generated).
const sdb = new Database(`${V2}/schema.sqlite`);

try { db.exec("ALTER TABLE sql_units ADD COLUMN semantics_json TEXT"); } catch { /* present */ }
try { db.exec("ALTER TABLE sql_units ADD COLUMN description_v2 TEXT"); } catch { /* present */ }
try { db.exec("ALTER TABLE sql_units ADD COLUMN needs_review INTEGER DEFAULT 0"); } catch { /* present */ }
try { sdb.exec("ALTER TABLE tables ADD COLUMN description_generated TEXT"); } catch { /* present */ }
try { sdb.exec("ALTER TABLE tables ADD COLUMN origin TEXT DEFAULT 'dictionary'"); } catch { /* present */ }
const updView = sdb.prepare("UPDATE tables SET description_generated=? WHERE name=? AND type='VIEW'");
const nameOf = new Map(db.prepare("SELECT id, name FROM sql_units WHERE source='view'").all().map((r) => [r.id, r.name]));

const seqSet = new Map(); // unit -> Set(seq)
function seqsFor(uid) {
  if (!seqSet.has(uid)) {
    seqSet.set(uid, new Set(db.prepare("SELECT seq FROM x_predicates WHERE unit_id=?").all(uid).map((r) => r.seq)));
  }
  return seqSet.get(uid);
}

const REQ = ["description", "intents", "titleHuman", "tags", "domain", "outputGrain",
  "tablesConfirmed", "missingTables", "extraTables", "security", "currentRow", "language",
  "grainHandling", "dateLogic", "flexfield", "plsqlFunctions", "computedColumns", "qualityFlags", "params"];
const TN = /^[A-Z][A-Z0-9_$#.]{1,63}$/;

const upd = db.prepare("UPDATE sql_units SET semantics_json=?, description_v2=?, needs_review=? WHERE id=?");
const missingAgg = new Map(); // table -> {units: count}
let ok = 0, flagged = 0, badJson = 0, errRows = 0, seqViol = 0;

const rl = readline.createInterface({ input: fs.createReadStream(`${V2}/enrich_output.jsonl`) });
const tx = [];
for await (const line of rl) {
  let rec;
  try { rec = JSON.parse(line); } catch { badJson++; continue; }
  if (!rec.ok) { errRows++; continue; }
  const r = rec.result;
  let review = 0;
  const notes = [];

  for (const k of REQ) if (!(k in r)) { notes.push(`missing key ${k}`); review = 1; }
  if (typeof r.description !== "string" || r.description.split(/[.!?]\s/).length < 3) { notes.push("description <3 sentences"); review = 1; }
  if (!Array.isArray(r.intents) || r.intents.length < 3) { notes.push("intents <3"); review = 1; }

  const seqs = seqsFor(rec.id);
  for (const fam of ["security", "currentRow", "language", "grainHandling"]) {
    for (const item of r[fam] ?? []) {
      for (const s of item.predicateSeqs ?? []) {
        if (!seqs.has(s)) { seqViol++; notes.push(`${fam} bad seq ${s}`); review = 1; }
      }
    }
  }
  for (const fam of ["missingTables", "extraTables"]) {
    r[fam] = (r[fam] ?? []).filter((t) => TN.test(String(t).toUpperCase()));
  }
  if (r.missingTables.length || r.extraTables.length || r.tablesConfirmed === false) review = 1;
  for (const t of r.missingTables) {
    const k = String(t).toUpperCase();
    missingAgg.set(k, (missingAgg.get(k) ?? 0) + 1);
  }
  if (notes.length) r._reviewNotes = notes;

  tx.push([JSON.stringify(r), r.description ?? null, review, rec.id]);
  // view descriptions ALSO land on the schema side (searchTables FTS picks them up at rebuild)
  if (rec.source === "view") {
    const nm = nameOf.get(rec.id);
    if (nm && r.description) updView.run(r.description, nm);
  }
  review ? flagged++ : ok++;
  if (tx.length >= 2000) { const t = db.transaction((rows) => rows.forEach((a) => upd.run(...a))); t(tx); tx.length = 0; }
}
if (tx.length) { const t = db.transaction((rows) => rows.forEach((a) => upd.run(...a))); t(tx); }
sdb.close();

fs.writeFileSync(`${V2}/convergence_missing.json`, JSON.stringify(
  [...missingAgg.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ table: t, units: c })), null, 2));

console.log(`[import] ok=${ok} flagged=${flagged} llmErrRows=${errRows} badJson=${badJson} seqViolations=${seqViol}`);
console.log(`[import] distinct missingTables=${missingAgg.size} -> convergence_missing.json (round-2 input)`);
console.log(`[import] coverage: ${db.prepare("SELECT COUNT(*) c FROM sql_units WHERE source IN ('otbi','bip-report') AND excluded_reason IS NULL AND semantics_json IS NOT NULL").get().c} / ${db.prepare("SELECT COUNT(*) c FROM sql_units WHERE source IN ('otbi','bip-report') AND excluded_reason IS NULL").get().c}`);
