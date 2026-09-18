import { BaseLayout } from "../base/layout.js";
import type * as T from "../types.js";
import type { SqliteProvider } from "./provider.js";

export class SqliteLayout extends BaseLayout {
  constructor(protected p: SqliteProvider) { super(p); }

  protected insertSql(): string {
    return super.insertSql().replace(/^INSERT INTO/, "INSERT OR REPLACE INTO");
  }
  protected hashSql(): string {
    return "INSERT OR REPLACE INTO layout_meta (k, v) VALUES ('jsonl_hash', ?)";
  }

  async replaceAll(rows: T.LayoutPatternRow[], vecs: Float32Array[][], hash: string): Promise<number> {
    const d = this.p.d;
    const ins = d.prepare(this.insertSql());
    const insVec = d.prepare("INSERT INTO layout_patterns_vec (embedding, prowid) VALUES (?, ?)");
    const byId = d.prepare("SELECT rowid FROM layout_patterns WHERE id = ?");
    const setHash = d.prepare(this.hashSql());
    const verifiedAt = new Date().toISOString();
    await this.p.syncTx(() => {
      d.exec("DELETE FROM layout_patterns; DELETE FROM layout_patterns_vec;");
      rows.forEach((r, i) => {
        ins.run(...this.insertParams(r, verifiedAt));
        const prowid = (byId.get(r.id) as any).rowid;
        for (const v of vecs[i]) insVec.run(this.p.vec(v), BigInt(prowid));
      });
      setHash.run(hash);
    });
    return rows.length;
  }

  async knn(vec: Float32Array, k: number): Promise<T.LayoutDbRow[]> {
    return this.p.q<T.LayoutDbRow>(
      `SELECT p.*, p.rowid AS rid, v.distance FROM
         (SELECT prowid, distance FROM layout_patterns_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN layout_patterns p ON p.rowid = v.prowid
       ORDER BY v.distance`, [this.p.vec(vec), k]);
  }
}
