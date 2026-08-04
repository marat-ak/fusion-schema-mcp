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

// ─────────────────────────── ADF extensions (CRM/CX custom objects & fields) ───────────────────────────
// Second registry, same lifecycle: the admin exports adf_extension_column_usage ⋈ adf_extension_column
// ⋈ adf_extensible_table ⋈ adf_extensible_table_usage. Two shapes in one file:
//  - OBJECT_NAME set  -> a CUSTOM OBJECT stored in a GENERIC table (TABLE_NAME, e.g. HZ_REF_ENTITIES):
//    rows filtered by CONTEXT_COLUMN_NAME = OBJECT_NAME; field ATTRIBUTE_NAME lives in COLUMN_NAME.
//  - OBJECT_NAME null -> a CUSTOM FIELD on a BUILT-IN object: TABLE_NAME is that object's dedicated
//    extension table (e.g. SVC_SERVICE_REQUESTS); no context filter; ATTRIBUTE_NAME -> COLUMN_NAME.

function ensureAdf(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS adf_extensions (
      object_name         TEXT,               -- NULL => custom field on the built-in object
      table_name          TEXT NOT NULL,      -- generic store (custom object) or dedicated ext table
      context_column_name TEXT,               -- filter column when object_name is set
      attribute_name      TEXT NOT NULL,      -- business field name (usually *_c)
      column_name         TEXT NOT NULL,      -- EXTN_ATTRIBUTE_* physical column
      display_hint        TEXT,               -- de-camelized human words for fuzzy lookup
      source              TEXT NOT NULL DEFAULT 'admin-export',
      loaded_at           TEXT NOT NULL,
      UNIQUE(object_name, table_name, attribute_name, column_name, source)
    );
    CREATE INDEX IF NOT EXISTS idx_adf_object ON adf_extensions(object_name);
    CREATE INDEX IF NOT EXISTS idx_adf_table  ON adf_extensions(table_name);
    CREATE INDEX IF NOT EXISTS idx_adf_attr   ON adf_extensions(attribute_name);
  `);
  try { d.exec("ALTER TABLE adf_extensions ADD COLUMN display_hint TEXT"); } catch { /* already present */ }
  try { d.exec("ALTER TABLE adf_extensions ADD COLUMN object_display TEXT"); } catch { /* already present */ }
  try { d.exec("ALTER TABLE adf_extensions ADD COLUMN field_display TEXT"); } catch { /* already present */ }
}

/** API name -> searchable human words: TicketContact_c -> "ticket contact";
 *  ServiceRequest_Id_Return_to_Work -> "service request id return to work". Users say display
 *  names, not *_c API names — the registry export carries only API names, so this derived field
 *  is what free-text search matches against. */
export function displayHint(apiName: string): string {
  return apiName
    .replace(/_+c$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Parse the ADF-extensions CSV (OBJECT_NAME, TABLE_NAME, CONTEXT_COLUMN_NAME, ATTRIBUTE_NAME,
 *  COLUMN_NAME) and snapshot-replace all rows of `source`. */
export function loadAdfExtensionsCsv(csvText: string, source = "admin-export"): { rows: number; customObjects: number; builtinExtensions: number } {
  const records: Record<string, string>[] = parse(csvText, {
    columns: (h: string[]) => h.map((c) => c.trim().toUpperCase()),
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  if (!records.length) throw new Error("CSV parsed to 0 rows");
  for (const col of ["TABLE_NAME", "ATTRIBUTE_NAME", "COLUMN_NAME"]) {
    if (!(col in records[0])) throw new Error(`CSV missing expected column ${col}`);
  }
  const d = db();
  ensureAdf(d);
  const now = new Date().toISOString();
  const ins = d.prepare(`
    INSERT OR REPLACE INTO adf_extensions
      (object_name, table_name, context_column_name, attribute_name, column_name, display_hint, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  let rows = 0;
  const objects = new Set<string>();
  const builtinTables = new Set<string>();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM adf_extensions WHERE source = ?").run(source);
    for (const r of records) {
      const table = norm(r.TABLE_NAME);
      const attr = norm(r.ATTRIBUTE_NAME);
      const col = norm(r.COLUMN_NAME);
      if (!table || !attr || !col) continue;
      const obj = norm(r.OBJECT_NAME);
      const hint = `${obj ? displayHint(obj) + " " : ""}${displayHint(attr)}`;
      ins.run(obj, table, norm(r.CONTEXT_COLUMN_NAME), attr, col, hint, source, now);
      rows++;
      if (obj) objects.add(obj); else builtinTables.add(table);
    }
  });
  tx();
  return { rows, customObjects: objects.size, builtinExtensions: builtinTables.size };
}

// ── App Composer Configuration Report (XML) — the DISPLAY-NAME source ──────────────────────────
// Setup and Maintenance -> Application Composer -> Configuration Report exports one XML with every
// custom object and field INCLUDING human display names (objectDisplayName / field displayName),
// plus tableName and columnName. Merge strategy: UPDATE display names onto existing registry rows
// (matched by object+attribute, or attribute+column for std-object custom fields), then INSERT
// rows the ADF export didn't have (e.g. OOTB fields like RecordName "Plan Name") as
// source='config-report'. display_hint gains the lowercased display names so searches match the
// words users actually say.

function xmlTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() || null : null;
}

export function loadConfigReportXml(xml: string): {
  objects: number; fields: number; displayUpdated: number; inserted: number;
} {
  const d = db();
  ensureAdf(d);
  const now = new Date().toISOString();
  const updByObj = d.prepare(`
    UPDATE adf_extensions SET object_display = ?, field_display = ?,
      display_hint = coalesce(display_hint,'') || ' ' || ?
    WHERE object_name = ? AND attribute_name = ?
  `);
  const updByCol = d.prepare(`
    UPDATE adf_extensions SET field_display = ?,
      display_hint = coalesce(display_hint,'') || ' ' || ?
    WHERE object_name IS NULL AND attribute_name = ? AND column_name = ?
  `);
  const ins = d.prepare(`
    INSERT OR REPLACE INTO adf_extensions
      (object_name, table_name, context_column_name, attribute_name, column_name,
       display_hint, object_display, field_display, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  let objects = 0, fields = 0, displayUpdated = 0, inserted = 0;
  const objBlocks = xml.split(/<CustomizedObject>/).slice(1).map((b) => b.split("</CustomizedObject>")[0]);
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM adf_extensions WHERE source = 'config-report'").run();
    for (const ob of objBlocks) {
      const objName = xmlTag(ob, "objectName");
      if (!objName) continue;
      objects++;
      const objDisplay = xmlTag(ob, "objectDisplayName");
      const objType = xmlTag(ob, "objectType"); // Custom | Standard
      const tableName = xmlTag(ob, "tableName");
      const isCustomObject = (objType ?? "").toLowerCase() === "custom";
      const fieldBlocks = ob.split(/<CustomField>/).slice(1).map((b) => b.split("</CustomField>")[0]);
      for (const fb of fieldBlocks) {
        const fieldName = xmlTag(fb, "fieldName");
        const colName = xmlTag(fb, "columnName");
        if (!fieldName) continue;
        fields++;
        const fieldDisplay = xmlTag(fb, "displayName");
        const hintAdd = `${(objDisplay ?? "").toLowerCase()} ${(fieldDisplay ?? "").toLowerCase()}`.trim();
        // custom object rows in the ADF export carry object_name; std-object custom fields have NULL
        const r1 = isCustomObject ? updByObj.run(objDisplay, fieldDisplay, hintAdd, objName, fieldName) : { changes: 0 };
        const r2 = !isCustomObject && colName ? updByCol.run(fieldDisplay, hintAdd, fieldName, colName) : { changes: 0 };
        if (r1.changes || r2.changes) { displayUpdated += r1.changes + r2.changes; continue; }
        if (!tableName || !colName) continue; // nothing to anchor an insert on
        const hint = `${isCustomObject ? displayHint(objName) + " " : ""}${displayHint(fieldName)} ${hintAdd}`.trim();
        ins.run(
          isCustomObject ? objName : null, tableName, null, fieldName, colName,
          hint, isCustomObject ? objDisplay : null, fieldDisplay, "config-report", now,
        );
        inserted++;
      }
    }
  });
  tx();
  return { objects, fields, displayUpdated, inserted };
}

export interface AdfQuery {
  /** custom object name (usually *_c), substring match. */
  object?: string;
  /** generic-store or extension table name, substring match. */
  table?: string;
  /** free text over attribute_name / object_name / table_name. */
  search?: string;
  limit?: number;
}

/** Lookup, grouped per object (custom objects) / per table (built-in extensions), with the exact
 *  access recipe (which table, which context filter, which physical column per attribute). */
export function queryAdfExtensions(q: AdfQuery): unknown {
  const d = db();
  ensureAdf(d);
  const cond: string[] = [];
  const bind: unknown[] = [];
  if (q.object) { cond.push("(UPPER(coalesce(object_name,'')) LIKE UPPER(?) OR coalesce(display_hint,'') LIKE ?)"); bind.push(`%${q.object}%`, `%${displayHint(q.object)}%`); }
  if (q.table) { cond.push("UPPER(table_name) LIKE UPPER(?)"); bind.push(`%${q.table}%`); }
  if (q.search) {
    // match API names AND the de-camelized human words (users say display names, not *_c)
    const words = displayHint(q.search).split(" ").filter(Boolean);
    const wordCond = words.map(() => "coalesce(display_hint,'') LIKE ?").join(" AND ");
    cond.push(`(UPPER(attribute_name || ' ' || coalesce(object_name,'') || ' ' || table_name) LIKE UPPER(?)${wordCond ? ` OR (${wordCond})` : ""})`);
    bind.push(`%${q.search}%`, ...words.map((w) => `%${w}%`));
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const rows = d.prepare(
    `SELECT * FROM adf_extensions ${where} ORDER BY object_name IS NULL, object_name, table_name, attribute_name LIMIT ${limit}`,
  ).all(...bind) as any[];

  const custom = new Map<string, any>();
  const builtin = new Map<string, any>();
  for (const r of rows) {
    const field = {
      attribute: r.attribute_name, column: r.column_name,
      ...(r.field_display ? { label: r.field_display } : {}),
    };
    if (r.object_name) {
      const k = r.object_name;
      if (!custom.has(k)) {
        custom.set(k, {
          objectName: r.object_name,
          ...(r.object_display ? { displayName: r.object_display } : {}),
          storedIn: r.table_name,
          rowFilter: r.context_column_name ? `${r.context_column_name} = '${r.object_name}'` : null,
          fields: [],
        });
      }
      const c = custom.get(k);
      if (!c.displayName && r.object_display) c.displayName = r.object_display;
      if (!c.rowFilter && r.context_column_name) c.rowFilter = `${r.context_column_name} = '${r.object_name}'`;
      // same attribute may come from two sources (adf export + config report) — keep one, prefer labeled
      const dup = c.fields.find((f: any) => f.attribute === field.attribute && f.column === field.column);
      if (dup) { if (!dup.label && field.label) dup.label = field.label; continue; }
      c.fields.push(field);
    } else {
      const k = r.table_name;
      if (!builtin.has(k)) builtin.set(k, { extensionTable: r.table_name, note: "custom fields on the built-in object this table extends (dedicated, no context filter)", fields: [] });
      const b = builtin.get(k);
      const dup = b.fields.find((f: any) => f.attribute === field.attribute && f.column === field.column);
      if (dup) { if (!dup.label && field.label) dup.label = field.label; continue; }
      b.fields.push(field);
    }
  }
  return {
    matched: rows.length,
    truncated: rows.length >= limit,
    customObjects: [...custom.values()],
    builtinExtensions: [...builtin.values()],
  };
}

export function adfCount(): { total: number; customObjects: number; builtinTables: number } {
  const d = db();
  ensureAdf(d);
  try {
    const total = (d.prepare("SELECT COUNT(*) c FROM adf_extensions").get() as any).c;
    const customObjects = (d.prepare("SELECT COUNT(DISTINCT object_name) c FROM adf_extensions WHERE object_name IS NOT NULL").get() as any).c;
    const builtinTables = (d.prepare("SELECT COUNT(DISTINCT table_name) c FROM adf_extensions WHERE object_name IS NULL").get() as any).c;
    return { total, customObjects, builtinTables };
  } catch {
    return { total: 0, customObjects: 0, builtinTables: 0 };
  }
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
