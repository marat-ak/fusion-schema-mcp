import type { ColCacheApi } from "../provider.js";
import type { BaseProvider } from "./provider.js";

/** Column-search embedding cache keyed by a content hash of "name: remarks". */
export class BaseColCache implements ColCacheApi {
  constructor(protected p: BaseProvider) {}

  /** Look up cached vectors by hash (batched). Missing hashes are simply absent from the map. */
  async get(hashes: string[]): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    if (!hashes.length) return out;
    const CH = 400;
    for (let i = 0; i < hashes.length; i += CH) {
      const chunk = hashes.slice(i, i + CH);
      const rows = await this.p.q<{ hash: string; vec: unknown }>(
        `SELECT hash, vec FROM ${this.p.t("col_vec")} WHERE hash IN (${chunk.map(() => "?").join(",")})`, chunk);
      for (const r of rows) out.set(r.hash, this.p.fromVec(r.vec));
    }
    return out;
  }

  async put(entries: { hash: string; vec: Float32Array }[]): Promise<void> {
    if (!entries.length) return;
    await this.p.tx(async () => {
      for (const e of entries) {
        await this.p.run(`INSERT INTO ${this.p.t("col_vec")} (hash, vec) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING`, [e.hash, this.p.vec(e.vec)]);
      }
    });
  }

  async wipe(): Promise<void> {
    await this.p.exec(`DELETE FROM ${this.p.t("col_vec")}`);
  }
}
