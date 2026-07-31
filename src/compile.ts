/**
 * Compile step: DB_SCHEMA CSVs + mined_relationships.json  ->  schema.sqlite + reports.sqlite
 *
 * SPLIT (2026-07): the single catalog.sqlite is now built as TWO files —
 *   schema.sqlite  : tables, columns, pkeys, fkeys, indexes, relationships, tables_fts, meta
 *                    (+ version keys: schema_version / queries_version / embedding_version)
 *   reports.sqlite : report_queries (+ embedding BLOB), report_queries_fts, report_queries_vec
 * Table names are unique across the two files; at runtime catalog.ts ATTACHes one onto the other so
 * unqualified queries (FROM tables / FROM report_queries) resolve unchanged.
 *
 * Streaming CSV parse (bounded memory over the 202MB columns file), filter junk table rows to
 * TABLE/VIEW, keep only columns/keys/indexes belonging to kept objects, load declared FKs and mined
 * relationships, build FTS5 + lookup indexes.
 *
 * When materializing a corpus row's vector we store it in BOTH report_queries.embedding (BLOB) AND
 * report_queries_vec, so the vec index can be rebuilt from the blobs WITHOUT re-embedding.
 *
 * Run: node dist/compile.js   (or npm run compile:dev)
 * Env: DATA_DIR (default ./data), SCHEMA_DB (default ./schema.sqlite), REPORTS_DB (default ./reports.sqlite)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { nn, toInt } from "./util.js";
import { openEnrichStore } from "./corpus/enrichStore.js";
import { embed, EMBED_DIM } from "./corpus/embed.js";
import { readVersionFile } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
// Build outputs default to the repo root (the Dockerfile zips them from there into /app/seed).
const SCHEMA_OUT = process.env.SCHEMA_DB ?? path.join(ROOT, "schema.sqlite");
const REPORTS_OUT = process.env.REPORTS_DB ?? path.join(ROOT, "reports.sqlite");

function log(msg: string) {
  console.error(`[compile] ${msg}`);
}

/** Stream a CSV (header row -> object records) and invoke `onRow` per record. */
async function streamCsv(
  file: string,
  onRow: (row: Record<string, string>) => void,
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
    onRow(row);
    count++;
  }
  return count;
}

async function main() {
  if (fs.existsSync(SCHEMA_OUT)) fs.rmSync(SCHEMA_OUT);
  if (fs.existsSync(REPORTS_OUT)) fs.rmSync(REPORTS_OUT);
  fs.mkdirSync(path.dirname(SCHEMA_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(REPORTS_OUT), { recursive: true });

  // ============================ schema.sqlite ============================
  const db = new Database(SCHEMA_OUT);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -200000"); // ~200MB page cache during build

  db.exec(`
    CREATE TABLE tables (
      name TEXT PRIMARY KEY,
      schema TEXT,
      type TEXT,
      module TEXT,
      remarks TEXT,
      view_text TEXT
    );
    CREATE TABLE columns (
      table_name TEXT,
      name TEXT,
      data_type TEXT,
      size INTEGER,
      nullable INTEGER,
      remarks TEXT,
      ordinal INTEGER
    );
    CREATE TABLE pkeys (
      table_name TEXT,
      column_name TEXT,
      seq INTEGER
    );
    CREATE TABLE fkeys (
      child_table TEXT,
      parent_table TEXT,
      column_name TEXT,
      seq INTEGER,
      name TEXT
    );
    CREATE TABLE indexes (
      table_name TEXT,
      index_name TEXT,
      is_unique INTEGER,
      ordinal INTEGER,
      column_name TEXT
    );
    CREATE TABLE relationships (
      from_table TEXT,
      from_col TEXT,
      to_table TEXT,
      to_col TEXT,
      evidence TEXT,
      occurrences INTEGER,
      confidence TEXT,
      predicate TEXT,
      source TEXT
    );
  `);

  // ---- tables (filter to TABLE/VIEW, dedupe by name preferring FUSION schema) ----
  const kept = new Set<string>();
  const insTable = db.prepare(
    `INSERT INTO tables (name, schema, type, module, remarks, view_text)
     VALUES (@name, @schema, @type, @module, @remarks, @view_text)
     ON CONFLICT(name) DO UPDATE SET
       schema=excluded.schema, type=excluded.type, module=excluded.module,
       remarks=excluded.remarks, view_text=excluded.view_text
     WHERE excluded.schema='FUSION' AND tables.schema<>'FUSION'`,
  );
  db.exec("BEGIN");
  let tableRows = await streamCsv("META_TABLES.csv", (r) => {
    const type = (nn(r.TABLE_TYPE) ?? "").toUpperCase();
    if (type !== "TABLE" && type !== "VIEW") return;
    const name = nn(r.TABLE_NAME);
    if (!name) return;
    kept.add(name);
    insTable.run({
      name,
      schema: nn(r.TABLE_SCHEM),
      type,
      module: nn(r.APPLICATION_SHORT_NAME),
      remarks: nn(r.REMARKS),
      view_text: nn(r.VIEW_TEXT),
    });
  });
  db.exec("COMMIT");
  log(`META_TABLES: scanned ${tableRows}, kept ${kept.size} TABLE/VIEW`);

  // ---- columns (only for kept tables) ----
  const insCol = db.prepare(
    `INSERT INTO columns (table_name, name, data_type, size, nullable, remarks, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  let colScan = 0;
  let colKept = 0;
  await streamCsv("META_COLUMNS.csv", (r) => {
    colScan++;
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const name = nn(r.COLUMN_NAME);
    if (!name) return;
    const nullable = (nn(r.NULLABLE) ?? "").toUpperCase() === "Y" ? 1 : 0;
    insCol.run(
      t,
      name,
      nn(r.TYPE_NAME) ?? nn(r.DATA_TYPE),
      toInt(r.COLUMN_SIZE),
      nullable,
      nn(r.REMARKS),
      toInt(r.ORDINAL_POSITION),
    );
    colKept++;
  });
  db.exec("COMMIT");
  log(`META_COLUMNS: scanned ${colScan}, kept ${colKept}`);

  // ---- primary keys ----
  const insPk = db.prepare(
    `INSERT INTO pkeys (table_name, column_name, seq) VALUES (?, ?, ?)`,
  );
  db.exec("BEGIN");
  let pkKept = 0;
  await streamCsv("META_PKEYS.csv", (r) => {
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const c = nn(r.COLUMN_NAME);
    if (!c) return;
    insPk.run(t, c, toInt(r.PKEY_SEQUENCE));
    pkKept++;
  });
  db.exec("COMMIT");
  log(`META_PKEYS: kept ${pkKept}`);

  // ---- foreign keys (declared): TABLE=child, FOREIGN_TABLE=parent ----
  const insFk = db.prepare(
    `INSERT INTO fkeys (child_table, parent_table, column_name, seq, name) VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  let fkKept = 0;
  await streamCsv("META_FKEYS.csv", (r) => {
    const child = nn(r.TABLE);
    const parent = nn(r.FOREIGN_TABLE);
    if (!child || !parent) return;
    if (!kept.has(child) && !kept.has(parent)) return;
    insFk.run(
      child,
      parent,
      nn(r.FOREIGN_KEY_COLUMN),
      toInt(r.SEQ),
      nn(r.NAMEFULL) ?? nn(r.NAME),
    );
    fkKept++;
  });
  db.exec("COMMIT");
  log(`META_FKEYS: kept ${fkKept}`);

  // ---- indexes (NON_UNIQUE 'false' => unique) ----
  const insIdx = db.prepare(
    `INSERT INTO indexes (table_name, index_name, is_unique, ordinal, column_name) VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  let idxKept = 0;
  await streamCsv("META_INDEXES.csv", (r) => {
    const t = nn(r.TABLE_NAME);
    if (!t || !kept.has(t)) return;
    const isUnique = (nn(r.NON_UNIQUE) ?? "").toLowerCase() === "false" ? 1 : 0;
    insIdx.run(
      t,
      nn(r.INDEX_NAME),
      isUnique,
      toInt(r.ORDINAL_POSITION),
      nn(r.COLUMN_NAME),
    );
    idxKept++;
  });
  db.exec("COMMIT");
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
    const insRel = db.prepare(
      `INSERT INTO relationships (from_table, from_col, to_table, to_col, evidence, occurrences, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'mined')`,
    );
    db.exec("BEGIN");
    for (const r of relRaw) {
      if (!r.fromTable || !r.toTable) continue;
      insRel.run(
        r.fromTable,
        r.fromColumn ?? null,
        r.toTable,
        r.toColumn ?? null,
        Array.isArray(r.evidence) ? r.evidence.join(",") : null,
        r.occurrences ?? null,
        r.confidence ?? null,
      );
      relKept++;
    }
    db.exec("COMMIT");
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
    const insOtbi = db.prepare(
      `INSERT INTO relationships (from_table, from_col, to_table, to_col, predicate, source)
       VALUES (?, ?, ?, ?, ?, 'otbi')`);
    db.exec("BEGIN");
    let n = 0;
    for (const r of arr) {
      if (!r.fromTable || !r.toTable) continue;
      insOtbi.run(r.fromTable, r.fromColumn ?? null, r.toTable, r.toColumn ?? null, r.predicate || null);
      n++;
    }
    db.exec("COMMIT");
    log(`otbi_relations: kept ${n}`);
  }

  // ---- indexes for lookup ----
  log("building lookup indexes...");
  db.exec(`
    CREATE INDEX idx_columns_table ON columns(table_name);
    CREATE INDEX idx_columns_name ON columns(name);
    CREATE INDEX idx_pkeys_table ON pkeys(table_name);
    CREATE INDEX idx_fkeys_child ON fkeys(child_table);
    CREATE INDEX idx_fkeys_parent ON fkeys(parent_table);
    CREATE INDEX idx_indexes_table ON indexes(table_name);
    CREATE INDEX idx_rel_from ON relationships(from_table);
    CREATE INDEX idx_rel_to ON relationships(to_table);
  `);

  // ---- FTS5 over table name + remarks + module (contentless, rowid -> tables.rowid) ----
  log("building FTS index...");
  db.exec(`
    CREATE VIRTUAL TABLE tables_fts USING fts5(name, remarks, module, content='');
  `);
  db.exec(`
    INSERT INTO tables_fts (rowid, name, remarks, module)
    SELECT rowid, name, COALESCE(remarks,''), COALESCE(module,'') FROM tables;
  `);

  // ---- metadata (incl. version keys) + optimize ----
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);
  insMeta.run("built_at_epoch", String(Math.floor(fs.statSync(SCHEMA_OUT).mtimeMs)));
  insMeta.run("tables", String(kept.size));
  insMeta.run("columns", String(colKept));
  insMeta.run("fkeys", String(fkKept));
  insMeta.run("relationships", String(relKept));
  const V = readVersionFile();
  insMeta.run("schema_version", V.schema);
  insMeta.run("queries_version", V.queries);
  insMeta.run("embedding_version", V.embedding);

  db.pragma("journal_mode = DELETE");
  db.exec("VACUUM");
  db.exec("ANALYZE");
  db.close();
  const szSchema = (fs.statSync(SCHEMA_OUT).size / (1024 * 1024)).toFixed(1);
  log(`schema.sqlite DONE -> ${SCHEMA_OUT} (${szSchema} MB)`);

  // ============================ reports.sqlite ============================
  const rdb = new Database(REPORTS_OUT);
  rdb.pragma("journal_mode = OFF");
  rdb.pragma("synchronous = OFF");
  rdb.pragma("temp_store = MEMORY");
  loadVec(rdb);
  rdb.exec(`
    CREATE TABLE report_queries (
      id TEXT PRIMARY KEY, source TEXT, title TEXT,
      original_sql TEXT, clean_sql TEXT, description TEXT,
      tables_used TEXT, joins TEXT, filters TEXT, lookup_types TEXT,
      security_predicate TEXT, approved INTEGER, embedding BLOB
    );
    CREATE VIRTUAL TABLE report_queries_fts USING fts5(title, description, tables_used, content='');
    CREATE VIRTUAL TABLE report_queries_vec USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIM}]);
  `);

  // SHIP-SAFETY: the enrich store (Oracle-catalog-extracted SQL corpus) is excluded from the Docker
  // build context (.dockerignore). The 3 report_queries* tables above are ALWAYS created so runtime
  // ingest (poller -> /ingest) and provision (seed refresh) can populate them. Only POPULATE from
  // enrich.sqlite when the file is present (local dev builds); otherwise ship an empty report corpus.
  const ENRICH_DB = process.env.ENRICH_DB ?? path.join(DATA_DIR, "enrich.sqlite");
  if (!fs.existsSync(ENRICH_DB)) {
    log(`no enrich.sqlite (${ENRICH_DB}) — empty report corpus; poller/ingest/provision will populate`);
    rdb.pragma("journal_mode = DELETE");
    rdb.exec("VACUUM");
    rdb.exec("ANALYZE");
    rdb.close();
    const szEmpty = (fs.statSync(REPORTS_OUT).size / (1024 * 1024)).toFixed(1);
    log(`reports.sqlite DONE -> ${REPORTS_OUT} (${szEmpty} MB, report_queries=0)`);
    return;
  }

  const enrich = openEnrichStore(ENRICH_DB);
  // rowid is set explicitly on ALL three tables so the vec/FTS JOIN back to report_queries by rowid
  // is guaranteed aligned. rowid is bound as BigInt and the embedding as a Node Buffer of the Float32
  // bytes — sqlite-vec rejects a plain JS number PK ("Only integers are allowed") and a Uint8Array.
  // We store the SAME embedding buffer in report_queries.embedding so provision/migrate can rebuild
  // the vec index from the blobs without re-embedding.
  const insRq = rdb.prepare(`
    INSERT INTO report_queries (rowid, id, source, title, original_sql, clean_sql, description,
      tables_used, joins, filters, lookup_types, security_predicate, approved, embedding)
    VALUES (@rowid,@id,@source,@title,@original_sql,@clean_sql,@description,@tables_used,@joins,@filters,@lookup_types,@security_predicate,@approved,@embedding)`);
  const insFts = rdb.prepare("INSERT INTO report_queries_fts (rowid, title, description, tables_used) VALUES (?,?,?,?)");
  const insVec = rdb.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  log(`embedding report_queries descriptions...`);
  let rid = 0;
  let buf: any[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const vecs = await embed(buf.map((r) => r.description!));
    const chunk = buf; buf = [];
    const tx = rdb.transaction(() => {
      chunk.forEach((r, k) => {
        rid++;
        const emb = Buffer.from(vecs[k].buffer);
        insRq.run({ rowid: BigInt(rid), id: r.id, source: r.source, title: r.title, original_sql: r.originalSql,
          clean_sql: r.cleanSql, description: r.description,
          tables_used: JSON.stringify(r.tablesUsed), joins: JSON.stringify(r.joins),
          filters: JSON.stringify(r.filters), lookup_types: JSON.stringify(r.lookupTypes),
          security_predicate: r.securityPredicate, approved: r.approved, embedding: emb });
        insFts.run(BigInt(rid), r.title, r.description, r.tablesUsed.join(" "));
        insVec.run(BigInt(rid), emb);
      });
    });
    tx();
  };
  for (const r of enrich.iterateEnriched()) { buf.push(r); if (buf.length >= 256) await flush(); }
  await flush();
  log(`report_queries: ${rid}`);

  rdb.pragma("journal_mode = DELETE");
  rdb.exec("VACUUM");
  rdb.exec("ANALYZE");
  rdb.close();
  const szReports = (fs.statSync(REPORTS_OUT).size / (1024 * 1024)).toFixed(1);
  log(`reports.sqlite DONE -> ${REPORTS_OUT} (${szReports} MB)`);
}

main().catch((e) => {
  console.error("[compile] FAILED", e);
  process.exit(1);
});
