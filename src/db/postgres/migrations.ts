/**
 * Forward-only library migrations (engine idiom, gnimsys-agent-core/src/db/migrations.ts):
 * versions already in `meta.library_migrations` are skipped, the whole pass runs under a
 * transaction-scoped advisory lock so two schema-mcp processes booting together apply each
 * version exactly once. Scope = the customer-owned tables of ./ddl.ts only; the vendor schema
 * belongs to scripts/pg-import/ddl.sql and the upgrade job.
 */
import type { Sql } from "postgres";
import { LIBRARY_MIGRATIONS } from "./ddl.js";
import { CUSTOMER_SCHEMA } from "./schemas.js";

/** fusion-schema-mcp's own key (the engine store uses 7412001 on another database). */
const LOCK_KEY = 7412002;

export async function applyLibraryMigrations(sql: Sql): Promise<number[]> {
  const applied: number[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE SCHEMA IF NOT EXISTS meta`;
    await tx`CREATE TABLE IF NOT EXISTS meta.library_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${CUSTOMER_SCHEMA}`);
    const done = new Set((await tx`SELECT version FROM meta.library_migrations`).map((r) => Number(r.version)));
    for (const m of LIBRARY_MIGRATIONS) {
      if (done.has(m.version)) continue;
      await tx.unsafe(m.sql(CUSTOMER_SCHEMA));
      await tx`INSERT INTO meta.library_migrations (version) VALUES (${m.version})`;
      applied.push(m.version);
    }
  });
  return applied;
}
