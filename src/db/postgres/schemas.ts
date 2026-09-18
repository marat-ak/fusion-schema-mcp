/**
 * Where each logical table physically lives in the `fusion` database (schema-per-version layout,
 * `scripts/pg-import/ddl.sql` ddl_version 1 + the library migrations in ./ddl.ts).
 *
 * Three routing roles — this map is the ONLY place the layout is known (plan §2.1: schema
 * qualification is provider-internal; callers never see a schema name):
 *
 *   version   read + write in the ACTIVE version schema (`v2026_09`): vendor data. Replaced
 *             wholesale by the upgrade job.
 *   dual      read from the ACTIVE version schema, write to `customer` AND the active version
 *             schema in ONE transaction (D14): `customer` is the durable customer-owned copy the
 *             upgrade job merges forward; the active schema stays complete for serving in between.
 *   customer  read + write in `customer` only: customer-owned operational state that no vendor
 *             dump ever carries.
 *
 * Absent on Postgres: `tables_fts` (FTS5 → the STORED `tables.search` tsvector) and
 * `report_queries_vec` (vec0 shadow → the `report_queries.embedding` column). Asking for either is
 * a programming error, not a fallback — `t()` throws.
 */
import type { TableName } from "../base/provider.js";

export type Role = "version" | "dual" | "customer" | "absent";

/** Physical table name where it differs from the logical one. */
const RENAMED: Partial<Record<TableName, string>> = { meta: "catalog_meta" };

const ROLE: Record<TableName, Role> = {
  // vendor schema catalog + registries + layout corpus (rebuilt/delivered by the upgrade job)
  tables: "version", columns: "version", pkeys: "version", fkeys: "version", indexes: "version",
  relationships: "version", meta: "version",
  table_grain: "version", grain_meta: "version", table_usages: "version", usage_meta: "version",
  table_predicates: "version", pred_meta: "version", table_join_columns: "version",
  layout_patterns: "version", layout_patterns_vec: "version", layout_meta: "version",
  // rebuildable embedding cache: ddl_version 1 puts it in the version schema; an upgrade re-embeds
  col_vec: "version",

  // ingest / materialize / enrichment writes (D14 dual-write)
  report_queries: "dual", report_queries_vec_multi: "dual",
  flexfields: "dual", adf_extensions: "dual", enrich: "dual",

  // customer-owned operational state (curated rules + enrichment job control/ledger)
  table_rules: "customer", facts_meta: "customer",
  enrich_usage: "customer", batch_jobs: "customer", batch_items: "customer",
  gjob_jobs: "customer", gjob_items: "customer", gjob_control: "customer",

  // no Postgres counterpart
  tables_fts: "absent", report_queries_vec: "absent",
};

export const CUSTOMER_SCHEMA = "customer";
export const META_SCHEMA = "meta";

export function roleOf(table: TableName): Role { return ROLE[table]; }
export function physical(table: TableName): string { return RENAMED[table] ?? table; }

/** The schema a READ of `table` must target. */
export function readSchema(table: TableName, activeVersion: string): string {
  switch (ROLE[table]) {
    case "version": case "dual": return activeVersion;
    case "customer": return CUSTOMER_SCHEMA;
    case "absent": throw new Error(`table ${table} does not exist on Postgres (see src/db/postgres/schemas.ts)`);
  }
}

/** Every schema a WRITE of `table` must land in; [0] is the read/serving schema. */
export function writeSchemas(table: TableName, activeVersion: string): string[] {
  return ROLE[table] === "dual"
    ? [activeVersion, CUSTOMER_SCHEMA]
    : [readSchema(table, activeVersion)];
}
