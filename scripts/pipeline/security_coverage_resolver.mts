/**
 * Data-access coverage THROUGH THE RESOLVER (src/corpus/dataAccess.ts, the product code in dist/): the
 * verdict of every table of two populations on ONE pod's loaded security layer, against the SERVED
 * database (the active release + customer.sec_instance_*). Read-only; nothing is written to a database.
 *
 *   A. the tables of OTBI fact folders   (otbi_folder.kind = 'fact', db_tables)
 *   B. the top-300 BIP tables            (table_usages.source = 'bip-report', by statements)
 *
 * Keyings per table:
 *  table  the table-keyed developer plan (phase 1): secured (route direct | reference, the condition's grade) |
 *         blocked (by the class of the blocked reason) | none;
 *  area   the (subject area, VO entity) keying: the table resolved in EVERY subject area that reads it (its FACT
 *         areas first, then the others, each by name; at most AREA_CAP areas). DEVELOPER view = the first secured
 *         area wins, else blocked (the first area's reason class) | none; END-USER view = exactly the end-user
 *         plan's verdict per area (dataAccess.ts endUserAccess: the strictest of candidates, the structural none
 *         rule, pool-2 picks blocked), the first readable area wins; a table no subject area reads = the no-area
 *         policy (a reference-family none table by the structural rule, a business table never — readInstead).
 * Revised phase 3 checks (2026-10-05): every (area, object) the RULE decides is compared with the job-role
 * consensus of that area (dataAccess.ts jobConsensus) — every disagreement is listed; every (table, area) whose
 * resolved object carries a curated row of the area must be graded by that row (user decision 4) — every violation
 * is listed.
 * Prints the summary tables (markdown) and writes the per-(table, area) verdicts as CSV lines to OUT (a file path)
 * when given.
 *
 *   docker run --rm --network oservices_default -v /tmp/pipeline-secx-r:/app/scripts/pipeline \
 *     -e DATABASE_URL=<the service's DATABASE_URL> -e CATALOG_DB=postgres -e INSTANCE=<pod host> [-e OUT=/app/scripts/pipeline/out.csv] \
 *     schema-mcp-build:latest npx tsx /app/scripts/pipeline/security_coverage_resolver.mts
 */
import fs from "node:fs";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const INSTANCE = process.env.INSTANCE;
if (!INSTANCE) throw new Error("INSTANCE is required (the pod host exactly as runSql reports `instance`) — no default");
const OUT = process.env.OUT;

const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} });
const keepAlive = setInterval(() => {}, 1 << 30);
const [{ version: V }] = await sql`SELECT version FROM meta.active_version`;
console.log(`[secx-r] served release ${V}, instance ${INSTANCE}`);

const factTables = (await sql.unsafe(
  `SELECT DISTINCT t FROM ${V}.otbi_folder f, jsonb_array_elements_text(f.db_tables::jsonb) t
   WHERE f.kind = 'fact' AND f.db_tables IS NOT NULL AND EXISTS (SELECT 1 FROM ${V}.tables x WHERE x.name = t) ORDER BY 1`)).map((r: any) => r.t as string);
const bipTop = (await sql.unsafe(
  `SELECT u.table_name FROM ${V}.table_usages u WHERE u.source = 'bip-report' AND EXISTS (SELECT 1 FROM ${V}.tables x WHERE x.name = u.table_name)
   GROUP BY u.table_name ORDER BY count(*) DESC, u.table_name LIMIT 300`)).map((r: any) => r.table_name as string);
console.log(`[secx-r] populations: OTBI fact tables ${factTables.length}, top-300 BIP tables ${bipTop.length}`);
const curated = (await sql.unsafe(
  `SELECT area_or_product AS area, obj_name, privilege, source FROM ${V}.sec_area_privilege WHERE instance_scope IN ('*', $1)`, [INSTANCE])) as any[];

const { openCatalogDb, closeCatalogDb } = await import("../../dist/db/index.js");
await openCatalogDb({ provider: "postgres", databaseUrl: DATABASE_URL });
const { dataSecurityFor, endUserAccess, jobConsensus } = await import("../../dist/corpus/dataAccess.js");
/** the subject areas resolved per table on the area keying (fact areas first) */
const AREA_CAP = 10;

type Row = { table: string; verdict: string; route: string; grade: string; cls: string; detail: string; object?: string; privileges?: string[] };
const classify = (reason: string): string =>
  /DISALLOWED in secured SQL/.test(reason) ? "disallowed"
  : /is not audited \(sec_meta\.primary_audit/.test(reason) ? "multi-context, primary context unaudited"
  : /is not the audited primary context/.test(reason) ? "multi-context, primary is not the audited context"
  : /is sensitive/.test(reason) ? "sensitive pair not registered / not granted"
  : /among all granted pairs .* ambiguous/.test(reason) ? "ambiguous privilege (pool 2, all grants)"
  : /with distinct grant sets .* ambiguous.*foreign dimension/.test(reason) ? "ambiguous privilege (U), foreign dimension of the area (no strictest)"
  : /with distinct grant sets .* ambiguous/.test(reason) ? "ambiguous privilege (U)"
  : /none belongs to module .* either/.test(reason) ? "no privilege of the table's module on the object (any grant)"
  : /no named privilege of .* carries an active grant/.test(reason) ? "object carries no named grant at all"
  : /is not registered as a security object/.test(reason) ? "reference object not registered"
  : /registered as .* but carries no active grant/.test(reason) ? "registered table without any grant"
  : /registered under .* granted security objects/.test(reason) ? "several stripe registrations"
  : /no key column|key column\(s\)/.test(reason) ? "no usable key column"
  : /area-duty route cannot|duties of .* hold .* distinct grant sets|whose duty roles cannot be named/.test(reason) ? "HCM area-duty route (no / ambiguous / unmapped duty)"
  : /analysis duties|duty map cannot|HCM object and no/.test(reason) ? "HCM duty map (ambiguous / none)"
  : /decides none of them|conflicting curation|none is the release's primary/.test(reason) ? "multi-context, the area decides no entity"
  : /is read by no folder of subject area/.test(reason) ? "not read by the area"
  : /no module in the catalog/.test(reason) ? "table without a module"
  : /curated/.test(reason) ? "curated row conflict / ungranted"
  // end-user only
  : /a child of secured data that is no reference-family member/.test(reason) ? "end user: child of secured data (structural rule)"
  : /a translation of secured data/.test(reason) ? "end user: translation of secured data"
  : /pool-2 pick/.test(reason) ? "end user: pool-2 pick only"
  : /expose[s]? none of its columns/.test(reason) ? "end user: the area exposes no column"
  : /business table no OTBI subject area reads/.test(reason) ? "end user: business table no area reads"
  : /without an area only a none reference table is read/.test(reason) ? "end user: secured reference table no area reads"
  : "other";

async function run(name: string, tables: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const t of tables) {
    const r: any = await dataSecurityFor(t, INSTANCE);
    if (!r) { rows.push({ table: t, verdict: "unknown", route: "", grade: "", cls: "not in catalog", detail: "" }); continue; }
    if (r.verdict === "secured") {
      const c = r.conditions[0];
      rows.push({ table: t, verdict: "secured", route: c.route, grade: c.grade, cls: "", detail: `${c.column ? `${c.column} -> ` : ""}${c.object}/${c.privileges.join("|")}` });
    } else if (r.verdict === "blocked") {
      const b = r.blocked[0];
      rows.push({ table: t, verdict: "blocked", route: "", grade: "", cls: classify(b.reason), detail: b.reason.slice(0, 160).replace(/[\r\n,]/g, " ") });
    } else {
      rows.push({ table: t, verdict: "none", route: "", grade: "", cls: "", detail: "" });
    }
  }
  const n = rows.length;
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const pct = (x: number) => `${x} (${((100 * x) / Math.max(n, 1)).toFixed(1)}%)`;
  console.log(`\n### ${name} — TABLE-keyed (developer): ${n} tables, instance ${INSTANCE}, release ${V}\n`);
  console.log("| verdict | tables |\n|---|---|");
  console.log(`| secured, direct | ${pct(count((r) => r.verdict === "secured" && r.route === "direct"))} |`);
  console.log(`| secured, reference | ${pct(count((r) => r.verdict === "secured" && r.route === "reference"))} |`);
  console.log(`| blocked | ${pct(count((r) => r.verdict === "blocked"))} |`);
  console.log(`| none (reference data) | ${pct(count((r) => r.verdict === "none"))} |`);
  const byGrade = new Map<string, number>();
  for (const r of rows) if (r.verdict === "secured") byGrade.set(r.grade, (byGrade.get(r.grade) ?? 0) + 1);
  console.log(`\nsecured by grade: ${[...byGrade].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  return rows;
}

type AreaRow = Row & { area: string };
type EuRow = { table: string; area: string; readable: boolean; grade: string; route: string; cls: string; detail: string; filterOnly: number; readInstead: string };
/** every (table, area) of the populations: developer + end-user, resolved once each */
const devAll = new Map<string, AreaRow[]>();
const euAll = new Map<string, EuRow[]>();

async function resolveAreas(tables: string[]) {
  const reads = new Map<string, { area: string; fact: number }[]>();
  for (const r of (await sql.unsafe(
    `SELECT table_name, subject_area, max(CASE WHEN folder_kind = 'fact' THEN 1 ELSE 0 END) AS fact
     FROM ${V}.otbi_column_ref WHERE table_name = ANY($1) GROUP BY 1, 2`, [tables])) as any[]) {
    reads.set(r.table_name, [...(reads.get(r.table_name) ?? []), { area: r.subject_area, fact: Number(r.fact) }]);
  }
  for (const t of tables) {
    if (devAll.has(t)) continue;
    const areas = (reads.get(t) ?? []).sort((x, y) => y.fact - x.fact || (x.area < y.area ? -1 : x.area > y.area ? 1 : 0)).slice(0, AREA_CAP).map((x) => x.area);
    const dev: AreaRow[] = [];
    const eu: EuRow[] = [];
    for (const a of areas) {
      const r: any = await dataSecurityFor(t, INSTANCE, a);
      if (r.verdict === "secured") {
        const c = r.conditions[0];
        dev.push({ table: t, verdict: "secured", route: c.route, grade: c.grade, cls: "", detail: `${c.column ? `${c.column} -> ` : ""}${c.object}/${c.privileges.join("|")}`, area: a, object: c.object, privileges: c.privileges });
      } else if (r.verdict === "blocked") {
        const b = r.blocked[0];
        dev.push({ table: t, verdict: "blocked", route: "", grade: "", cls: classify(b.reason), detail: b.reason.slice(0, 160).replace(/[\r\n,]/g, " "), area: a });
      } else {
        dev.push({ table: t, verdict: "none", route: "", grade: "", cls: "", detail: "", area: a });
      }
      const e: any = await endUserAccess(t, INSTANCE, a);
      eu.push(e.readable
        ? { table: t, area: a, readable: true, grade: e.grade, route: e.route ?? "none", cls: "", detail: e.detail, filterOnly: e.filterOnly, readInstead: "" }
        : { table: t, area: a, readable: false, grade: "", route: "", cls: classify(e.reason), detail: e.reason.slice(0, 160).replace(/[\r\n,]/g, " "), filterOnly: 0, readInstead: "" });
    }
    if (!areas.length) {
      const e: any = await endUserAccess(t, INSTANCE, null);
      eu.push(e.readable
        ? { table: t, area: "", readable: true, grade: e.grade, route: e.route ?? "none", cls: "", detail: e.detail, filterOnly: e.filterOnly, readInstead: "" }
        : { table: t, area: "", readable: false, grade: "", route: "", cls: classify(e.reason), detail: e.reason.slice(0, 160).replace(/[\r\n,]/g, " "), filterOnly: 0,
            readInstead: (e.readInstead ?? []).map((x: any) => x.table).join(" ") });
    }
    devAll.set(t, dev);
    euAll.set(t, eu);
  }
}

function summarize(name: string, tables: string[]) {
  const n = tables.length;
  const pct = (x: number) => `${x} (${((100 * x) / Math.max(n, 1)).toFixed(1)}%)`;
  // developer: the first secured area wins, else the first area's verdict; no area = "no OTBI area"
  const dev = tables.map((t) => {
    const rows = devAll.get(t) as AreaRow[];
    return rows.length ? (rows.find((r) => r.verdict === "secured") ?? rows[0]) : ({ table: t, verdict: "no OTBI area", route: "", grade: "", cls: "", detail: "", area: "" } as AreaRow);
  });
  // end user: the first readable area wins, else the first area's reason; no area = the no-area policy row
  const eu = tables.map((t) => { const rows = euAll.get(t) as EuRow[]; return rows.find((r) => r.readable) ?? rows[0]; });
  const count = <T>(xs: T[], f: (r: T) => boolean) => xs.filter(f).length;
  console.log(`\n### ${name} — AREA-keyed (subject area, VO entity): ${n} tables, instance ${INSTANCE}, release ${V}\n`);
  console.log("| developer verdict (best of the table's areas) | tables |\n|---|---|");
  console.log(`| secured, direct | ${pct(count(dev, (r) => r.verdict === "secured" && r.route === "direct"))} |`);
  console.log(`| secured, reference | ${pct(count(dev, (r) => r.verdict === "secured" && r.route === "reference"))} |`);
  console.log(`| blocked | ${pct(count(dev, (r) => r.verdict === "blocked"))} |`);
  console.log(`| none (reference data) | ${pct(count(dev, (r) => r.verdict === "none"))} |`);
  console.log(`| no OTBI area reads it | ${pct(count(dev, (r) => r.verdict === "no OTBI area"))} |`);
  const g = new Map<string, number>();
  for (const r of dev) if (r.verdict === "secured") g.set(r.grade, (g.get(r.grade) ?? 0) + 1);
  console.log(`\ndeveloper secured by grade: ${[...g].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  const dc = new Map<string, number>();
  for (const r of dev) if (r.verdict === "blocked") dc.set(r.cls, (dc.get(r.cls) ?? 0) + 1);
  console.log("\n| developer blocked — first area's reason class | tables |\n|---|---|");
  for (const [k, v] of [...dc].sort((x, y) => y[1] - x[1])) console.log(`| ${k} | ${v} |`);

  console.log("\n| END-USER verdict (best of the table's areas; no area = the no-area policy) | tables |\n|---|---|");
  console.log(`| readable | ${pct(count(eu, (r) => r.readable))} |`);
  const eg = new Map<string, number>();
  for (const r of eu) if (r.readable) eg.set(`${r.grade}${r.area ? "" : " (no area)"}`, (eg.get(`${r.grade}${r.area ? "" : " (no area)"}`) ?? 0) + 1);
  for (const [k, v] of [...eg].sort((x, y) => y[1] - x[1])) console.log(`| — readable, ${k} | ${v} |`);
  console.log(`| blocked | ${pct(count(eu, (r) => !r.readable))} |`);
  const ec = new Map<string, number>();
  for (const r of eu) if (!r.readable) ec.set(r.cls, (ec.get(r.cls) ?? 0) + 1);
  for (const [k, v] of [...ec].sort((x, y) => y[1] - x[1])) console.log(`| — blocked, ${k} | ${v} |`);
  // the none tables of the developer view: what the structural rule does with them
  const noneT = dev.filter((r) => r.verdict === "none").map((r) => r.table);
  const euOf = (t: string) => (euAll.get(t) as EuRow[]).find((r) => r.readable) ?? (euAll.get(t) as EuRow[])[0];
  const opened = noneT.filter((t) => euOf(t).readable);
  const children = noneT.filter((t) => !euOf(t).readable);
  console.log(`\nnone tables (developer): ${noneT.length} — the structural rule opens ${opened.length} for end users ` +
    `(${opened.filter((t) => /reference data stays readable|only through non-key columns/.test((euAll.get(t) as EuRow[]).find((r) => r.readable)?.detail ?? "")).length} of them reference-family members WITH a secured relationship), keeps ${children.length} blocked` +
    `${children.length ? ` (e.g. ${children.slice(0, 12).join(", ")})` : ""}`);
  const noArea = tables.filter((t) => !(devAll.get(t) as AreaRow[]).length);
  if (noArea.length) {
    const rd = noArea.filter((t) => (euAll.get(t) as EuRow[])[0].readable);
    console.log(`no-area tables: ${noArea.length} — readable (reference family, structural) ${rd.length}${rd.length ? ` (${rd.slice(0, 10).join(", ")})` : ""}; ` +
      `blocked ${noArea.length - rd.length}, of which with a readInstead equivalent ${noArea.filter((t) => !!(euAll.get(t) as EuRow[])[0].readInstead).length}`);
  }
  const fo = eu.filter((r) => r.readable).reduce((s, r) => s + r.filterOnly, 0);
  console.log(`filter-only columns offered on the readable tables (best area): ${fo}`);
  return { dev, eu };
}

const a = await run("A. tables of OTBI fact folders", factTables);
const b = await run("B. top-300 BIP tables", bipTop);
await resolveAreas([...factTables, ...bipTop]);
const sa = summarize("A. tables of OTBI fact folders", factTables);
const sb = summarize("B. top-300 BIP tables", bipTop);

// ---- revised phase 3 checks ------------------------------------------------------------------------
const areaMatches = (rowArea: string, area: string) => rowArea === area || area.startsWith(`${rowArea} `);
const devRows = [...devAll.values()].flat();
// decision 4: a (table, area) whose condition object carries a curated row of the area must be graded by it
const d4 = devRows.filter((r) => r.verdict === "secured" && curated.some((c) => c.obj_name === r.object && areaMatches(c.area, r.area)));
const d4bad = d4.filter((r) => r.grade !== "trace" && r.grade !== "inferred");
console.log(`\n### decision 4 — the area's known privilege on the object: ${d4.length} (table, area) secured on a curated object of their area; graded otherwise: ${d4bad.length}`);
for (const r of d4bad.slice(0, 30)) console.log(`- ${r.table} in ${r.area}: ${r.grade} ${r.detail}`);
// consensus vs rule: every (area, object) the rule decides, against the consensus of the same (area, object)
const ruled = new Map<string, { area: string; object: string; privilege: string; tables: string[] }>();
for (const r of devRows) {
  if (r.verdict !== "secured" || (r.grade !== "rule" && r.grade !== "equivalent")) continue;
  const k = `${r.area}\u0001${r.object}`;
  const e = ruled.get(k) ?? { area: r.area, object: r.object as string, privilege: (r.privileges as string[])[0], tables: [] };
  e.tables.push(r.table);
  ruled.set(k, e);
}
let agree = 0, nopick = 0;
const disagree: string[] = [];
for (const e of ruled.values()) {
  const c: any = await jobConsensus(INSTANCE, e.area, e.object);
  if ("why" in c) { nopick++; continue; }
  if (c.privilege === e.privilege || c.equivalentTo.includes(e.privilege)) agree++;
  else disagree.push(`${e.area} / ${e.object}: rule ${e.privilege}, consensus ${c.privilege} (${e.tables.length} table(s): ${e.tables.slice(0, 4).join(", ")})`);
}
console.log(`\n### consensus vs rule — ${ruled.size} (area, object) pairs the rule decides: agree ${agree}, disagree ${disagree.length}, no consensus ${nopick}`);
for (const d of disagree) console.log(`- ${d}`);
// consensus picks actually used (developer best area) per population
for (const [p, s] of [["A", sa], ["B", sb]] as const) {
  const cons = s.dev.filter((r) => r.grade === "consensus").length;
  const strict = s.eu.filter((r) => r.readable && r.grade === "strictest").length;
  console.log(`population ${p}: consensus-graded (developer best area) ${cons}; strictest-graded (end user best area) ${strict}`);
}

if (OUT) {
  const lines = ["population,view,table,area,verdict,route,grade,blocked_class,detail,read_instead"];
  const q = (xs: unknown[]) => xs.map((x) => `"${String(x).replace(/"/g, "'")}"`).join(",");
  for (const [p, rows] of [["A", a], ["B", b]] as const) for (const r of rows) lines.push(q([p, "table", r.table, "", r.verdict, r.route, r.grade, r.cls, r.detail, ""]));
  for (const [p, tables] of [["A", factTables], ["B", bipTop]] as const) {
    for (const t of tables) {
      for (const r of devAll.get(t) as AreaRow[]) lines.push(q([p, "developer", t, r.area, r.verdict, r.route, r.grade, r.cls, r.detail, ""]));
      for (const r of euAll.get(t) as EuRow[]) lines.push(q([p, "end-user", t, r.area, r.readable ? "readable" : "blocked", r.route, r.grade, r.cls, r.detail, r.readInstead]));
    }
  }
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\n[secx-r] per-(table, area) verdicts: ${OUT} (${lines.length - 1} rows)`);
}
await closeCatalogDb();
await sql.end({ timeout: 5 });
clearInterval(keepAlive);
