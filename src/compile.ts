/**
 * Compile step: DB_SCHEMA CSVs + mined_relationships.json  ->  catalog.sqlite
 *
 * Streaming CSV parse (bounded memory over the 202MB columns file), filter junk table
 * rows to TABLE/VIEW, keep only columns/keys/indexes belonging to kept objects, load
 * declared FKs and mined relationships, build FTS5 + lookup indexes.
 *
 * Run: node dist/compile.js   (or npm run compile:dev)
 * Env: DATA_DIR (default ./data), CATALOG_DB (default ./catalog.sqlite)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import Database from "better-sqlite3";
import { nn, toInt } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
const OUT_DB = process.env.CATALOG_DB ?? path.join(ROOT, "catalog.sqlite");

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
  if (fs.existsSync(OUT_DB)) fs.rmSync(OUT_DB);
  const db = new Database(OUT_DB);
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
      confidence TEXT
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

  // ---- mined relationships (JSON array) ----
  const relRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "mined_relationships.json"), "utf8"),
  ) as Array<{
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    evidence?: string[];
    occurrences?: number;
    confidence?: string;
  }>;
  const insRel = db.prepare(
    `INSERT INTO relationships (from_table, from_col, to_table, to_col, evidence, occurrences, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  let relKept = 0;
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

  // ---- metadata + optimize ----
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);
  insMeta.run("built_at_epoch", String(Math.floor(fs.statSync(OUT_DB).mtimeMs)));
  insMeta.run("tables", String(kept.size));
  insMeta.run("columns", String(colKept));
  insMeta.run("fkeys", String(fkKept));
  insMeta.run("relationships", String(relKept));

  db.pragma("journal_mode = DELETE");
  db.exec("VACUUM");
  db.exec("ANALYZE");
  db.close();

  const sz = (fs.statSync(OUT_DB).size / (1024 * 1024)).toFixed(1);
  log(`DONE -> ${OUT_DB} (${sz} MB)`);
}

main().catch((e) => {
  console.error("[compile] FAILED", e);
  process.exit(1);
});
