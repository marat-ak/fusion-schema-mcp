/**
 * Persistent embedding cache for column search, keyed by a CONTENT hash of "name: remarks".
 * The column text is static (from the compiled catalog), so a vector is embedded once and reused
 * forever — across searches, tables (same column text dedups), and restarts. If a column's remarks
 * are ever updated, its text hash changes → automatic cache miss → re-embed. No manual reset needed.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { CACHE_DB } from "../dbPaths.js";

// The column-search embedding cache now lives in its own file cache.sqlite (env CACHE_DB, default
// <DATA_DIR>/cache.sqlite). COLCACHE_DB is still honoured (via dbPaths) for back-compat.
const DEFAULT = CACHE_DB;

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DEFAULT), { recursive: true });
  const d = new Database(DEFAULT);
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE IF NOT EXISTS col_vec (hash TEXT PRIMARY KEY, vec BLOB)");
  _db = d;
  return d;
}

export function textHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
}

function toF32(blob: Buffer): Float32Array {
  const f = new Float32Array(blob.byteLength / 4);
  Buffer.from(f.buffer, f.byteOffset, f.byteLength).set(blob);
  return f;
}

/** Look up cached vectors by hash (batched). Missing hashes are simply absent from the map. */
export function getVecs(hashes: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!hashes.length) return out;
  const d = db();
  const CH = 400;
  for (let i = 0; i < hashes.length; i += CH) {
    const chunk = hashes.slice(i, i + CH);
    const rows = d.prepare(`SELECT hash, vec FROM col_vec WHERE hash IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as any[];
    for (const r of rows) out.set(r.hash, toF32(r.vec as Buffer));
  }
  return out;
}

export function putVecs(entries: { hash: string; vec: Float32Array }[]): void {
  if (!entries.length) return;
  const d = db();
  const ins = d.prepare("INSERT OR IGNORE INTO col_vec (hash, vec) VALUES (?, ?)");
  const tx = d.transaction(() => {
    for (const e of entries) ins.run(e.hash, Buffer.from(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength));
  });
  tx();
}
