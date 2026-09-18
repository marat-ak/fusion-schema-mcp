import type { SchemaApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

/** Schema catalog: tables / columns / pkeys / fkeys / indexes / relationships (+ the name snapshot). */
export class BaseSchema implements SchemaApi {
  protected names: Set<string> = new Set();
  constructor(protected p: BaseProvider) {}

  tableNames(): ReadonlySet<string> { return this.names; }

  async reloadTableNames(): Promise<void> {
    const rows = await this.p.q<{ name: string }>(`SELECT name FROM ${this.p.t("tables")}`);
    this.names = new Set(rows.map((r) => r.name));
  }

  async getTable(name: string): Promise<T.TableRow | null> {
    const rows = await this.p.q<T.TableRow>(
      `SELECT name, schema, type, module, remarks, view_text FROM ${this.p.t("tables")} WHERE name = ?`, [name]);
    return rows[0] ?? null;
  }

  async moduleOf(name: string): Promise<string | undefined> {
    const rows = await this.p.q<{ module: string | null }>(`SELECT module FROM ${this.p.t("tables")} WHERE name = ?`, [name]);
    return rows[0]?.module ?? undefined;
  }

  async columns(table: string): Promise<T.ColumnRow[]> {
    return this.p.q<T.ColumnRow>(
      `SELECT name, data_type, size, nullable, remarks, ordinal
       FROM ${this.p.t("columns")} WHERE table_name = ? ORDER BY ordinal`, [table]);
  }

  async columnCount(table: string): Promise<number> {
    const rows = await this.p.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.p.t("columns")} WHERE table_name = ?`, [table]);
    return rows[0]?.n ?? 0;
  }

  async primaryKey(table: string): Promise<string[]> {
    const rows = await this.p.q<{ column_name: string }>(
      `SELECT column_name FROM ${this.p.t("pkeys")} WHERE table_name = ? ORDER BY seq`, [table]);
    return rows.map((r) => r.column_name);
  }

  async indexes(table: string): Promise<T.IndexRow[]> {
    return this.p.q<T.IndexRow>(
      `SELECT index_name, is_unique, ordinal, column_name
       FROM ${this.p.t("indexes")} WHERE table_name = ? ORDER BY index_name, ordinal`, [table]);
  }

  async fkeys(table: string): Promise<{ out: T.FkRow[]; in: T.FkRow[] }> {
    const out = await this.p.q<T.FkRow>(
      `SELECT parent_table AS other, column_name AS col, name FROM ${this.p.t("fkeys")} WHERE child_table = ?`, [table]);
    const inn = await this.p.q<T.FkRow>(
      `SELECT child_table AS other, column_name AS col, name FROM ${this.p.t("fkeys")} WHERE parent_table = ?`, [table]);
    return { out, in: inn };
  }

  async relationships(table: string): Promise<{ from: T.RelRow[]; to: T.RelRow[] }> {
    const from = await this.p.q<T.RelRow>(
      `SELECT to_table AS other, from_col, to_col, evidence, occurrences, confidence
       FROM ${this.p.t("relationships")} WHERE from_table = ?`, [table]);
    const to = await this.p.q<T.RelRow>(
      `SELECT from_table AS other, from_col, to_col, evidence, occurrences, confidence
       FROM ${this.p.t("relationships")} WHERE to_table = ?`, [table]);
    return { from, to };
  }

  /** Portable fallback (no full-text engine): prefix LIKE over name/remarks/module. Providers override. */
  async searchTables(tokens: string[], mode: "and" | "or", limit: number): Promise<T.TableHit[]> {
    const per = tokens.map(() => "(UPPER(name) LIKE ? OR UPPER(COALESCE(remarks,'')) LIKE ? OR UPPER(COALESCE(module,'')) LIKE ?)");
    const params = tokens.flatMap((tk) => [`%${tk}%`, `%${tk}%`, `%${tk}%`]);
    return this.p.q<T.TableHit>(
      `SELECT name, type, module, remarks FROM ${this.p.t("tables")}
       WHERE ${per.join(mode === "and" ? " AND " : " OR ")} ORDER BY name LIMIT ?`, [...params, limit]);
  }

  async columnSignals(): Promise<T.ColumnSignal[]> {
    return this.p.q<T.ColumnSignal>(`SELECT table_name, LOWER(name) AS col FROM ${this.p.t("columns")}`);
  }

  /** INSERT text per bulk-load target (compile.ts statements, positional params). */
  protected loadSql(table: T.SchemaLoadTable): string {
    switch (table) {
      case "tables":
        return `INSERT INTO ${this.p.t("tables")} (name, schema, type, module, remarks, view_text)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                  schema=excluded.schema, type=excluded.type, module=excluded.module,
                  remarks=excluded.remarks, view_text=excluded.view_text
                WHERE excluded.schema='FUSION' AND schema<>'FUSION'`;
      case "columns":
        return `INSERT INTO ${this.p.t("columns")} (table_name, name, data_type, size, nullable, remarks, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      case "pkeys":
        return `INSERT INTO ${this.p.t("pkeys")} (table_name, column_name, seq) VALUES (?, ?, ?)`;
      case "fkeys":
        return `INSERT INTO ${this.p.t("fkeys")} (child_table, parent_table, column_name, seq, name) VALUES (?, ?, ?, ?, ?)`;
      case "indexes":
        return `INSERT INTO ${this.p.t("indexes")} (table_name, index_name, is_unique, ordinal, column_name) VALUES (?, ?, ?, ?, ?)`;
      case "relationships_mined":
        return `INSERT INTO ${this.p.t("relationships")} (from_table, from_col, to_table, to_col, evidence, occurrences, confidence, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'mined')`;
      case "relationships_otbi":
        return `INSERT INTO ${this.p.t("relationships")} (from_table, from_col, to_table, to_col, predicate, source)
                VALUES (?, ?, ?, ?, ?, 'otbi')`;
    }
  }

  protected loadParams(table: T.SchemaLoadTable, row: unknown): unknown[] {
    if (table === "tables") {
      const r = row as T.TableLoadRow;
      return [r.name, r.schema, r.type, r.module, r.remarks, r.view_text];
    }
    return row as unknown[];
  }

  async bulkLoad(table: T.SchemaLoadTable, rows: unknown[]): Promise<number> {
    const sql = this.loadSql(table);
    return this.p.tx(async () => {
      for (const r of rows) await this.p.run(sql, this.loadParams(table, r));
      return rows.length;
    });
  }

  async rebuildTablesFts(): Promise<void> { /* no full-text index in the portable base */ }
}
