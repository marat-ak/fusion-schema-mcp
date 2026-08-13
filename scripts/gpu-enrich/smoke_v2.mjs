// Smoke-test the v2 serving catalog through the REAL serving read path (catalog.ts findSimilarQueries).
//   docker run --rm --network host -v /opt/fusion-catalog-v2:/app/data -v /root/enrich-run:/work \
//     -e DATA_DIR=/app/data --entrypoint node gnimsys/fusion-schema-mcp:latest /work/smoke_v2.mjs
process.env.DATA_DIR = process.env.DATA_DIR || "/app/data";
const keepAlive = setInterval(() => {}, 1 << 30);
const cat = await import("/app/dist/catalog.js");
const find = cat.findSimilarQueries || cat.default?.findSimilarQueries;

for (const q of ["item cost by work order", "supplier invoice amounts by business unit", "employee absence balance"]) {
  const res = await find(q, { limit: 3 });
  console.log(`\n=== "${q}" ===  ambiguous=${res.ambiguous}${res.domain ? " domain=" + res.domain : ""}`);
  for (const r of (res.matches ?? res.candidates ?? []))
    console.log(`  [${r.score}] ${r.source} ${String(r.title).slice(0, 90)}`);
}

import Database from "/app/node_modules/better-sqlite3/lib/index.js";
const d = new Database("/app/data/reports.sqlite", { readonly: true });
console.log("\n=== alias pointer queries ===");
const big = d.prepare("SELECT unit_id, COUNT(*) n FROM unit_aliases GROUP BY unit_id ORDER BY n DESC LIMIT 1").get();
console.log(`biggest query: ${big.n} paths -> ${big.unit_id.slice(0, 70)}`);
const sa = d.prepare(`SELECT DISTINCT a.subject_area FROM report_queries q JOIN unit_aliases a ON a.unit_id=q.id
                      WHERE q.source='otbi' AND q.tables_used LIKE '%EGP_SYSTEM_ITEMS_ALL_V%' LIMIT 5`).all();
console.log("EGP_SYSTEM_ITEMS_ALL_V subject areas:", sa.map(r => r.subject_area));
const s = d.prepare("SELECT id, substr(description,1,180) d, substr(clean_sql,1,120) sql FROM report_queries WHERE source='otbi' AND semantics_json IS NOT NULL LIMIT 1").get();
console.log(`\nsample otbi row: ${s.id.slice(0, 60)}\n  desc: ${s.d}\n  rewrittenSql: ${s.sql}`);
d.close();
clearInterval(keepAlive);
process.exit(0);
