/**
 * Env-driven resolution of the split SQLite files (the sqlite provider's only config surface):
 *
 *   DATA_DIR (REQUIRED, no default) — the data volume every file lives in by default
 *   SCHEMA_DB  → schema.sqlite   tables/columns/pkeys/fkeys/indexes/relationships/tables_fts/meta
 *   REPORTS_DB → reports.sqlite  report_queries(+vec/vec_multi), registries, layout corpus, flexStore,
 *                                enrich_usage, batch jobs + gjob tables (the MAIN connection — vec0 needs it)
 *   ENRICH_DB  → enrich.sqlite   staging queue
 *   CACHE_DB   → cache.sqlite    col_vec (column-search embedding cache)
 *   FACTS_DB   → facts.sqlite    table_rules + facts_meta (curated; never part of a seed)
 *
 * Each *_DB overrides one file; a missing DATA_DIR is a boot error (required input, never defaulted).
 */
import path from "node:path";

export interface SqliteFiles { schema: string; reports: string; enrich?: string; cache?: string; facts?: string }

export function requireDataDir(): string {
  const d = process.env.DATA_DIR;
  if (!d) throw new Error("DATA_DIR is required (the catalog data directory) — no default");
  return d;
}

/** All five files from the env (runtime shape). */
export function sqliteFilesFromEnv(): SqliteFiles {
  const dataDir = requireDataDir();
  return {
    schema: process.env.SCHEMA_DB ?? path.join(dataDir, "schema.sqlite"),
    reports: process.env.REPORTS_DB ?? path.join(dataDir, "reports.sqlite"),
    enrich: process.env.ENRICH_DB ?? path.join(dataDir, "enrich.sqlite"),
    cache: process.env.CACHE_DB ?? path.join(dataDir, "cache.sqlite"),
    facts: process.env.FACTS_DB ?? path.join(dataDir, "facts.sqlite"),
  };
}

/** Escape a filesystem path for embedding inside a single-quoted SQL string (ATTACH DATABASE '…'). */
export function sqlQuote(p: string): string {
  return p.replace(/'/g, "''");
}
