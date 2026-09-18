/**
 * Persistent embedding cache for column search, keyed by a CONTENT hash of "name: remarks".
 * The column text is static (from the compiled catalog), so a vector is embedded once and reused
 * forever — across searches, tables (same column text dedups), and restarts. If a column's remarks
 * are ever updated, its text hash changes → automatic cache miss → re-embed. No manual reset needed.
 * Storage: `db().colCache` (cache.sqlite `col_vec` on the sqlite provider).
 */
import crypto from "node:crypto";
import { db } from "../db/index.js";

export function textHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
}

/** Look up cached vectors by hash (batched). Missing hashes are simply absent from the map. */
export async function getVecs(hashes: string[]): Promise<Map<string, Float32Array>> {
  return db().colCache.get(hashes);
}

export async function putVecs(entries: { hash: string; vec: Float32Array }[]): Promise<void> {
  return db().colCache.put(entries);
}
