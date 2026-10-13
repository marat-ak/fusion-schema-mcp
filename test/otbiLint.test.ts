/**
 * checkOtbiSql's lint against (a) the 33 real "Oracle BI EE" dataset SQLs found in downloaded data
 * models (test/fixtures/otbi-biee.json — extracted read-only from the DM corpus; the catalog slice
 * they reference comes from the built work.otbi_* tables) and (b) crafted invalid statements. The
 * resolver is in-memory (the fixture), so this suite needs no catalog DB and no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintOtbiSql, nearestNames, tokenize, type LintCatalog } from "../src/corpus/otbiLint.js";

type Col = { name: string; kind: string; aggregation: string | null; data_type: string | null };
type Fixture = { datasets: { file: string; dataset: string; hasBind: boolean; sql: string }[]; subjectAreas: Record<string, Record<string, { kind: string; columns: Col[] | null }> | null> };
const FX: Fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "otbi-biee.json"), "utf8"));

const cat: LintCatalog = {
  async subjectAreaNames() { return Object.keys(FX.subjectAreas).filter((k) => FX.subjectAreas[k]); },
  async folders(sa) { return Object.entries(FX.subjectAreas[sa] ?? {}).map(([name, f]) => ({ name, kind: f.kind })); },
  async columns(sa, folder) { return FX.subjectAreas[sa]?.[folder]?.columns ?? []; },
  async foldersWithColumn(sa, column) {
    return Object.entries(FX.subjectAreas[sa] ?? {}).filter(([, f]) => f.columns?.some((c) => c.name === column)).map(([n]) => n);
  },
};

/** A column name present in at least two loaded folders of `sa` (the fixture loads columns for referenced folders only). */
async function ambiguousColumn(sa: string): Promise<string> {
  const seen = new Map<string, number>();
  for (const f of Object.values(FX.subjectAreas[sa] ?? {})) for (const c of f.columns ?? []) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
  const hit = [...seen.entries()].find(([, n]) => n >= 2);
  if (!hit) throw new Error(`fixture has no column shared by two folders of ${sa}`);
  return hit[0];
}

test("tokenize: quoted identifiers with escapes, strings, binds, comments", () => {
  const t = tokenize(`SELECT "A""B"."C" s_1 FROM "SA" WHERE "X" = 'it''s' AND "Y" = :P_ID -- c\n/* d */`);
  assert.deepEqual(t.filter((x) => x.t === "ident").map((x) => x.v), ['A"B', "C", "SA", "X", "Y"]);
  assert.equal(t.find((x) => x.t === "str")!.v, "'it''s'");
  assert.equal(t.find((x) => x.t === "bind")!.v, ":P_ID");
});

test("nearestNames: normalised exact first, then containment, then edit distance", () => {
  const names = ["- Invoice Amounts", "Invoice Details", "Business Unit", "Supplier"];
  assert.deepEqual(nearestNames("invoice amounts", names)[0], "- Invoice Amounts");
  assert.deepEqual(nearestNames("Invoice", names).slice(0, 2).sort(), ["- Invoice Amounts", "Invoice Details"]);
  assert.deepEqual(nearestNames("Suplier", names), ["Supplier"]);
});

// What the real dataset SQL legitimately trips on — pod-specific content the VENDOR catalog does not
// carry (test/fixtures/otbi-biee.json is built from the shipped scope): extension-object folder
// paths (`Consumer Pkg Info > FB Consumer Product > Main`) and flexfield columns of one pod
// (`Location Attributes_LATITUDE_`). Every other reference of every dataset must resolve.
const EXPECTED_POD_SPECIFIC: Record<string, { code: string; count: number }> = {
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / ConsumerProd": { code: "extension_folder", count: 26 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / FactPanel": { code: "extension_folder", count: 7 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / Allergens": { code: "extension_folder", count: 3 },
  "FBConsumerProductSpec_SQL.xdmz!_datamodel.xdm / Compliance": { code: "extension_folder", count: 2 },
  "Longitude.xdmz!_datamodel.xdm / hc": { code: "unknown_column", count: 2 },
};

test("the 33 real BI EE dataset SQLs: every reference resolves, except pod-specific content, which is named", async () => {
  const known = new Set(Object.keys(FX.subjectAreas).filter((k) => FX.subjectAreas[k]));
  let resolvedRefs = 0, okStatements = 0, customSa = 0, crossSa = 0;
  const failures: string[] = [];
  for (const d of FX.datasets) {
    const r = await lintOtbiSql(d.sql, cat);
    const name = `${d.file.split("/").pop()} / ${d.dataset}`;
    if (r.subjectArea === null && r.errors.some((e) => e.code === "unknown_subject_area")) {
      // the Project Status DM selects from a custom subject area ("custExt…") — not vendor content
      customSa++;
      assert.ok(r.errors[0].suggestions !== undefined);
      continue;
    }
    assert.ok(r.subjectArea && known.has(r.subjectArea), `${name}: subject area resolved`);
    resolvedRefs += r.resolved.length;
    if (r.warnings.some((w) => w.code === "cross_subject_area")) crossSa++;
    const expected = EXPECTED_POD_SPECIFIC[name];
    if (r.ok) okStatements++;
    else if (expected && r.errors.length === expected.count && r.errors.every((e) => e.code === expected.code)) okStatements++;
    else failures.push(`${name}: ${r.errors.map((e) => `${e.code} ${e.ref ?? ""}`).join("; ")}`);
  }
  assert.equal(customSa, 2, "exactly the two Project Status datasets select from a custom subject area");
  assert.deepEqual(failures, [], "real dataset SQL must lint clean against the catalog it was written for");
  assert.equal(okStatements, FX.datasets.length - customSa);
  assert.ok(crossSa >= 3, `cross-subject-area queries are real (Emergency Contacts, HESA, Longitude) and warn, never fail: ${crossSa}`);
  assert.ok(resolvedRefs > 300, `resolved ${resolvedRefs} references`);
});

test("real SQL shapes: SET VARIABLE prefix, UNION branches in a derived table, FROM folder aliases, REPORT_ aggregates", async () => {
  const abs = FX.datasets.find((d) => d.dataset === "Abs Balance")!;
  const r = await lintOtbiSql(abs.sql, cat);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.notes.some((n) => /SET VARIABLE/.test(n)));
  assert.ok(r.resolved.some((x) => x.column === "Accrual Plan Name") && r.resolved.some((x) => x.column === "Absence Status"), "both UNION branches resolved against their own FROM");
  const hh = FX.datasets.find((d) => d.dataset === "HH_OTBI")!;
  const h = await lintOtbiSql(hh.sql, cat);
  assert.equal(h.ok, true, JSON.stringify(h.errors));
  assert.ok(h.resolved.some((x) => x.folder === "Fact - Benefits Billing Payments" && x.column === "Amount Due"), "\"Alias\".\"Column\" resolves through the FROM alias");
  assert.ok(h.warnings.some((w) => w.code === "aggregate_function" && /REPORT_/i.test(w.message)));
  const pp = FX.datasets.find((d) => d.dataset === "perfPromote")!;
  const p = await lintOtbiSql(pp.sql, cat);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.ok(p.resolved.length >= 12, "both derived tables resolved; the outer Promotions.s_6 references are derived-table columns");
});

test("real SQL: two-part FROM form (crawl probes) and three-part form both resolve; measures are reported", async () => {
  const hc = FX.datasets.find((d) => d.dataset === "HC")!;
  const r = await lintOtbiSql(hc.sql, cat);
  assert.equal(r.ok, true);
  assert.equal(r.subjectArea, "Workforce Management - Worker Assignment Real Time");
  assert.ok(r.measures.includes("Head Count"), `measures: ${r.measures.join(", ")}`);
  assert.ok(r.resolved.some((x) => x.ref === '"Workforce Management - Worker Assignment Real Time"."Worker"."Employee Name"' && x.kind === "attribute"));
  const two = await lintOtbiSql(`SELECT "Employee Name", "Head Count" FROM "Workforce Management - Worker Assignment Real Time"."Worker" FETCH FIRST 10 ROWS ONLY`, cat);
  assert.ok(two.errors.some((e) => e.code === "unknown_column" && e.ref === '"Head Count"'), "Head Count is not in Worker — it is a measure of another folder");
  assert.ok(two.errors[0].message.includes("it exists in"));
  const two2 = await lintOtbiSql(`SELECT "Employee Name" FROM "Workforce Management - Worker Assignment Real Time"."Worker"`, cat);
  assert.equal(two2.ok, true); assert.equal(two2.fromFolder, "Worker");
  assert.ok(two2.notes.some((n) => /FETCH FIRST/.test(n)));
});

test("crafted invalid statements", async () => {
  const SA = "Workforce Management - Worker Assignment Real Time";
  const cases: { sql: string; code: string; check?: (r: any) => void }[] = [
    { sql: `SELECT "Worker"."Employee Name" FROM "Workforce Managment - Worker Assignment Real Time"`, code: "unknown_subject_area",
      check: (r) => assert.equal(r.errors[0].suggestions[0], SA) },
    { sql: `SELECT "${SA}"."Workers"."Employee Name" FROM "${SA}"`, code: "unknown_folder",
      check: (r) => assert.ok(r.errors[0].suggestions.includes("Worker")) },
    { sql: `SELECT "${SA}"."Worker"."Employee Nmae" FROM "${SA}"`, code: "unknown_column",
      check: (r) => assert.ok(r.errors[0].suggestions.includes("Employee Name")) },
    { sql: `SELECT * FROM "${SA}"`, code: "select_star" },
    { sql: `SELECT "${SA}"."Worker"."Employee Name"`, code: "no_from" },
    // an unqualified column that several loaded folders of the fixture carry (chosen at run time so
    // the case does not depend on which folders the fixture happened to load)
    { sql: `SELECT "${await ambiguousColumn(SA)}" FROM "${SA}"`, code: "ambiguous_column" },
    { sql: `SELECT "${SA}"."Worker"."Employee Name"."Extra" FROM "${SA}"`, code: "invalid_reference" },
    { sql: `SELECT "${SA}"."Worker"."Employee Name" FROM "${SA}"."Worker"."Extra"`, code: "invalid_reference" },
    { sql: `SELECT "${SA}"."Consumer Pkg Info > FB Consumer Product > Main"."EGO_ITEM_DL_FB_ConsumerPkgInfo_FBbrand" FROM "${SA}"`, code: "extension_folder" },
    { sql: `UPDATE "${SA}" SET x = 1`, code: "not_a_select" },
  ];
  for (const c of cases) {
    const r = await lintOtbiSql(c.sql, cat);
    assert.equal(r.ok, false, c.sql);
    assert.ok(r.errors.some((e) => e.code === c.code), `${c.sql}\n expected ${c.code}, got ${r.errors.map((e) => e.code).join(",")}`);
    c.check?.(r);
  }
  // cross-subject-area references are a WARNING (OBIEE runs them when the areas share a business model)
  for (const sql of [
    `SELECT "${SA}"."Worker"."Employee Name", "Workforce Management - Person Real Time"."Worker"."Person ID" FROM "${SA}"`,
    `SELECT "${SA}"."Worker"."Employee Name" FROM "${SA}", "Workforce Management - Person Real Time"`,
  ]) {
    const r = await lintOtbiSql(sql, cat);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.warnings.some((w) => w.code === "cross_subject_area"), sql);
  }
});

test("warnings: case/space spelling resolves with the canonical name; aggregate functions are flagged", async () => {
  const SA = "Workforce Management - Worker Assignment Real Time";
  const r = await lintOtbiSql(`SELECT "${SA.toLowerCase()}"."worker"."employee name", SUM("${SA}"."Worker Assignment"."Head Count") FROM "${SA}"`, cat);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.filter((w) => w.code === "name_spelling").length >= 2);
  assert.equal(r.warnings.find((w) => w.code === "name_spelling")!.suggestions![0], SA);
  assert.ok(r.warnings.some((w) => w.code === "aggregate_function"));
  assert.ok(r.resolved.some((x) => x.column === "Employee Name"), "resolved to the canonical spelling");
});

test("aliases are not references: AS \"Alias\", bare \"Alias\" after an expression, ORDER BY alias", async () => {
  const SA = "Workforce Management - Worker Assignment Real Time";
  const r = await lintOtbiSql(`SELECT "${SA}"."Worker"."Employee Name" AS "Name", "${SA}"."Worker"."Person ID" "PID" FROM "${SA}" ORDER BY "Name"`, cat);
  assert.deepEqual(r.errors, []);
  assert.equal(r.resolved.length, 2);
});
