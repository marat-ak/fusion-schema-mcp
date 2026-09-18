import { BaseFlex } from "../base/flex.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/** Flexfield / ADF registries are admin-uploaded CUSTOMER data: written to `customer` and the
 *  active version schema in one transaction (D14), read from the active schema. The upserts are
 *  the portable `ON CONFLICT` form already in the base — only the dual target is new. */
export class PgFlex extends BaseFlex {
  constructor(protected p: PostgresProvider) { super(p); }

  async replaceSnapshot(kind: T.FlexKind, source: string, rows: unknown[]): Promise<number> {
    await this.p.tx(async () => {
      for (const tbl of this.p.tw(kind)) {
        await this.p.run(`DELETE FROM ${tbl} WHERE source = ?`, [source]);
        const sql = this.upsertSql(kind, tbl);
        for (const r of rows) await this.p.run(sql, r as unknown[]);
      }
    });
    return rows.length;
  }

  async applyConfigReport(fields: T.ConfigReportField[], nowIso: string): Promise<{ displayUpdated: number; inserted: number }> {
    let displayUpdated = 0, inserted = 0;
    await this.p.tx(async () => {
      for (const [i, a] of this.p.tw("adf_extensions").entries()) {
        const ins = this.insertConfigReportSql(a);
        await this.p.run(`DELETE FROM ${a} WHERE source = 'config-report'`);
        for (const f of fields) {
          const r1 = f.isCustomObject
            ? await this.p.run(
                `UPDATE ${a} SET object_display = ?, field_display = ?,
                   display_hint = coalesce(display_hint,'') || ' ' || ?
                 WHERE object_name = ? AND attribute_name = ?`, [f.objDisplay, f.fieldDisplay, f.hintAdd, f.objName, f.fieldName])
            : { changes: 0 };
          const r2 = !f.isCustomObject && f.colName
            ? await this.p.run(
                `UPDATE ${a} SET field_display = ?,
                   display_hint = coalesce(display_hint,'') || ' ' || ?
                 WHERE object_name IS NULL AND attribute_name = ? AND column_name = ?`, [f.fieldDisplay, f.hintAdd, f.fieldName, f.colName])
            : { changes: 0 };
          if (r1.changes || r2.changes) { if (i === 0) displayUpdated += r1.changes + r2.changes; continue; }
          if (!f.tableName || !f.colName) continue; // nothing to anchor an insert on
          await this.p.run(ins, [
            f.isCustomObject ? f.objName : null, f.tableName, null, f.fieldName, f.colName,
            f.hint, f.isCustomObject ? f.objDisplay : null, f.fieldDisplay, "config-report", nowIso,
          ]);
          if (i === 0) inserted++;
        }
      }
    });
    return { displayUpdated, inserted };
  }
}
