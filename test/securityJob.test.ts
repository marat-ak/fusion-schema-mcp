/**
 * The facts JOB itself — scripts/pipeline/p5_security.sql with the REAL p5_security_rules.json and a
 * SYNTHETIC Oracle policy extract (test/fixtures/datasec-policies.csv: the generic FUN_USER_ROLE_DATA_ASGNMNTS
 * shapes the job parses under Oracle's seeded instance-set names, no row of any pod; read with a CSV parser
 * in place of the job's psql \copy, plus one synthetic unparsable set) — on a synthetic release dictionary +
 * a synthetic `work` (clear_sql / r_tables / f_joins) in a throwaway Postgres database. Nothing of any
 * customer pod is read (ddl_version 9: the pod data-security export is gone from the release and the image). The job is Postgres-only by
 * nature (it runs in the build database), so under CATALOG_DB=sqlite this suite is skipped, not faked.
 * Fixture objects = spec 2026-09-29 §3 + the exclusion / chain / Oracle-policy cases the rules name.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parse } from "csv-parse/sync";
import { openTempCatalog, dropScratchDbs, PROVIDER } from "./fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIPE = path.join(HERE, "..", "scripts", "pipeline");

if (PROVIDER !== "postgres") {
  test("security job (p5_security.sql) — runs on the Postgres build database only", { skip: "CATALOG_DB=sqlite" }, () => {});
} else {
  const { db, dir: url } = await openTempCatalog("secjob-", false);
  const V = db.meta.activeVersion();
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  const T = (name: string, type = "TABLE", view_text: string | null = null) => ({ name, schema: "FUSION", type, module: name.split("_")[0], remarks: null, view_text });
  const C = (t: string, c: string, nullable = 0, remarks: string | null = null, ordinal = 1) => [t, c, "NUMBER", 18, nullable, remarks, ordinal];
  // every reference / evidence object the rules name must exist (the job fails loudly otherwise)
  const REFS: [string, string][] = [
    ["FUN_ALL_BUSINESS_UNITS_V", "BU_ID"], ["FUN_BU_PERF_V", "BU_ID"], ["GL_LEDGERS", "LEDGER_ID"], ["GL_LEDGERS_PUBLIC_V", "LEDGER_ID"],
    ["FA_BOOK_CONTROLS", "BOOK_TYPE_CODE"], ["INV_ORG_PARAMETERS", "ORGANIZATION_ID"], ["INV_ORG_PARAMETERS_V", "ORGANIZATION_ID"],
    ["INV_ORGANIZATION_DEFINITIONS_V", "ORGANIZATION_ID"], ["CST_COST_ORGS_V", "COST_ORG_ID"], ["RCS_MFG_PARAMETERS", "ORGANIZATION_ID"],
    ["RCS_ORG_DEFINITIONS_LW_V", "ORGANIZATION_ID"], ["HR_ORG_UNIT_CLASSIFICATIONS_F", "ORGANIZATION_ID"], ["HR_ORGANIZATION_V", "ORGANIZATION_ID"],
    ["FUN_INTERCO_ORGANIZATIONS", "INTERCO_ORG_ID"], ["XCC_CONTROL_BUDGETS", "CONTROL_BUDGET_ID"], ["GL_ACCESS_SETS", "ACCESS_SET_ID"],
    ["GL_ACCESS_SET_LEDGERS", "ACCESS_SET_ID"], ["FND_SETID_SETS_VL", "SET_ID"], ["FUN_TRX_HEADERS", "INITIATOR_ID"], ["FUN_TRX_HEADERS", "RECIPIENT_ID"],
    ["FUN_TRX_BATCHES", "INITIATOR_ID"],
    // the curated overrides' columns (set / none)
    ["OSS_COVERAGE_DISCOUNTS", "ORGANIZATION_ID"], ["ACA_QI_PR_V", "ORGANIZATION_ID"], ["HZ_IMP_GROUP_MEMBERS", "ORGANIZATION_ID"],
    // Oracle policy columns: FA_BOOK_CONTROLS is secured on its id (FABOOKCONTROLSSTD), not by name
    ["FA_BOOK_CONTROLS", "BOOK_CONTROL_ID"],
    ["XLE_ENTITY_PROFILES", "LEGAL_ENTITY_ID"], ["CMK_COLLAB_DOCS_B", "DOCUMENT_ID"], ["ZZ_POLICY_T", "ORG_ID"],
    ["XLA_TRANSACTION_ENTITIES", "SECURITY_ID_INT_1"], ["XLA_TRANSACTION_ENTITIES", "SECURITY_ID_CHAR_1"], ["XLA_TRANSACTION_ENTITIES", "LEDGER_ID"],
  ];
  // the ORGANIZATION_ID chain cases (plan 2026-09-30 R1-R6 + the module family): transitive vote,
  // tie-break, lineage, own id space, non-org partners, HCM lineage, set / none overrides, unused ⇒
  // disallowed, used ⇒ gate, module family (code evidence / judgment) ahead of the votes
  const CHAIN = [
    "ZX_JRNL_ACCOUNTS_EXTRACT_V", "ZX_AR_LOC_ACCOUNTS_EXTRACT_V", "WIS_WD_OPERATION_MATERIALS", "ENQ_ISSUES_VL", "ENQ_ISSUES_B",
    "FFS_ORGANIZATION_TL", "FFS_SCHEDULE", "MKT_CM_CAMPAIGNS", "HTS_SCHED_UNITS_DEPARTMENT_V", "JTF_RS_RESOURCE_ORG_BU", "XYZ_ORG_LINKS",
    "PJB_XLA_WAREHOUSE_ITEM_V", "WIE_WO_OPERATIONS_B", "MNT_WORK_REQUIREMENTS_B", "QA_IP_EVENTS", "SMO_COMMANDS", "CML_RECEIPTS_VL", "CML_RECEIPTS_B",
  ];
  // the sensitive tables of p5_security_rules.json `sensitive` with their key column (the bank accounts with the MASKED_* twins)
  const SENSITIVE: [string, string][] = [
    ["PER_NATIONAL_IDENTIFIERS", "NATIONAL_IDENTIFIER_ID"], ["PER_PASSPORTS", "PASSPORT_ID"], ["PER_VISAS_PERMITS_F", "VISA_PERMIT_ID"],
    ["PER_DRIVERS_LICENSES", "DRIVERS_LICENSE_ID"], ["CMP_SALARY", "SALARY_ID"], ["POZ_SUPPLIERS_PII", "VENDOR_ID"], ["POZ_SUPPLIER_SITES_PII", "VENDOR_SITE_ID"],
    ["POZ_SUP_REG_PII", "SUPPLIER_REG_ID"], ["POZ_SUPP_REQUESTS_PII", "SUPP_REQUEST_PII_ID"], ["IBY_EXT_BANK_ACCOUNTS", "EXT_BANK_ACCOUNT_ID"],
    ["IBY_ACCOUNT_OWNERS", "ACCOUNT_OWNER_ID"],
  ];
  // the reference families (ddl_version 10): members by name pattern AND reference-shaped columns, and look-alikes that
  // are not (a lookup without LOOKUP_CODE, a period table with a business key, a translation carrying a business id)
  const REFDATA: [string, string[]][] = [
    ["FND_LOOKUPS", ["LOOKUP_TYPE", "LOOKUP_CODE", "MEANING", "DESCRIPTION"]], ["AP_LOOKUP_CODES", ["LOOKUP_TYPE", "LOOKUP_CODE", "DISPLAYED_FIELD"]],
    ["ZZ_LOOKUPS", ["LOOKUP_TYPE", "MEANING"]],
    ["GL_PERIODS", ["PERIOD_NAME", "PERIOD_SET_NAME", "START_DATE", "END_DATE", "CREATION_DATE"]], ["PJC_PERIODS", ["PROJECT_ID", "START_DATE"]],
    ["ZZ_CAL", ["CAL_CODE", "CREATION_DATE"]],
    ["GL_DAILY_RATES", ["FROM_CURRENCY", "TO_CURRENCY", "CONVERSION_TYPE"]], ["FND_CURRENCIES_TL", ["CURRENCY_CODE", "LANGUAGE", "SOURCE_LANG"]],
    ["FND_TERRITORIES_VL", ["TERRITORY_CODE", "TERRITORY_SHORT_NAME"]], ["HZ_GEOGRAPHIES", ["GEOGRAPHY_ID", "GEOGRAPHY_TYPE", "GEOGRAPHY_CODE", "GEOGRAPHY_NAME", "COUNTRY_CODE"]],
    ["XX_THINGS_B", ["THING_ID"]], ["XX_THINGS_TL", ["THING_ID", "LANGUAGE", "SOURCE_LANG", "NAME"]], ["XX_THINGS_VL", ["THING_ID", "NAME"]],
    ["XX_BIZ_TL", ["BIZ_ID", "PARTY_ID", "LANGUAGE", "SOURCE_LANG"]], ["XX_LONE_TL", ["LONE_ID", "LANGUAGE", "SOURCE_LANG"]],
  ];
  const OBJECTS = [
    T("AP_INVOICES_ALL"), T("GL_JE_HEADERS"), T("FA_BOOKS"), T("INV_ONHAND_QUANTITIES_DETAIL"), T("PER_DEPARTMENTS"), T("FFS_ORGANIZATION"),
    T("PO_HEADERS_ALL"), T("DOO_HEADERS_ALL"), T("EGP_SYSTEM_ITEMS_B"), T("WIE_WORK_ORDERS_B"), T("AP_INVOICES_ALL_"), T("MLOG$_AP_INVOICES_ALL"),
    T("AR_TRX_HEADER_GT"), T("OKC_CURRENT_USER_BU_V", "VIEW", "select org_id from fun_user_role_data_asgnmnts where user_guid = fnd_global.user_guid"),
    T("FND_GRANTS"), T("FUN_USER_ROLE_DATA_ASGNMNTS"), T("AR_XLA_LINES_EXTRACT"), T("CST_X_TXNS"), T("JTF_RS_GROUP_MEMBERS"),
    // the (area, entity) keys of the curated area map name dictionary tables (the job fails otherwise)
    T("ZMM_NOTES"),
    // the sensitive side tables the rules name (the job fails when one is not in the dictionary)
    ...SENSITIVE.map(([t]) => T(t)),
    ...CHAIN.map((t) => T(t, t.endsWith("_V") || t.endsWith("_VL") ? "VIEW" : "TABLE")),
    ...[...new Set(REFS.map(([t]) => t))].map((t) => T(t, t.endsWith("_V") ? "VIEW" : "TABLE")),
    ...REFDATA.map(([t]) => T(t, t.endsWith("_VL") ? "VIEW" : "TABLE")),
  ];
  const COLUMNS = [
    C("AP_INVOICES_ALL", "INVOICE_ID"), C("AP_INVOICES_ALL", "ORG_ID", 0, "Business unit identifier.", 2),
    C("AP_INVOICES_ALL", "SET_OF_BOOKS_ID", 0, null, 3), C("AP_INVOICES_ALL", "EXPENDITURE_ORGANIZATION_ID", 1, null, 4),
    C("GL_JE_HEADERS", "LEDGER_ID"), C("FA_BOOKS", "BOOK_TYPE_CODE"), C("INV_ONHAND_QUANTITIES_DETAIL", "ORGANIZATION_ID"),
    C("PER_DEPARTMENTS", "ORGANIZATION_ID"), C("PER_DEPARTMENTS", "BUSINESS_GROUP_ID", 0, null, 2), C("FFS_ORGANIZATION", "ORGANIZATION_ID"),
    C("PO_HEADERS_ALL", "PRC_BU_ID", 0, null, 1), C("PO_HEADERS_ALL", "REQ_BU_ID", 1, null, 2), C("PO_HEADERS_ALL", "BILLTO_BU_ID", 1, null, 3),
    C("PO_HEADERS_ALL", "SOLDTO_BU_ID", 1, null, 4), C("DOO_HEADERS_ALL", "ORG_ID"), C("EGP_SYSTEM_ITEMS_B", "ORGANIZATION_ID"),
    C("WIE_WORK_ORDERS_B", "ORGANIZATION_ID"), C("AP_INVOICES_ALL_", "ORG_ID"), C("MLOG$_AP_INVOICES_ALL", "ORG_ID"),
    C("AR_TRX_HEADER_GT", "SET_OF_BOOKS_ID", 0, "Oracle internal use only"), C("OKC_CURRENT_USER_BU_V", "ORG_ID"),
    C("FUN_USER_ROLE_DATA_ASGNMNTS", "ORG_ID"), C("FUN_USER_ROLE_DATA_ASGNMNTS", "LEDGER_ID", 1, null, 2),
    // the rest of URDA the job reads (every context column + the generic DATASEC / collaboration columns)
    ...["BOOK_ID", "SET_ID", "INV_ORGANIZATION_ID", "CST_ORGANIZATION_ID", "ITM_ORGANIZATION_ID", "ACCESS_SET_ID", "CONTROL_BUDGET_ID",
        "INTERCO_ORG_ID", "PRJ_ORGANIZATION_ID", "MFG_ORGANIZATION_ID", "DATASEC_CONTEXT_TYPE_CODE", "DATASEC_CONTEXT_VALUE1",
        "DATASEC_CONTEXT_VALUE2", "COLLABORATION_DOC_ID"].map((c, i) => C("FUN_USER_ROLE_DATA_ASGNMNTS", c, 1, null, 3 + i)),
    C("AR_XLA_LINES_EXTRACT", "ORG_ID"), C("CST_X_TXNS", "INVENTORY_ORG_ID"), C("JTF_RS_GROUP_MEMBERS", "GROUP_ID"),
    ...CHAIN.map((t) => C(t, "ORGANIZATION_ID")),
    C("JTF_RS_RESOURCE_ORG_BU", "BU_ID", 0, null, 2), C("HZ_IMP_GROUP_MEMBERS", "ORG_ID", 0, null, 2),
    C("PJB_XLA_WAREHOUSE_ITEM_V", "WAREHOUSE_BU_ID", 0, null, 2),
    ...REFS.map(([t, c]) => C(t, c)),
    ...SENSITIVE.map(([t, c]) => C(t, c)),
    C("IBY_EXT_BANK_ACCOUNTS", "BANK_ACCOUNT_NUM", 1, null, 2), C("IBY_EXT_BANK_ACCOUNTS", "MASKED_BANK_ACCOUNT_NUM", 1, null, 3),
    C("IBY_EXT_BANK_ACCOUNTS", "IBAN", 1, null, 4), C("IBY_EXT_BANK_ACCOUNTS", "MASKED_IBAN", 1, null, 5),
    ...REFDATA.flatMap(([t, cols]) => cols.map((c, i) => C(t, c, 0, null, i + 1))),
  ];

  const grantBlock = (fn: string, obj: string, set: string, pred: string) =>
    `EXISTS (SELECT NULL FROM fnd_grants gnt WHERE exists (SELECT null FROM fnd_session_role_sets WHERE session_role_set_key = fnd_global.session_role_set_key and role_guid = gnt.grantee_key) ` +
    `AND exists (select null from fnd_compiled_menu_functions cmf where cmf.function_id = ${fn} and cmf.menu_id = gnt.menu_id) AND gnt.object_id = ${obj} ` +
    `AND gnt.grant_type = 'ALLOW' AND gnt.instance_type = 'SET' AND (gnt.instance_set_id = ${set} AND ${pred}))`;
  const STMTS: { h: string; source: string; text: string; tables: string[] }[] = [
    { h: "s-gl", source: "otbi", tables: ["GL_JE_HEADERS", "GL_LEDGERS", "FND_GRANTS", "FUN_USER_ROLE_DATA_ASGNMNTS"],
      text: "SELECT h.NAME FROM GL_JE_HEADERS h, GL_LEDGERS GlLedgers WHERE h.LEDGER_ID = GlLedgers.LEDGER_ID AND " +
        grantBlock("300000000012225", "300000000008587", "300000118326121",
          "GlLedgers.LEDGER_ID IN (SELECT LEDGER_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG <> 'N')") },
    { h: "s-doo", source: "otbi", tables: ["DOO_HEADERS_ALL", "FUN_ALL_BUSINESS_UNITS_V", "FND_GRANTS", "FUN_USER_ROLE_DATA_ASGNMNTS"],
      text: "SELECT d.ORDER_NUMBER FROM DOO_HEADERS_ALL d, FUN_ALL_BUSINESS_UNITS_V BU WHERE d.ORG_ID = BU.BU_ID AND " +
        grantBlock("300000000012367", "300000000008651", "300000118327110",
          "BU.BU_ID IN (SELECT ORG_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG!='N')") },
    // a custom BIP report joining the URDA table is not Oracle precedent
    { h: "s-bip", source: "bip-report", tables: ["AP_INVOICES_ALL", "FUN_USER_ROLE_DATA_ASGNMNTS"],
      text: "SELECT 1 FROM AP_INVOICES_ALL a WHERE a.ORG_ID IN (SELECT ORG_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS)" },
    { h: "s-ap", source: "bip-report", tables: ["AP_INVOICES_ALL", "FUN_ALL_BUSINESS_UNITS_V"], text: "SELECT 1 FROM AP_INVOICES_ALL a, FUN_ALL_BUSINESS_UNITS_V b WHERE a.ORG_ID = b.BU_ID" },
    // chain statements (the SQL text is not re-parsed by the job: the joins below are the parse facts)
    { h: "s-zx1", source: "view", tables: ["ZX_JRNL_ACCOUNTS_EXTRACT_V", "AR_XLA_LINES_EXTRACT"], text: "x" },
    { h: "s-zx2", source: "view", tables: ["ZX_AR_LOC_ACCOUNTS_EXTRACT_V", "ZX_JRNL_ACCOUNTS_EXTRACT_V"], text: "x" },
    { h: "s-wis1", source: "bip-report", tables: ["WIS_WD_OPERATION_MATERIALS", "CST_X_TXNS"], text: "x" },
    { h: "s-wis2", source: "bip-report", tables: ["WIS_WD_OPERATION_MATERIALS", "WIE_WORK_ORDERS_B"], text: "x" },
    { h: "s-enq1", source: "bip-report", tables: ["ENQ_ISSUES_VL", "INV_ORGANIZATION_DEFINITIONS_V"], text: "x" },
    { h: "s-enq2", source: "bip-report", tables: ["ENQ_ISSUES_VL", "INV_ORGANIZATION_DEFINITIONS_V"], text: "x" },
    { h: "s-mkt", source: "otbi", tables: ["MKT_CM_CAMPAIGNS", "JTF_RS_GROUP_MEMBERS"], text: "x" },
    { h: "s-jtf", source: "otbi", tables: ["JTF_RS_RESOURCE_ORG_BU", "JTF_RS_GROUP_MEMBERS"], text: "x" },
    { h: "s-oss", source: "otbi", tables: ["OSS_COVERAGE_DISCOUNTS"], text: "x" },
    { h: "s-hz", source: "bip-report", tables: ["HZ_IMP_GROUP_MEMBERS"], text: "x" },
    { h: "s-xyz", source: "bip-report", tables: ["XYZ_ORG_LINKS"], text: "x" },
    // Oracle policy / module family cases: each column's corpus vote says the OTHER org context
    { h: "s-rcs", source: "bip-report", tables: ["RCS_MFG_PARAMETERS", "INV_ONHAND_QUANTITIES_DETAIL"], text: "x" },
    { h: "s-wieop", source: "bip-report", tables: ["WIE_WO_OPERATIONS_B", "INV_ONHAND_QUANTITIES_DETAIL"], text: "x" },
    { h: "s-mnt", source: "bip-report", tables: ["MNT_WORK_REQUIREMENTS_B", "WIE_WO_OPERATIONS_B"], text: "x" },
    { h: "s-smo1", source: "bip-report", tables: ["SMO_COMMANDS", "CST_X_TXNS"], text: "x" },
    { h: "s-smo2", source: "bip-report", tables: ["SMO_COMMANDS", "WIE_WORK_ORDERS_B"], text: "x" },
    { h: "s-cml1", source: "bip-report", tables: ["CML_RECEIPTS_VL", "INV_ORGANIZATION_DEFINITIONS_V"], text: "x" },
    { h: "s-cml2", source: "bip-report", tables: ["CML_RECEIPTS_VL", "INV_ORGANIZATION_DEFINITIONS_V"], text: "x" },
  ];
  const JOINS: [string, string, string, string, string, string][] = [
    ["s-ap", "AP_INVOICES_ALL", "ORG_ID", "FUN_ALL_BUSINESS_UNITS_V", "BU_ID", "inner"],
    ["s-zx1", "ZX_JRNL_ACCOUNTS_EXTRACT_V", "ORGANIZATION_ID", "AR_XLA_LINES_EXTRACT", "ORG_ID", "WHERE"],
    ["s-zx2", "ZX_AR_LOC_ACCOUNTS_EXTRACT_V", "ORGANIZATION_ID", "ZX_JRNL_ACCOUNTS_EXTRACT_V", "ORGANIZATION_ID", "WHERE"],
    ["s-wis1", "WIS_WD_OPERATION_MATERIALS", "ORGANIZATION_ID", "CST_X_TXNS", "INVENTORY_ORG_ID", "WHERE"],
    ["s-wis2", "WIS_WD_OPERATION_MATERIALS", "ORGANIZATION_ID", "WIE_WORK_ORDERS_B", "ORGANIZATION_ID", "WHERE"],
    ["s-enq1", "INV_ORGANIZATION_DEFINITIONS_V", "ORGANIZATION_ID", "ENQ_ISSUES_VL", "ORGANIZATION_ID", "WHERE"],
    ["s-enq2", "ENQ_ISSUES_VL", "ORGANIZATION_ID", "INV_ORGANIZATION_DEFINITIONS_V", "ORGANIZATION_ID", "WHERE"],
    ["s-mkt", "MKT_CM_CAMPAIGNS", "ORGANIZATION_ID", "JTF_RS_GROUP_MEMBERS", "GROUP_ID", "SEMI"],
    ["s-jtf", "JTF_RS_RESOURCE_ORG_BU", "ORGANIZATION_ID", "JTF_RS_GROUP_MEMBERS", "GROUP_ID", "WHERE"],
    ["s-rcs", "RCS_MFG_PARAMETERS", "ORGANIZATION_ID", "INV_ONHAND_QUANTITIES_DETAIL", "ORGANIZATION_ID", "WHERE"],
    ["s-wieop", "WIE_WO_OPERATIONS_B", "ORGANIZATION_ID", "INV_ONHAND_QUANTITIES_DETAIL", "ORGANIZATION_ID", "WHERE"],
    ["s-mnt", "MNT_WORK_REQUIREMENTS_B", "ORGANIZATION_ID", "WIE_WO_OPERATIONS_B", "ORGANIZATION_ID", "WHERE"],
    ["s-smo1", "SMO_COMMANDS", "ORGANIZATION_ID", "CST_X_TXNS", "INVENTORY_ORG_ID", "WHERE"],
    ["s-smo2", "SMO_COMMANDS", "ORGANIZATION_ID", "WIE_WORK_ORDERS_B", "ORGANIZATION_ID", "WHERE"],
    ["s-cml1", "CML_RECEIPTS_VL", "ORGANIZATION_ID", "INV_ORGANIZATION_DEFINITIONS_V", "ORGANIZATION_ID", "WHERE"],
    ["s-cml2", "INV_ORGANIZATION_DEFINITIONS_V", "ORGANIZATION_ID", "CML_RECEIPTS_VL", "ORGANIZATION_ID", "WHERE"],
  ];
  // view pass-through lineage (work.view_column_remarks): view column <- base column
  const LINEAGE: [string, string, string, string][] = [
    ["ENQ_ISSUES_VL", "ORGANIZATION_ID", "ENQ_ISSUES_B", "ORGANIZATION_ID"],
    ["CML_RECEIPTS_VL", "ORGANIZATION_ID", "CML_RECEIPTS_B", "ORGANIZATION_ID"],
    ["HTS_SCHED_UNITS_DEPARTMENT_V", "ORGANIZATION_ID", "PER_DEPARTMENTS", "ORGANIZATION_ID"],
    // a RENAMED alias never feeds its context back to the base column (EGP stays item org)
    ["PJB_XLA_WAREHOUSE_ITEM_V", "WAREHOUSE_BU_ID", "EGP_SYSTEM_ITEMS_B", "ORGANIZATION_ID"],
  ];

  await db.schema.bulkLoad("tables", OBJECTS);
  await db.schema.bulkLoad("columns", COLUMNS);
  await db.schema.bulkLoad("pkeys", [["FFS_ORGANIZATION", "ORGANIZATION_ID", 1], ["XX_THINGS_TL", "THING_ID", 1], ["XX_THINGS_TL", "LANGUAGE", 2],
    ["XX_BIZ_TL", "BIZ_ID", 1], ["XX_BIZ_TL", "LANGUAGE", 2], ["XX_LONE_TL", "LONE_ID", 1], ["XX_LONE_TL", "LANGUAGE", 2]]);
  await db.schema.bulkLoad("fkeys", [
    ["INV_ONHAND_QUANTITIES_DETAIL", "INV_ORG_PARAMETERS", "ORGANIZATION_ID", 1, "IOQD_FK1"],
    ["WIE_WORK_ORDERS_B", "RCS_MFG_PARAMETERS", "ORGANIZATION_ID", 1, "WWO_FK1"],
    ["FFS_ORGANIZATION_TL", "FFS_ORGANIZATION", "ORGANIZATION_ID", 1, "FFS_ORGANIZATION_TL_FK_1"],
  ]);
  await sql.unsafe(`CREATE SCHEMA work;
    CREATE TABLE work.clear_sql (sql_hash text PRIMARY KEY, source text, sql_text text);
    CREATE TABLE work.r_tables (sql_hash text, table_name text, is_cte boolean);
    CREATE TABLE work.f_joins (sql_hash text, from_t text, from_c text, to_t text, to_c text, join_type text);
    CREATE TABLE work.view_column_remarks (view_name text, column_name text, kind text, src_table text, src_col text);
    CREATE TABLE work.relationships (from_table text, to_table text, source text);
    CREATE TABLE work.otbi_lineage (db_object text);
    CREATE TABLE work.otbi_column (db_refs jsonb);`);
  for (const s of STMTS) {
    await sql`INSERT INTO work.clear_sql VALUES (${s.h}, ${s.source}, ${s.text})`;
    for (const t of s.tables) await sql`INSERT INTO work.r_tables VALUES (${s.h}, ${t}, false)`;
  }
  for (const j of JOINS) await sql`INSERT INTO work.f_joins VALUES (${j[0]}, ${j[1]}, ${j[2]}, ${j[3]}, ${j[4]}, ${j[5]})`;
  for (const l of LINEAGE) await sql`INSERT INTO work.view_column_remarks VALUES (${l[0]}, ${l[1]}, 'passthrough', ${l[2]}, ${l[3]})`;

  // the synthetic policy extract, read with a real CSV parser — what the job's `\copy sec_pol_raw` loads —
  // plus one synthetic set of a shape the job cannot map
  const POLICIES = parse(fs.readFileSync(path.join(HERE, "fixtures", "datasec-policies.csv"), "utf8"), { from_line: 2 }) as string[][];
  const UNPARSABLE = ["ZZ_POLICY_T", "ZZ_POLICY_T", "ZZPOLICYTODD",
    "&TABLE_ALIAS.ORG_ID = (SELECT MAX(ORG_ID) FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID)"];
  const lit = (s: string) => (s === "" ? "NULL" : `'${s.replaceAll("'", "''")}'`);
  const loadPolicies = `INSERT INTO sec_pol_raw VALUES ${[...POLICIES, UNPARSABLE].map((r) => `(${r.map(lit).join(", ")})`).join(",\n")};`;
  const RULES = JSON.parse(fs.readFileSync(path.join(PIPE, "p5_security_rules.json"), "utf8"));

  // the job, exactly as p5_security.sh stages it (psql meta-commands are the runner's, not SQL; the
  // \copy of the extract is the INSERT above)
  const rules = fs.readFileSync(path.join(PIPE, "p5_security_rules.json"), "utf8");
  const job = fs.readFileSync(path.join(PIPE, "p5_security.sql"), "utf8")
    .replaceAll("{{V}}", V)
    .split("\n").map((l) => (l === "{{RULES}}" ? rules : l.startsWith("\\copy sec_pol_raw ") ? loadPolicies : l))
    .filter((l) => !l.startsWith("\\")).join("\n");
  await sql.unsafe(job);
  const meta = async () => Object.fromEntries((await sql.unsafe(`SELECT k, v FROM ${V}.sec_meta`) as any[]).map((r) => [r.k, r.v]));
  const reasonOf = async (t: string, c: string) =>
    ((await sql.unsafe(`SELECT reason FROM ${V}.table_security WHERE table_name = $1 AND column_name = $2`, [t, c])) as any[])[0]?.reason as string;

  const rows = async (t: string) => (await sql.unsafe(
    `SELECT column_name, context, is_primary, confidence, evidence FROM ${V}.table_security WHERE table_name = $1 ORDER BY is_primary DESC, column_name COLLATE "C", context COLLATE "C"`, [t])) as any[];
  const brief = async (t: string) => (await rows(t)).map((r) => [r.column_name, r.context, r.is_primary, r.confidence]);

  test("job: AP_INVOICES_ALL — BU primary + ledger + project org, all detected; custom BIP is no precedent", async () => {
    assert.deepEqual(await brief("AP_INVOICES_ALL"), [
      ["ORG_ID", "BU", 1, "name"],
      ["EXPENDITURE_ORGANIZATION_ID", "PRJ_ORG", 0, "name"],
      ["SET_OF_BOOKS_ID", "LEDGER", 0, "name"],
    ]);
    assert.equal((await rows("AP_INVOICES_ALL"))[0].evidence, 1, "one statement joins ORG_ID to the BU reference view");
  });

  test("job: GL_JE_HEADERS ledger + DOO BU carry Oracle precedent; the area map ships as NAMES with its (area, entity) keys; no pod export copy exists", async () => {
    assert.deepEqual(await brief("GL_JE_HEADERS"), [["LEDGER_ID", "LEDGER", 1, "oracle_precedent"]]);
    assert.deepEqual(await brief("DOO_HEADERS_ALL"), [["ORG_ID", "BU", 1, "oracle_precedent"]]);
    // ddl_version 9: the seed export copies are gone from the release schema
    const tabs = (await sql.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('sec_object', 'sec_privilege')`, [V]) as any[]);
    assert.equal(tabs.length, 0, "no sec_object / sec_privilege in a ddl_version 9 release");
    const area = await sql.unsafe(`SELECT area_or_product, ordinal, obj_name, privilege, source, instance_scope, entity_table FROM ${V}.sec_area_privilege WHERE source = 'trace' ORDER BY 1`) as any[];
    assert.deepEqual(area.map((r) => [r.area_or_product, r.ordinal, r.obj_name, r.privilege, r.source, r.instance_scope, r.entity_table]), [
      ["AP", 1, "FUN_ALL_BUSINESS_UNITS_V", "AP_REPORT_PAYABLES_DATA", "trace", "*", null],
      ["Payables", 1, "FUN_ALL_BUSINESS_UNITS_V", "AP_REPORT_PAYABLES_DATA", "trace", "*", "FUN_BU_PERF_V"]], "the Payables row as sec_trace.py loaded it from the trace (entity = the table carrying the grant block)");
    const bySrc = Object.fromEntries((await sql.unsafe(`SELECT source, count(*) n FROM ${V}.sec_area_privilege GROUP BY 1`) as any[]).map((r) => [r.source, Number(r.n)]));
    assert.deepEqual(bySrc, { trace: 2, inferred: RULES.areaPrivileges.rows.length - 2 }, "the 35 demo-pod areas ship as inferred rows (ddl_version 8: never nameless)");
    const nameless = (await sql.unsafe(`SELECT count(*) n FROM ${V}.sec_area_privilege WHERE obj_name IS NULL OR privilege IS NULL OR coalesce(instance_scope, '') = ''`) as any[])[0];
    assert.equal(Number(nameless.n), 0, "no pending / nameless / unscoped row exists");
    const gl = await sql.unsafe(`SELECT obj_name, privilege, instance_scope, entity_table FROM ${V}.sec_area_privilege WHERE area_or_product = 'General Ledger - Journals Real Time'`) as any[];
    assert.deepEqual(gl.map((r) => [r.obj_name, r.privilege, r.instance_scope, r.entity_table]), [["GL_LEDGERS", "GL_REPORT_GENERAL_LEDGER_DATA", "*", "GL_LEDGERS"]]);
    // the area rows carry their (area, entity) key where the evidence names a dictionary entity; the AP PRODUCT row stays product-level
    const keyed = (await sql.unsafe(`SELECT count(*) FILTER (WHERE entity_table IS NOT NULL) k, count(*) n FROM ${V}.sec_area_privilege`) as any[])[0];
    const withEntity = (RULES.areaPrivileges.rows as any[]).filter((r) => r.entity).length;
    assert.ok(withEntity >= RULES.areaPrivileges.rows.length - 2, "every area row but the product row and an entity outside the dictionary is keyed");
    assert.deepEqual([Number(keyed.k), Number(keyed.n)], [withEntity, RULES.areaPrivileges.rows.length]);
    // nothing numeric masquerades as a name anywhere in the shipped security tables
    const ids = (await sql.unsafe(`SELECT count(*) n FROM (SELECT obj_name n FROM ${V}.sec_area_privilege UNION ALL SELECT privilege FROM ${V}.sec_area_privilege) x WHERE x.n ~ '^[0-9]+$'`) as any[])[0];
    assert.equal(Number(ids.n), 0);
  });

  test("job: FA_BOOKS book, INV org via FK, item org on EGP (a renamed view alias never feeds back), mfg org on WIE", async () => {
    assert.deepEqual(await brief("FA_BOOKS"), [["BOOK_TYPE_CODE", "BOOK", 1, "name"]]);
    assert.deepEqual(await brief("INV_ONHAND_QUANTITIES_DETAIL"), [["ORGANIZATION_ID", "INV_ORG", 1, "fk"]]);
    assert.deepEqual(await brief("EGP_SYSTEM_ITEMS_B"), [["ORGANIZATION_ID", "ITM_ORG", 1, "prefix"]]);
    assert.deepEqual(await brief("WIE_WORK_ORDERS_B"), [["ORGANIZATION_ID", "MFG_ORG", 1, "fk"]]);
  });

  test("job ORACLE POLICY: the context Oracle filters a column by overrides every heuristic; one set per module ⇒ the standard set", async () => {
    // RCS_MFG_PARAMETERS: its only corpus partner is an inventory org (the vote says INV_ORG) — Oracle says MFG
    assert.deepEqual(await brief("RCS_MFG_PARAMETERS"), [["ORGANIZATION_ID", "MFG_ORG", 1, "oracle_policy"]]);
    assert.equal(await reasonOf("RCS_MFG_PARAMETERS", "ORGANIZATION_ID"),
      "Oracle data-security policy RCS_MFG_PARAMETERS: instance set(s) RCSMFGPARAMETERSSTD filter ORGANIZATION_ID by URDA.MFG_ORGANIZATION_ID");
    // INV_ORG_PARAMETERS: ENQ / MNT / PWA / STD by INV_ORGANIZATION_ID, MFG by MFG_ORGANIZATION_ID — the standard set decides
    assert.deepEqual((await rows("INV_ORG_PARAMETERS")).map((r) => [r.column_name, r.context, r.confidence, r.evidence]), [["ORGANIZATION_ID", "INV_ORG", "oracle_policy", 4]]);
    assert.match(await reasonOf("INV_ORG_PARAMETERS", "ORGANIZATION_ID"),
      /instance set\(s\) INVORGPARAMETERSENQ, INVORGPARAMETERSMNT, INVORGPARAMETERSPWA, INVORGPARAMETERSSTD filter ORGANIZATION_ID by URDA\.INV_ORGANIZATION_ID .*; per module also INVORGPARAMETERSMFG by URDA\.MFG_ORGANIZATION_ID - the standard set decides$/);
    // a column no name rule knows (the book id) is secured; the name-rule column stays (every column applies)
    assert.deepEqual(await brief("FA_BOOK_CONTROLS"), [
      ["BOOK_CONTROL_ID", "BOOK", 1, "oracle_policy"], ["BOOK_TYPE_CODE", "BOOK", 0, "name"]]);
    // name-rule columns Oracle secures become oracle_policy; the rest keep their rule
    assert.deepEqual(await brief("FUN_ALL_BUSINESS_UNITS_V"), [["BU_ID", "BU", 1, "oracle_policy"]]);
    assert.deepEqual(await brief("GL_LEDGERS"), [["LEDGER_ID", "LEDGER", 1, "oracle_policy"]]);
    // one application-conditioned set per context: the ledger is mapped, the column Oracle secures by
    // BU for some applications and by cost org for others is a conflict — no fact, reported
    assert.deepEqual(await brief("XLA_TRANSACTION_ENTITIES"), [["LEDGER_ID", "LEDGER", 1, "oracle_policy"]]);
    assert.match(await reasonOf("XLA_TRANSACTION_ENTITIES", "LEDGER_ID"), /XLA_TRX_ENT_SL_INST_SET_S .*conditioned on a grant parameter/);
    const cols = JSON.parse((await meta()).policy_columns) as any[];
    assert.deepEqual(cols.find((c) => c.table === "XLA_TRANSACTION_ENTITIES" && c.column === "SECURITY_ID_INT_1"), {
      table: "XLA_TRANSACTION_ENTITIES", column: "SECURITY_ID_INT_1", context: null, decidedBy: "conflict",
      contexts: { BU: "XLA_TRX_ENT_BU_INST_SET_S", COST_ORG: "XLA_TRX_ENT_CO_INST_SET_S" } });
  });

  test("job MODULE FAMILY: the application's org context, derived from the policy set codes, beats the corpus vote — MFG vs INV", async () => {
    // WIE (code evidence: the HTS *_WIE sets use MFG_ORGANIZATION_ID) — its only partner votes INV_ORG
    assert.deepEqual(await brief("WIE_WO_OPERATIONS_B"), [["ORGANIZATION_ID", "MFG_ORG", 1, "module"]]);
    assert.match(await reasonOf("WIE_WO_OPERATIONS_B", "ORGANIZATION_ID"),
      /^ORGANIZATION_ID -> MFG_ORG by module family: application WIE -> MFG_ORG \(code evidence: HTSSCHEDULES_WIE, HTSSCHEDUNITSDEPARTMENTV_WIE, HTSWORKLOADPLANS_WIE, HTSWORKLOADS_WIE\)$/);
    // MNT (code evidence: INVORGPARAMETERSMNT, CSEASSETSBMNT77 …) — its only partner is the WIE column above (MFG)
    assert.deepEqual(await brief("MNT_WORK_REQUIREMENTS_B"), [["ORGANIZATION_ID", "INV_ORG", 1, "module"]]);
    assert.match(await reasonOf("MNT_WORK_REQUIREMENTS_B", "ORGANIZATION_ID"), /application MNT -> INV_ORG \(code evidence: .*CSEASSETSBMNT77.*INVORGPARAMETERSMNT/);
    assert.deepEqual(await brief("ENQ_ISSUES_VL"), [["ORGANIZATION_ID", "INV_ORG", 1, "module"]]);
    // judgment applications (no instance set of their own): WIS -> MFG, QA -> INV — a WIS tie never reaches the vote
    assert.deepEqual(await brief("WIS_WD_OPERATION_MATERIALS"), [["ORGANIZATION_ID", "MFG_ORG", 1, "module"]]);
    assert.match(await reasonOf("WIS_WD_OPERATION_MATERIALS", "ORGANIZATION_ID"), /application WIS -> MFG_ORG \(judgment: /);
    assert.deepEqual(await brief("QA_IP_EVENTS"), [["ORGANIZATION_ID", "INV_ORG", 1, "module"]]);
    // an object with its own Oracle policy is never decided by the module rule (HTS: derived sets only)
    assert.deepEqual(await brief("HTS_SCHED_UNITS_DEPARTMENT_V"), []);
    const fam = Object.fromEntries((JSON.parse((await meta()).module_families) as any[]).map((f) => [f.app, [f.context, f.how, f.catalogApplication]]));
    assert.deepEqual([fam.WIE, fam.MNT, fam.INV, fam.ENQ, fam.WIS, fam.QA], [
      ["MFG_ORG", "code", true], ["INV_ORG", "code", true], ["INV_ORG", "code", true], ["INV_ORG", "code", true],
      ["MFG_ORG", "judgment", true], ["INV_ORG", "judgment", true]]);
    assert.deepEqual([fam.MFG, fam.PWA], [["MFG_ORG", "code", false], ["INV_ORG", "code", false]], "family codes that are no catalog application");
  });

  test("job ORACLE POLICY: an unmapped shape is reported with its reason, never guessed into a fact", async () => {
    assert.deepEqual(await brief("XLE_ENTITY_PROFILES"), [], "legal entity = a generic DATASEC context, not one of the twelve");
    assert.deepEqual(await brief("CMK_COLLAB_DOCS_B"), [], "URDA.COLLABORATION_DOC_ID is no context column");
    assert.deepEqual(await brief("ZZ_POLICY_T"), [["ORG_ID", "BU", 1, "name"]], "an unparsable set leaves the rule's fact alone");
    const sets = Object.fromEntries((JSON.parse((await meta()).policy_sets) as any[]).map((s) => [s.set, s]));
    assert.equal(Object.keys(sets).length, POLICIES.length + 1);
    assert.equal(POLICIES.length, 26, "the synthetic extract carries 26 instance sets");
    assert.equal(sets.XLEENTITYPROFILESSTD.shape, "datasec");
    assert.match(sets.XLEENTITYPROFILESSTD.why, /generic data-security context ORA_LEGAL_ENTITY_ID/);
    assert.equal(sets.CMKCOLLABDOCSBSTD.shape, "non_context");
    assert.match(sets.CMKCOLLABDOCSBSTD.why, /DOCUMENT_ID by URDA\.COLLABORATION_DOC_ID - not one of the twelve context columns/);
    assert.equal(sets.ZZPOLICYTODD.shape, "unparsed");
    assert.equal(sets.ZZPOLICYTODD.columns, null);
    assert.equal(sets.POHEADERSALLMFG.shape, "exists");
    assert.equal(sets.CSTCOSTORGSINV.shape, "derived");
    assert.match(sets.CSTCOSTORGSINV.why, /COST_ORG_ID by COST_ORG_ID of CST_COST_INV_ORGS - derived from URDA\.INV_ORGANIZATION_ID through a mapping object/);
    assert.deepEqual(sets.INVORGPARAMETERSMFG.columns, [{ column: "ORGANIZATION_ID", context: "MFG_ORG", urda: "MFG_ORGANIZATION_ID", flags: null }]);
  });

  test("job R2: transitive vote by the partner COLUMN's context — ZX views → BU via AR_XLA_LINES_EXTRACT.ORG_ID, two hops", async () => {
    assert.deepEqual(await brief("ZX_JRNL_ACCOUNTS_EXTRACT_V"), [["ORGANIZATION_ID", "BU", 1, "corpus_join"]]);
    assert.deepEqual(await brief("ZX_AR_LOC_ACCOUNTS_EXTRACT_V"), [["ORGANIZATION_ID", "BU", 1, "corpus_join"]], "resolved from a partner resolved in the round before");
  });

  test("job R2: a tie goes to the object's own prefix family — SMO_COMMANDS INV 1 : MFG 1 → MFG", async () => {
    assert.deepEqual(await brief("SMO_COMMANDS"), [["ORGANIZATION_ID", "MFG_ORG", 1, "corpus_join"]]);
    assert.match(await reasonOf("SMO_COMMANDS", "ORGANIZATION_ID"), /tie broken by the object's prefix family SMO/);
  });

  test("job R3: view lineage — CML_RECEIPTS_VL → INV by its joins, CML_RECEIPTS_B inherits it; a view passing an HCM column through is excluded", async () => {
    assert.deepEqual(await brief("CML_RECEIPTS_VL"), [["ORGANIZATION_ID", "INV_ORG", 1, "corpus_join"]]);
    assert.deepEqual(await brief("CML_RECEIPTS_B"), [["ORGANIZATION_ID", "INV_ORG", 1, "lineage"]]);
    assert.deepEqual(await brief("HTS_SCHED_UNITS_DEPARTMENT_V"), []);
  });

  test("job R4/R5: own id space (FFS_ORGANIZATION key + its TL child) and non-org partners (resource GROUP_ID) are no context", async () => {
    assert.deepEqual(await brief("FFS_ORGANIZATION"), []);
    assert.deepEqual(await brief("FFS_ORGANIZATION_TL"), []);
    assert.deepEqual(await brief("MKT_CM_CAMPAIGNS"), []);
    assert.deepEqual(await brief("JTF_RS_RESOURCE_ORG_BU"), [["BU_ID", "BU", 1, "name"]], "only the ORGANIZATION_ID column is dropped; the BU column stays");
  });

  test("job R6: curated `set` replaces the candidates, column-scoped `none` keeps the object's other columns", async () => {
    assert.deepEqual(await brief("OSS_COVERAGE_DISCOUNTS"), [["ORGANIZATION_ID", "ITM_ORG", 1, "curated"]]);
    assert.deepEqual(await brief("HZ_IMP_GROUP_MEMBERS"), [["ORG_ID", "BU", 1, "name"]]);
  });

  test("job: unresolved + unused ⇒ disallowed (no rows); unresolved + USED ⇒ ambiguous rows the p6 gate fails on", async () => {
    assert.deepEqual(await brief("FFS_SCHEDULE"), []);
    const d = await sql.unsafe(`SELECT table_name, reason FROM ${V}.table_disallowed ORDER BY 1`) as any[];
    assert.deepEqual(d.map((r) => r.table_name), ["FFS_SCHEDULE"]);
    assert.match(d[0].reason, /^ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage.* — and FFS_SCHEDULE is used by no corpus SQL/);
    assert.deepEqual((await rows("XYZ_ORG_LINKS")).map((r) => [r.context, r.confidence]),
      [["BU", "ambiguous"], ["INV_ORG", "ambiguous"], ["MFG_ORG", "ambiguous"], ["PRJ_ORG", "ambiguous"]]);
    // the release gate, exactly as p6_verify.sql §6c runs it
    const p6 = fs.readFileSync(path.join(PIPE, "p6_verify.sql"), "utf8");
    const gate = /DO \$\$\nDECLARE n int;[\s\S]*?p6 gate FAILED: % ambiguous[\s\S]*?END \$\$;/.exec(p6);
    assert.ok(gate, "p6_verify.sql carries the ambiguous gate");
    await assert.rejects(sql.unsafe(gate[0].replaceAll("{{V}}", V)), /p6 gate FAILED: 1 ambiguous data-access column\(s\) on USED objects/);
    await sql.unsafe(`DELETE FROM ${V}.table_security WHERE confidence = 'ambiguous'`);
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
  });

  test("job: the p6 gate on curated area rows — every row names its pair and its scope; a nameless row fails the release", async () => {
    const p6 = fs.readFileSync(path.join(PIPE, "p6_verify.sql"), "utf8");
    const gate = /DO \$\$\nDECLARE nameless int;[\s\S]*?p6 gate FAILED: % curated area row[\s\S]*?END \$\$;/.exec(p6);
    assert.ok(gate, "p6_verify.sql carries the nameless-row gate");
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
    await assert.rejects(sql.unsafe(`INSERT INTO ${V}.sec_area_privilege (area_or_product, ordinal, obj_name, privilege, source, evidence, instance_scope) VALUES ('ZZ', 1, NULL, NULL, 'inferred', 'x', '*')`),
      /null value in column "obj_name"/, "ddl_version 8: a nameless row cannot even be stored");
    await sql.unsafe(`INSERT INTO ${V}.sec_area_privilege (area_or_product, ordinal, obj_name, privilege, source, evidence, instance_scope) VALUES ('ZZ', 1, 'GL_LEDGERS', '', 'inferred', 'x', '*')`);
    await assert.rejects(sql.unsafe(gate[0].replaceAll("{{V}}", V)), /p6 gate FAILED: 1 curated area row\(s\) in .* without an object \/ privilege name or an instance scope/);
    await sql.unsafe(`DELETE FROM ${V}.sec_area_privilege WHERE area_or_product = 'ZZ'`);
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
  });

  test("job: PO_HEADERS_ALL — every BU column detected; the two Oracle secures (REQ_BU_ID, BILLTO_BU_ID) are oracle_policy, REQ_BU_ID primary", async () => {
    assert.deepEqual(await brief("PO_HEADERS_ALL"), [
      ["REQ_BU_ID", "BU", 1, "oracle_policy"], ["BILLTO_BU_ID", "BU", 0, "oracle_policy"],
      ["PRC_BU_ID", "BU", 0, "name"], ["SOLDTO_BU_ID", "BU", 0, "name"],
    ]);
    assert.match(await reasonOf("PO_HEADERS_ALL", "REQ_BU_ID"), /instance set\(s\) POHEADERSALLPO49, POHEADERSALLRCVADVRCV, POHEADERSALLRCVPREPARER, POHEADERSALLRCVREQUESTER filter REQ_BU_ID by URDA\.ORG_ID/);
    assert.match(await reasonOf("PO_HEADERS_ALL", "BILLTO_BU_ID"), /instance set\(s\) POHEADERSALLAP294 filter BILLTO_BU_ID by URDA\.ORG_ID/);
  });

  test("job: HCM → none; exclusions hold (security objects included)", async () => {
    assert.deepEqual(await brief("PER_DEPARTMENTS"), []);
    for (const t of ["AP_INVOICES_ALL_", "MLOG$_AP_INVOICES_ALL", "AR_TRX_HEADER_GT", "OKC_CURRENT_USER_BU_V", "FUN_USER_ROLE_DATA_ASGNMNTS"]) {
      assert.deepEqual(await brief(t), [], `${t} is excluded`);
    }
  });

  test("job: sec_meta carries stamps, the context order + evidence objects, the HCM prefixes — no template, no probe, no export stamp", async () => {
    const m = Object.fromEntries((await sql.unsafe(`SELECT k, v FROM ${V}.sec_meta`) as any[]).map((r) => [r.k, r.v]));
    assert.equal(m.version, "2");
    assert.equal(m.source_release, V);
    assert.equal(JSON.parse(m.context_order)[0], "BU");
    assert.deepEqual(JSON.parse(m.hcm_prefixes), RULES.exclude.hcmPrefixes);
    assert.deepEqual(JSON.parse(m.privilege_prefix_aliases), RULES.privilegePrefixAliases.map, "the resolver's module filter ships in sec_meta");
    assert.ok(!Object.keys(m).some((k) => k.startsWith("template.") || k.startsWith("probe_")), "no predicate template and no probe outcome exists any more");
    assert.equal(m.export, undefined, "ddl_version 9: no export stamp — nothing of a pod is read");
    // per context: the reference object + its evidence objects (the area-keyed plan's VO evidence reads them)
    const ev = JSON.parse(m.context_evidence_refs) as Record<string, string[]>;
    assert.deepEqual(Object.keys(ev).sort(), [...JSON.parse(m.context_order)].sort());
    assert.ok(ev.BU.includes("FUN_ALL_BUSINESS_UNITS_V") && ev.LEDGER.includes("GL_LEDGERS"));
    const stats = JSON.parse(m.stats);
    assert.equal(stats.ambiguous_on_used_columns, 1);
    assert.equal(stats.disallowed_objects, 1);
    assert.equal(stats.org_chain.own_id_space, 2);
    assert.equal(stats.org_chain.non_org_partner, 2);
    // the synthetic extract (26 sets) + the one synthetic unparsable set
    assert.deepEqual(stats.policy.sets_by_shape, { direct: 18, derived: 5, datasec: 1, exists: 1, non_context: 1, unparsed: 1 });
    assert.deepEqual(JSON.parse(m.policy_source).instance_sets, 27);
    // WIE_WO_OPERATIONS_B, MNT_WORK_REQUIREMENTS_B, QA_IP_EVENTS, WIS_WD_OPERATION_MATERIALS, ENQ_ISSUES_VL / _B,
    // INV_ORG_PARAMETERS_V, INV_ORGANIZATION_DEFINITIONS_V (the FK-decided WIE / INV tables keep `fk`)
    assert.equal(stats.policy.module_rule_columns, 8);
    assert.equal(stats.org_chain.oracle_policy, 2, "INV_ORG_PARAMETERS + RCS_MFG_PARAMETERS");
    assert.deepEqual(stats.area_rows_by_source, { trace: 2, inferred: RULES.areaPrivileges.rows.length - 2 });
    assert.equal(stats.area_rows_with_entity, (RULES.areaPrivileges.rows as any[]).filter((r) => r.entity).length);
    assert.equal(stats.area_rows_with_column, (RULES.areaPrivileges.rows as any[]).filter((r) => r.column).length);
    assert.ok(stats.area_rows_with_column >= 1, "the traced Payables row names its column");
    assert.equal(stats.sec_objects, undefined);
  });

  test("job ddl_version 10: the reference families by name pattern AND reference-shaped columns (with evidence); the traced context column; the p6 reference gate", async () => {
    const fams = Object.fromEntries((await sql.unsafe(`SELECT table_name, family, base_table, evidence FROM ${V}.table_reference_family ORDER BY 1`) as any[])
      .map((r) => [r.table_name, [r.family, r.base_table]]));
    assert.deepEqual(fams, {
      AP_LOOKUP_CODES: ["lookup", null], FND_LOOKUPS: ["lookup", null], GL_PERIODS: ["calendar", null], GL_DAILY_RATES: ["currency", null],
      FND_CURRENCIES_TL: ["currency", null], FND_TERRITORIES_VL: ["territory", null], HZ_GEOGRAPHIES: ["territory", null],
      XX_THINGS_TL: ["translation", "XX_THINGS_B"], XX_THINGS_VL: ["translation", "XX_THINGS_B"], XX_LONE_TL: ["translation", null],
    }, "no LOOKUP_CODE, a business key on a period table, an audit date only, a business id on a translation: not reference data");
    const ev = Object.fromEntries((await sql.unsafe(`SELECT table_name, evidence FROM ${V}.table_reference_family`) as any[]).map((r) => [r.table_name, r.evidence]));
    assert.equal(ev.FND_LOOKUPS, "name ..._LOOKUPS (lookup pattern); reference columns DESCRIPTION, LOOKUP_CODE, LOOKUP_TYPE, MEANING");
    assert.equal(ev.GL_PERIODS, "name ..._PERIODS (calendar pattern); reference columns END_DATE, PERIOD_SET_NAME, START_DATE; id columns none (no business key)");
    assert.equal(ev.XX_THINGS_VL, "name ..._VL over XX_THINGS_TL with LANGUAGE, SOURCE_LANG; key columns THING_ID; every *_ID column a key or a standard id; base XX_THINGS_B");
    assert.match(ev.XX_LONE_TL, /; no base table in the dictionary$/);
    const stats = JSON.parse((await meta()).stats);
    assert.deepEqual(stats.reference_tables_by_family, { calendar: 1, currency: 2, lookup: 2, territory: 2, translation: 3 });
    assert.equal(stats.reference_translations_without_base, 1);
    // the traced Payables row: its entity and the column the trace names reach sec_area_privilege
    const traced = await sql.unsafe(`SELECT area_or_product, obj_name, privilege, source, entity_table, context_column FROM ${V}.sec_area_privilege WHERE context_column IS NOT NULL`) as any[];
    assert.deepEqual(traced.map((r) => [r.area_or_product, r.obj_name, r.privilege, r.source, r.entity_table, r.context_column]),
      [["Payables", "FUN_ALL_BUSINESS_UNITS_V", "AP_REPORT_PAYABLES_DATA", "trace", "FUN_BU_PERF_V", "AP_INVOICES_ALL.ORG_ID"]]);
    // the p6 gate on the reference families and the context columns: green, then each breakage fails it
    const p6 = fs.readFileSync(path.join(PIPE, "p6_verify.sql"), "utf8");
    const gate = /DO \$\$\nDECLARE bad_ref text;[\s\S]*?END \$\$;/.exec(p6);
    assert.ok(gate, "p6_verify.sql carries the reference-family gate");
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
    await sql.unsafe(`INSERT INTO ${V}.table_reference_family VALUES ('NOPE_TABLE', 'lookup', NULL, 'x'), ('FND_LOOKUPS_X', 'colour', NULL, 'x')`);
    await sql.unsafe(`UPDATE ${V}.table_reference_family SET base_table = 'NOPE_BASE' WHERE table_name = 'XX_THINGS_TL'`);
    await sql.unsafe(`UPDATE ${V}.sec_area_privilege SET context_column = 'AP_INVOICES_ALL.NOPE' WHERE context_column IS NOT NULL`);
    const err = await sql.unsafe(gate[0].replaceAll("{{V}}", V)).then(() => "", (e: Error) => e.message);
    assert.match(err, /p6 gate FAILED: reference families \/ context columns/);
    assert.match(err, /table_reference_family -> tables: 2 row\(s\)/);
    assert.match(err, /table_reference_family\.family colour is not lookup/);
    assert.match(err, /a base_table on a non-translation row, or a base that is no dictionary table: XX_THINGS_TL/);
    assert.match(err, /context_column AP_INVOICES_ALL\.NOPE \(Payables\) is not TABLE\.COLUMN of the dictionary/);
    await sql.unsafe(`DELETE FROM ${V}.table_reference_family WHERE table_name IN ('NOPE_TABLE', 'FND_LOOKUPS_X')`);
    await sql.unsafe(`UPDATE ${V}.table_reference_family SET base_table = 'XX_THINGS_B' WHERE table_name = 'XX_THINGS_TL'`);
    await sql.unsafe(`UPDATE ${V}.sec_area_privilege SET context_column = 'AP_INVOICES_ALL.ORG_ID' WHERE context_column IS NOT NULL`);
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
  });

  test("job: sec_meta.primary_audit (the audited prefixes only) + sec_meta.sensitive_objects (masked twins from the dictionary); the p6 sec_meta gate", async () => {
    const m = await meta();
    assert.deepEqual(JSON.parse(m.primary_audit), {
      AP: { contexts: ["BU"], source: "trace", evidence: RULES.primaryByPrefix.AP.audit.evidence },
      DOO: { contexts: ["BU"], source: "crawl", evidence: RULES.primaryByPrefix.DOO.audit.evidence },
      GL: { contexts: ["LEDGER"], source: "crawl", evidence: RULES.primaryByPrefix.GL.audit.evidence },
    }, "a crawl audit only where the demo-crawl grant block names the entity it binds to (GL ledger, DOO business unit)");
    assert.match(m.primary_audit, /SHA-256 5747a1ca58d2202d4a4a234804e150a60b4d762ae6adf86c330d4994b8c8a426, 2,569 chars/, "the trace proof is a hash + length, never the text");
    const s = JSON.parse(m.sensitive_objects);
    assert.deepEqual(Object.keys(s).sort(), SENSITIVE.map(([t]) => t).sort());
    assert.deepEqual(s.PER_NATIONAL_IDENTIFIERS, { object: "PER_NATIONAL_IDENTIFIERS", privileges: ["PER_REPORT_PERSON_NATIONAL_IDENTIFIER_DATA"], evidence: s.PER_NATIONAL_IDENTIFIERS.evidence, masked: [] });
    assert.deepEqual(s.POZ_SUPPLIERS_PII.privileges, ["POZ_MAINTAIN_SUPPLIER_TAX_IDENTIFIERS_PII_DATA", "POZ_MAINTAIN_SUPPLIER_CORPORATE_TAX_IDENTIFIERS_DATA"]);
    assert.deepEqual(s.IBY_EXT_BANK_ACCOUNTS.masked, [{ column: "BANK_ACCOUNT_NUM", use: "MASKED_BANK_ACCOUNT_NUM" }, { column: "IBAN", use: "MASKED_IBAN" }]);
    assert.deepEqual(s.IBY_ACCOUNT_OWNERS.masked, []);
    const stats = JSON.parse(m.stats);
    assert.deepEqual([stats.primary_audit_prefixes, stats.sensitive_tables], [["AP", "DOO", "GL"], SENSITIVE.length]);
    // every primary still exactly one per object (the table-keyed plan secures it)
    const prim = (await sql.unsafe(`SELECT count(*) n FROM (SELECT table_name FROM ${V}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1 HAVING sum(is_primary) <> 1) x`) as any[])[0];
    assert.equal(Number(prim.n), 0);
    // the release gate, exactly as p6_verify.sql §6c runs it: green, then a sensitive row read through another
    // object, a privilege that is no name and an evidence map naming no context each fail it
    const p6 = fs.readFileSync(path.join(PIPE, "p6_verify.sql"), "utf8");
    const gate = /DO \$\$\nDECLARE bad_meta text;[\s\S]*?END \$\$;/.exec(p6);
    assert.ok(gate, "p6_verify.sql carries the sec_meta gate");
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
    const broken = { ...s, CMP_SALARY: { ...s.CMP_SALARY, object: "CMP_SALARY_X" }, PER_PASSPORTS: { ...s.PER_PASSPORTS, privileges: ["1234"] } };
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'sensitive_objects'`, [JSON.stringify(broken)]);
    const sErr = await sql.unsafe(gate[0].replaceAll("{{V}}", V)).then(() => "", (e: Error) => e.message);
    assert.match(sErr, /sensitive_objects\.CMP_SALARY: object CMP_SALARY_X is not the table itself/);
    assert.match(sErr, /sensitive_objects\.PER_PASSPORTS: privilege 1234 is not a privilege name/);
    const ev = m.context_evidence_refs;
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'context_evidence_refs'`, [JSON.stringify({ ...JSON.parse(ev), NOPE: ["X"], BU: [] })]);
    const eErr = await sql.unsafe(gate[0].replaceAll("{{V}}", V)).then(() => "", (e: Error) => e.message);
    assert.match(eErr, /context_evidence_refs\.NOPE is not one of sec_meta\.context_order/);
    assert.match(eErr, /context_evidence_refs\.BU is not one of sec_meta\.context_order, or lists no object/);
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'context_evidence_refs'`, [ev]);
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'primary_audit'`, [JSON.stringify({ ZZ: { contexts: ["NOPE"], source: "guess", evidence: "" } })]);
    const err = await sql.unsafe(gate[0].replaceAll("{{V}}", V)).then(() => "", (e: Error) => e.message);
    assert.match(err, /p6 gate FAILED: data-access sec_meta facts/);
    assert.match(err, /primary_audit\.ZZ is malformed/);
    assert.match(err, /primary_audit\.ZZ names context NOPE, not one of sec_meta\.context_order/);
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'sensitive_objects'`, [m.sensitive_objects]);
    await sql.unsafe(`UPDATE ${V}.sec_meta SET v = $1 WHERE k = 'primary_audit'`, [m.primary_audit]);
    await sql.unsafe(gate[0].replaceAll("{{V}}", V));
  });

  after(async () => {
    await sql.end();
    await db.close();
    await dropScratchDbs();
  });
}
