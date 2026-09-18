/**
 * DEV-ONLY raw loader (2026-09-18): the upstream artefacts -> schema `raw` in the `fusion_dev`
 * database on `stack-db`. This never ships in the image and no serving code reads it.
 *
 * Loads exactly three things, unfiltered:
 *   1. sqls.sqlite `sql_units`            - the normalised unit inventory (x_* fact tables skipped)
 *   2. data/enrich.sqlite `enrich`        - the staging/enrichment store (generation 1)
 *   3. META_*.csv                         - the vendor metadata, straight through COPY ... CSV
 *
 * Units from both stores are merged on unit_id; sqls.sqlite wins (second pass is ON CONFLICT DO
 * NOTHING) and every row records its `origin_file`.
 *
 * Every input is an explicit argument - no defaults, no env fallbacks:
 *   --sqls-sqlite       /opt/fusion-catalog-v2/sqls.sqlite   (read-only, never written)
 *   --enrich-sqlite     a WRITABLE COPY of data/enrich.sqlite (the original is WAL-mode and will
 *                       not open read-only; copy it out, load, delete the copy)
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
import postgres from "postgres";

// ---------------------------------------------------------------- args (all required, no defaults)
const REQUIRED = [
  "sqls-sqlite", "enrich-sqlite",
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

  log("--- row counts ---");
  for (const c of counts) log(`${c.table.padEnd(30)} pg=${String(c.pg).padStart(9)}  source=${c.source}  (${c.seconds.toFixed(1)}s)`);
  if (nulStripped) log(`NUL bytes stripped from ${nulStripped} field(s) (PG text cannot hold \\0)`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await sql.end({ timeout: 5 });
  sqlsDb.close();
  enrichDb.close();
}
