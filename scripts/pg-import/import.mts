/**
 * DEV-ONLY importer (D13, 2026-09-18): the live v2 SQLite catalog → the `fusion` database on `stack-db`.
 *
 * Reads every SQLite file READ-ONLY (`readonly: true`), creates `meta` + `customer` (idempotent) and
 * the version schema `v<version>` (refused if it exists unless --replace), streams every table through
 * COPY FROM STDIN (text format, one statement = one transaction per table), then checks row-count
 * parity per table, writes `meta.seeds` and points `meta.active_version` at the new schema.
 * Serving code is untouched: this is the one-off seed of the vendor data; the future upgrade job
 * restores a pg_dump of this schema instead.
 *
 * Every input is an explicit argument — no defaults, no env fallbacks:
 *   --schema-sqlite   schema.sqlite   (tables/columns/pkeys/fkeys/indexes/relationships/meta)
 *   --reports-sqlite  reports.sqlite  (corpus + vectors + registries + flex/adf + layout corpus)
 *   --enrich-sqlite   enrich.sqlite   (enrich store)
 *   --facts-sqlite    facts.sqlite    (table_rules)
 *   --colcache-sqlite colcache.sqlite (col_vec)
 *   --database-url    postgresql://fusion:<pw>@host:5432/fusion   (never logged)
 *   --version         2026_09         → schema v2026_09
 *   [--replace]       drop an existing v<version> schema first
 *
 * Run inside the schema-mcp image (linux better-sqlite3 + sqlite-vec) with the `postgres` client
 * mounted in, from WSL (`wsl -d CloudBeaver -u root -e bash -lc`):
 *   docker run --rm --network host \
 *     -v /opt/fusion-catalog-v2:/v2:ro \
 *     -v <repo>/scripts/pg-import:/app/scripts/pg-import:ro \
 *     -v <dir with node_modules/postgres>/node_modules/postgres:/app/node_modules/postgres:ro \
 *     --entrypoint node gnimsys/fusion-schema-mcp:latest node_modules/.bin/tsx scripts/pg-import/import.mts \
 *     --schema-sqlite /v2/schema.sqlite --reports-sqlite /v2/reports.sqlite --enrich-sqlite /v2/enrich.sqlite \
 *     --facts-sqlite /v2/facts.sqlite --colcache-sqlite /v2/colcache.sqlite \
 *     --database-url "$URL" --version 2026_09
 *
 * NOT imported (dead in the SQLite files — no reader in src/): unit_aliases, enrich_usage, batch_jobs,
 * batch_items, gjob_jobs, gjob_items, gjob_control, report_queries_fts (+ shadow tables), sqlite_stat*.
 * report_queries_vec is folded into report_queries.embedding (same 384-float blob per row).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import postgres from "postgres";

// ---------------------------------------------------------------- args (all required, no defaults)
const REQUIRED = ["schema-sqlite", "reports-sqlite", "enrich-sqlite", "facts-sqlite", "colcache-sqlite", "database-url", "version"] as const;
type ArgName = (typeof REQUIRED)[number];

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
  for (const n of REQUIRED) if (n.endsWith("-sqlite") && !fs.existsSync(out[n]!)) fail(`--${n}: file not found: ${out[n]}`);
  if (!/^\d{4}_\d{2}$/.test(out.version!)) fail(`--version must look like 2026_09 (got ${out.version})`);
  return { args: out as Record<ArgName, string>, replace };
}

function fail(msg: string): never {
  console.error(`[pg-import] ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- DDL blocks
function loadDdl(): { version: string; blocks: Record<string, string> } {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "ddl.sql");
  const text = fs.readFileSync(file, "utf8");
  const version = /^-- ddl_version:\s*(\S+)/m.exec(text)?.[1];
  if (!version) fail("ddl.sql: missing '-- ddl_version:' header");
  const blocks: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^-- @block (\w+)/.exec(line);
    if (m) { cur = m[1]; blocks[cur] = ""; continue; }
    if (cur) blocks[cur] += line + "\n";
  }
  for (const b of ["meta", "corpus", "vendor"]) if (!blocks[b]) fail(`ddl.sql: missing @block ${b}`);
  return { version, blocks };
}

// ---------------------------------------------------------------- COPY encoding (text format)
let nulStripped = 0;
function vecLiteral(buf: Buffer): string {
  if (buf.length !== 384 * 4) throw new Error(`embedding blob is ${buf.length} bytes, expected 1536`);
  const f = new Float32Array(384);
  new Uint8Array(f.buffer).set(buf); // byte copy: no alignment assumptions on the sqlite Buffer
  return "[" + Array.from(f).join(",") + "]";
}
function enc(v: unknown): string {
  if (v === null || v === undefined) return "\\N";
  if (Buffer.isBuffer(v)) return vecLiteral(v);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  let s = String(v);
  if (s.includes("\0")) { nulStripped++; s = s.replaceAll("\0", ""); } // PG text cannot hold NUL
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

// ---------------------------------------------------------------- jobs
type Src = "schema" | "reports" | "enrich" | "facts" | "colcache";
type Job = {
  src: Src;
  table: string;              // destination table (in the version schema)
  select: string;             // sqlite SELECT producing exactly `cols` (constants appended by `extra`)
  from: string;               // sqlite table for the source count
  cols: string[];
  extra?: string[];           // constant trailing values (e.g. origin='vendor'), appended per row
};
const RQ_COLS = ["id", "source", "title", "original_sql", "clean_sql", "description", "tables_used", "joins", "filters",
  "lookup_types", "security_predicate", "approved", "reports", "embedding", "intents", "mechanics", "semantics_json", "low_confidence"];
const FLEX_COLS = ["application_id", "flexfield_type", "flexfield_code", "deployment_status", "context_code", "context_enabled",
  "multirow", "translatable", "segment_code", "column_name", "sequence_number", "segment_name", "prompt", "display_type",
  "value_set_id", "required", "segment_enabled", "source", "loaded_at"];
const ADF_COLS = ["object_name", "table_name", "context_column_name", "attribute_name", "column_name", "source", "loaded_at",
  "display_hint", "object_display", "field_display"];
const LAYOUT_COLS = ["id", "kind", "name", "format", "format_exclusive", "dsl_support", "description", "when_to_use", "intents",
  "requires", "composition", "recipe", "fixture_ref", "pitfalls", "trigger", "why", "instead", "alternative", "source_refs",
  "verified", "dsl_version", "verified_at"];
const ENRICH_COLS = ["id", "source", "title", "source_hash", "original_sql", "clean_sql", "description", "tables_used",
  "lookup_types", "joins", "filters", "security_predicate", "approved", "reports", "intents", "mechanics"];
const RULE_COLS = ["id", "table_name", "scope", "column_name", "kind", "grain", "dedup", "body", "author", "source", "enabled", "updated_at"];

const plain = (src: Src, table: string, cols: string[], from = table): Job =>
  ({ src, table, from, cols, select: `SELECT ${cols.join(", ")} FROM ${from}` });

const JOBS: Job[] = [
  // schema.sqlite
  plain("schema", "catalog_meta", ["key", "value"], "meta"),
  plain("schema", "tables", ["name", "schema", "type", "module", "remarks", "view_text"]),
  plain("schema", "columns", ["table_name", "name", "data_type", "size", "nullable", "remarks", "ordinal"]),
  plain("schema", "pkeys", ["table_name", "column_name", "seq"]),
  plain("schema", "fkeys", ["child_table", "parent_table", "column_name", "seq", "name"]),
  plain("schema", "indexes", ["table_name", "index_name", "is_unique", "ordinal", "column_name"]),
  plain("schema", "relationships", ["from_table", "from_col", "to_table", "to_col", "evidence", "occurrences", "confidence", "predicate", "source"]),
  // reports.sqlite — corpus (origin set EXPLICITLY per row, never via the column default)
  { src: "reports", table: "report_queries", from: "report_queries", cols: ["rid", ...RQ_COLS, "origin"],
    select: `SELECT rowid AS rid, ${RQ_COLS.join(", ")} FROM report_queries`, extra: ["vendor"] },
  { src: "reports", table: "report_queries_vec_multi", from: "report_queries_vec_multi", cols: ["id", "qrowid", "embedding"],
    select: "SELECT rowid AS id, qrowid, embedding FROM report_queries_vec_multi" },
  plain("reports", "flexfields", FLEX_COLS),
  plain("reports", "adf_extensions", ADF_COLS),
  // reports.sqlite — registries
  plain("reports", "table_usages", ["table_name", "query_id", "source", "title", "sql_chars", "score"]),
  plain("reports", "usage_meta", ["k", "v"]),
  plain("reports", "table_predicates", ["table_name", "column_name", "op", "literal", "occurrences", "role"]),
  plain("reports", "pred_meta", ["k", "v"]),
  plain("reports", "table_join_columns", ["table_name", "column_name", "units", "share"]),
  plain("reports", "table_grain", ["table_name", "grain", "multi_row", "dedup", "signals", "corpus_evidence", "note", "updated_at"]),
  plain("reports", "grain_meta", ["k", "v"]),
  // reports.sqlite — layout corpus
  { src: "reports", table: "layout_patterns", from: "layout_patterns", cols: ["rid", ...LAYOUT_COLS],
    select: `SELECT rowid AS rid, ${LAYOUT_COLS.join(", ")} FROM layout_patterns` },
  { src: "reports", table: "layout_patterns_vec", from: "layout_patterns_vec", cols: ["id", "prowid", "embedding"],
    select: "SELECT rowid AS id, prowid, embedding FROM layout_patterns_vec" },
  plain("reports", "layout_meta", ["k", "v"]),
  // enrich.sqlite / facts.sqlite / colcache.sqlite
  plain("enrich", "enrich", ENRICH_COLS),
  plain("facts", "table_rules", RULE_COLS),
  plain("facts", "facts_meta", ["k", "v"]),
  plain("colcache", "col_vec", ["hash", "vec"]),
];

// ---------------------------------------------------------------- main
const { args, replace } = parseArgs(process.argv.slice(2));
const V = `v${args.version}`;
const ddl = loadDdl();

const dbs: Record<Src, Database.Database> = {
  schema: new Database(args["schema-sqlite"], { readonly: true }),
  reports: new Database(args["reports-sqlite"], { readonly: true }),
  enrich: new Database(args["enrich-sqlite"], { readonly: true }),
  facts: new Database(args["facts-sqlite"], { readonly: true }),
  colcache: new Database(args["colcache-sqlite"], { readonly: true }),
};
loadVec(dbs.reports); // vec0 tables (report_queries_vec_multi, layout_patterns_vec) need the extension to scan

const sql = postgres(args["database-url"], { max: 2, connect_timeout: 10, idle_timeout: 10, onnotice: () => {} });
const t0 = Date.now();
const log = (m: string) => console.log(`[pg-import +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

try {
  await sql`SELECT 1`;
  const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${V}) AS exists`;
  if (exists) {
    if (!replace) fail(`schema ${V} already exists — pass --replace to drop and re-import it`);
    log(`dropping existing schema ${V}`);
    await sql.unsafe(`DROP SCHEMA ${V} CASCADE`);
  }

  log(`applying DDL v${ddl.version}: meta, corpus(${V}), corpus(customer), vendor(${V})`);
  await sql.unsafe(ddl.blocks.meta);
  await sql.unsafe(ddl.blocks.corpus.replaceAll("{{S}}", V));
  await sql.unsafe(ddl.blocks.corpus.replaceAll("{{S}}", "customer"));
  await sql.unsafe(ddl.blocks.vendor.replaceAll("{{V}}", V));

  const parity: { table: string; sqlite: number; pg: number; seconds: number }[] = [];
  for (const job of JOBS) {
    const src = dbs[job.src];
    const srcCount = (src.prepare(`SELECT COUNT(*) AS c FROM ${job.from}`).get() as any).c as number;
    const stmt = src.prepare(job.select);
    const t1 = Date.now();
    function* chunks() {
      let buf: string[] = [];
      for (const r of stmt.raw(true).iterate() as Iterable<unknown[]>) {
        const vals = job.extra ? [...r, ...job.extra] : r;
        buf.push(vals.map(enc).join("\t"));
        if (buf.length >= 2000) { yield buf.join("\n") + "\n"; buf = []; }
      }
      if (buf.length) yield buf.join("\n") + "\n";
    }
    const writable = await sql`COPY ${sql(V)}.${sql(job.table)} (${sql(job.cols)}) FROM STDIN`.writable();
    await pipeline(Readable.from(chunks()), writable);
    const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM ${sql(V)}.${sql(job.table)}`;
    const seconds = (Date.now() - t1) / 1000;
    parity.push({ table: job.table, sqlite: srcCount, pg: c, seconds });
    log(`${job.table.padEnd(26)} sqlite=${String(srcCount).padStart(9)} pg=${String(c).padStart(9)} ${c === srcCount ? "ok" : "MISMATCH"} (${seconds.toFixed(1)}s)`);
  }
  const bad = parity.filter((p) => p.sqlite !== p.pg);
  if (bad.length) fail(`row-count parity failed for: ${bad.map((b) => b.table).join(", ")}`);

  // identity sequences past the copied keys (COPY with explicit values does not advance them)
  for (const [table, col] of [["report_queries", "rid"], ["report_queries_vec_multi", "id"], ["table_rules", "id"]]) {
    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${V}.${table}', '${col}'), COALESCE((SELECT MAX(${col}) FROM ${V}.${table}), 0) + 1, false)`);
  }

  // meta: the embedding model comes from the seed itself, never hardcoded
  const embeddingModel = (dbs.schema.prepare("SELECT value FROM meta WHERE key = 'embedding_version'").get() as any)?.value as string | undefined;
  if (!embeddingModel) fail("schema.sqlite meta has no embedding_version — refusing to register the seed");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO meta.seeds (version, embedding_model, ddl_version, restored_at, activated_at)
             VALUES (${V}, ${embeddingModel}, ${ddl.version}, now(), now())
             ON CONFLICT (version) DO UPDATE SET embedding_model = EXCLUDED.embedding_model,
               ddl_version = EXCLUDED.ddl_version, restored_at = now(), activated_at = now()`;
    await tx`INSERT INTO meta.active_version (lock, version) VALUES (true, ${V})
             ON CONFLICT (lock) DO UPDATE SET version = EXCLUDED.version, switched_at = now()`;
  });
  log(`meta.seeds(${V}, ${embeddingModel}, ddl ${ddl.version}); meta.active_version → ${V}`);

  for (const job of JOBS) await sql.unsafe(`ANALYZE ${V}.${job.table}`);

  const sizes = await sql`SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = ${V} AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC`;
  const [{ total }] = await sql`SELECT pg_size_pretty(SUM(pg_total_relation_size(c.oid))::bigint) AS total
                                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                WHERE n.nspname = ${V} AND c.relkind = 'r'`;
  console.log("\ntable                        sqlite        pg  seconds  size");
  for (const p of parity) {
    const s = sizes.find((x) => x.table === p.table)?.size ?? "";
    console.log(`${p.table.padEnd(26)} ${String(p.sqlite).padStart(9)} ${String(p.pg).padStart(9)} ${p.seconds.toFixed(1).padStart(8)}  ${s}`);
  }
  console.log(`\nschema ${V} total (tables + indexes): ${total}; NUL bytes stripped from text: ${nulStripped}`);
  log("done");
} finally {
  await sql.end({ timeout: 5 });
  for (const d of Object.values(dbs)) d.close();
}
