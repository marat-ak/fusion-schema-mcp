import { BaseLayout } from "../base/layout.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/** The layout corpus is code-shipped vendor data: it lives ONLY in the active version schema.
 *  `layout_patterns.rid` and `layout_patterns_vec.id` carry no identity default (ddl.sql:266,291),
 *  so both are assigned here — rid by load order, exactly like the SQLite rowids they replaced. */
export class PgLayout extends BaseLayout {
  constructor(protected p: PostgresProvider) { super(p); }

  private insertWithRid(tbl: string): string {
    return `INSERT INTO ${tbl}
    (rid, id, kind, name, format, format_exclusive, dsl_support, description, when_to_use, intents,
     requires, composition, recipe, fixture_ref, pitfalls, trigger, why, instead, alternative,
     source_refs, verified, dsl_version, verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  }

  async replaceAll(rows: T.LayoutPatternRow[], vecs: Float32Array[][], hash: string): Promise<number> {
    const pat = this.p.t("layout_patterns"), pv = this.p.t("layout_patterns_vec");
    const ins = this.insertWithRid(pat);
    const verifiedAt = new Date().toISOString();
    await this.p.tx(async () => {
      await this.p.run(`DELETE FROM ${pv}`);
      await this.p.run(`DELETE FROM ${pat}`);
      let vecId = 0;
      for (let i = 0; i < rows.length; i++) {
        const rid = i + 1;
        await this.p.run(ins, [rid, ...this.insertParams(rows[i], verifiedAt)]);
        for (const v of vecs[i]) {
          await this.p.run(`INSERT INTO ${pv} (id, prowid, embedding) VALUES (?, ?, ?)`, [++vecId, rid, this.p.vec(v)]);
        }
      }
      await this.p.run(this.hashSql(), [hash]);
    });
    return rows.length;
  }

  async knn(vec: Float32Array, k: number): Promise<T.LayoutDbRow[]> {
    return this.p.q<T.LayoutDbRow>(
      `SELECT p.*, v.distance FROM
         (SELECT prowid, embedding <-> ?::vector AS distance FROM ${this.p.t("layout_patterns_vec")} ORDER BY distance LIMIT ?) v
       JOIN ${this.p.t("layout_patterns")} p ON p.rid = v.prowid
       ORDER BY v.distance`, [this.p.vec(vec), k]);
  }
}
