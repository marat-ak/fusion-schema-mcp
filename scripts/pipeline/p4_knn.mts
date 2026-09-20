/**
 * P4c — does p4's output actually RETRIEVE? An exact-KNN probe of `work.embeddings`,
 * run the way the server runs it, with v2026_09 alongside for scale.
 *
 * p6_knn.mts asks the same question of a finished release schema; this asks it of the
 * staging table, before p5 exists, so a bad embed is caught where it was made. The
 * statement is PgCorpus.knn(multi)'s own — top `K*4` vector rows by `<->`, joined back
 * to the owning statement, de-duplicated to K — with `work.embeddings` standing in for
 * `report_queries_vec_multi` (owner_kind='unit', owner_id = sql_hash).
 *
 * The two corpora are keyed differently (this build re-normalized and re-hashed every
 * statement), so the new hits are mapped back to their v2026_09 ids through
 * clear_sql.primary_unit_id — the statement's own L2 unit — falling back to
 * src_enrich_unit for the 55 statements whose own unit never reached the release.
 * Agreement is then a set overlap of the two top-K, which is the only comparison the
 * two id spaces support.
 *
 *   docker run --rm --network oservices_default \
 *     -v <repo>/scripts/pipeline:/app/scripts/pipeline \
 *     -e DATABASE_URL=postgres://postgres:<pw>@stack-db:5432/fusion_dev \
 *     schema-mcp-build:latest npx tsx /app/scripts/pipeline/p4_knn.mts
 */
import postgres from "postgres";
import { embed } from "../../dist/corpus/embed.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const K = Number(process.env.K ?? 10);
const OLD = process.env.OLD_SCHEMA ?? "v2026_09";
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
const pad = (s: unknown, n: number) => String(s).slice(0, n).padEnd(n);

/** work.embeddings, under PgCorpus.knn(multi)'s statement. */
async function knnWork(vec: string) {
  const rows = await sql.unsafe(
    `SELECT c.sql_hash, c.source, c.title_human, c.title, v.distance,
            coalesce(rp.id, re.id) AS v09_id
     FROM (SELECT owner_id, embedding <-> $1::vector AS distance
           FROM work.embeddings WHERE owner_kind = 'unit' ORDER BY distance LIMIT $2) v
     JOIN work.clear_sql c ON c.sql_hash = v.owner_id
     LEFT JOIN ${OLD}.report_queries rp ON rp.id = c.primary_unit_id
     LEFT JOIN ${OLD}.report_queries re ON re.id = c.src_enrich_unit
     ORDER BY v.distance`, [vec, K * 4]);
  const seen = new Set<string>();
  return rows.filter((r: any) => !seen.has(r.sql_hash) && seen.add(r.sql_hash)).slice(0, K);
}

/** the shipped release, same statement (p6_knn.mts's query). */
async function knnOld(vec: string) {
  const rows = await sql.unsafe(
    `SELECT rq.id, rq.source, rq.title, v.distance
     FROM (SELECT qrowid, embedding <-> $1::vector AS distance
           FROM ${OLD}.report_queries_vec_multi ORDER BY distance LIMIT $2) v
     JOIN ${OLD}.report_queries rq ON rq.rid = v.qrowid
     ORDER BY v.distance`, [vec, K * 4]);
  const seen = new Set<string>();
  return rows.filter((r: any) => !seen.has(r.id) && seen.add(r.id)).slice(0, K);
}

let overlapTot = 0, top1Same = 0;
for (const probe of PROBES) {
  const [v] = await embed([probe]);
  const lit = `[${Array.from(v).join(",")}]`;
  const t0 = Date.now(); const neu = await knnWork(lit); const msN = Date.now() - t0;
  const t1 = Date.now(); const old = await knnOld(lit);  const msO = Date.now() - t1;

  const oldIds = new Set(old.map((r: any) => r.id));
  const neuIds = new Set(neu.map((r: any) => r.v09_id).filter(Boolean));
  const overlap = [...neuIds].filter((id) => oldIds.has(id as string)).length;
  overlapTot += overlap;
  const same1 = neu[0]?.v09_id && old[0]?.id && neu[0].v09_id === old[0].id;
  if (same1) top1Same++;

  console.log(`\n=== probe: ${probe}`);
  console.log(`--- work.embeddings (${msN} ms) vs ${OLD} (${msO} ms) — top-${K} overlap ${overlap}/${K}${same1 ? ", same top-1" : ""}`);
  for (let i = 0; i < K; i++) {
    const n: any = neu[i], o: any = old[i];
    const hit = n?.v09_id && oldIds.has(n.v09_id) ? " " : "*";     // * = in the new top-K only
    console.log(`  ${String(i + 1).padStart(2)}.${hit}${n ? score(Number(n.distance)).toFixed(4) : "      "} ${pad(n?.source, 10)} ${pad(n?.title_human ?? n?.title, 58)} | ${o ? score(Number(o.distance)).toFixed(4) : "      "} ${pad(o?.source, 10)} ${pad(o?.title, 58)}`);
  }
}
console.log(`\n=== ${PROBES.length} probes: mean top-${K} overlap ${(overlapTot / PROBES.length).toFixed(1)}/${K} (${((100 * overlapTot) / (PROBES.length * K)).toFixed(0)}%), same top-1 on ${top1Same}/${PROBES.length}`);

clearInterval(keepAlive);
await sql.end({ timeout: 5 });
process.exit(0);
