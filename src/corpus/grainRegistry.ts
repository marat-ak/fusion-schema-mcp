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
 * schema/corpus refresh. Storage: `db().registries` (kind "grain").
 */
import { db, type GrainRegistryRow } from "../db/index.js";

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

/** (Re)build the table_grain registry from the schema `columns` + the corpus SQL. Idempotent. */
export async function rebuildGrainRegistry(): Promise<{ rows: number }> {
  // 1) schema signals: one pass over the schema columns, collect per-table the cols we care about
  type Sig = { eff: boolean; flag?: string; rev?: string; lang: boolean };
  const sig = new Map<string, Sig>();
  const wanted = new Set([...EFFECTIVE_COLS, ...FLAG_COLS, ...REVISION_COLS, LANG_COL]);
  const colRows = await db().schema.columnSignals();
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
  const rq = await db().corpus.rowsForGrain();
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

  // 3) classify + replace
  const now = new Date().toISOString();
  const rows: GrainRegistryRow[] = [];
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
    rows.push({ table_name: table, grain, multi_row: 1, dedup, signals: JSON.stringify(signals), corpus_evidence: ev, note, updated_at: now });
  }
  return db().registries.replaceAll("grain", rows);
}

/** Grain hint for one table (case-insensitive). Returns single_row default when not flagged. */
export async function getTableGrain(table: string): Promise<GrainHint> {
  const r = await db().registries.grain(table.toUpperCase());
  if (!r) {
    return {
      table: table.toUpperCase(), grain: "single_row", multiRow: false, dedup: "",
      signals: [], corpusEvidence: 0,
      note: "No versioning/effective-date/revision signal — treat as one row per business key (default).",
    };
  }
  return {
    table: r.table_name, grain: r.grain as GrainType, multiRow: !!r.multi_row, dedup: r.dedup ?? "",
    signals: JSON.parse(r.signals ?? "[]"), corpusEvidence: r.corpus_evidence, note: r.note ?? "",
  };
}

// Bump when the classification logic changes so a redeploy rebuilds the registry.
const GRAIN_VERSION = 4;

/** Startup helper: (re)build the registry when it's empty, the logic version changed, or force=true.
 *  Idempotent; safe to call on every boot. */
export async function ensureGrainRegistry(force = false): Promise<{ built: boolean; rows: number }> {
  const ver = await db().registries.version("grain");
  const have = await db().registries.count("grain");
  if (have > 0 && ver === String(GRAIN_VERSION) && !force) return { built: false, rows: have };
  const r = await rebuildGrainRegistry();
  await db().registries.setVersion("grain", String(GRAIN_VERSION));
  return { built: true, rows: r.rows };
}
