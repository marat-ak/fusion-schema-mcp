/**
 * SQLITE-MODE provisioning / upgrade step. Run BEFORE the server by entrypoint.sh ONLY when
 * CATALOG_DB=sqlite (postgres mode never runs it; the image bakes no seed since 2026-09-25).
 *
 * Compares the seed volume (SEED_DIR/VERSION + schema.sqlite.zip + reports.sqlite.zip — all three
 * REQUIRED, a missing one is a loud failure, never an empty DB) against the on-disk split DBs'
 * version meta (schema.sqlite `meta`) and brings the data volume up to date, per this matrix:
 *
 *   schema.sqlite missing      -> unzip seed schema.sqlite
 *   schema_version differs      -> replace schema.sqlite from seed
 *   reports.sqlite missing     -> unzip seed reports.sqlite (seeded otbi/view)
 *   queries_version differs     -> refresh rows WHERE source IN ('otbi','view') from seed reports;
 *                                  KEEP source='bip-report'; re-embed ONLY refreshed otbi/view that
 *                                  arrive without a blob; rebuild vec from ALL embedding blobs
 *   embedding_version differs   -> re-embed ALL report_queries (incl bip-report); rebuild vec;
 *                                  WIPE the column cache (col_vec)
 *   cache/enrich/facts missing -> created empty by the library at open (lazy-fill at runtime)
 *
 * Re-embedding uses the LOCAL embedder (corpus/embed.ts, no external call). Unzip uses fflate (no
 * system `unzip`/`sqlite3` needed). Version meta in schema.sqlite is refreshed to the seed values at
 * the end so the next start is a no-op. File ops stay here; every statement is a library method.
 * Env: CATALOG_DB=sqlite (required), DATA_DIR (required), SEED_DIR (required — the seed VERSION is
 * read from THERE only, never from the repo VERSION), optional *_DB overrides (src/db/sqlite/paths.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { embed } from "./corpus/embed.js";
import { openCatalogDb, type CatalogDb } from "./db/index.js";
import { sqliteFilesFromEnv, requireDataDir, type SqliteFiles } from "./db/sqlite/paths.js";
import type { Versions } from "./version.js";

function log(m: string) { console.error(`[provision] ${m}`); }

function seedDir(): string {
  const d = process.env.SEED_DIR;
  if (!d) throw new Error("SEED_DIR is required (the seed volume: VERSION + *.sqlite.zip) — no default");
  return d;
}

/** The seed's version triple: <SEED_DIR>/VERSION, all three keys required. No repo/default fallback. */
function readSeedVersion(): Versions {
  const file = path.join(seedDir(), "VERSION");
  if (!fs.existsSync(file)) throw new Error(`${file} missing — the seed volume must carry VERSION; refusing to provision`);
  const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Versions>;
  for (const k of ["schema", "queries", "embedding"] as const) {
    if (typeof v[k] !== "string" || !v[k]) throw new Error(`${file}: key "${k}" missing — refusing to provision`);
  }
  return { schema: v.schema!, queries: v.queries!, embedding: v.embedding! };
}

/** Unzip <SEED_DIR>/<name>.zip (a single-entry zip holding <name>) to destFile. Missing seed = failure. */
function unzipSeed(name: string, destFile: string): void {
  const zipPath = path.join(seedDir(), `${name}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error(`seed ${zipPath} missing — cannot provision ${name}; refusing to start on an empty DB`);
  const entry = unzipSync(fs.readFileSync(zipPath))[name];
  if (!entry) throw new Error(`seed zip ${zipPath} has no entry "${name}"`);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, Buffer.from(entry));
  log(`unzipped seed ${name} -> ${destFile} (${(entry.length / 1048576).toFixed(1)} MB)`);
}

function open(files: SqliteFiles): Promise<CatalogDb> {
  return openCatalogDb({ provider: "sqlite", files, create: true });
}

/** (Re)compute embedding blobs for the given rows (256 per embed batch). */
async function reEmbed(db: CatalogDb, targets: { rid: number; description: string | null }[]): Promise<number> {
  const B = 256;
  for (let i = 0; i < targets.length; i += B) {
    const chunk = targets.slice(i, i + B);
    const vecs = await embed(chunk.map((r) => r.description ?? ""));
    await db.corpus.setEmbeddings(chunk.map((r, k) => ({ rid: r.rid, vec: vecs[k] })));
  }
  return targets.length;
}

/** queries_version bump: replace otbi/view rows from the seed, keep bip-report, rebuild vec. */
async function refreshOtbiView(db: CatalogDb, dataDir: string) {
  const tmp = path.join(dataDir, ".seed-reports.sqlite");
  unzipSeed("reports.sqlite", tmp);
  try {
    const n = await db.corpus.replaceSourcesFromSeed(tmp, ["otbi", "view"]);
    // Re-embed ONLY the refreshed otbi/view rows that arrived without a blob.
    const reemb = await reEmbed(db, await db.corpus.rowsMissingEmbedding(["otbi", "view"]));
    await db.corpus.rebuildVectorIndex();
    log(`queries refresh: inserted ${n} otbi/view rows (re-embedded ${reemb}), rebuilt vec`);
  } finally {
    try { fs.rmSync(tmp); } catch { /* best effort */ }
    for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(tmp + ext); } catch { /* */ } }
  }
}

/** embedding_version bump: re-embed EVERY row with the current model, rebuild vec. */
async function reEmbedAll(db: CatalogDb) {
  const n = await reEmbed(db, await db.corpus.allRowsForEmbedding());
  await db.corpus.rebuildVectorIndex();
  log(`re-embedded ALL ${n} report_queries rows and rebuilt vec (embedding_version change)`);
}

async function main() {
  if (process.env.CATALOG_DB !== "sqlite") {
    throw new Error(`provisioning is the sqlite provider's boot step only (CATALOG_DB=${JSON.stringify(process.env.CATALOG_DB ?? null)}) — nothing to do for any other provider`);
  }
  const seed = readSeedVersion();
  const dataDir = requireDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const files = sqliteFilesFromEnv();

  const hadSchema = fs.existsSync(files.schema);
  const hadReports = fs.existsSync(files.reports);
  const hadCache = fs.existsSync(files.cache!);
  if (!hadSchema) unzipSeed("schema.sqlite", files.schema);
  if (!hadReports) unzipSeed("reports.sqlite", files.reports);

  let db = await open(files);
  const old: Versions | null = hadSchema ? await db.meta.versions() : null;
  log(`seed=${JSON.stringify(seed)} on-disk=${JSON.stringify(old)}`);

  // ---- schema.sqlite ----
  if (old && old.schema !== seed.schema) {
    log(`schema_version ${old.schema} -> ${seed.schema}: replacing schema.sqlite from seed`);
    await db.close();
    unzipSeed("schema.sqlite", files.schema);
    db = await open(files);
  }

  // ---- reports.sqlite ----
  if (hadReports && old) {
    if (old.queries !== seed.queries) {
      log(`queries_version ${old.queries} -> ${seed.queries}: refreshing otbi/view from seed`);
      await refreshOtbiView(db, dataDir);
    }
    if (old.embedding !== seed.embedding) {
      log(`embedding_version ${old.embedding} -> ${seed.embedding}: re-embedding all rows`);
      await reEmbedAll(db);
      await db.colCache.wipe();
      log("wiped the column-search cache (col_vec) for new embedding_version");
    }
  }

  // ---- cache.sqlite ----
  if (!hadCache) log("created empty cache.sqlite");

  // Stamp the on-disk schema meta so the next start is a no-op.
  await db.meta.setVersions(seed);
  await db.close();
  log("done");
}

main().catch((e) => {
  console.error("[provision] FAILED", e);
  process.exit(1);
});
