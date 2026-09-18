/**
 * DEV-ONLY raw loader (2026-09-18): the upstream artefacts -> schema `raw` in the `fusion_dev`
 * database on `stack-db`. This never ships in the image and no serving code reads it.
 *
 * Loads exactly four things, unfiltered:
 *   1. sqls.sqlite `sql_units`            - the normalised unit inventory (x_* fact tables skipped)
 *   2. data/enrich.sqlite `enrich`        - the staging/enrichment store (generation 1)
 *   3. META_*.csv                         - the vendor metadata, straight through COPY ... CSV
 *   4. reports.sqlite vectors             - report_queries.embedding + the two vec0 tables, lifted
 *                                           verbatim into raw.embeddings (no vector is recomputed)
 *
 * Units from both stores are merged on unit_id; sqls.sqlite wins (second pass is ON CONFLICT DO
 * NOTHING) and every row records its `origin_file`.
 *
 * Every input is an explicit argument - no defaults, no env fallbacks:
 *   --sqls-sqlite       /opt/fusion-catalog-v2/sqls.sqlite   (read-only, never written)
 *   --enrich-sqlite     a WRITABLE COPY of data/enrich.sqlite (the original is WAL-mode and will
 *                       not open read-only; copy it out, load, delete the copy)
 *   --reports-sqlite    /opt/fusion-catalog-v2/reports.sqlite (read-only: the serving corpus, the
 *                       ONLY place the vendor embeddings exist)
 *   --meta-tables-csv   META_TABLES.csv
 *   --meta-columns-csv  META_COLUMNS.csv
 *   --meta-pkeys-csv    META_PKEYS.csv
 *   --meta-fkeys-csv    META_FKEYS.csv
 *   --meta-indexes-csv  META_INDEXES.csv
 *   --database-url      postgresql://fusion_dev:<pw>@stack-db:5432/fusion_dev   (never logged)
 *   [--replace]         drop this DDL's tables first (otherwise a non-empty `raw` is refused)
 *
 * See README.md for the exact docker invocation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import postgres from "postgres";
// The runtime embedder out of the BUILT image (dist/): same worker, same model, same ONNX weights
// the serving code uses - so a re-embed here is directly comparable with what the catalog stores.
// Used ONLY to verify a text -> vector mapping (step 5); no vector is ever recomputed for storage.
import { embedBulk } from "../../dist/corpus/embed.js";
const embed = embedBulk as (texts: string[]) => Promise<Float32Array[]>;
/** verbatim from src/corpus/embedWorker.ts - the model every stored vector came from */
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
/** normalized vectors: dot == cosine. Re-embedding is deterministic, so a match is ~1.0 exactly. */
const SIM_EXACT = 0.9999;

// ---------------------------------------------------------------- args (all required, no defaults)
const REQUIRED = [
  "sqls-sqlite", "enrich-sqlite", "reports-sqlite",
  "meta-tables-csv", "meta-columns-csv", "meta-pkeys-csv", "meta-fkeys-csv", "meta-indexes-csv",
  "database-url",
] as const;
type ArgName = (typeof REQUIRED)[number];

function fail(msg: string): never {
  console.error(`[fusion-dev-load] ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { args: Record<ArgName, string>; replace: boolean } {
  const out: Partial<Record<ArgName, string>> = {};
  let replace = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replace") { replace = true; continue; }
    if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
    const name = a.slice(2) as ArgName;
    if (!REQUIRED.includes(name)) fail(`unknown argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
    out[name] = v;
  }
  for (const n of REQUIRED) if (!out[n]) fail(`--${n} is required`);
  for (const n of REQUIRED) {
    if (n === "database-url") continue;
    if (!fs.existsSync(out[n]!)) fail(`--${n}: file not found: ${out[n]}`);
  }
  return { args: out as Record<ArgName, string>, replace };
}

// ---------------------------------------------------------------- DDL
function loadDdl(): { version: string; text: string; tables: string[] } {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "ddl.sql");
  const text = fs.readFileSync(file, "utf8");
  const version = /^-- ddl_version:\s*(\S+)/m.exec(text)?.[1];
  if (!version) fail("ddl.sql: missing '-- ddl_version:' header");
  const tables = [...text.matchAll(/^CREATE TABLE raw\.(\w+)/gm)].map((m) => m[1]);
  if (!tables.length) fail("ddl.sql: no 'CREATE TABLE raw.<name>' statements found");
  return { version, text, tables };
}

// ---------------------------------------------------------------- COPY text-format encoding
let nulStripped = 0;
function enc(v: unknown): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  let s = String(v);
  if (s.includes("\0")) { nulStripped++; s = s.replaceAll("\0", ""); } // PG text cannot hold NUL
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
const strip = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v).replaceAll("\0", "");

// the dedup key of scripts/gpu-enrich/dedup_units.py, applied to the enrich store's own SQL text so
// that it lands on the same value the generated column produces for the matching unit row
const sqlKey = (s: string | null): string | null =>
  s === null ? null : crypto.createHash("md5").update(s).digest("hex");

const md5 = (v: string | Buffer): string => crypto.createHash("md5").update(v).digest("hex");

/** sqlite-vec blob -> pgvector literal. Same contract as scripts/pg-import/import.mts: exactly
 *  384 little-endian float32s, byte-copied (the sqlite Buffer carries no alignment guarantee). */
function toFloats(buf: Buffer): Float32Array {
  if (buf.length !== 384 * 4) throw new Error(`embedding blob is ${buf.length} bytes, expected 1536`);
  const f = new Float32Array(384);
  new Uint8Array(f.buffer).set(buf);
  return f;
}
const vecLiteral = (buf: Buffer): string => "[" + Array.from(toFloats(buf)).join(",") + "]";
const cos = (a: Float32Array, b: Float32Array): number => { let d = 0; for (let i = 0; i < 384; i++) d += a[i] * b[i]; return d; };

/** a JSON text column that holds an array of strings; anything else is treated as empty */
function jsonStrings(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try { const j = JSON.parse(v); return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

// ---------------------------------------------------------------- CSV jobs
type CsvJob = { arg: ArgName; table: string; header: string[]; cols: string[]; forceNull: string[] };
const CSV_JOBS: CsvJob[] = [
  {
    arg: "meta-tables-csv", table: "meta_tables",
    header: ["TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS", "REAL_TABLE_SCHEM", "REAL_TABLE_NAME",
      "FND_ID", "VIEW_TEXT", "APPLICATION_SHORT_NAME", "OBJECT_ID", "COLUMNS_LOADED", "REAL_OBJECT_TYPE"],
    cols: ["table_schem", "table_name", "table_type", "remarks", "real_table_schem", "real_table_name",
      "fnd_id", "view_text", "application_short_name", "object_id", "columns_loaded", "real_object_type"],
    forceNull: ["object_id"],
  },
  {
    arg: "meta-columns-csv", table: "meta_columns",
    header: ["TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "TYPE_NAME", "COLUMN_SIZE",
      "DECIMAL_DIGITS", "NULLABLE", "REMARKS", "CHAR_OCTET_LENGTH", "ORDINAL_POSITION"],
    cols: ["table_schem", "table_name", "column_name", "data_type", "type_name", "column_size",
      "decimal_digits", "nullable", "remarks", "char_octet_length", "ordinal_position"],
    forceNull: ["column_size", "char_octet_length", "ordinal_position"],
  },
  {
    arg: "meta-pkeys-csv", table: "meta_pkeys",
    header: ["PKEY_SEQUENCE", "COLUMN_ID", "PKEY_NAME", "PKEY_ID", "TABLE_ID", "COLUMN_NAME",
      "PHYSICAL_COLUMN_NAME", "USER_COLUMN_NAME", "PHYSICAL_TABLE_NAME", "TABLE_NAME"],
    cols: ["pkey_sequence", "column_id", "pkey_name", "pkey_id", "table_id", "column_name",
      "physical_column_name", "user_column_name", "physical_table_name", "table_name"],
    forceNull: ["pkey_sequence", "column_id", "pkey_id", "table_id"],
  },
  {
    arg: "meta-fkeys-csv", table: "meta_fkeys",
    header: ["TABLENAME", "TABLE", "FOREIGN_TABLE", "FOREIGN_KEY_COLUMN", "SEQ", "NAME", "NAMEFULL"],
    cols: ["tablename", `"table"`, "foreign_table", "foreign_key_column", "seq", "name", "namefull"],
    forceNull: ["seq"],
  },
  {
    arg: "meta-indexes-csv", table: "meta_indexes",
    header: ["TABLE_SCHEM", "TABLE_NAME", "NON_UNIQUE", "INDEX_QUALIFIER", "INDEX_NAME", "TYPE",
      "ORDINAL_POSITION", "COLUMN_NAME", "ASC_OR_DESC", "CARDINALITY", "OBJECT_ID"],
    cols: ["table_schem", "table_name", "non_unique", "index_qualifier", "index_name", "type",
      "ordinal_position", "column_name", "asc_or_desc", "cardinality", "object_id"],
    forceNull: ["type", "ordinal_position", "cardinality", "object_id"],
  },
];

/** first line of the file, split on commas outside quotes, quotes stripped */
function readHeader(file: string): string[] {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const line = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[0];
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

// ---------------------------------------------------------------- main
const { args, replace } = parseArgs(process.argv.slice(2));
const ddl = loadDdl();

const sqlsDb = new Database(args["sqls-sqlite"], { readonly: true });
const enrichDb = new Database(args["enrich-sqlite"]); // WAL store: opened read-write on a COPY
const reportsDb = new Database(args["reports-sqlite"], { readonly: true });
loadVec(reportsDb); // the vec0 virtual tables cannot even be scanned without the extension

const sql = postgres(args["database-url"], { max: 1, connect_timeout: 15, idle_timeout: 0, onnotice: () => {} });
const t0 = Date.now();
const log = (m: string) => console.log(`[fusion-dev-load +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const counts: { table: string; source: number | string; pg: number; seconds: number }[] = [];

/** stream rows (arrays of values) into COPY ... FROM STDIN, text format */
async function copyRows(table: string, cols: string[], rows: Iterable<unknown[]>): Promise<number> {
  const t1 = Date.now();
  function* chunks() {
    let buf: string[] = [];
    for (const r of rows) {
      buf.push(r.map(enc).join("\t"));
      if (buf.length >= 2000) { yield buf.join("\n") + "\n"; buf = []; }
    }
    if (buf.length) yield buf.join("\n") + "\n";
  }
  const writable = await sql.unsafe(`COPY ${table} (${cols.join(", ")}) FROM STDIN`).writable();
  await pipeline(Readable.from(chunks()), writable);
  return Date.now() - t1;
}

async function pgCount(table: string): Promise<number> {
  const [{ c }] = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return c as number;
}

try {
  await sql`SELECT 1`;

  // ------------------------------------------------------------ guard: refuse a non-empty `raw`
  const present = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'raw'`).map((r) => r.tablename as string);
  if (present.length) {
    if (!replace) fail(`schema raw is not empty (${present.join(", ")}) - pass --replace to drop and re-load`);
    const mine = ddl.tables.filter((t) => present.includes(t));
    const foreign = present.filter((t) => !ddl.tables.includes(t));
    if (mine.length) {
      log(`--replace: dropping ${mine.length} table(s): ${mine.join(", ")}`);
      await sql.unsafe(`DROP TABLE ${mine.map((t) => `raw.${t}`).join(", ")} CASCADE`);
    }
    if (foreign.length) log(`leaving ${foreign.length} table(s) this loader does not own: ${foreign.join(", ")}`);
  }

  log(`applying ddl.sql v${ddl.version} (${ddl.tables.length} tables)`);
  await sql.unsafe(ddl.text);

  // ------------------------------------------------------------ 1. units from sqls.sqlite
  const UNIT_COLS = ["id", "source", "name", "title", "original_sql", "sql_for_parse", "clean_sql",
    "parse_quality", "parse_error", "description", "description_generated", "intents", "mechanics",
    "semantics_json", "description_v2", "needs_review", "excluded_reason", "reports",
    "tables_used_old", "joins_old", "filters_old", "security_predicate_old"];
  const DEST_UNIT_COLS = ["unit_id", ...UNIT_COLS.slice(1), "origin_file"];
  {
    const src = sqlsDb.prepare(`SELECT ${UNIT_COLS.join(", ")} FROM sql_units`);
    const srcCount = (sqlsDb.prepare("SELECT COUNT(*) AS c FROM sql_units").get() as any).c as number;
    function* rows() {
      for (const r of src.raw(true).iterate() as Iterable<unknown[]>) yield [...r, "sqls.sqlite"];
    }
    const ms = await copyRows("raw.sql_units", DEST_UNIT_COLS, rows());
    const pg = await pgCount("raw.sql_units");
    counts.push({ table: "sql_units (sqls.sqlite)", source: srcCount, pg, seconds: ms / 1000 });
    log(`sql_units  <- sqls.sqlite   sqlite=${srcCount} pg=${pg} ${pg === srcCount ? "ok" : "MISMATCH"}`);
    if (pg !== srcCount) fail("sql_units row-count parity failed for sqls.sqlite");
  }

  // ------------------------------------------------------------ 2. units + enrichment from the staging store
  // Units first, via a staging table so the merge can be ON CONFLICT DO NOTHING (COPY cannot).
  const enrichTotal = (enrichDb.prepare("SELECT COUNT(*) AS c FROM enrich").get() as any).c as number;
  {
    await sql.unsafe(`CREATE UNLOGGED TABLE raw._stage_units (
      unit_id text, source text, title text, original_sql text, clean_sql text)`);
    const src = enrichDb.prepare("SELECT id, source, title, original_sql, clean_sql FROM enrich");
    const ms = await copyRows("raw._stage_units",
      ["unit_id", "source", "title", "original_sql", "clean_sql"],
      src.raw(true).iterate() as Iterable<unknown[]>);
    const staged = await pgCount("raw._stage_units");
    if (staged !== enrichTotal) fail(`staging parity failed: sqlite=${enrichTotal} pg=${staged}`);
    const before = await pgCount("raw.sql_units");
    await sql.unsafe(`INSERT INTO raw.sql_units (unit_id, source, title, original_sql, clean_sql, origin_file)
                      SELECT unit_id, source, title, original_sql, clean_sql, 'enrich.sqlite'
                        FROM raw._stage_units
                      ON CONFLICT (unit_id) DO NOTHING`);
    const after = await pgCount("raw.sql_units");
    await sql.unsafe("DROP TABLE raw._stage_units");
    counts.push({ table: "sql_units (enrich.sqlite, new)", source: enrichTotal, pg: after - before, seconds: ms / 1000 });
    log(`sql_units  <- enrich.sqlite staged=${enrichTotal} inserted=${after - before} skipped=${enrichTotal - (after - before)}`);
  }
  {
    const src = enrichDb.prepare(`SELECT id, description, tables_used, lookup_types, joins, filters,
                                         security_predicate, approved, source_hash, original_sql, clean_sql
                                    FROM enrich`);
    function* rows() {
      for (const r of src.raw(true).iterate() as Iterable<unknown[]>) {
        const [id, description, tables_used, lookup_types, joins, filters,
               security_predicate, approved, source_hash, original_sql, clean_sql] = r as any[];
        const text = strip(original_sql) ?? strip(clean_sql);
        yield [id, 1, null, null, null,                       // generation 1; model/run_id/produced_at: no attribution exists
          description, tables_used, lookup_types, joins, filters,
          security_predicate, approved, source_hash, sqlKey(text)];
      }
    }
    const ms = await copyRows("raw.enrichment",
      ["unit_id", "generation", "model", "run_id", "produced_at", "description", "tables_used",
        "lookup_types", "joins", "filters", "security_predicate", "approved", "source_hash", "sql_key"],
      rows());
    const pg = await pgCount("raw.enrichment");
    counts.push({ table: "enrichment (gen 1)", source: enrichTotal, pg, seconds: ms / 1000 });
    log(`enrichment <- enrich.sqlite sqlite=${enrichTotal} pg=${pg} ${pg === enrichTotal ? "ok" : "MISMATCH"}`);
    if (pg !== enrichTotal) fail("enrichment row-count parity failed");
  }

  // ------------------------------------------------------------ 3. unit_refs (BIP datamodel provenance)
  // The `reports` arrays live in sqls.sqlite's sql_units - the staging enrich store has no such
  // column (its table is 13 columns wide and carries no reports/intents/mechanics).
  {
    const src = sqlsDb.prepare(`SELECT id, reports FROM sql_units
                                 WHERE reports IS NOT NULL AND reports <> '' AND reports <> '[]'`);
    let units = 0, bad = 0;
    function* rows() {
      for (const r of src.raw(true).iterate() as Iterable<unknown[]>) {
        const [id, reports] = r as [string, string];
        let arr: any;
        try { arr = JSON.parse(reports); } catch { bad++; continue; }
        if (!Array.isArray(arr)) { bad++; continue; }
        units++;
        for (const el of arr) {
          if (el && typeof el === "object") yield [id, el.path ?? null, el.title ?? null, el.index ?? null];
          else bad++;
        }
      }
    }
    const ms = await copyRows("raw.unit_refs", ["unit_id", "path", "title", "idx"], rows());
    const pg = await pgCount("raw.unit_refs");
    counts.push({ table: "unit_refs", source: `${units} units`, pg, seconds: ms / 1000 });
    log(`unit_refs  <- sqls.sqlite   units_with_refs=${units} refs=${pg}${bad ? ` unparseable=${bad}` : ""}`);
  }

  // ------------------------------------------------------------ 4. vendor metadata CSVs
  for (const job of CSV_JOBS) {
    const file = args[job.arg];
    const header = readHeader(file);
    if (header.length !== job.header.length || header.some((h, i) => h !== job.header[i])) {
      fail(`${path.basename(file)}: unexpected header\n  expected: ${job.header.join(",")}\n  found:    ${header.join(",")}`);
    }
    const t1 = Date.now();
    const forceNull = job.forceNull.length ? `, FORCE_NULL (${job.forceNull.join(", ")})` : "";
    const writable = await sql
      .unsafe(`COPY raw.${job.table} (${job.cols.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true${forceNull})`)
      .writable();
    await pipeline(fs.createReadStream(file), writable);
    const pg = await pgCount(`raw.${job.table}`);
    counts.push({ table: job.table, source: path.basename(file), pg, seconds: (Date.now() - t1) / 1000 });
    log(`${job.table.padEnd(13)} <- ${path.basename(file).padEnd(18)} pg=${pg}`);
  }

  // ------------------------------------------------------------ 5. embeddings (reports.sqlite)
  // The vendor corpus vectors, lifted VERBATIM: every stored row is the exact 1536-byte blob
  // sqlite-vec holds, converted to pgvector. Embeddings are computed once, in dev, and ship inside
  // the release dump - no customer ever re-embeds the vendor corpus.
  //
  // Slot identity. In SQLite the multi vectors were inserted in embedTexts() order (description
  // (+tables) first, then one per intent) by src/db/sqlite/corpus.ts, so vec0 rowid order SHOULD
  // equal slot order within an owner. That is VERIFIED here per owner, never assumed:
  //   (a) the vectors of one owner arrive in ascending vec0 rowid during the scan, and
  //   (b) their count equals 1 + the number of non-blank intents (embedTexts() filters blanks).
  // An owner failing either check still gets its vectors, slotted by scan order, but with NO
  // text_hash - a text <-> vector mapping is never guessed.
  //
  // text_hash. Intent slots are unambiguous: every writer path embeds exactly the intent strings it
  // then stores (materialize / updateEnrichment), so slot k = intents[k-1] by construction - spot
  // checked below by re-embedding a sample. Unit slot 0 is NOT: src/ingest.ts has three call sites
  // that pass DIFFERENT `tables` arguments to embedTexts() - the freshly-modelled `e.tablesUsed`
  // (which updateEnrichment never writes back to report_queries.tables_used), `[]`, or the stored
  // list - so slot 0 is verified per row by re-embedding the reconstructed text and comparing with
  // the stored vector: hash on match, NULL on mismatch. Layout patterns have ONE writer
  // (loadLayoutPatterns) and only a couple hundred vectors, so EVERY layout slot is verified.
  const EMB_COLS = ["owner_kind", "owner_id", "slot", "text_hash", "model", "embedding"];
  {
    // ---- units: the corpus rows and their durable description vector
    type Unit = {
      id: string; text0: string; embHash: string; emb: Float32Array; intents: string[];
      hash0: string | null; slots: number; ordered: boolean;
    };
    const units = new Map<number, Unit>(); // report_queries.rowid -> unit
    for (const r of reportsDb.prepare(
      "SELECT rowid AS rid, id, description, tables_used, intents, embedding FROM report_queries").iterate() as any) {
      units.set(r.rid as number, {
        id: r.id as string,
        text0: `${r.description ?? ""}\nTables: ${jsonStrings(r.tables_used).join(", ")}`,
        embHash: md5(r.embedding as Buffer), emb: toFloats(r.embedding as Buffer),
        intents: jsonStrings(r.intents).filter((x) => x && x.trim()),
        hash0: null, slots: 0, ordered: true,
      });
    }
    log(`embeddings <- reports.sqlite report_queries=${units.size}`);

    // ---- pre-pass: slot order + slot count per owner (aux columns only - no blob is read)
    let multiTotal = 0, orphanVecs = 0, outOfOrder = 0;
    const orphanOwners = new Set<number>();
    const prevRid = new Map<number, number>();
    const slotOfVec = new Map<number, number>(); // vec0 rowid -> slot, for the KNN parity check
    for (const r of reportsDb.prepare("SELECT rowid AS rid, qrowid FROM report_queries_vec_multi").iterate() as any) {
      multiTotal++;
      const q = r.qrowid as number, rid = r.rid as number;
      const u = units.get(q);
      if (!u) { orphanVecs++; orphanOwners.add(q); continue; }
      const last = prevRid.get(q);
      if (last !== undefined && rid < last) { outOfOrder++; u.ordered = false; }
      prevRid.set(q, rid);
      slotOfVec.set(rid, u.slots);  // scan order == slot order (asserted by `ordered` above)
      u.slots++;
    }
    let countMismatch = 0;
    for (const u of units.values()) if (u.slots !== 1 + u.intents.length) countMismatch++;
    const isTrusted = (u: Unit) => u.ordered && u.slots === 1 + u.intents.length;
    log(`embeddings   multi vectors=${multiTotal} orphan=${orphanVecs} (over ${orphanOwners.size} unknown qrowids), ` +
        `slot-order violations=${outOfOrder}, slot-count != 1+intents=${countMismatch}`);

    // ---- unit slot 0: verify the reconstructed text by re-embedding it
    const trusted = [...units.entries()].filter(([, u]) => isTrusted(u));
    let slot0Derivable = 0;
    const BATCH = 512;
    for (let i = 0; i < trusted.length; i += BATCH) {
      const chunk = trusted.slice(i, i + BATCH);
      const vs = await embed(chunk.map(([, u]) => u.text0));
      chunk.forEach(([, u], k) => { if (cos(vs[k], u.emb) > SIM_EXACT) { u.hash0 = md5(u.text0); slot0Derivable++; } });
      if ((i / BATCH) % 8 === 0) log(`embeddings   slot-0 verification ${Math.min(i + BATCH, trusted.length)}/${trusted.length}`);
    }
    log(`embeddings   slot-0 text re-embeds to the stored vector for ${slot0Derivable}/${units.size} units ` +
        `(${units.size - slot0Derivable} keep text_hash NULL)`);

    // ---- COPY the unit vectors
    let slot0NotDurable = 0;
    function* unitRows() {
      const nextSlot = new Map<number, number>();
      for (const r of reportsDb.prepare(
        "SELECT rowid AS rid, qrowid, embedding FROM report_queries_vec_multi").iterate() as any) {
        const q = r.qrowid as number;
        const u = units.get(q);
        if (!u) continue; // orphan: no owner id to key it by (counted in the pre-pass)
        const slot = nextSlot.get(q) ?? 0;
        nextSlot.set(q, slot + 1);
        const blob = r.embedding as Buffer;
        if (slot === 0 && md5(blob) !== u.embHash) slot0NotDurable++;
        const hash = !isTrusted(u) ? null
          : slot === 0 ? u.hash0
          : slot - 1 < u.intents.length ? md5(u.intents[slot - 1]) : null;
        yield ["unit", u.id, slot, hash, EMBED_MODEL, vecLiteral(blob)];
      }
    }
    const msUnits = await copyRows("raw.embeddings", EMB_COLS, unitRows());
    const pgUnits = await pgCount("raw.embeddings");
    counts.push({ table: "embeddings (unit)", source: `${multiTotal} vec rows`, pg: pgUnits, seconds: msUnits / 1000 });
    log(`embeddings   units pg=${pgUnits}; slot-0 vector differs from report_queries.embedding for ${slot0NotDurable} units`);

    // ---- spot check: are the intent slots really the stored intent strings? (re-embed a sample)
    const ownerVecs = reportsDb.prepare("SELECT embedding FROM report_queries_vec_multi WHERE qrowid = ? ORDER BY rowid");
    const sample: { text: string; vec: Float32Array }[] = [];
    for (const [rid, u] of trusted.slice(0, 120)) {
      const vs = (ownerVecs.all(rid) as any[]).map((v) => toFloats(v.embedding as Buffer));
      u.intents.forEach((t, k) => { if (vs[k + 1]) sample.push({ text: t, vec: vs[k + 1] }); });
    }
    const sampleVecs = await embed(sample.map((x) => x.text));
    const intentOk = sample.filter((x, i) => cos(sampleVecs[i], x.vec) > SIM_EXACT).length;
    log(`embeddings   intent-slot spot check: ${intentOk}/${sample.length} re-embed to the stored vector`);

    // ---- layout patterns: ONE writer, a couple hundred vectors - verify every slot
    type Pat = { id: string; texts: string[]; blobs: Buffer[]; vecs: Float32Array[] };
    const patVec = reportsDb.prepare("SELECT embedding FROM layout_patterns_vec WHERE prowid = ? ORDER BY rowid");
    const patOwners = new Set<number>();
    const pats: Pat[] = [];
    for (const p of reportsDb.prepare("SELECT rowid AS rid, id, name, description, intents FROM layout_patterns").all() as any[]) {
      patOwners.add(p.rid as number);
      const blobs = (patVec.all(p.rid) as any[]).map((v) => v.embedding as Buffer);
      // loadLayoutPatterns(): `${name}. ${description}` first, then every intent, UNFILTERED
      pats.push({ id: p.id as string, texts: [`${p.name}. ${p.description}`, ...jsonStrings(p.intents)], blobs, vecs: blobs.map(toFloats) });
    }
    let patOrphan = 0;
    for (const v of reportsDb.prepare("SELECT prowid FROM layout_patterns_vec").iterate() as any) {
      if (!patOwners.has(v.prowid as number)) patOrphan++;
    }
    const patParityFail = pats.filter((p) => p.blobs.length !== p.texts.length).length;
    const flat: { p: Pat; slot: number }[] = [];
    for (const p of pats) if (p.blobs.length === p.texts.length) p.texts.forEach((_t, k) => flat.push({ p, slot: k }));
    const patVecs = await embed(flat.map((x) => x.p.texts[x.slot]));
    const patHash = new Map<string, string>(); // `${id}#${slot}` -> md5 of the verified text
    let patOk = 0;
    flat.forEach((x, i) => {
      if (cos(patVecs[i], x.p.vecs[x.slot]) > SIM_EXACT) { patHash.set(`${x.p.id}#${x.slot}`, md5(x.p.texts[x.slot])); patOk++; }
    });
    function* patRows() {
      for (const p of pats) {
        for (let slot = 0; slot < p.blobs.length; slot++) {
          yield ["layout", p.id, slot, patHash.get(`${p.id}#${slot}`) ?? null, EMBED_MODEL, vecLiteral(p.blobs[slot])];
        }
      }
    }
    const msPats = await copyRows("raw.embeddings", EMB_COLS, patRows());
    const pgAll = await pgCount("raw.embeddings");
    counts.push({ table: "embeddings (layout)", source: `${pats.length} patterns`, pg: pgAll - pgUnits, seconds: msPats / 1000 });
    log(`embeddings   layout patterns=${pats.length} vectors=${pgAll - pgUnits} text verified=${patOk}/${flat.length} ` +
        `orphan vectors=${patOrphan} count-parity failures=${patParityFail}`);

    // ---- identity: a sample of stored vectors must equal the SQLite blob float-for-float.
    // Compared by DISTANCE, not by text: pgvector prints a float4 shortest-round-trip ("0.1") while
    // JS prints the float64 widening of the same 32 bits ("0.10000000149011612") - identical value,
    // different spelling. An L2 distance of exactly 0 is element-wise equality.
    let identical = 0, identityChecked = 0;
    for (const [rid, u] of trusted.filter((_e, i) => i % Math.ceil(trusted.length / 50) === 0)) {
      const blob = (ownerVecs.all(rid) as any[])[0]?.embedding as Buffer | undefined;
      if (!blob) continue;
      const [row] = await sql`SELECT (embedding <-> ${vecLiteral(blob)}::vector)::float8 AS d FROM raw.embeddings
                               WHERE owner_kind = 'unit' AND owner_id = ${u.id} AND slot = 0`;
      identityChecked++;
      if (row && Number(row.d) === 0) identical++;
    }
    log(`embeddings   stored vector == sqlite blob (L2 distance 0): ${identical}/${identityChecked} sampled slot-0 vectors`);

    // ---- exact-KNN parity: the SAME query vector, top-10 on both sides, no invented probe text
    const [probeRid, probeUnit] = trusted[Math.floor(trusted.length / 2)];
    const probeBlob = (ownerVecs.all(probeRid) as any[])[0].embedding as Buffer;
    const liteTop = (reportsDb.prepare(
      `SELECT qrowid, rowid AS rid, distance FROM report_queries_vec_multi
        WHERE embedding MATCH ? ORDER BY distance LIMIT 10`).all(probeBlob) as any[])
      .map((r) => ({ key: `${units.get(r.qrowid as number)?.id ?? `orphan:${r.qrowid}`}#${slotOfVec.get(r.rid as number)}`, d: r.distance as number }));
    const pgTop = (await sql`SELECT owner_id, slot, (embedding <-> ${vecLiteral(probeBlob)}::vector)::float8 AS d
                               FROM raw.embeddings WHERE owner_kind = 'unit' ORDER BY d LIMIT 10`)
      .map((r) => ({ key: `${r.owner_id}#${r.slot}`, d: Number(r.d) }));
    const sameOrder = liteTop.length === pgTop.length && liteTop.every((x, i) => x.key === pgTop[i].key);
    const maxDelta = Math.max(...liteTop.map((x, i) => Math.abs(x.d - (pgTop[i]?.d ?? Infinity))));
    log(`embeddings   exact-KNN parity for ${probeUnit.id} slot 0: top-10 identical=${sameOrder} maxDistanceDelta=${maxDelta.toExponential(2)}`);
    if (!sameOrder) for (let i = 0; i < Math.max(liteTop.length, pgTop.length); i++) log(`  #${i} sqlite=${liteTop[i]?.key} pg=${pgTop[i]?.key}`);
  }

  // ------------------------------------------------------------ verification
  log("--- verification ---");
  const residual = await sql`SELECT source, COUNT(*)::int AS n FROM raw.sql_units
                              WHERE origin_file = 'enrich.sqlite' GROUP BY source ORDER BY 2 DESC`;
  for (const r of residual) log(`units only in the enrich store: source=${r.source} n=${r.n}`);

  const [dups] = await sql`SELECT COALESCE(SUM(n), 0)::int AS rows, COUNT(*)::int AS keys FROM (
      SELECT sql_key, COUNT(*)::int AS n FROM raw.sql_units
       WHERE sql_key IS NOT NULL GROUP BY sql_key HAVING COUNT(*) > 1) d`;
  log(`sql_key shared by >1 unit: ${dups.rows} rows across ${dups.keys} keys`);

  const [bip] = await sql`SELECT
      COUNT(*)::int AS bip,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM raw.sql_units c
                                      WHERE c.source = 'catalog' AND c.sql_key = b.sql_key))::int AS matched
      FROM raw.sql_units b WHERE b.source = 'bip-report'`;
  const [cat] = await sql`SELECT COUNT(DISTINCT sql_key)::int AS distinct_sql,
      COUNT(DISTINCT sql_key) FILTER (WHERE NOT EXISTS (SELECT 1 FROM raw.sql_units b
          WHERE b.source = 'bip-report' AND b.sql_key = c.sql_key))::int AS not_served
      FROM raw.sql_units c WHERE c.source = 'catalog'`;
  log(`bip-report units=${bip.bip} with a catalog row of identical SQL=${bip.matched} (missing ${bip.bip - bip.matched})`);
  log(`catalog distinct SQL=${cat.distinct_sql}, of which not present as a served bip unit=${cat.not_served}`);

  const [spot] = await sql`SELECT e.unit_id, u.source, u.origin_file,
      (e.sql_key = u.sql_key) AS sql_key_agrees, jsonb_array_length(e.tables_used) AS tables
      FROM raw.enrichment e JOIN raw.sql_units u USING (unit_id)
     WHERE e.tables_used IS NOT NULL AND jsonb_array_length(e.tables_used) > 0 LIMIT 1`;
  log(`spot check: enrichment ${spot.unit_id} joins its unit (source=${spot.source}, origin=${spot.origin_file}, sql_key agrees=${spot.sql_key_agrees}, tables_used=${spot.tables})`);

  const [orphans] = await sql`SELECT COUNT(*)::int AS c FROM raw.enrichment e
      LEFT JOIN raw.sql_units u USING (unit_id) WHERE u.unit_id IS NULL`;
  log(`enrichment rows without a unit: ${orphans.c}`);

  const embByKind = await sql`SELECT owner_kind, COUNT(*)::int AS vectors, COUNT(DISTINCT owner_id)::int AS owners,
      COUNT(text_hash)::int AS hashed, MIN(slot)::int AS min_slot, MAX(slot)::int AS max_slot
      FROM raw.embeddings GROUP BY owner_kind ORDER BY 1`;
  for (const r of embByKind)
    log(`embeddings ${String(r.owner_kind).padEnd(6)} vectors=${r.vectors} owners=${r.owners} ` +
        `text_hash set=${r.hashed} (${((100 * r.hashed) / r.vectors).toFixed(1)}%) slots ${r.min_slot}..${r.max_slot}`);

  const slotDistr = await sql`SELECT owner_kind, n, COUNT(*)::int AS owners FROM (
      SELECT owner_kind, owner_id, COUNT(*)::int AS n FROM raw.embeddings GROUP BY 1, 2) d
      GROUP BY 1, 2 ORDER BY 1, 2`;
  for (const k of ["unit", "layout"])
    log(`embeddings ${k.padEnd(6)} vectors-per-owner: ` +
        slotDistr.filter((r) => r.owner_kind === k).map((r) => `${r.n}:${r.owners}`).join(" "));

  const [hashSlot] = await sql`SELECT
      COUNT(*) FILTER (WHERE slot = 0 AND text_hash IS NULL)::int AS slot0_null,
      COUNT(*) FILTER (WHERE slot = 0)::int AS slot0,
      COUNT(*) FILTER (WHERE slot > 0 AND text_hash IS NULL)::int AS intent_null,
      COUNT(*) FILTER (WHERE slot > 0)::int AS intent
      FROM raw.embeddings`;
  log(`embeddings text_hash NULL: slot 0 ${hashSlot.slot0_null}/${hashSlot.slot0}, intent slots ${hashSlot.intent_null}/${hashSlot.intent}`);

  const [embUnits] = await sql`SELECT COUNT(DISTINCT e.owner_id)::int AS c FROM raw.embeddings e
      JOIN raw.sql_units u ON u.unit_id = e.owner_id WHERE e.owner_kind = 'unit'`;
  log(`embedding owners that are also raw.sql_units rows: ${embUnits.c} of the corpus owners`);

  log("--- row counts ---");
  for (const c of counts) log(`${c.table.padEnd(30)} pg=${String(c.pg).padStart(9)}  source=${c.source}  (${c.seconds.toFixed(1)}s)`);
  if (nulStripped) log(`NUL bytes stripped from ${nulStripped} field(s) (PG text cannot hold \\0)`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await sql.end({ timeout: 5 });
  sqlsDb.close();
  enrichDb.close();
  reportsDb.close();
}
