import type { RegistriesApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider, TableName } from "./provider.js";

const META_OF: Record<T.RegistryKind, TableName> = { grain: "grain_meta", usage: "usage_meta", predicates: "pred_meta" };
const TABLE_OF: Record<T.RegistryKind, TableName> = { grain: "table_grain", usage: "table_usages", predicates: "table_predicates" };

/** Boot-built registries: table_grain / table_usages / table_predicates (+ their version stamps). */
export class BaseRegistries implements RegistriesApi {
  constructor(protected p: BaseProvider) {}

  async grain(table: string): Promise<T.GrainRegistryRow | null> {
    const rows = await this.p.q<T.GrainRegistryRow>(
      `SELECT table_name, grain, multi_row, dedup, signals, corpus_evidence, note FROM ${this.p.t("table_grain")} WHERE table_name = ?`, [table]);
    return rows[0] ?? null;
  }

  async usages(table: string, limit: number): Promise<T.UsageJoinRow[]> {
    return this.p.q<T.UsageJoinRow>(
      `SELECT u.query_id AS id, u.source, u.title, u.sql_chars,
              r.filters, r.joins, r.clean_sql, r.original_sql
       FROM ${this.p.t("table_usages")} u JOIN ${this.p.t("report_queries")} r ON r.id = u.query_id
       WHERE u.table_name = ? ORDER BY u.score DESC, u.query_id${this.p.coll()} LIMIT ?`, [table, limit]);
  }

  async usageCount(table: string): Promise<number> {
    const rows = await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("table_usages")} WHERE table_name = ?`, [table]);
    return rows[0]?.c ?? 0;
  }

  async predicates(table: string): Promise<T.PredicateRow[]> {
    return this.p.q<T.PredicateRow>(
      `SELECT column_name, op, literal, occurrences, role FROM ${this.p.t("table_predicates")} WHERE table_name = ? ORDER BY occurrences DESC, column_name${this.p.coll()}, op${this.p.coll()}, literal${this.p.coll()}`, [table]);
  }

  async topPredicates(table: string, limit: number): Promise<T.PredicateStat[]> {
    return this.p.q<T.PredicateStat>(
      `SELECT column_name AS "column", op, literal, occurrences FROM ${this.p.t("table_predicates")} WHERE table_name = ? ORDER BY occurrences DESC, column_name${this.p.coll()}, op${this.p.coll()}, literal${this.p.coll()} LIMIT ?`,
      [table, limit]);
  }

  async version(kind: T.RegistryKind): Promise<string | null> {
    const rows = await this.p.q<{ v: string }>(`SELECT v FROM ${this.p.t(META_OF[kind])} WHERE k='version'`);
    return rows[0]?.v ?? null;
  }

  async setVersion(kind: T.RegistryKind, v: string): Promise<void> {
    await this.p.run(`INSERT INTO ${this.p.t(META_OF[kind])} (k,v) VALUES ('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [v]);
  }

  async count(kind: T.RegistryKind): Promise<number> {
    const rows = await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t(TABLE_OF[kind])}`);
    return rows[0]?.c ?? 0;
  }

  /** Full rebuild: clear first (UPSERT never deletes — a reclassified table would keep its stale row). */
  async replaceAll(kind: T.RegistryKind, rows: unknown[]): Promise<{ rows: number }> {
    await this.p.tx(async () => {
      await this.p.exec(`DELETE FROM ${this.p.t(TABLE_OF[kind])}`);
      if (kind === "grain") {
        for (const r of rows as T.GrainRegistryRow[]) {
          await this.p.run(
            `INSERT INTO ${this.p.t("table_grain")} (table_name, grain, multi_row, dedup, signals, corpus_evidence, note, updated_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(table_name) DO UPDATE SET grain=excluded.grain, multi_row=excluded.multi_row, dedup=excluded.dedup,
               signals=excluded.signals, corpus_evidence=excluded.corpus_evidence, note=excluded.note, updated_at=excluded.updated_at`,
            [r.table_name, r.grain, r.multi_row, r.dedup, r.signals, r.corpus_evidence, r.note, r.updated_at ?? null]);
        }
      } else if (kind === "usage") {
        for (const u of rows as T.UsageRegistryRow[]) {
          await this.p.run(
            `INSERT INTO ${this.p.t("table_usages")} (table_name, query_id, source, title, sql_chars, score) VALUES (?,?,?,?,?,?)`,
            [u.table_name, u.query_id, u.source, u.title, u.sql_chars, u.score]);
        }
      } else {
        for (const v of rows as T.PredicateRegistryRow[]) {
          await this.p.run(
            `INSERT INTO ${this.p.t("table_predicates")} (table_name, column_name, op, literal, occurrences, role) VALUES (?,?,?,?,?,?)`,
            [v.table_name, v.column_name, v.op, v.literal, v.occurrences, v.role]);
        }
      }
    });
    return { rows: rows.length };
  }
}
