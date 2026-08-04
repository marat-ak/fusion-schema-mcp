/**
 * DFF/EFF flexfield registry — the customer-admin-provided mapping from business names
 * ("Pallet Qty", context "Tama Australia Cotton File") to physical bindings (flexfield_code,
 * context_code, ATTRIBUTE_CHARn column, value set). Source of truth for resolving EFF contexts
 * WITHOUT guessing and without needing pod access (works offline).
 *
 * Storage: a plain `flexfields` table in reports.sqlite (the writable per-stack DB). No vectors —
 * this is an exact registry; lookups are indexed equality/LIKE, not semantic search. Loading is
 * snapshot-replace per `source` ('admin-export' | 'datamodel-mined' | 'pod-live'): a new admin
 * upload fully replaces the previous admin snapshot.
 *
 * Expected CSV columns (the standard FND_DF_FLEXFIELDS_B/FND_DF_CONTEXTS_B/FND_DF_SEGMENTS_VL
 * export; header names case-insensitive): APPLICATION_ID, FLEXFIELD_TYPE, FLEXFIELD_CODE,
 * DEPLOYMENT_STATUS, CONTEXT_CODE, CONTEXT_ENABLED_FLAG, MULTIROW_FLAG, TRANSLATABLE_FLAG,
 * SEGMENT_CODE, COLUMN_NAME, SEQUENCE_NUMBER, SEGMENT_NAME, PROMPT, DISPLAY_TYPE, VALUE_SET_ID,
 * REQUIRED_FLAG, SEGMENT_ENABLED_FLAG.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { reportsDbPath } from "../dbPaths.js";

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const path = reportsDbPath();
  if (!fs.existsSync(path)) throw new Error(`reports DB not found at ${path} (provision or migrate first).`);
  const d = new Database(path);
  d.pragma("busy_timeout = 10000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS flexfields (
      application_id   INTEGER,
      flexfield_type   TEXT NOT NULL,          -- 'DFF' | 'EFF'
      flexfield_code   TEXT NOT NULL,          -- e.g. DOO_FULFILL_LINES_ADD_INFO, AP_INVOICES
      deployment_status TEXT,
      context_code     TEXT NOT NULL,
      context_enabled  TEXT,
      multirow         TEXT,                   -- EFF only
      translatable     TEXT,                   -- EFF only
      segment_code     TEXT NOT NULL,
      column_name      TEXT,                   -- ATTRIBUTE_CHAR2 / GLOBAL_ATTRIBUTE1 / ...
      sequence_number  INTEGER,
      segment_name     TEXT,
      prompt           TEXT,
      display_type     TEXT,
      value_set_id     INTEGER,
      required         TEXT,
      segment_enabled  TEXT,
      source           TEXT NOT NULL DEFAULT 'admin-export',
      loaded_at        TEXT NOT NULL,
      UNIQUE(flexfield_type, application_id, flexfield_code, context_code, segment_code, source)
    );
    CREATE INDEX IF NOT EXISTS idx_flex_code    ON flexfields(flexfield_code);
    CREATE INDEX IF NOT EXISTS idx_flex_context ON flexfields(context_code);
    CREATE INDEX IF NOT EXISTS idx_flex_column  ON flexfields(column_name);
  `);
  _db = d;
  return d;
}

const norm = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const toInt = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** Parse the registry CSV and snapshot-replace all rows of `source`. */
export function loadFlexfieldsCsv(csvText: string, source = "admin-export"): { rows: number; dff: number; eff: number } {
  const records: Record<string, string>[] = parse(csvText, {
    columns: (h: string[]) => h.map((c) => c.trim().toUpperCase()),
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  if (!records.length) throw new Error("CSV parsed to 0 rows");
  const required = ["FLEXFIELD_TYPE", "FLEXFIELD_CODE", "CONTEXT_CODE", "SEGMENT_CODE"];
  for (const col of required) {
    if (!(col in records[0])) throw new Error(`CSV missing expected column ${col}`);
  }

  const d = db();
  const now = new Date().toISOString();
  const ins = d.prepare(`
    INSERT OR REPLACE INTO flexfields
      (application_id, flexfield_type, flexfield_code, deployment_status, context_code,
       context_enabled, multirow, translatable, segment_code, column_name, sequence_number,
       segment_name, prompt, display_type, value_set_id, required, segment_enabled, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let dff = 0, eff = 0, rows = 0;
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM flexfields WHERE source = ?").run(source);
    for (const r of records) {
      const type = (norm(r.FLEXFIELD_TYPE) ?? "").toUpperCase();
      const code = norm(r.FLEXFIELD_CODE);
      const ctx = norm(r.CONTEXT_CODE);
      const seg = norm(r.SEGMENT_CODE);
      if (!type || !code || !ctx || !seg) continue; // truncated/garbage line
      ins.run(
        toInt(r.APPLICATION_ID), type, code, norm(r.DEPLOYMENT_STATUS), ctx,
        norm(r.CONTEXT_ENABLED_FLAG), norm(r.MULTIROW_FLAG), norm(r.TRANSLATABLE_FLAG),
        seg, norm(r.COLUMN_NAME), toInt(r.SEQUENCE_NUMBER),
        norm(r.SEGMENT_NAME), norm(r.PROMPT), norm(r.DISPLAY_TYPE),
        toInt(r.VALUE_SET_ID), norm(r.REQUIRED_FLAG), norm(r.SEGMENT_ENABLED_FLAG),
        source, now,
      );
      rows++;
      if (type === "DFF") dff++; else if (type === "EFF") eff++;
    }
  });
  tx();
  return { rows, dff, eff };
}

export interface FlexQuery {
  /** flexfield_code exact (case-insensitive) OR a base-table-ish name; %LIKE% both ways. */
  flexfieldCode?: string;
  /** context_code, %LIKE% case-insensitive. */
  context?: string;
  /** free text over segment_name / prompt / segment_code / context_code / flexfield_code. */
  search?: string;
  type?: "DFF" | "EFF";
  limit?: number;
}

/** Registry lookup: grouped by flexfield_code + context, segments ordered by sequence. */
export function queryFlexfields(q: FlexQuery): unknown {
  const d = db();
  const cond: string[] = [];
  const bind: unknown[] = [];
  if (q.type) { cond.push("flexfield_type = ?"); bind.push(q.type.toUpperCase()); }
  if (q.flexfieldCode) { cond.push("UPPER(flexfield_code) LIKE UPPER(?)"); bind.push(`%${q.flexfieldCode}%`); }
  if (q.context) { cond.push("UPPER(context_code) LIKE UPPER(?)"); bind.push(`%${q.context}%`); }
  if (q.search) {
    cond.push("(UPPER(coalesce(segment_name,'') || ' ' || coalesce(prompt,'') || ' ' || segment_code || ' ' || context_code || ' ' || flexfield_code) LIKE UPPER(?))");
    bind.push(`%${q.search}%`);
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const rows = d.prepare(
    `SELECT * FROM flexfields ${where} ORDER BY flexfield_type, flexfield_code, context_code, sequence_number LIMIT ${limit}`,
  ).all(...bind) as any[];

  // group: flexfield -> context -> segments
  const out = new Map<string, any>();
  for (const r of rows) {
    const fk = `${r.flexfield_type}:${r.flexfield_code}`;
    if (!out.has(fk)) out.set(fk, { flexfieldType: r.flexfield_type, flexfieldCode: r.flexfield_code, applicationId: r.application_id, contexts: new Map<string, any>() });
    const f = out.get(fk);
    if (!f.contexts.has(r.context_code)) {
      f.contexts.set(r.context_code, {
        contextCode: r.context_code, enabled: r.context_enabled, multirow: r.multirow, segments: [],
      });
    }
    f.contexts.get(r.context_code).segments.push({
      name: r.segment_name, prompt: r.prompt, code: r.segment_code, column: r.column_name,
      seq: r.sequence_number, displayType: r.display_type, valueSetId: r.value_set_id, required: r.required,
    });
  }
  const flexfields = [...out.values()].map((f) => ({ ...f, contexts: [...f.contexts.values()] }));
  return { matched: rows.length, truncated: rows.length >= limit, flexfields };
}

export function flexfieldsCount(): { total: number; dff: number; eff: number; sources: unknown } {
  const d = db();
  try {
    const total = (d.prepare("SELECT COUNT(*) c FROM flexfields").get() as any).c;
    const dff = (d.prepare("SELECT COUNT(*) c FROM flexfields WHERE flexfield_type='DFF'").get() as any).c;
    const eff = (d.prepare("SELECT COUNT(*) c FROM flexfields WHERE flexfield_type='EFF'").get() as any).c;
    const sources = d.prepare("SELECT source, COUNT(*) c, MAX(loaded_at) loaded_at FROM flexfields GROUP BY source").all();
    return { total, dff, eff, sources };
  } catch {
    return { total: 0, dff: 0, eff: 0, sources: [] };
  }
}
