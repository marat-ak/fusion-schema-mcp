import type { LayoutApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

const J = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** Layout-pattern corpus (hash-gated JSONL load + multi-vector KNN). */
export class BaseLayout implements LayoutApi {
  constructor(protected p: BaseProvider) {}

  async jsonlHash(): Promise<string | null> {
    const rows = await this.p.q<{ v: string }>(`SELECT v FROM ${this.p.t("layout_meta")} WHERE k = 'jsonl_hash'`);
    return rows[0]?.v ?? null;
  }

  protected insertSql(tbl = this.p.t("layout_patterns")): string {
    return `INSERT INTO ${tbl}
    (id, kind, name, format, format_exclusive, dsl_support, description, when_to_use, intents,
     requires, composition, recipe, fixture_ref, pitfalls, trigger, why, instead, alternative,
     source_refs, verified, dsl_version, verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  }
  protected hashSql(tbl = this.p.t("layout_meta")): string {
    return `INSERT INTO ${tbl} (k, v) VALUES ('jsonl_hash', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`;
  }
  protected insertParams(r: T.LayoutPatternRow, verifiedAt: string): unknown[] {
    return [
      r.id, r.kind, r.name, r.format, r.formatExclusive ? 1 : 0, r.dslSupport,
      r.description, r.whenToUse, JSON.stringify(r.intents ?? []),
      J(r.requires), J(r.composition), J(r.recipe), r.fixtureRef ?? null, J(r.pitfalls),
      r.trigger ?? null, r.why ?? null, J(r.instead), r.alternative ?? null,
      J(r.sourceRefs), r.verified, r.dslVersion ?? null, verifiedAt,
    ];
  }

  /** Portable: identity generated on insert; one vec row per (description + each intent). */
  async replaceAll(rows: T.LayoutPatternRow[], vecs: Float32Array[][], hash: string): Promise<number> {
    const ins = this.insertSql();
    const verifiedAt = new Date().toISOString();
    await this.p.tx(async () => {
      await this.p.exec(`DELETE FROM ${this.p.t("layout_patterns")}; DELETE FROM ${this.p.t("layout_patterns_vec")};`);
      for (let i = 0; i < rows.length; i++) {
        const res = await this.p.run(ins, this.insertParams(rows[i], verifiedAt));
        for (const v of vecs[i]) {
          await this.p.run(`INSERT INTO ${this.p.t("layout_patterns_vec")} (embedding, prowid) VALUES (?, ?)`, [this.p.vec(v), this.p.idBind(res.lastInsertRowid)]);
        }
      }
      await this.p.run(this.hashSql(), [hash]);
    });
    return rows.length;
  }

  async knn(vec: Float32Array, k: number): Promise<T.LayoutDbRow[]> {
    return this.p.q<T.LayoutDbRow>(
      `SELECT p.*, p.${this.p.idCol()} AS rid, v.distance FROM
         (SELECT prowid, embedding <-> ? AS distance FROM ${this.p.t("layout_patterns_vec")} ORDER BY distance LIMIT ?) v
       JOIN ${this.p.t("layout_patterns")} p ON p.${this.p.idCol()} = v.prowid
       ORDER BY v.distance`, [this.p.vec(vec), k]);
  }

  async get(id: string): Promise<T.LayoutDbRow | null> {
    const rows = await this.p.q<T.LayoutDbRow>(`SELECT *, ${this.p.idCol()} AS rid FROM ${this.p.t("layout_patterns")} WHERE id = ?`, [id]);
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
    const rows = await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("layout_patterns")}`);
    return rows[0]?.c ?? 0;
  }
}
