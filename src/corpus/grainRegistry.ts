/**
 * Table GRAIN registry — teaches the agent whether a table keeps ONE row per business key or
 * MULTIPLE (date-effective history, revision retention, latest-flag versions), so it stops GUESSING
 * grain and double-counting. Built from two authoritative signals, no live-data scan required:
 *
 *   1. SCHEMA columns (deterministic): a table with EFFECTIVE_START_DATE/END is date-effective
 *      (`_F` convention) -> multi-row, filter `SYSDATE BETWEEN`. A LATEST_REC_FLAG / LATEST_FLAG /
 *      CURRENT_FLAG column -> latest-flag versioned -> filter `<flag>='Y'`. OBJECT_VERSION_NUMBER
 *      alone is IGNORED (it is on ~64% of tables as optimistic locking, NOT revision retention).
 *   2. CORPUS evidence: how many real report SQLs dedup this table and with which idiom — corroborates
 *      the schema signal and surfaces real examples.
 *
 * The hard case (e.g. DOO_HEADERS_ALL retaining order revisions) has a REVISION_NUMBER /
 * SOURCE_REVISION_NUMBER column but no standard flag, and the corpus is nearly silent (only ~1 SQL
 * dedups by MAX(object_version_number)) — so those are marked `revision_suspect`: the agent must
 * VERIFY the grain (a COUNT-by-key probe) or dedup, never assert one-row-per-key.
 *
 * Managed incrementally alongside the schema: rebuildGrainRegistry() is idempotent; call it after a
 * schema/corpus refresh.
 */
import Database from "better-sqlite3";
import { reportsDbPath, schemaDbPath, sqlQuote } from "../dbPaths.js";

export type GrainType = "effective_dated" | "latest_flag" | "translation" | "revision_suspect" | "single_row";

export interface GrainHint {
  table: string;
  grain: GrainType;
  multiRow: boolean;
  dedup: string;        // the filter/idiom that picks the current row(s)
  signals: string[];    // schema columns that drove the classification
  corpusEvidence: number; // # of real report SQLs that treat this table with a dedup idiom
  note: string;
}

const EFFECTIVE_COLS = ["effective_start_date", "effective_end_date"];
const FLAG_COLS = ["latest_rec_flag", "latest_flag", "current_flag", "primary_flag"];
const REVISION_COLS = ["revision_number", "source_revision_number"];
const LANG_COL = "language"; // _TL translation tables: one row per language -> filter LANGUAGE='US' / use _VL

/** (Re)build the table_grain table from the schema `columns` + the corpus SQL. Idempotent.
 *  `d` must be a WRITABLE reports connection with schema.sqlite ATTACHed as `schemadb`
 *  (ingestStore.db() shape). */
export function rebuildGrainRegistry(d: Database.Database): { rows: number } {
  d.exec(`
    CREATE TABLE IF NOT EXISTS table_grain (
      table_name TEXT PRIMARY KEY,
      grain TEXT NOT NULL,
      multi_row INTEGER NOT NULL,
      dedup TEXT,
      signals TEXT,          -- JSON array of schema columns
      corpus_evidence INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT
    )`);

  // 1) schema signals: one pass over the attached schema columns, collect per-table the cols we care about
  type Sig = { eff: boolean; flag?: string; rev?: string; lang: boolean };
  const sig = new Map<string, Sig>();
  const wanted = new Set([...EFFECTIVE_COLS, ...FLAG_COLS, ...REVISION_COLS, LANG_COL]);
  const colRows = d.prepare("SELECT table_name, LOWER(name) AS col FROM schemadb.columns").all() as { table_name: string; col: string }[];
  for (const r of colRows) {
    if (!wanted.has(r.col)) continue;
    const s = sig.get(r.table_name) ?? { eff: false, lang: false };
    if (r.col === "effective_start_date") s.eff = true;
    else if (r.col === LANG_COL) s.lang = true;
    else if (FLAG_COLS.includes(r.col) && !s.flag) s.flag = r.col;
    else if (REVISION_COLS.includes(r.col) && !s.rev) s.rev = r.col;
    sig.set(r.table_name, s);
  }

  // 2) corpus evidence: count, per table, how many real SQLs apply a dedup idiom AND list that table.
  //    Coarse attribution (table is in tablesUsed AND the SQL uses the idiom the table's columns
  //    support) — good enough to corroborate, not to invent.
  const evidence = new Map<string, number>();
  const rq = d.prepare(
    "SELECT tables_used, clean_sql, original_sql FROM report_queries WHERE clean_sql IS NOT NULL OR original_sql IS NOT NULL",
  ).all() as { tables_used: string | null; clean_sql: string | null; original_sql: string | null }[];
  for (const q of rq) {
    const sql = ((q.clean_sql ?? "") + " " + (q.original_sql ?? "")).toLowerCase();
    const hasEff = /between[\s\S]{0,60}effective_start_date/.test(sql);
    const hasFlag = /latest_rec_flag|latest_flag|current_flag/.test(sql) && /=\s*'y'/.test(sql);
    const hasRev = /max\s*\(\s*object_version_number/.test(sql) || /source_revision_number/.test(sql);
    if (!hasEff && !hasFlag && !hasRev) continue;
    let tabs: string[] = [];
    try { tabs = (JSON.parse(q.tables_used ?? "[]") as string[]).map((t) => t.toUpperCase()); } catch { /* skip */ }
    for (const t of tabs) {
      const s = sig.get(t);
      if (!s) continue;
      if ((hasEff && s.eff) || (hasFlag && s.flag) || (hasRev && s.rev)) {
        evidence.set(t, (evidence.get(t) ?? 0) + 1);
      }
    }
  }

  // 3) classify + upsert
  const up = d.prepare(
    `INSERT INTO table_grain (table_name, grain, multi_row, dedup, signals, corpus_evidence, note, updated_at)
     VALUES (@table_name,@grain,@multi_row,@dedup,@signals,@corpus_evidence,@note,@updated_at)
     ON CONFLICT(table_name) DO UPDATE SET grain=@grain, multi_row=@multi_row, dedup=@dedup,
       signals=@signals, corpus_evidence=@corpus_evidence, note=@note, updated_at=@updated_at`);
  const now = new Date().toISOString();
  let rows = 0;
  const tx = d.transaction(() => {
    for (const [table, s] of sig) {
      const ev = evidence.get(table) ?? 0;
      const isTL = /_TL$/.test(table);
      let grain: GrainType; let dedup: string; let note: string; const signals: string[] = [];
      if (s.eff) {
        // date-effective (_F/_M); if it also carries a primary/latest flag (e.g. PER_ALL_ASSIGNMENTS_M
        // where a person has several concurrent assignments), that flag is a SECOND dedup on top.
        grain = "effective_dated"; signals.push("effective_start_date", "effective_end_date");
        dedup = "SYSDATE (or :as_of) BETWEEN effective_start_date AND effective_end_date"
          + (s.flag ? ` AND ${s.flag} = 'Y'` : "");
        note = "Date-effective table (_F/_M): KEEPS MULTIPLE rows per key across time (open row ends 4712-12-31). "
          + "Apply the BETWEEN predicate on EVERY date-tracked table in the join — a missing one MULTIPLIES."
          + (s.flag ? ` This table also has ${s.flag}: a key can have several concurrent current rows — add ${s.flag}='Y' to pick one.` : "");
        if (s.flag) signals.push(s.flag);
      } else if (isTL) {
        // Only the _TL BASE translation tables multiply per language. _VL views already filter the
        // session language (they ARE the fix) and a bare `language` column on a base table is an
        // attribute, not a grain multiplier — so neither is flagged.
        grain = "translation"; signals.push("_TL"); if (s.lang) signals.push("language");
        dedup = "LANGUAGE = 'US' (or 'USERENV') — or use the sibling _VL view which filters language automatically";
        note = "Translation table (_TL): one row PER INSTALLED LANGUAGE per id. Filter LANGUAGE or join the _VL view, else counts inflate by the number of languages.";
      } else if (s.flag) {
        grain = "latest_flag"; signals.push(s.flag);
        dedup = `${s.flag} = 'Y'`;
        note = `Versioned table: keeps history; the current/primary row is flagged by ${s.flag}='Y'.`;
      } else if (s.rev) {
        grain = "revision_suspect"; signals.push(s.rev);
        dedup = "VERIFY grain (COUNT(*) GROUP BY <business key> HAVING COUNT(*)>1); if multi-row, keep the current revision via MAX(object_version_number) OVER (PARTITION BY <key>)";
        note = `Has ${s.rev} but no standard latest-flag and the corpus rarely dedups it. MAY retain revisions (like DOO_HEADERS_ALL keeping every order revision). Do NOT assume one-row-per-key — verify.`;
      } else {
        continue; // only object_version_number etc. -> not a grain signal, skip
      }
      up.run({ table_name: table, grain, multi_row: 1, dedup, signals: JSON.stringify(signals), corpus_evidence: ev, note, updated_at: now });
      rows++;
    }
  });
  tx();
  return { rows };
}

/** Grain hint for one table (case-insensitive). Returns single_row default when not flagged. */
export function getTableGrain(reports: Database.Database, table: string): GrainHint {
  const r = reports.prepare(
    "SELECT table_name, grain, multi_row, dedup, signals, corpus_evidence, note FROM table_grain WHERE table_name = ?",
  ).get(table.toUpperCase()) as any;
  if (!r) {
    return {
      table: table.toUpperCase(), grain: "single_row", multiRow: false, dedup: "",
      signals: [], corpusEvidence: 0,
      note: "No versioning/effective-date/revision signal — treat as one row per business key (default).",
    };
  }
  return {
    table: r.table_name, grain: r.grain, multiRow: !!r.multi_row, dedup: r.dedup,
    signals: JSON.parse(r.signals ?? "[]"), corpusEvidence: r.corpus_evidence, note: r.note,
  };
}

export function grainRegistryCount(reports: Database.Database): number {
  try { return (reports.prepare("SELECT COUNT(*) c FROM table_grain").get() as any).c; } catch { return 0; }
}

// Bump when the classification logic changes so a redeploy rebuilds the registry.
const GRAIN_VERSION = 3;

/** Startup helper: open a writable reports connection with schema ATTACHed and (re)build the registry
 *  when it's empty, the logic version changed, or force=true. Idempotent; safe to call on every boot. */
export function ensureGrainRegistry(force = false): { built: boolean; rows: number } {
  const d = new Database(reportsDbPath());
  try {
    d.exec(`ATTACH DATABASE '${sqlQuote(schemaDbPath())}' AS schemadb`);
    d.exec("CREATE TABLE IF NOT EXISTS grain_meta (k TEXT PRIMARY KEY, v TEXT)");
    const ver = (d.prepare("SELECT v FROM grain_meta WHERE k='version'").get() as any)?.v;
    const have = grainRegistryCount(d);
    if (have > 0 && ver === String(GRAIN_VERSION) && !force) return { built: false, rows: have };
    const r = rebuildGrainRegistry(d);
    d.prepare("INSERT INTO grain_meta (k,v) VALUES ('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(GRAIN_VERSION));
    return { built: true, rows: r.rows };
  } finally {
    d.close();
  }
}
