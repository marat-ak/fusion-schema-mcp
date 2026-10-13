# Fusion data-access security — corpus / catalog analysis (Step 1, read-only)

Date 2026-09-29. Author: fusion-agent-dev (dispatched). Program: "end-user mode + mandatory
data-access security", Step 1 of 2. Nothing was changed: no schema, serving code, plugin or data.

Sources read (all READ-ONLY):

- `CloudBeaver` WSL distro, `/opt/fusion-catalog-v2/schema.sqlite` (29,802 objects / 1,449,501
  columns / 18,565 fkeys / 14,009 relationships) and `sqls.sqlite` (98,154 L2 units + `x_*`
  round-0 facts), via `sqlite3 -readonly` and script files under the session scratchpad
  (`.../scratchpad/da/q*.sql`). `/opt/fusion-catalog-test` was not touched.
- Postgres `stack-db`, database `fusion_dev`: `work.*` (the pinned sqlglot parse — `f_predicates`,
  `f_joins`, `r_tables`, `f_calls`, `clear_sql` with the Qwen `security` jsonb) and the release
  `v2026_11` (the version `fusion` serves: `meta.active_version = v2026_11`; `fusion_dev` also holds
  `v2026_09/10/12`). Scripts: `.../scratchpad/da/pg_*.sh`.
- Repo: `data/META_*.csv`, `data/mined_relationships.json` (4,892 rows), `data/otbi_relations.json`
  (9,117 rows); `src/catalog.ts`, `src/tools.ts`, `src/db/**`, `src/corpus/{grainRegistry,
  predicateMiner,usageGraph,otbiMeta}.ts`, `scripts/pipeline/{README.md,p3_calls*,p5_fill.sql,
  p5_plsql.sql}`, `scripts/pg-import/ddl.sql`, `scripts/gpu-enrich/import_serving.mjs`.
- KB: `articles/fusion-schema-mcp.md`, `articles/otbi-logical-sql.md`,
  `articles/table-grain-registry.md`, memory `v2-catalog-data-access`, `mostly-used-filters-push`.

Terminology: "object" = row of `tables` (TABLE or VIEW); "statement" = L3 `work.clear_sql` row
(deduped by `sql_hash`, 26,204); "unit" = L2 `sql_units` row (98,154 in sqls.sqlite; 116,006 in
`work.sql_unit`). Counts labelled (T/V) are TABLE/VIEW splits.

---

## 1. Column-name coverage per context

Query (schema.sqlite, `q1.sql`): a `pat(ctx, pattern, kind)` VALUES list joined to `columns` on
exact name or `LIKE '%_X'` suffix (exact names removed from the suffix bucket), joined to `tables`
for the type split. Catalog totals: **29,802 objects (22,898 T / 6,904 V), 1,449,501 columns**.
`v2026_11` ships the identical counts (29,802 / 6,904 / 1,449,501).

| Context | Column pattern | objects | TABLE | VIEW | Note |
|---|---|---|---|---|---|
| BU | `ORG_ID` | **1,019** | 776 | 243 | 546 of 1,019 are `_ALL` tables; remark says "business unit" on all 776 remarked; CN_* = 294 (29 %) |
| BU | `BU_ID` | 190 | 140 | 50 | |
| BU | `%_BU_ID` | 409 | 300 | 109 | PRC_BU_ID 156, REQ_BU_ID 102, BILL_TO_BU_ID 26, PROFIT_CENTER_BU_ID 26, SOLDTO_BU_ID 24, REQUISITIONING_BU_ID 20 … |
| BU | `BUSINESS_UNIT_ID` (not in the ask) | **408** | 291 | 117 | escapes both `ORG_ID` and `%_BU_ID`; must be added |
| Ledger | `LEDGER_ID` | **665** | 447 | 218 | 62 tables' remark = "internal use only / no longer used" |
| Ledger | `%_LEDGER_ID` | 127 | 80 | 47 | PRIMARY_LEDGER_ID 33, CMR_SUB_LEDGER_ID 13, SOURCE/FROM/TO/TARGET/SECONDARY_LEDGER_ID … |
| Ledger | `SET_OF_BOOKS_ID` | 192 | 138 | 54 | legacy name of LEDGER_ID (FA 25, AR 21, GTG 18, AP 16 …) |
| Data access set | `ACCESS_SET_ID` | 14 | 14 | 0 | 3 are `MSC_DAS_*` (SCM Planning "data access sets" — a different object) |
| Asset book | `BOOK_TYPE_CODE` | 148 | 136 | 12 | FA 123 (114 T / 9 V); 25 outside FA (GTG 16, PJF 3, PJC 3, JG/JE/FUN 1 each) |
| Asset book | `BOOK_ID` / `BOOK_CONTROL_ID` | 2 / 4 | | | BOOK_CONTROL_ID lives on FA_BOOK_CONTROLS + 3 |
| Ref data set | `SET_ID` | **288** | 167 | 121 | 167 remark "reference data set", 121 no remark (views); **0 FKs** on SET_ID anywhere |
| Ref data set | `%_SET_ID` | 1,635 | 1,289 | 346 | **NOT a reference-data pattern**: ASSET_ID 263, DATA_SET_ID 121, CATEGORY_SET_ID 94, CUST_SET_ID 83, VALUE_SET_ID 78, RULE_SET_ID 64, DISTRIBUTION_SET_ID 41, SIMULATION_SET_ID 32 … |
| Inv org | `ORGANIZATION_ID` | **1,326** | 852 | 474 | see §2 for resolution; 136–144 are HCM |
| Inv org | `INV_ORG_ID` | 118 | 68 | 50 | CST 52, LOY 11, CMR 10, QSC 8 |
| Inv org | `INVENTORY_ORG_ID` / `INVENTORY_ORGANIZATION_ID` (not in the ask) | 290 / 114 | | | |
| Inv org | `%_ORGANIZATION_ID` | 835 | 515 | 320 | PJC_ORGANIZATION_ID 140, SOURCE_ 116, INVENTORY_ 114, ITEM_ 56, EXPENDITURE_ 55, INTERNAL_ 48, MASTER_ 47, SHIP_TO_ 45 … (mixed contexts: PJC/EXPENDITURE = project org; INVENTORY/SHIP_TO/FROM/TO = inv org) |
| Inv org | `INV_ORGANIZATION_ID` | 12 | 11 | 1 | URDA itself + 11 |
| Cost org | `COST_ORG_ID` | **404** | 307 | 97 | 100 % CST_* |
| Cost org | `CST_ORGANIZATION_ID` | 2 | 2 | 0 | URDA + copy |
| Project org | `CARRYING_OUT_ORGANIZATION_ID` | 20 | 7 | 13 | PJF 14, PJC 3, GTG 2, XFACE 2 |
| Project org | `PRJ_ORGANIZATION_ID` | 2 | 2 | 0 | URDA + copy |
| Interco org | `INTERCO_ORG_ID` | 9 | 8 | 1 | FUN_INTERCO_ORGANIZATIONS, FUN_INTERCO_ORG_BSVS, FUN_IC_CUST_SUPP_MAP, FUN_INTERCO_MASTER_ORGS_V, URDA (+ `_` copies) |
| Interco org | `%_INTERCO_ORG_ID` | 0 | | | only INTERCO_ORG_BSV_ID (2) — a BSV id, not an org |
| Control budget | `CONTROL_BUDGET_ID` | 74 | 53 | 21 | XCC 53; 21 outside XCC (AR, IBY, FV, EXM, PO, FUN, POR, GL, AP, XLA, PJC, CMR) |

Union of the asked patterns: **5,725 objects (4,129 T / 1,596 V) = 19.2 % of the catalog**.
Restricted to the exact names only (no suffix buckets) in `v2026_11`: 4,709 objects.
Multi-context objects (coarse mapping of exact names): 3,915 carry one context, **627 two, 33
three, 4 four, 2 six** — e.g. AP_INVOICES_ALL (ORG_ID + SET_OF_BOOKS_ID + EXPENDITURE_ORGANIZATION_ID),
RA_CUSTOMER_TRX_ALL (ORG_ID + SET_OF_BOOKS_ID), PJC_EXP_ITEMS_ALL (ORG_ID + 5 `*_ORGANIZATION_ID`),
INV_MATERIAL_TXNS (ORGANIZATION_ID + 6 `*_ORGANIZATION_ID`), PO_HEADERS_ALL (PRC/REQ/BILLTO/SOLDTO_BU_ID,
no ORG_ID), PJF_PROJECTS_ALL_B (ORG_ID + CARRYING_OUT_ORGANIZATION_ID).

Prefix breakdown (`q1b.sql`, first token of the object name, cells with ≥ 8 objects):

| Column | Prefix (T/V) |
|---|---|
| ORG_ID | CN 243/51, AR 91/11, AP 60/14, VRM 33, EXM 30, FLA 26/11, HES 26/10, JL 26/24, IBY 24/15, PJC 24/11, RA 24, JG 22, AHT 16, OKC 15, PJF 15/14, GRC –/13, QP 13/12, DOO –/12, IEX 11, JA 8, PJB 8, ZX 8 |
| BU_ID | CJM 32, LOY 16, OKC 12, VRM 11 |
| LEDGER_ID | GL 89/10, AR 10/74, XLA 56/9, VRM 47/17, XCC 36, FV 35, FUN 25, ZX 25/19, FA 19, PJC –/17, FLA 15/8, CST 13, CMR 12/9, JG 10, JA 9, JL 9, AP 8, PSC –/8 |
| SET_OF_BOOKS_ID | FA 25, AR 21, GTG 18, AP 16, PER –/12, VRM 10, GL 9, RA 8 |
| ACCESS_SET_ID | GL 9 (+ MSC 3, FUN 2) |
| BOOK_TYPE_CODE | FA 114/9, GTG 16 |
| SET_ID | AR 27, RA 16, PER –/15, HZ 12, FND 11, QP 10, CST 9/8, HR –/9, FA 8, PJF 8 |
| ORGANIZATION_ID | MSC 198/132, INV 105/34, WIE 68/40, EGP 45/34, WIS 37/20, PER 16/32, EGO 31/19, MLOG$ –/28, PJF 27, MNT 22/9, CST 20/9, PJC 18, HR 10/17, MSS 17, WSH 17/8, GTG 16, CZ 13, BEN 11, CSE 11, GMS –/11, OSS 10, VCS 10, FFS 9, RCS 8, RCV 8, SCH 8 |
| INV_ORG_ID | CST 21/31, LOY 11, CMR –/10, QSC 8 |
| COST_ORG_ID | CST 307/97 |
| CARRYING_OUT_ORGANIZATION_ID | PJF –/10 (+ PJF 4 T, PJC 3 V, GTG 2) |
| CONTROL_BUDGET_ID | XCC 45/8 |

`tables.module` is not usable for this breakdown (191 values, mixed case, `fusion`/`fnd` junk);
the name prefix (206 values) is.

---

## 2. Reference resolution of ambiguous names

Queries: `q2.sql` (fkeys + `relationships` on schema.sqlite — `relationships` is exactly
`mined_relationships.json` 4,892 + `otbi_relations.json` 9,117, source-tagged), `json_xcheck.py`
(the two JSON files directly, same numbers), `pg_more.sh` B3–B6 (`work.f_joins`, the pinned parse:
richer than both), `q7.sql`/`q7c.sql`/`q_amb.sql` (remark and sibling-column signals).

### 2.1 `ORGANIZATION_ID` (1,326 objects)

| Signal | Resolves to | objects |
|---|---|---|
| FK (`fkeys`, 18,565 rows over 4,164 child tables) | any parent | **84 of 1,326 (6.3 %)** |
| | INV_ORG_PARAMETERS 27, INV_SECONDARY_INVENTORIES 26, EGP_ITEM_ORG_ASSOCIATIONS 19, INV_LOT_NUMBERS 10, EGP_SYSTEM_ITEMS_B 9, MSC_PARAMETERS 7, MSS_ORG_ATTRIBUTES 6, CZ_SS_ITEMS_B (73 child rows) | |
| | **RCS_MFG_PARAMETERS: 0 · HR_* : 0 · HR_ORG_UNIT_CLASSIFICATIONS_F: 0** | |
| `relationships` (mined+otbi) as from_col | INV_ORG_PARAMETERS 8, HR_ORG_UNIT_CLASSIFICATIONS_F 4, WIE_WORK_ORDERS_B/VL 4, ZCA_BI_PRODUCT_DENORM.INV_ORG_ID 4, EGP_SYSTEM_ITEMS_ALL_V.ITEM_DEFINITION_ORG_ID 3, PER_ALL_ASSIGNMENTS_M 3, PER_DEPARTMENTS 3 … | 52 (23 T / 29 V) |
| Bucketed (FK first, then relationships) | none 1,190 · fk:other 57 · rel:other 39 · fk:INV_ORG_PARAMETERS 27 · rel:INV_ORG_PARAMETERS 8 · rel:HR 3 · rel:PJF 2 | |
| Corpus joins (`work.f_joins`) on that column | any join partner | **257 of 1,326 (19.4 %)** |
| | targets: INV_ORG_PARAMETERS 27 tables / 2,386 stmts; EGP_SYSTEM_ITEMS_VL 27/120; INV_ORGANIZATION_DEFINITIONS_V 18/68; HR_ORGANIZATION_UNITS_F_TL 11/479; MSC_SYSTEM_ITEMS 11/20; HR_ALL_ORGANIZATION_UNITS_F 9/152; PER_DEPARTMENTS 8/30; RCS_ORG_DEFINITIONS_LW_V 7/9; HR_ORGANIZATION_INFORMATION_F 7/188; HR_ORG_UNIT_CLASSIFICATIONS_F 5/306; PER_ALL_ASSIGNMENTS_M 5/41; **RCS_MFG_PARAMETERS 3/5** | |
| | from-tables by target family: inv 50 · hr 44 · mfg 3 · other 143 | |
| Column remark (`columns.remarks`) | none 474 · generic "organization" 474 · inventory 122 · manufacturing/plant 118 · HCM (department/legal/business group) 56 · item 50 · project 11 · other 21 | |
| Sibling columns on the same object | INVENTORY_ITEM_ID 619 · WORK_ORDER/WORK_DEFINITION/WORK_CENTER_ID 174 · PERSON_ID/ASSIGNMENT_ID 145 · PROJECT_ID/TASK_ID 122 · SUBINVENTORY_CODE 98 · BUSINESS_GROUP_ID 97 · **no signal 427** | |
| Prefix domain | scm-inv/item/plan 693 · mfg/maint/quality 236 · hcm/edu 144 · projects 86 · other 139 · MLOG$ 28 | |

Resolution chain applied in order (`q_amb.sql`): junk excluded 31 (MLOG$ + trailing-underscore
copies) → HCM prefixes excluded 144 → FK 84 → relationships 72 → prefix domain (inv/mfg/prj) 867 →
sibling columns 56 → **ambiguous 72 (51 T / 21 V)**, all in "other" prefixes: GTG 16, CZ 16, VCS 10,
OSS 10, FFS 10, SMO 8, EGI 8, CTO 6, RCL 5, JMF/ENQ/ACA 4 each, and 1–3 each for MKT, JG, ZX, SVC,
JTF, HTS, EDR, CML, CMF, PO, HZ, OKC, XLE, VRM, MO.

Caveat on the 867: prefix domain resolves *which reference object* (INV_ORG_PARAMETERS vs
RCS_MFG_PARAMETERS vs HR project classification) but the underlying id space is ONE
(`HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID` — FUN_ALL_BUSINESS_UNITS_V, CST_COST_ORGS_V,
INV_ORG_PARAMETERS, RCS_MFG_PARAMETERS all key on it; view texts in `q3.sql`). A manufacturing
table's ORGANIZATION_ID is both an inventory org and a plant; whether URDA.INV_ORGANIZATION_ID or
URDA.MFG_ORGANIZATION_ID is the correct gate is a business ruling per module, not derivable.

### 2.2 Other ambiguous names

| Column | FK parents | relationships / corpus joins | Verdict |
|---|---|---|---|
| ORG_ID | 17 parents, all CN_*/AR/AP/PJF `_ALL` tables (the parent is another BU-striped table, never a BU master — FUN_ALL_BUSINESS_UNITS_V is a view) | otbi: FUN_ALL_BUSINESS_UNITS_V.BU_ID 18 tables, FUN_BU_PERF_V.BU_ID 10; corpus: FUN_ALL_BUSINESS_UNITS_V ← ORG_ID 34 tables / 111 stmts, ← BUSINESS_UNIT_ID 15/107, ← PRC_BU_ID 11/24, ← REQ_BU_ID 8/9; HR_ORGANIZATION_UNITS_F_TL ← ORG_ID 10/41 | name is sufficient; 776/776 remarked say "business unit" |
| LEDGER_ID | GL_LEDGERS 57 children (+ XCC_BCE_*, FA_MC_LEASE_SCHEDULES) | GL_LEDGERS ← LEDGER_ID 26 tables / 119 stmts, ← SET_OF_BOOKS_ID 12/26, ← PRIMARY_LEDGER_ID 5/25 | name sufficient; SET_OF_BOOKS_ID is a ledger id |
| BOOK_TYPE_CODE | FA_BOOK_CONTROLS 51 children, FA_DEPRN_PERIODS 19, FA_TRANSACTION_HEADERS 16, FA_MC_BOOK_CONTROLS 10 | FA_BOOK_CONTROLS ← BOOK_TYPE_CODE 13/57 | name sufficient inside FA_* |
| SET_ID | **0 FK rows** | FND_SETID_SETS_VL ← SET_ID 11 tables / 83 stmts; otbi also → HR_ORG_UNIT_CLASSIFICATIONS_F.SET_ID, PER_JOBS_F, PER_GRADES_F, PJF_RATE_SCHEDULES_B | remark is the only broad signal (167 of 288) |
| COST_ORG_ID | CST_COST_ORG_BOOKS 3, CST_COST_INV_ORGS 1, CST_COST_ORG_PARAMETERS 1 | CST_COST_ORGS_V ← COST_ORG_ID 15/67 | name sufficient (404/404 CST) |
| CONTROL_BUDGET_ID | XCC_CONTROL_BUDGETS 1 | XCC_CONTROL_BUDGETS ← 5/29 | name sufficient |
| INTERCO_ORG_ID | FUN_INTERCO_ORGANIZATIONS 1 | otbi: FUN_TRX_HEADERS.INITIATOR_ID / RECIPIENT_ID, FUN_TRX_BATCHES.INITIATOR_ID → INTERCO_ORG_ID (the real transaction tables carry the interco org under **different names**) | name rule misses the fact tables; needs a curated rule |
| ACCESS_SET_ID | GL_ACCESS_SETS 2 | GL_ACCESS_SETS ← URDA 4 stmts; GL_ACCESS_SET_LEDGERS ← URDA 2 | 14 objects, 3 MSC_DAS_* collide |
| CARRYING_OUT_ORGANIZATION_ID | none | HR_ORGANIZATION_V ← 4 tables / 60 stmts | all PJF/PJC/GTG; name sufficient |
| BU_ID | PJF_BU_IMPL_ALL 3 | FUN_ALL_BUSINESS_UNITS_V ← BU_ID 3/6; otbi: INV_ORG_PARAMETERS.BUSINESS_UNIT_ID, DOO_HEADERS_ALL.ORG_ID | name sufficient |

Expected ambiguous set overall: **≈ 72 ORGANIZATION_ID objects + the multi-context choice on
≈ 666 objects (627 two-context + 39 three-plus)** where the fact must name ONE primary context.
Everything else resolves by name (BU/ledger/book/cost/budget/DAS/project) or by the chain above.

---

## 3. Reference objects present in the catalog

Query `q3.sql` (schema.sqlite `tables` + `columns` + `view_text`). All present with columns
except where noted:

| Object | Type | cols | Key columns confirmed |
|---|---|---|---|
| FUN_USER_ROLE_DATA_ASGNMNTS | TABLE (FUN) | 59 | see URDA list below |
| FUN_ALL_BUSINESS_UNITS_V | VIEW | 21 | BU_ID = HR_ALL_ORGANIZATION_UNITS_F_VL.ORGANIZATION_ID with classification `FUN_BUSINESS_UNIT`; PRIMARY_LEDGER_ID, DEFAULT_SET_ID, LEGAL_ENTITY_ID from HR_ORGANIZATION_INFORMATION_X |
| FUN_USER_BO_DATA_ASSIGNMENTS_V | VIEW | 19 | full view text recovered (below) — the canonical context → object map |
| FUN_USER_ROLE_DATA_ASGNMNTS_V | — | — | **does not exist** in the catalog |
| GL_ACCESS_SET_LEDGERS | TABLE | 12 | ACCESS_SET_ID, LEDGER_ID, ACCESS_PRIVILEGE_CODE, START_DATE, END_DATE |
| GL_ACCESS_SETS | TABLE | 43 | (+ GL_ACCESS_SET_ASSIGNMENTS 13, GL_LEDGER_SET_ASSIGNMENTS present) |
| GL_LEDGERS | TABLE | 128 | |
| FA_BOOK_CONTROLS | TABLE | 201 | BOOK_TYPE_CODE, **BOOK_CONTROL_ID NUMBER**, SET_OF_BOOKS_ID, BOOK_CLASS (+ FA_MC_BOOK_CONTROLS) |
| FND_GRANTS | TABLE | 48 | GRANT_GUID, GRANTEE_TYPE, GRANTEE_KEY, MENU_ID, OBJECT_ID, INSTANCE_TYPE, INSTANCE_SET_ID, INSTANCE_PK1..5_VALUE, PARAMETER1..10, GRANT_TYPE, ROLE_NAME, START_DATE, END_DATE, CONTEXT_NAME, CONTEXT_VALUE |
| FND_OBJECTS | TABLE | 30 | OBJECT_ID, **OBJ_NAME**, DATABASE_OBJECT_NAME, PK1..5_COLUMN_NAME, FILTER_COLUMN_LIST |
| FND_FORM_FUNCTIONS | TABLE | 16 | FUNCTION_ID, **FUNCTION_NAME**, OBJECT_ID (+ _TL, _VL) |
| FND_OBJECT_INSTANCE_SETS | TABLE | 18 | INSTANCE_SET_ID, INSTANCE_SET_NAME, OBJECT_ID, **PREDICATE**, FILTER (XMLTYPE) |
| FND_SESSION_ROLE_SETS | TABLE | 5 | SESSION_ROLE_SET_KEY, ROLE_GUID, ROLE_NAME, LAST_CONNECT, ENTERPRISE_ID |
| FND_COMPILED_MENU_FUNCTIONS | TABLE | 6 | (+ FND_MENU_ENTRIES present) |
| PER_USERS | TABLE | 22 | USER_GUID, USERNAME, ACTIVE_FLAG |
| PER_ROLES_DN_VL | VIEW | 22 | ROLE_COMMON_NAME (+ PER_ROLES_DN, PER_USER_ROLES, ASE_USER_ROLE_MBR, ASE_USER_B) |
| CST_COST_ORGS_V | VIEW | 7 | COST_ORG_ID = HR org with classification `CST`, status 'A' |
| RCS_MFG_PARAMETERS | TABLE | 81 | ORGANIZATION_ID (the only org column) |
| INV_ORG_PARAMETERS | TABLE | 174 | ORGANIZATION_ID, MASTER_ORGANIZATION_ID, ITEM_DEFINITION_ORG_ID, BUSINESS_UNIT_ID, PROFIT_CENTER_BU_ID, MFG_PLANT_FLAG, MAINT_ORGANIZATION_ID |
| FUN_INTERCO_ORGANIZATIONS | TABLE | 51 | INTERCO_ORG_ID, LEGAL_ENTITY_ID, PAY_BU_ID, REC_BU_ID |
| XCC_CONTROL_BUDGETS | TABLE | 85 | CONTROL_BUDGET_ID, LEDGER_ID, CHART_OF_ACCOUNTS_ID, PROJECT_ID |
| FND_SETID_SETS_VL | VIEW | 10 | SET_ID, SET_CODE (over FND_SETID_SETS with LANGUAGE; FND_SETID_ASSIGNMENTS present) |
| HR_ORG_UNIT_CLASSIFICATIONS_F | TABLE | 19 | ORGANIZATION_ID, CLASSIFICATION_CODE, STATUS, SET_ID, effective dates |
| HR_ALL_ORGANIZATION_UNITS_F / _VL / _TL, HR_ORGANIZATION_V, HR_ORG_UNIT_CLASSIFICATIONS_X, HR_ORGANIZATION_INFORMATION_X, INV_ORGANIZATION_DEFINITIONS_V, RCS_ORG_DEFINITIONS_LW_V, PJF_ORG_HIERARCHY_DENORM, FUN_BUSINESS_OBJECT_MAPPING, FUN_BU_PERF_V, FUN_BU_USAGES(_V), GL_LEDGERS_PUBLIC_V, MO_GLOB_ORG_ACCESS_TMP (EBS relic) | all present | | |
| FND_GLOBAL, HZ_SESSION_UTIL, HRC_SESSION_UTIL, FND_PROFILE, FND_DATA_SECURITY, GL_ACCESS_SET_SECURITY_PKG, XLA_SECURITY_PKG, PJF_SECURITY_PKG | packages, `v2026_11.plsql_packages` `in_dictionary=1` | | FND_GLOBAL called by 635 statements (USER_GUID 342, USER_NAME 211, SESSION_ROLE_SET_KEY 176, GET_CONN_DS_ATTRIBUTE 169) |

**URDA context columns actually present** (12 typed, in `columns` ordinal order): `ORG_ID`,
`LEDGER_ID`, `BOOK_ID`, `SET_ID`, `INV_ORGANIZATION_ID`, `CST_ORGANIZATION_ID`,
`ITM_ORGANIZATION_ID`, `ACCESS_SET_ID`, `CONTROL_BUDGET_ID`, `INTERCO_ORG_ID`,
`PRJ_ORGANIZATION_ID`, `MFG_ORGANIZATION_ID` — the fixed 12-context list is confirmed. Two more
carriers exist: the generic `DATASEC_CONTEXT_TYPE_CODE` + `DATASEC_CONTEXT_VALUE1..5` (used in the
corpus for `ORA_PRJ_AWARD_ORG_HIER_ID`, `GMS_AWARD_HEADERS_B`, `ORA_CAMPUS_ID`) and
`COLLABORATION_DOC_ID`. Gate columns: `USER_GUID`, `ROLE_NAME`, `ACTIVE_FLAG` ('Y'/'N'),
`START_DATE_ACTIVE`, `END_DATE_ACTIVE` (remark: "Reserved for future use"), `ENTERPRISE_ID`.

`FUN_USER_BO_DATA_ASSIGNMENTS_V` (Oracle's own view text, verbatim) fixes the context → reference
object mapping and the type codes:

```
when org_id is not null            then 'ORA_BU_ID'               -> 'FUN_ALL_BUSINESS_UNITS_V'
when ledger_id is not null         then 'ORA_LEDGER_ID'           -> 'GL_LEDGERS'
when book_id is not null           then 'ORA_BOOK_CONTROL_ID'     -> 'FA_BOOK_CONTROLS'
when set_id is not null            then 'ORA_SET_ID'              -> 'FND_SETID_SETS_VL'
when inv_organization_id ...       then 'ORA_ORGANIZATION_ID'     -> 'INV_ORG_PARAMETERS'
when cst_organization_id ...       then 'ORA_COST_ORG_ID'         -> 'CST_COST_ORGS_V'
when access_set_id ...             then 'ORA_ACCESS_SET_ID'       -> 'GL_ACCESS_SETS'
when control_budget_id ...         then 'ORA_CONTROL_BUDGET_ID'   -> 'XCC_CONTROL_BUDGETS'
when interco_org_id ...            then 'ORA_INTERCO_ORG_ID'      -> 'FUN_INTERCO_ORGANIZATIONS'
when prj_organization_id ...       then 'ORA_PRJ_ORGANIZATION_ID' -> 'HR_ORG_UNIT_CLASSIFICATIONS_F'
when mfg_organization_id ...       then 'ORA_MFG_ORGANIZATION_ID' -> 'RCS_MFG_PARAMETERS'
-- ITM_ORGANIZATION_ID has NO branch in either CASE (only in the COALESCE of value1):
-- item org is not exposed as a business-object context by Oracle's own view.
```

The same view is also the grant-name resolver: `fnd_grants g, fnd_objects o, fnd_object_instance_sets
ois, fnd_menu_entries me, fnd_form_functions ff, fun_business_object_mapping bomap` with
`ois.created_by = 'SEED_DATA_FROM_APPLICATION' AND upper(ois.predicate) LIKE '%FUN_USER_ROLE_DATA_ASGNMNTS%'`
and `o.obj_name = bomap.fndds_object_name AND ff.function_name = bomap.fndds_privilege`.
`FUN_BUSINESS_OBJECT_MAPPING` (16 cols: FNDDS_OBJECT_NAME, FNDDS_PRIVILEGE, BOSS_BUSINESS_OBJECT,
ALLOWED_ACTIONS, seed-data columns) is Oracle's seeded catalogue of exactly the (OBJ_NAME,
FUNCTION_NAME) pairs Step 2 wants, and its rows are not in our dictionary (a data table).

Catalog noise seen while checking: **1,741 trailing-underscore objects** (e.g.
`FUN_USER_ROLE_DATA_ASGNMNTS_`, `GL_ACCESS_SETS_`, `FUN_INTERCO_ORGANIZATIONS_`) and 100 `MLOG$_*`
objects — copies that inflate every count above by a few units.

---

## 4. OTBI grant evidence

Queries: `q45.sql` (sqls.sqlite LIKE scan over `sql_for_parse` + `x_tables`/`x_predicates`),
`pg_inv2.sh`/`pg_grants.sh`/`pg_pairs.sh` (`work.r_tables`, `work.f_predicates`, regex over
`work.clear_sql.sql_text`).

Volumes:

| Measure | count |
|---|---|
| L2 units by source (sqls.sqlite) | otbi 85,688 · bip-report 6,389 · view 6,077 |
| L2 units with `FND_GRANTS` in text | **otbi 238** (0.28 %) · bip 2 · view 2 |
| L2 units listing FND_GRANTS in `x_tables` | otbi 234 · sql 1 · view 2 |
| L3 statements reading FND_GRANTS (`work.r_tables`) | **otbi 169** · catalog 3 · view 2 · bip 1 |
| L3 statements reading FND_SESSION_ROLE_SETS | otbi 168 · view 9 (always paired with FND_GRANTS in OTBI) |
| L3 statements reading FND_OBJECTS / FND_FORM_FUNCTIONS / FND_OBJECT_INSTANCE_SETS | 1 otbi each + 2 views (the BO_V definition) — never as a predicate source |
| `f_predicates` on FND_GRANTS | INSTANCE_SET_ID EQ 245 · INSTANCE_TYPE EQ 171 · GRANT_TYPE EQ 169 · START_DATE LTE 169 · END_DATE GTE 169 · OBJECT_ID EQ 168 · OBJECT_ID IN 1 · GRANTEE_TYPE EQ 1 |

**Names vs ids: only numeric ids occur.** Zero occurrences of `OBJ_NAME` / `FUNCTION_NAME` /
`INSTANCE_SET_NAME` in any statement. Literals: `OBJECT_ID = 300000000009596` (92), `= 300000000008651`
(49), `= 300000000008587` (14), `= 300000000008402` (11), `= 300000000000992` (2);
`FUNCTION_ID` appears only inside `fnd_compiled_menu_functions cmf WHERE cmf.function_id = <n>`.

Distinct (object_id, function_id, instance_set_id) triples across all 168 OTBI grant statements
(`pg_pairs.sh`; "secured tables" = co-read tables carrying one of the exact security columns):

| object_id | function_id | instance_set_id | stmts | instance-set predicate (verbatim) | secured tables co-read |
|---|---|---|---|---|---|
| 300000000009596 | 300000000012207 | 300000000009597 | 92 | `TO_CHAR(ItemBasePEO.INVENTORY_ORGANIZATION_ID) = GNT.PARAMETER1 AND GNT.PARAMETER2 IN (SELECT TO_CHAR(PARENT_ITEM_CLASS_ID) FROM EGP_IC_HIERARCHY WHERE ITEM_CLASS_ID = ItemBasePEO.ITEM_CATALOG_GROUP_ID)` | EGP_SYSTEM_ITEMS_B_V 92, EGP_SYSTEM_ITEMS_TL_V 15, HR_ORGANIZATION_UNITS_F_TL 13, EGP_ITEM_REVISIONS_B_V 11 — **item-class grants, not URDA** |
| 300000000008651 | 300000000012367 | 300000118327110 | 49 | `BU.BU_ID IN (SELECT ORG_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG!='N')` | FUN_ALL_BUSINESS_UNITS_V 49, DOO_FULFILL_LINES_ALL 44, DOO_HEADERS_ALL 37, DOO_LINES_ALL 31 — **BU context** |
| 300000000008587 | 300000000012225 | 300000118326121 | 14 | `Ledgers.LEDGER_ID IN (SELECT LEDGER_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG <> 'N')` | GL_LEDGERS 8, GL_JE_HEADERS 7, GL_DAILY_BALANCES 3, AR/AP_RECON_SUMMARY_DETAILS 2 — **ledger context, direct LEDGER_ID only** |
| 300000000008402 | 300000000011814 | 300000000008404 (+8405/06/08/11/12, 300000106631112, 300000138152902) | 11 | `SOURCE_OBJECT_CODE = GNT.PARAMETER1 [AND VISIBILITY_CODE = 'INTERNAL'|'EXTERNAL'|'PRIVATE' AND NotePEO.CREATED_BY = FND_GLOBAL.USER_NAME]` | notes (ZMM/CRM) — object-code grants, not URDA |
| 300000000000992 | 300000000002195 | 300000000000994 | 2 | `QRSLT.application = GNT.PARAMETER1` | PAY_STATS_FLOW_ACTIONS — payroll flow grants |
| (none — INSTANCE_TYPE='INSTANCE' / row-level) | | | 6 | `G.OBJECT_ID IN (300000000009596, 100000599659374) AND G.INSTANCE_TYPE='INSTANCE' AND G.INSTANCE_PK1_VALUE = I.INVENTORY_ITEM_ID AND G.INSTANCE_PK2_VALUE = I.ORGANIZATION_ID` | EGP_SYSTEM_ITEMS_B (custom BIP "BOM with Grants") |

So the corpus yields **exactly 2 URDA-context grant triples** (BU via DOO, ledger via GL/SLA) and
3 non-URDA grant families. Subject areas carrying FND_GRANTS: Product Management - Structures and
Components 37, Where Used 37, Item Catalog Category Hierarchy 31, Item Supplier Associations 30, DOO
Fulfillment Lines 25, Structures 9, GL Journals 7, DOO Process Instances 6, SFO 4, DOO Order Headers 4,
CRM notes 3×3 … (25 SAs).

**Coverage** (`pg_more.sh` B1, against `v2026_11.columns`, exact security names): secured objects
4,709; objects co-read in FND_GRANTS statements 196, of which secured **62 → 1.3 %**; objects
co-read in URDA statements 193, secured **97 → 2.1 %**. Per driving table the grant pair is known
for DOO_HEADERS_ALL / DOO_FULFILL_LINES_ALL / DOO_LINES_ALL / DOO_ORCHESTRATION_GROUPS (BU) and
GL_JE_HEADERS / GL_DAILY_BALANCES / AP_RECON_SUMMARY_DETAILS / AR_RECON_SUMMARY_DETAILS (ledger) —
and for nothing else.

Instance-set ids: the item/notes/payroll sets are seed-range ids (`3000000000xxxxx`); the two URDA
sets are `300000118327110` / `300000118326121` — a higher range that may be pod-generated. Cross-pod
stability of any of these ids is **unverified** (single demo pod).

Five real examples (verbatim, trimmed):

1. OTBI "Distributed Order Orchestration - Order Holds Real Time.Holds Details" (BU):
```
... WHERE ( EXISTS (SELECT NULL FROM fnd_grants gnt WHERE exists (SELECT /*+ index(fnd_session_role_sets FND_SESSION_ROLE_SETS_U1) no_unnest */ null FROM fnd_session_role_sets WHERE session_role_set_key = fnd_global.session_role_set_key and role_guid = gnt.grantee_key UNION ALL SELECT fnd_global.user_guid AS path FROM dual WHERE fnd_global.user_guid = gnt.grantee_key)  AND exists (select /*+ no_unnest */ null from fnd_compiled_menu_functions cmf where cmf.function_id = 300000000012367 and cmf.menu_id = gnt.menu_id)  AND gnt.object_id = 300000000008651 AND gnt.grant_type = 'ALLOW' AND gnt.instance_type = 'SET' AND gnt.start_date <= SYSDATE and (gnt.end_date is null or gnt.end_date >= sysdate) AND ((gnt.CONTEXT_NAME is NULL) or (gnt.context_name is not null and gnt.context_value like fnd_global.get_conn_ds_attribute(gnt.context_name)))  AND (gnt.instance_set_id = 300000118327110 AND BU_ID IN (SELECT ORG_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG!='N')))))
```
2. OTBI "Subledger Accounting - Payables Summary Reconciliation Real Time" (ledger):
```
FROM AP_RECON_SUMMARY_DETAILS ReconciliationSummaryPEO, GL_LEDGERS Ledgers WHERE (ReconciliationSummaryPEO.LEDGER_ID = Ledgers.LEDGER_ID) AND (( EXISTS (SELECT NULL FROM fnd_grants gnt WHERE ... cmf.function_id = 300000000012225 ... gnt.object_id = 300000000008587 ... AND (gnt.instance_set_id = 300000118326121 AND Ledgers.LEDGER_ID IN (SELECT LEDGER_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG <> 'N'))))))
```
3. OTBI "Product Management - Item Catalog Category Hierarchy Real Time.MPS MRP Planning" (item class):
```
FROM EGP_SYSTEM_ITEMS_B_V ItemBasePEO WHERE (((NVL(PUBLIC_FLAG, 'N') = 'Y') OR EXISTS (SELECT NULL FROM fnd_grants gnt WHERE ... cmf.function_id = 300000000012207 ... gnt.object_id = 300000000009596 ... AND (gnt.instance_set_id = 300000000009597 AND TO_CHAR(ItemBasePEO.INVENTORY_ORGANIZATION_ID) = GNT.PARAMETER1 AND GNT.PARAMETER2 IN (SELECT TO_CHAR(PARENT_ITEM_CLASS_ID) FROM EGP_IC_HIERARCHY WHERE ITEM_CLASS_ID = ItemBasePEO.ITEM_CATALOG_GROUP_ID)))))
```
4. OTBI "Compensation - Workforce Compensation Real Time.Compensation Notes" (object-code grants
ORed with ZCA_OBJECT_SHARE_VIEW access groups; `SOURCE_OBJECT_CODE = GNT.PARAMETER1`).
5. Custom BIP `/Custom/SCM/PLM/Build/BOM View - PD/Single Level BOM with Grants.xdm` — row-level
`INSTANCE_TYPE='INSTANCE'` grants joined on `INSTANCE_PK1_VALUE = INVENTORY_ITEM_ID AND INSTANCE_PK2_VALUE = ORGANIZATION_ID`, reporting the grants themselves (not a security filter).

Second voice — the Qwen `security` facts (`work.clear_sql.security`, 645 of 26,204 statements
flagged, 2.5 %): mechanism `user-own` 354, `data-security-grants` 247, `person-security` 55; top
tables FND_GRANTS 123, ZCA_OBJECT_SHARE_VIEW 85, ZCA_ACCESS_GROUP_MEMBERS_VIEW 83, URDA 47,
PER_PERSONS 37, FND_COMPILED_MENU_FUNCTIONS 31, FND_SESSION_ROLE_SETS 22. Third voice — the old
crawl `security_predicate_old` (1,574 OTBI L2 units, **15 distinct values**): 1,172 `P.PERSON_ID =
(SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-1)...)`, 304 `SVC_SERVICE_REQUESTS*.CREATED_BY =
FND_GLOBAL.USER_NAME`, 50 `FUN_ALL_BUSINESS_UNITS_V.BU_ID IN (SELECT ORG_ID FROM URDA ...)`, 11
partner `hz_parties.user_guid`. All three agree: the OTBI corpus secures HCM by person, CRM by
party/access group, and only DOO (BU) and GL/SLA (ledger) by URDA.

---

## 5. BIP corpus evidence and the templates

Counts (`q45.sql`, `pg_grants.sh`):

| Object in text | bip-report (6,389 L2) | catalog (crawl DMs, L3) | view (6,077) | otbi |
|---|---|---|---|---|
| FUN_USER_ROLE_DATA_ASGNMNTS | **2** (GL JournalAndTransactionDetailsDm — Oracle-shipped; `/Custom/FIN/Receivables/AR VB APP DATA(1)` — custom) | 6 (3 Orbit GLSense custom DMs, the two above) | **3** (FUN_USER_BO_DATA_ASSIGNMENTS_V, GMS_GDA_ORG_LIST_V, GMS_GDA_ONLY_ORG_V) | 66 L2 / 63 L3 |
| FND_GRANTS | 2 (BOM with Grants) | 3 | 2 (EGP_EXPLOSIONS_V, BO_V) | 238 / 169 |
| FUN_USER_BO_DATA_ASSIGNMENTS_V | 0 | 0 | 0 (only its own definition) | 0 |
| GL_ACCESS_SET_LEDGERS | 1 | 4 | 0 | 0 |
| FND_SESSION_ROLE_SETS | 0 | 0 | 9 | 233 |
| text `USER_GUID` | 48 | 52 | 59 | 610 (L3) |
| text `FND_GLOBAL.USER_ID` | **0** | 0 | 0 | 0 |
| text `FND_GLOBAL.USER_NAME` | 15 | 19 | 0 | 191 |
| text `SESSION_ROLE_SET_KEY` | **0** | 0 | 9 | 168 |

URDA predicate/join facts (`work.f_predicates` / `f_joins`): `ACTIVE_FLAG != 'N'` 49 statements,
`<> 'N'` 14, `= 'Y'` 4, `NVL(x.ACTIVE_FLAG,'N') != 'N'` 2; `DATASEC_CONTEXT_TYPE_CODE =` 5
(`ORA_PRJ_AWARD_ORG_HIER_ID` 3, `GMS_AWARD_HEADERS_B` 1, `ORA_CAMPUS_ID` 1); joins
`GL_ACCESS_SETS.ACCESS_SET_ID = URDA.ACCESS_SET_ID` 4, `PER_USERS.USER_GUID = URDA.USER_GUID` 3,
`GL_ACCESS_SET_LEDGERS.{ACCESS_SET_ID,LEDGER_ID} = URDA.{…}` 2, `PER_ROLES_DN_VL.ROLE_COMMON_NAME =
URDA.ROLE_NAME` 2, `URDA.ROLE_NAME = FND_SESSION_ROLE_SETS.ROLE_NAME` 2, `URDA.ORG_ID =
HR_ALL_ORGANIZATION_UNITS_F_VL.ORGANIZATION_ID` 1, and the four `DATASEC_CONTEXT_VALUE1..4 =
PJF_ORG_HIERARCHY_DENORM.{TREE_STRUCTURE_CODE,TREE_VERSION_ID,PARENT_ORGANIZATION_ID,TREE_CODE}`.
No statement anywhere uses `START_DATE_ACTIVE` / `END_DATE_ACTIVE`.

Verbatim shapes:

(a) Oracle-shipped BIP data model, `/Financials/General Ledger/Journals/Data Models/JournalAndTransactionDetailsDm.xdm` (ledger; the ONLY Oracle-authored BIP security shape in the corpus):
```sql
FROM gl_ledgers gl, gl_access_set_ledgers gasl, fun_user_role_data_asgnmnts urda
WHERE gl.ledger_id IN (:p_ledger)
  AND GL.OBJECT_TYPE_CODE = 'L'
  AND urda.active_flag = 'Y'
  -- Security is implemented only for the Ledger parameter LOV ... enforces Ledger security when the user selects a Ledger Set
  AND urda.user_guid = FND_GLOBAL.USER_GUID
  AND (gasl.access_set_id = urda.access_set_id OR gasl.ledger_id = urda.ledger_id)
  AND gl.ledger_id = gasl.ledger_id
  AND gasl.access_set_id = :p_data_access_set
```
(b) Oracle view `GMS_GDA_ORG_LIST_V` (project org, role-aware, DB-session context):
```sql
select ORGD.CHILD_ORGANIZATION_ID
 from FUN_USER_ROLE_DATA_ASGNMNTS FURD, PJF_ORG_HIERARCHY_DENORM ORGD, FND_SESSION_ROLE_SETS SROLE
 where FURD.USER_GUID = FND_GLOBAL.USER_GUID
 and FURD.ROLE_NAME   =  SROLE.ROLE_NAME
 and SROLE.SESSION_ROLE_SET_KEY = FND_GLOBAL.SESSION_ROLE_SET_KEY
 and NVL(FURD.ACTIVE_FLAG,'N')     != 'N'
 and FURD.DATASEC_CONTEXT_TYPE_CODE = 'ORA_PRJ_AWARD_ORG_HIER_ID'
 and FURD.DATASEC_CONTEXT_VALUE1 = ORGD.TREE_STRUCTURE_CODE ... VALUE4 = ORGD.TREE_CODE
 union all
 select a.PRJ_ORGANIZATION_ID from FUN_USER_ROLE_DATA_ASGNMNTS a, FND_SESSION_ROLE_SETS SROLE
  where a.USER_GUID = FND_GLOBAL.USER_GUID and NVL(a.ACTIVE_FLAG,'N') != 'N'
  and a.ROLE_NAME = SROLE.ROLE_NAME and SROLE.SESSION_ROLE_SET_KEY = FND_GLOBAL.SESSION_ROLE_SET_KEY
  and a.PRJ_ORGANIZATION_ID is not null
```
(c) Oracle OTBI physical SQL (BU / ledger) — the `EXISTS (SELECT NULL FROM fnd_grants gnt WHERE
<role membership via FND_SESSION_ROLE_SETS UNION ALL direct user grant> AND <function via
FND_COMPILED_MENU_FUNCTIONS> AND gnt.object_id = … AND grant_type='ALLOW' AND instance_type='SET' AND
start_date <= SYSDATE AND (end_date IS NULL OR end_date >= SYSDATE) AND <CONTEXT_NAME clause> AND
(gnt.instance_set_id = … AND <col> IN (SELECT <urda col> FROM FUN_USER_ROLE_DATA_ASGNMNTS WHERE
USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG != 'N'))))` of §4.
(d) Custom BIP `AR VB APP DATA(1)`: `ROLE.ORG_ID = ORG.ORGANIZATION_ID AND pu.USER_GUID = role.USER_GUID
AND ROLE.ROLE_NAME LIKE 'ORA_AR%MANA%'` — no active flag, no role membership check (a listing report).
(e) Custom Orbit GLSense: `gl.ACCESS_SET_ID = ROLE.ACCESS_SET_ID AND pu.USER_GUID = ROLE.USER_GUID AND
PER_ROLES_DN_VL.ROLE_COMMON_NAME = ROLE.role_name AND gl.ENABLED_FLAG='Y' AND ROLE.ACTIVE_FLAG='Y'`.

### Template verdicts (against variants A / B / C)

| Point | Draft | Oracle's own SQL says | Verdict |
|---|---|---|---|
| Identity key | `USER_GUID` vs `USER_ID` | `urda.USER_GUID = FND_GLOBAL.USER_GUID` in 100 % of Oracle shapes; `FND_GLOBAL.USER_ID` occurs 0 times in 26,204 statements; `PER_USERS` is joined only to print a username | **USER_GUID, no PER_USERS join** |
| Active flag | ? | `ACTIVE_FLAG != 'N'` / `<> 'N'` (63 OTBI), `NVL(ACTIVE_FLAG,'N') != 'N'` (Oracle views), `= 'Y'` only in the shipped GL DM and custom SQL; date columns never used | **`NVL(urda.ACTIVE_FLAG,'N') <> 'N'`; no START/END_DATE_ACTIVE** |
| Role gate | A: FND_GRANTS EXISTS | OTBI ties `URDA.ROLE_NAME = GNT.ROLE_NAME` and proves membership through `FND_SESSION_ROLE_SETS.SESSION_ROLE_SET_KEY = FND_GLOBAL.SESSION_ROLE_SET_KEY` (or a direct user grant). **0 of 6,389 BIP units use SESSION_ROLE_SET_KEY**; Oracle's shipped BIP DM (a) uses URDA with **no role or grant check at all** | The FND_GRANTS wrapper is Oracle's ADF/OTBI mechanism; whether `FND_GLOBAL.SESSION_ROLE_SET_KEY` is populated in a BIP-executed session is **unproven in the corpus** (must be tested on the pod). Default template = URDA-only (Oracle's own BIP precedent); role-aware variant = URDA ⋈ FND_SESSION_ROLE_SETS as in (b), gated on a pod test |
| Grant names | A: `FND_OBJECTS.OBJ_NAME`, `FND_FORM_FUNCTIONS.FUNCTION_NAME` | never present in SQL (numeric ids only, 5 triples); names live in pod data (`FUN_BUSINESS_OBJECT_MAPPING`, `FND_OBJECTS`, `FND_FORM_FUNCTIONS`) | **cannot be mined from the corpus**; if wanted, extract once from the pod via the BO_V join path (read-only SQL) |
| Instance-set matching | A: IN-list | Oracle's URDA instance sets are literally `<col> IN (SELECT <urda col> FROM URDA WHERE USER_GUID = FND_GLOBAL.USER_GUID AND ROLE_NAME = GNT.ROLE_NAME AND ACTIVE_FLAG != 'N')`; `FND_OBJECT_INSTANCE_SETS.PREDICATE` holds this text on the pod | IN-list confirmed; per-role correlation only meaningful inside the grant wrapper |
| B: ledger | `GL_ACCESS_SET_LEDGERS UNION direct LEDGER_ID` | shipped GL DM: `(gasl.access_set_id = urda.access_set_id OR gasl.ledger_id = urda.ledger_id) AND gl.ledger_id = gasl.ledger_id`; OTBI GL/SLA: direct `LEDGER_ID IN (SELECT LEDGER_ID FROM URDA …)` only | **B confirmed** (OR ≡ UNION); OTBI's direct-only form under-secures users granted a data access set (URDA.ACCESS_SET_ID set, LEDGER_ID null) — keep the UNION |
| C: asset book | `BOOK_TYPE_CODE IN (… FA_BOOK_CONTROLS WHERE BOOK_CONTROL_ID = urda.BOOK_ID)` | BO_V: `book_id → 'ORA_BOOK_CONTROL_ID' → 'FA_BOOK_CONTROLS'`; `FA_BOOK_CONTROLS.BOOK_CONTROL_ID NUMBER` exists; **0 corpus statements** join URDA to FA | structurally right, **unverified** (needs one pod probe: `SELECT BOOK_TYPE_CODE FROM FA_BOOK_CONTROLS WHERE BOOK_CONTROL_ID IN (SELECT BOOK_ID FROM URDA WHERE …)`) |
| Reference-object hop | join to FUN_ALL_BUSINESS_UNITS_V / GL_LEDGERS etc. | OTBI filters the data column directly (`BU_ID IN (SELECT ORG_ID …)`, `LEDGER_ID IN (SELECT LEDGER_ID …)`) — no reference join for BU/ledger | join through the reference object only where the data column is not the URDA key (book: BOOK_TYPE_CODE ↔ BOOK_CONTROL_ID; cost org, inv org, mfg org and project org share the HR org id and need no hop) |

Corrected canonical templates (URDA-only core; `<col>` = the table's security column):

```sql
-- BU / cost org / inv org / mfg org / project org / control budget / interco / set / DAS (direct key)
<col> IN (SELECT urda.<URDA_COL>
            FROM FUN_USER_ROLE_DATA_ASGNMNTS urda
           WHERE urda.USER_GUID = FND_GLOBAL.USER_GUID
             AND NVL(urda.ACTIVE_FLAG,'N') <> 'N'
             AND urda.<URDA_COL> IS NOT NULL)

-- ledger (variant B, confirmed)
<ledger_col> IN (SELECT urda.LEDGER_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS urda
                  WHERE urda.USER_GUID = FND_GLOBAL.USER_GUID AND NVL(urda.ACTIVE_FLAG,'N') <> 'N'
                    AND urda.LEDGER_ID IS NOT NULL
                 UNION
                 SELECT gasl.LEDGER_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS urda, GL_ACCESS_SET_LEDGERS gasl
                  WHERE urda.USER_GUID = FND_GLOBAL.USER_GUID AND NVL(urda.ACTIVE_FLAG,'N') <> 'N'
                    AND gasl.ACCESS_SET_ID = urda.ACCESS_SET_ID)

-- asset book (variant C, structurally derived, UNVERIFIED on a pod)
<book_col> IN (SELECT bc.BOOK_TYPE_CODE FROM FA_BOOK_CONTROLS bc, FUN_USER_ROLE_DATA_ASGNMNTS urda
                WHERE bc.BOOK_CONTROL_ID = urda.BOOK_ID
                  AND urda.USER_GUID = FND_GLOBAL.USER_GUID AND NVL(urda.ACTIVE_FLAG,'N') <> 'N')

-- optional role-membership tightening (Oracle view idiom; needs the BIP-session probe first)
  AND EXISTS (SELECT 1 FROM FND_SESSION_ROLE_SETS s
               WHERE s.SESSION_ROLE_SET_KEY = FND_GLOBAL.SESSION_ROLE_SET_KEY
                 AND s.ROLE_NAME = urda.ROLE_NAME)
```

Item org: no `ORA_…` type code exists; for EGP_* item tables use
`ORGANIZATION_ID IN (SELECT INV_ORGANIZATION_ID … UNION SELECT ITM_ORGANIZATION_ID …)` — zero evidence
either way.

---

## 6. Existing fact seams (compute → store → serve)

| Fact | COMPUTED | STORED | SERVED |
|---|---|---|---|
| `mostlyUsedFilters` | Postgres release: `scripts/pipeline/p5_fill.sql` §"table_predicates" — `work.f_predicates ⋈ corpus`, `occurrences = count(DISTINCT sql_hash)`, `role = discriminator` at ≥ 8 distinct literals, drops 6+-digit literals on `*_ID`. SQLite legacy: `scripts/gpu-enrich/import_serving.mjs` "LAST STEP" (from `x_predicates`). Runtime rebuild: `src/corpus/predicateMiner.ts` `rebuildPredicateRegistry()` / `ensurePredicateRegistry()` (reads `report_queries.filters`; version-gated) | `v<ver>.table_predicates` + `pred_meta` (`scripts/pg-import/ddl.sql`; sqlite `src/db/sqlite/ddl.ts` in `reports.sqlite`); role `version` in `src/db/postgres/schemas.ts` ROLE map | `src/catalog.ts mostlyUsedStats()` → `db().registries.topPredicates(n, 8)` (`src/db/base/registries.ts`) → field `mostlyUsedFilters` |
| `mostlyUsedJoinFilters` | `p5_fill.sql` §"table_join_columns" — `work.f_joins` both sides / `r_tables` denominator, `share >= 0.20`; legacy `import_serving.mjs:177-235`; **no runtime rebuild** | `v<ver>.table_join_columns` (PK table,column) | `db().corpus.joinColumnStats(n, 8)` (`src/db/base/corpus.ts`) → `mostlyUsedJoinFilters` |
| `grainWarning` / `table_grain` | `p5_fill.sql` §"table_grain" (`grain_sig` from `work.meta_columns` by ordinal + `grain_ev` corpus corroboration, `grain_meta.version = 4`); runtime `src/corpus/grainRegistry.ts` `rebuildGrainRegistry()` / `ensureGrainRegistry()` (GRAIN_VERSION gate) called from `src/server.ts` `app.listen` | `v<ver>.table_grain` + `grain_meta` | **pull-only** since 2026-08-12: `getTableGrain` → `catalog.grainFor()` → `db().registries.grain()` (+ curated `table_rules`, `commonPredicates`); `validateTable` no longer pushes it (its tool description in `src/tools.ts:92` still says "each entry returns its grain warning" — stale text, untouched) |
| `mostlyUsedApis` | `scripts/pipeline/p3_calls.sql` (`work.f_calls`) → `p3_calls.py`/`p3_calls.sh` → `p3_calls_post.sql` (`work.plsql_api`, `plsql_api_tables`, `plsql_packages`) → `p5_plsql.sql` projection into `v<ver>`; **no runtime rebuild** (`db().plsql.replaceAll` exists for the upgrade job/tests only) | `v<ver>.plsql_api`, `plsql_api_tables`, `plsql_packages`, `plsql_meta` (ddl_version 3) | `db().plsql.forTable(n, 5)` filtered `table_statements >= 2` (`src/db/base/plsql.ts`) → `mostlyUsedApis [{api, statements, share}]`; unbounded via `findPlsqlApi({table})` |
| `topUsages` | `p5_fill.sql` §"table_usages" / `src/corpus/usageGraph.ts` `rebuildUsageGraph()` / `ensureUsageGraph()` | `v<ver>.table_usages` + `usage_meta` | `catalog.tableUsages(name,{limit:3,brief:true})` on `validateTable` (single) and `getTableGrain` |

Payload fan-out (`src/catalog.ts`): `getTable` (l.60), `getColumns` plain (l.89) and semantic branch
(`src/tools.ts:78` spreads `mostlyUsedStats` next to `searchColumns`), `validateColumns` (l.298),
`validateTable` single (l.148–158, + `topUsages`), `validateTable names[]` dossier
(`src/tools.ts:100–116`: caps filters 5 / joinFilters 5 / apis 3, no usages). Provider seam:
`src/db/provider.ts` (`RegistriesApi`, `PlsqlApi`, `CorpusApi.joinColumnStats`), row types
`src/db/types.ts` (`PredicateStat`, `JoinColumnStat`, `PlsqlApiForTable`), Postgres routing
`src/db/postgres/schemas.ts` (`table_predicates: "version"` …), contract test `test/dbContract.test.ts`
runs both providers.

Boot behaviour: `src/server.ts` calls the three `ensure*` on every start; on Postgres they find the
release's rows + version stamps and do nothing (`PostgresProvider.open()` only `meta.verify()`s —
`src/db/postgres/provider.ts:11`). Served DB `fusion` is at `v2026_11` (rows: table_predicates
15,459; table_join_columns 15,662; table_grain 3,792; plsql_api_tables 14,514).

One pre-existing per-statement security field exists — `report_queries.security_predicate`
(`src/corpus/otbiMeta.ts` SEC regex over the crawl `filters`, served as `securityPredicate` by
`getReportQuery`, `src/catalog.ts:603`) — but the pipeline README lists the OTBI relations block as
excluded from the Postgres build, so it is not a seam to build on.

---

## 7. Gaps and risks

1. **Nine of twelve contexts have zero URDA corpus evidence**: asset book, reference data set,
   inventory org, item org, cost org, manufacturing org, intercompany org, control budget, and data
   access set (only appears as the ledger LOV join). Evidence exists only for BU (49 OTBI + 1 shipped
   + 1 custom), ledger (14 OTBI + shipped GL DM), project org (2 Oracle GMS views incl. hierarchy).
   Templates for the nine are structural inferences from `FUN_USER_BO_DATA_ASSIGNMENTS_V`.
2. **Grant names do not exist in the corpus**; 5 numeric (object, function, instance set) triples cover
   all 168 OTBI grant statements; 2 of them are URDA contexts. `FND_GRANTS` gating in a BIP-executed
   session is unproven (`SESSION_ROLE_SET_KEY` never appears in BIP SQL; Oracle's own shipped BIP DM
   omits it). Risk: variant A returns zero rows under BIP if the session role set is not populated.
3. **`%_SET_ID` is not a reference-data pattern** (1,635 objects, dominated by ASSET_ID 263,
   DATA_SET_ID 121, CATEGORY_SET_ID 94, CUST_SET_ID 83, VALUE_SET_ID 78, RULE_SET_ID 64). `SET_ID`
   exact: 288 objects, 167 with the "reference data set" remark, 121 unremarked views, 0 FKs.
   `ACCESS_SET_ID`: 3 of 14 are `MSC_DAS_*` (planning). `BOOK_TYPE_CODE` outside FA: 25 (GTG_* 16 GRC
   ETL copies, PJF_BU_IMPL* 3 = default book per BU setup, PJC 3, JG/JE/FUN). `CONTROL_BUDGET_ID`
   outside XCC: 21 (AR, IBY, FV, EXM, PO, FUN, POR, GL, AP, XLA, PJC, CMR — budget references on
   transactions, not budget-secured rows).
4. **HCM**: `ORG_ID` does not occur on any PER_/HR_/PAY_/BEN_ table (0); it occurs on HES_* (36,
   higher-ed, remark "business unit") and CN_* (294 = 29 % of all ORG_ID tables — incentive comp is
   BU-striped; fine). `ORGANIZATION_ID` on HCM prefixes = **136–144 objects** (HR organization /
   department / business group, not an inventory org) → hard exclude list. `SET_OF_BOOKS_ID` on PER
   views (12) and `LEDGER_ID` on PER_ALL_ASSIGNMENTS_M are payroll costing ledgers — exclude.
5. **One id space, many contexts**: FUN_ALL_BUSINESS_UNITS_V, CST_COST_ORGS_V, INV_ORG_PARAMETERS,
   RCS_MFG_PARAMETERS and the project-org classification all key on
   `HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID`. A numeric value cannot tell BU from cost org from
   plant; only the table's module can. `ORGANIZATION_ID` FK coverage is 6.3 %, corpus-join coverage
   19.4 %; after the full chain 72 objects (51 T / 21 V) stay ambiguous, and the inv-vs-mfg choice on
   the 236 mfg/maint/quality objects is a business ruling (plants ⊂ inventory orgs).
6. **Multi-context tables need ONE primary context** (627 two, 39 three-plus): AP/AR/PO/POZ/DOO/PJC
   carry ORG_ID + SET_OF_BOOKS_ID (+ `*_ORGANIZATION_ID`); GL/XLA/XCC carry LEDGER_ID; PJF_PROJECTS_ALL_B
   carries ORG_ID + CARRYING_OUT_ORGANIZATION_ID. Securing on the derived column (ledger on an AP
   invoice) over-restricts; securing on none of the several BU columns (PO_HEADERS_ALL: PRC/REQ/
   BILLTO/SOLDTO_BU_ID) under-restricts. Oracle's own OTBI choice is visible only for DOO (ORG_ID)
   and GL/SLA (LEDGER_ID).
7. **Name-rule misses**: `BUSINESS_UNIT_ID` (408 objects) escapes both `ORG_ID` and `%_BU_ID`;
   `INVENTORY_ORG_ID` (290) and `INVENTORY_ORGANIZATION_ID` (114) escape `ORGANIZATION_ID`;
   intercompany transactions carry the interco org as `FUN_TRX_HEADERS.INITIATOR_ID` /
   `RECIPIENT_ID` (otbi_relations) — no name rule finds them.
8. **Views**: 1,113 views carry a security column and have view text; only 16 views already embed
   security (4 of them with a security column: EGP_EXPLOSIONS_V, FUN_USER_BO_DATA_ASSIGNMENTS_V,
   GMS_GDA_*), so double-securing is rare but the rule must skip them. Views alias the HR org id as
   `BU_ID` / `COST_ORG_ID` (FUN_ALL_BUSINESS_UNITS_V, CST_COST_ORGS_V), so a view's security column may
   be a renamed base column — the fact must be computed on the view's own column names, never
   inherited from its base table by position.
9. **Catalog noise**: 1,741 trailing-underscore duplicate objects and 100 `MLOG$_*` objects carry the
   same columns as their originals; 62 `LEDGER_ID` columns are remarked "internal use only".
10. Instance-set ids `300000118327110` / `300000118326121` may be pod-generated; all grant ids are
    from one demo pod — never hard-code them into a template.
11. `%_LEDGER_ID` (127) mixes real ledger keys (PRIMARY/SECONDARY/SOURCE/TARGET_LEDGER_ID) with
    `CMR_SUB_LEDGER_ID` (13) and `EXCLUDED_SUBLEDGER_ID` — "subledger" is an application id, not a ledger.

---

## Recommendations for Step 2

### Detection rules (per object, in order; first hit wins per context, several contexts allowed)

1. **Exclusions first**: name `LIKE 'MLOG$%'` or ends with `_`; HCM prefixes (PER, HR, PAY, BEN, HRC,
   HRT, IRC, CMP, ANC, HXT, HWM, HRG, HRY, HWR, HEY, WLF) for `ORGANIZATION_ID` / `SET_OF_BOOKS_ID` /
   `LEDGER_ID`; the 16 views that already embed URDA/FND_GRANTS/HZ_SESSION_UTIL; columns whose remark
   is "internal use only" / "no longer used"; `MSC_DAS_*` for ACCESS_SET_ID; GTG_* everywhere.
2. **Exact-name rules** (confidence `name`): `ORG_ID`, `BU_ID`, `BUSINESS_UNIT_ID` → BU (`urda.ORG_ID`);
   `LEDGER_ID`, `SET_OF_BOOKS_ID` → ledger (variant B); `ACCESS_SET_ID` → DAS; `BOOK_TYPE_CODE` on
   `FA_%` → asset book (variant C); `SET_ID` with the reference-data remark (or on FND/HZ/AR/RA/PER/HR/
   PJF/QP/ZX/FA/CST/POZ/PO/IBY/CE prefixes) → reference data set; `COST_ORG_ID` → cost org;
   `CONTROL_BUDGET_ID` on `XCC_%` → control budget; `INTERCO_ORG_ID` → interco;
   `CARRYING_OUT_ORGANIZATION_ID`, `PJC_ORGANIZATION_ID`, `EXPENDITURE_ORGANIZATION_ID` → project org;
   `INV_ORG_ID`, `INVENTORY_ORG_ID`, `INVENTORY_ORGANIZATION_ID`, `INV_ORGANIZATION_ID` → inventory org.
3. **Suffix rules** only where no exact column exists on the object: `%_BU_ID` → BU (the *primary*
   BU column = the first of PRC_BU_ID, REQ_BU_ID, ORG_ID-like by ordinal, recorded as `primary=1`,
   others `primary=0`); `PRIMARY_LEDGER_ID` / `SECONDARY_LEDGER_ID` → ledger; never `%_SET_ID`.
4. **`ORGANIZATION_ID` chain**: FK parent (INV_ORG_PARAMETERS / EGP_* / INV_* → inv org;
   RCS_MFG_PARAMETERS → mfg) → corpus join target family (`work.f_joins`: inv / mfg / project / hr) →
   prefix domain (INV, RCV, WSH, EGP, EGO, CST, CMR, MSC, MSS, SCH, DOS, CMK → inv; WIE, WIS, WIP, RCS,
   MNT, CSE, QA, QSC → mfg; PJF, PJC, PJB, PJS, PJT, PJO, PJR, GMS → project) → sibling columns
   (INVENTORY_ITEM_ID / SUBINVENTORY_CODE → inv; WORK_ORDER_ID / WORK_DEFINITION_ID / WORK_CENTER_ID →
   mfg; PROJECT_ID / TASK_ID → project; PERSON_ID / ASSIGNMENT_ID / BUSINESS_GROUP_ID → HCM, exclude)
   → else `ambiguous` (expected ≈ 72). EGP_* item tables get inv ∪ item (`INV_ORGANIZATION_ID UNION
   ITM_ORGANIZATION_ID`); mfg tables get `MFG_ORGANIZATION_ID` with a note that the same id is an
   inventory org (ruling to confirm).
5. **Curated overrides** (`table_rules`-style, few rows): FUN_TRX_HEADERS/BATCHES `INITIATOR_ID`,
   `RECIPIENT_ID` → interco; PJF_BU_IMPL* BOOK_TYPE_CODE → none; DOO_* → BU on ORG_ID (Oracle
   precedent); GL_JE_HEADERS, GL_BALANCES, GL_DAILY_BALANCES, XLA_AE_* → ledger (Oracle precedent).
6. **Primary context per object** = module-family default (AP/AR/PO/POZ/DOO/PJC/EXM/IBY/CN → BU;
   GL/XLA/XCC/FV → ledger; FA → book; INV/EGP/WSH/RCV/MSC → inv org; CST → cost org; WIE/WIS → mfg org;
   PJF → project org; FUN interco tables → interco; XCC balances → control budget), all other detected
   columns kept as `secondary` facts so the agent can see them but applies one by default.

### Storage shape (both providers, same pattern as `table_predicates` / `plsql_api_tables`)

```
table_security (
  table_name    text NOT NULL,
  column_name   text NOT NULL,
  context       text NOT NULL,   -- BU|LEDGER|DAS|BOOK|SET|INV_ORG|ITM_ORG|COST_ORG|MFG_ORG|PRJ_ORG|INTERCO|BUDGET
  urda_column   text NOT NULL,   -- ORG_ID|LEDGER_ID|ACCESS_SET_ID|BOOK_ID|SET_ID|INV_ORGANIZATION_ID|...
  variant       text NOT NULL,   -- direct|ledger_union|book_via_controls|item_inv_union
  ref_object    text,            -- FUN_ALL_BUSINESS_UNITS_V|GL_LEDGERS|FA_BOOK_CONTROLS|...
  ref_column    text,
  is_primary    integer NOT NULL,
  confidence    text NOT NULL,   -- oracle_precedent|fk|corpus_join|name|prefix|sibling|curated|ambiguous
  evidence      integer NOT NULL DEFAULT 0,  -- distinct corpus statements backing the resolution
  reason        text,
  PRIMARY KEY (table_name, column_name, context)
);
table_grants (  -- the OTBI-mined grant triples; tiny, per driving table
  table_name text, object_id text, function_id text, instance_set_id text,
  obj_name text NULL, function_name text NULL,          -- filled only by a pod extract
  instance_predicate text, statements integer, PRIMARY KEY (table_name, object_id, function_id, instance_set_id)
);
sec_meta (k PRIMARY KEY, v)   -- 'version', 'built_at', 'source_release'
```

Computed by a new `scripts/pipeline/p5_security.sql` (same place as `p5_plsql.sql`: reads
`work.meta_columns`, `work.meta_fkeys`, `work.f_joins`, `work.f_predicates`, `work.r_tables`, regex
over `work.clear_sql.sql_text` for the triples; projects into `v<ver>` in one transaction) plus a
small curated-rules JSON input (like the layout-pattern corpus). DDL in `scripts/pg-import/ddl.sql`
and `src/db/sqlite/ddl.ts`; `table_security: "version"`, `table_grants: "version"`, `sec_meta:
"version"` in `src/db/postgres/schemas.ts`; a new library group `db().security` in
`src/db/base/security.ts` (portable SQL: `forTable(table)`, `count()`, `version()`, `replaceAll()`)
added to `CatalogProvider` in `src/db/provider.ts` and to `test/dbContract.test.ts`. No boot-time
rebuild (same rule as plsql: pipeline-built, `verify()` only).

### Payload shape

Pushed by `mostlyUsedStats()` next to `mostlyUsedFilters` on every table payload
(`getTable`, `getColumns` incl. semantic branch, `validateColumns`, `validateTable`; the `names[]`
dossier keeps the primary row only):

```
dataSecurity: [{
  column: "ORG_ID", context: "BU", primary: true, confidence: "oracle_precedent",
  predicate: "ORG_ID IN (SELECT urda.ORG_ID FROM FUN_USER_ROLE_DATA_ASGNMNTS urda WHERE urda.USER_GUID = FND_GLOBAL.USER_GUID AND NVL(urda.ACTIVE_FLAG,'N') <> 'N' AND urda.ORG_ID IS NOT NULL)",
  reference: "FUN_ALL_BUSINESS_UNITS_V.BU_ID",
  reason: "49 OTBI statements secure DOO_* on ORG_ID via URDA; column remark = business unit"
}]
```

plus a pull tool `getTableSecurity(table)` returning all rows, the grant triples, and the
ambiguity note. Agent contract mirrors `mostlyUsedFilters`: apply the primary predicate, ask, or say
why not — with `ambiguous` rows always escalated to an ask.

### Verification Step 2 must do on the pod before shipping templates

1. `SELECT FND_GLOBAL.SESSION_ROLE_SET_KEY, FND_GLOBAL.USER_GUID FROM DUAL` through a BIP data model
   run as a real user — decides whether the role-aware variant is usable in BIP.
2. Variant C probe on FA (one query).
3. One-time read-only extract of `FUN_BUSINESS_OBJECT_MAPPING` ⋈ `FND_OBJECTS` ⋈ `FND_FORM_FUNCTIONS`
   ⋈ `FND_OBJECT_INSTANCE_SETS.PREDICATE` (the BO_V join path) if grant NAMES are wanted in
   `table_grants` — the corpus cannot supply them.

### Estimated ambiguous set

≈ 72 `ORGANIZATION_ID` objects (51 tables / 21 views) with no resolving signal, plus the primary-
context choice on ≈ 666 multi-context objects, which the module-family default resolves except for
cross-module tables (PJF_PROJECTS_ALL_B: BU vs project org; INV_ORG_PARAMETERS: inv org vs BU) —
expect a curated list of 20–40 rows. Contexts with no corpus backing at all (9 of 12) ship at
confidence `name`/`prefix`, never `oracle_precedent`.

---

## 8. Oracle's own policies vs the v2027_02 facts (2026-09-30, release v2027_03)

Input: `scripts/pipeline/oracle_datasec_policies.csv` — Oracle's seeded instance sets whose predicate
uses URDA (FND_OBJECTS x FND_OBJECT_INSTANCE_SETS; 150 sets on 60 objects, 7 predicates cut at 1,000
chars; provenance in `scripts/pipeline/README.md`). `p5_security.sql` now takes them as the top
source (`oracle_policy`) and derives the module org family from their set codes; every set's parse
is in `v2027_03.sec_meta` (`policy_sets`, `policy_columns`, `module_families`).

**Parse** (all 150 classified, none guessed): 78 `direct` (the object's column IN a URDA context
column — incl. ADF-alias, unqualified, TO_CHAR, OR/EXISTS-wrapped and EAM-narrowed forms) → 54 policy
columns; 49 `derived` (a mapping object between URDA and the column: setid assignments, GL access
set ledgers, ledger relationships, cost-org books, HR org info, interco orgs, project BU/org, HTS
zones / work centers); 16 `datasec` (DATASEC_CONTEXT: legal entity, budget level, award org
hierarchy — not one of the twelve contexts); 6 `exists` (another object: PO line locations / WIE
work orders, interco master orgs / LE, alloc runs); 1 `non_context` (URDA.COLLABORATION_DOC_ID).

**The 54 policy columns vs v2027_02**: 46 match (same context; confidence becomes `oracle_policy`);
1 context change — `RCS_MFG_PARAMETERS.ORGANIZATION_ID` INV_ORG (corpus vote) → MFG_ORG; 3 missed by
our rules — `DOS_SUPPLY_LINES.DESTINATION_ORGANIZATION_ID` (INV_ORG), `FA_BOOK_CONTROLS.BOOK_CONTROL_ID`
(BOOK, direct on URDA.BOOK_ID), `FUN_INTERCO_MASTER_DOCUMENTS.PROVIDER_ORG_ID` (INTERCO); 3 absent from
our dictionary — `CSE_ASSETS_B.ORGANIZATION_ID`, `JV_JOINT_VENTURES_VL.BU_ID`,
`PJF_ALL_ORGANIZATIONS.CARRYING_OUT_ORGANIZATION_ID`; 1 conflict, no fact —
`XLA_TRANSACTION_ENTITIES.SECURITY_ID_INT_1` (BU for one application, cost org for another, via the
grant's PARAMETER1). One column, several contexts: `INV_ORG_PARAMETERS.ORGANIZATION_ID` INV (ENQ /
MNT / PWA / STD sets) vs MFG (INVORGPARAMETERSMFG) — the standard set decides (INV_ORG).

**Objects Oracle secures that the facts still cannot** (every set non-direct): CMK_COLLAB_DOCS_B,
CSE_ASSETS_B, HTS_SCHEDULES, HTS_SCHED_UNITS_DEPARTMENT_V, HTS_WORKLOADS, HTS_WORKLOAD_PLANS,
PJB_CNTRCT_PROJ_LINKS, XLE_ENTITY_PROFILES — the payload says `none` for them.

**Columns we secure that Oracle's URDA sets do not use** (every detected column stays AND-ed — user
decision; this extract holds URDA-based sets only): 24 on 18 policy objects, e.g. PO_HEADERS_ALL
PRC_BU_ID / SOLDTO_BU_ID (Oracle: BILLTO_BU_ID for payables AP294, REQ_BU_ID for procurement and
receiving PO49 / RCV*), POR_REQUISITION_* PRC_BU_ID / CONTENT_PRC_BU_ID, FA_BOOK_CONTROLS
BOOK_TYPE_CODE / SET_OF_BOOKS_ID, FUN_INTERCO_ORGANIZATIONS PAY_BU_ID / REC_BU_ID, INV_ORG_PARAMETERS
BUSINESS_UNIT_ID, XCC_CONTROL_BUDGETS LEDGER_ID, PJ* ORGANIZATION_ID / EXPENDITURE_ORGANIZATION_ID,
XLA_GL_LEDGERS LEDGER_ID (Oracle derives its ledgers from book / BU / cost org / ledger).
Oracle uses different columns per role / module on PO_HEADERS_ALL, DOS_SUPPLY_LINES (INV org vs BU),
PJF_PROJECTS_ALL_VL / PJF_ALL_ORGANIZATIONS (BU vs project org + award hierarchy), INV_ORG_PARAMETERS
(INV vs MFG), XLA_TRANSACTION_ENTITIES (per application), JV_JOINT_VENTURES_VL (BU_ID manage vs
BUSINESS_UNIT_ID view).

**Module family** (application → org context of a generic ORGANIZATION_ID on an object without its
own policy, after the FK, ahead of votes / lineage / prefix): code evidence — WIE → MFG_ORG
(HTS*_WIE sets), MNT → INV_ORG (INVORGPARAMETERSMNT, CSEASSETSBMNT77, MNTPROGRAMSBMNT109, HTS*_MNT,
POHEADERSALLMNT), ENQ → INV_ORG (INVORGPARAMETERSENQ), INV → INV_ORG (HTS*INV, CSTCOSTORGSINV), DOS →
INV_ORG (DOSSUPPLYLINESDOS4), RCV → INV_ORG (POHEADERSALLRCVWAREHOUSE); object evidence — CSE →
INV_ORG (CSEASSETSBMNT77); judgment — WIS → MFG_ORG, QA → INV_ORG. Family codes that are no
application: MFG → MFG_ORG, PWA → INV_ORG. Not mapped: RCS (only its own RCS_MFG_PARAMETERS set;
the application also owns maintenance parameters and lot / UOM conversions), HTS and PO (mixed codes
on indirect sets), SMO / QSC / MSC (no evidence). Removed from the MFG_ORG prefix domain: MNT, CSE,
QA (contradicted by the policies).

**Effect** (v2027_02 → v2027_03): MFG_ORG 116 → 203 rows, INV_ORG 1,209 → 1,124, BOOK 93 → 94,
INTERCO 7 → 8, PRJ_ORG 277 → 276; 5,032 → 5,035 rows on 4,012 → 4,013 objects; ambiguous on used 0,
disallowed 18. Of the 86 columns R2 had moved MFG_ORG → INV_ORG: 66 back to MFG_ORG (WIE 43, WIS 16
by module; RCS 3, MSC 2, CST 1, EDR 1 by policy / votes / lineage) and 20 stay INV_ORG (MNT 9, CSE 3,
QA 2, RCV 1, INV 1 by module; QSC 2, EDR 1, RCS 1 by votes / lineage). Beyond the 86: MNT 19, CSE 9,
QA 3 prefix-MFG columns → INV_ORG; 29 MSC planning views over WIE / WIS work definitions and orders,
2 CST, 1 CTO, 1 EDR, INV_ITEM_UOMS_V, RCS_PLANT_SHIFT_EXC_B/VL, RCS_MFG_PARAMETERS_V (was PRJ_ORG) →
MFG_ORG through the votes / lineage their WIE / WIS partners now anchor.

**Grant layer**: the two mined OTBI triples now carry `obj_name` (FUN_ALL_BUSINESS_UNITS_V /
FUNALLBUSINESSUNITSVSTD, GL_LEDGERS / GLLEDGERSSTD, matched by predicate on an object the statement
reads); privilege (function) names are not in this extract — `probe_grant_names` stays pending. The
read-only query that supplies them:

```sql
SELECT o.obj_name, ois.instance_set_name, ff.function_name, COUNT(DISTINCT g.role_name) AS roles
FROM   fnd_object_instance_sets ois
JOIN   fnd_objects o    ON o.object_id = ois.object_id
JOIN   fnd_grants g     ON g.object_id = ois.object_id AND g.instance_set_id = ois.instance_set_id
                       AND g.instance_type = 'SET' AND g.grant_type = 'ALLOW'
JOIN   fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
JOIN   fnd_form_functions ff ON ff.function_id = cmf.function_id
WHERE  UPPER(ois.predicate) LIKE '%FUN_USER_ROLE_DATA_ASGNMNTS%'
GROUP  BY o.obj_name, ois.instance_set_name, ff.function_name
ORDER  BY 1, 2, 3;
```
