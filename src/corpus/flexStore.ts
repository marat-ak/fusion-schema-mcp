/**
 * DFF/EFF flexfield registry — the customer-admin-provided mapping from business names
 * ("Pallet Qty", context "customer-A requirements doc") to physical bindings (flexfield_code,
 * context_code, ATTRIBUTE_CHARn column, value set). Source of truth for resolving EFF contexts
 * WITHOUT guessing and without needing pod access (works offline).
 *
 * Storage: `db().flex` (plain `flexfields` / `adf_extensions` tables). No vectors — this is an exact
 * registry; lookups are indexed equality/LIKE, not semantic search. Loading is snapshot-replace per
 * `source` ('admin-export' | 'datamodel-mined' | 'pod-live'): a new admin upload fully replaces the
 * previous admin snapshot. This module owns the CSV/XML parsing + result grouping; the statements
 * live in the library.
 *
 * Expected CSV columns (the standard FND_DF_FLEXFIELDS_B/FND_DF_CONTEXTS_B/FND_DF_SEGMENTS_VL
 * export; header names case-insensitive): APPLICATION_ID, FLEXFIELD_TYPE, FLEXFIELD_CODE,
 * DEPLOYMENT_STATUS, CONTEXT_CODE, CONTEXT_ENABLED_FLAG, MULTIROW_FLAG, TRANSLATABLE_FLAG,
 * SEGMENT_CODE, COLUMN_NAME, SEQUENCE_NUMBER, SEGMENT_NAME, PROMPT, DISPLAY_TYPE, VALUE_SET_ID,
 * REQUIRED_FLAG, SEGMENT_ENABLED_FLAG.
 */
import { parse } from "csv-parse/sync";
import { db, type FlexfieldLoadRow, type AdfLoadRow, type ConfigReportField } from "../db/index.js";

const norm = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const toInt = (v: unknown): number | null => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** Parse the registry CSV and snapshot-replace all rows of `source`. */
export async function loadFlexfieldsCsv(csvText: string, source = "admin-export"): Promise<{ rows: number; dff: number; eff: number }> {
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

  const now = new Date().toISOString();
  const out: FlexfieldLoadRow[] = [];
  let dff = 0, eff = 0;
  for (const r of records) {
    const type = (norm(r.FLEXFIELD_TYPE) ?? "").toUpperCase();
    const code = norm(r.FLEXFIELD_CODE);
    const ctx = norm(r.CONTEXT_CODE);
    const seg = norm(r.SEGMENT_CODE);
    if (!type || !code || !ctx || !seg) continue; // truncated/garbage line
    out.push([
      toInt(r.APPLICATION_ID), type, code, norm(r.DEPLOYMENT_STATUS), ctx,
      norm(r.CONTEXT_ENABLED_FLAG), norm(r.MULTIROW_FLAG), norm(r.TRANSLATABLE_FLAG),
      seg, norm(r.COLUMN_NAME), toInt(r.SEQUENCE_NUMBER),
      norm(r.SEGMENT_NAME), norm(r.PROMPT), norm(r.DISPLAY_TYPE),
      toInt(r.VALUE_SET_ID), norm(r.REQUIRED_FLAG), norm(r.SEGMENT_ENABLED_FLAG),
      source, now,
    ]);
    if (type === "DFF") dff++; else if (type === "EFF") eff++;
  }
  const rows = await db().flex.replaceSnapshot("flexfields", source, out);
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
export async function queryFlexfields(q: FlexQuery): Promise<unknown> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const rows = await db().flex.queryFlexfields(q, limit);

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
export async function loadAdfExtensionsCsv(csvText: string, source = "admin-export"): Promise<{ rows: number; customObjects: number; builtinExtensions: number }> {
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
  const now = new Date().toISOString();
  const out: AdfLoadRow[] = [];
  const objects = new Set<string>();
  const builtinTables = new Set<string>();
  for (const r of records) {
    const table = norm(r.TABLE_NAME);
    const attr = norm(r.ATTRIBUTE_NAME);
    const col = norm(r.COLUMN_NAME);
    if (!table || !attr || !col) continue;
    const obj = norm(r.OBJECT_NAME);
    const hint = `${obj ? displayHint(obj) + " " : ""}${displayHint(attr)}`;
    out.push([obj, table, norm(r.CONTEXT_COLUMN_NAME), attr, col, hint, source, now]);
    if (obj) objects.add(obj); else builtinTables.add(table);
  }
  const rows = await db().flex.replaceSnapshot("adf_extensions", source, out);
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

export async function loadConfigReportXml(xml: string): Promise<{
  objects: number; fields: number; displayUpdated: number; inserted: number;
}> {
  const now = new Date().toISOString();
  let objects = 0, fields = 0;
  const parsed: ConfigReportField[] = [];
  const objBlocks = xml.split(/<CustomizedObject>/).slice(1).map((b) => b.split("</CustomizedObject>")[0]);
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
      const hint = `${isCustomObject ? displayHint(objName) + " " : ""}${displayHint(fieldName)} ${hintAdd}`.trim();
      parsed.push({ objName, isCustomObject, objDisplay, tableName, fieldName, colName, fieldDisplay, hintAdd, hint });
    }
  }
  const r = await db().flex.applyConfigReport(parsed, now);
  return { objects, fields, displayUpdated: r.displayUpdated, inserted: r.inserted };
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
export async function queryAdfExtensions(q: AdfQuery): Promise<unknown> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const rows = await db().flex.queryAdf({
    object: q.object, objectHint: q.object ? displayHint(q.object) : undefined,
    table: q.table,
    search: q.search, searchWords: q.search ? displayHint(q.search).split(" ").filter(Boolean) : undefined,
  }, limit);

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

export async function adfCount(): Promise<{ total: number; customObjects: number; builtinTables: number }> {
  return db().flex.adfCount();
}

export async function flexfieldsCount(): Promise<{ total: number; dff: number; eff: number; sources: unknown }> {
  return db().flex.flexfieldsCount();
}
