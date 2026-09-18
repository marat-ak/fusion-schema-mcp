import { BaseMeta } from "../base/meta.js";
import { readVersionFile } from "../../version.js";
import { roleOf, physical, readSchema, CUSTOMER_SCHEMA, META_SCHEMA } from "./schemas.js";
import type { TableName } from "../base/provider.js";
import type { PostgresProvider } from "./provider.js";

/** The `ddl_version` header of scripts/pg-import/ddl.sql this code is written against. */
export const EXPECTED_DDL_VERSION = "2"; // v2: punctuation-stripped tsvector (FTS5 tokenizer parity)
/** The library migrations (./ddl.ts) a serving database must already carry. */
export const EXPECTED_LIBRARY_VERSION = 1;

const ALL_TABLES: TableName[] = [
  "tables", "columns", "pkeys", "fkeys", "indexes", "relationships", "meta",
  "report_queries", "report_queries_vec_multi",
  "table_grain", "grain_meta", "table_usages", "usage_meta", "table_predicates", "pred_meta", "table_join_columns",
  "layout_patterns", "layout_patterns_vec", "layout_meta",
  "flexfields", "adf_extensions", "enrich", "col_vec",
  "enrich_usage", "batch_jobs", "batch_items", "gjob_jobs", "gjob_items", "gjob_control",
  "table_rules", "facts_meta",
];

/**
 * `catalog_meta` k/v of the ACTIVE version schema + the boot-time verification.
 *
 * §0 of the DB-library plan (user decision 2026-09-18): THE SERVING CONTAINER BUILDS NOTHING.
 * `verify()` is read-only; `ensureDdl()` (the library migrations) is an EXPLICIT call reserved for
 * the upgrade job and is never invoked on the serving path.
 */
export class PgMeta extends BaseMeta {
  constructor(protected p: PostgresProvider) { super(p); }

  activeVersion(): string { return this.p.activeSchema(); }

  /**
   * Read-only boot check: the active version schema exists with every table the provider addresses,
   * its seed's `ddl_version` + `embedding_model` match this code, and the library migrations have
   * been applied. Any gap is a loud error naming the missing piece — never a repair, never a
   * fallback. Logs the row counts that prove which catalog is being served.
   */
  async verify(): Promise<void> {
    const v = this.p.activeSchema();
    const seed = (await this.p.q<{ ddl_version: string; embedding_model: string }>(
      `SELECT ddl_version, embedding_model FROM ${META_SCHEMA}.seeds WHERE version = ?`, [v]))[0];
    if (!seed) throw new Error(`meta.seeds has no row for the active version ${v} — restore it with the upgrade job`);
    if (seed.ddl_version !== EXPECTED_DDL_VERSION) {
      throw new Error(`${v} was restored with ddl_version ${seed.ddl_version}; this build speaks ddl_version ${EXPECTED_DDL_VERSION}`);
    }
    const want = readVersionFile().embedding;
    if (seed.embedding_model !== want) {
      throw new Error(`${v} carries embeddings from ${seed.embedding_model}; this build embeds with ${want} — re-run the upgrade job with a matching seed`);
    }

    const present = new Set((await this.p.q<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN (?,?,?)`,
      [v, CUSTOMER_SCHEMA, META_SCHEMA])).map((r) => r.t));
    const missing: string[] = [];
    for (const t of ALL_TABLES) {
      const one = `${readSchema(t, v)}.${physical(t)}`;
      if (!present.has(one)) missing.push(one);
      if (roleOf(t) === "dual") {
        const other = `${CUSTOMER_SCHEMA}.${physical(t)}`;
        if (!present.has(other)) missing.push(other);
      }
    }
    if (missing.length) {
      throw new Error(`the fusion database is missing ${missing.length} table(s) the catalog needs: ${missing.join(", ")} — run the upgrade job (it applies scripts/pg-import/ddl.sql + the library migrations); the serving container never creates them`);
    }
    const applied = (await this.p.q<{ version: number }>(`SELECT version FROM ${META_SCHEMA}.library_migrations`)).map((r) => Number(r.version));
    if (!applied.includes(EXPECTED_LIBRARY_VERSION)) {
      throw new Error(`library migration v${EXPECTED_LIBRARY_VERSION} has not been applied to this database — run the upgrade job`);
    }

    const [tables, corpus, cust] = await Promise.all([
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("tables")}`),
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("report_queries")}`),
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${CUSTOMER_SCHEMA}.report_queries`),
    ]);
    console.error(`[db] postgres ready: active=${v} ddl_version=${seed.ddl_version} embedding=${seed.embedding_model} ` +
      `tables=${tables[0].c} report_queries=${corpus[0].c} (customer=${cust[0].c})`);
  }

  /**
   * The library's own customer-side DDL (src/db/postgres/ddl.ts). Called ONLY by the upgrade job /
   * a test seeding a fresh database — NEVER at boot: a serving container that finds the database
   * incomplete fails loudly (see verify()), it does not build.
   */
  async ensureDdl(): Promise<void> {
    const applied = await this.p.migrate();
    console.error(applied.length
      ? `[db] library migrations applied: ${applied.map((x) => `v${x}`).join(", ")}`
      : "[db] library migrations already applied");
  }

  /** Indexes ship with the DDL (ddl.sql / ddl.ts) — nothing is ever created at runtime. */
  async ensureIndexes(): Promise<void> { /* no-op */ }

  /** End of a bulk load (upgrade job only): refresh planner stats. */
  async finalizeBuild(): Promise<void> {
    await this.p.exec("ANALYZE");
  }
}
