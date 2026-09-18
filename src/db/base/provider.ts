/**
 * BaseProvider — the dialect hooks every concrete provider implements, plus the group wiring.
 * Group classes (BaseMeta, BaseSchema, ...) hold the portable default SQL of EVERY statement as an
 * overridable method; a provider swaps in a subclass for the groups whose statements diverge.
 */
import type { CatalogProvider, MetaApi, SchemaApi, CorpusApi, RegistriesApi, FlexApi, LayoutApi, RulesApi, EnrichApi, ColCacheApi } from "../provider.js";

export type TableName =
  | "tables" | "columns" | "pkeys" | "fkeys" | "indexes" | "relationships" | "tables_fts" | "meta"
  | "report_queries" | "report_queries_vec" | "report_queries_vec_multi"
  | "table_grain" | "grain_meta" | "table_usages" | "usage_meta" | "table_predicates" | "pred_meta" | "table_join_columns"
  | "layout_patterns" | "layout_patterns_vec" | "layout_meta"
  | "flexfields" | "adf_extensions"
  | "enrich_usage" | "batch_jobs" | "batch_items" | "gjob_jobs" | "gjob_items" | "gjob_control"
  | "enrich" | "col_vec" | "table_rules" | "facts_meta";

export interface RunResult { changes: number; lastInsertRowid: number }

export abstract class BaseProvider implements CatalogProvider {
  abstract meta: MetaApi;
  abstract schema: SchemaApi;
  abstract corpus: CorpusApi;
  abstract registries: RegistriesApi;
  abstract flex: FlexApi;
  abstract layout: LayoutApi;
  abstract rules: RulesApi;
  abstract enrich: EnrichApi;
  abstract colCache: ColCacheApi;

  // ---- dialect hooks (implemented by the provider) ----
  /** Run a statement and return its rows. `?` placeholders (the pg provider rewrites them to $n). */
  abstract q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement, return changes + last insert identity. */
  abstract run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Execute a (multi-statement) script without params. */
  abstract exec(sql: string): Promise<void>;
  /** Run `fn` inside ONE transaction (nested calls join the outer one). */
  abstract tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Encode a vector for binding. */
  abstract vec(v: Float32Array): unknown;
  /** Decode a stored vector. */
  abstract fromVec(raw: unknown): Float32Array;
  /** Qualified name of a table (bare vs `schema.table`). */
  abstract t(table: TableName): string;
  /** Text-ORDER-BY suffix. SQLite compares text bytewise; Postgres orders by the database locale
   *  (which ignores spaces/case), so its provider appends `COLLATE "C"` — without it the same list
   *  comes back in a different order on the two providers. */
  abstract coll(): string;
  /** Identity column of a table (`rowid` on sqlite, `rid` on pg) + how to bind a value of it. */
  abstract idCol(): string;
  abstract idBind(n: number | bigint): unknown;

  async refreshIfMoved(): Promise<boolean> { return false; }
  abstract close(): Promise<void>;
}
