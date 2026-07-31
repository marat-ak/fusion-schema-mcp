/**
 * Self-provisioning / upgrade step. Run BEFORE the server (entrypoint.sh -> node dist/provision.js).
 *
 * Compares the image's baked seed (/app/seed/VERSION + schema.sqlite.zip + reports.sqlite.zip)
 * against the on-disk split DBs' version meta (schema.sqlite `meta`) and brings the data volume up
 * to date, per this matrix:
 *
 *   schema.sqlite missing      -> unzip seed schema.sqlite
 *   schema_version differs      -> replace schema.sqlite from seed
 *   reports.sqlite missing     -> unzip seed reports.sqlite (seeded otbi/view)
 *   queries_version differs     -> refresh rows WHERE source IN ('otbi','view') from seed reports;
 *                                  KEEP source='bip-report'; re-embed ONLY refreshed otbi/view that
 *                                  arrive without a blob; rebuild vec from ALL embedding blobs
 *   embedding_version differs   -> re-embed ALL report_queries (incl bip-report); rebuild vec;
 *                                  WIPE cache.sqlite (col_vec)
 *   cache.sqlite missing       -> create empty (lazy-fills at runtime)
 *
 * Re-embedding uses the LOCAL embedder (corpus/embed.ts, no external call). Unzip uses fflate (no
 * system `unzip`/`sqlite3` needed). Version meta in schema.sqlite is refreshed to the seed values at
 * the end so the next start is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { unzipSync } from "fflate";
import { embed } from "./corpus/embed.js";
import { SCHEMA_DB, REPORTS_DB, CACHE_DB, DATA_DIR, SEED_DIR, sqlQuote } from "./dbPaths.js";
import { readVersionFile, type Versions } from "./version.js";

function log(m: string) { console.error(`[provision] ${m}`); }

/** Read schema_version/queries_version/embedding_version from a schema.sqlite meta table. */
function readMetaVersions(dbFile: string): Versions | null {
  if (!fs.existsSync(dbFile)) return null;
  try {
    const d = new Database(dbFile, { readonly: true });
    const rows = d
      .prepare("SELECT key, value FROM meta WHERE key IN ('schema_version','queries_version','embedding_version')")
      .all() as { key: string; value: string }[];
    d.close();
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m.schema_version == null && m.queries_version == null && m.embedding_version == null) return null;
    return { schema: m.schema_version ?? "", queries: m.queries_version ?? "", embedding: m.embedding_version ?? "" };
  } catch {
    return null;
  }
}

/** Unzip <SEED_DIR>/<name>.zip (a single-entry zip holding <name>) to destFile. */
function unzipSeed(name: string, destFile: string): boolean {
  const zipPath = path.join(SEED_DIR, `${name}.zip`);
  if (!fs.existsSync(zipPath)) { log(`seed ${zipPath} missing — cannot provision ${name}`); return false; }
  const files = unzipSync(fs.readFileSync(zipPath));
  const entry = files[name] ?? Object.values(files)[0];
  if (!entry) { log(`seed zip ${zipPath} empty`); return false; }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, Buffer.from(entry));
  log(`unzipped seed ${name} -> ${destFile} (${(entry.length / 1048576).toFixed(1)} MB)`);
  return true;
}

/** Add the runtime-only columns to a reports.sqlite if a pre-split seed lacks them. */
function ensureReportsCols(d: Database.Database) {
  try { d.exec("ALTER TABLE report_queries ADD COLUMN reports TEXT"); } catch { /* present */ }
  try { d.exec("ALTER TABLE report_queries ADD COLUMN embedding BLOB"); } catch { /* present */ }
}

/** (Re)compute embedding blobs for report_queries rows matching `where` (empty = all). */
async function reEmbedRows(d: Database.Database, where: string): Promise<number> {
  const rows = d.prepare(`SELECT rowid, description FROM report_queries ${where}`).all() as
    { rowid: number; description: string | null }[];
  const upd = d.prepare("UPDATE report_queries SET embedding = ? WHERE rowid = ?");
  const B = 256;
  for (let i = 0; i < rows.length; i += B) {
    const chunk = rows.slice(i, i + B);
    const vecs = await embed(chunk.map((r) => r.description ?? ""));
    const tx = d.transaction(() => chunk.forEach((r, k) => upd.run(Buffer.from(vecs[k].buffer), r.rowid)));
    tx();
  }
  return rows.length;
}

/** Rebuild report_queries_vec from every report_queries.embedding blob (no re-embedding). */
function rebuildVec(d: Database.Database) {
  loadVec(d);
  d.exec("DELETE FROM report_queries_vec");
  const ins = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  const sel = d.prepare("SELECT rowid, embedding FROM report_queries WHERE embedding IS NOT NULL");
  const tx = d.transaction(() => {
    for (const r of sel.iterate() as Iterable<{ rowid: number; embedding: Buffer }>) {
      ins.run(BigInt(r.rowid), r.embedding);
    }
  });
  tx();
}

/** Rebuild the contentless FTS index from report_queries (title/description/tables_used). */
function rebuildFts(d: Database.Database) {
  d.exec("DELETE FROM report_queries_fts");
  const ins = d.prepare("INSERT INTO report_queries_fts (rowid, title, description, tables_used) VALUES (?,?,?,?)");
  const sel = d.prepare("SELECT rowid, title, description, tables_used FROM report_queries");
  const tx = d.transaction(() => {
    for (const r of sel.iterate() as Iterable<any>) {
      let tu = "";
      try { const a = JSON.parse(r.tables_used ?? "[]"); tu = Array.isArray(a) ? a.join(" ") : String(r.tables_used ?? ""); }
      catch { tu = String(r.tables_used ?? ""); }
      ins.run(BigInt(r.rowid), r.title, r.description, tu);
    }
  });
  tx();
}

/** queries_version bump: replace otbi/view rows from the seed, keep bip-report, rebuild vec+fts. */
async function refreshOtbiView() {
  const tmp = path.join(DATA_DIR, ".seed-reports.sqlite");
  if (!unzipSeed("reports.sqlite", tmp)) return;
  try {
    const d = new Database(REPORTS_DB);
    ensureReportsCols(d);
    d.exec(`ATTACH DATABASE '${sqlQuote(tmp)}' AS seed`);
    const seedRows = d
      .prepare("SELECT * FROM seed.report_queries WHERE source IN ('otbi','view') ORDER BY rowid")
      .all() as any[];
    const seedCols = new Set(
      (d.prepare("SELECT name FROM pragma_table_info('report_queries', 'seed')").all() as any[]).map((c) => c.name),
    );
    const ins = d.prepare(
      `INSERT INTO report_queries
         (rowid, id, source, title, original_sql, clean_sql, description,
          tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding)
       VALUES (@rowid,@id,@source,@title,@original_sql,@clean_sql,@description,
               @tables_used,@joins,@filters,@lookup_types,@security_predicate,@approved,@reports,@embedding)`,
    );
    const tx = d.transaction(() => {
      d.prepare("DELETE FROM report_queries WHERE source IN ('otbi','view')").run();
      let next = (d.prepare("SELECT COALESCE(MAX(rowid),0) AS m FROM report_queries").get() as any).m as number;
      for (const r of seedRows) {
        ins.run({
          rowid: BigInt(++next), id: r.id, source: r.source, title: r.title,
          original_sql: r.original_sql, clean_sql: r.clean_sql, description: r.description,
          tables_used: r.tables_used ?? "[]", joins: r.joins ?? "[]", filters: r.filters ?? "[]",
          lookup_types: r.lookup_types ?? "[]", security_predicate: r.security_predicate ?? null,
          approved: r.approved ?? 1, reports: seedCols.has("reports") ? (r.reports ?? "[]") : "[]",
          embedding: seedCols.has("embedding") ? (r.embedding ?? null) : null,
        });
      }
    });
    tx();
    d.exec("DETACH DATABASE seed");
    // Re-embed ONLY the refreshed otbi/view rows that arrived without a blob.
    const reemb = await reEmbedRows(d, "WHERE source IN ('otbi','view') AND embedding IS NULL");
    rebuildVec(d);
    rebuildFts(d);
    d.close();
    log(`queries refresh: inserted ${seedRows.length} otbi/view rows (re-embedded ${reemb}), rebuilt vec+fts`);
  } finally {
    try { fs.rmSync(tmp); } catch { /* best effort */ }
    for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(tmp + ext); } catch { /* */ } }
  }
}

/** embedding_version bump: re-embed EVERY row with the current model, rebuild vec. */
async function reEmbedAll() {
  const d = new Database(REPORTS_DB);
  ensureReportsCols(d);
  const n = await reEmbedRows(d, "");
  rebuildVec(d);
  d.close();
  log(`re-embedded ALL ${n} report_queries rows and rebuilt vec (embedding_version change)`);
}

function ensureCache() {
  fs.mkdirSync(path.dirname(CACHE_DB), { recursive: true });
  const d = new Database(CACHE_DB);
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE IF NOT EXISTS col_vec (hash TEXT PRIMARY KEY, vec BLOB)");
  d.close();
}

function wipeCache() {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(CACHE_DB + ext); } catch { /* */ } }
  ensureCache();
  log("wiped cache.sqlite (col_vec) for new embedding_version");
}

function writeSchemaVersions(seed: Versions) {
  if (!fs.existsSync(SCHEMA_DB)) return;
  const d = new Database(SCHEMA_DB);
  d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const up = d.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  up.run("schema_version", seed.schema);
  up.run("queries_version", seed.queries);
  up.run("embedding_version", seed.embedding);
  d.close();
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seedVersionFile = path.join(SEED_DIR, "VERSION");
  const seed = fs.existsSync(seedVersionFile) ? readVersionFile(seedVersionFile) : readVersionFile();
  const old = readMetaVersions(SCHEMA_DB);
  log(`seed=${JSON.stringify(seed)} on-disk=${JSON.stringify(old)}`);

  // ---- schema.sqlite ----
  if (!fs.existsSync(SCHEMA_DB)) {
    unzipSeed("schema.sqlite", SCHEMA_DB);
  } else if (old && old.schema !== seed.schema) {
    log(`schema_version ${old.schema} -> ${seed.schema}: replacing schema.sqlite from seed`);
    unzipSeed("schema.sqlite", SCHEMA_DB);
  }

  // ---- reports.sqlite ----
  if (!fs.existsSync(REPORTS_DB)) {
    unzipSeed("reports.sqlite", REPORTS_DB);
  } else if (old) {
    if (old.queries !== seed.queries) {
      log(`queries_version ${old.queries} -> ${seed.queries}: refreshing otbi/view from seed`);
      await refreshOtbiView();
    }
    if (old.embedding !== seed.embedding) {
      log(`embedding_version ${old.embedding} -> ${seed.embedding}: re-embedding all rows`);
      await reEmbedAll();
      wipeCache();
    }
  }

  // ---- cache.sqlite ----
  if (!fs.existsSync(CACHE_DB)) { ensureCache(); log("created empty cache.sqlite"); }

  // Stamp the on-disk schema meta so the next start is a no-op.
  writeSchemaVersions(seed);
  log("done");
}

main().catch((e) => {
  console.error("[provision] FAILED", e);
  process.exit(1);
});
