/**
 * P6b — exact-KNN spot check on the release corpus, run the way the server runs it.
 *
 * Embeds real intents with the repo's own embedder and issues the SAME statement
 * PgCorpus.knn(multi) issues (`embedding <-> $1::vector` over report_queries_vec_multi,
 * joined back by qrowid), scoring with catalog.ts's `1 - d²/2`. The same probes are
 * run against v2026_09 (the shipped baseline, present in fusion_dev) so the two corpora can be
 * read side by side. VER names the release under test — required, no default.
 *
 *   docker run --rm --network oservices_default \
 *     -v <repo>/scripts/pipeline:/app/scripts/pipeline \
 *     -e DATABASE_URL=... -e VER=v2026_11 schema-mcp-build:latest npx tsx /app/scripts/pipeline/p6_knn.mts
 */
import postgres from "postgres";
import { embed } from "../../dist/corpus/embed.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const V = process.env.VER;
if (!V || !/^v\d{4}_\d{2}$/.test(V)) throw new Error("VER is required (the release schema, v<YYYY_MM>) — no default");
const BASE = "v2026_09"; // the shipped baseline the six probes are read against
const K = Number(process.env.K ?? 10);
// the SAME six probes p4_knn.mts uses, so the top-10 agreement figure is comparable
const PROBES = (process.env.PROBES ?? [
  "open supplier invoice balances by business unit",
  "employee assignments with department and job as of a date",
  "customer receipts applied to transactions",
  "purchase orders awaiting approval with supplier and buyer",
  "general ledger journal lines by account and period",
  "fixed asset additions and depreciation by category",
].join("|")).split("|");

const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} });
const keepAlive = setInterval(() => {}, 1 << 30);
const score = (d: number) => +(1 - (d * d) / 2).toFixed(4);

// release ids are sql:<hash> for every source (since v2026_10); v2026_09's are the old unit ids. A hit is
// mapped back through the statement's own L2 unit (clear_sql.primary_unit_id), falling
// back to the unit that carried its enrichment — the same map p4_knn.mts uses — so the
// two top-K can be compared as sets.
async function knn(schema: string, vec: string) {
  const v09 = schema === V
    ? `, coalesce(rp.id, re.id) AS v09_id`
    : `, rq.id AS v09_id`;
  const map = schema === V
    ? `LEFT JOIN work.clear_sql c ON c.sql_hash = substr(rq.id, 5)
       LEFT JOIN ${BASE}.report_queries rp ON rp.id = c.primary_unit_id
       LEFT JOIN ${BASE}.report_queries re ON re.id = c.src_enrich_unit`
    : ``;
  return sql.unsafe(
    `SELECT rq.id, rq.source, rq.title, v.distance ${v09}
     FROM (SELECT qrowid, embedding <-> $1::vector AS distance
           FROM ${schema}.report_queries_vec_multi ORDER BY distance LIMIT $2) v
     JOIN ${schema}.report_queries rq ON rq.rid = v.qrowid
     ${map}
     ORDER BY v.distance`, [vec, K * 4]);
}

let overlapTot = 0, top1Same = 0;
for (const probe of PROBES) {
  const [v] = await embed([probe]);
  const lit = `[${Array.from(v).join(",")}]`;
  console.log(`\n=== probe: ${probe}`);
  const tops: Record<string, any[]> = {};
  for (const schema of [V, BASE]) {
    const t0 = Date.now();
    const rows = await knn(schema, lit);
    const ms = Date.now() - t0;
    const seen = new Set<string>();
    const top = rows.filter((r: any) => !seen.has(r.id) && seen.add(r.id)).slice(0, K);
    tops[schema] = top;
    console.log(`--- ${schema}  (${ms} ms, ${rows.length} vec hits -> ${top.length} rows)`);
    top.forEach((r: any, i: number) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${score(Number(r.distance)).toFixed(4)}  ${String(r.source).padEnd(10)} ${String(r.title).slice(0, 88)}`));
  }
  const oldIds = new Set(tops[BASE].map((r: any) => r.id));
  const overlap = tops[V].filter((r: any) => r.v09_id && oldIds.has(r.v09_id)).length;
  const same1 = tops[V][0]?.v09_id && tops[V][0].v09_id === tops[BASE][0]?.id;
  overlapTot += overlap; if (same1) top1Same++;
  console.log(`--- top-${K} overlap ${overlap}/${K}${same1 ? ", same top-1" : ""}`);
}
console.log(`\n=== ${PROBES.length} probes: mean top-${K} overlap ${(overlapTot / PROBES.length).toFixed(1)}/${K}, same top-1 on ${top1Same}/${PROBES.length}`);

clearInterval(keepAlive);
await sql.end({ timeout: 5 });
process.exit(0);
