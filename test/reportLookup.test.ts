import { test } from "node:test";
import assert from "node:assert/strict";
import { embed } from "../src/corpus/embed.js";
import { openTempCatalog } from "./fixture.js";

test("getReportQuery + listQueriesForSubjectArea: exact title lookup", async () => {
  const keepAlive = setInterval(() => {}, 1 << 30); // embed.ts unref()s its worker — pin the loop while embedding
  const { db } = await openTempCatalog("rq-");
  const rows = [
    { id: "otbi:SA__Contracts", title: "Absence.Contracts", originalSql: "SELECT c1 FROM machine", cleanSql: "SELECT DESCRIPTION FROM PER_CONTRACTS_F", description: "worker contracts", tablesUsed: ["PER_CONTRACTS_F"] },
    { id: "otbi:SA__Business Unit", title: "Absence.Business Unit", originalSql: "SELECT c1 FROM m2", cleanSql: "SELECT NAME FROM HR_ALL_ORGANIZATION_UNITS_F", description: "business units", tablesUsed: ["HR_ALL_ORGANIZATION_UNITS_F"] },
  ];
  const vecs = await embed(rows.map((r) => r.description));
  clearInterval(keepAlive);
  await db.corpus.materialize(rows.map((r) => ({ ...r, source: "otbi", lookupTypes: [] })), vecs.map((v) => [v]));

  const { getReportQuery, listQueriesForSubjectArea } = await import("../src/catalog.js");

  const q = (await getReportQuery("Absence.Contracts")) as any;
  assert.equal(q.found, true);
  assert.equal(q.originalSql, "SELECT c1 FROM machine");
  assert.match(q.cleanSql, /PER_CONTRACTS_F/);
  assert.deepEqual(q.tablesUsed, ["PER_CONTRACTS_F"]);

  const miss = (await getReportQuery("Absence.Contract")) as any; // near-miss
  assert.equal(miss.found, false);
  assert.ok(miss.suggestions.includes("Absence.Contracts"));

  const list = await listQueriesForSubjectArea("Absence");
  assert.equal(list.length, 2);
  assert.ok(list.map((x: any) => x.title).includes("Absence.Business Unit"));
});
