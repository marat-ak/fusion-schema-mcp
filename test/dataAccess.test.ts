/**
 * Data-access security — the resolver (src/corpus/dataAccess.ts), the pushed payload, the developer
 * getDataAccessPredicate PLAN (table-keyed, or keyed on one subject area) and the END-USER getSecuredQueryPlan
 * (plan 2026-10-04 phases 1 + 2: {instance, tables[, subjectArea(s)]} → {…, ctes[{…, keying, grade}], rewrite,
 * pairs, blocked, …} — no skeleton; the area keying, the area-duty route, the gate input, the column
 * whitelist; revised phase 3 = the job-role consensus, the strictest of candidates, the area's known privilege, the
 * structural none rule with the reference families, the filter-only columns, the no-area policy, the traced context
 * column, loader v4 role grants), on the provider `CATALOG_DB` names (sqlite / postgres — same fixture, same assertions). Two
 * layers are built the way the pipeline / loader build them: the RELEASE facts (table_security rows, the
 * disallowed object, curated area rows with instance scope and (area, entity) keys, sec_meta from the REAL
 * p5_security_rules.json — incl. the audited primary contexts, the context evidence objects and the sensitive
 * objects; the OTBI lineage: columns with db_refs = the exposure index, VOs, area → duty codes) through
 * `security.replaceAll` / `otbi.replaceAll`, and the per-INSTANCE layer (two pods, v3: grant signatures on
 * every granted pair + duty aliases) through `security.replaceLayer`.
 * NO condition text and NO pod id exist anywhere in what is served — asserted, not assumed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTempCatalog, dropScratchDbs } from "./fixture.js";
import type { OtbiAreaDutyRow, OtbiAreaJobRow, OtbiColumnRow, OtbiFolderRow, OtbiSubjectAreaRow, OtbiVoRow, ReferenceFamilyRow, SecAreaPrivilegeRow, SecLayerInput, TableDisallowedRow, TableSecurityRow } from "../src/db/types.js";

const { db } = await openTempCatalog("sec-");
const catalog = await import("../src/catalog.js");
const { getDataAccessPredicate, getSecuredQueryPlan, compactDataSecurity, dataSecurityFor, exposesInputs, endUserAccess, jobConsensus } = await import("../src/corpus/dataAccess.js");
const { readLayerDir } = await import("../src/securityLayer.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(fs.readFileSync(path.join(HERE, "..", "scripts", "pipeline", "p5_security_rules.json"), "utf8"));
/** the grades of the TABLE-keyed developer plan; consensus (area keying), strictest and structural (end user) have their own tests */
const GRADES = ["trace", "inferred", "rule", "duty", "granted", "equivalent", "sensitive"];

/** sec_meta exactly as p5_security.sql §10 writes it (the keys the serving side requires); the masked twins are
 *  what the job derives from the release dictionary — here the fixture's IBY_EXT_BANK_ACCOUNTS columns below. */
const MASKED_FIXTURE: Record<string, { column: string; use: string }[]> = {
  IBY_EXT_BANK_ACCOUNTS: [{ column: "BANK_ACCOUNT_NUM", use: "MASKED_BANK_ACCOUNT_NUM" }, { column: "IBAN", use: "MASKED_IBAN" }],
};
const PRIMARY_AUDIT = Object.fromEntries(Object.entries(RULES.primaryByPrefix as Record<string, any>)
  .filter(([k, v]) => !k.startsWith("_") && v.audit).map(([k, v]) => [k, { contexts: v.contexts, source: v.audit.source, evidence: v.audit.evidence }]));
const SENSITIVE = Object.fromEntries((RULES.sensitive.rows as any[]).map((r) => [r.table,
  { object: r.object, privileges: r.privileges, evidence: r.evidence, masked: r.maskedOnly ? MASKED_FIXTURE[r.table] : [] }]));
const META: Record<string, string> = {
  version: "2", built_at: "test", source_release: "v2999_01", rules_version: RULES.version,
  context_order: JSON.stringify(RULES.contexts.map((c: { context: string }) => c.context)),
  hcm_prefixes: JSON.stringify(RULES.exclude.hcmPrefixes),
  privilege_prefix_aliases: JSON.stringify(RULES.privilegePrefixAliases.map),
  primary_audit: JSON.stringify(PRIMARY_AUDIT),
  sensitive_objects: JSON.stringify(SENSITIVE),
  // per context: its reference object + evidence objects (p5_security.sql: evidence_refs || ref_object)
  context_evidence_refs: JSON.stringify(Object.fromEntries(RULES.contexts.map((c: { context: string; ref: string; evidenceRefs?: string[] }) =>
    [c.context, [...(c.evidenceRefs ?? []), c.ref.split(".")[0]]]))),
  stats: "{}",
};

const CTX = Object.fromEntries(RULES.contexts.map((c: { context: string; urda: string; ref: string }) => [c.context, c]));
const row = (table: string, column: string, context: string, primary: number, confidence = "name", evidence = 0): TableSecurityRow => ({
  table_name: table, column_name: column, context, urda_column: CTX[context].urda,
  ref_object: CTX[context].ref.split(".")[0], ref_column: CTX[context].ref.split(".")[1],
  is_primary: primary, confidence, evidence, reason: `${confidence} ${column} -> ${context}`,
});
const ROWS: TableSecurityRow[] = [
  // AP is audited (BU, the Kornit trace): the primary BU is secured, LEDGER / PRJ_ORG are facts only
  row("AP_INVOICES_ALL", "ORG_ID", "BU", 1, "name", 12), row("AP_INVOICES_ALL", "SET_OF_BOOKS_ID", "LEDGER", 0), row("AP_INVOICES_ALL", "EXPENDITURE_ORGANIZATION_ID", "PRJ_ORG", 0),
  // an AP table whose primary is NOT the audited context
  row("AP_LEDGER_ONLY", "SET_OF_BOOKS_ID", "LEDGER", 1), row("AP_LEDGER_ONLY", "PJC_ORGANIZATION_ID", "PRJ_ORG", 0),
  row("AP_CHECKS_ALL", "ORG_ID", "BU", 1),
  row("GL_JE_HEADERS", "LEDGER_ID", "LEDGER", 1, "oracle_precedent", 7),
  // a registered table keeps its context facts (served as facts; the plan secures it through its own grants)
  row("PO_HEADERS_ALL", "REQ_BU_ID", "BU", 1, "oracle_policy", 4), row("PO_HEADERS_ALL", "PRC_BU_ID", "BU", 0),
  row("INV_MATERIAL_TXNS", "ORGANIZATION_ID", "INV_ORG", 1, "fk", 3),
  row("WSH_NEW_DELIVERIES", "ORGANIZATION_ID", "INV_ORG", 1, "fk", 2),
  row("CST_ITEM_COSTS", "COST_ORG_ID", "COST_ORG", 1),
  row("WIE_WORK_ORDERS_B", "ORGANIZATION_ID", "MFG_ORG", 1, "module", 1),
  row("FA_BOOKS", "BOOK_TYPE_CODE", "BOOK", 1, "name", 26),
  // two columns of ONE context, prefix ZZ unaudited: blocked (the primary-only choice needs an audit)
  row("ZZ_TWO_BU", "PRC_BU_ID", "BU", 1), row("ZZ_TWO_BU", "REQ_BU_ID", "BU", 0),
  row("ZZ_ONE_BU", "ORG_ID", "BU", 1), row("ZZ_NULLABLE", "ORG_ID", "BU", 1),
  row("ZZ_CONFLICT", "ORG_ID", "BU", 1), row("ZZ_UNGRANTED", "ORG_ID", "BU", 1),
  // a module with no privilege on the BU view in U: pool 2 over all of the pod's grants on it
  row("CE_STATEMENT_LINES", "ORG_ID", "BU", 1),
  // two contexts, prefix ZZ unaudited: table-keyed = blocked; area-keyed = the area's VO evidence decides (or blocks)
  row("ZZ_TWO_CTX", "ORG_ID", "BU", 1), row("ZZ_TWO_CTX", "LEDGER_ID", "LEDGER", 0),
];
const DISALLOWED: TableDisallowedRow[] = [{
  table_name: "FFS_SCHEDULE",
  reason: "ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and FFS_SCHEDULE is used by no corpus SQL (BIP, OTBI, view text), join, relationship or OTBI lineage",
}];
const INST_A = "pod-a.example.oraclecloud.com";
const INST_B = "pod-b.example.oraclecloud.com";
const BU = "FUN_ALL_BUSINESS_UNITS_V";
/** a curated row; `entity` = its (area, entity) key (ddl_version 9) — null on a product-level row */
const area = (area_or_product: string, ordinal: number, obj_name: string, privilege: string, source: string, instance_scope: string, evidence: string, entity: string | null = obj_name,
  context_column: string | null = null): SecAreaPrivilegeRow =>
  ({ area_or_product, ordinal, obj_name, privilege, source, evidence, instance_scope, entity_table: entity, vo_def: null, context_column });
const AREA: SecAreaPrivilegeRow[] = [
  area("AP", 1, BU, "AP_REPORT_PAYABLES_DATA", "trace", "*", "Kornit OTBI trace 2026-10-02", null),
  area("Payables", 1, BU, "AP_REPORT_PAYABLES_DATA", "trace", "*", "same trace"),
  area("General Ledger - Journals Real Time", 1, "GL_LEDGERS", "GL_REPORT_GENERAL_LEDGER_DATA", "inferred", "*", "demo-pod crawl: block on GL_LEDGERS"),
  // scoped to ONE pod: pod-b takes the rule
  area("ZZ", 1, BU, "ZZ_CURATED_DATA", "inferred", INST_A, "user decision for pod-a", null),
  // two rows of one area disagree: blocked, never a pick
  area("ZZ2", 1, BU, "ZZ_CURATED_DATA", "inferred", "*", "row one", null), area("ZZ2", 2, BU, "AP_REPORT_PAYABLES_DATA", "inferred", "*", "row two", null),
  // a curated pair with no grant on the instance
  area("ZZ3", 1, BU, "AP_MANAGE_PAYABLES_INVOICE_DATA", "inferred", "*", "not granted on pod-a", null),
  // a subject-area row on a REFERENCE object speaks for the area's facts: AP_CHECKS_ALL is only a dimension there — no conflict
  area("Supply Chain Financial Orchestration Real Time", 1, BU, "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "inferred", "*", "demo-pod id identity"),
  // a subject-area row on the table's OWN object applies from any folder (the Item-entity evidence)
  area("Zed - Things Real Time", 1, "ZZ_DIRECT_DIM", "ZZ_VIEW_Y_DATA", "inferred", "*", "demo-pod: the thing entity is secured as a dimension"),
  // ddl_version 10: a trace names the column of the table the entity is joined to (REQ_BU_ID, not the primary PRC_BU_ID)
  area("Zed - Two BU Real Time", 1, BU, "AP_REPORT_PAYABLES_DATA", "trace", "*", "trace: the area joins the entity on REQ_BU_ID", BU, "ZZ_TWO_BU.REQ_BU_ID"),
  // decision 4: the area's KNOWN privilege on the object, keyed to an entity that is not the table's — still beats the rule
  area("Zed - Known Real Time", 1, BU, "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "inferred", "*", "the area's known privilege on the BU view", "WSH_NEW_DELIVERIES"),
];
/** the reference families (p5_security.sql §9b) */
const fam = (table_name: string, family: string, base_table: string | null = null): ReferenceFamilyRow => ({ table_name, family, base_table, evidence: `test: ${family}` });
const FAMILIES: ReferenceFamilyRow[] = [fam("AP_LOOKUP_CODES", "lookup"), fam("FND_TERRITORIES_VL", "territory"), fam("ZZ_THINGS_TL", "translation", "ZZ_THINGS_B"),
  fam("ZZ_NOTES_TL", "translation", "ZZ_NOTES_B")];
const FACTS = { rows: ROWS, disallowed: DISALLOWED, areaPrivileges: AREA, referenceFamilies: FAMILIES, meta: META };

// the dictionary the resolver reads modules + nullability from
const TABLES: [string, string][] = [
  ["AP_INVOICES_ALL", "AP"], ["AP_LEDGER_ONLY", "AP"], ["AP_CHECKS_ALL", "AP"], ["GL_JE_HEADERS", "GL"], ["PO_HEADERS_ALL", "PO"], ["HR_ALL_POSITIONS_F", "HR"],
  ["PER_ALL_PEOPLE_F", "PER"], ["PER_ALL_ASSIGNMENTS_M", "PER"], ["INV_MATERIAL_TXNS", "INV"], ["WSH_NEW_DELIVERIES", "WSH"], ["CST_ITEM_COSTS", "CST"],
  ["WIE_WORK_ORDERS_B", "WIE"], ["FA_BOOKS", "FA"], ["ZZ_TWO_BU", "ZZ"], ["ZZ_ONE_BU", "ZZ"], ["ZZ_NULLABLE", "ZZ"], ["ZZ_CONFLICT", "ZZ2"], ["ZZ_UNGRANTED", "ZZ3"],
  ["FFS_SCHEDULE", "FFS"], ["FND_LOOKUP_VALUES_TL", "FND"], ["ZZ_REG_NOGRANT", "ZZ"], ["ZZ_STRIPED", "ZZ"], ["ZZ_NOPK", "ZZ"], ["ZZ_DIRECT_DIM", "ZZ"],
  ["CE_STATEMENT_LINES", "CE"], ["ZZP_THINGS", "ZZP"], ["ZZQ_THINGS", "ZZQ"], ["ZZ_TWO_CTX", "ZZ"],
  ["PER_NATIONAL_IDENTIFIERS", "PER"], ["POZ_SUPPLIERS_PII", "POZ"], ["IBY_EXT_BANK_ACCOUNTS", "IBY"], ["CMP_SALARY", "CMP"],
  // revised phase 3: the consensus / strictest table, the structural none rule's cases, the no-area policy's
  ["ZZJ_ITEMS", "ZZJ"], ["AP_LOOKUP_CODES", "AP"], ["ZZ_SUPPLIERS", "ZZ"], ["ZZ_THINGS_TL", "ZZ"], ["ZZ_THINGS_B", "ZZ"], ["ZZ_NOTES_TL", "ZZ"], ["ZZ_NOTES_B", "ZZ"],
  ["FND_TERRITORIES_VL", "FND"],
];
/** a no-area VIEW over AP_INVOICES_ALL (the readInstead case) */
const VIEWS: [string, string, string][] = [["AP_INVOICES_V", "AP", "select i.invoice_id from AP_INVOICES_ALL i"]];
await db.schema.bulkLoad("tables", [...TABLES.map(([name, module]) => ({ name, schema: "FUSION", type: "TABLE", module, remarks: null, view_text: null })),
  ...VIEWS.map(([name, module, view_text]) => ({ name, schema: "FUSION", type: "VIEW", module, remarks: null, view_text }))]);
const col = (t: string, c: string, nullable = 0, ordinal = 1) => [t, c, "NUMBER", 18, nullable, null, ordinal];
await db.schema.bulkLoad("columns", [
  col("AP_INVOICES_ALL", "INVOICE_ID"), col("AP_INVOICES_ALL", "ORG_ID", 0, 2), col("AP_INVOICES_ALL", "SET_OF_BOOKS_ID", 0, 3), col("AP_INVOICES_ALL", "EXPENDITURE_ORGANIZATION_ID", 1, 4),
  col("AP_INVOICES_ALL", "VENDOR_ID", 0, 5), col("AP_INVOICES_ALL", "INVOICE_NUM", 0, 6), col("ZZ_TWO_CTX", "ID"), col("ZZ_TWO_CTX", "ORG_ID", 0, 2), col("ZZ_TWO_CTX", "LEDGER_ID", 0, 3),
  col("AP_LEDGER_ONLY", "SET_OF_BOOKS_ID"), col("AP_LEDGER_ONLY", "PJC_ORGANIZATION_ID", 1, 2),
  col("AP_CHECKS_ALL", "CHECK_ID"), col("AP_CHECKS_ALL", "ORG_ID", 0, 2),
  col("GL_JE_HEADERS", "JE_HEADER_ID"), col("GL_JE_HEADERS", "LEDGER_ID", 0, 2),
  col("PO_HEADERS_ALL", "PO_HEADER_ID"), col("PO_HEADERS_ALL", "PRC_BU_ID", 0, 2), col("PO_HEADERS_ALL", "REQ_BU_ID", 1, 3),
  col("HR_ALL_POSITIONS_F", "POSITION_ID"), col("HR_ALL_POSITIONS_F", "EFFECTIVE_START_DATE", 0, 2), col("HR_ALL_POSITIONS_F", "EFFECTIVE_END_DATE", 0, 3),
  col("PER_ALL_PEOPLE_F", "PERSON_ID"), col("PER_ALL_PEOPLE_F", "EFFECTIVE_START_DATE", 0, 2), col("PER_ALL_PEOPLE_F", "EFFECTIVE_END_DATE", 0, 3),
  col("PER_ALL_ASSIGNMENTS_M", "ASSIGNMENT_ID"), col("PER_ALL_ASSIGNMENTS_M", "EFFECTIVE_START_DATE", 0, 2), col("PER_ALL_ASSIGNMENTS_M", "EFFECTIVE_END_DATE", 0, 3),
  col("INV_MATERIAL_TXNS", "TRANSACTION_ID"), col("INV_MATERIAL_TXNS", "ORGANIZATION_ID", 0, 2),
  col("WSH_NEW_DELIVERIES", "DELIVERY_ID"), col("WSH_NEW_DELIVERIES", "ORGANIZATION_ID", 0, 2),
  col("CST_ITEM_COSTS", "ITEM_COST_ID"), col("CST_ITEM_COSTS", "COST_ORG_ID", 0, 2),
  col("WIE_WORK_ORDERS_B", "WORK_ORDER_ID"), col("WIE_WORK_ORDERS_B", "ORGANIZATION_ID", 0, 2),
  col("FA_BOOKS", "BOOK_TYPE_CODE"),
  col("ZZ_TWO_BU", "PRC_BU_ID"), col("ZZ_TWO_BU", "REQ_BU_ID", 1, 2), col("ZZ_ONE_BU", "ORG_ID"), col("ZZ_NULLABLE", "ORG_ID", 1),
  col("ZZ_CONFLICT", "ORG_ID"), col("ZZ_UNGRANTED", "ORG_ID"), col("FFS_SCHEDULE", "ORGANIZATION_ID"), col("FND_LOOKUP_VALUES_TL", "LOOKUP_CODE"),
  col("ZZ_REG_NOGRANT", "ID"), col("ZZ_STRIPED", "ID"), col("ZZ_NOPK", "X"), col("ZZ_DIRECT_DIM", "ID"),
  col("CE_STATEMENT_LINES", "STATEMENT_LINE_ID"), col("CE_STATEMENT_LINES", "ORG_ID", 0, 2), col("ZZP_THINGS", "ID"), col("ZZQ_THINGS", "ID"),
  col("PER_NATIONAL_IDENTIFIERS", "NATIONAL_IDENTIFIER_ID"), col("PER_NATIONAL_IDENTIFIERS", "PERSON_ID", 0, 2), col("POZ_SUPPLIERS_PII", "VENDOR_ID"),
  col("IBY_EXT_BANK_ACCOUNTS", "EXT_BANK_ACCOUNT_ID"), col("IBY_EXT_BANK_ACCOUNTS", "BANK_ACCOUNT_NUM", 1, 2), col("IBY_EXT_BANK_ACCOUNTS", "MASKED_BANK_ACCOUNT_NUM", 1, 3),
  col("IBY_EXT_BANK_ACCOUNTS", "IBAN", 1, 4), col("IBY_EXT_BANK_ACCOUNTS", "MASKED_IBAN", 1, 5), col("CMP_SALARY", "SALARY_ID"),
  col("ZZJ_ITEMS", "ID"), col("ZZJ_ITEMS", "ITEM_NAME", 1, 2),
  col("AP_LOOKUP_CODES", "LOOKUP_TYPE"), col("AP_LOOKUP_CODES", "LOOKUP_CODE", 0, 2), col("AP_LOOKUP_CODES", "DISPLAYED_FIELD", 1, 3),
  col("ZZ_SUPPLIERS", "VENDOR_ID"), col("ZZ_SUPPLIERS", "VENDOR_NAME", 1, 2),
  col("ZZ_THINGS_TL", "THING_ID"), col("ZZ_THINGS_TL", "LANGUAGE", 0, 2), col("ZZ_THINGS_TL", "SOURCE_LANG", 0, 3), col("ZZ_THINGS_TL", "NAME", 1, 4), col("ZZ_THINGS_B", "THING_ID"),
  col("ZZ_NOTES_TL", "NOTE_ID"), col("ZZ_NOTES_TL", "LANGUAGE", 0, 2), col("ZZ_NOTES_TL", "SOURCE_LANG", 0, 3), col("ZZ_NOTES_TL", "CREATED_BY", 1, 4), col("ZZ_NOTES_B", "NOTE_ID"),
  col("FND_TERRITORIES_VL", "TERRITORY_CODE"), col("FND_TERRITORIES_VL", "TERRITORY_SHORT_NAME", 1, 2),
  col("AP_INVOICES_V", "INVOICE_ID"),
]);
await db.schema.bulkLoad("pkeys", [["AP_INVOICES_ALL", "INVOICE_ID", 1], ["ZZ_THINGS_TL", "THING_ID", 1], ["ZZ_THINGS_TL", "LANGUAGE", 2],
  ["ZZ_NOTES_TL", "NOTE_ID", 1], ["ZZ_NOTES_TL", "LANGUAGE", 2]]);
await db.schema.bulkLoad("fkeys", [["AP_INVOICES_ALL", "POZ_SUPPLIERS_PII", "VENDOR_ID", 1, "AP_INVOICES_FK_VENDOR"],
  // a CHILD of secured data (a registered object with grants): blocked for an end user, whatever its own security
  ["ZZ_SUPPLIERS", "POZ_SUPPLIERS_PII", "VENDOR_ID", 1, "ZZ_SUPPLIERS_FK_PII"]]);
await db.schema.bulkLoad("relationships_mined", [
  // a lookup related to secured data stays readable (reference family)
  ["AP_LOOKUP_CODES", "LOOKUP_CODE", "AP_INVOICES_ALL", "INVOICE_NUM", "test", 3, "high"],
  // a translation whose KEY reaches secured data translates secured data: blocked
  ["ZZ_THINGS_TL", "THING_ID", "ZZ_DIRECT_DIM", "ID", "test", 2, "high"],
  // a translation related to secured data through a NON-key column only stays readable
  ["ZZ_NOTES_TL", "CREATED_BY", "AP_INVOICES_ALL", "INVOICE_ID", "test", 2, "high"],
]);
await db.schema.reloadTableNames();

// the OTBI lineage: the presentation columns' db_refs ARE the exposure index (otbi_column_ref, derived by
// replaceAll exactly as p5_otbi.sql derives it), the VO hop, the area -> duty codes of Oracle's TBI guides
const sa = (name: string, pillar = "fin"): OtbiSubjectAreaRow => ({ name, pillar, n_folders: 1, n_fact_folders: 1, n_columns: 0, fact_folders: null, in_lineage: 1, in_crawl: 0, in_corpus: 0, text_hash: null });
const folder = (subject_area: string, name: string, kind: string): OtbiFolderRow => ({
  subject_area, name, kind, kind_source: "test", description: null, desc_source: null, db_tables: null, n_columns: 0, n_measures: 0,
  in_lineage: 1, in_crawl: 0, in_corpus: 0, unit_id: null, grain_note: null, nested: 0, ordinal: 1, text_hash: null,
});
const ocol = (subject_area: string, fold: string, name: string, refs: [string, string][], expression: string | null = null): OtbiColumnRow => ({
  subject_area, folder: fold, name, data_type: "VARCHAR", kind: "attribute", aggregation: null, expression,
  db_refs: JSON.stringify(refs.map(([t, c]) => ({ t, c, src: ["lineage"] }))), vo_refs: null, indexed: 0, description: null, desc_source: null,
  gap_cause: null, in_lineage: 1, in_crawl: 0, in_probe: 0, ordinal: 1, text_hash: null,
});
const vo = (subject_area: string, fold: string, vo_def: string, objects: string[]): OtbiVoRow =>
  ({ subject_area, folder: fold, vo_path: `${vo_def}AM.${vo_def}`, vo_def, db_objects: JSON.stringify(objects), vo_attrs: "[]" });
const duty = (subject_area: string, duty_code: string): OtbiAreaDutyRow =>
  ({ subject_area, duty_code, duty_name: duty_code, guide: "TEST", guide_release: "test", matched_by: "name", guide_area: subject_area });
const PAY_INV = "Payables Invoices - Transactions Real Time";
const PAY_PMT = "Payables Payments - Disbursements Real Time";
const SCFO = "Supply Chain Financial Orchestration Real Time";
const GLJ = "General Ledger - Journals Real Time";
const WFP = "Workforce Management - Person Real Time";
const WFA = "Workforce Management - Worker Assignment Real Time";
const ABS = "Absence Management - Absence Real Time";
const CASH = "Cash Management - Bank Statements Real Time";
const ZLED = "Zed - Ledgers Real Time";
const ZMIX = "Zed - Mixed Real Time";
const ZTH = "Zed - Things Real Time";
const ZJOB = "Zed - Jobs Real Time";
const ZSPLIT = "Zed - Split Real Time";
const ZFOR = "Zed - Foreign Real Time";
const ZTWO = "Zed - Two BU Real Time";
const ZKNOWN = "Zed - Known Real Time";
const OTBI_AREAS = [sa(PAY_INV), sa(PAY_PMT), sa(SCFO, "scm-and-prc"), sa(GLJ), sa(WFP, "hcm"), sa(WFA, "hcm"), sa(ABS, "hcm"), sa(CASH), sa(ZLED), sa(ZMIX), sa(ZTH),
  sa(ZJOB), sa(ZSPLIT), sa(ZFOR), sa(ZTWO), sa(ZKNOWN)];
const OTBI_FOLDERS = [
  folder(PAY_INV, "Invoice", "fact"), folder(PAY_INV, "Lookup", "dimension"), folder(PAY_PMT, "Payment", "fact"), folder(SCFO, "Payment Details", "dimension"),
  folder(GLJ, "Journal Header", "fact"), folder(WFP, "Person", "fact"), folder(WFA, "Assignment", "fact"), folder(ABS, "Absence", "fact"),
  folder(CASH, "Statement Line", "fact"), folder(ZLED, "Two", "fact"), folder(ZMIX, "Two", "fact"), folder(ZTH, "Thing", "dimension"),
  folder(ZJOB, "Item", "fact"), folder(ZSPLIT, "Item", "fact"), folder(ZFOR, "Journal", "fact"), folder(ZFOR, "Item", "dimension"),
  folder(ZTWO, "Two", "fact"), folder(ZKNOWN, "One", "fact"),
];
const OTBI_COLUMNS = [
  ocol(PAY_INV, "Invoice", "Invoice Id", [["AP_INVOICES_ALL", "INVOICE_ID"]]),
  ocol(PAY_INV, "Invoice", "Business Unit Id", [["AP_INVOICES_ALL", "ORG_ID"]]),
  // a lookup / null default over the input = the input exposed; a masking shape = the input hidden
  ocol(PAY_INV, "Invoice", "Expenditure Organization", [["AP_INVOICES_ALL", "EXPENDITURE_ORGANIZATION_ID"]], "nvl(HR_ORGANIZATION_UNITS_F_TL.NAME , AP_INVOICES_ALL.EXPENDITURE_ORGANIZATION_ID)"),
  ocol(PAY_INV, "Invoice", "Ledger Tail", [["AP_INVOICES_ALL", "SET_OF_BOOKS_ID"]], "'XXXX' || SUBSTR(cast(AP_INVOICES_ALL.SET_OF_BOOKS_ID as VARCHAR ( 20 )), -4)"),
  ocol(PAY_INV, "Lookup", "Meaning", [["FND_LOOKUP_VALUES_TL", "LOOKUP_CODE"]]),
  ocol(PAY_PMT, "Payment", "Check Id", [["AP_CHECKS_ALL", "CHECK_ID"]]), ocol(PAY_PMT, "Payment", "Business Unit Id", [["AP_CHECKS_ALL", "ORG_ID"]]),
  // the payment table as a dimension of SCFO, the invoice table too
  ocol(SCFO, "Payment Details", "Check Id", [["AP_CHECKS_ALL", "CHECK_ID"]]), ocol(SCFO, "Payment Details", "Invoice Id", [["AP_INVOICES_ALL", "INVOICE_ID"]]),
  ocol(GLJ, "Journal Header", "Journal Id", [["GL_JE_HEADERS", "JE_HEADER_ID"]]), ocol(GLJ, "Journal Header", "Ledger Name", [["GL_LEDGERS", "NAME"]]),
  ocol(WFP, "Person", "Person Id", [["PER_ALL_PEOPLE_F", "PERSON_ID"]]), ocol(WFP, "Person", "Person Name", [["PER_PERSON_NAMES_F", "FULL_NAME"]]),
  ocol(WFA, "Assignment", "Assignment Id", [["PER_ALL_ASSIGNMENTS_M", "ASSIGNMENT_ID"]]),
  ocol(ABS, "Absence", "Assignment Id", [["PER_ALL_ASSIGNMENTS_M", "ASSIGNMENT_ID"]]),
  ocol(CASH, "Statement Line", "Line Id", [["CE_STATEMENT_LINES", "STATEMENT_LINE_ID"]]), ocol(CASH, "Statement Line", "Business Unit Id", [["CE_STATEMENT_LINES", "ORG_ID"]]),
  // ZZ_TWO_CTX next to a GL fact table (the area's product prefixes = GL + ZZ)
  ocol(ZLED, "Two", "Id", [["ZZ_TWO_CTX", "ID"]]), ocol(ZLED, "Two", "Journal Id", [["GL_JE_HEADERS", "JE_HEADER_ID"]]),
  ocol(ZMIX, "Two", "Id", [["ZZ_TWO_CTX", "ID"]]),
  ocol(ZTH, "Thing", "Id", [["ZZ_DIRECT_DIM", "ID"]]),
  // the structural none rule's cases, read by the invoice area
  ocol(PAY_INV, "Lookup", "Code Meaning", [["AP_LOOKUP_CODES", "DISPLAYED_FIELD"]]), ocol(PAY_INV, "Lookup", "Supplier", [["ZZ_SUPPLIERS", "VENDOR_NAME"]]),
  ocol(PAY_INV, "Lookup", "Thing", [["ZZ_THINGS_TL", "NAME"]]), ocol(PAY_INV, "Lookup", "Note", [["ZZ_NOTES_TL", "NOTE_ID"]]),
  // the consensus / strictest table: a fact of two areas, a dimension of a GL area
  ocol(ZJOB, "Item", "Item", [["ZZJ_ITEMS", "ITEM_NAME"]]), ocol(ZSPLIT, "Item", "Item", [["ZZJ_ITEMS", "ITEM_NAME"]]),
  ocol(ZFOR, "Journal", "Journal Id", [["GL_JE_HEADERS", "JE_HEADER_ID"]]), ocol(ZFOR, "Item", "Item", [["ZZJ_ITEMS", "ITEM_NAME"]]),
  ocol(ZTWO, "Two", "Req BU", [["ZZ_TWO_BU", "REQ_BU_ID"]]), ocol(ZKNOWN, "One", "BU", [["ZZ_ONE_BU", "ORG_ID"]]),
];
const job = (subject_area: string, job_code: string): OtbiAreaJobRow => ({ subject_area, job_code, job_name: null, matched_by: "duty", guide: "TEST" });
const OTBI_LINEAGE = {
  vos: [
    vo(ZLED, "Two", "ZzLedgerTwoVO", ["ZZ_TWO_CTX", "GL_LEDGERS"]),
    vo(ZMIX, "Two", "ZzMixedTwoVO", ["ZZ_TWO_CTX", "GL_LEDGERS", "FUN_ALL_BUSINESS_UNITS_V"]),
    vo(PAY_INV, "Invoice", "InvoiceHeaderVO", ["AP_INVOICES_ALL"]),
  ],
  areaDuties: [
    duty(PAY_INV, "FBI_INTER_COMPANY_TRANSACTION_ANALYSIS_DUTY"), duty(PAY_INV, "FBI_PAYABLES_INVOICE_TRANSACTION_ANALYSIS_DUTY"),
    duty(PAY_PMT, "FBI_PAYABLES_PAYMENT_TRANSACTION_ANALYSIS_DUTY"), duty(SCFO, "FBI_SUPPLY_CHAIN_FINANCIAL_ORCHESTRATION_TRANSACTION_ANALYSIS_DUTY"),
    duty(GLJ, "FBI_GENERAL_LEDGER_TRANSACTION_ANALYSIS_DUTY"), duty(CASH, "FBI_CASH_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY"),
    // HCM: the guide code maps to the pod's ORA_<code>_HCM role (the person duty) — or to nothing (the absence code here)
    duty(WFP, "FBI_PERSON_TRANSACTION_ANALYSIS_DUTY"), duty(WFA, "FBI_PERSON_TRANSACTION_ANALYSIS_DUTY"), duty(ABS, "FBI_NOPE_TRANSACTION_ANALYSIS_DUTY"),
  ],
  // the job roles the guides name per area: three for ZJOB (2 of 3 hold A = a majority), two that split for ZSPLIT
  areaJobs: [job(ZJOB, "ORA_ZZJ_ANALYST_JOB"), job(ZJOB, "ORA_ZZJ_CLERK_JOB"), job(ZJOB, "ORA_ZZJ_MANAGER_JOB"), job(ZSPLIT, "ORA_ZZJ_X_JOB"), job(ZSPLIT, "ORA_ZZJ_Y_JOB")],
  guideRelease: "test",
  unmappedAreas: Object.fromEntries([ZLED, ZMIX, ZTH, ZJOB, ZSPLIT, ZFOR, ZTWO, ZKNOWN].map((a) => [a, "no duty in the TBI guides test (test)"])),
};
await db.otbi.replaceAll(OTBI_AREAS, OTBI_FOLDERS, OTBI_COLUMNS, [], "test", OTBI_LINEAGE);

// ---- the instance layers (what src/securityLayer.ts loads from the pod exports) ----
const o = (obj_name: string, pk: (string | null)[] = [], database_object_name = obj_name) => ({
  obj_name, database_object_name, pk1_column: pk[0] ?? null, pk2_column: pk[1] ?? null, pk3_column: pk[2] ?? null, pk4_column: pk[3] ?? null, pk5_column: pk[4] ?? null,
});
const EDATE = ["EFFECTIVE_START_DATE", "EFFECTIVE_END_DATE"];
const u = (obj_name: string, privilege: string, grant_sig: string, instance_type = "GLOBAL", n_grants = 10) => ({ obj_name, privilege, instance_type, grant_sig, n_grants });
const d = (duty_role: string, obj_name: string, privilege: string, grant_sig: string, n_grants = 20) => ({ duty_role, obj_name, privilege, grant_sig, n_grants });
const g = (obj_name: string, privilege: string, grant_sig: string, n_grants = 5) => ({ obj_name, privilege, grant_sig, n_grants });
const U_A = [
  u(BU, "AP_REPORT_PAYABLES_DATA", "s-ap"), u(BU, "AR_VIEW_RECEIVABLES_ACTIVITIES_DATA", "s-ar"), u(BU, "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "s-doo"),
  u("GL_LEDGERS", "GL_REPORT_GENERAL_LEDGER_DATA", "s-gl"), u("GL_LEDGERS", "read", "s-glr"), u("GL_LEDGERS", "update", "s-glr"), u("GL_LEDGERS", "delete", "s-glr"),
  u("PO_HEADERS_ALL", "PO_VIEW_PO_DOC_ANALYSIS_DATA", "s-po"), u("PO_HEADERS_ALL", "read", "s-por"),
  u("INV_ORG_PARAMETERS", "INV_MANAGE_INVENTORY_TRANSACTION_DATA", "s-i1", "SET"), u("INV_ORG_PARAMETERS", "INV_MANAGE_ONHAND_QUANTITY_DATA", "s-i2", "SET"),
  u("INV_ORG_PARAMETERS", "INV_MANAGE_ABC_CLASS_DATA", "s-i3", "SET"), u("INV_ORG_PARAMETERS", "INV_MANAGE_ITEM_SUBINVENTORY_DATA", "s-i3", "SET"),
  u("INV_ORG_PARAMETERS", "WSH_MANAGE_DELIVERY_DATA", "s-w1", "SET"), u("INV_ORG_PARAMETERS", "RCS_MAINTENANCE_ORG_DATA", "s-r1", "SET"), u("INV_ORG_PARAMETERS", "RCS_QUALITY_ORG_DATA", "s-r2", "SET"),
  // three names, ONE grant set: equivalent
  u("CST_COST_ORGS_V", "CST_VIEW_COSTED_ONHAND_DATA", "s-c1"), u("CST_COST_ORGS_V", "CST_VIEW_COST_PERIOD_DATA", "s-c1"), u("CST_COST_ORGS_V", "CST_VIEW_VALUATION_UNIT_DATA", "s-c1"),
  u("RCS_MFG_PARAMETERS", "RCS_PLANT_PARAMETERS_DATA", "s-rp"),
  u("ZZ_STRIPED_A", "ZZ_VIEW_A_DATA", "s-za"), u("ZZ_STRIPED_B", "ZZ_VIEW_B_DATA", "s-zb"), u("ZZ_NOPK", "ZZ_VIEW_NOPK_DATA", "s-zn"),
  // two ZZ privileges with distinct grant sets: the rule alone is ambiguous
  u("ZZ_DIRECT_DIM", "ZZ_VIEW_X_DATA", "s-zx"), u("ZZ_DIRECT_DIM", "ZZ_VIEW_Y_DATA", "s-zy"),
  // national identifiers: the dedicated report privilege AND the person privilege reach the BI identity
  u("PER_NATIONAL_IDENTIFIERS", "PER_REPORT_PERSON_NATIONAL_IDENTIFIER_DATA", "s-nid"), u("PER_NATIONAL_IDENTIFIERS", "PER_REPORT_PERSON_DATA", "s-nidp"),
  // two ZZJ privileges with distinct grant sets: the rule is ambiguous — the consensus or the strictest decides
  u("ZZJ_ITEMS", "ZZJ_VIEW_A_DATA", "s-ja"), u("ZZJ_ITEMS", "ZZJ_VIEW_B_DATA", "s-jb"),
];
const DUTY_A = [
  d("ORA_FBI_POSITION_TRANSACTION_ANALYSIS_DUTY_HCM", "HR_ALL_POSITIONS_F", "PER_REPORT_POSITION_DATA", "s-pos", 51),
  d("ORA_FBI_WORKFORCE_TRANSACTION_ANALYSIS_DUTY_HCM", "HR_ALL_POSITIONS_F", "PER_REPORT_POSITION_DATA", "s-pos", 51),
  d("ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_ALL_PEOPLE_F", "PER_REPORT_PERSON_DATA", "s-per", 30),
  d("ORA_FBI_ABSENCE_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_ALL_PEOPLE_F", "PER_REPORT_PERSON_DATA", "s-per", 30),
  d("ORA_FBI_ABSENCE_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_ALL_PEOPLE_F", "ANC_REPORT_ABSENCE_RECORD_DATA", "s-anc", 9),
  d("ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_ALL_ASSIGNMENTS_M", "PER_REPORT_PERSON_DATA", "s-per2", 30),
  d("ORA_FBI_ABSENCE_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_ALL_ASSIGNMENTS_M", "ANC_REPORT_ABSENCE_RECORD_DATA", "s-anc2", 9),
  // the duty route alone would read national identifiers through the PERSON privilege (one privilege, one class)
  d("ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM", "PER_NATIONAL_IDENTIFIERS", "PER_REPORT_PERSON_DATA", "s-nidp", 33),
  d("XXKD_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", "PER_ALL_PEOPLE_F", "PER_REPORT_PERSON_DATA", "s-per", 30),
];
/** every granted pair of pod-a (any grantee) with its grant-set signature: U ∪ duties ∪ the grants of no BI / duty role */
const sigOf = new Map<string, string>([...U_A, ...DUTY_A].map((x) => [`${x.obj_name}/${x.privilege}`, x.grant_sig]));
const GRANTED_ONLY_A = [
  g(BU, "ZZ_CURATED_DATA", "s-zc"),
  // pool 2 on the BU view: the only CE privilege of the object (no CE privilege reaches the BI identity)
  g(BU, "CE_MANAGE_BANK_STATEMENT_DATA", "s-ce"), g(BU, "PJC_VIEW_PROJECT_DATA", "s-pjc"),
  // pool 2 on a registered table: two ZZP names, ONE grant set (unique class); two ZZQ names, two sets (ambiguous)
  g("ZZP_THINGS", "ZZP_EDIT_THING_DATA", "s-zp"), g("ZZP_THINGS", "ZZP_VIEW_THING_DATA", "s-zp"), g("ZZP_THINGS", "read", "s-zpr"),
  g("ZZQ_THINGS", "ZZQ_A_DATA", "s-zq1"), g("ZZQ_THINGS", "ZZQ_B_DATA", "s-zq2"),
  // HCM: a PER privilege granted on the assignments object to a role that is no analysis duty — the HCM route never reads pool 2
  g("PER_ALL_ASSIGNMENTS_M", "PER_VIEW_ASSIGNMENT_ONLY_DATA", "s-pva"),
  // sensitive objects: both supplier PII privileges, the bank-account PII privilege — none reaches the BI identity
  g("POZ_SUPPLIERS_PII", "POZ_MAINTAIN_SUPPLIER_TAX_IDENTIFIERS_PII_DATA", "s-pz1"), g("POZ_SUPPLIERS_PII", "POZ_MAINTAIN_SUPPLIER_CORPORATE_TAX_IDENTIFIERS_DATA", "s-pz2"),
  g("POZ_SUPPLIERS_PII", "read", "s-pzr"),
  g("IBY_EXT_BANK_ACCOUNTS", "IBY_VIEW_PII_ATTRIBUTES_IN_PAYMENTS_DATA", "s-iby"),
  // CMP_SALARY is registered with a grant — but not of its sensitive report privilege
  g("CMP_SALARY", "CMP_VIEW_SALARY_DETAILS_DATA", "s-cmp"),
];
const pairsOf = (xs: { obj_name: string; privilege: string }[]) =>
  [...new Map(xs.map((x) => [`${x.obj_name}/${x.privilege}`, g(x.obj_name, x.privilege, sigOf.get(`${x.obj_name}/${x.privilege}`)!)])).values()];
const LAYER_A: SecLayerInput = {
  grantee: "FUSION_APPS_OBIA_BIEE_APPID",
  objects: [o(BU, ["BU_ID"]), o("GL_LEDGERS", ["LEDGER_ID"]), o("PO_HEADERS_ALL", ["PO_HEADER_ID"]), o("HR_ALL_POSITIONS_F", ["POSITION_ID", ...EDATE]),
    o("PER_ALL_PEOPLE_F", ["PERSON_ID", ...EDATE]), o("PER_ALL_ASSIGNMENTS_M", ["ASSIGNMENT_ID", ...EDATE]), o("INV_ORG_PARAMETERS", ["ORGANIZATION_ID"]),
    o("CST_COST_ORGS_V", ["COST_ORG_ID"]), o("RCS_MFG_PARAMETERS", ["ORGANIZATION_ID"]), o("ZZ_REG_NOGRANT", ["ID"]),
    o("ZZ_STRIPED_A", ["ID"], "ZZ_STRIPED"), o("ZZ_STRIPED_B", ["ID"], "ZZ_STRIPED"), o("ZZ_NOPK"), o("ZZ_DIRECT_DIM", ["ID"]),
    o("ZZP_THINGS", ["ID"]), o("ZZQ_THINGS", ["ID"]), o("PER_NATIONAL_IDENTIFIERS", ["NATIONAL_IDENTIFIER_ID"]), o("POZ_SUPPLIERS_PII", ["VENDOR_ID"]),
    o("IBY_EXT_BANK_ACCOUNTS", ["EXT_BANK_ACCOUNT_ID"]), o("CMP_SALARY", ["SALARY_ID"]), o("ZZJ_ITEMS", ["ID"])],
  privileges: [...pairsOf([...U_A, ...DUTY_A]), ...GRANTED_ONLY_A],
  u: U_A,
  duties: DUTY_A,
  aliases: [{ duty_role: "XXKD_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", seeded_role: "ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM" }],
  // v4: the seeded job roles' grants (names only)
  roleGrants: [
    { role_name: "ORA_ZZJ_ANALYST_JOB", obj_name: "ZZJ_ITEMS", privilege: "ZZJ_VIEW_A_DATA" }, { role_name: "ORA_ZZJ_CLERK_JOB", obj_name: "ZZJ_ITEMS", privilege: "ZZJ_VIEW_A_DATA" },
    { role_name: "ORA_ZZJ_MANAGER_JOB", obj_name: "ZZJ_ITEMS", privilege: "ZZJ_VIEW_B_DATA" },
    { role_name: "ORA_ZZJ_X_JOB", obj_name: "ZZJ_ITEMS", privilege: "ZZJ_VIEW_A_DATA" }, { role_name: "ORA_ZZJ_Y_JOB", obj_name: "ZZJ_ITEMS", privilege: "ZZJ_VIEW_B_DATA" },
  ],
};
const LAYER_B: SecLayerInput = {
  grantee: "FUSION_APPS_OBIA_BIEE_APPID", objects: [o(BU, ["BU_ID"])], privileges: [g(BU, "AP_REPORT_PAYABLES_DATA", "s-ap")],
  u: [u(BU, "AP_REPORT_PAYABLES_DATA", "s-ap")], duties: [], aliases: [], roleGrants: [],
};

/** no numeric pod id and no FND_GRANTS / URDA text may appear in anything served */
const assertNamesOnly = (x: unknown) => {
  const s = JSON.stringify(x);
  assert.doesNotMatch(s, /\b3000\d{8,}\b/, "a pod id leaked");
  assert.doesNotMatch(s, /FND_GRANTS|FUN_USER_ROLE_DATA_ASGNMNTS|FND_SESSION_ROLE_SETS/i, "condition text leaked");
};
const plan = (tables: { table: string; alias: string }[], instance: string = INST_A) => getDataAccessPredicate({ instance, tables }) as Promise<any>;
const ds = (table: string, instance: string = INST_A) => dataSecurityFor(table, instance) as Promise<any>;
const cteOf = (p: any, alias: string) => p.ctes.find((c: any) => c.alias === alias);

test("no facts built: no dataSecurity pushed, the plan fails loudly (absent is never `none`); no layer: the instance is unknown", async () => {
  assert.equal("dataSecurity" in (await catalog.mostlyUsedStats("AP_CHECKS_ALL")), false);
  const r: any = await plan([{ table: "AP_CHECKS_ALL", alias: "ap" }]);
  assert.match(r.error, /no data-access security layer is loaded for pod-a\.example\.oraclecloud\.com \(loaded: none\)/);
});

test("library: replaceAll (release facts), replaceLayer v3 (two pods: grant signatures, aliases), the layer reads, idempotent re-import with a new stamp", async () => {
  assert.deepEqual(await db.security.replaceAll(FACTS), { rows: ROWS.length, disallowed: 1, areaRows: AREA.length, referenceTables: FAMILIES.length, meta: Object.keys(META).length });
  assert.deepEqual(await db.security.referenceFamily("ZZ_THINGS_TL"), { table_name: "ZZ_THINGS_TL", family: "translation", base_table: "ZZ_THINGS_B", evidence: "test: translation" });
  assert.equal(await db.security.referenceFamily("AP_INVOICES_ALL"), null);
  assert.equal(await db.security.version(), "2");
  assert.deepEqual((await db.security.areaPrivileges(BU, INST_A)).map((a) => [a.area_or_product, a.privilege, a.instance_scope]),
    [["AP", "AP_REPORT_PAYABLES_DATA", "*"], ["Payables", "AP_REPORT_PAYABLES_DATA", "*"], ["Supply Chain Financial Orchestration Real Time", "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "*"],
     ["ZZ", "ZZ_CURATED_DATA", INST_A], ["ZZ2", "ZZ_CURATED_DATA", "*"], ["ZZ2", "AP_REPORT_PAYABLES_DATA", "*"], ["ZZ3", "AP_MANAGE_PAYABLES_INVOICE_DATA", "*"],
     [ZKNOWN, "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "*"], [ZTWO, "AP_REPORT_PAYABLES_DATA", "*"]]);
  assert.equal((await db.security.areaPrivileges(BU, INST_A)).find((a) => a.area_or_product === ZTWO)?.context_column, "ZZ_TWO_BU.REQ_BU_ID");
  assert.equal((await db.security.areaPrivileges(BU, INST_B)).some((a) => a.area_or_product === "ZZ"), false, "a row scoped to pod-a is invisible on pod-b");

  const counts = await db.security.replaceLayer(INST_A, "2026-10-03", LAYER_A, "2026-10-03T10:00:00Z");
  const want = { objects: LAYER_A.objects.length, privileges: LAYER_A.privileges.length, u: U_A.length, duties: DUTY_A.length, aliases: 1, roleGrants: 5 };
  assert.deepEqual(counts, want);
  // idempotent: the same export loaded again = the same counts, the same rows, one layer row
  assert.deepEqual(await db.security.replaceLayer(INST_A, "2026-10-03", LAYER_A, "2026-10-03T10:00:00Z"), want);
  assert.equal((await db.security.layers()).filter((l) => l.instance === INST_A).length, 1);
  await db.security.replaceLayer(INST_B, "2026-09-01", LAYER_B, "2026-09-01T10:00:00Z");
  assert.deepEqual((await db.security.layers()).map((l) => [l.instance, l.stamp, l.grantee]), [[INST_A, "2026-10-03", "FUSION_APPS_OBIA_BIEE_APPID"], [INST_B, "2026-09-01", "FUSION_APPS_OBIA_BIEE_APPID"]]);
  assert.deepEqual(JSON.parse((await db.security.layer(INST_A))!.counts), counts);
  assert.deepEqual((await db.security.instanceObjectsForTable(INST_A, "ZZ_STRIPED")).map((x) => x.obj_name), ["ZZ_STRIPED_A", "ZZ_STRIPED_B"]);
  assert.deepEqual((await db.security.instanceObjectsForTable(INST_A, "PO_HEADERS_ALL")).map((x) => [x.obj_name, x.pk1_column]), [["PO_HEADERS_ALL", "PO_HEADER_ID"]]);
  assert.deepEqual((await db.security.uPairs(INST_A, "PO_HEADERS_ALL")).map((x) => [x.privilege, x.instance_type, x.grant_sig]), [["PO_VIEW_PO_DOC_ANALYSIS_DATA", "GLOBAL", "s-po"], ["read", "GLOBAL", "s-por"]]);
  assert.deepEqual((await db.security.grantedPairs(INST_A, "ZZP_THINGS")).map((x) => [x.privilege, x.grant_sig, x.n_grants]),
    [["ZZP_EDIT_THING_DATA", "s-zp", 5], ["ZZP_VIEW_THING_DATA", "s-zp", 5], ["read", "s-zpr", 5]]);
  assert.deepEqual(await db.security.dutyAliases(INST_A), [{ instance: INST_A, duty_role: "XXKD_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", seeded_role: "ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM" }]);
  assert.deepEqual(await db.security.roleGrants(INST_A, "ZZJ_ITEMS", ["ORA_ZZJ_ANALYST_JOB", "ORA_ZZJ_MANAGER_JOB", "ORA_NOPE_JOB"]),
    [{ role_name: "ORA_ZZJ_ANALYST_JOB", privilege: "ZZJ_VIEW_A_DATA" }, { role_name: "ORA_ZZJ_MANAGER_JOB", privilege: "ZZJ_VIEW_B_DATA" }]);
  assert.deepEqual(await db.security.roleGrants(INST_A, "ZZJ_ITEMS", []), []);
  assert.equal((await db.security.dutyPairs(INST_A, "HR_ALL_POSITIONS_F")).length, 2);
  assert.equal(await db.security.instancePrivilegeExists(INST_A, BU, "ZZ_CURATED_DATA"), true);
  assert.equal(await db.security.instancePrivilegeExists(INST_B, BU, "ZZ_CURATED_DATA"), false);
  // re-import = the new stamp, the previous rows gone (aliases included), nothing of the other pod touched
  const small: SecLayerInput = { ...LAYER_B, grantee: "OTHER_IDENTITY" };
  assert.deepEqual(await db.security.replaceLayer(INST_A, "2026-10-04", small, "2026-10-04T00:00:00Z"), { objects: 1, privileges: 1, u: 1, duties: 0, aliases: 0, roleGrants: 0 });
  assert.deepEqual(await db.security.roleGrants(INST_A, "ZZJ_ITEMS", ["ORA_ZZJ_ANALYST_JOB"]), [], "a re-import replaces the role grants too");
  assert.deepEqual([(await db.security.layer(INST_A))!.stamp, (await db.security.layer(INST_A))!.grantee], ["2026-10-04", "OTHER_IDENTITY"]);
  assert.deepEqual(await db.security.uPairs(INST_A, "PO_HEADERS_ALL"), []);
  assert.deepEqual(await db.security.dutyPairs(INST_A, "HR_ALL_POSITIONS_F"), []);
  assert.deepEqual(await db.security.dutyAliases(INST_A), []);
  assert.equal((await db.security.layer(INST_B))!.stamp, "2026-09-01");
  await db.security.replaceLayer(INST_A, "2026-10-03", LAYER_A, "2026-10-03T10:00:00Z");
  assert.equal((await db.security.uPairs(INST_A, "PO_HEADERS_ALL")).length, 2);
});

test("plan: the contract — ctes + rewrite + distinct pairs + blocked + unsecured, NO skeleton / conditions field; the cte text over the inner alias t", async () => {
  const p = await plan([{ table: "AP_CHECKS_ALL", alias: "ap" }, { table: "PO_HEADERS_ALL", alias: "poh" }, { table: "GL_JE_HEADERS", alias: "gl" },
    { table: "HR_ALL_POSITIONS_F", alias: "pos" }, { table: "INV_MATERIAL_TXNS", alias: "mt" }, { table: "FND_LOOKUP_VALUES_TL", alias: "lk" }]);
  assertNamesOnly(p);
  assert.deepEqual(Object.keys(p), ["instance", "layerStamp", "keying", "ctes", "rewrite", "pairs", "blocked", "unsecured"]);
  assert.equal(p.keying, "table");
  assert.equal("skeleton" in p, false);
  assert.equal("conditions" in p, false);
  assert.deepEqual([p.instance, p.layerStamp], [INST_A, "2026-10-03"]);
  assert.deepEqual(p.ctes.map((c: any) => [c.table, c.alias, c.cteName, c.keying, c.grade, c.route, c.column, c.context]), [
    ["AP_CHECKS_ALL", "ap", "ap_sec", "table", "trace", "reference", "ORG_ID", "BU"],
    ["PO_HEADERS_ALL", "poh", "poh_sec", "table", "rule", "direct", null, null],
    ["GL_JE_HEADERS", "gl", "gl_sec", "table", "inferred", "reference", "LEDGER_ID", "LEDGER"],
    ["HR_ALL_POSITIONS_F", "pos", "pos_sec", "table", "duty", "direct", null, null],
  ]);
  assert.deepEqual(Object.keys(cteOf(p, "ap")), ["table", "alias", "cteName", "cte", "pairs", "keying", "grade", "route", "column", "context", "evidence"]);
  assert.equal(cteOf(p, "ap").cte,
    "ap_sec as (select /*+ INLINE */ t.* from AP_CHECKS_ALL t where t.ORG_ID in (select sec$.BU_ID from FUN_ALL_BUSINESS_UNITS_V sec$ where {PRED:FUN_ALL_BUSINESS_UNITS_V|AP_REPORT_PAYABLES_DATA}))");
  assert.equal(cteOf(p, "poh").cte,
    "poh_sec as (select /*+ INLINE */ t.* from PO_HEADERS_ALL t where t.PO_HEADER_ID in (select sec$.PO_HEADER_ID from PO_HEADERS_ALL sec$ where {PRED:PO_HEADERS_ALL|PO_VIEW_PO_DOC_ANALYSIS_DATA}))");
  assert.equal(cteOf(p, "pos").cte,
    "pos_sec as (select /*+ INLINE */ t.* from HR_ALL_POSITIONS_F t where (t.POSITION_ID, t.EFFECTIVE_START_DATE, t.EFFECTIVE_END_DATE) in " +
    "(select sec$.POSITION_ID, sec$.EFFECTIVE_START_DATE, sec$.EFFECTIVE_END_DATE from HR_ALL_POSITIONS_F sec$ where {PRED:HR_ALL_POSITIONS_F|PER_REPORT_POSITION_DATA}))");
  assert.deepEqual(cteOf(p, "gl").pairs, [{ object: "GL_LEDGERS", privilege: "GL_REPORT_GENERAL_LEDGER_DATA", alias: "sec$" }]);
  assert.deepEqual(p.rewrite, [
    { from: "AP_CHECKS_ALL ap", to: "ap_sec ap" }, { from: "PO_HEADERS_ALL poh", to: "poh_sec poh" },
    { from: "GL_JE_HEADERS gl", to: "gl_sec gl" }, { from: "HR_ALL_POSITIONS_F pos", to: "pos_sec pos" }]);
  assert.equal(p.blocked.length, 1);
  assert.deepEqual([p.blocked[0].table, p.blocked[0].alias, p.blocked[0].column], ["INV_MATERIAL_TXNS", "mt", "ORGANIZATION_ID"]);
  assert.match(p.blocked[0].reason, /^4 privileges of module INV on INV_ORG_PARAMETERS granted to FUSION_APPS_OBIA_BIEE_APPID with distinct grant sets on pod-a\.example\.oraclecloud\.com — ambiguous: INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA; a curated row/);
  assert.deepEqual(p.blocked[0].candidates, ["INV_MANAGE_ABC_CLASS_DATA", "INV_MANAGE_INVENTORY_TRANSACTION_DATA", "INV_MANAGE_ITEM_SUBINVENTORY_DATA", "INV_MANAGE_ONHAND_QUANTITY_DATA"]
    .map((privilege) => ({ object: "INV_ORG_PARAMETERS", privilege })));
  assert.deepEqual(p.unsecured, [{ table: "FND_LOOKUP_VALUES_TL", alias: "lk", reason: p.unsecured[0].reason }]);
  assert.match(p.unsecured[0].reason, /reference data, read directly/);
  assert.deepEqual(p.pairs, [
    { object: BU, privilege: "AP_REPORT_PAYABLES_DATA", alias: "sec$" }, { object: "PO_HEADERS_ALL", privilege: "PO_VIEW_PO_DOC_ANALYSIS_DATA", alias: "sec$" },
    { object: "GL_LEDGERS", privilege: "GL_REPORT_GENERAL_LEDGER_DATA", alias: "sec$" }, { object: "HR_ALL_POSITIONS_F", privilege: "PER_REPORT_POSITION_DATA", alias: "sec$" }]);
  // a self-join = two instances, two CTEs, one distinct pair
  const sj = await plan([{ table: "AP_CHECKS_ALL", alias: "c1" }, { table: "AP_CHECKS_ALL", alias: "c2" }]);
  assert.deepEqual([sj.ctes.map((c: any) => c.cteName), sj.pairs.length, sj.rewrite.map((r: any) => r.to)], [["c1_sec", "c2_sec"], 1, ["c1_sec c1", "c2_sec c2"]]);
});

test("primary context: AP_INVOICES_ALL is secured on ORG_ID under the audited AP primary; an unaudited prefix and a non-audited primary are BLOCKED naming the audit", async () => {
  assert.deepEqual(PRIMARY_AUDIT.AP.contexts, ["BU"], "the rules audit AP -> BU (the Kornit trace)");
  assert.equal(PRIMARY_AUDIT.AP.source, "trace");
  assert.match(PRIMARY_AUDIT.AP.evidence, /SHA-256 5747a1ca58d2202d4a4a234804e150a60b4d762ae6adf86c330d4994b8c8a426, 2,569 chars/);
  const p = await plan([{ table: "AP_INVOICES_ALL", alias: "ai" }]);
  assertNamesOnly(p);
  assert.deepEqual(p.blocked, []);
  const ai = cteOf(p, "ai");
  assert.deepEqual([ai.route, ai.column, ai.context, ai.grade, ai.keying], ["reference", "ORG_ID", "BU", "trace", "table"]);
  assert.equal(ai.cte,
    "ai_sec as (select /*+ INLINE */ t.* from AP_INVOICES_ALL t where t.ORG_ID in (select sec$.BU_ID from FUN_ALL_BUSINESS_UNITS_V sec$ where {PRED:FUN_ALL_BUSINESS_UNITS_V|AP_REPORT_PAYABLES_DATA}))");
  assert.match(ai.evidence, /primary context audited for AP \(trace: .*\) — SET_OF_BOOKS_ID \(LEDGER\), EXPENDITURE_ORGANIZATION_ID \(PRJ_ORG\) not applied, as OTBI does$/);
  // the payload: every context stays a fact, the verdict is the one primary condition
  const a = await ds("AP_INVOICES_ALL");
  assert.deepEqual([a.verdict, a.keying, a.columns.map((c: any) => [c.column, c.primary])],
    ["secured", "table", [["ORG_ID", true], ["SET_OF_BOOKS_ID", false], ["EXPENDITURE_ORGANIZATION_ID", false]]]);
  assert.deepEqual(a.conditions, [{ column: "ORG_ID", context: "BU", object: BU, privileges: ["AP_REPORT_PAYABLES_DATA"], pk: "BU_ID", route: "reference", grade: "trace" }]);
  // unaudited prefix ZZ: two BU columns, the primary choice is not audited — blocked, nothing secured
  const z = await plan([{ table: "ZZ_TWO_BU", alias: "z" }]);
  assert.deepEqual([z.ctes, z.pairs, z.blocked.map((b: any) => [b.table, b.column])], [[], [], [["ZZ_TWO_BU", "PRC_BU_ID"]]]);
  assert.match(z.blocked[0].reason, /^ZZ_TWO_BU carries 2 context columns — the primary PRC_BU_ID \(BU\) and REQ_BU_ID \(BU\); the table-keyed plan secures the primary one only, which is allowed only for a name prefix whose primary context is audited — ZZ is not audited \(sec_meta\.primary_audit; p5_security_rules\.json primaryByPrefix\.ZZ\.audit needs an OTBI LOGLEVEL-7 trace\); keyed on a subject area \(subjectArea\) the area may decide$/);
  // AP audited, but this table's primary is LEDGER (no BU column): not covered by the audit
  const lo = await ds("AP_LEDGER_ONLY");
  assert.equal(lo.verdict, "blocked");
  assert.match(lo.blocked[0].reason, /and LEDGER is not the audited primary context of AP \(BU, trace\)$/);
  // one context column needs no audit; a nullable one does not restrict NULL rows
  const n = await plan([{ table: "ZZ_NULLABLE", alias: "zn" }]);
  assert.equal(cteOf(n, "zn").cte,
    "zn_sec as (select /*+ INLINE */ t.* from ZZ_NULLABLE t where (t.ORG_ID is null or t.ORG_ID in (select sec$.BU_ID from FUN_ALL_BUSINESS_UNITS_V sec$ where {PRED:FUN_ALL_BUSINESS_UNITS_V|ZZ_CURATED_DATA})))");
});

test("sensitive objects: national identifiers through their OWN pair (the override beats the duty route); supplier PII = anyOf OR-ed in ONE condition; bank accounts masked; ungranted / unregistered = blocked", async () => {
  // what the duty route alone would pick: PER_REPORT_PERSON_DATA, one privilege, one class
  assert.deepEqual((await db.security.dutyPairs(INST_A, "PER_NATIONAL_IDENTIFIERS")).map((x) => x.privilege), ["PER_REPORT_PERSON_DATA"]);
  const p = await plan([{ table: "PER_NATIONAL_IDENTIFIERS", alias: "nid" }, { table: "POZ_SUPPLIERS_PII", alias: "pii" }, { table: "IBY_EXT_BANK_ACCOUNTS", alias: "ba" }]);
  assertNamesOnly(p);
  assert.deepEqual(p.blocked, []);
  const nid = cteOf(p, "nid");
  assert.deepEqual([nid.grade, nid.route, nid.pairs], ["sensitive", "direct", [{ object: "PER_NATIONAL_IDENTIFIERS", privilege: "PER_REPORT_PERSON_NATIONAL_IDENTIFIER_DATA", alias: "sec$" }]]);
  assert.doesNotMatch(nid.cte, /PER_REPORT_PERSON_DATA/);
  const pii = cteOf(p, "pii");
  assert.equal(pii.grade, "sensitive");
  assert.equal(pii.cte,
    "pii_sec as (select /*+ INLINE */ t.* from POZ_SUPPLIERS_PII t where t.VENDOR_ID in (select sec$.VENDOR_ID from POZ_SUPPLIERS_PII sec$ where " +
    "({PRED:POZ_SUPPLIERS_PII|POZ_MAINTAIN_SUPPLIER_TAX_IDENTIFIERS_PII_DATA}) or ({PRED:POZ_SUPPLIERS_PII|POZ_MAINTAIN_SUPPLIER_CORPORATE_TAX_IDENTIFIERS_DATA})))");
  assert.deepEqual(pii.pairs.map((x: any) => x.privilege), ["POZ_MAINTAIN_SUPPLIER_TAX_IDENTIFIERS_PII_DATA", "POZ_MAINTAIN_SUPPLIER_CORPORATE_TAX_IDENTIFIERS_DATA"]);
  assert.match(pii.evidence, /any of the privileges \(OR-ed in one condition\)/);
  const ba = cteOf(p, "ba");
  assert.deepEqual([ba.grade, ba.pairs.map((x: any) => x.privilege), ba.masked],
    ["sensitive", ["IBY_VIEW_PII_ATTRIBUTES_IN_PAYMENTS_DATA"], [{ column: "BANK_ACCOUNT_NUM", use: "MASKED_BANK_ACCOUNT_NUM" }, { column: "IBAN", use: "MASKED_IBAN" }]]);
  assert.deepEqual(p.pairs.length, 4, "distinct pairs across the three CTEs (the anyOf pair counts twice)");
  // the payload carries the masked facts even without an instance
  assert.deepEqual((await dataSecurityFor("IBY_EXT_BANK_ACCOUNTS") as any).masked, ba.masked);
  // the sensitive privilege is not granted on the pod: blocked, the other salary privilege is never a substitute
  const sal = await ds("CMP_SALARY");
  assert.deepEqual([sal.verdict, sal.conditions], ["blocked", []]);
  assert.match(sal.blocked[0].reason, /^CMP_SALARY is sensitive — read only through CMP_SALARY \/ CMP_REPORT_SALARY_DATA — and CMP_REPORT_SALARY_DATA carries no active grant on pod-a/);
  // pod-b does not register the PII object
  const b = await ds("POZ_SUPPLIERS_PII", INST_B);
  assert.match(b.blocked[0].reason, /POZ_SUPPLIERS_PII is not registered as a security object on pod-b/);
});

test("pool 2: a module with no named privilege in U takes ALL of the pod's grants by prefix — unique class = granted, several = blocked with candidates; HCM never reads pool 2", async () => {
  const p = await plan([{ table: "CE_STATEMENT_LINES", alias: "ce" }, { table: "ZZP_THINGS", alias: "zp" }, { table: "ZZQ_THINGS", alias: "zq" }]);
  assertNamesOnly(p);
  const ce = cteOf(p, "ce");
  assert.deepEqual([ce.grade, ce.route, ce.column, ce.pairs.map((x: any) => x.privilege)], ["granted", "reference", "ORG_ID", ["CE_MANAGE_BANK_STATEMENT_DATA"]]);
  assert.match(ce.evidence, /^pool 2 \(none of the 3 named privilege\(s\) granted to FUSION_APPS_OBIA_BIEE_APPID on FUN_ALL_BUSINESS_UNITS_V \(AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA\) belongs to module CE \(prefix CE\)\).*not OTBI-proven$/);
  const zp = cteOf(p, "zp");
  assert.deepEqual([zp.grade, zp.route, zp.pairs.map((x: any) => x.privilege), zp.equivalentTo], ["granted", "direct", ["ZZP_EDIT_THING_DATA"], ["ZZP_VIEW_THING_DATA"]]);
  assert.equal(zp.cte, "zp_sec as (select /*+ INLINE */ t.* from ZZP_THINGS t where t.ID in (select sec$.ID from ZZP_THINGS sec$ where {PRED:ZZP_THINGS|ZZP_EDIT_THING_DATA}))");
  assert.deepEqual(p.blocked.map((b: any) => b.table), ["ZZQ_THINGS"]);
  assert.match(p.blocked[0].reason, /^ZZQ_THINGS carries no named grant to FUSION_APPS_OBIA_BIEE_APPID on pod-a\.example\.oraclecloud\.com; among all granted pairs on pod-a\.example\.oraclecloud\.com, 2 privileges of module ZZQ on ZZQ_THINGS carry distinct grant sets — ambiguous: ZZQ_A_DATA, ZZQ_B_DATA/);
  assert.deepEqual(p.blocked[0].candidates, [{ object: "ZZQ_THINGS", privilege: "ZZQ_A_DATA" }, { object: "ZZQ_THINGS", privilege: "ZZQ_B_DATA" }]);
  // HCM untouched: the assignments object has a unique PER grant outside the duty map — still decided by the duty map (blocked)
  const asg = await ds("PER_ALL_ASSIGNMENTS_M");
  assert.deepEqual([asg.verdict, asg.hcm, asg.conditions], ["blocked", true, []]);
  assert.match(asg.blocked[0].reason, /^PER_ALL_ASSIGNMENTS_M carries 2 privileges across the analysis duties on pod-a\.example\.oraclecloud\.com \(ANC_REPORT_ABSENCE_RECORD_DATA \[1\], PER_REPORT_PERSON_DATA \[1\]\) — the table-keyed plan cannot choose among them; key the plan on the subject area the query reads/);
  assert.doesNotMatch(JSON.stringify(asg), /PER_VIEW_ASSIGNMENT_ONLY_DATA/);
  // pod-b: only the AP privilege is granted on the BU view — nothing of module ZZ in any pool
  const b = await ds("ZZ_ONE_BU", INST_B);
  assert.match(b.blocked[0].reason, /^none of the 1 named privilege\(s\) granted to FUSION_APPS_OBIA_BIEE_APPID on FUN_ALL_BUSINESS_UNITS_V \(AP_REPORT_PAYABLES_DATA\) belongs to module ZZ \(prefix ZZ\); of all 1 named privilege\(s\) granted on FUN_ALL_BUSINESS_UNITS_V on pod-b\.example\.oraclecloud\.com \(AP_REPORT_PAYABLES_DATA\) none belongs to module ZZ either/);
});

test("privilege choice: identical grant sets = equivalent (grade, first by name, the rest in equivalentTo); the module alias map; the generic names never chosen", async () => {
  const c = await ds("CST_ITEM_COSTS");
  assert.equal(c.verdict, "secured");
  assert.deepEqual(c.conditions.map((x: any) => [x.object, x.privileges, x.equivalentTo, x.grade]),
    [["CST_COST_ORGS_V", ["CST_VIEW_COSTED_ONHAND_DATA"], ["CST_VIEW_COST_PERIOD_DATA", "CST_VIEW_VALUATION_UNIT_DATA"], "equivalent"]]);
  const p = await plan([{ table: "CST_ITEM_COSTS", alias: "c" }, { table: "WIE_WORK_ORDERS_B", alias: "wo" }, { table: "WSH_NEW_DELIVERIES", alias: "dl" }]);
  assert.deepEqual(p.ctes.map((x: any) => [x.alias, x.pairs[0].object, x.pairs[0].privilege, x.equivalentTo ?? null, x.grade]), [
    ["c", "CST_COST_ORGS_V", "CST_VIEW_COSTED_ONHAND_DATA", ["CST_VIEW_COST_PERIOD_DATA", "CST_VIEW_VALUATION_UNIT_DATA"], "equivalent"],
    ["wo", "RCS_MFG_PARAMETERS", "RCS_PLANT_PARAMETERS_DATA", null, "rule"],   // WIE -> RCS through privilegePrefixAliases
    ["dl", "INV_ORG_PARAMETERS", "WSH_MANAGE_DELIVERY_DATA", null, "rule"],     // the WSH privilege of the inventory-org object
  ]);
  assert.deepEqual(p.blocked, []);
  assert.doesNotMatch(JSON.stringify(p), /"privilege":"(read|update|delete)"/);
});

test("a grade on EVERY condition of the plan and the payload, from the one vocabulary", async () => {
  const all = TABLES.map(([table], i) => ({ table, alias: `x${i}` }));
  const p = await plan(all);
  assertNamesOnly(p);
  assert.ok(p.ctes.length >= 12, `secured ${p.ctes.length}`);
  for (const c of p.ctes) {
    assert.ok(GRADES.includes(c.grade), `${c.table}: grade ${c.grade}`);
    assert.equal(c.keying, "table");
    assert.ok(c.pairs.length >= 1 && c.evidence.length > 0, c.table);
  }
  assert.deepEqual([...new Set(p.ctes.map((c: any) => c.grade))].sort(), [...GRADES].sort(), "every grade occurs in the fixture");
  assert.equal(p.ctes.length + p.blocked.length + p.unsecured.length, all.length, "every table instance has exactly one outcome");
  for (const [t] of TABLES) {
    const x = await ds(t);
    for (const c of x.conditions) assert.ok(GRADES.includes(c.grade), `${t}: ${c.grade}`);
  }
});

test("HCM table-keyed: the whole duty map, one grant-set class only (positions: grade duty); two classes = blocked, no name-token guess", async () => {
  const pos = await ds("HR_ALL_POSITIONS_F");
  assert.deepEqual(pos.conditions.map((c: any) => [c.object, c.privileges, c.route, c.grade]), [["HR_ALL_POSITIONS_F", ["PER_REPORT_POSITION_DATA"], "direct", "duty"]]);
  const pap = await ds("PER_ALL_PEOPLE_F");
  assert.deepEqual([pap.verdict, pap.hcm], ["blocked", true]);
  assert.match(pap.blocked[0].reason, /PER_ALL_PEOPLE_F carries 2 privileges across the analysis duties .* key the plan on the subject area the query reads/);
  assert.deepEqual(pap.blocked[0].candidates.map((c: any) => c.privilege), ["ANC_REPORT_ABSENCE_RECORD_DATA", "PER_REPORT_PERSON_DATA"]);
});

test("curated rows: instance scope (pod-a applies, pod-b takes the rule and pool 2); a conflict and an ungranted pair are blocked; dimension vs fact areas", async () => {
  const a = await plan([{ table: "ZZ_ONE_BU", alias: "z" }]);
  assert.deepEqual(a.ctes.map((c: any) => [c.column, c.pairs[0].privilege, c.grade]), [["ORG_ID", "ZZ_CURATED_DATA", "inferred"]]);
  const b = await plan([{ table: "ZZ_ONE_BU", alias: "z" }], INST_B);
  assert.deepEqual([b.instance, b.layerStamp, b.ctes, b.blocked.length], [INST_B, "2026-09-01", [], 1]);
  const c = await ds("ZZ_CONFLICT");
  assert.equal(c.verdict, "blocked");
  assert.match(c.blocked[0].reason, /^the curated rows that apply to ZZ_CONFLICT disagree on the privilege of FUN_ALL_BUSINESS_UNITS_V: ZZ2 → ZZ_CURATED_DATA \(inferred\); ZZ2 → AP_REPORT_PAYABLES_DATA \(inferred\) — no silent pick$/);
  assert.deepEqual(c.blocked[0].candidates.map((x: any) => x.privilege), ["AP_REPORT_PAYABLES_DATA", "ZZ_CURATED_DATA"]);
  const ug = await ds("ZZ_UNGRANTED");
  assert.match(ug.blocked[0].reason, /^the curated privilege AP_MANAGE_PAYABLES_INVOICE_DATA of FUN_ALL_BUSINESS_UNITS_V \(ZZ3, inferred\) carries no active grant on pod-a/);
  // AP_CHECKS_ALL reads in "Payables Payments - …" and is module AP — the SCFO row (BU view / DOO) does NOT apply: there it is a dimension
  assert.deepEqual((await ds("AP_CHECKS_ALL")).conditions.map((x: any) => [x.privileges, x.grade]), [[["AP_REPORT_PAYABLES_DATA"], "trace"]]);
  // a row naming the table's OWN object applies from a dimension folder (direct route): the rule alone would be ambiguous
  const dim = await ds("ZZ_DIRECT_DIM");
  assert.deepEqual([dim.verdict, dim.conditions.map((x: any) => [x.route, x.privileges, x.grade])], ["secured", [["direct", ["ZZ_VIEW_Y_DATA"], "inferred"]]]);
});

test("registration edge cases: disallowed, a reference object the pod does not register, registered without any grant, several granted stripes, no key column", async () => {
  const f = await ds("FFS_SCHEDULE");
  assert.deepEqual([f.verdict, f.disallowed?.reason === DISALLOWED[0].reason], ["blocked", true]);
  assert.match(f.blocked[0].reason, /^FFS_SCHEDULE is DISALLOWED in secured SQL: ORGANIZATION_ID: no Oracle policy/);
  const fa = await ds("FA_BOOKS");
  assert.match(fa.blocked[0].reason, /^FA_BOOK_CONTROLS \(the BOOK reference of FA_BOOKS\.BOOK_TYPE_CODE\) is not registered as a security object on pod-a/);
  const ng = await ds("ZZ_REG_NOGRANT");
  assert.match(ng.blocked[0].reason, /^ZZ_REG_NOGRANT is registered as ZZ_REG_NOGRANT but carries no active grant on pod-a\.example\.oraclecloud\.com, and it has no context column/);
  const st = await ds("ZZ_STRIPED");
  assert.match(st.blocked[0].reason, /^ZZ_STRIPED is registered under 2 granted security objects on pod-a\.example\.oraclecloud\.com \(ZZ_STRIPED_A, ZZ_STRIPED_B\) and none is named ZZ_STRIPED — no silent pick$/);
  const nk = await ds("ZZ_NOPK");
  assert.match(nk.blocked[0].reason, /^ZZ_NOPK has no key column registered in FND_OBJECTS on pod-a/);
  for (const x of [f, fa, ng, st, nk]) { assert.equal(x.verdict, "blocked"); assert.deepEqual(x.conditions, []); assertNamesOnly(x); }
});

test("payload: without `instance` the facts + a note (no verdict); with it the verdict; the compact names[] form; getTable / getColumns / validateColumns / validateTable carry it", async () => {
  const bare = await dataSecurityFor("AP_CHECKS_ALL") as any;
  assert.deepEqual(Object.keys(bare), ["columns", "disallowed", "hcm", "exposure", "note"]);
  assert.deepEqual(bare.columns, [{ column: "ORG_ID", context: "BU", primary: true, confidence: "name", evidence: 0, reference: "FUN_ALL_BUSINESS_UNITS_V.BU_ID" }]);
  // OTBI exposure (facts only): read by 2 subject areas, a fact of one
  const exposure = { areas: 2, factAreas: [PAY_PMT], factAreaCount: 1 };
  assert.deepEqual(bare.exposure, exposure);
  assert.match(bare.note, /pass `instance`/);
  assert.deepEqual(compactDataSecurity(bare), { columns: [{ column: "ORG_ID", context: "BU", primary: true, reference: "FUN_ALL_BUSINESS_UNITS_V.BU_ID" }], disallowed: null, hcm: false, exposure, note: bare.note });
  const full = await ds("AP_CHECKS_ALL");
  assert.deepEqual(Object.keys(full), ["columns", "disallowed", "hcm", "exposure", "instance", "layerStamp", "keying", "verdict", "conditions", "blocked"]);
  assert.deepEqual(compactDataSecurity(full), {
    verdict: "secured", columns: [{ column: "ORG_ID", context: "BU", primary: true, reference: "FUN_ALL_BUSINESS_UNITS_V.BU_ID" }], disallowed: null, hcm: false, exposure,
    conditions: [{ column: "ORG_ID", object: BU, privileges: ["AP_REPORT_PAYABLES_DATA"], route: "reference", grade: "trace" }],
  });
  const none = await ds("FND_LOOKUP_VALUES_TL");
  assert.deepEqual([none.verdict, none.conditions, none.blocked], ["none", [], []]);
  assert.match(none.reason, /reference data/);
  assert.deepEqual(compactDataSecurity(none), { verdict: "none", columns: [], disallowed: null, hcm: false, exposure: { areas: 1, factAreas: [], factAreaCount: 0 }, reason: none.reason });
  // the sensitive pair is a fact of the payload
  assert.deepEqual((await dataSecurityFor("POZ_SUPPLIERS_PII") as any).sensitive,
    { object: "POZ_SUPPLIERS_PII", privileges: ["POZ_MAINTAIN_SUPPLIER_TAX_IDENTIFIERS_PII_DATA", "POZ_MAINTAIN_SUPPLIER_CORPORATE_TAX_IDENTIFIERS_DATA"] });
  const blocked = compactDataSecurity(await ds("INV_MATERIAL_TXNS")) as any;
  assert.deepEqual([blocked.verdict, blocked.blocked.length, blocked.blocked[0].column, blocked.blocked[0].candidates.length], ["blocked", 1, "ORGANIZATION_ID", 4]);
  for (const p of [await catalog.getTable("AP_CHECKS_ALL", INST_A), await catalog.getColumns("AP_CHECKS_ALL", { instance: INST_A }),
    await catalog.validateColumns("AP_CHECKS_ALL", ["ORG_ID"], INST_A), await catalog.validateTable("AP_CHECKS_ALL", INST_A)] as any[]) {
    assert.deepEqual(p.dataSecurity, full);
  }
  assert.deepEqual((await catalog.getTable("AP_CHECKS_ALL") as any).dataSecurity, bare);
  assert.equal("dataSecurity" in (await catalog.mostlyUsedStats("NOPE_TABLE", INST_A)), false);
  await assert.rejects(() => catalog.mostlyUsedStats("AP_CHECKS_ALL", "nope.example"), /no data-access security layer is loaded for nope\.example \(loaded: pod-a\.example\.oraclecloud\.com, pod-b\.example\.oraclecloud\.com\)/);
  await assert.rejects(() => catalog.mostlyUsedStats("AP_CHECKS_ALL", " "), /`instance` is required/);
});

test("plan input rules: instance required / unknown; tables required; alias identifier-shaped and unique; unknown table = suggestions; an ambiguous row = a broken release", async () => {
  assert.match((await getDataAccessPredicate({ tables: [{ table: "AP_CHECKS_ALL", alias: "a" }] }) as any).error, /^`instance` is required: the pod host exactly as runSql reports `instance` — there is no default instance$/);
  assert.match((await getDataAccessPredicate({ instance: "", tables: [{ table: "AP_CHECKS_ALL", alias: "a" }] }) as any).error, /`instance` is required/);
  assert.match((await getDataAccessPredicate({ instance: "pod-c.example", tables: [{ table: "AP_CHECKS_ALL", alias: "a" }] }) as any).error, /no data-access security layer is loaded for pod-c\.example \(loaded: pod-a\.example\.oraclecloud\.com, pod-b\.example\.oraclecloud\.com\)/);
  assert.match((await getDataAccessPredicate({ instance: INST_A, tables: [] }) as any).error, /`tables` is required/);
  assert.match((await getDataAccessPredicate({ instance: INST_A, tables: [{ table: "AP_CHECKS_ALL", alias: "a b" }] }) as any).error, /alias of AP_CHECKS_ALL is required/);
  assert.match((await getDataAccessPredicate({ instance: INST_A, tables: [{ table: "AP_CHECKS_ALL", alias: "a" }, { table: "GL_JE_HEADERS", alias: "A" }] }) as any).error, /alias A is used twice/);
  const un: any = await getDataAccessPredicate({ instance: INST_A, tables: [{ table: "AP_CHECK_ALL", alias: "a" }] });
  assert.match(un.error, /does not exist/);
  assert.ok(un.suggestions.includes("AP_CHECKS_ALL"));
  await db.security.replaceAll({ ...FACTS, rows: [...ROWS, { ...row("GL_JE_HEADERS", "ORGANIZATION_ID", "BU", 0), confidence: "ambiguous" }] });
  await assert.rejects(() => catalog.mostlyUsedStats("GL_JE_HEADERS"), /unresolved data-access column\(s\) ORGANIZATION_ID in the served release/);
  await db.security.replaceAll(FACTS);
});

test("incomplete facts (a stamp missing — incl. the audited primaries / sensitive objects) fail loudly, never degrade", async () => {
  for (const k of ["privilege_prefix_aliases", "primary_audit", "sensitive_objects", "context_evidence_refs"]) {
    const rest: Record<string, string> = { ...META };
    delete rest[k];
    await db.security.replaceAll({ ...FACTS, meta: rest });
    await assert.rejects(() => plan([{ table: "AP_CHECKS_ALL", alias: "ap" }]), new RegExp(`sec_meta \\(version 2\\) is missing ${k}`));
  }
  await db.security.replaceAll(FACTS);
});

const aplan = (tables: { table: string; alias: string }[], subjectArea: string, instance: string = INST_A) =>
  getDataAccessPredicate({ instance, tables, subjectArea }) as Promise<any>;
const eplan = (tables: { table: string; alias: string }[], subjectAreas?: string[], instance: string = INST_A) =>
  getSecuredQueryPlan({ instance, tables, ...(subjectAreas ? { subjectAreas } : {}) }) as Promise<any>;

test("area keying (developer subjectArea): one table, two areas, two privileges; the curated (area, entity) row picks the context; VO evidence; undecided = blocked; columns as advice; the gate not applied", async () => {
  // the payment table read by Payables Payments (its fact) and by SCFO (a dimension): each area's own entity privilege
  const pmt = await aplan([{ table: "AP_CHECKS_ALL", alias: "c" }], PAY_PMT);
  assertNamesOnly(pmt);
  assert.deepEqual([pmt.keying, pmt.subjectArea], ["area", PAY_PMT]);
  assert.deepEqual(pmt.ctes.map((c: any) => [c.keying, c.subjectArea, c.column, c.pairs[0].privilege, c.grade]), [["area", PAY_PMT, "ORG_ID", "AP_REPORT_PAYABLES_DATA", "trace"]]);
  assert.match(cteOf(pmt, "c").evidence, /^curated row Payables \(area, entity\) \(trace\): same trace; entity of Payables Payments - Disbursements Real Time: curated \(area, entity\) row Payables → FUN_ALL_BUSINESS_UNITS_V \(trace\)$/);
  const scfo = await aplan([{ table: "AP_CHECKS_ALL", alias: "c" }], SCFO);
  assert.deepEqual(scfo.ctes.map((c: any) => [c.column, c.pairs[0].privilege, c.grade]), [["ORG_ID", "DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "inferred"]],
    "OTBI secures the dimension with the AREA's privilege on the entity");
  assert.deepEqual(scfo.gate, { applied: false, note: scfo.gate.note });
  assert.match(scfo.gate.note, /developer mode: the subject-area gate .* is not applied/);
  // three contexts, the curated (area, entity) row names the BU entity — and the area's columns as advice
  const inv = await aplan([{ table: "AP_INVOICES_ALL", alias: "ai" }], PAY_INV);
  assert.deepEqual(inv.ctes.map((c: any) => [c.column, c.context, c.grade]), [["ORG_ID", "BU", "trace"]]);
  assert.match(cteOf(inv, "ai").evidence, /— SET_OF_BOOKS_ID \(LEDGER\), EXPENDITURE_ORGANIZATION_ID \(PRJ_ORG\) not applied, as OTBI does$/);
  assert.match(cteOf(inv, "ai").cte, /^ai_sec as \(select \/\*\+ INLINE \*\/ t\.\* from AP_INVOICES_ALL t where/, "developer projection stays t.*");
  assert.deepEqual(inv.columns, { ai: { hidden: ["INVOICE_NUM", "SET_OF_BOOKS_ID"], hiddenCount: 2, maskingShapes: ["SET_OF_BOOKS_ID"] } });
  // two contexts, no curated row: the area's VO joins GL_LEDGERS -> the LEDGER entity (not the BU primary); GL is the area's product
  const led = await aplan([{ table: "ZZ_TWO_CTX", alias: "z" }], ZLED);
  assert.deepEqual(led.blocked, []);
  assert.deepEqual(led.ctes.map((c: any) => [c.column, c.context, c.pairs[0].object, c.pairs[0].privilege, c.grade]), [["LEDGER_ID", "LEDGER", "GL_LEDGERS", "GL_REPORT_GENERAL_LEDGER_DATA", "rule"]]);
  assert.match(cteOf(led, "z").evidence, /module ZZ\/GL \(the table's ZZ \+ the fact modules of Zed - Ledgers Real Time\).*VO evidence — ZzLedgerTwoVO of Zed - Ledgers Real Time reads ZZ_TWO_CTX with GL_LEDGERS — ORG_ID \(BU\) not applied, as OTBI does$/);
  // the same table where the area's VO joins BOTH entities and the prefix is unaudited: blocked, the reason says why
  const mix = await aplan([{ table: "ZZ_TWO_CTX", alias: "z" }], ZMIX);
  assert.deepEqual([mix.ctes, mix.blocked.map((b: any) => [b.table, b.column])], [[], [["ZZ_TWO_CTX", "ORG_ID"]]]);
  assert.match(mix.blocked[0].reason, /^ZZ_TWO_CTX carries 2 contexts \(BU, LEDGER\) and Zed - Mixed Real Time decides none of them: no curated \(area, entity\) row names one, the area's 1 VO\(s\) reading ZZ_TWO_CTX join the entities of several \(BU, LEDGER\), and ZZ has no audited primary context/);
  // table-keyed, the same table is blocked by the missing audit
  assert.match((await ds("ZZ_TWO_CTX")).blocked[0].reason, /ZZ is not audited/);
  // a table the area does not read
  const no = await aplan([{ table: "GL_JE_HEADERS", alias: "gl" }], PAY_INV);
  assert.match(no.blocked[0].reason, /^GL_JE_HEADERS is read by no folder of subject area Payables Invoices - Transactions Real Time \(OTBI lineage\) — it is read by 3 other subject area\(s\)/);
  // an unknown area = an error with suggestions; the payload keyed on an area
  const bad: any = await getDataAccessPredicate({ instance: INST_A, tables: [{ table: "AP_CHECKS_ALL", alias: "c" }], subjectArea: "Payables Payment - Disbursements Real Time" });
  assert.match(bad.error, /subject area "Payables Payment - Disbursements Real Time" is not in the catalog/);
  assert.ok(bad.suggestions.includes(PAY_PMT));
  const kd = await dataSecurityFor("AP_CHECKS_ALL", INST_A, SCFO) as any;
  assert.deepEqual([kd.keying, kd.subjectArea, kd.conditions[0].privileges], ["area", SCFO, ["DOO_MANAGE_ORCHESTRATION_ORDER_DATA"]]);
});

test("HCM area-duty route: the area's guide code mapped to the pod's ORA_<code>_HCM role decides; customer copies count for the privilege; an unmapped code blocks", async () => {
  const asg = await aplan([{ table: "PER_ALL_ASSIGNMENTS_M", alias: "a" }], WFA);
  assertNamesOnly(asg);
  assert.deepEqual(asg.ctes.map((c: any) => [c.route, c.pairs[0].privilege, c.grade]), [["direct", "PER_REPORT_PERSON_DATA", "duty"]]);
  assert.match(cteOf(asg, "a").evidence, /^the duties of Workforce Management - Worker Assignment Real Time \(Oracle TBI guide; ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM \+ 1 customer copy\) on PER_ALL_ASSIGNMENTS_M on pod-a\.example\.oraclecloud\.com: PER_REPORT_PERSON_DATA held by 1 duty$/);
  // the person table: the mapped duty + its customer copy hold the person privilege; the absence duty is not the area's
  const pap = await aplan([{ table: "PER_ALL_PEOPLE_F", alias: "p" }], WFP);
  assert.deepEqual(pap.ctes.map((c: any) => [c.pairs[0].privilege, c.grade]), [["PER_REPORT_PERSON_DATA", "duty"]]);
  assert.match(cteOf(pap, "p").evidence, /ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM \+ 1 customer copy\) on PER_ALL_PEOPLE_F .*: PER_REPORT_PERSON_DATA held by 2 duties$/);
  // the absence area's code exists on the pod under neither name: never held, the route cannot secure
  const abs = await aplan([{ table: "PER_ALL_ASSIGNMENTS_M", alias: "a" }], ABS);
  assert.deepEqual(abs.ctes, []);
  assert.match(abs.blocked[0].reason, /whose duty roles cannot be named on pod-a\.example\.oraclecloud\.com: the HCM guide code\(s\) FBI_NOPE_TRANSACTION_ANALYSIS_DUTY of Absence Management - Absence Real Time exist on pod-a\.example\.oraclecloud\.com under neither the guide's name nor ORA_<code>_HCM — unmapped, never held/);
});

test("getSecuredQueryPlan: without areas = the candidate areas (and stop); no area reads them all = per table", async () => {
  const c = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }, { table: "FND_LOOKUP_VALUES_TL", alias: "lk" }]);
  assertNamesOnly(c);
  assert.deepEqual(Object.keys(c), ["instance", "layerStamp", "mode", "candidateAreas", "next"]);
  assert.deepEqual(c.candidateAreas, [{ area: PAY_INV, factOf: ["AP_INVOICES_ALL"], alsoReads: ["FND_LOOKUP_VALUES_TL"], duties: 2, hcm: false }]);
  assert.match(c.next, /never ask the end user for an area/);
  const one = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }]);
  assert.deepEqual(one.candidateAreas.map((x: any) => [x.area, x.factOf.length]), [[PAY_INV, 1], [SCFO, 0]], "facts first, then by name");
  const none = await eplan([{ table: "AP_CHECKS_ALL", alias: "c" }, { table: "GL_JE_HEADERS", alias: "gl" }]);
  assert.deepEqual(none.candidateAreas, []);
  assert.deepEqual(none.perTable, { AP_CHECKS_ALL: [PAY_PMT, SCFO], GL_JE_HEADERS: [GLJ, ZFOR, ZLED] });
  assert.match(none.next, /no single subject area reads all these tables/);
});

test("getSecuredQueryPlan: the area's columns only (allowed + joinOnly in the CTE projection), the gate input (FSCM codes verbatim, alternates), a structural none read without a condition, a pool-2 pick NOT read", async () => {
  const p = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }, { table: "FND_LOOKUP_VALUES_TL", alias: "lk" }], [PAY_INV]);
  assertNamesOnly(p);
  assert.deepEqual(Object.keys(p), ["mode", "enforcement", "instance", "layerStamp", "catalogRelease", "guideRelease", "keying", "subjectAreas", "gate", "ctes", "rewrite", "pairs", "blocked", "columns", "limits"]);
  assert.deepEqual([p.mode, p.enforcement, p.keying, p.guideRelease, p.subjectAreas], ["end-user", "prompt", "area", "test", [PAY_INV]]);
  // the whitelist: exposed as-is, the masked input hidden, the PK and the FK column join-only
  assert.deepEqual(p.columns.ai, { allowed: ["EXPENDITURE_ORGANIZATION_ID", "INVOICE_ID", "ORG_ID"], joinOnly: ["VENDOR_ID"], filterOnly: [], hidden: ["INVOICE_NUM", "SET_OF_BOOKS_ID"], hiddenCount: 2, maskingShapes: ["SET_OF_BOOKS_ID"] });
  assert.equal(cteOf(p, "ai").cte,
    "ai_sec as (select /*+ INLINE */ t.EXPENDITURE_ORGANIZATION_ID, t.INVOICE_ID, t.ORG_ID, t.VENDOR_ID from AP_INVOICES_ALL t where t.ORG_ID in (select sec$.BU_ID from FUN_ALL_BUSINESS_UNITS_V sec$ where {PRED:FUN_ALL_BUSINESS_UNITS_V|AP_REPORT_PAYABLES_DATA}))");
  assert.deepEqual(p.rewrite, [{ from: "AP_INVOICES_ALL ai", to: "ai_sec ai" }, { from: "FND_LOOKUP_VALUES_TL lk", to: "lk_sec lk" }]);
  assert.deepEqual(p.pairs, [{ object: BU, privilege: "AP_REPORT_PAYABLES_DATA", alias: "sec$" }]);
  // a none table with no relationship to secured data: the structural rule reads it, the area's columns only, no condition, no pair
  assert.deepEqual(p.blocked, []);
  assert.deepEqual([cteOf(p, "lk").grade, cteOf(p, "lk").route, cteOf(p, "lk").pairs, cteOf(p, "lk").subjectArea], ["structural", null, [], PAY_INV]);
  assert.equal(cteOf(p, "lk").cte, "lk_sec as (select /*+ INLINE */ t.LOOKUP_CODE from FND_LOOKUP_VALUES_TL t)");
  assert.match(cteOf(p, "lk").evidence, /^structural none rule \(end user\): no declared or mined relationship to secured data/);
  // the gate: the settled area with its codes verbatim (FSCM); the alternates read every table and carry codes
  assert.deepEqual(p.gate, { areas: [{ area: PAY_INV, duties: ["FBI_INTER_COMPANY_TRANSACTION_ANALYSIS_DUTY", "FBI_PAYABLES_INVOICE_TRANSACTION_ANALYSIS_DUTY"] }], alternates: [] });
  const alt = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }], [PAY_INV]);
  assert.deepEqual(alt.gate.alternates, [{ area: SCFO, duties: ["FBI_SUPPLY_CHAIN_FINANCIAL_ORCHESTRATION_TRANSACTION_ANALYSIS_DUTY"] }]);
  assert.match(p.limits, /^Read as OTBI subject area Payables Invoices - Transactions Real Time for the signed-in user: 1 table\(s\) filtered by 1 data-access pair\(s\) \(FUN_ALL_BUSINESS_UNITS_V \/ AP_REPORT_PAYABLES_DATA\), 1 reference table\(s\) read without a condition by the structural rule \(FND_LOOKUP_VALUES_TL\), 2 column\(s\) the area does not expose withheld, 0 table instance\(s\) not readable; security layer 2026-10-03, catalog .*, TBI guides test; enforcement: prompt/);
  // a pool-2 pick (grade granted) is not OTBI-proven: blocked for an end user
  const ce = await eplan([{ table: "CE_STATEMENT_LINES", alias: "ce" }], [CASH]);
  assert.deepEqual(ce.ctes, []);
  assert.match(ce.blocked[0].reason, /^CE_STATEMENT_LINES: the only condition found is a pool-2 pick \(FUN_ALL_BUSINESS_UNITS_V \/ CE_MANAGE_BANK_STATEMENT_DATA, grade granted/);
  // a table none of the given areas reads
  const nr = await eplan([{ table: "GL_JE_HEADERS", alias: "gl" }], [PAY_INV]);
  assert.match(nr.blocked[0].reason, /^GL_JE_HEADERS is read by none of the subject areas Payables Invoices - Transactions Real Time/);
  assert.deepEqual(nr.gate.areas, []);
});

test("getSecuredQueryPlan HCM: the gate carries the MAPPED pod role (never the customer copy); an unmapped area = duties [] + neverHeld; several areas key each table on the first that reads it", async () => {
  const p = await eplan([{ table: "PER_ALL_ASSIGNMENTS_M", alias: "a" }], [WFA]);
  assert.deepEqual(p.gate.areas, [{ area: WFA, duties: ["ORA_FBI_PERSON_TRANSACTION_ANALYSIS_DUTY_HCM"] }]);
  assert.deepEqual(p.ctes.map((c: any) => [c.subjectArea, c.grade]), [[WFA, "duty"]]);
  const pp = await eplan([{ table: "PER_ALL_PEOPLE_F", alias: "p" }], [WFP]);
  assert.doesNotMatch(JSON.stringify(pp.gate), /XXKD/, "a customer copy is never an area holder");
  const ab = await eplan([{ table: "PER_ALL_ASSIGNMENTS_M", alias: "a" }], [ABS]);
  assert.deepEqual(ab.gate.areas.map((g: any) => [g.area, g.duties]), [[ABS, []]]);
  assert.match(ab.gate.areas[0].neverHeld, /unmapped, never held/);
  assert.deepEqual(ab.ctes, []);
  // two areas: each table keyed on the first given area that reads it; the gate lists both
  const two = await eplan([{ table: "AP_CHECKS_ALL", alias: "c" }, { table: "AP_INVOICES_ALL", alias: "ai" }], [PAY_PMT, PAY_INV]);
  assert.deepEqual(two.ctes.map((c: any) => [c.alias, c.subjectArea]), [["c", PAY_PMT], ["ai", PAY_INV]]);
  assert.deepEqual(two.gate.areas.map((g: any) => g.area), [PAY_PMT, PAY_INV]);
  assert.match((await eplan([{ table: "AP_CHECKS_ALL", alias: "c" }], ["Nope Area"])).error, /subject area "Nope Area" is not in the catalog/);
});

test("the masking-shape classifier: lookups / casts / null defaults / cases expose their inputs; masks, scalar subqueries, aggregates and unknown calls hide them", () => {
  for (const e of ["nvl(HCM_LOOKUPS.MEANING , PER_ALL_ASSIGNMENTS_M.PROBATION_UNIT)", "cast(PJF_PROJ_ELEMENTS_B.TASK_CODE10_ID as CHARACTER ( 30 ) )",
    "case when ZCA_SALES_ACCOUNTS.EXISTING_FLAG = 'Y' then 'N' else 'Y' end", "(decode(PER_JOBS_F.ATTRIBUTE_CATEGORY,'SMCR','YN',null))",
    "FND_CAL_WEEK.PARENT_YEAR * 100 + ZCA_BI_CRM_CALENDAR.FISCAL_PERIOD_NUMBER", "to_char(T.D, 'YYYY-MM')"]) {
    assert.equal(exposesInputs(e), true, e);
  }
  for (const e of ["'XXXX' || SUBSTR(T.ACCOUNT_NUM, -4)", "LPAD(SUBSTR(T.IBAN, -4), 12, '*')", "regexp_replace(T.SSN, '[0-9]', 'X')",
    "(select MEANING from HR_LOOKUPS where LOOKUP_CODE = T.CODE)", "sum(T.AMOUNT) over (partition by T.ID)", "'****'", "STANDARD_HASH(T.X)"]) {
    assert.equal(exposesInputs(e), false, e);
  }
});

test("payload R7: getColumns carries per-column OTBI exposure (exposedIn) and, on a sensitive table, the masked twin to read instead", async () => {
  const c = await catalog.getColumns("AP_INVOICES_ALL") as any;
  const by = Object.fromEntries(c.columns.map((x: any) => [x.name, x.exposedIn ?? 0]));
  assert.deepEqual(by, { INVOICE_ID: 2, ORG_ID: 1, SET_OF_BOOKS_ID: 1, EXPENDITURE_ORGANIZATION_ID: 1, VENDOR_ID: 0, INVOICE_NUM: 0 });
  const iby = await catalog.getColumns("IBY_EXT_BANK_ACCOUNTS") as any;
  assert.deepEqual(iby.columns.filter((x: any) => x.readInstead).map((x: any) => [x.name, x.readInstead]), [["BANK_ACCOUNT_NUM", "MASKED_BANK_ACCOUNT_NUM"], ["IBAN", "MASKED_IBAN"]]);
});

test("no OTBI lineage served (an empty presentation layer): the end-user plan refuses, the developer area keying says why", async () => {
  await db.otbi.replaceAll([], [], [], [], "test", { vos: [], areaDuties: [], areaJobs: [], guideRelease: "test", unmappedAreas: {} });
  const e: any = await eplan([{ table: "AP_CHECKS_ALL", alias: "c" }], [PAY_PMT]);
  assert.match(e.error, /^OTBI catalog unavailable: .* refuse the question; nothing may be read$/);
  assert.match((await aplan([{ table: "AP_CHECKS_ALL", alias: "c" }], PAY_PMT)).error, /subjectArea keying needs the OTBI catalog/);
  // the table-keyed plan does not need it
  assert.equal((await plan([{ table: "AP_CHECKS_ALL", alias: "c" }])).ctes.length, 1);
  await db.otbi.replaceAll(OTBI_AREAS, OTBI_FOLDERS, OTBI_COLUMNS, [], "test", OTBI_LINEAGE);
});

test("job-role consensus (area keying): the area's guide job roles decide what the rule cannot — a unique majority picks, a tie decides nothing; table keying has no voters", async () => {
  const j = await aplan([{ table: "ZZJ_ITEMS", alias: "i" }], ZJOB);
  assertNamesOnly(j);
  assert.deepEqual(j.blocked, []);
  assert.deepEqual(j.ctes.map((c: any) => [c.route, c.pairs.map((p: any) => p.privilege), c.grade]), [["direct", ["ZZJ_VIEW_A_DATA"], "consensus"]]);
  assert.equal(cteOf(j, "i").evidence, "job-role consensus of Zed - Jobs Real Time on ZZJ_ITEMS on pod-a.example.oraclecloud.com: ZZJ_VIEW_A_DATA — majority — 2 of 3 holder job role(s), " +
    "2 grant-set classes, among U's named privileges (FUSION_APPS_OBIA_BIEE_APPID); voters = the 3 job role(s) Oracle's TBI guides name for the area");
  // the job roles of another area split: the developer plan blocks with the candidates and says why the consensus did not decide
  const s = await aplan([{ table: "ZZJ_ITEMS", alias: "i" }], ZSPLIT);
  assert.deepEqual(s.ctes, []);
  assert.match(s.blocked[0].reason, /^2 privileges of module ZZJ on ZZJ_ITEMS granted to FUSION_APPS_OBIA_BIEE_APPID with distinct grant sets on pod-a\.example\.oraclecloud\.com — ambiguous: ZZJ_VIEW_A_DATA, ZZJ_VIEW_B_DATA; the job-role consensus decides nothing \(the 2 holder job role\(s\) of Zed - Split Real Time split over 2 classes of U's named privileges \(FUSION_APPS_OBIA_BIEE_APPID\) \(ZZJ_VIEW_A_DATA \[1\], ZZJ_VIEW_B_DATA \[1\]\) — a tie\); a curated row/);
  assert.deepEqual(s.blocked[0].candidates.map((c: any) => c.privilege), ["ZZJ_VIEW_A_DATA", "ZZJ_VIEW_B_DATA"]);
  // table keying: no area, no voters — the rule's ambiguity stands as before
  assert.match((await ds("ZZJ_ITEMS")).blocked[0].reason, /ambiguous: ZZJ_VIEW_A_DATA, ZZJ_VIEW_B_DATA; a curated row/);
  // the coverage helper: the consensus of (area, object), whatever the rule decides
  const jc: any = await jobConsensus(INST_A, ZJOB, "ZZJ_ITEMS");
  assert.deepEqual([jc.privilege, jc.equivalentTo], ["ZZJ_VIEW_A_DATA", []]);
  assert.match((await jobConsensus(INST_A, ZSPLIT, "ZZJ_ITEMS") as any).why, /— a tie$/);
  assert.match((await jobConsensus(INST_A, PAY_INV, BU) as any).why, /^Payables Invoices - Transactions Real Time names no guide job role \(otbi_area_job\)$/);
});

test("strictest of candidates (END USER): several U classes, no consensus, the area's own module — every class AND-ed in ONE condition with the empty-result wording; a foreign dimension is not read; the developer never ANDs", async () => {
  const s = await eplan([{ table: "ZZJ_ITEMS", alias: "i" }], [ZSPLIT]);
  assertNamesOnly(s);
  assert.deepEqual(s.blocked, []);
  const c = cteOf(s, "i");
  assert.deepEqual([c.grade, c.route, c.pairs.map((p: any) => p.privilege)], ["strictest", "direct", ["ZZJ_VIEW_A_DATA", "ZZJ_VIEW_B_DATA"]]);
  assert.equal(c.cte, "i_sec as (select /*+ INLINE */ t.ITEM_NAME from ZZJ_ITEMS t where t.ID in (select sec$.ID from ZZJ_ITEMS sec$ where ({PRED:ZZJ_ITEMS|ZZJ_VIEW_A_DATA}) and ({PRED:ZZJ_ITEMS|ZZJ_VIEW_B_DATA})))");
  assert.deepEqual(c.strictest, { privileges: ["ZZJ_VIEW_A_DATA", "ZZJ_VIEW_B_DATA"],
    onEmpty: "access cannot be confirmed for ZZJ_ITEMS (ambiguous privilege, you lack <the privilege whose predicate came back (1=2)>)" });
  assert.deepEqual(s.pairs.map((p: any) => p.privilege), ["ZZJ_VIEW_A_DATA", "ZZJ_VIEW_B_DATA"]);
  assert.match(s.limits, /ZZJ_ITEMS by the strictest of candidates \(ambiguous privilege: rows show only when you hold every candidate\)/);
  // where the area's job roles agree, the end user reads ONE consensus pair instead
  const j = await eplan([{ table: "ZZJ_ITEMS", alias: "i" }], [ZJOB]);
  assert.deepEqual(j.ctes.map((x: any) => [x.grade, x.pairs.length, "strictest" in x]), [["consensus", 1, false]]);
  // a dimension of a GL area (ZZJ is not one of the area's modules): blocked, never a strictest AND
  const f = await eplan([{ table: "ZZJ_ITEMS", alias: "i" }], [ZFOR]);
  assert.deepEqual(f.ctes, []);
  assert.match(f.blocked[0].reason, /the strictest of candidates applies only to a table of Zed - Foreign Real Time's own modules \(GL\), and ZZJ_ITEMS is a ZZJ table — a foreign dimension of the area, not read$/);
  assert.equal((await aplan([{ table: "ZZJ_ITEMS", alias: "i" }], ZSPLIT)).ctes.length, 0, "the developer plan blocks the ambiguity");
  assert.deepEqual(await endUserAccess("ZZJ_ITEMS", INST_A, ZSPLIT),
    { readable: true, grade: "strictest", route: "direct", filterOnly: 0, detail: "ZZJ_ITEMS/ZZJ_VIEW_A_DATA AND ZZJ_ITEMS/ZZJ_VIEW_B_DATA" });
});

test("structural none rule (END USER): a reference family stays readable with a secured relationship; a child of secured data and a translation of secured data are not; the developer reads them directly", async () => {
  const p = await eplan([{ table: "AP_LOOKUP_CODES", alias: "lc" }, { table: "ZZ_SUPPLIERS", alias: "s" }, { table: "ZZ_THINGS_TL", alias: "th" },
    { table: "ZZ_NOTES_TL", alias: "nt" }], [PAY_INV]);
  assertNamesOnly(p);
  assert.deepEqual(p.ctes.map((c: any) => [c.table, c.grade, c.route, c.pairs.length]), [["AP_LOOKUP_CODES", "structural", null, 0], ["ZZ_NOTES_TL", "structural", null, 0]]);
  assert.equal(cteOf(p, "lc").evidence, "structural none rule (end user): lookup reference data (test: lookup) — related to secured AP_INVOICES_ALL, and reference data stays readable");
  assert.equal(cteOf(p, "nt").evidence, "structural none rule (end user): translation reference data (test: translation) — related to secured AP_INVOICES_ALL only through non-key columns, its base ZZ_NOTES_B not secured");
  assert.equal(cteOf(p, "lc").cte, "lc_sec as (select /*+ INLINE */ t.DISPLAYED_FIELD from AP_LOOKUP_CODES t)");
  assert.deepEqual(p.blocked.map((b: any) => b.table), ["ZZ_SUPPLIERS", "ZZ_THINGS_TL"]);
  assert.equal(p.blocked[0].reason, "ZZ_SUPPLIERS has no context column and is no security object, but a declared FK reaches secured POZ_SUPPLIERS_PII — a child of secured data " +
    "that is no reference-family member (lookup / translation / calendar / currency / territory) is not read by an end user");
  assert.equal(p.blocked[1].reason, "ZZ_THINGS_TL is a translation whose key THING_ID relates to secured ZZ_DIRECT_DIM — a translation of secured data, not reference data");
  assert.deepEqual(p.pairs, []);
  // the developer plan: plain none tables, read directly
  const d = await plan([{ table: "AP_LOOKUP_CODES", alias: "lc" }, { table: "ZZ_SUPPLIERS", alias: "s" }]);
  assert.deepEqual(d.unsecured.map((u: any) => u.table), ["AP_LOOKUP_CODES", "ZZ_SUPPLIERS"]);
  assert.deepEqual(await endUserAccess("ZZ_SUPPLIERS", INST_A, PAY_INV), { readable: false, reason: p.blocked[0].reason });
});

test("filter-only columns (END USER): the corpus filter columns the area does not expose are projected for WHERE / JOIN only; exposed, key and masking-shape columns never become filter-only", async () => {
  await db.registries.replaceAll("predicates", [
    { table_name: "AP_INVOICES_ALL", column_name: "INVOICE_NUM", op: "EQ", literal: "'X'", occurrences: 4, role: "filter" },
    { table_name: "AP_INVOICES_ALL", column_name: "ORG_ID", op: "IN", literal: "(1)", occurrences: 2, role: "filter" },
    { table_name: "AP_INVOICES_ALL", column_name: "VENDOR_ID", op: "EQ", literal: "1", occurrences: 2, role: "filter" },
    { table_name: "AP_INVOICES_ALL", column_name: "SET_OF_BOOKS_ID", op: "EQ", literal: "1", occurrences: 2, role: "filter" },
  ]);
  try {
    assert.deepEqual(await db.registries.predicateColumns("AP_INVOICES_ALL"), ["INVOICE_NUM", "ORG_ID", "SET_OF_BOOKS_ID", "VENDOR_ID"]);
    const p = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }], [PAY_INV]);
    assert.deepEqual(p.columns.ai, { allowed: ["EXPENDITURE_ORGANIZATION_ID", "INVOICE_ID", "ORG_ID"], joinOnly: ["VENDOR_ID"], filterOnly: ["INVOICE_NUM"],
      hidden: ["SET_OF_BOOKS_ID"], hiddenCount: 1, maskingShapes: ["SET_OF_BOOKS_ID"] });
    assert.match(cteOf(p, "ai").cte, /^ai_sec as \(select \/\*\+ INLINE \*\/ t\.EXPENDITURE_ORGANIZATION_ID, t\.INVOICE_ID, t\.ORG_ID, t\.VENDOR_ID, t\.INVOICE_NUM from AP_INVOICES_ALL t where /);
    assert.match(p.limits, /1 column\(s\) the area does not expose withheld \(1 filter-only column\(s\) used in conditions, never shown\)/);
    // the developer advice lists the same hidden set
    assert.deepEqual((await aplan([{ table: "AP_INVOICES_ALL", alias: "ai" }], PAY_INV)).columns, { ai: { hidden: ["SET_OF_BOOKS_ID"], hiddenCount: 1, maskingShapes: ["SET_OF_BOOKS_ID"] } });
  } finally {
    await db.registries.replaceAll("predicates", []);
  }
});

test("no-area policy (END USER): a reference-family none table no area reads is read whole (every non-sensitive column); a business table never — readInstead names the equivalent an area reads", async () => {
  const p = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }, { table: "FND_TERRITORIES_VL", alias: "tr" }, { table: "AP_INVOICES_V", alias: "v" }], [PAY_INV]);
  assertNamesOnly(p);
  const tr = cteOf(p, "tr");
  assert.deepEqual([tr.grade, tr.keying, "subjectArea" in tr, tr.pairs], ["structural", "table", false, []]);
  assert.equal(tr.cte, "tr_sec as (select /*+ INLINE */ t.TERRITORY_CODE, t.TERRITORY_SHORT_NAME from FND_TERRITORIES_VL t)");
  assert.match(tr.evidence, /territory reference data \(test: territory\); no declared or mined relationship to secured data .*; no subject area reads it — every non-sensitive column \(user decision 6\)$/);
  assert.deepEqual(p.columns.tr, { allowed: ["TERRITORY_CODE", "TERRITORY_SHORT_NAME"], joinOnly: [], filterOnly: [], hidden: [], hiddenCount: 0 });
  assert.deepEqual(p.blocked.map((b: any) => [b.table, b.readInstead]), [["AP_INVOICES_V", [{ table: "AP_INVOICES_ALL", how: "the same entity (name stem AP_INVOICES), read by OTBI subject areas" }]]]);
  assert.equal(p.blocked[0].reason, "AP_INVOICES_V is a business table no OTBI subject area reads — an end user never reads it — read instead: AP_INVOICES_ALL (the same entity (name stem AP_INVOICES), read by OTBI subject areas)");
  assert.deepEqual(p.gate.areas.map((g: any) => g.area), [PAY_INV], "a no-area table adds no gate area");
  // the candidates leave the no-area tables to the policy and say so
  const c = await eplan([{ table: "AP_INVOICES_ALL", alias: "ai" }, { table: "AP_INVOICES_V", alias: "v" }]);
  assert.deepEqual([c.candidateAreas.map((x: any) => x.area), c.noArea], [[PAY_INV, SCFO], ["AP_INVOICES_V"]]);
  assert.deepEqual(await endUserAccess("AP_INVOICES_V", INST_A, null), { readable: false, reason: p.blocked[0].reason, readInstead: p.blocked[0].readInstead });
  assert.deepEqual(await endUserAccess("FND_TERRITORIES_VL", INST_A, null), { readable: true, grade: "structural", route: null, filterOnly: 0, detail: tr.evidence });
});

test("a traced context column decides the column of its table in the area; the area's known privilege beats the rule for every table of the area on that object (decision 4)", async () => {
  const t2 = await aplan([{ table: "ZZ_TWO_BU", alias: "z" }], ZTWO);
  assertNamesOnly(t2);
  assert.deepEqual(t2.ctes.map((c: any) => [c.column, c.context, c.pairs[0].privilege, c.grade]), [["REQ_BU_ID", "BU", "AP_REPORT_PAYABLES_DATA", "trace"]]);
  assert.match(cteOf(t2, "z").evidence, /curated \(area, entity\) row Zed - Two BU Real Time → ZZ_TWO_BU\.REQ_BU_ID \(trace\); REQ_BU_ID = the column the trace names — PRC_BU_ID \(BU\) not applied, as OTBI does$/);
  assert.match(cteOf(t2, "z").cte, /where \(t\.REQ_BU_ID is null or t\.REQ_BU_ID in \(select sec\$\.BU_ID from FUN_ALL_BUSINESS_UNITS_V sec\$ where/);
  // the row of the area is keyed to another entity: the area's known privilege on the BU view still applies to ZZ_ONE_BU
  const k = await aplan([{ table: "ZZ_ONE_BU", alias: "z" }], ZKNOWN);
  assert.deepEqual(k.ctes.map((c: any) => [c.pairs[0].privilege, c.grade]), [["DOO_MANAGE_ORCHESTRATION_ORDER_DATA", "inferred"]]);
  assert.match(cteOf(k, "z").evidence, /^curated row Zed - Known Real Time \(the area's known privilege on the object\) \(inferred\): the area's known privilege on the BU view/);
});

test("loader v4: readLayerDir verifies the pages (instance match, completeness, overlap, one export moment = equal signatures, aliases, role grants) and shapes the layer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seclayer-"));
  const reply = (rows: Record<string, unknown>[], instance = "pod-x.example") => JSON.stringify({ instance, columns: [], rows, rowCount: rows.length, maxRows: 1000, truncated: false, elapsedMs: 1 });
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);
  const DUTY = "ORA_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM";
  write("objects-1.json", reply([{ OBJ_NAME: "PO_HEADERS_ALL", DATABASE_OBJECT_NAME: "PO_HEADERS_ALL", PK1_COLUMN_NAME: "po_header_id", PK2_COLUMN_NAME: null, PK3_COLUMN_NAME: null, PK4_COLUMN_NAME: null, PK5_COLUMN_NAME: null }]));
  write("objects-2.json", reply([{ OBJ_NAME: "ESS_REQUEST_HISTORY", DATABASE_OBJECT_NAME: "ESS_REQUEST_HISTORY", PK1_COLUMN_NAME: "requestid", PK2_COLUMN_NAME: null, PK3_COLUMN_NAME: null, PK4_COLUMN_NAME: null, PK5_COLUMN_NAME: null }]));
  write("privileges-1.json", reply([
    { OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA", GRANT_SIG: 21236060444, N_GRANTS: 4 }, { OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "read", GRANT_SIG: 99, N_GRANTS: 2 },
    { OBJ_NAME: "ESS_REQUEST_HISTORY", PRIVILEGE: "ESS_REQUEST_READ", GRANT_SIG: 7, N_GRANTS: 9 }]));
  write("u-1.json", reply([{ OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA", INSTANCE_TYPE: "GLOBAL", GRANT_SIG: 21236060444, N_GRANTS: 4 }]));
  write("duties-1.json", reply([
    { DUTY_ROLE: DUTY, OBJ_NAME: "ESS_REQUEST_HISTORY", PRIVILEGE: "ESS_REQUEST_READ", GRANT_SIG: 7, N_GRANTS: 9 },
    { DUTY_ROLE: `XXKD_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM_NEW`, OBJ_NAME: "ESS_REQUEST_HISTORY", PRIVILEGE: "ESS_REQUEST_READ", GRANT_SIG: 7, N_GRANTS: 9 }]));
  write("aliases-1.json", reply([{ DUTY_ROLE: "XXKD_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", SEEDED_ROLE: DUTY }]));
  write("role_grants-1.json", reply([{ ROLE_NAME: "ORA_PO_BUYER_JOB", OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA" }]));
  const layer = readLayerDir(dir, "pod-x.example", "FUSION_APPS_OBIA_BIEE_APPID");
  assert.deepEqual(layer.roleGrants, [{ role_name: "ORA_PO_BUYER_JOB", obj_name: "PO_HEADERS_ALL", privilege: "PO_VIEW_PO_DOC_ANALYSIS_DATA" }]);
  assert.deepEqual(layer.objects.map((x) => [x.obj_name, x.pk1_column]), [["PO_HEADERS_ALL", "PO_HEADER_ID"], ["ESS_REQUEST_HISTORY", "REQUESTID"]], "key columns upper-cased, page order kept");
  assert.deepEqual(layer.privileges[0], { obj_name: "PO_HEADERS_ALL", privilege: "PO_VIEW_PO_DOC_ANALYSIS_DATA", grant_sig: "21236060444", n_grants: 4 });
  assert.deepEqual(layer.u, [{ obj_name: "PO_HEADERS_ALL", privilege: "PO_VIEW_PO_DOC_ANALYSIS_DATA", instance_type: "GLOBAL", grant_sig: "21236060444", n_grants: 4 }]);
  assert.deepEqual(layer.aliases, [{ duty_role: "XXKD_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", seeded_role: DUTY }]);
  assert.deepEqual([layer.grantee, layer.privileges.length, layer.duties[0].duty_role], ["FUSION_APPS_OBIA_BIEE_APPID", 3, DUTY]);
  // the layer loads, twice, to the same counts (idempotent)
  const c1 = await db.security.replaceLayer("pod-x.example", "2026-10-05", layer, "2026-10-05T00:00:00Z");
  assert.deepEqual(await db.security.replaceLayer("pod-x.example", "2026-10-05", layer, "2026-10-05T00:00:00Z"), c1);
  assert.deepEqual(c1, { objects: 2, privileges: 3, u: 1, duties: 2, aliases: 1, roleGrants: 1 });
  assert.deepEqual(await db.security.roleGrants("pod-x.example", "PO_HEADERS_ALL", ["ORA_PO_BUYER_JOB"]), [{ role_name: "ORA_PO_BUYER_JOB", privilege: "PO_VIEW_PO_DOC_ANALYSIS_DATA" }]);
  // a role grant on a pair the privileges pages do not carry = two export moments
  write("role_grants-1.json", reply([{ ROLE_NAME: "ORA_PO_BUYER_JOB", OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_MANAGE_PO_DATA" }]));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /role grant ORA_PO_BUYER_JOB PO_HEADERS_ALL\/PO_MANAGE_PO_DATA is not among the granted pairs/);
  write("role_grants-1.json", reply([{ ROLE_NAME: "ORA_PO_BUYER_JOB", OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA" }]));
  assert.deepEqual((await db.security.grantedPairs("pod-x.example", "PO_HEADERS_ALL")).map((x) => [x.privilege, x.grant_sig]), [["PO_VIEW_PO_DOC_ANALYSIS_DATA", "21236060444"], ["read", "99"]]);
  assert.throws(() => readLayerDir(dir, "pod-y.example", "X"), /objects-1\.json was exported from pod-x\.example, not pod-y\.example — refusing to mix pods/);
  // a U pair whose signature differs from the privileges page = two export moments
  write("u-1.json", reply([{ OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA", INSTANCE_TYPE: "GLOBAL", GRANT_SIG: 5, N_GRANTS: 4 }]));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /u pair PO_HEADERS_ALL\/PO_VIEW_PO_DOC_ANALYSIS_DATA carries grant_sig 5, the privileges pages 21236060444/);
  write("u-1.json", reply([{ OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA", INSTANCE_TYPE: "GLOBAL", GRANT_SIG: 21236060444, N_GRANTS: 4 }]));
  // an alias whose twin is no duty of the duty pages
  write("aliases-1.json", reply([{ DUTY_ROLE: "XXKD_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM_NEW", SEEDED_ROLE: "ORA_FBI_NOPE_DUTY_HCM" }]));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /alias XXKD_FBI_PAYROLL_FLOWS_TRANSACTION_ANALYSIS_DUTY_HCM_NEW -> ORA_FBI_NOPE_DUTY_HCM does not link two different duties/);
  write("aliases-1.json", reply([]));
  assert.deepEqual(readLayerDir(dir, "pod-x.example", "X").aliases, [], "an empty alias page is a valid export");
  // a privileges page without the signature columns = the pre-v3 export
  const goodPrivileges = fs.readFileSync(path.join(dir, "privileges-1.json"), "utf8");
  write("privileges-1.json", reply([{ OBJ_NAME: "PO_HEADERS_ALL", PRIVILEGE: "PO_VIEW_PO_DOC_ANALYSIS_DATA" }]));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /privileges-1\.json: column GRANT_SIG missing — export with the documented SQL/);
  write("privileges-1.json", goodPrivileges);
  fs.rmSync(path.join(dir, "aliases-1.json"));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /no aliases-<n>\.json page/);
  write("aliases-1.json", reply([]));
  fs.rmSync(path.join(dir, "role_grants-1.json"));
  assert.throws(() => readLayerDir(dir, "pod-x.example", "X"), /no role_grants-<n>\.json page/, "a v3 export (no role grants) is refused");
  fs.rmSync(dir, { recursive: true, force: true });
});

after(async () => {
  await db.close();
  await dropScratchDbs();
});
