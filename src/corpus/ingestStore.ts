/**
 * Runtime ingest into the report-SQL corpus (report_queries + report_queries_vec) held in
 * catalog.sqlite. Opens a SEPARATE writable connection (catalog.ts holds a read-only one).
 *
 * Each report's SQLs are stored under ids `bip-report:<groupKey>#<i>`, so re-ingesting the same
 * report REPLACES its prior rows (idempotent) — we delete every row whose id has that prefix,
 * then insert the fresh set with new rowids. Embeddings are the same local bge-small-en-v1.5
 * vectors used elsewhere (no external model call); we embed a synthesized description built from
 * the report path + extracted tables + classified domain. Domain itself is not stored — it is
 * recomputed at query time by findSimilarQueries from tables_used — but is folded into the
 * embedded description so intent search can hit it.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed } from "./embed.js";
import { classifyDomain } from "./domain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DB_PATH = process.env.CATALOG_DB ?? path.join(ROOT, "catalog.sqlite");

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`catalog.sqlite not found at ${DB_PATH} (run the compile step first).`);
  }
  const d = new Database(DB_PATH);
  d.pragma("busy_timeout = 10000"); // tolerate the read-only reader connection briefly locking
  loadVec(d);
  _db = d;
  return d;
}

// ---- table -> Fusion module lookup (authoritative signal for classifyDomain) ----
let _qModule: Database.Statement | null = null;
const _moduleCache = new Map<string, string | undefined>();
function moduleOf(table: string): string | undefined {
  if (_moduleCache.has(table)) return _moduleCache.get(table);
  _qModule ??= db().prepare("SELECT module FROM tables WHERE name = ?");
  const mod = (_qModule.get(table.toUpperCase()) as any)?.module ?? undefined;
  _moduleCache.set(table, mod);
  return mod;
}

const SQL_KEYWORDS = new Set([
  "DUAL", "TABLE", "LATERAL", "SELECT", "WHERE", "LEFT", "RIGHT", "INNER", "OUTER", "FULL",
  "CROSS", "JOIN", "ON", "USING", "AS", "WITH", "JSON_TABLE", "XMLTABLE", "VALUES", "PROCEDURE",
  "FUNCTION", "GROUP", "ORDER", "PARTITION",
]);

/** Best-effort table extraction from raw SQL (drives prefix-based domain classification). */
export function extractTables(sql: string): string[] {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
  const re =
    /\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const parts = m[1].split(".").map((p) => p.replace(/"/g, ""));
    const last = parts[parts.length - 1].toUpperCase();
    if (/^[A-Z][A-Z0-9_$]*$/.test(last) && last.length > 2 && !SQL_KEYWORDS.has(last)) out.add(last);
  }
  return [...out];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function corpusCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM report_queries").get() as any).n as number;
}

export interface IngestSql {
  hash?: string;
  text: string;
}

export interface IngestReportInput {
  /** Stable identity for this report; re-ingesting the same key replaces its prior rows. */
  groupKey: string;
  /** Human title / report path stored on each row and searchable via getReportQuery. */
  title: string;
  provenance?: "shared" | "custom" | string;
  reportPath?: string;
  sqls: IngestSql[];
}

export interface IngestReportResult {
  groupKey: string;
  inserted: number;
  replaced: number;
  domains: string[];
}

/**
 * Replace all corpus rows for `groupKey` with the given SQLs (idempotent).
 * Returns per-report counts. Embeddings are computed before the (synchronous) DB transaction.
 */
export async function ingestReport(input: IngestReportInput): Promise<IngestReportResult> {
  const d = db();
  const sqls = (input.sqls ?? []).filter((s) => s && typeof s.text === "string" && /\S/.test(s.text));

  // Build rows (tables + domain + description) up front, then embed the descriptions.
  const rows = sqls.map((s, i) => {
    const tables = extractTables(s.text);
    const domain = classifyDomain(tables, input.title, moduleOf);
    const suffix = sqls.length > 1 ? ` #${i}` : "";
    const description =
      `${input.title}${suffix} — Oracle Fusion BIP report physical SQL` +
      `${input.provenance ? ` (${input.provenance})` : ""}. Domain: ${domain}.` +
      (tables.length ? ` Tables: ${tables.join(", ")}.` : "");
    return {
      id: `bip-report:${input.groupKey}#${i}`,
      title: `${input.title}${suffix}`,
      sql: s.text,
      tables,
      domain,
      description,
    };
  });

  const vecs = rows.length ? await embed(rows.map((r) => r.description)) : [];

  const pattern = `bip-report:${escapeLike(input.groupKey)}#%`;
  const delOld = d.prepare(
    `SELECT rowid FROM report_queries WHERE id LIKE ? ESCAPE '\\'`,
  );
  const delRq = d.prepare("DELETE FROM report_queries WHERE rowid = ?");
  const delVec = d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?");
  const insRq = d.prepare(
    `INSERT INTO report_queries
       (rowid, id, source, title, original_sql, clean_sql, description,
        tables_used, joins, filters, lookup_types, security_predicate, approved)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  );
  const insVec = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  const maxRowid = d.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM report_queries");

  let replaced = 0;
  const tx = d.transaction(() => {
    for (const r of delOld.all(pattern) as any[]) {
      delVec.run(r.rowid);
      delRq.run(r.rowid);
      replaced++;
    }
    let next = (maxRowid.get() as any).m as number;
    rows.forEach((r, i) => {
      const rowid = BigInt(next + 1 + i);
      insRq.run(
        rowid, r.id, "bip-report", r.title, r.sql, r.sql, r.description,
        JSON.stringify(r.tables), "[]", "[]", "[]", null,
      );
      insVec.run(rowid, Buffer.from(vecs[i].buffer));
    });
  });
  tx();

  return {
    groupKey: input.groupKey,
    inserted: rows.length,
    replaced,
    domains: [...new Set(rows.map((r) => r.domain))],
  };
}
