import { BaseOtbi } from "../base/otbi.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/** pgvector KNN over `otbi_vec` (HNSW-indexed by p5_index.sql; `hnsw.ef_search = 100` on the pool). */
export class PgOtbi extends BaseOtbi {
  constructor(protected p: PostgresProvider) { super(p); }

  async knn(vec: Float32Array, k: number): Promise<T.OtbiVecHit[]> {
    return this.p.q<T.OtbiVecHit>(
      `SELECT text_hash, kind, embedding <-> ?::vector AS distance FROM ${this.p.t("otbi_vec")} ORDER BY distance LIMIT ?`, [this.p.vec(vec), k]);
  }
}
