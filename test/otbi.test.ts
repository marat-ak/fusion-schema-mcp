/**
 * OTBI presentation catalog + unit_titles through the library and the tool functions, on the
 * provider `CATALOG_DB` names (sqlite / postgres — same fixture, same assertions). The vectors are
 * real bge-small embeddings of the fixture texts, so searchOtbi is exercised end to end.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { embed } from "../src/corpus/embed.js";
import { openTempCatalog, dropScratchDbs } from "./fixture.js";
import type { OtbiColumnRow, OtbiFolderRow, OtbiSubjectAreaRow, OtbiVecRow } from "../src/db/types.js";

const keepAlive = setInterval(() => {}, 1 << 30); // embed.ts unref()s its worker
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const AP = "Payables Invoices - Transactions Real Time";
const GL = "General Ledger - Balances Real Time";

// texts exactly as p3_otbi.sql builds them: column text carries no subject area, so the same column
// in two subject areas is ONE text (one vector, two locations)
const colText = (name: string, kind: string, agg: string | null, desc: string | null) =>
  name + (kind === "measure" ? ` (measure${agg ? ", " + agg : ""})` : "") + (desc ? `: ${desc}` : "");
const col = (sa: string, folder: string, name: string, kind: "attribute" | "measure", desc: string | null, extra: Partial<OtbiColumnRow> = {}): OtbiColumnRow => {
  const text = colText(name, kind, extra.aggregation ?? (kind === "measure" ? "sum" : null), desc);
  return {
    subject_area: sa, folder, name, data_type: kind === "measure" ? "double" : "varchar", kind, aggregation: kind === "measure" ? "sum" : null,
    expression: null, db_refs: JSON.stringify(extra.db_refs ? JSON.parse(extra.db_refs) : [{ t: "AP_INVOICES_ALL", c: "INVOICE_AMOUNT", src: ["lineage", "probe"] }]),
    vo_refs: null, indexed: 0, description: desc, desc_source: desc ? "table_remark" : null, gap_cause: desc ? null : "ref_without_remark",
    in_lineage: 1, in_crawl: 1, in_probe: 1, ordinal: 0, text_hash: md5(text), ...extra,
  };
};
const folder = (sa: string, name: string, kind: "fact" | "dimension", desc: string | null, extra: Partial<OtbiFolderRow> = {}): OtbiFolderRow => {
  const text = `${sa} > ${name} (${kind})${desc ? ": " + desc : ""}`;
  return {
    subject_area: sa, name, kind, kind_source: kind === "fact" ? "measures" : "default", description: desc, desc_source: desc ? "otbi-unit enrichment" : null,
    db_tables: JSON.stringify(["AP_INVOICES_ALL"]), n_columns: 2, n_measures: kind === "fact" ? 1 : 0, in_lineage: 1, in_crawl: 1, in_corpus: 1,
    unit_id: `otbi:${sa}__${name}`, grain_note: null, nested: 0, ordinal: 0, text_hash: md5(text), ...extra,
  };
};
const sa = (name: string, pillar: string, facts: string[]): OtbiSubjectAreaRow => {
  const text = `${name} (${pillar})`;
  return { name, pillar, n_folders: 2, n_fact_folders: facts.length, n_columns: 4, fact_folders: JSON.stringify(facts), in_lineage: 1, in_crawl: 1, in_corpus: 1, text_hash: md5(text) };
};

const SAS = [sa(AP, "fin", ["- Invoice Amounts"]), sa(GL, "fin", ["Balances"])];
const FOLDERS = [
  folder(AP, "- Invoice Amounts", "fact", "Invoice header amounts: invoice, paid, tax, discount."),
  folder(AP, "Supplier", "dimension", "The supplier (party) of the invoice."),
  folder(GL, "Balances", "fact", null, { unit_id: null, in_corpus: 0, description: null }),
  folder(GL, "Ledger", "dimension", "Ledger name, description and chart of accounts.", { nested: 0 }),
];
const COLUMNS = [
  col(AP, "- Invoice Amounts", "Invoice Amount", "measure", "Invoice amount in the invoice currency (AP_INVOICES_ALL.INVOICE_AMOUNT)"),
  col(AP, "- Invoice Amounts", "Paid Amount", "measure", "Amount paid to date on the invoice (AP_INVOICES_ALL.AMOUNT_PAID)"),
  col(AP, "Supplier", "Supplier Name", "attribute", "Name of the supplier party (POZ_SUPPLIERS_V.VENDOR_NAME)"),
  col(AP, "Supplier", "Supplier Number", "attribute", null),
  col(GL, "Balances", "Ending Balance", "measure", null, { gap_cause: "empty_sql_folder", in_probe: 0 }),
  col(GL, "Ledger", "Ledger Name", "attribute", "Name of the ledger (GL_LEDGERS.NAME)"),
  // the same column text in a second subject area → same text_hash, second location
  col(GL, "Ledger", "Supplier Name", "attribute", "Name of the supplier party (POZ_SUPPLIERS_V.VENDOR_NAME)"),
];

const { db } = await openTempCatalog("otbi-");

test("otbi: replaceAll, reads, knn ≡ nearest text, hashes resolve to every location", async () => {
  const texts = new Map<string, { kind: string; text: string }>();
  for (const c of COLUMNS) texts.set(c.text_hash!, { kind: "column", text: colText(c.name, c.kind, c.aggregation, c.description) });
  for (const f of FOLDERS) texts.set(f.text_hash!, { kind: "folder", text: `${f.subject_area} > ${f.name} (${f.kind})${f.description ? ": " + f.description : ""}` });
  for (const s of SAS) texts.set(s.text_hash!, { kind: "subject_area", text: `${s.name} (${s.pillar})` });
  const keys = [...texts.keys()];
  const vecs = await embed(keys.map((k) => texts.get(k)!.text));
  const rows: OtbiVecRow[] = keys.map((k, i) => ({ text_hash: k, kind: texts.get(k)!.kind, vec: vecs[i] }));
  const r = await db.otbi.replaceAll(SAS, FOLDERS, COLUMNS, rows, "test", { vos: [], areaDuties: [], areaJobs: [], guideRelease: "test", unmappedAreas: { [AP]: "test", [GL]: "test" } });
  assert.deepEqual(r, { subjectAreas: 2, folders: 4, columns: 7, vectors: keys.length, vos: 0, columnRefs: 7, areaDuties: 0, areaJobs: 0 });
  assert.equal(keys.length, COLUMNS.length - 1 + FOLDERS.length + SAS.length, "the duplicated column text is ONE vector");
  assert.deepEqual(await db.otbi.counts(), r);
  assert.equal(await db.otbi.version(), "test");

  assert.equal((await db.otbi.subjectArea(AP))!.pillar, "fin");
  assert.equal(await db.otbi.subjectArea("nope"), null);
  assert.deepEqual(await db.otbi.subjectAreaNames(), [GL, AP]);
  assert.deepEqual((await db.otbi.folders(AP)).map((f) => f.name), ["- Invoice Amounts", "Supplier"]);
  assert.equal((await db.otbi.folder(AP, "- Invoice Amounts"))!.kind, "fact");
  assert.equal(await db.otbi.folder(AP, "Invoice Amounts"), null, "verbatim: the `- ` prefix is part of the name");
  assert.deepEqual((await db.otbi.columns(AP, "- Invoice Amounts")).map((c) => c.name), ["Invoice Amount", "Paid Amount"]);
  assert.deepEqual(await db.otbi.foldersWithColumn(AP, "Supplier Name"), ["Supplier"]);

  const [q] = await embed(["how much did we pay the supplier on the invoice"]);
  const hits = await db.otbi.knn(q, 3);
  assert.equal(hits.length, 3);
  const paid = COLUMNS.find((c) => c.name === "Paid Amount")!;
  assert.ok(hits.some((h) => h.text_hash === paid.text_hash), `Paid Amount among the top-3: ${hits.map((h) => texts.get(h.text_hash)!.text).join(" | ")}`);
  const shared = COLUMNS.find((c) => c.name === "Supplier Name" && c.subject_area === AP)!;
  const both = await db.otbi.columnsByHash([shared.text_hash!], undefined, 10);
  assert.deepEqual(both.map((c) => `${c.subject_area}/${c.folder}`), [`${GL}/Ledger`, `${AP}/Supplier`], "one hash → both locations");
  assert.equal((await db.otbi.columnsByHash([shared.text_hash!], AP, 10)).length, 1, "subject-area filter");
  assert.equal((await db.otbi.columnsByHash([shared.text_hash!], undefined, 1)).length, 1, "perHash cap");
  assert.equal((await db.otbi.foldersByHash([FOLDERS[0].text_hash!], undefined))[0].name, "- Invoice Amounts");
  assert.equal((await db.otbi.subjectAreasByHash([SAS[1].text_hash!]))[0].name, GL);
});

test("unit_titles: byTitle / siblings / byTitlePrefix resolve alias titles to the shared statement", async () => {
  const rows = [
    { id: "sql:aaa", title: `${AP}.- Invoice Amounts`, originalSql: "SELECT c1 FROM ap", cleanSql: "SELECT INVOICE_AMOUNT FROM AP_INVOICES_ALL", description: "invoice amounts", tablesUsed: ["AP_INVOICES_ALL"] },
    { id: "sql:bbb", title: `${GL}.Ledger`, originalSql: "SELECT c1 FROM gl", cleanSql: "SELECT NAME FROM GL_LEDGERS", description: "ledgers", tablesUsed: ["GL_LEDGERS"] },
  ];
  const vecs = await embed(rows.map((r) => r.description));
  await db.corpus.materialize(rows.map((r) => ({ ...r, source: "otbi", lookupTypes: [] })), vecs.map((v) => [v]));
  // the Supplier folder's physical SQL is the SAME statement as - Invoice Amounts (one hash, two titles)
  assert.equal(await db.corpus.replaceUnitTitles([
    { title: `${AP}.- Invoice Amounts`, id: "sql:aaa", source: "otbi" },
    { title: `${AP}.Supplier`, id: "sql:aaa", source: "otbi" },
    { title: `${GL}.Ledger`, id: "sql:bbb", source: "otbi" },
  ]), 3);
  assert.equal(await db.corpus.unitTitleCount(), 3);
  assert.equal((await db.corpus.byTitle(`${AP}.Supplier`))!.id, "sql:aaa", "an alias title resolves through unit_titles");
  assert.equal((await db.corpus.byTitle(`${AP}.- Invoice Amounts`))!.id, "sql:aaa");
  assert.equal(await db.corpus.byTitle(`${AP}.Nope`), null);
  assert.deepEqual((await db.corpus.siblings(`${AP}.Supplier`)).map((s) => s.id), ["sql:aaa"]);
  const pre = await db.corpus.byTitlePrefix(`${AP}.%`, 10);
  assert.deepEqual(pre.map((p) => [p.title, p.canonicalTitle, p.id]), [
    [`${AP}.- Invoice Amounts`, `${AP}.- Invoice Amounts`, "sql:aaa"],
    [`${AP}.Supplier`, `${AP}.- Invoice Amounts`, "sql:aaa"],
  ], "one row per unit title, canonicalTitle = the corpus row's title");
  assert.ok((await db.corpus.nearTitles("%Supplier%")).includes(`${AP}.Supplier`));

  const { getReportQuery, listQueriesForSubjectArea } = await import("../src/catalog.js");
  const q = (await getReportQuery(`${AP}.Supplier`)) as any;
  assert.equal(q.found, true); assert.equal(q.id, "sql:aaa");
  assert.equal(q.requestedTitle, `${AP}.Supplier`); assert.equal(q.title, `${AP}.- Invoice Amounts`);
  assert.equal(((await getReportQuery(`${AP}.- Invoice Amounts`)) as any).requestedTitle, undefined, "the canonical title needs no echo");
  const list = await listQueriesForSubjectArea(AP);
  assert.deepEqual(list.map((x) => x.title), [`${AP}.- Invoice Amounts`, `${AP}.Supplier`]);
  assert.equal(list[1].canonicalTitle, `${AP}.- Invoice Amounts`);
});

test("tools: searchOtbi / describeOtbiFolder / checkOtbiSql over the fixture catalog", async () => {
  const { searchOtbi, describeOtbiFolder, checkOtbiSql } = await import("../src/corpus/otbiStore.js");
  const s = (await searchOtbi("supplier name", { limit: 5 })) as any;
  assert.ok(s.hits.length >= 1);
  const top = s.hits.find((h: any) => h.hit === "column" && h.name === "Supplier Name");
  assert.ok(top, `Supplier Name found: ${JSON.stringify(s.hits.map((h: any) => h.name ?? h.folder ?? h.subjectArea))}`);
  assert.equal(top.locations.length, 2, "both subject areas listed");
  assert.equal(top.kind, "attribute");
  const narrowed = (await searchOtbi("supplier name", { subjectArea: AP, limit: 5 })) as any;
  const t2 = narrowed.hits.find((h: any) => h.hit === "column" && h.name === "Supplier Name");
  assert.deepEqual(t2.locations, [{ subjectArea: AP, folder: "Supplier" }]);
  const bad = (await searchOtbi("x", { subjectArea: "Payables Invoices" })) as any;
  assert.equal(bad.found, false); assert.deepEqual(bad.suggestions, [AP]);

  const tree = (await describeOtbiFolder(AP)) as any;
  assert.equal(tree.found, true);
  assert.deepEqual(tree.facts.map((f: any) => f.name), ["- Invoice Amounts"]);
  assert.deepEqual(tree.dimensions.map((f: any) => f.name), ["Supplier"]);
  const f = (await describeOtbiFolder(AP, "- Invoice Amounts")) as any;
  assert.equal(f.found, true);
  assert.deepEqual(f.columns.map((c: any) => [c.name, c.kind, c.aggregation]), [["Invoice Amount", "measure", "sum"], ["Paid Amount", "measure", "sum"]]);
  assert.deepEqual(f.columns[0].dbRefs, ["AP_INVOICES_ALL.INVOICE_AMOUNT"]);
  assert.ok(f.physicalSql.includes(`${AP}.- Invoice Amounts`));
  const miss = (await describeOtbiFolder(AP, "Invoice Amounts")) as any;
  assert.equal(miss.found, false); assert.equal(miss.suggestions[0], "- Invoice Amounts");
  const gl = (await describeOtbiFolder(GL, "Balances")) as any;
  assert.equal(gl.columns[0].noDescriptionBecause, "empty_sql_folder");

  const ok = await checkOtbiSql(`SELECT "${AP}"."Supplier"."Supplier Name" s_1, "${AP}"."- Invoice Amounts"."Invoice Amount" s_2 FROM "${AP}" WHERE "${AP}"."Supplier"."Supplier Name" = :P_SUPPLIER FETCH FIRST 100 ROWS ONLY`);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.measures, ["Invoice Amount"]);
  const two = await checkOtbiSql(`SELECT "Invoice Amount", "Paid Amount" FROM "${AP}"."- Invoice Amounts"`);
  assert.equal(two.ok, true); assert.equal(two.resolved.length, 2);
  const bad2 = await checkOtbiSql(`SELECT "${AP}"."Supplier"."Supplier Nam" FROM "${AP}"`);
  assert.equal(bad2.ok, false); assert.equal(bad2.errors[0].code, "unknown_column"); assert.ok(bad2.errors[0].suggestions!.includes("Supplier Name"));
  const cross = await checkOtbiSql(`SELECT "${AP}"."Supplier"."Supplier Name", "${GL}"."Ledger"."Ledger Name" FROM "${AP}"`);
  assert.equal(cross.ok, true, "a cross-subject-area query is a warning, not an error (OBIEE runs it when the areas share a model)");
  assert.ok(cross.warnings.some((w) => w.code === "cross_subject_area"));
});

// cleanup in a hook, never at the end of a test: a failed assertion must not leave the keep-alive
// interval pinning the runner
after(async () => {
  clearInterval(keepAlive);
  await db.close();
  await dropScratchDbs();
});
