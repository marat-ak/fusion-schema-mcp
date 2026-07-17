import { test } from "node:test";
import assert from "node:assert/strict";
import { otbiMeta } from "../src/corpus/otbiMeta.js";

test("extracts tables, lookups, and pulls out the security predicate", () => {
  const raw = { relations: {
    dbTables: ["PER_CONTRACTS_F", "HCM_LOOKUPS"],
    joins: [{ from: "A.X", to: "B.X", outer: true }],
    filters: ["HCM_LOOKUPS.LOOKUP_TYPE = 'CONTRACT_STATUS'",
              "P.PERSON_ID = (SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-1)"],
    lookupTypes: ["CONTRACT_STATUS"],
  }};
  const m = otbiMeta(raw);
  assert.deepEqual(m.tablesUsed, ["PER_CONTRACTS_F", "HCM_LOOKUPS"]);
  assert.deepEqual(m.lookupTypes, ["CONTRACT_STATUS"]);
  assert.equal(m.joins.length, 1);
  assert.match(m.securityPredicate!, /GET_USER_PERSONID/);
  assert.ok(!m.filters.some((f) => /GET_USER_PERSONID/.test(f)), "security pred removed from filters");
});

test("non-OTBI raw yields empty metadata", () => {
  assert.deepEqual(otbiMeta({}), { tablesUsed: [], lookupTypes: [], joins: [], filters: [], securityPredicate: null });
});
