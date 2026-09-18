import type { FlexApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

/** FlexStore registry: flexfields (DFF/EFF) + adf_extensions (CRM/CX custom objects & fields). */
export class BaseFlex implements FlexApi {
  constructor(protected p: BaseProvider) {}

  /** Upsert text per snapshot table (portable ON CONFLICT; sqlite overrides with INSERT OR REPLACE). */
  protected upsertSql(kind: T.FlexKind, tbl = this.p.t(kind)): string {
    if (kind === "flexfields") {
      return `INSERT INTO ${tbl}
        (application_id, flexfield_type, flexfield_code, deployment_status, context_code,
         context_enabled, multirow, translatable, segment_code, column_name, sequence_number,
         segment_name, prompt, display_type, value_set_id, required, segment_enabled, source, loaded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(flexfield_type, application_id, flexfield_code, context_code, segment_code, source) DO UPDATE SET
        deployment_status=excluded.deployment_status, context_enabled=excluded.context_enabled, multirow=excluded.multirow,
        translatable=excluded.translatable, column_name=excluded.column_name, sequence_number=excluded.sequence_number,
        segment_name=excluded.segment_name, prompt=excluded.prompt, display_type=excluded.display_type,
        value_set_id=excluded.value_set_id, required=excluded.required, segment_enabled=excluded.segment_enabled, loaded_at=excluded.loaded_at`;
    }
    return `INSERT INTO ${tbl}
        (object_name, table_name, context_column_name, attribute_name, column_name, display_hint, source, loaded_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(object_name, table_name, attribute_name, column_name, source) DO UPDATE SET
        context_column_name=excluded.context_column_name, display_hint=excluded.display_hint, loaded_at=excluded.loaded_at`;
  }

  /** Snapshot-replace all rows of `source` (DELETE then re-insert) in ONE transaction. */
  async replaceSnapshot(kind: T.FlexKind, source: string, rows: unknown[]): Promise<number> {
    const sql = this.upsertSql(kind);
    await this.p.tx(async () => {
      await this.p.run(`DELETE FROM ${this.p.t(kind)} WHERE source = ?`, [source]);
      for (const r of rows) await this.p.run(sql, r as unknown[]);
    });
    return rows.length;
  }

  async queryFlexfields(q: T.FlexQuery, limit: number): Promise<any[]> {
    const cond: string[] = [];
    const bind: unknown[] = [];
    if (q.type) { cond.push("flexfield_type = ?"); bind.push(q.type.toUpperCase()); }
    if (q.flexfieldCode) { cond.push("UPPER(flexfield_code) LIKE UPPER(?)"); bind.push(`%${q.flexfieldCode}%`); }
    if (q.context) { cond.push("UPPER(context_code) LIKE UPPER(?)"); bind.push(`%${q.context}%`); }
    if (q.search) {
      cond.push("(UPPER(coalesce(segment_name,'') || ' ' || coalesce(prompt,'') || ' ' || segment_code || ' ' || context_code || ' ' || flexfield_code) LIKE UPPER(?))");
      bind.push(`%${q.search}%`);
    }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    return this.p.q<any>(
      `SELECT * FROM ${this.p.t("flexfields")} ${where} ORDER BY flexfield_type${this.p.coll()}, flexfield_code${this.p.coll()}, context_code${this.p.coll()}, sequence_number LIMIT ${limit}`, bind);
  }

  async queryAdf(q: T.AdfQuery, limit: number): Promise<any[]> {
    const cond: string[] = [];
    const bind: unknown[] = [];
    if (q.object) { cond.push("(UPPER(coalesce(object_name,'')) LIKE UPPER(?) OR coalesce(display_hint,'') LIKE ?)"); bind.push(`%${q.object}%`, `%${q.objectHint ?? ""}%`); }
    if (q.table) { cond.push("UPPER(table_name) LIKE UPPER(?)"); bind.push(`%${q.table}%`); }
    if (q.search) {
      // match API names AND the de-camelized human words (users say display names, not *_c)
      const words = q.searchWords ?? [];
      const wordCond = words.map(() => "coalesce(display_hint,'') LIKE ?").join(" AND ");
      cond.push(`(UPPER(attribute_name || ' ' || coalesce(object_name,'') || ' ' || table_name) LIKE UPPER(?)${wordCond ? ` OR (${wordCond})` : ""})`);
      bind.push(`%${q.search}%`, ...words.map((w) => `%${w}%`));
    }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    return this.p.q<any>(
      `SELECT * FROM ${this.p.t("adf_extensions")} ${where} ORDER BY object_name IS NULL, object_name${this.p.coll()}, table_name${this.p.coll()}, attribute_name${this.p.coll()} LIMIT ${limit}`, bind);
  }

  async flexfieldsCount(): Promise<T.FlexCounts> {
    const f = this.p.t("flexfields");
    const total = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${f}`))[0].c;
    const dff = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${f} WHERE flexfield_type='DFF'`))[0].c;
    const eff = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${f} WHERE flexfield_type='EFF'`))[0].c;
    const sources = await this.p.q(`SELECT source, COUNT(*) c, MAX(loaded_at) loaded_at FROM ${f} GROUP BY source`);
    return { total, dff, eff, sources };
  }

  async adfCount(): Promise<T.AdfCounts> {
    const a = this.p.t("adf_extensions");
    const total = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${a}`))[0].c;
    const customObjects = (await this.p.q<{ c: number }>(`SELECT COUNT(DISTINCT object_name) c FROM ${a} WHERE object_name IS NOT NULL`))[0].c;
    const builtinTables = (await this.p.q<{ c: number }>(`SELECT COUNT(DISTINCT table_name) c FROM ${a} WHERE object_name IS NULL`))[0].c;
    return { total, customObjects, builtinTables };
  }

  protected insertConfigReportSql(tbl = this.p.t("adf_extensions")): string {
    return `INSERT INTO ${tbl}
      (object_name, table_name, context_column_name, attribute_name, column_name,
       display_hint, object_display, field_display, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(object_name, table_name, attribute_name, column_name, source) DO UPDATE SET
      context_column_name=excluded.context_column_name, display_hint=excluded.display_hint,
      object_display=excluded.object_display, field_display=excluded.field_display, loaded_at=excluded.loaded_at`;
  }

  /** App Composer configuration report: UPDATE display names onto existing rows (by object+attribute,
   *  or attribute+column for std-object custom fields), then INSERT the rows the ADF export lacked as
   *  source='config-report'. ONE transaction. */
  async applyConfigReport(fields: T.ConfigReportField[], nowIso: string): Promise<{ displayUpdated: number; inserted: number }> {
    const a = this.p.t("adf_extensions");
    const ins = this.insertConfigReportSql();
    let displayUpdated = 0, inserted = 0;
    await this.p.tx(async () => {
      await this.p.run(`DELETE FROM ${a} WHERE source = 'config-report'`);
      for (const f of fields) {
        // custom object rows in the ADF export carry object_name; std-object custom fields have NULL
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
        if (r1.changes || r2.changes) { displayUpdated += r1.changes + r2.changes; continue; }
        if (!f.tableName || !f.colName) continue; // nothing to anchor an insert on
        await this.p.run(ins, [
          f.isCustomObject ? f.objName : null, f.tableName, null, f.fieldName, f.colName,
          f.hint, f.isCustomObject ? f.objDisplay : null, f.fieldDisplay, "config-report", nowIso,
        ]);
        inserted++;
      }
    });
    return { displayUpdated, inserted };
  }
}
