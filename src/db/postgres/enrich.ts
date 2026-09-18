import { BaseEnrich, toEnrichRow } from "../base/enrich.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/**
 * Staging queue. Writes are dual (customer + active version schema, D14) so a version upgrade can
 * never drop a customer's staged or enriched rows; reads serve from the active schema, which also
 * holds the vendor's delivered enrichment. The usage ledger and the batch/gjob job control live in
 * `customer` only (no vendor dump carries them) — those base statements run unchanged.
 */
export class PgEnrich extends BaseEnrich {
  constructor(protected p: PostgresProvider) { super(p); }

  private tables(): string[] { return this.p.tw("enrich"); }

  async upsertSource(s: T.SqlSource): Promise<void> {
    await this.p.tx(async () => {
      for (const tbl of this.tables()) {
        await this.p.run(this.insSrcSql(tbl), [s.id, s.source, s.title, s.sourceHash, s.originalSql, null]);
      }
    });
  }

  async stage(s: T.SqlSource, ref: T.ReportRef): Promise<boolean> {
    return this.p.tx(async () => {
      const existing = (await this.p.q<{ reports: string | null }>(`SELECT reports FROM ${this.e()} WHERE id = ?`, [s.id]))[0];
      if (!existing) {
        for (const tbl of this.tables()) {
          await this.p.run(this.insSrcSql(tbl), [s.id, s.source, s.title, s.sourceHash, s.originalSql, JSON.stringify([ref])]);
        }
        return true;
      }
      const refs: T.ReportRef[] = existing.reports ? JSON.parse(existing.reports) : [];
      if (!refs.some((r) => r.path === ref.path && r.index === ref.index)) {
        refs.push(ref);
        for (const tbl of this.tables()) await this.p.run(`UPDATE ${tbl} SET reports=? WHERE id=?`, [JSON.stringify(refs), s.id]);
      }
      return false;
    });
  }

  async setEnrichment(id: string, e: T.Enrichment): Promise<void> {
    const J = (v: unknown) => JSON.stringify(v ?? null);
    await this.p.tx(async () => {
      for (const tbl of this.tables()) {
        await this.p.run(
          `UPDATE ${tbl} SET clean_sql=?, description=?,
             tables_used=?, lookup_types=?, joins=?,
             filters=?, security_predicate=?,
             intents=?, mechanics=? WHERE id=?`,
          [e.cleanSql, e.description, J(e.tablesUsed), J(e.lookupTypes), J(e.joins), J(e.filters), e.securityPredicate,
           J(e.intents ?? []), e.mechanics ?? null, id]);
      }
    });
  }

  /** `enrich` has no identity column on Postgres (id text PK) — page by id instead of a rowid. */
  async *iterateEnriched(): AsyncIterable<T.EnrichRow> {
    let after = "";
    for (;;) {
      const rows = await this.p.q<any>(
        `SELECT * FROM ${this.e()} WHERE description IS NOT NULL AND id > ? ORDER BY id COLLATE "C" LIMIT 500`, [after]);
      if (!rows.length) return;
      for (const r of rows) { after = r.id; yield toEnrichRow(r); }
    }
  }
}
