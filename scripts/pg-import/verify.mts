/**
 * DEV-ONLY verification of an import.mts run (D13): the Postgres copy vs the SQLite originals.
 *   --schema-sqlite <schema.sqlite> --reports-sqlite <reports.sqlite> --database-url <url> --version 2026_09
 * Checks (each prints PASS/FAIL; exit 1 on any FAIL):
 *   1. embeddings: count(embedding IS NOT NULL) = SQLite report_queries count; report_queries_vec parity
 *   2. self-KNN: 5 sampled corpus rows — `ORDER BY embedding <-> $1 LIMIT 10` returns the row itself first, distance 0
 *   3. top-10 equality: 3 synthetic queries — exact PG L2 scan vs brute-force JS L2 over the SQLite blobs
 *      (report_queries), plus 1 query over report_queries_vec_multi
 *   4. tsvector: 3 known table names found by their own prefix tokens (the searchTables idiom)
 *   5. meta: exactly one meta.seeds row, meta.active_version = v<version>
 * Same run idiom as import.mts (schema-mcp image + mounted `postgres` client).
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import postgres from "postgres";

const REQUIRED = ["schema-sqlite", "reports-sqlite", "database-url", "version"] as const;
type ArgName = (typeof REQUIRED)[number];
const args: Partial<Record<ArgName, string>> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, "") as ArgName;
  if (!argv[i].startsWith("--") || !REQUIRED.includes(name)) die(`unknown argument ${argv[i]}`);
  args[name] = argv[++i];
}
for (const n of REQUIRED) if (!args[n]) die(`--${n} is required`);
for (const n of ["schema-sqlite", "reports-sqlite"] as const) if (!fs.existsSync(args[n]!)) die(`${n}: not found ${args[n]}`);
function die(m: string): never { console.error(`[pg-verify] ${m}`); process.exit(1); }

const V = `v${args.version}`;
const schemaDb = new Database(args["schema-sqlite"]!, { readonly: true });
const reportsDb = new Database(args["reports-sqlite"]!, { readonly: true });
loadVec(reportsDb);
const sql = postgres(args["database-url"]!, { max: 2, connect_timeout: 10, idle_timeout: 10, onnotice: () => {} });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const toF32 = (buf: Buffer) => { const f = new Float32Array(384); new Uint8Array(f.buffer).set(buf); return f; };
const lit = (f: Float32Array | number[]) => "[" + Array.from(f).join(",") + "]";
const l2 = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < 384; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };

try {
  // ---- 1. embeddings
  const rqRows = reportsDb.prepare("SELECT rowid AS rid, id, embedding FROM report_queries ORDER BY rowid").all() as { rid: number; id: string; embedding: Buffer }[];
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(V)}.report_queries WHERE embedding IS NOT NULL`;
  check(`embedding not null = ${rqRows.length}`, n === rqRows.length, `pg=${n}`);
  const vecCount = (reportsDb.prepare("SELECT COUNT(*) AS c FROM report_queries_vec").get() as any).c;
  check(`report_queries_vec (folded) rows = report_queries rows`, vecCount === rqRows.length, `vec0=${vecCount}`);
  const sampleIdx = [0, Math.floor(rqRows.length / 4), Math.floor(rqRows.length / 2), Math.floor((3 * rqRows.length) / 4), rqRows.length - 1];
  for (const i of sampleIdx) {
    const v0 = reportsDb.prepare("SELECT embedding FROM report_queries_vec WHERE rowid = ?").get(BigInt(rqRows[i].rid)) as any;
    check(`vec0 blob == report_queries.embedding blob (rid ${rqRows[i].rid})`, Buffer.compare(v0.embedding, rqRows[i].embedding) === 0);
  }

  // ---- 2. self-KNN on 5 sampled rows
  for (const i of sampleIdx) {
    const r = rqRows[i];
    const q = lit(toF32(r.embedding));
    const top = await sql`SELECT rid, id, embedding <-> ${q}::vector AS d FROM ${sql(V)}.report_queries ORDER BY embedding <-> ${q}::vector LIMIT 10`;
    // bigint columns arrive as strings from postgres.js — compare numerically
    check(`self-KNN rid ${r.rid} (${r.id}) first=self, d=0`, Number(top[0]?.rid) === r.rid && Number(top[0]?.d) === 0, `first=${top[0]?.rid} d=${top[0]?.d} (${top.length} rows)`);
  }

  // ---- 3. top-10 equality: synthetic queries = 0.6/0.4 blend of two corpus vectors (not a trivial
  // self-hit, and no structural tie — a plain mean is equidistant from both sources). PASS = same
  // 10 keys AND each position's distance within 1e-6 (float32 blobs vs PG's float8 arithmetic differ
  // at ~1e-8, which can swap genuinely tied neighbours); the exact order is printed as evidence.
  type Hit = { key: number; d: number };
  const compareTop10 = (name: string, brute: Hit[], pg: { key: unknown; d: unknown }[]) => {
    const sameSet = brute.map((x) => x.key).sort((a, b) => a - b).join(",") === pg.map((x) => Number(x.key)).sort((a, b) => a - b).join(",");
    const maxDd = Math.max(...brute.map((x, i) => Math.abs(x.d - Number(pg[i]?.d ?? NaN))));
    const sameOrder = brute.map((x) => x.key).join(",") === pg.map((x) => Number(x.key)).join(",");
    check(name, sameSet && maxDd < 1e-6, `order ${sameOrder ? "identical" : "differs on ties"}; js=[${brute.map((x) => x.key)}] pg=[${pg.map((x) => Number(x.key))}] max|Δd|=${maxDd.toExponential(2)}`);
  };
  const vecs = rqRows.map((r) => toF32(r.embedding));
  const blend = (a: Float32Array, b: Float32Array) => { const q = new Float32Array(384); for (let i = 0; i < 384; i++) q[i] = 0.6 * a[i] + 0.4 * b[i]; return q; };
  const pairs = [[Math.floor(vecs.length / 3), Math.floor((2 * vecs.length) / 3)], [7, Math.floor(vecs.length / 2) + 11], [123, vecs.length - 42]];
  for (const [a, b] of pairs) {
    const q = blend(vecs[a], vecs[b]);
    const brute: Hit[] = rqRows.map((r, i) => ({ key: r.rid, d: l2(q, vecs[i]) })).sort((x, y) => x.d - y.d || x.key - y.key).slice(0, 10);
    const pg = await sql`SELECT rid AS key, embedding <-> ${lit(q)}::vector AS d FROM ${sql(V)}.report_queries ORDER BY embedding <-> ${lit(q)}::vector, rid LIMIT 10`;
    compareTop10(`top-10 L2 equality report_queries (blend of rids ${rqRows[a].rid},${rqRows[b].rid})`, brute, pg);
  }
  // one query over the multi-vector table
  const multi = reportsDb.prepare("SELECT rowid AS id, qrowid, embedding FROM report_queries_vec_multi").all() as { id: number; qrowid: number; embedding: Buffer }[];
  {
    const q = blend(toF32(multi[Math.floor(multi.length / 5)].embedding), toF32(multi[Math.floor((4 * multi.length) / 5)].embedding));
    const brute: Hit[] = multi.map((m) => ({ key: m.id, d: l2(q, toF32(m.embedding)) })).sort((x, y) => x.d - y.d || x.key - y.key).slice(0, 10);
    const pg = await sql`SELECT id AS key, embedding <-> ${lit(q)}::vector AS d FROM ${sql(V)}.report_queries_vec_multi ORDER BY embedding <-> ${lit(q)}::vector, id LIMIT 10`;
    compareTop10(`top-10 L2 equality report_queries_vec_multi (${multi.length} rows)`, brute, pg);
  }

  // ---- 4. tsvector search by prefix tokens (searchTables: tokens → `tok*` AND-joined, FTS5 → `tok:* & tok:*`)
  for (const name of ["AP_INVOICES_ALL", "GL_JE_HEADERS", "PER_ALL_PEOPLE_F"]) {
    const inSqlite = schemaDb.prepare("SELECT 1 FROM tables WHERE name = ?").get(name);
    if (!inSqlite) { check(`tsvector ${name}`, false, "name not in schema.sqlite tables"); continue; }
    const q = name.toLowerCase().split("_").filter(Boolean).map((t) => `${t}:*`).join(" & ");
    const rows = await sql`SELECT name, ts_rank(search, to_tsquery('simple', ${q})) AS rank FROM ${sql(V)}.tables
                           WHERE search @@ to_tsquery('simple', ${q}) ORDER BY rank DESC, name LIMIT 10`;
    const pos = rows.findIndex((r) => r.name === name);
    check(`tsvector '${q}' finds ${name}`, pos >= 0, `position ${pos + 1} of ${rows.length}: [${rows.slice(0, 5).map((r) => r.name)}]`);
  }

  // ---- 5. meta
  const seeds = await sql`SELECT version, embedding_model, ddl_version FROM meta.seeds`;
  const active = await sql`SELECT version FROM meta.active_version`;
  check(`meta.seeds has one row`, seeds.length === 1, JSON.stringify(seeds));
  check(`meta.active_version = ${V}`, active.length === 1 && active[0].version === V, JSON.stringify(active));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
} finally {
  await sql.end({ timeout: 5 });
  schemaDb.close();
  reportsDb.close();
}
