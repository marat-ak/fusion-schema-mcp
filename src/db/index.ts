/**
 * The ONLY import callers may use: open the catalog DB once (server boot / a dev script's main),
 * then reach it through `db()`. Callers program against `CatalogProvider` (src/db/provider.ts) —
 * typed methods, never SQL, never a connection handle.
 *
 * Required config, no defaults: CATALOG_DB=sqlite + DATA_DIR (+ optional per-file *_DB overrides,
 * see sqlite/paths.ts). A missing/unknown value is a boot error.
 */
import type { CatalogProvider } from "./provider.js";
export type { CatalogProvider, MetaApi, SchemaApi, CorpusApi, RegistriesApi, FlexApi, LayoutApi, RulesApi, EnrichApi, JobsApi, ColCacheApi } from "./provider.js";
import { SqliteProvider, type SqliteConfig } from "./sqlite/provider.js";
import { sqliteFilesFromEnv } from "./sqlite/paths.js";

export type CatalogDb = CatalogProvider;
export type CatalogConfig = SqliteConfig;
export type { SqliteFiles } from "./sqlite/paths.js";
export * from "./types.js";

let _db: CatalogDb | null = null;

/** Resolve the provider config from the environment (runtime shape: every file required). */
export function configFromEnv(opts: { create?: boolean } = {}): CatalogConfig {
  const kind = process.env.CATALOG_DB;
  if (kind !== "sqlite") throw new Error(`CATALOG_DB must be "sqlite" (got ${JSON.stringify(kind ?? null)}) — required, no default`);
  return { provider: "sqlite", files: sqliteFilesFromEnv(), create: opts.create };
}

/** Open a catalog DB. Throws on missing files / DDL failure. Registers as the process default unless `register:false`. */
export async function openCatalogDb(cfg: CatalogConfig, opts: { register?: boolean } = {}): Promise<CatalogDb> {
  if (cfg.provider !== "sqlite") throw new Error(`unknown catalog provider ${String((cfg as any).provider)}`);
  const p = await SqliteProvider.open(cfg);
  if (opts.register !== false) _db = p;
  return p;
}

/** The process-default catalog DB (opened by server.ts boot / a script's main). */
export function db(): CatalogDb {
  if (!_db) throw new Error("catalog DB not opened — call openCatalogDb() first");
  return _db;
}

export async function closeCatalogDb(): Promise<void> {
  const p = _db;
  _db = null;
  if (p) await p.close();
}
