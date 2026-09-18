import { BaseSchema } from "../base/schema.js";
import type * as T from "../types.js";
import type { SqliteProvider } from "./provider.js";

export class SqliteSchema extends BaseSchema {
  constructor(protected p: SqliteProvider) { super(p); }

  /** FTS5 over table name + remarks + module: uppercase [A-Za-z0-9_] tokens as prefix terms, bm25 rank. */
  async searchTables(tokens: string[], mode: "and" | "or", limit: number): Promise<T.TableHit[]> {
    // tokens are pure [A-Za-z0-9_], safe as bareword prefix queries
    const match = tokens.map((t) => `${t}*`).join(mode === "and" ? " AND " : " OR ");
    return this.p.q<T.TableHit>(
      `SELECT t.name, t.type, t.module, t.remarks
       FROM tables_fts f JOIN tables t ON t.rowid = f.rowid
       WHERE tables_fts MATCH ? ORDER BY rank LIMIT ?`, [match, limit]);
  }

  /** Bulk insert in ONE synchronous transaction (compile.ts: 1.45M column rows). */
  async bulkLoad(table: T.SchemaLoadTable, rows: unknown[]): Promise<number> {
    const stmt = this.p.d.prepare(this.loadSql(table));
    await this.p.syncTx(() => { for (const r of rows) stmt.run(...this.loadParams(table, r)); });
    return rows.length;
  }

  /** Rebuild the contentless FTS index from `tables` (rowid-aligned). */
  async rebuildTablesFts(): Promise<void> {
    await this.p.exec(`
      INSERT INTO schemadb.tables_fts (tables_fts) VALUES ('delete-all');
      INSERT INTO schemadb.tables_fts (rowid, name, remarks, module)
      SELECT rowid, name, COALESCE(remarks,''), COALESCE(module,'') FROM schemadb.tables;
    `);
  }
}
