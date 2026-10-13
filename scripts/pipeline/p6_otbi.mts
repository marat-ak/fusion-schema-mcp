/**
 * P6c — the OTBI gate, run THROUGH THE PRODUCT'S OWN CODE (the postgres provider + catalog.ts +
 * otbiStore.ts) against the release under test in the BUILD database:
 *
 *   1. listQueriesForSubjectArea returns every lineage folder of the three verification subject
 *      areas that has a corpus unit at all (the folders without a unit are listed, not hidden);
 *   2. checkOtbiSql lints the 33 real "Oracle BI EE" dataset SQLs of test/fixtures/otbi-biee.json
 *      clean (the two custom-subject-area datasets are expected to fail on the subject area);
 *   3. searchOtbi / describeOtbiFolder answer a few business probes (printed for reading).
 *
 * The provider serves `meta.active_version`, so this script points the BUILD database's pointer at
 * VER for the run (fusion_dev is scratch; the served database is untouched) and registers the
 * release's own stamps in meta.seeds — exactly what p9 does in the target, on the build side.
 *
 *   docker run --rm --network oservices_default -v <repo>/scripts/pipeline:/app/scripts/pipeline \
 *     -v <repo>/test/fixtures:/app/test/fixtures \
 *     -e DATABASE_URL=postgres://postgres:<pw>@stack-db:5432/fusion_dev -e VER=v2026_12 \
 *     schema-mcp-build:latest npx tsx /app/scripts/pipeline/p6_otbi.mts
 */
import fs from "node:fs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const V = process.env.VER;
if (!V || !/^v\d{4}_\d{2}$/.test(V)) throw new Error("VER is required (the release schema, v<YYYY_MM>) — no default");
const FIXTURE = process.env.FIXTURE ?? "/app/test/fixtures/otbi-biee.json";
const SAS = ["General Ledger - Balances Real Time", "Payables Invoices - Transactions Real Time", "Workforce Management - Worker Assignment Real Time"];

const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} });
const keepAlive = setInterval(() => {}, 1 << 30);

// ---- point the build database at VER (its own stamps; the served database is never touched)
const [stamp] = await sql.unsafe(`SELECT (SELECT value FROM ${V}.catalog_meta WHERE key = 'ddl_version') AS ddl, (SELECT value FROM ${V}.catalog_meta WHERE key = 'embedding_version') AS emb`);
if (!stamp?.ddl || !stamp?.emb) throw new Error(`${V}.catalog_meta lacks ddl_version / embedding_version — not a finished release`);
const [prev] = await sql`SELECT version FROM meta.active_version`;
await sql`INSERT INTO meta.seeds (version, embedding_model, ddl_version) VALUES (${V}, ${stamp.emb}, ${stamp.ddl})
          ON CONFLICT (version) DO UPDATE SET embedding_model = EXCLUDED.embedding_model, ddl_version = EXCLUDED.ddl_version`;
await sql`INSERT INTO meta.active_version (lock, version) VALUES (true, ${V}) ON CONFLICT (lock) DO UPDATE SET version = EXCLUDED.version, switched_at = now()`;
console.log(`[p6c] build database active_version: ${prev?.version ?? "none"} -> ${V} (ddl ${stamp.ddl}, ${stamp.emb})`);

const { openCatalogDb, closeCatalogDb } = await import("../../dist/db/index.js");
// the build database plays the served one: the library's customer-side migrations are applied here too
// (the boot check requires them — library v2 = the per-instance security layer tables), as p9's target carries them
await openCatalogDb({ provider: "postgres", databaseUrl: DATABASE_URL, migrate: true });
const catalog = await import("../../dist/catalog.js");
const otbi = await import("../../dist/corpus/otbiStore.js");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail !== undefined ? " -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600) : ""}`);
};

// ---- 1. listQueriesForSubjectArea covers every lineage folder that has a unit
console.log("\n=== 1. listQueriesForSubjectArea vs lineage folders ===");
for (const sa of SAS) {
  const folders = await sql.unsafe(`SELECT name, unit_id IS NOT NULL AS has_unit, kind FROM ${V}.otbi_folder WHERE subject_area = $1 AND in_lineage = 1 ORDER BY name`, [sa]);
  const listed = await catalog.listQueriesForSubjectArea(sa, 500);
  const titles = new Set(listed.map((r: any) => r.title));
  const withUnit = folders.filter((f: any) => f.has_unit);
  const missing = withUnit.filter((f: any) => !titles.has(`${sa}.${f.name}`)).map((f: any) => f.name);
  const noUnit = folders.filter((f: any) => !f.has_unit).map((f: any) => `${f.name} (${f.kind})`);
  check(`${sa}: ${withUnit.length}/${folders.length} lineage folders have a unit, all listed`, missing.length === 0, missing.length ? { missing } : `listed ${listed.length}, aliases ${listed.filter((r: any) => r.title !== r.canonicalTitle).length}`);
  console.log(`      lineage folders WITHOUT any unit (${noUnit.length}): ${noUnit.join(" | ") || "none"}`);
}

// ---- 2. the real BI EE dataset SQLs through checkOtbiSql
console.log("\n=== 2. checkOtbiSql over the real BI EE dataset SQLs ===");
if (!fs.existsSync(FIXTURE)) throw new Error(`fixture not found: ${FIXTURE}`);
const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { datasets: { file: string; dataset: string; sql: string }[] };
// pod-specific content the VENDOR catalog does not carry (the same allowlist as test/otbiLint.test.ts):
// extension-object folder paths and one pod's flexfield columns
const POD_SPECIFIC: Record<string, { code: string; count: number }> = {
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / ConsumerProd": { code: "extension_folder", count: 26 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / FactPanel": { code: "extension_folder", count: 7 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / Allergens": { code: "extension_folder", count: 3 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / Compliance": { code: "extension_folder", count: 2 },
  "Longitude.xdmz!_datamodel.xdm / hc": { code: "unknown_column", count: 2 },
};
let clean = 0, custom = 0, podSpecific = 0, crossSa = 0;
for (const d of fx.datasets) {
  const r = await otbi.checkOtbiSql(d.sql);
  const name = `${d.file.split("/").pop()} / ${d.dataset}`;
  if (r.subjectArea === null && r.errors.some((e: any) => e.code === "unknown_subject_area")) { custom++; console.log(`  [custom SA] ${name}: ${r.errors[0].message}`); continue; }
  if (r.warnings.some((w: any) => w.code === "cross_subject_area")) crossSa++;
  const exp = POD_SPECIFIC[name];
  if (r.ok) clean++;
  else if (exp && r.errors.length === exp.count && r.errors.every((e: any) => e.code === exp.code)) { podSpecific++; console.log(`  [pod-specific] ${name}: ${exp.count} × ${exp.code}`); }
  else console.log(`  [FAIL] ${name}: ${r.errors.map((e: any) => `${e.code} ${e.ref ?? ""} ${e.suggestions ? "→ " + e.suggestions.slice(0, 3).join(" | ") : ""}`).join("; ")}`);
}
check(`${clean} of ${fx.datasets.length - custom} catalogued datasets lint clean, ${podSpecific} fail only on named pod-specific content (${custom} select from a custom subject area; ${crossSa} cross-subject-area warnings)`,
  clean + podSpecific === fx.datasets.length - custom);

// ---- 3. business probes (read, not asserted beyond "answers")
console.log("\n=== 3. searchOtbi / describeOtbiFolder probes ===");
for (const q of ["supplier invoice amount unpaid", "employee department job name", "general ledger ending balance by account"]) {
  const s: any = await otbi.searchOtbi(q, { limit: 5 });
  check(`searchOtbi("${q}") answers`, s.hits?.length > 0, s.hits?.map((h: any) => `${h.hit}:${h.name ?? h.folder ?? h.subjectArea}${h.locations ? `@${h.locations[0].subjectArea}/${h.locations[0].folder}` : ""}`));
}
const tree: any = await otbi.describeOtbiFolder(SAS[1]);
check(`describeOtbiFolder(${SAS[1]}) tree`, tree.found === true, `facts ${tree.facts?.length}, dimensions ${tree.dimensions?.length}, nested ${tree.nestedFolderCount ?? 0}`);
const one: any = await otbi.describeOtbiFolder(SAS[1], "- Invoice Amounts");
check(`describeOtbiFolder(${SAS[1]}, "- Invoice Amounts") columns`, one.found === true && one.columns?.length > 0, one.columns?.slice(0, 4).map((c: any) => `${c.name} [${c.kind}${c.aggregation ? " " + c.aggregation : ""}] ${c.dbRefs?.[0] ?? ""}`));
const rq: any = await catalog.getReportQuery(`${SAS[1]}.- Invoice Amounts`);
check(`getReportQuery("${SAS[1]}.- Invoice Amounts")`, rq.found === true, { id: rq.id, title: rq.title, requestedTitle: rq.requestedTitle });

console.log(`\n=== ${failures ? failures + " FAILED" : "all checks passed"} ===`);
await closeCatalogDb();
clearInterval(keepAlive);
await sql.end({ timeout: 5 });
process.exit(failures ? 1 : 0);
