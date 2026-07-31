/**
 * Central, env-driven resolution of the THREE split SQLite files, with backward-compat to the
 * legacy single catalog.sqlite.
 *
 *   schema.sqlite  (SCHEMA_DB)  — tables, columns, pkeys, fkeys, indexes, relationships, tables_fts, meta
 *   reports.sqlite (REPORTS_DB) — report_queries(+embedding BLOB), report_queries_fts, report_queries_vec
 *   cache.sqlite   (CACHE_DB)   — col_vec (column-search embedding cache)
 *
 * Defaults live under DATA_DIR (default /app/data in the image; ./data in a source checkout).
 *
 * Back-compat: if a split file is ABSENT but CATALOG_DB points at an existing legacy catalog.sqlite
 * (schema + corpus in one file), the resolver falls back to it so an un-migrated deployment keeps
 * working (table names are unique across schema vs reports, so a single file that holds both still
 * resolves every unqualified query). Run `node dist/migrate-split.js` to produce the split files.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
export const SEED_DIR = process.env.SEED_DIR ?? "/app/seed";

export const SCHEMA_DB = process.env.SCHEMA_DB ?? path.join(DATA_DIR, "schema.sqlite");
export const REPORTS_DB = process.env.REPORTS_DB ?? path.join(DATA_DIR, "reports.sqlite");
export const CACHE_DB =
  process.env.CACHE_DB ?? process.env.COLCACHE_DB ?? path.join(DATA_DIR, "cache.sqlite");

/** Legacy single-file catalog (schema + corpus). Only used as a fallback when split files absent. */
export const LEGACY_CATALOG_DB = process.env.CATALOG_DB ?? null;

function resolveOrLegacy(splitPath: string): string {
  if (fs.existsSync(splitPath)) return splitPath;
  if (LEGACY_CATALOG_DB && fs.existsSync(LEGACY_CATALOG_DB)) return LEGACY_CATALOG_DB;
  return splitPath; // default; callers using fileMustExist will surface a clear error
}

/** Path the schema tables live in (schema.sqlite, or the legacy catalog.sqlite as fallback). */
export function schemaDbPath(): string {
  return resolveOrLegacy(SCHEMA_DB);
}
/** Path the report corpus lives in (reports.sqlite, or the legacy catalog.sqlite as fallback). */
export function reportsDbPath(): string {
  return resolveOrLegacy(REPORTS_DB);
}

/** True when schema+reports resolve to the SAME file (legacy single catalog) → skip the ATTACH. */
export function isSingleFile(): boolean {
  return path.resolve(schemaDbPath()) === path.resolve(reportsDbPath());
}

/** Escape a filesystem path for embedding inside a single-quoted SQL string (ATTACH DATABASE '…'). */
export function sqlQuote(p: string): string {
  return p.replace(/'/g, "''");
}
