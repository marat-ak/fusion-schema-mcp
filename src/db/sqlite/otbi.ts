import { BaseOtbi } from "../base/otbi.js";
import type * as T from "../types.js";
import type { SqliteProvider } from "./provider.js";

/** sqlite-vec shape: `otbi_vec` is a vec0 table with `text_hash` / `kind` as auxiliary columns. */
export class SqliteOtbi extends BaseOtbi {
  constructor(protected p: SqliteProvider) { super(p); }

  async knn(vec: Float32Array, k: number): Promise<T.OtbiVecHit[]> {
    return this.p.q<T.OtbiVecHit>(
      `SELECT text_hash, kind, distance FROM otbi_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`, [this.p.vec(vec), k]);
  }
}
