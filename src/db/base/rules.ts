import type { RulesApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

function rowToRule(r: any): T.TableRule {
  return {
    id: r.id, table: r.table_name, scope: r.scope, column: r.column_name, kind: r.kind,
    grain: r.grain, dedup: r.dedup, body: r.body ?? "", author: r.author ?? "unknown",
    source: r.source ?? "human", enabled: !!r.enabled, updatedAt: r.updated_at ?? "",
  };
}

/** Curated table rules (facts) — the human-override layer. */
export class BaseRules implements RulesApi {
  constructor(protected p: BaseProvider) {}
  protected tr() { return this.p.t("table_rules"); }

  /** Insert a new curated rule, or update an existing one when `id` is given. Returns the saved rule. */
  async upsert(a: T.UpsertArgs, nowIso: string): Promise<T.TableRule> {
    const table = a.table.toUpperCase();
    const scope = a.scope ?? (a.column ? "column" : "table");
    const column = a.column ? a.column.toUpperCase() : null;
    const enabled = a.enabled === false ? 0 : 1;
    if (a.id != null) {
      await this.p.run(
        `UPDATE ${this.tr()} SET table_name=?, scope=?, column_name=?, kind=?, grain=?, dedup=?, body=?,
           author=COALESCE(?,author), source=COALESCE(?,source), enabled=?, updated_at=? WHERE id=?`,
        [table, scope, column, a.kind, a.grain ?? null, a.dedup ?? null, a.note ?? "",
         a.author ?? null, a.source ?? null, enabled, nowIso, a.id]);
      return (await this.byId(a.id))!;
    }
    const info = await this.p.run(
      `INSERT INTO ${this.tr()} (table_name, scope, column_name, kind, grain, dedup, body, author, source, enabled, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [table, scope, column, a.kind, a.grain ?? null, a.dedup ?? null, a.note ?? "",
       a.author ?? "unknown", a.source ?? "human", enabled, nowIso]);
    return (await this.byId(Number(info.lastInsertRowid)))!;
  }

  async byId(id: number): Promise<T.TableRule | null> {
    const rows = await this.p.q<any>(`SELECT * FROM ${this.tr()} WHERE id=?`, [id]);
    return rows[0] ? rowToRule(rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const info = await this.p.run(`DELETE FROM ${this.tr()} WHERE id=?`, [id]);
    return info.changes > 0;
  }

  /** Enabled curated rules for a table (case-insensitive), newest first. */
  async forTable(table: string): Promise<T.TableRule[]> {
    const rows = await this.p.q<any>(
      `SELECT * FROM ${this.tr()} WHERE table_name=? AND enabled=1 ORDER BY updated_at DESC, id DESC`, [table.toUpperCase()]);
    return rows.map(rowToRule);
  }

  /** List rules (optionally for one table), including disabled — for management/UI. */
  async list(table?: string): Promise<T.TableRule[]> {
    const rows = table
      ? await this.p.q<any>(`SELECT * FROM ${this.tr()} WHERE table_name=? ORDER BY id DESC`, [table.toUpperCase()])
      : await this.p.q<any>(`SELECT * FROM ${this.tr()} ORDER BY table_name, id DESC`);
    return rows.map(rowToRule);
  }
}
