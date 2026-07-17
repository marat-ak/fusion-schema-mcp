/** Query layer over catalog.sqlite. All object names are normalized before lookup. */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed } from "./corpus/embed.js";
import { normName, suggestNames } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.CATALOG_DB ?? path.join(ROOT, "catalog.sqlite");

if (!fs.existsSync(DB_PATH)) {
  throw new Error(
    `catalog.sqlite not found at ${DB_PATH}. Run the compile step first (npm run compile).`,
  );
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma("query_only = true");

// In-memory table-name list for fuzzy did-you-mean (~30k strings, cheap).
const ALL_NAMES: string[] = db
  .prepare("SELECT name FROM tables")
  .all()
  .map((r: any) => r.name as string);
const NAME_SET = new Set(ALL_NAMES);

export function stats() {
  const rows = db.prepare("SELECT key, value FROM meta").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---- prepared statements ----
const qTable = db.prepare(
  "SELECT name, schema, type, module, remarks, view_text FROM tables WHERE name = ?",
);
const qPk = db.prepare(
  "SELECT column_name FROM pkeys WHERE table_name = ? ORDER BY seq",
);
const qColCount = db.prepare(
  "SELECT COUNT(*) AS n FROM columns WHERE table_name = ?",
);
const qColumns = db.prepare(
  `SELECT name, data_type, size, nullable, remarks, ordinal
   FROM columns WHERE table_name = ? ORDER BY ordinal`,
);
const qIndexes = db.prepare(
  `SELECT index_name, is_unique, ordinal, column_name
   FROM indexes WHERE table_name = ? ORDER BY index_name, ordinal`,
);
const qFkOut = db.prepare(
  `SELECT parent_table AS other, column_name AS col, name FROM fkeys WHERE child_table = ?`,
);
const qFkIn = db.prepare(
  `SELECT child_table AS other, column_name AS col, name FROM fkeys WHERE parent_table = ?`,
);
const qRelFrom = db.prepare(
  `SELECT to_table AS other, from_col, to_col, evidence, occurrences, confidence
   FROM relationships WHERE from_table = ?`,
);
const qRelTo = db.prepare(
  `SELECT from_table AS other, from_col, to_col, evidence, occurrences, confidence
   FROM relationships WHERE to_table = ?`,
);

function ftsSanitize(query: string): string[] {
  return (query.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toUpperCase());
}

export function searchTables(query: string, limit = 20) {
  const tokens = ftsSanitize(query);
  if (tokens.length === 0) return [];
  const run = (join: string) => {
    // tokens are pure [A-Za-z0-9_], safe as bareword prefix queries
    const match = tokens.map((t) => `${t}*`).join(join);
    return db
      .prepare(
        `SELECT t.name, t.type, t.module, t.remarks
         FROM tables_fts f JOIN tables t ON t.rowid = f.rowid
         WHERE tables_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as any[];
  };
  // AND first (precise); fall back to OR if nothing matches.
  let rows = run(" AND ");
  if (rows.length === 0 && tokens.length > 1) rows = run(" OR ");
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    module: r.module,
    remarks: r.remarks,
  }));
}

export function getTable(name: string) {
  const n = normName(name);
  const t = qTable.get(n) as any;
  if (!t) return null;
  const pk = (qPk.all(n) as any[]).map((r) => r.column_name);
  const cc = (qColCount.get(n) as any).n as number;
  return {
    name: t.name,
    schema: t.schema,
    type: t.type,
    module: t.module,
    remarks: t.remarks,
    viewText: t.view_text,
    primaryKey: pk,
    columnCount: cc,
  };
}

export function getColumns(table: string) {
  const n = normName(table);
  if (!NAME_SET.has(n)) return { tableExists: false, columns: [] as any[] };
  const pk = new Set((qPk.all(n) as any[]).map((r) => r.column_name));
  const cols = (qColumns.all(n) as any[]).map((r) => ({
    name: r.name,
    dataType: r.data_type,
    size: r.size,
    nullable: r.nullable === 1,
    remarks: r.remarks,
    ordinal: r.ordinal,
    isPrimaryKey: pk.has(r.name),
  }));
  return { tableExists: true, columns: cols };
}

export function validateTable(name: string) {
  const n = normName(name);
  if (NAME_SET.has(n)) {
    const t = qTable.get(n) as any;
    return {
      exists: true,
      table: { name: t.name, type: t.type, module: t.module, remarks: t.remarks },
      suggestions: [] as string[],
    };
  }
  return { exists: false, table: null, suggestions: suggestNames(n, ALL_NAMES, 5) };
}

export function validateColumns(table: string, columns: string[]) {
  const n = normName(table);
  const tableExists = NAME_SET.has(n);
  if (!tableExists) {
    return {
      table: n,
      tableExists: false,
      tableSuggestions: suggestNames(n, ALL_NAMES, 5),
      results: [] as any[],
    };
  }
  const cols = qColumns.all(n) as any[];
  const colNames = cols.map((c) => c.name as string);
  const colSet = new Set(colNames);
  const results = columns.map((raw) => {
    const c = (raw ?? "").trim().toUpperCase();
    const exists = colSet.has(c);
    return {
      column: c,
      exists,
      suggestions: exists ? [] : suggestNames(c, colNames, 5),
    };
  });
  return { table: n, tableExists: true, results };
}

export function getIndexes(table: string) {
  const n = normName(table);
  if (!NAME_SET.has(n)) return { tableExists: false, indexes: [] as any[] };
  const rows = qIndexes.all(n) as any[];
  const byName = new Map<string, { indexName: string; unique: boolean; columns: string[] }>();
  for (const r of rows) {
    let e = byName.get(r.index_name);
    if (!e) {
      e = { indexName: r.index_name, unique: r.is_unique === 1, columns: [] };
      byName.set(r.index_name, e);
    }
    if (r.column_name) e.columns.push(r.column_name);
  }
  return { tableExists: true, indexes: [...byName.values()] };
}

const CONF_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function getRelatedTables(table: string) {
  const n = normName(table);
  if (!NAME_SET.has(n)) {
    return { tableExists: false, suggestions: suggestNames(n, ALL_NAMES, 5), related: [] as any[] };
  }
  const out: any[] = [];
  for (const r of qFkOut.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "outgoing",
      source: "declared",
      name: r.name,
    });
  }
  for (const r of qFkIn.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "incoming",
      source: "declared",
      name: r.name,
    });
  }
  for (const r of qRelFrom.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.from_col,
      toColumn: r.to_col,
      direction: "outgoing",
      source: "mined",
      evidence: r.evidence,
      occurrences: r.occurrences,
      confidence: r.confidence,
    });
  }
  for (const r of qRelTo.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.to_col,
      toColumn: r.from_col,
      direction: "incoming",
      source: "mined",
      evidence: r.evidence,
      occurrences: r.occurrences,
      confidence: r.confidence,
    });
  }
  // declared first, then mined by confidence then occurrences
  out.sort((a, b) => {
    if (a.source !== b.source) return a.source === "declared" ? -1 : 1;
    const cr = (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3);
    if (cr !== 0) return cr;
    return (b.occurrences ?? 0) - (a.occurrences ?? 0);
  });
  return { tableExists: true, related: out };
}

const SRC_OVERFETCH = 40;
let _vecStmts: { qVec: any; qVecSrc: any } | null = null;
function vecStmts() {
  if (!_vecStmts) {
    loadVec(db);
    _vecStmts = {
      qVec: db.prepare(
        `SELECT rq.id, rq.source, rq.title, rq.description, rq.clean_sql,
                rq.tables_used, rq.joins, rq.filters, rq.lookup_types,
                v.distance AS distance
         FROM report_queries_vec v
         JOIN report_queries rq ON rq.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`),
      qVecSrc: db.prepare(
        `SELECT rq.id, rq.source, rq.title, rq.description, rq.clean_sql,
                rq.tables_used, rq.joins, rq.filters, rq.lookup_types,
                v.distance AS distance
         FROM report_queries_vec v
         JOIN report_queries rq ON rq.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND rq.source = ?
         ORDER BY v.distance
         LIMIT ?`),
    };
  }
  return _vecStmts;
}

export async function findSimilarQueries(
  intent: string, opts: { source?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 5;
  const [vec] = await embed([intent]);
  const blob = Buffer.from(vec.buffer);
  const { qVec, qVecSrc } = vecStmts();
  const rows = (opts.source
    ? qVecSrc.all(blob, limit * SRC_OVERFETCH, opts.source, limit)
    : qVec.all(blob, limit)) as any[];
  return rows.map((r) => ({
    id: r.id, source: r.source, title: r.title, description: r.description,
    cleanSql: r.clean_sql,
    tablesUsed: JSON.parse(r.tables_used ?? "[]"),
    joins: JSON.parse(r.joins ?? "[]"),
    filters: JSON.parse(r.filters ?? "[]"),
    lookupTypes: JSON.parse(r.lookup_types ?? "[]"),
    score: 1 - (r.distance * r.distance) / 2,
  }));
}
