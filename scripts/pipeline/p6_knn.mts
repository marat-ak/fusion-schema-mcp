/**
 * P6b — exact-KNN spot check on the release corpus, run the way the server runs it.
 *
 * Embeds real intents with the repo's own embedder and issues the SAME statement
 * PgCorpus.knn(multi) issues (`embedding <-> $1::vector` over report_queries_vec_multi,
 * joined back by qrowid), scoring with catalog.ts's `1 - d²/2`. The same probes are
 * run against v2026_09 so the two corpora can be read side by side.
 *
 *   docker run --rm --network oservices_default \
 *     -v <repo>/scripts/pipeline:/app/scripts/pipeline \
 *     -e DATABASE_URL=... schema-mcp-build:latest npx tsx /app/scripts/pipeline/p6_knn.mts
 */
import postgres from "postgres";
import { embed } from "../../dist/corpus/embed.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const K = Number(process.env.K ?? 10);
const PROBES = (process.env.PROBES ?? [
  "open supplier invoice balances by business unit",
  "employee assignments with department and job as of a date",
  "customer receipts applied to transactions",
].join("|")).split("|");

const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} });
const keepAlive = setInterval(() => {}, 1 << 30);
const score = (d: number) => +(1 - (d * d) / 2).toFixed(4);

async function knn(schema: string, vec: string) {
  return sql.unsafe(
    `SELECT rq.id, rq.source, rq.title, v.distance
     FROM (SELECT qrowid, embedding <-> $1::vector AS distance
           FROM ${schema}.report_queries_vec_multi ORDER BY distance LIMIT $2) v
     JOIN ${schema}.report_queries rq ON rq.rid = v.qrowid
     ORDER BY v.distance`, [vec, K * 4]);
}

for (const probe of PROBES) {
  const [v] = await embed([probe]);
  const lit = `[${Array.from(v).join(",")}]`;
  console.log(`\n=== probe: ${probe}`);
  for (const schema of ["v2026_10", "v2026_09"]) {
    const t0 = Date.now();
    const rows = await knn(schema, lit);
    const ms = Date.now() - t0;
    const seen = new Set<string>();
    const top = rows.filter((r: any) => !seen.has(r.id) && seen.add(r.id)).slice(0, K);
    console.log(`--- ${schema}  (${ms} ms, ${rows.length} vec hits -> ${top.length} rows)`);
    top.forEach((r: any, i: number) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${score(Number(r.distance)).toFixed(4)}  ${String(r.source).padEnd(10)} ${String(r.title).slice(0, 88)}`));
  }
}

clearInterval(keepAlive);
await sql.end({ timeout: 5 });
process.exit(0);
