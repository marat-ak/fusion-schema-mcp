/**
 * Compile step: DB_SCHEMA CSVs + mined_relationships.json  ->  schema.sqlite + reports.sqlite
 *
 * SPLIT (2026-07): the single catalog.sqlite is built as TWO files —
 *   schema.sqlite  : tables, columns, pkeys, fkeys, indexes, relationships, tables_fts, meta
 *                    (+ version keys: schema_version / queries_version / embedding_version)
 *   reports.sqlite : report_queries (+ embedding BLOB), report_queries_vec
 * Both are written through the catalog DB library (src/db, sqlite provider in build mode = bulk
 * pragmas); the DDL is the library's, so a compiled seed has exactly the runtime shape.
 *
 * Streaming CSV parse (bounded memory over the 202MB columns file), filter junk table rows to
 * TABLE/VIEW, keep only columns/keys/indexes belonging to kept objects, load declared FKs and mined
 * relationships, build FTS5 + lookup indexes.
 *
 * When materializing a corpus row's vector we store it in BOTH report_queries.embedding (BLOB) AND
 * report_queries_vec, so the vec index can be rebuilt from the blobs WITHOUT re-embedding.
 *
 * Run: node dist/compile.js   (or npm run compile:dev)
 * Env: DATA_DIR (REQUIRED — the CSV input dir), SCHEMA_DB / REPORTS_DB (build outputs, default
 *      <repo>/schema.sqlite + <repo>/reports.sqlite — zip-seed.ts reads the same), ENRICH_DB
 *      (default <DATA_DIR>/enrich.sqlite; absent = empty corpus).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import { openCatalogDb, type CatalogDb, type CorpusLoadRow } from "./db/index.js";
import { requireDataDir } from "./db/sqlite/paths.js";
import { nn, toInt } from "./util.js";
import { decodeXmlEntities, hasXmlEntities } from "./xmlEntities.js";
import { embed } from "./corpus/embed.js";
import { readVersionFile } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = requireDataDir();
// Build outputs default to the repo root (the Dockerfile zips them from there into /app/seed).
const SCHEMA_OUT = process.env.SCHEMA_DB ?? path.join(ROOT, "schema.sqlite");
const REPORTS_OUT = process.env.REPORTS_DB ?? path.join(ROOT, "reports.sqlite");
const BATCH = 50_000;

function log(msg: string) {
  console.error(`[compile] ${msg}`);
}

// XML-entity decode for dictionary text fields (the pod export left &quot;/&apos; in
// REMARKS/VIEW_TEXT — see xmlEntities.ts). Counted per call site for build verification.
let decodedCount = 0;
function dec(v: string | null): string | null {
  if (v === null) return null;
  if (!hasXmlEntities(v)) return v;
  decodedCount++;
  return decodeXmlEntities(v);
}

/** Stream a CSV (header row -> object records) and invoke `onRow` per record. */
async function streamCsv(
  file: string,
  onRow: (row: Record<string, string>) => Promise<void> | void,
): Promise<number> {
  let count = 0;
  const parser = fs.createReadStream(path.join(DATA_DIR, file)).pipe(
    parse({
      columns: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }),
  );
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    await onRow(row);
    count++;
  }
  return count;
}

/** Batches rows and flushes them through one bulkLoad per BATCH (one transaction each). */
function batcher<T>(flush: (rows: T[]) => Promise<unknown>) {
  let buf: T[] = [];
  return {
    async push(r: T) { buf.push(r); if (buf.length >= BATCH) { const b = buf; buf = []; await flush(b); } },
    async end() { if (buf.length) { const b = buf; buf = []; await flush(b); } },
  };
}

async function main() {
  if (fs.existsSync(SCHEMA_OUT)) fs.rmSync(SCHEMA_OUT);
  if (fs.existsSync(REPORTS_OUT)) fs.rmSync(REPORTS_OUT);

  // SHIP-SAFETY: the enrich store (Oracle-catalog-extracted SQL corpus) is excluded from the Docker
  // build context (.dockerignore). The report_queries tables are ALWAYS created so runtime ingest
  // (poller -> /ingest) and provision (seed refresh) can populate them. Only POPULATE from
  // enrich.sqlite when the file is present (local dev builds); otherwise ship an empty report corpus.
  const ENRICH_DB = process.env.ENRICH_DB ?? path.join(DATA_DIR, "enrich.sqlite");
  const hasEnrich = fs.existsSync(ENRICH_DB);

  const db: CatalogDb = await openCatalogDb({
    provider: "sqlite",
    files: { schema: SCHEMA_OUT, reports: REPORTS_OUT, enrich: hasEnrich ? ENRICH_DB : undefined },
    create: true,
    build: true,
  });

  // ============================ schema.sqlite ============================
  // ---- tables (filter to TABLE/VIEW, dedupe by name preferring FUSION schema) ----
  const kept = new Set<string>();
  const tb = batcher((rows) => db.schema.bulkLoad("tables", rows));
  const tableRows = await streamCsv("META_TABLES.csv", async (r) => {
    const type = (nn(r.TABLE_TYPE) ?? "").toUpperCase();
    if (type !== "TABLE" && type !== "VIEW") return;
    const name = nn(r.TABLE_NAME);
    if (!name) return;
    kept.add(name);
    await tb.push({
      name,
      schema: nn(r.TABLE_SCHEM),
      type,
      module: nn(r.APPLICATION_SHORT_NAME),
      remarks: dec(nn(r.REMARKS)),
      view_text: dec(nn(r.VIEW_TEXT)),
    });
  });
  await tb.end();
  log(`META_TABLES: scanned ${tableRows}, kept ${kept.size} TABLE/VIEW (entity-decoded values so far: ${decodedCount})`);

  // ---- columns (only for kept tables) ----
  const cb = batcher((rows) => db.schema.bulkLoad("columns", rows));
  let colScan = 0;
  let colKept = 0;
  await streamCsv("META_COLUMNS.csv", async (r) => {
    colScan++;
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const name = nn(r.COLUMN_NAME);
    if (!name) return;
    const nullable = (nn(r.NULLABLE) ?? "").toUpperCase() === "Y" ? 1 : 0;
    await cb.push([
      t,
      name,
      nn(r.TYPE_NAME) ?? nn(r.DATA_TYPE),
      toInt(r.COLUMN_SIZE),
      nullable,
      dec(nn(r.REMARKS)),
      toInt(r.ORDINAL_POSITION),
    ]);
    colKept++;
  });
  await cb.end();
  log(`META_COLUMNS: scanned ${colScan}, kept ${colKept} (entity-decoded values so far: ${decodedCount})`);

  // ---- primary keys ----
  const pb = batcher((rows) => db.schema.bulkLoad("pkeys", rows));
  let pkKept = 0;
  await streamCsv("META_PKEYS.csv", async (r) => {
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const c = nn(r.COLUMN_NAME);
    if (!c) return;
    await pb.push([t, c, toInt(r.PKEY_SEQUENCE)]);
    pkKept++;
  });
  await pb.end();
  log(`META_PKEYS: kept ${pkKept}`);

  // ---- foreign keys (declared): TABLE=child, FOREIGN_TABLE=parent ----
  const fb = batcher((rows) => db.schema.bulkLoad("fkeys", rows));
  let fkKept = 0;
  await streamCsv("META_FKEYS.csv", async (r) => {
    const child = nn(r.TABLE);
    const parent = nn(r.FOREIGN_TABLE);
    if (!child || !parent) return;
    if (!kept.has(child) && !kept.has(parent)) return;
    await fb.push([
      child,
      parent,
      nn(r.FOREIGN_KEY_COLUMN),
      toInt(r.SEQ),
      nn(r.NAMEFULL) ?? nn(r.NAME),
    ]);
    fkKept++;
  });
  await fb.end();
  log(`META_FKEYS: kept ${fkKept}`);

  // ---- indexes (NON_UNIQUE 'false' => unique) ----
  const ib = batcher((rows) => db.schema.bulkLoad("indexes", rows));
  let idxKept = 0;
  await streamCsv("META_INDEXES.csv", async (r) => {
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const isUnique = (nn(r.NON_UNIQUE) ?? "").toLowerCase() === "false" ? 1 : 0;
    await ib.push([
      t,
      nn(r.INDEX_NAME),
      isUnique,
      toInt(r.ORDINAL_POSITION),
      nn(r.COLUMN_NAME),
    ]);
    idxKept++;
  });
  await ib.end();
  log(`META_INDEXES: kept ${idxKept}`);

  // ---- mined relationships (JSON array; optional — absent in minimal build contexts) ----
  let relKept = 0;
  const minedRelPath = path.join(DATA_DIR, "mined_relationships.json");
  if (fs.existsSync(minedRelPath)) {
    const relRaw = JSON.parse(fs.readFileSync(minedRelPath, "utf8")) as Array<{
      fromTable: string;
      fromColumn: string;
      toTable: string;
      toColumn: string;
      evidence?: string[];
      occurrences?: number;
      confidence?: string;
    }>;
    const rows: unknown[] = [];
    for (const r of relRaw) {
      if (!r.fromTable || !r.toTable) continue;
      rows.push([
        r.fromTable,
        r.fromColumn ?? null,
        r.toTable,
        r.toColumn ?? null,
        Array.isArray(r.evidence) ? r.evidence.join(",") : null,
        r.occurrences ?? null,
        r.confidence ?? null,
      ]);
      relKept++;
    }
    await db.schema.bulkLoad("relationships_mined", rows);
    log(`mined_relationships: kept ${relKept}`);
  } else {
    log(`no mined_relationships.json (${minedRelPath}) — skipping mined relationships`);
  }

  // ---- OTBI relations (with predicate / outer join) ----
  const otbiRelPath = path.join(DATA_DIR, "otbi_relations.json");
  if (fs.existsSync(otbiRelPath)) {
    const arr = JSON.parse(fs.readFileSync(otbiRelPath, "utf8")) as Array<{
      fromTable: string; fromColumn: string; toTable: string; toColumn: string; predicate?: string;
    }>;
    const rows: unknown[] = [];
    for (const r of arr) {
      if (!r.fromTable || !r.toTable) continue;
      rows.push([r.fromTable, r.fromColumn ?? null, r.toTable, r.toColumn ?? null, dec(r.predicate || null)]);
    }
    await db.schema.bulkLoad("relationships_otbi", rows);
    log(`otbi_relations: kept ${rows.length} (entity-decoded values total: ${decodedCount})`);
  }

  // ---- indexes for lookup + FTS5 over table name + remarks + module ----
  log("building lookup indexes...");
  await db.meta.ensureIndexes();
  log("building FTS index...");
  await db.schema.rebuildTablesFts();

  // ---- metadata (incl. version keys) ----
  await db.meta.set("built_at_epoch", String(Math.floor(fs.statSync(SCHEMA_OUT).mtimeMs)));
  await db.meta.set("tables", String(kept.size));
  await db.meta.set("columns", String(colKept));
  await db.meta.set("fkeys", String(fkKept));
  await db.meta.set("relationships", String(relKept));
  await db.meta.setVersions(readVersionFile());

  // ============================ reports.sqlite ============================
  if (!hasEnrich) {
    log(`no enrich.sqlite (${ENRICH_DB}) — empty report corpus; poller/ingest/provision will populate`);
    await db.meta.finalizeBuild();
    await db.close();
    report(0);
    return;
  }

  // rowid is set explicitly on BOTH tables (library) so the vec JOIN back to report_queries by rowid
  // is guaranteed aligned. The SAME embedding buffer lands in report_queries.embedding so
  // provision/migrate can rebuild the vec index from the blobs without re-embedding.
  log(`embedding report_queries descriptions...`);
  let rid = 0;
  let buf: CorpusLoadRow[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const chunk = buf; buf = [];
    const vecs = await embed(chunk.map((r) => r.description));
    rid += await db.corpus.bulkLoad(chunk, vecs);
  };
  for await (const r of db.enrich.iterateEnriched()) {
    buf.push({
      id: r.id, source: r.source, title: r.title, originalSql: r.originalSql, cleanSql: r.cleanSql,
      description: r.description!, tablesUsed: r.tablesUsed, joins: r.joins, filters: r.filters,
      lookupTypes: r.lookupTypes, securityPredicate: r.securityPredicate, approved: r.approved,
    });
    if (buf.length >= 256) await flush();
  }
  await flush();
  log(`report_queries: ${rid}`);

  await db.meta.finalizeBuild();
  await db.close();
  report(rid);
}

function report(rows: number) {
  const szSchema = (fs.statSync(SCHEMA_OUT).size / (1024 * 1024)).toFixed(1);
  log(`schema.sqlite DONE -> ${SCHEMA_OUT} (${szSchema} MB)`);
  const szReports = (fs.statSync(REPORTS_OUT).size / (1024 * 1024)).toFixed(1);
  log(`reports.sqlite DONE -> ${REPORTS_OUT} (${szReports} MB, report_queries=${rows})`);
}

main().catch((e) => {
  console.error("[compile] FAILED", e);
  process.exit(1);
});
