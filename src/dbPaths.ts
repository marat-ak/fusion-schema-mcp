/**
 * Central, env-driven resolution of the THREE split SQLite files.
 *
 *   schema.sqlite  (SCHEMA_DB)  — tables, columns, pkeys, fkeys, indexes, relationships, tables_fts, meta
 *   reports.sqlite (REPORTS_DB) — report_queries(+embedding BLOB), report_queries_fts, report_queries_vec
 *   cache.sqlite   (CACHE_DB)   — col_vec (column-search embedding cache)
 *
 * Defaults live under DATA_DIR (default /app/data in the image; ./data in a source checkout).
 * The entrypoint (provision.js) creates the split files from the baked seed before the server
 * opens them; a pre-split single catalog.sqlite is converted once with `node dist/migrate-split.js`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
export const SEED_DIR = process.env.SEED_DIR ?? "/app/seed";

export const SCHEMA_DB = process.env.SCHEMA_DB ?? path.join(DATA_DIR, "schema.sqlite");
export const REPORTS_DB = process.env.REPORTS_DB ?? path.join(DATA_DIR, "reports.sqlite");
export const CACHE_DB = process.env.CACHE_DB ?? path.join(DATA_DIR, "cache.sqlite");

/** Path the schema tables live in (schema.sqlite). */
export function schemaDbPath(): string {
  return SCHEMA_DB;
}
/** Path the report corpus lives in (reports.sqlite). */
export function reportsDbPath(): string {
  return REPORTS_DB;
}

/** Escape a filesystem path for embedding inside a single-quoted SQL string (ATTACH DATABASE '…'). */
export function sqlQuote(p: string): string {
  return p.replace(/'/g, "''");
}
