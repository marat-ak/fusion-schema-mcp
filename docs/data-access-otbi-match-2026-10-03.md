# Data-access security: matching FND_GRANTS to OTBI's behaviour (2026-10-03)

Read-only analysis for the question "can we generate role/data-access secured SQL exactly as OTBI
does, MCP-only at runtime, loading customer-pod data into our PG where it helps?". Built on the
facts the orchestrator established on the Kornit TEST pod on 2026-10-03 (gate passed:
FND_GLOBAL.SESSION_ROLE_SET_KEY is set in the BIP session; FND_DATA_SECURITY.GET_SECURITY_PREDICATE
('AP_REPORT_PAYABLES_DATA', 'FUN_ALL_BUSINESS_UNITS_V') reproduces the OTBI LOGLEVEL-7 block
character for character). Nothing was changed: no source, pipeline, data or plugin file, no PG
write, no pod mutation. 10 read-only runSql queries were run on Kornit TEST (Appendix A), the rest
is the Kornit export (`data/security/*.csv`), the coverage outputs, the dev catalog release
v2027_04 and the demo-pod OTBI crawl logs.

Terms: U = the (object, privilege) pairs granted to the BI server identity
`FUSION_APPS_OBIA_BIEE_APPID`; "the API" = `FND_DATA_SECURITY.GET_SECURITY_PREDICATE`;
"duty map" = the FND_GRANTS held by the `ORA_FBI_*_TRANSACTION_ANALYSIS_DUTY_HCM` roles.

## Summary of verdicts

| AQ | Verdict |
|---|---|
| 1 U | U = 140 objects / 326 pairs / 179 privileges (active ALLOW grants). Both traced pairs are in U. Privilege is unique per (object, fact-module prefix) for 120 of 156 groups (77%); 36 groups on 32 objects are not, and they concentrate on 4 reference objects (BU view, INV_ORG_PARAMETERS, CST_COST_ORGS_V, EGP_SYSTEM_ITEMS_B) plus PER_* and CX import/export objects. ALL_INTEGRATION_POINTS_ALL_DATA is a superset (157 privileges on the BU view) and no tie-break; naming is not a rule either (103 *_VIEW_*, 75 *_REPORT_*, 42 *_MANAGE_*, 4 *_ANALYSIS_DATA). |
| 2 HCM | 71 roles (48 seeded ORA_FBI_*_DUTY_HCM, 16 Kornit XXKD_FBI_*_NEW copies, 7 other analysis duties) hold 230 pairs on 144 objects. 103 of 144 objects carry exactly one privilege across all duties; the person/assignment anchors do not (PER_ALL_PEOPLE_F 19, PER_ALL_ASSIGNMENTS_M 18) and 44 of 71 duties hold two privileges on one of them. Only 71 of the 230 pairs are in U: U is the OBIA/BICC extraction subset, the duty map is the OTBI-side enumeration for HCM. Restricted-profile proof still open (kept as the gate). |
| 3 Demo logs | The predicate text identifies the security object for every grant block: 234 logs, 710 block occurrences, only 5 distinct (object, privilege) ids on the demo pod, 5 of 5 named by text match against Kornit's FND_OBJECT_INSTANCE_SETS. Object resolved for 35 of 35 areas; privilege: 11 areas unique by the U rule, 6 more by id identity with those, 18 remain proposal-grade (items 13, notes 4, payroll flows 1). |
| 4 Coverage | Rule "fact -> object (itself or reference) -> U by fact-module prefix (HCM: duty map)": OTBI fact-folder tables (1,180): 216 direct, 221 via reference, 741 none; privilege unique for 122 tables (143 with primary context only). Top-300 BIP tables: 77 direct, 87 via reference, 135 none; unique for 58 (72 primary-only). Ambiguity sits on four objects; 110 of the top-300 BIP tables are never-fact ride-alongs. |
| 5 Runtime | MCP-only works end to end: plan (schema-mcp) -> ONE batched API statement per query (pod-mcp, WITH FUNCTION through runSql) -> splice -> runSql. Latency is the round trip, not the API: 1 pair 1,486 ms, 3 pairs 1,909 ms, 8 pairs 1,995 ms. A pair the user lacks returns status T and `(1=2)` (fail-closed text, not an error); a GLOBAL grant returns `(1=1)`. Load into PG per customer: U, the duty map, object/privilege names; never predicate text. |
| 6 Holes | Of the 13: 3 closed (gate, OPSS readability, any-access verdict), 3 replaced by today's rule/evidence, 7 open with sharper gates (see AQ6). |

## AQ1. The privilege universe U (grants to FUSION_APPS_OBIA_BIEE_APPID)

Query A1 (Appendix A): active ALLOW grants whose `role_name = 'FUSION_APPS_OBIA_BIEE_APPID'`, joined
through `fnd_compiled_menu_functions` to `fnd_form_functions` and `fnd_objects`.

- Size: 140 objects, 326 distinct (object, privilege) pairs (328 when the instance type is kept:
  216 GLOBAL-only, 108 SET-only, 2 both), 179 distinct privileges. 80 pairs are the generic CRUD
  names (`read` on 62 objects, `update`/`delete` on 9); 246 pairs are named privileges.
- Multiplicity per object (all privileges): 1: 55 objects, 2: 64, 3: 3, 4: 6, 5: 4, 6: 2, 8: 1,
  9: 3, 17: 1 (INV_ORG_PARAMETERS), 26: 1 (ZCA_EXP_OBJECTS). Without CRUD: 1: 106, 2: 22, 3: 3,
  4: 1, 5: 1, 6: 1, 8: 4, 17: 1, 23: 1.
- Multiplicity per (object, privilege prefix) without CRUD: 156 groups; 120 have exactly one
  privilege, 24 have 2, 4 have 3, 2 have 5, 3 have 7, one each 8, 11, 16.
- Both traced pairs are in U: `FUN_ALL_BUSINESS_UNITS_V / AP_REPORT_PAYABLES_DATA` (GLOBAL) and
  `PO_HEADERS_ALL / PO_VIEW_PO_DOC_ANALYSIS_DATA` (GLOBAL, next to `read`).
- The prefix must be the FACT's module, not the object's: 71 of the 246 named pairs carry a
  privilege prefix different from the object prefix (FUN->AP/AR/DOO, EGP->EGO, HR->PER,
  INV->RCS/RCV/WSH, PER->CMP/PAY, PJB->OKC, PJF->PJO, ZMM->MKL/MOO, ZCA->MOT/ZSF/HZ, MKT->MOT/HZ,
  FND->CST). E.g. the BU view carries exactly one privilege per module prefix: AP ->
  AP_REPORT_PAYABLES_DATA, AR -> AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO ->
  DOO_MANAGE_ORCHESTRATION_ORDER_DATA; GL_LEDGERS -> GL_REPORT_GENERAL_LEDGER_DATA (+ CRUD).

### Where (object, fact-module prefix) is NOT deterministic (36 groups, 32 objects)

| object [prefix] | n | privileges | tie-break evidence |
|---|---|---|---|
| INV_ORG_PARAMETERS [INV] | 11 | ABC_CLASS, CYCLE_COUNT, EXPECTED_SUPPLY, INVENTORY_ORGANIZATION_PARAMETER, INVENTORY_RESERVATION, INVENTORY_TRANSACTION, INVENTORY_TRANSFER_ORDER, ITEM_LOCATOR, ITEM_LOT_AND_ITEM_SERIAL, ITEM_SUBINVENTORY, ONHAND_QUANTITY (all INV_MANAGE_*_DATA) | grant sets differ (10 distinct of 11; only ABC_CLASS = ITEM_SUBINVENTORY), so the choice changes rows. All descriptions read "... for the inventory organizations in which they can operate"; the subject-matter token matches OTBI area names (Inventory Transactions, On-hand, Transfer Order, Cycle Count). |
| INV_ORG_PARAMETERS [RCV] | 3 | RCV_MANAGE_INBOUND_SHIPMENT, RECEIVING_RECEIPT, RECEIVING_TRANSACTION | INBOUND_SHIPMENT = RECEIVING_RECEIPT (identical grant sets, GLOBAL only, 5 grantees); RECEIVING_TRANSACTION differs (21 grantees). |
| INV_ORG_PARAMETERS [RCS] | 2 | RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA | module split: MNT -> MAINTENANCE, QA/ENQ -> QUALITY (the p5 module-family rule already knows these codes). |
| CST_COST_ORGS_V [CST] | 8 | CST_VIEW_COGS_EVENT, COSTED_ONHAND, COST_ORGANIZATION, COST_PERIOD, COST_TRANSACTION, ITEM_COST, VALUATION_UNIT, CST_EXTRACT_AND_WAREHOUSE_VALUATION_UNIT | COSTED_ONHAND = COST_PERIOD = VALUATION_UNIT (identical grant sets); 6 distinct sets of 8. Subject-matter token again (Cost Transaction, Item Cost, COGS). |
| EGP_SYSTEM_ITEMS_B [EGO] | 3 | EGO_VIEW_ITEM_BASIC_DATA, ITEM_PACK_DATA, ITEM_STRUCTURE_DATA | BASIC has the SAME grant set as `read` (identical predicates); STRUCTURE differs (22 vs 24 grantees). Demo logs: ONE function id on the item entity across 13 areas incl. the structure areas. |
| HZ_PARTIES [HZ] | 2 | HZ_VIEW_TRADING_COMMUNITY_CONTACT_DATA (SET), _PERSON_DATA (GLOBAL) | different grant sets (156 vs 581 grantees). |
| PJF_PROJECTS_ALL_VL [PJF] / [PJO] | 2 / 2 | PJF_MANAGE_PROJECT_TASK_STRUCTURE, PJF_VIEW_PROJECT_IN_PROJECT_LIST / PJO_VIEW_PROJECT_BUDGET_BASELINE_VERSION, PJO_VIEW_PROJECT_FORECAST_APPROVED_VERSION | all four differ. |
| PJC_EXP_ITEMS_ALL [PJC] | 2 | PJC_EXTRACT_N_WAREHOUSE_PROJECT_EXPENDITURE_ITEM, PJC_MANAGE_PROJECT_EXPENDITURE_ITEM | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY holds only PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA (duty evidence). |
| HR_ALL_POSITIONS_F [PER] | 2 | PER_CHOOSE_POSITION_DATA (SET), PER_REPORT_POSITION_DATA (GLOBAL) | duty map: 41 duties hold PER_REPORT_POSITION_DATA, none holds CHOOSE. |
| 17 PER_* objects [PER] | 2-5 | the specific PER_REPORT_<entity>_DATA next to PER_REPORT_PERSON_DATA / PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA (addresses, phones, emails, passports, visas, national ids, grades, locations, persons, people, assignments) | duty map decides per area (AQ2); the FBI duties hold the specific one. |
| FND_DOCUMENT_CATEGORIES [FND] | 3 | FND_READ/UPDATE/DELETE_APPLICATION_ATTACHMENT_DATA | attachments; READ is the reporting one (naming, not proven). |
| MKT_IMP_JOBS/MAP/OBJECTS, ZCA_EXP_OBJECTS, MOT_* [MOT/ZSF] | 2-16 | CX import/export and territory objects | not reporting facts; out of scope for secured SQL. |

Tie-break data checked:

1. **ALL_INTEGRATION_POINTS_ALL_DATA** (query A3) holds 157 privileges on the BU view, 129 on
   PER_ALL_PEOPLE_F, 124 on PJF_PROJECTS_ALL_VL, 33 on INV_ORG_PARAMETERS, 32 on CST_COST_ORGS_V
   -- a superset of U everywhere; it cannot discriminate.
2. **Grant-set identity** (query A9): two privileges with identical (grantee, instance type,
   instance set) multisets produce identical predicates for every user, so the choice between them
   is immaterial. Found: CST COSTED_ONHAND = COST_PERIOD = VALUATION_UNIT; INV ABC_CLASS =
   ITEM_SUBINVENTORY; RCV INBOUND_SHIPMENT = RECEIVING_RECEIPT; EGO_VIEW_ITEM_BASIC_DATA = `read`
   on items; GL `delete` = `update`. Everywhere else the sets differ (PO ANALYSIS 16 grantees / 4
   sets vs `read` 40 / 11; BU view AP/AR/DOO all distinct), so the privilege choice matters.
3. **Demo-log id identity** (AQ3): on the demo pod one function id per object serves every area
   that secures through that object (BU view 12 areas, items 13, GL 5, notes 4).
4. **Naming / descriptions**: no rule. *_REPORT_* (AP, GL, PER, PAY, CMP, HRA, IRC), *_VIEW_*
   (AR, PO, POR, PON, CST, EGO, HZ, SVC, MOO), *_MANAGE_* (DOO, INV, RCV, WSH, PJC, OKC, FA, XLA)
   and *_ANALYSIS_DATA (PO, POR, PON) all appear as OTBI privileges.

Proposals (not proven; marked for user approval):

- P1 INV_ORG_PARAMETERS: choose by the subject-matter token of the OTBI area / fact (Inventory
  Transactions -> INV_MANAGE_INVENTORY_TRANSACTION_DATA, On-hand -> ONHAND_QUANTITY, Transfer
  Order -> INVENTORY_TRANSFER_ORDER, Cycle Count -> CYCLE_COUNT, Reservations ->
  INVENTORY_RESERVATION, Lots/Serials -> ITEM_LOT_AND_ITEM_SERIAL, Expected Supply ->
  EXPECTED_SUPPLY, Locators/Subinventories -> the matching one); facts with no token match ->
  needs-input listing the 11.
- P2 CST_COST_ORGS_V: the same token rule (COGS, Item Cost, Cost Transaction, Costed On-hand,
  Cost Period, Valuation Unit, Cost Organization).
- P3 EGP_SYSTEM_ITEMS_B: EGO_VIEW_ITEM_BASIC_DATA for item facts and the item dimension (identical
  to `read`; the demo pod uses one id everywhere); EGO_VIEW_ITEM_STRUCTURE_DATA only for structure
  component facts (EGP_COMPONENTS_B) -- unproven.
- P4 CX notes (ZMM_NOTES): `read` (the one privilege common to contact, customer, opportunity and
  compensation notes, which share one id on the demo pod). Generalises to CX objects whose U set
  is {<X>_VIEW_<obj>_DATA, read}: open, needs one Sales trace.
- P5 PJF_PROJECTS_ALL_VL: PJF_VIEW_PROJECT_IN_PROJECT_LIST_DATA for project facts (the view-list
  privilege; the task-structure one is an editing privilege) -- unproven.

## AQ2. The HCM route (FBI duty grants)

Query A2 (two pages): active ALLOW grants of every `role_name` containing `FBI` or
`ANALYSIS_DUTY`, aggregated per (object, privilege) with the duty list.

- Roles caught: 71 = 48 seeded `ORA_FBI_*_TRANSACTION_ANALYSIS_DUTY_HCM` (plus the payroll
  `ORA_FBI_PAYROLL_*_TRANSACTION_DUTY_HCM` family), 16 Kornit copies `XXKD_FBI_*_NEW` (same pairs
  as their seeded twins -- the customer layer of the map), 7 other analysis duties
  (`ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY` holding the PJB/PJC pairs,
  `ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY`, ...). The FSCM/PRC
  `FBI_*` duties hold no FND_GRANTS at all (orchestrator fact 3 confirmed: nothing on the BU view
  or PO_HEADERS_ALL).
- Map: 230 (object, privilege) pairs on 144 objects with 112 privileges; 173 are
  `*_REPORT_*_DATA`, 33 `*_VIEW_*`, 24 other (ESS_REQUEST_*, PJB/PJC/OKC manage, PER_MANAGE_ABSENCE_CASE_DATA).
- "Exactly one pair per object" holds for 103 of 144 objects (dimensions and most facts:
  HR_ALL_POSITIONS_F/PER_REPORT_POSITION_DATA by 41 duties, PER_JOBS_F/PER_REPORT_HR_JOB_DATA,
  PAY_FLOWS/PAY_REPORT_PAYROLL_FLOW_DATA, ...). It fails on the anchors: PER_ALL_PEOPLE_F carries 19
  privileges across duties, PER_ALL_ASSIGNMENTS_M 18, one object 5, 9 objects 3, 29 objects 2. Per
  duty: 44 of 71 hold two privileges on at least one object -- always the area's own privilege
  next to PER_REPORT_PERSON_DATA on PER_ALL_ASSIGNMENTS_M / PER_ALL_PEOPLE_F (e.g. Absence
  Management: ANC_REPORT_ABSENCE_RECORD_DATA + PER_REPORT_PERSON_DATA). Reading: the area's fact
  VO is secured by the area privilege and the Person dimension by PER_REPORT_PERSON_DATA; which one
  applies to a table depends on whether it is read as that area's fact or as the person dimension
  (tie-break by role of the table in the query, not by name -- proposal P6).
- Relation to U: 71 of the 230 pairs are also held by FUSION_APPS_OBIA_BIEE_APPID; 65 of the 144
  objects are in U. 159 pairs are not in U (all BEN_*, ANC_*, HRG_*, HTS_*, HWM_*, CEL_*, HMO_*,
  PAY_FLOWS, the specific IRC_REPORT_* and the ESS_REQUEST_* pairs). 20 U pairs on HCM objects are
  held by no duty (PER_CHOOSE_*, PER_REPORT_PERSON_ADDRESS/PHONE/EMAIL/PASSPORT/VISA/NATIONAL_IDENTIFIER_DATA,
  PER_VIEW_PERSON_DEFERRED_DATA, PER_EDIT_USER_NAME_DATA, PJC_EXTRACT_N_WAREHOUSE_...). So U is
  the OBIA/BICC extraction subset (the APPID is the BI Applications identity: it needs a GLOBAL
  grant on every privilege the extracted BI VOs check) and the duty map is the OTBI-side
  enumeration for HCM; for FSCM there is no duty enumeration, which is why U is the pod-side
  evidence there.
- Payroll flows: the demo-pod area secures `ESS_REQUEST_HISTORY` (AQ3); the payroll duties hold
  ESS_REQUEST_CANCEL/HOLD/LOCK/READ/RELEASE on it with identical counts (9 roles each on the set
  REQS_ALL_OF_ONE_APP) -- one permission set, so the five names yield the same predicate;
  ESS_REQUEST_READ is the natural name (proposal P7).
- Probes on marat (query A6/A10): PER_ALL_PEOPLE_F / PER_REPORT_PERSON_DATA -> `(1=1)` (he holds a
  GLOBAL grant: the all-persons profile), PAY_FLOWS / PAY_REPORT_PAYROLL_FLOW_DATA -> status T,
  `(1=2)` (no grant: fail-closed, no error). The restricted-profile proof (a user whose person
  security profile is a subset) remains the gate for HCM, as instructed; nothing here closes it.

The full map (object x privilege -> duties, 230 rows) is Appendix B; the per-duty view (71 rows)
is Appendix C.

## AQ3. Demo-log evidence re-use (35 subject areas, fa-exqw-dev2 crawl, user matt.hooper)

Method: every `EXISTS (SELECT NULL FROM fnd_grants gnt WHERE ...)` block of the 234 logs that carry
one was parsed (function_id, object_id, instance_set_id, the expanded instance-set predicate text);
the text was normalised (`&TABLE_ALIAS.` dropped, `&GRANT_ALIAS` -> `GNT`, every `<alias>.`
qualifier dropped on both sides, whitespace/case folded) and matched against the 5,634 predicates
of Kornit's FND_OBJECT_INSTANCE_SETS export (2,399 distinct texts).

Result: 710 block occurrences, only **5 distinct (object_id, function_id) pairs** on the whole demo
pod, and every one of the 5 predicate texts matches: 4 of 5 to exactly one object (GL_LEDGERS /
GLLEDGERSSTD; EGP_SYSTEM_ITEMS_B / EGPSYSTEMITEMSBEGO1; ZMM_NOTES / the ZMM_NOTES_* family;
ESS_REQUEST_HISTORY / REQS_ALL_OF_ONE_APP), one to two objects sharing the text
(FUN_ALL_BUSINESS_UNITS_V / FUNALLBUSINESSUNITSVSTD and PJC_COMMITMENT_TXNS /
PJC_OTBI_CMT_TXN_BU_IS) and disambiguated by the entity the block is attached to
(`FUN_ALL_BUSINESS_UNITS_V BU` in 128 of 144 occurrences). So the route "predicate text -> object
name" works for 35 of 35 areas; ids never had to leave the demo pod.

Which entity carries the block (the OTBI pattern): the fact VO's BU / Ledger / Item entity
(`FUN_ALL_BUSINESS_UNITS_V BU`, `GL_LEDGERS` next to `GL_JE_HEADERS JrnlHdr`,
`EGP_SYSTEM_ITEMS_B_V ItemBasePEO`), i.e. the same shape as the Kornit AP trace
(`FUN_BU_PERF_V BusinessUnit` on the invoice). Two findings beyond the fact: (a) the **Item entity
is secured wherever it appears**, including as a dimension of "Receivables - Customer Tax Profile"
and "Manufacturing - Work Definitions"; (b) in the Inventory / Manufacturing / Shipping / SCFO
areas the only secured folders are DOO's (Transfer Order Line Details, Sales Order Details,
Shipment Line Summary, Order Header/Line Detail -- `DOO_FULFILL_LINES_ALL`, module DOO) and they
carry the DOO areas' function id. Dimensions do ride along in general (5,784 logs carry the
`(1=2)` stub, which is the capturing user's missing grant on the FACT privilege, and matt.hooper's
GLOBAL grants collapse most slots to `(1=1)`), but secured dimension VOs exist.

| areas (n) | demo object -> name | privilege by rule (U n fact-module prefix) | grade |
|---|---|---|---|
| General Ledger - Journals, Average Daily Balances, Transactional ADB (3) | GL_LEDGERS | GL_REPORT_GENERAL_LEDGER_DATA (unique in U for GL) | rule |
| Subledger Accounting - Payables / Receivables Summary Reconciliation (2) | GL_LEDGERS | GL_REPORT_GENERAL_LEDGER_DATA (XLA has no privilege on GL_LEDGERS; the only named privilege on the object) | rule (unique-any-prefix) |
| Distributed Order Orchestration - Fulfillment Lines, Order Headers, Order Holds, Order Lines, Price Adjustments, Process Instances (6) | FUN_ALL_BUSINESS_UNITS_V | DOO_MANAGE_ORCHESTRATION_ORDER_DATA (unique in U for DOO; 38 roles hold it with FUNALLBUSINESSUNITSVSTD) | rule |
| Inventory - Transfer Order, Kanban Activity; Manufacturing - Work Order Performance, Workstation Supervision; Shipping; Supply Chain Financial Orchestration (6) | FUN_ALL_BUSINESS_UNITS_V | DOO_MANAGE_ORCHESTRATION_ORDER_DATA -- the secured folders are DOO fulfillment/sales-order folders and the function id equals the DOO areas' | id identity |
| Product Management - Change Order, Change Order Approvals, Item Catalog Category Hierarchy, Item Revisions, Item Supplier Associations, Structures, Structures and Components, Where Used (8); Manufacturing - Work Definitions (1); Receivables - Customer Tax Profile, Customer Account Site Tax Profile (2); custExt33f1cb05, custExt3ba2e2a8 (2) | EGP_SYSTEM_ITEMS_B | EGO_VIEW_ITEM_BASIC_DATA (P3): 3 candidates in U; BASIC = `read` by grant set; one id on the item entity in all 13 areas | proposal |
| Sales - CRM Contact Note, Customer Note, Opportunity Note (3); Compensation - Workforce Compensation (1, the Compensation Notes folders) | ZMM_NOTES | `read` (P4): one id for all four; `read` is the only privilege common to them (MOO/MKL are object-specific) | proposal |
| Payroll - Payroll Flows (1) | ESS_REQUEST_HISTORY | ESS_REQUEST_READ (P7): not in U; 5 ESS_REQUEST_* on one permission set in the payroll duties | proposal |

Count: object 35/35; privilege rule-grade 11, id-identity 6, proposal 18. The 35 `pending` rows of
`sec_area_privilege` (release v2027_04) can be replaced by these rows (source `inferred` for the
proposals, `trace` only after a Kornit LOGLEVEL-7 trace per family).

## AQ4. Corpus coverage under the rule

Rule evaluated: table registered in FND_OBJECTS with an active grant -> object = the table;
else every context column of `table_security` -> its reference object; privilege = U[object] minus
CRUD, filtered by the table's module (`tables.module`, with the prefix aliases EGP->EGO, HR->PER,
WIE/WIS/MNT/QA/ENQ->RCS, CMR->CML, FOS->DOO); exactly one -> `unique_prefix`; none by prefix but
exactly one named privilege on the object -> `unique_single`; several -> ambiguous; HCM-prefixed
table or object -> the duty map on the object (one privilege -> `hcm_unique`). Populations from
release v2027_04 (`otbi_folder.kind = 'fact'`, `table_usages.source = 'bip-report'`).

| population | n | direct | via reference | none | unique privilege (every ctx -> primary ctx only) | ambiguous (every -> primary) | object not in U | multi-context | HCM none / ambiguous | other |
|---|---|---|---|---|---|---|---|---|---|---|
| A. tables of OTBI fact folders | 1,180 | 216 | 221 | 741 | 122 -> 143 | 123 -> 149 | 99 | 48 -> 0 | 28 / 17 | 2 registered-no-grant |
| A1. same, dominant-module tables only | 987 | 185 | 188 | 614 | 102 -> 120 | 105 -> 128 | 85 | 42 -> 0 | 24 / 15 | - |
| B. top-300 BIP tables | 300 | 77 | 87 | 135 | 58 -> 72 | 28 -> 37 | 20 | 24 -> 0 | 8 / 26 | 1 |
| C. all catalog tables | 29,802 | 874 | 3,861 | 25,040 | 1,147 -> 1,307 | 2,101 -> 2,585 | 464 | 657 -> 0 | 216 / 150 | 18 disallowed, 9 registered-no-grant |

Reading: of the securable OTBI fact tables (A, 437 direct + via reference) 28% get a unique pair
under the current "every context applies" rule and 33% under "primary context only"; the rest is
the four-object ambiguity below, registered objects outside U, and HCM. The "none" tables split by
the coverage report's class (v2027_03 objects.csv): A: UNSECURABLE 354, VIA_PARENT 122 (secured
through a parent such as PO_LINES_ALL -> PO_HEADERS_ALL; the rule as stated has no parent hop),
VIA_JOIN 55 (HCM columns the p5 release excludes), 210 not in that run; B: 45 / 15 / 24 / 51.

Gap classes (counts in A; 3 examples each):

- none, no context and not registered: 741 (ACA_PC_COMMON_CONFIG_VL, ACA_STRUCTURE_EXPL_STAGING,
  ACA_STRUCTURE_IMPL_STAGING); in B: 135, of which **110 are never-fact tables** (never in an OTBI
  fact folder: ZX_REP_TRX_JX_EXT_T, POZ_SUPPLIERS, PER_JOBS_F_VL, HZ_GEOGRAPHIES,
  INV_UNITS_OF_MEASURE_VL ...) -- OTBI reads them as unsecured dimensions.
- privilege ambiguous: 155 (table, object) pairs (AP_INVOICE_PAYMENTS_ALL -> INV_ORG_PARAMETERS:17,
  CE_EXTERNAL_TRANSACTIONS -> FUN_ALL_BUSINESS_UNITS_V:3, CMF_FISCAL_DOC_LINES_VL -> BU:3). Across
  the whole catalog the ambiguity sits on four objects: FUN_ALL_BUSINESS_UNITS_V (1,526 tables whose
  module -- CE, ZX, POZ, CMR, IBY, CN, OKC, ... -- holds no privilege on the BU view in U, so AP/AR/DOO
  remain), INV_ORG_PARAMETERS (1,024 + 187), CST_COST_ORGS_V (402), HR_ORG_UNIT_CLASSIFICATIONS_F
  (270, the PRJ_ORG context: PER_REPORT_DEPARTMENT / LEGAL_EMPLOYER / HR-specialist dashboard).
- registered object absent from U: 97 tables (ACD_CONCEPT_B, ACN_IDEA_B, CEL_RECOGNITIONS; in B:
  XLE_ENTITY_PROFILES, PSC_LNP_RECORD, PSC_LNP_PR_USER) -- objects the OBIA identity never extracts;
  for HCM ones the duty map fills part (hcm_none 28 remain: ANC_PER_PLAN_ENROLLMENT,
  BEN_BILL_CHARGES, BEN_ELIG_RSLT_F).
- multi-context: 48 (AP_INVOICES_ALL [BU + LEDGER + PRJ_ORG], AP_INVOICE_DISTRIBUTIONS_ALL,
  AP_INVOICE_LINES_ALL; in B also WIE_WORK_ORDERS_B [MFG_ORG + PRJ_ORG], RA_CUSTOMER_TRX_ALL
  [BU + LEDGER]). OTBI applies one (the Kornit AP trace: BU only; demo GL: ledger only).
- reference object absent from U: 2 (FUN_TRX_BATCHES, FUN_TRX_HEADERS -> FUN_INTERCO_ORGANIZATIONS).
- registered, no active grant on the export pod: 2 (FND_ATTACHED_DOCUMENTS, FND_TERRITORIES_TL).

Examples of the rule working: AP_CHECKS_ALL, AP_HOLDS_ALL, PO_HEADERS_ALL, POZ_SUPPLIERS_V,
ZX_REP_TRX_DETAIL_T (B) and 122 OTBI fact tables; the per-table outcomes of population B are
Appendix D.

## AQ5. MCP-only runtime design

Measured on Kornit TEST through runSql (the generic SQL report, `WITH FUNCTION` accepted):

| probe | result |
|---|---|
| 1 pair (BU / AP_REPORT_PAYABLES_DATA) | T, 2,553 chars, 1,486 ms |
| 3 pairs in one statement | 1,909 ms total (PAY_FLOWS pair = `(1=2)`, AP 2,553, PO 2,204 chars) |
| 8 pairs in one statement | 1,995 ms total; shapes: `(1=2)` x2 (GL_LEDGERS/GL_REPORT, BU/DOO -- marat lacks them), `(1=1)` x2 (RCS_MFG_PARAMETERS/RCS_PLANT_PARAMETERS_DATA, PER_ALL_PEOPLE_F/PER_REPORT_PERSON_DATA -- GLOBAL grants), SET text x4 (INV 2,407, CST 1,060, items 1,108 with `NVL(PUBLIC_FLAG,'N')='Y' OR ...`, ZMM_NOTES/read 10,531) |
| pair the user lacks | status `T`, predicate `(1=2)` -- fail-closed text, never an error |
| OPSS through runSql | readable: 23 `cn=roles` containers, 284 obi `*TRANSACTION_ANALYSIS*` duties |

So the cost is the BIP round trip (about 1.4 s), not the API (about 0.1 s per extra pair): **one
batched statement per query**, whatever the number of secured tables.

Flow (every step is an MCP tool the runtime persona already has):

1. `getDataAccessPredicate` (schema-mcp) for each table instance of the query -> plan entries
   `{form, object, privilege, verdict, column, referencePk, nullable, condition "{PRED:n}"}`. Changes
   it needs: (a) the privilege comes from the customer's U / duty map through the module rule and
   the curated `sec_area_privilege` rows, with a `verdict` (unique | ambiguous[candidates] | none);
   `privilege: null` ("any access") disappears -- an ambiguous or missing privilege is `needs-input`
   with the candidates, never a call without privilege; (b) a whole-query form (one call with all
   `{table, alias}` pairs, or the skill merging the per-table `fetch` lists) so the pairs are
   de-duplicated before the pod call; (c) the context policy switch (every context vs primary only)
   once the user decides hole 8.
2. `getSecurityPredicate` (pod-mcp) with the de-duplicated pairs -> ONE `WITH FUNCTION` statement
   (one row per pair and 4,000-char chunk: object, privilege, status, length, seq, chunk; aliases
   that are not reserved words: `txt`, `api_mode`, never `raw`/`MODE`), executed by `runSql` in the
   user's pod session; `privilege` becomes REQUIRED (any-access mode removed: NULL privilege = any
   grant on the object = `(1=1)` on the BU view). Returned per pair: `{status, predicate, length,
   shape: none | all | sets}` where `(1=2)` -> `none` and `(1=1)` -> `all`.
3. Splice: `t.<col> IN (SELECT sec$.<pk> FROM <object> sec$ WHERE <predicate>)` (isolated form,
   NULL-tolerant when the column is nullable) per entry, AND-ed inside the `<alias>_sec` CTE; a
   `none` shape is spliced as is (the query returns no rows for that table) and the deliverable
   states "no access to <object> under <privilege> in this session" instead of hiding it.
4. `runSql` runs the secured query in the same session; the branches re-check `fnd_grants` and
   `fnd_session_role_sets` at run time, so the text is exact for the generating user, and a data
   model authored for others embeds the author's branches (stated, as today).

Per-customer data to load into our PG (names only, proposal):

| table (customer layer, per pod) | content | source query | size on Kornit |
|---|---|---|---|
| `sec_u` | (obj_name, privilege, grant_types) held by FUSION_APPS_OBIA_BIEE_APPID | A1 | 326 rows |
| `sec_duty_pair` | (duty_role, obj_name, privilege) of every `*FBI*` / `*ANALYSIS_DUTY*` role | A2 | 230 pairs / 71 duties |
| `sec_object`, `sec_privilege` | the registered objects and privileges of THIS pod (adds the customer-created `XX*`/`_c` objects and the role counts) | exports 01/02 | 1,025 / 7,405 |
| `sec_duty_parent` (optional) | duty -> job roles from OPSS (`jps_dn`/`jps_attrs`), for the "jobs holding the privilege vs jobs with the duty" warning | conv-3 query | small |

Never loaded: predicate text, instance-set text, ids. Refresh: the four queries take about 2 s
each through the same runSql; trigger = admin action (the setup-driven ingest of schema-mcp, not an
env var) with a stamp (pod, date, counts) shown in the plan; re-run after a Fusion quarterly update
or a security change. Seed layer: the shipped export + U of a reference pod; customer layer
overrides by name (the coverage report's section 8.4 shape).

Cache: the returned text enumerates only the instance sets the user's roles hold at generation
time and re-checks the grants at run time, so a cached text can only become STALE, never leak: a
revoked grant makes its branch's `EXISTS (... fnd_grants ...)` false; a newly granted set is
missing until regeneration. An in-memory cache keyed (pod, user session, object, privilege, alias)
for the life of the pod session is therefore safe; it must not be persisted, shared across users or
written to the catalog (the user's "no predicate storage" rule) -- flagged as a decision, not
assumed.

Budget: one round trip of about 1.5-2.0 s per query generation (plus the usual runSql of the
query itself), independent of the number of secured tables; no per-pair cost worth caching across
queries.

## AQ6. The 13 holes (ledger 2026-10-03)

| # | hole | status today |
|---|---|---|
| 1 | session_role_set_key in BIP unverified (GATE) | CLOSED: set; 2,312 FND_SESSION_ROLE_SETS rows; API output identical to the OTBI trace (orchestrator). |
| 2 | CB connection user != chat user | OPEN for the CloudBeaver path; NOT APPLICABLE to the MCP-only runtime (the identity-broker pod session is the chat user's). |
| 3 | privilege rule is a heuristic (AP Specialist / Spend counter-examples) | REPLACED by "U n fact-module prefix" with a verdict: unique for 120 of 156 (object, prefix) groups; the counter-examples stay open as trace work (a LOGLEVEL-7 run as a Specialist decodes the function id). |
| 4 | subject area <-> duty by name match | REPLACED for FSCM (U needs no duty); still the HCM route, now runnable through runSql (OPSS readable). |
| 5 | fact detection = stub heuristic | OPEN, sharper: the block sits on the fact VO's BU / Ledger / Item entity, and the Item entity is secured even as a dimension (AQ3). |
| 6 | multi-fact tables (PO_HEADERS_ALL fact in Purchasing, dimension elsewhere) | OPEN; the rule keys the privilege on the module of the table being secured, which is what the demo shows for the Item entity (one privilege everywhere). |
| 7 | never-fact tables | QUANTIFIED: 110 of the top-300 BIP tables; OTBI reads them unsecured -> policy decision (treat as none, state it). |
| 8 | "every context applies" vs OTBI's single context | EVIDENCE: Kornit AP = BU only, demo GL = ledger only; primary-only raises unique coverage (122 -> 143 of the OTBI fact tables) and removes 657 multi-context conflicts -> user decision. |
| 9 | any-access mode must go | CONFIRMED (NULL privilege = `(1=1)` on the BU view); build pending. |
| 10 | OPSS readability via runSql unknown | CLOSED: readable (23 containers, 284 obi duties). |
| 11 | data models carry the author's roles | OPEN, untouched (the XMLTABLE / DBMS_XMLGEN dynamic-predicate spike was not run). |
| 12 | HCM unproven | OPEN (restricted-profile user needed); new facts: `(1=2)` for a lacking payroll pair, `(1=1)` for marat's PER_REPORT_PERSON_DATA, duty map unique for 103 of 144 objects. |
| 13 | seed vs customer layers of the map | SHAPED: Kornit's 16 `XXKD_FBI_*_NEW` copies and its `_c`/`XX*` objects are the customer layer; the per-pod load of U + duty map (AQ5) IS that layer. |

New since the list: (a) pod-mcp `getSecurityPredicate` emits reserved-word aliases (`raw`, `MODE`,
ORA-00923) -- never pod-verified; (b) U = 326 pairs is the OBIA extraction subset, not a full
enumeration of OTBI privileges (HCM shows 159 duty pairs outside it); (c) secured dimension VOs
exist (Item).

## Proposed rule

1. Object: the table itself when it is registered with an active grant; else the reference object
   of its context column (primary context only, if hole 8 is decided that way; every context
   otherwise); parent hop for the VIA_PARENT class to be added later (not in this rule).
2. Privilege: on FSCM/PRC/SCM/CX objects the named (non-CRUD) privileges in the customer pod's U
   filtered by the secured table's module prefix (with the alias map); one hit = use it; several =
   `needs-input` with the candidates unless a curated `sec_area_privilege` row (trace > inferred)
   decides; none = the object is not an OTBI-visible security point for that module -> `needs-input`.
3. HCM objects: the duty map of the pod -- the privilege held on the object by the duty whose
   display name matches the subject area; the person/assignment anchors need the fact-vs-dimension
   role of the table (P6); the restricted-profile probe gates shipping.
4. Generation: one batched API statement per query in the user's session; `(1=2)` is stated as
   "no access"; never a privilege-less call; never stored text.
5. Data: U + duty map + object/privilege names per customer pod in PG, refreshed by an admin
   action; curated proposals P1-P7 enter `sec_area_privilege` as `inferred` until traced.

## Next build steps (not executed)

1. pod-mcp `getSecurityPredicate`: rename the aliases, make `privilege` required (delete the
   any-access mode and its tests), accept `pairs[]` and emit the one-statement batch with the
   per-pair shape; unit tests + a pod smoke on Kornit TEST.
2. schema-mcp: customer-layer tables `sec_u`, `sec_duty_pair` (+ pod `sec_object`/`sec_privilege`)
   with a names-only loader fed by the four runSql queries of Appendix A and a stamp; the loader's
   trigger goes through the setup-driven ingest, no new env var.
3. schema-mcp `dataAccess.ts`: privilege resolver = customer U / duty map + module alias map +
   curated rows -> `verdict` and candidates; drop `privilege: null`; whole-query plan form; the
   context-policy switch after the user's decision on hole 8.
4. `p5_security_rules.json` `areaPrivileges`: replace the 35 `pending` rows with the AQ3 table
   (11 rule + 6 id-identity rows as `inferred`, the 18 proposals as `inferred` pending traces);
   new release label; coverage re-run with the resolver.
5. fusion-sql skill `data-access-security`: batch flow, the three shapes, the "no access" wording,
   session-cache rule.
6. User-side proofs that turn proposals into `trace`: Kornit LOGLEVEL-7 captures of one Inventory,
   one Costing, one Product Management, one Sales-notes and one HCM area (restricted user), decoded
   with the function-id lookup; a Specialist capture for the AP counter-example.

## Appendix A. SQL run on Kornit TEST (read-only, runSql, in order)

```sql
-- A1  U: pairs granted to the BI server identity (140 rows, aggregated per object)
WITH u AS (
  SELECT DISTINCT o.obj_name, ff.function_name, g.instance_type
  FROM fnd_grants g
  JOIN fnd_objects o ON o.object_id = g.object_id
  JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
  JOIN fnd_form_functions ff ON ff.function_id = cmf.function_id
  WHERE g.role_name = 'FUSION_APPS_OBIA_BIEE_APPID' AND g.grant_type = 'ALLOW'
    AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE))
SELECT obj_name, COUNT(DISTINCT function_name) AS n_priv,
       LISTAGG(function_name || ':' || instance_type, ' ') WITHIN GROUP (ORDER BY function_name, instance_type) AS privs
FROM u GROUP BY obj_name ORDER BY obj_name;

-- A2  the FBI / analysis-duty map (230 rows; run twice: first 200, then OFFSET 200 ROWS FETCH NEXT 200 ROWS ONLY)
WITH h AS (
  SELECT DISTINCT g.role_name, o.obj_name, ff.function_name
  FROM fnd_grants g
  JOIN fnd_objects o ON o.object_id = g.object_id
  JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
  JOIN fnd_form_functions ff ON ff.function_id = cmf.function_id
  WHERE (g.role_name LIKE '%FBI%' OR g.role_name LIKE '%ANALYSIS_DUTY%') AND g.grant_type = 'ALLOW'
    AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE))
SELECT obj_name, function_name, COUNT(DISTINCT role_name) AS n_duties,
       LISTAGG(REPLACE(REPLACE(role_name, 'ORA_FBI_', ''), '_DUTY_HCM', ''), ' ' ON OVERFLOW TRUNCATE '...' WITH COUNT)
         WITHIN GROUP (ORDER BY role_name) AS duties
FROM h GROUP BY obj_name, function_name ORDER BY obj_name, function_name;

-- A3  ALL_INTEGRATION_POINTS_ALL_DATA holdings on the multi-candidate objects (same shape as A1 with
--     g.role_name = 'ALL_INTEGRATION_POINTS_ALL_DATA' AND o.obj_name IN (...18 objects...))

-- A4  OPSS readability through runSql
SELECT (SELECT COUNT(*) FROM fusion_opss.jps_dn WHERE rdn = 'cn=roles') AS roles_containers,
       (SELECT COUNT(*) FROM fusion_opss.jps_attrs a JOIN fusion_opss.jps_dn d ON d.entryid = a.jps_dn_entryid
         WHERE a.attrname = 'cn' AND UPPER(a.attrval) LIKE '%TRANSACTION_ANALYSIS%'
           AND LOWER(d.parentdn) = 'cn=fapolicies,cn=jpscontext,cn=fusiondomain,cn=obi,cn=roles,') AS obi_analysis_duties
FROM dual;

-- A5/A6/A8  the API, batched (the alias-safe wrapper; the pairs CTE lists 1, 3 or 8 pairs)
WITH
FUNCTION osaas_pred(p_obj VARCHAR2, p_priv VARCHAR2) RETURN CLOB IS
  l_pred CLOB; l_status VARCHAR2(30);
BEGIN
  FND_DATA_SECURITY.GET_SECURITY_PREDICATE(p_api_version => 1.0, p_privilege => p_priv, p_object_name => p_obj,
    p_grant_instance_type => 'UNIVERSAL', p_statement_type => 'OTHER',
    x_predicate => l_pred, x_return_status => l_status, p_table_alias => 'sec$');
  RETURN NVL(l_status, '?') || '|' || l_pred;
EXCEPTION WHEN OTHERS THEN RETURN 'E|' || SQLERRM;
END;
pairs AS (SELECT 'PAY_FLOWS' AS obj, 'PAY_REPORT_PAYROLL_FLOW_DATA' AS priv FROM dual
          UNION ALL SELECT 'FUN_ALL_BUSINESS_UNITS_V', 'AP_REPORT_PAYABLES_DATA' FROM dual
          UNION ALL SELECT 'PO_HEADERS_ALL', 'PO_VIEW_PO_DOC_ANALYSIS_DATA' FROM dual),
res AS (SELECT obj, priv, osaas_pred(obj, priv) AS txt FROM pairs)
SELECT obj, priv, DBMS_LOB.SUBSTR(txt, DBMS_LOB.INSTR(txt, '|') - 1, 1) AS api_status,
       DBMS_LOB.GETLENGTH(txt) - DBMS_LOB.INSTR(txt, '|') AS pred_len,
       DBMS_LOB.SUBSTR(txt, 400, DBMS_LOB.INSTR(txt, '|') + 1) AS pred_head
FROM res;

-- A7  single pair (timing reference): res AS (SELECT osaas_pred('FUN_ALL_BUSINESS_UNITS_V','AP_REPORT_PAYABLES_DATA') AS txt FROM dual)

-- A9  grant-set identity of the U candidates on 11 objects (59 rows)
WITH g AS (
  SELECT o.obj_name, ff.function_name, g.grantee_key, g.instance_type, NVL(g.instance_set_id, 0) AS iset, g.menu_id
  FROM fnd_grants g
  JOIN fnd_objects o ON o.object_id = g.object_id
  JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
  JOIN fnd_form_functions ff ON ff.function_id = cmf.function_id
  WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)
    AND (o.obj_name, ff.function_name) IN (/* the 59 U pairs of the 11 objects */ ('PO_HEADERS_ALL','read')))
SELECT obj_name, function_name, COUNT(*) AS n_grants, COUNT(DISTINCT grantee_key) AS n_grantees, COUNT(DISTINCT menu_id) AS n_menus,
       SUM(CASE WHEN instance_type = 'GLOBAL' THEN 1 ELSE 0 END) AS n_global,
       COUNT(DISTINCT CASE WHEN instance_type = 'SET' THEN iset END) AS n_sets,
       SUM(DISTINCT ORA_HASH(grantee_key || ':' || instance_type || ':' || iset)) AS grant_sig
FROM g GROUP BY obj_name, function_name ORDER BY obj_name, function_name;
```

Offline inputs: `data/security/_02_*.csv` (privileges, descriptions), `_03_*.csv` (instance-set
text), `_04_*.csv` (grant links per set), `coverage/objects.csv` (classes); release v2027_04
tables `otbi_folder`, `tables`, `sec_object`, `table_security`, `table_disallowed`, `table_usages`;
demo logs `C:\Marat\OSaaS\ClaudeShared\Bip\OTBI\results\logs` (234 of 86,973 files carry
`fnd_grants gnt`).

## Appendix B. HCM duty map by object (230 pairs; duties abbreviated: `ORA_FBI_` / `_DUTY_HCM` / `_TRANSACTION_ANALYSIS` dropped, `xxkd:` = Kornit copy)

| object | privilege | duties | in U | duty list |
|---|---|---|---|---|
| ANC_PER_ABS_ENTRIES | ANC_REPORT_ABSENCE_RECORD_DATA | 2 | N | ABSENCE_MANAGEMENT xxkd:ABSENCE_MANAGEMENT |
| ANC_PER_ACRL_ENTRY_DTLS | ANC_REPORT_DONATIONS_DATA | 1 | N | LEAVE_DONATION |
| ANC_PER_AVAILABILITIES | ANC_REPORT_AVAILABILITY_PATTERNS_DATA | 2 | N | AVAILABILITY_PATTERNS xxkd:AVAILABILITY_PATTERNS |
| BEN_BENEFIT_RELATIONS_F | BEN_REPORT_BENEFIT_RELATION_DATA | 1 | N | BENEFITS |
| BEN_BENFTS_GRP | BEN_REPORT_BENEFIT_GROUP_DATA | 1 | N | BENEFITS |
| BEN_ELIG_PER_F | BEN_REPORT_BENEFIT_ELIGIBLE_PERSON_DATA | 1 | N | BENEFITS |
| BEN_LER_F | BEN_REPORT_LIFE_EVENT_REASON_DATA | 1 | N | BENEFITS |
| BEN_OIPL_F | BEN_REPORT_BENEFIT_OPTION_IN_PLAN_DATA | 1 | N | BENEFITS |
| BEN_OPT_F | BEN_REPORT_BENEFIT_OPTION_DATA | 1 | N | BENEFITS |
| BEN_PER_IN_LER | BEN_REPORT_PERSON_LIFE_EVENT_DATA | 1 | N | BENEFITS |
| BEN_PGM_F | BEN_REPORT_BENEFIT_PROGRAM_DATA | 1 | N | BENEFITS |
| BEN_PL_F | BEN_REPORT_BENEFIT_PLAN_DATA | 1 | N | BENEFITS |
| BEN_PL_TYP_F | BEN_REPORT_BENEFIT_PLAN_TYPE_DATA | 1 | N | BENEFITS |
| BEN_PRTT_ENRT_RSLT | BEN_REPORT_BENEFIT_PARTICIPANT_ENROLLMENT_RESULT_DATA | 1 | N | BENEFITS |
| BEN_PTIP_F | BEN_REPORT_BENEFIT_PLAN_TYPE_IN_PROGRAM_DATA | 1 | N | BENEFITS |
| BEN_PTNL_LER_FOR_PER | BEN_REPORT_PERSON_LIFE_EVENT_DATA | 1 | N | BENEFITS |
| CEL_RECOGNITIONS | CEL_REPORT_PERSON_CELEBRATION_DATA | 1 | N | HCM_CELEBRATE |
| CMP_CWB_PERSON_RATES | CMP_REPORT_COMPENSATION_ALLOCATION_DATA | 2 | N | COMPENSATION xxkd:COMPENSATION |
| CMP_SALARY | CMP_REPORT_SALARY_DATA | 4 | Y | COMPENSATION WORKFORCE_ASSIGNMENT_SALARY xxkd:COMPENSATION xxkd:WORKFORCE_ASSIGNMENT_SALARY |
| CMP_STOCK_DETAILS | CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA | 2 | N | COMPENSATION xxkd:COMPENSATION |
| ESS_REQUEST_HISTORY | ESS_REQUEST_CANCEL | 1 | N | ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY |
| ESS_REQUEST_HISTORY | ESS_REQUEST_HOLD | 1 | N | ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY |
| ESS_REQUEST_HISTORY | ESS_REQUEST_LOCK | 1 | N | ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY |
| ESS_REQUEST_HISTORY | ESS_REQUEST_READ | 1 | N | ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY |
| ESS_REQUEST_HISTORY | ESS_REQUEST_RELEASE | 1 | N | ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY |
| HMO_MODEL_PLANS_B | HMO_REPORT_WORKFORCE_MODEL_PLAN_DATA | 3 | N | WORKFORCE_MODELING xxkd:WORKFORCE_MODELING XXKD_XXKD_FBI_WORKFORCE_MODELING_TRANSACTION_ANALYSIS_NEW_NEW |
| HRA_CHECK_IN_MEETINGS | HRA_REPORT_CHECK_IN_DOCUMENT_DATA | 2 | N | PERFORMANCE_MANAGEMENT xxkd:PERFORMANCE_MANAGEMENT |
| HRA_EVALUATIONS | HRA_REPORT_PERFORMANCE_DOCUMENT_DATA | 2 | Y | PERFORMANCE_MANAGEMENT xxkd:PERFORMANCE_MANAGEMENT |
| HRA_FEEDBACK_REQUEST | HRA_REPORT_REQUESTED_FEEDBACK_DATA | 2 | N | PERFORMANCE_MANAGEMENT xxkd:PERFORMANCE_MANAGEMENT |
| HRG_GOALS | HRG_REPORT_CAREER_DEVELOPMENT_DATA | 2 | N | CAREER_DEV xxkd:CAREER_DEV |
| HRG_GOALS | HRG_REPORT_PERFORMANCE_GOAL_DATA | 2 | N | GOAL_MANAGEMENT xxkd:GOAL_MANAGEMENT |
| HRG_GOAL_ACCESS | HRG_REPORT_SHARED_PERFORMANCE_GOAL_DATA | 2 | N | GOAL_MANAGEMENT xxkd:GOAL_MANAGEMENT |
| HRM_PLANS | HRM_REPORT_SUCCESSION_PLAN_DATA | 1 | Y | SUCCESSION_MANAGEMENT |
| HRM_PLAN_CANDIDATES | HRM_REPORT_SUCCESSION_PLAN_CANDIDATE_DATA | 1 | N | SUCCESSION_MANAGEMENT |
| HRM_POOLS_V | HRM_REPORT_TALENT_POOL_DATA | 2 | N | SUCCESSION_MANAGEMENT TALENT_REVIEW |
| HRQ_QSTNR_PART_GSVY_V | HRQ_REPORT_QUESTIONNAIRE_RESPONSES_DATA | 2 | N | HCM_QUESTIONNAIRES_GENERAL_SURVEY_RESPONSES xxkd:HCM_QUESTIONNAIRES_GENERAL_SURVEY_RESPONSES |
| HRT_PROFILES_B | HRT_REPORT_TALENT_PROFILE_DATA | 2 | Y | WORKFORCE_PROFILE xxkd:WORKFORCE_PROFILE |
| HRT_PROFILE_ITEMS | HRT_REPORT_TALENT_PROFILE_ITEM_DATA | 2 | N | WORKFORCE_PROFILE xxkd:WORKFORCE_PROFILE |
| HRY_PI_INBD_RECORDS | HRY_REPORT_PAYROLL_INTERFACE_INBOUND_RECORD_DATA | 1 | N | PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS |
| HR_ALL_ORGANIZATION_UNITS_F | PER_REPORT_DEPARTMENT_DATA | 42 | N | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| HR_ALL_ORGANIZATION_UNITS_F | PER_REPORT_LEGAL_EMPLOYER_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING_SOURCING RECRUITING xxkd:INDIVIDUAL_COMPENSATION |
| HR_ALL_ORGANIZATION_UNITS_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| HR_ALL_POSITIONS_F | PER_REPORT_POSITION_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| HR_ALL_POSITIONS_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| HR_DOCUMENTS_OF_RECORD | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| HR_DOCUMENT_DELIVERY_PREFS | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| HR_DOCUMENT_TYPES_B | PER_REPORT_DOCUMENT_TYPE_DATA | 3 | N | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| HR_DOR_MASS_REQUESTS | PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA | 1 | N | DOCUMENT_RECORD_MASS_DOWNLOAD_HISTORY |
| HR_ORGANIZATION_INFORMATION_F | PER_REPORT_LEGAL_EMPLOYER_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING_SOURCING RECRUITING xxkd:INDIVIDUAL_COMPENSATION |
| HR_ORGANIZATION_INFORMATIO_EFC | PER_REPORT_LEGAL_EMPLOYER_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING_SOURCING RECRUITING xxkd:INDIVIDUAL_COMPENSATION |
| HR_ORG_UNIT_CLASSIFICATIONS_F | PER_REPORT_DEPARTMENT_DATA | 42 | N | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| HR_ORG_UNIT_CLASSIFICATIONS_F | PER_REPORT_LEGAL_EMPLOYER_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING_SOURCING RECRUITING xxkd:INDIVIDUAL_COMPENSATION |
| HR_ORG_UNIT_CLASSIFICATIONS_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| HTS_COVERAGES | HTS_REPORT_COVERAGE_DATA | 2 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY |
| HTS_SCHEDULES | HTS_REPORT_WORKFORCE_SCHEDULES_DATA | 2 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY |
| HTS_SCHED_UNITS_DEPARTMENT_V | HTS_REPORT_DEPARTMENT_DATA | 3 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY |
| HTS_STAFFING_VOLUMES | HTS_REPORT_VOLUME_DATA | 2 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY |
| HTS_WORKLOADS | HTS_REPORT_WORKLOAD_DATA | 3 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY |
| HTS_WORKLOAD_PLANS | HTS_REPORT_WORKLOAD_DATA | 3 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY |
| HTS_WORK_PATTERN_ASSIGNMENTS | HTS_REPORT_WORK_PATTERNS_DATA | 2 | N | ADVANCED_WORKFORCE_SCHEDULING ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY |
| HWM_ATTENDANCE_VIOLATIONS | HXT_REPORT_ATTENDANCE_VIOLATIONS_DATA | 1 | N | TIME_AND_LABOR |
| HWM_TM_REC | HXT_REPORT_TIME_LABOR_DATA | 2 | N | TIME_AND_LABOR xxkd:TIME_AND_LABOR |
| HWM_TM_REC_CHANGE_REQS | HXT_REPORT_TIME_CHANGE_REQUESTS_DATA | 1 | N | TIME_AND_LABOR |
| IRC_BC_CAND_RESULTS | IRC_REPORT_EMPLOYMENT_SCREENING_RESULTS_DATA | 1 | N | RECRUITING |
| IRC_COMM_CAMPAIGNS_V | IRC_REPORT_HCM_COMMUNICATE_CAMPAIGNS_DATA | 1 | N | HCM_COMMUNICATE_CAMPAIGNS |
| IRC_OFFERS | IRC_REPORT_JOB_OFFER_DATA | 1 | Y | RECRUITING |
| IRC_OFFERS | IRC_REPORT_JOB_OFFER_OTHER_COMPENSATION_DATA | 1 | N | RECRUITING |
| IRC_OFFERS | IRC_REPORT_JOB_OFFER_SALARY_DATA | 1 | N | RECRUITING |
| IRC_POOLS_V | IRC_REPORT_CANDIDATE_POOL_DATA | 1 | N | RECRUITING |
| IRC_REC_EVENTS_B | IRC_REPORT_HIRING_EVENT_DATA | 1 | N | HIRING_EVENTS |
| IRC_REQUISITIONS_B | IRC_REPORT_JOB_REQUISITION_DATA | 2 | Y | RECRUITING_SOURCING RECRUITING |
| IRC_SUBMISSIONS | IRC_REPORT_CANDIDATE_JOB_APPLICATION_DATA | 1 | Y | RECRUITING |
| PAY_ALL_PAYROLLS_F | PAY_REPORT_PAYROLL_DEFINITION_DATA | 15 | Y | INDIVIDUAL_COMPENSATION PAYROLL_ACTIVITY_CENTER PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_FLOW_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PAY_BALANCE_CATEGORIES_F | PAY_REPORT_PAYROLL_BALANCE_DATA | 1 | Y | PAYROLL |
| PAY_BALANCE_TYPES | PAY_REPORT_PAYROLL_BALANCE_DATA | 1 | Y | PAYROLL |
| PAY_DEDUCTION_TYPES | PAY_REPORT_PAYROLL_DEDUCTION_DATA | 1 | Y | PAYROLL |
| PAY_DEFINED_BALANCES | PAY_REPORT_PAYROLL_BALANCE_DATA | 1 | Y | PAYROLL |
| PAY_DIR_CARD_COMP_DEFS_F | PAY_REPORT_PAYROLL_DEDUCTION_DATA | 7 | Y | PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL |
| PAY_ELEMENT_TYPES_F | PAY_REPORT_PAYROLL_ELEMENT_DATA | 11 | Y | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION |
| PAY_ELEMENT_TYPES_F_V | PAY_REPORT_PAYROLL_ELEMENT_DATA | 5 | Y | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL |
| PAY_ELE_CLASSIFICATIONS | PAY_REPORT_PAYROLL_ELEMENT_DATA | 1 | Y | PAYROLL |
| PAY_FLOWS | PAY_REPORT_PAYROLL_FLOW_DATA | 9 | N | PAYROLL_ACTIVITY_CENTER PAYROLL_BALANCES_TRANSACTION PAYROLL_FLOW_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL |
| PAY_FLOW_INSTANCES | PAY_REPORT_PAYROLL_FLOW_DATA | 1 | N | PAYROLL |
| PAY_OBJECT_GROUPS | PAY_REPORT_OBJECT_GROUP_DATA | 1 | N | PAYROLL |
| PAY_ORG_PAY_METHODS_F | PAY_REPORT_PAYROLL_PAYMENT_DATA | 4 | N | PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL |
| PAY_PAY_RELATIONSHIPS_DN | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_COSTING_SETUP_DETAILS_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PAY_PAY_RELATIONSHIPS_DN | PAY_REPORT_PERSON_PROCESS_RESULTS_DATA | 15 | Y | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PAY_PAY_RELATIONSHIPS_F | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA | 15 | N | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_COSTING_SETUP_DETAILS_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PAY_PAY_RELATIONSHIPS_F | PAY_REPORT_PERSON_PROCESS_RESULTS_DATA | 15 | Y | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PAY_PERSON_PAY_METHODS_F | PAY_REPORT_PAYROLL_PAYMENT_DATA | 4 | N | PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL |
| PAY_RUN_TYPES_F | PAY_REPORT_PAYROLL_DEFINITION_DATA | 5 | Y | PAYROLL_BALANCES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL |
| PAY_TIME_PERIODS | PAY_REPORT_PAYROLL_DEFINITION_DATA | 6 | Y | PAYROLL_BALANCES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL |
| PAY_TIME_PERIOD_TYPES | PAY_REPORT_PAYROLL_DEFINITION_DATA | 2 | Y | PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL |
| PER_ABSENCE_CASES | PER_MANAGE_ABSENCE_CASE_DATA | 1 | N | ORA_PER_ABSENCE_ANALYSIS_DUTY |
| PER_ADDRESSES | IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_ADDRESSES | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ADDRESSES | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ADDRESSES_F | IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_ADDRESSES_F | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ADDRESSES_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ALLOCATED_CHECKLISTS | PER_REPORT_PERSON_CHECKLIST_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_ALLOCATED_TASKS | PER_REPORT_PERSON_CHECKLIST_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_ALL_ASSIGNMENTS_M | ANC_REPORT_ABSENCE_RECORD_DATA | 2 | N | ABSENCE_MANAGEMENT xxkd:ABSENCE_MANAGEMENT |
| PER_ALL_ASSIGNMENTS_M | ANC_REPORT_AVAILABILITY_PATTERNS_DATA | 2 | N | AVAILABILITY_PATTERNS xxkd:AVAILABILITY_PATTERNS |
| PER_ALL_ASSIGNMENTS_M | ANC_REPORT_DONATIONS_DATA | 1 | N | LEAVE_DONATION |
| PER_ALL_ASSIGNMENTS_M | CMP_REPORT_COMPENSATION_ALLOCATION_DATA | 2 | Y | COMPENSATION xxkd:COMPENSATION |
| PER_ALL_ASSIGNMENTS_M | CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA | 2 | N | COMPENSATION xxkd:COMPENSATION |
| PER_ALL_ASSIGNMENTS_M | CMP_REPORT_SALARY_DATA | 4 | N | COMPENSATION WORKFORCE_ASSIGNMENT_SALARY xxkd:COMPENSATION xxkd:WORKFORCE_ASSIGNMENT_SALARY |
| PER_ALL_ASSIGNMENTS_M | HRA_REPORT_CHECK_IN_DOCUMENT_DATA | 2 | N | PERFORMANCE_MANAGEMENT xxkd:PERFORMANCE_MANAGEMENT |
| PER_ALL_ASSIGNMENTS_M | HRA_REPORT_PERFORMANCE_DOCUMENT_DATA | 2 | N | PERFORMANCE_MANAGEMENT xxkd:PERFORMANCE_MANAGEMENT |
| PER_ALL_ASSIGNMENTS_M | HRG_REPORT_PERFORMANCE_GOAL_DATA | 2 | N | GOAL_MANAGEMENT xxkd:GOAL_MANAGEMENT |
| PER_ALL_ASSIGNMENTS_M | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA | 7 | Y | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_COSTING_SETUP_DETAILS_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_ASSIGNMENT_DATA | 8 | N | COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION WORKFORCE_ASSIGNMENT_SALARY xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:WORKFORCE_ASSIGNMENT_SALARY |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_PERSON_ASSIGNMENT_DATA | 10 | Y | COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_PERSON_DATA | 34 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_SENIORITY_DATE_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_VACANCY_DATA | 2 | N | VACANCY xxkd:VACANCY |
| PER_ALL_ASSIGNMENTS_M | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 2 | Y | DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_ALL_ASSIGNMENTS_M | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ALL_ASSIGNMENTS_M | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ALL_PEOPLE_F | HRG_REPORT_CAREER_DEVELOPMENT_DATA | 2 | N | CAREER_DEV xxkd:CAREER_DEV |
| PER_ALL_PEOPLE_F | HRM_REPORT_SUCCESSION_PLAN_CANDIDATE_DATA | 1 | N | SUCCESSION_MANAGEMENT |
| PER_ALL_PEOPLE_F | HRM_REPORT_SUCCESSION_PLAN_INCUMBENT_DATA | 1 | N | SUCCESSION_MANAGEMENT |
| PER_ALL_PEOPLE_F | HXT_REPORT_ATTENDANCE_VIOLATIONS_DATA | 1 | N | TIME_AND_LABOR |
| PER_ALL_PEOPLE_F | HXT_REPORT_TIME_CHANGE_REQUESTS_DATA | 1 | N | TIME_AND_LABOR |
| PER_ALL_PEOPLE_F | HXT_REPORT_TIME_LABOR_DATA | 2 | N | TIME_AND_LABOR xxkd:TIME_AND_LABOR |
| PER_ALL_PEOPLE_F | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA | 14 | Y | INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_COSTING_SETUP_DETAILS_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PER_ALL_PEOPLE_F | PAY_REPORT_PERSON_PROCESS_RESULTS_DATA | 15 | N | BENEFITS COMPENSATION INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL xxkd:INDIVIDUAL_COMPENSATION |
| PER_ALL_PEOPLE_F | PER_MANAGE_ABSENCE_CASE_DATA | 1 | N | ORA_PER_ABSENCE_ANALYSIS_DUTY |
| PER_ALL_PEOPLE_F | PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA | 1 | N | DOCUMENT_RECORD_MASS_DOWNLOAD_HISTORY |
| PER_ALL_PEOPLE_F | PER_REPORT_PERSON_CHECKLIST_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_ALL_PEOPLE_F | PER_REPORT_PERSON_CONTACT_DISABILITY_DATA | 1 | N | PERSON_DISABILITY |
| PER_ALL_PEOPLE_F | PER_REPORT_PERSON_DATA | 38 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ALL_PEOPLE_F | PER_REPORT_PERSON_DISABILITY_DATA | 1 | N | PERSON_DISABILITY |
| PER_ALL_PEOPLE_F | PER_REPORT_PERSON_EXTRA_INFORMATION_DATA | 1 | N | WORKFORCE |
| PER_ALL_PEOPLE_F | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_ALL_PEOPLE_F | PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_ALL_PEOPLE_F | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ALL_PEOPLE_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASG_REPRESENTATIVES | PER_REPORT_AREAS_OF_RESPONSIBILITY_MAPPING_DATA | 1 | N | AREAS_OF_RESPONSIBILITY |
| PER_ASG_RESPONSIBILITIES | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASG_RESPONSIBILITIES | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGNMENT_EXTRA_INFO_M | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGNMENT_EXTRA_INFO_M | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGNMENT_SUPERVISORS_F | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGNMENT_SUPERVISORS_F | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGN_GRADE_STEPS_F | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGN_GRADE_STEPS_F | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGN_WORK_MEASURES_F | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ASSIGN_WORK_MEASURES_F | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_CHK_GUIDED_RESPONSES | PER_REPORT_GUIDED_JOURNEY_RESPONSE_DATA | 1 | N | GUIDED_JOURNEY_RESPONSES |
| PER_CITIZENSHIPS | IRC_REPORT_PERSON_CITIZENSHIP_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_CITIZENSHIPS | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_CONTRACTS_F | PER_REPORT_WORKER_CONTRACT_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_DISABILITIES_F | PER_REPORT_PERSON_CONTACT_DISABILITY_DATA | 1 | N | PERSON_DISABILITY |
| PER_DISABILITIES_F | PER_REPORT_PERSON_DISABILITY_DATA | 1 | Y | PERSON_DISABILITY |
| PER_DRIVERS_LICENSES | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_DRIVERS_LICENSE_TYPES | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_EMAIL_ADDRESSES | IRC_REPORT_PERSON_EMAIL_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_EMAIL_ADDRESSES | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_EMAIL_ADDRESSES | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_ETHNICITIES | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_ETHNICITIES | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_EXT_APP_IDENTIFIERS | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_EXT_APP_IDENTIFIERS | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_GRADES_F | PER_REPORT_ASSIGNMENT_GRADE_DATA | 40 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADES_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_GRADES_IN_LADDERS_F | PER_REPORT_ASSIGNMENT_GRADE_LADDER_DATA | 29 | N | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADE_EXTRA_INFO_F | PER_REPORT_ASSIGNMENT_GRADE_DATA | 40 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADE_EXTRA_INFO_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_GRADE_LADDERS_F | PER_REPORT_ASSIGNMENT_GRADE_LADDER_DATA | 29 | N | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADE_LADDER_LEG_F | PER_REPORT_ASSIGNMENT_GRADE_LADDER_DATA | 29 | N | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL RECRUITING VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADE_LEG_F | PER_REPORT_ASSIGNMENT_GRADE_DATA | 40 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_GRADE_LEG_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_IMAGES | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_JOBS_F | PER_REPORT_HR_JOB_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_JOBS_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_JOB_EXTRA_INFO_F | PER_REPORT_HR_JOB_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_JOB_EXTRA_INFO_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_JOB_LEG_F | PER_REPORT_HR_JOB_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_JOB_LEG_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_LEGISLATIVE_DATA_GROUPS | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA | 16 | Y | INDIVIDUAL_COMPENSATION PAYROLL_ACTIVITY_CENTER PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_FLOW_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PAYROLL_USER_DEFINED_TABLES_TRANSACTION xxkd:INDIVIDUAL_COMPENSATION |
| PER_LOCATIONS | PER_REPORT_LOCATION_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_LOCATIONS | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_LOCATION_DETAILS_F | PER_REPORT_LOCATION_DATA | 43 | Y | ABSENCE_MANAGEMENT ADVANCED_WORKFORCE_SCHEDULING AVAILABILITY_PATTERNS BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT RECRUITING_SOURCING RECRUITING TIME_AND_LABOR VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_LOCATION_DETAILS_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_NATIONAL_IDENTIFIERS | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_NATIONAL_IDENTIFIERS | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PASSPORTS | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PER_PEOPLE_EXTRA_INFO_F | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PEOPLE_EXTRA_INFO_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PEOPLE_LEGISLATIVE_F | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PEOPLE_LEGISLATIVE_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERIODS_OF_SERVICE | PER_REPORT_WORK_RELATIONSHIP_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_PERIODS_OF_SERVICE | PER_REVIEW_WORKER_AVAILABILITY_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERIODS_OF_SERVICE | PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERSONS | PER_REPORT_PUBLIC_PERSON_DATA | 22 | Y | COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL SHARE_DATA_ACCESS WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PERSON_ADDR_USAGES_F | IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_PERSON_ADDR_USAGES_F | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PERSON_ADDR_USAGES_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERSON_DLVRY_METHODS | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PERSON_DLVRY_METHODS | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERSON_NAMES_F | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PERSON_NAMES_F | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PERSON_TYPE_USAGES_M | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PERSON_TYPE_USAGES_M | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_PHONES | IRC_REPORT_PERSON_PHONE_FOR_RECRUITING_DATA | 1 | N | RECRUITING |
| PER_PHONES | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_PHONES | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_RATES_F | PER_REPORT_ASSIGNMENT_GRADE_RATE_DATA | 28 | Y | ABSENCE_MANAGEMENT AVAILABILITY_PATTERNS COMPENSATION_EXTERNAL_DATA COMPENSATION HCM_CELEBRATE INDIVIDUAL_COMPENSATION LEAVE_DONATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL VACANCY WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:ABSENCE_MANAGEMENT xxkd:AVAILABILITY_PATTERNS xxkd:COMPENSATION xxkd:INDIVIDUAL_COMPENSATION xxkd:VACANCY xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_RELIGIONS | PER_REPORT_PERSON_DATA | 33 | Y | BENEFITS CAREER_DEV COMPENSATION_EXTERNAL_DATA COMPENSATION DOCUMENTS_OF_RECORD GOAL_MANAGEMENT HCM_CELEBRATE INDIVIDUAL_COMPENSATION PAYROLL_BALANCES_TRANSACTION PAYROLL_CALCULATION_CARD_TRANSACTION PAYROLL_ELEMENT_ENTRIES_TRANSACTION PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS PAYROLL_PAYMENTS_COSTING_TRANSACTION PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION PAYROLL_RETROACTIVE_PAY_TRANSACTION PAYROLL_RUN_COSTING_TRANSACTION PAYROLL_RUN_RESULTS_TRANSACTION PAYROLL PERFORMANCE_MANAGEMENT TIME_AND_LABOR WORKFORCE_ASSIGNMENT_SALARY WORKFORCE xxkd:CAREER_DEV xxkd:COMPENSATION xxkd:DOCUMENTS_OF_RECORD xxkd:GOAL_MANAGEMENT xxkd:INDIVIDUAL_COMPENSATION xxkd:PERFORMANCE_MANAGEMENT xxkd:TIME_AND_LABOR xxkd:WORKFORCE_ASSIGNMENT_SALARY xxkd:WORKFORCE |
| PER_RELIGIONS | PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA | 1 | N | ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY |
| PER_REQUISITIONS_INTERFACE_B | PER_REPORT_VACANCY_DATA | 2 | N | VACANCY xxkd:VACANCY |
| PER_RESOURCE_EXCEPTIONS | PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_SCHEDULE_ASSIGNMENTS | PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_SCHEDULE_EXCEPTIONS | PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA | 2 | N | WORKFORCE xxkd:WORKFORCE |
| PER_SHARE_INFORMATION | PER_REPORT_SHARE_DATA_ACCESS_DATA | 1 | N | SHARE_DATA_ACCESS |
| PER_VISAS_PERMITS_F | PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA | 3 | Y | BENEFITS DOCUMENTS_OF_RECORD xxkd:DOCUMENTS_OF_RECORD |
| PJB_BILLING_EVENTS | PJB_EXTRACT_N_WAREHOUSE_PROJECT_BILLING_EVENTS_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJB_BILLING_EVENTS | PJB_MANAGE_PROJECT_BILLING_EVENT_DATA | 1 | N | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJB_CNTRCT_PROJ_LINKS | OKC_MANAGE_CONTRACT_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJB_INV_LINE_DISTS | PJB_MANAGE_PROJECT_CONTRACT_INVOICE_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJB_REV_DISTRIBUTIONS | PJB_MAINTAIN_PROJECT_CONTRACT_REVENUE_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJC_COMMITMENT_TXNS | PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJC_COST_DIST_LINES_ALL | PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJC_EXP_ITEMS_ALL | PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA | 1 | Y | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| PJC_TXN_XFACE_ALL | PJC_MANAGE_PROJECT_UNPROCESSED_EXPENDITURE_ITEM_DATA | 1 | N | ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY |
| WLF_ASSIGNMENT_RECORDS_V | WLF_REPORT_LEARNING_RECORD_DATA | 1 | N | LEARNING |
| WLF_CATALOG_LEARNING_ITEMS_VL | WLF_REPORT_CATALOG_ITEM_DATA | 1 | N | LEARNING |
| WLF_LI_CONTENT_F | WLF_REPORT_ELEARNING_CONTENT_DATA | 1 | N | LEARNING |

## Appendix C. HCM duty map by duty (71 roles)

| duty | kind | pairs | objects | objects with 2+ privileges for this duty |
|---|---|---|---|---|
| ORA_FBI_ABSENCE_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 19 | 18 | PER_ALL_ASSIGNMENTS_M: ANC_REPORT_ABSENCE_RECORD_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_ADVANCED_WORKFORCE_SCHEDULING_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 13 | 13 | - |
| ORA_FBI_AREAS_OF_RESPONSIBILITY_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_AVAILABILITY_PATTERNS_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 19 | 18 | PER_ALL_ASSIGNMENTS_M: ANC_REPORT_AVAILABILITY_PATTERNS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_BENEFITS_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 55 | 53 | PER_ALL_PEOPLE_F: PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA|PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA |
| ORA_FBI_CAREER_DEV_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 29 | 28 | PER_ALL_PEOPLE_F: HRG_REPORT_CAREER_DEVELOPMENT_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_COMPENSATION_EXTERNAL_DATA_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 34 | 32 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_COMPENSATION_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 46 | 39 | PER_ALL_ASSIGNMENTS_M: CMP_REPORT_COMPENSATION_ALLOCATION_DATA|CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA|CMP_REPORT_SALARY_DATA|PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_DOCUMENTS_OF_RECORD_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 27 | 25 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_PERSON_DATA|PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA; PER_ALL_PEOPLE_F: PER_REPORT_PERSON_DATA|PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA |
| ORA_FBI_DOCUMENT_RECORD_MASS_DOWNLOAD_HISTORY_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 2 | 2 | - |
| ORA_FBI_GOAL_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 30 | 29 | PER_ALL_ASSIGNMENTS_M: HRG_REPORT_PERFORMANCE_GOAL_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_GUIDED_JOURNEY_RESPONSES_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_HCM_CELEBRATE_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 35 | 33 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_HCM_COMMUNICATE_CAMPAIGNS_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_HCM_QUESTIONNAIRES_GENERAL_SURVEY_RESPONSES_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_HIRING_EVENTS_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_INDIVIDUAL_COMPENSATION_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 49 | 40 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_ASSIGNMENTS_M: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_LEARNING_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 3 | 3 | - |
| ORA_FBI_LEAVE_DONATION_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 19 | 18 | PER_ALL_ASSIGNMENTS_M: ANC_REPORT_DONATIONS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_ACTIVITY_CENTER_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 3 | 3 | - |
| ORA_FBI_PAYROLL_BALANCES_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 48 | 42 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_CALCULATION_CARD_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 46 | 40 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_COSTING_SETUP_DETAILS_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 4 | 4 | - |
| ORA_FBI_PAYROLL_ELEMENT_ENTRIES_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 47 | 40 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_ASSIGNMENTS_M: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PER_REPORT_PERSON_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_FLOW_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 3 | 3 | - |
| ORA_FBI_PAYROLL_INTERFACE_TRANSACTIONAL_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 33 | 33 | - |
| ORA_FBI_PAYROLL_PAYMENTS_COSTING_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 47 | 41 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_PAYMENTS_DISTRIBUTION_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 48 | 42 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_PERSONAL_PAYMENT_METHODS_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 46 | 40 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_RATE_CALCULATION_RESULTS_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 45 | 39 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_RETROACTIVE_PAY_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 47 | 41 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_RUN_COSTING_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 48 | 42 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_RUN_RESULTS_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 49 | 43 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 61 | 54 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_ASSIGNMENTS_M: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PER_REPORT_PERSON_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PAYROLL_USER_DEFINED_TABLES_TRANSACTION_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_PERFORMANCE_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 32 | 30 | PER_ALL_ASSIGNMENTS_M: HRA_REPORT_CHECK_IN_DOCUMENT_DATA|HRA_REPORT_PERFORMANCE_DOCUMENT_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_PERSON_DISABILITY_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 4 | 2 | PER_ALL_PEOPLE_F: PER_REPORT_PERSON_CONTACT_DISABILITY_DATA|PER_REPORT_PERSON_DISABILITY_DATA; PER_DISABILITIES_F: PER_REPORT_PERSON_CONTACT_DISABILITY_DATA|PER_REPORT_PERSON_DISABILITY_DATA |
| ORA_FBI_RECRUITING_SOURCING_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 16 | 14 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA |
| ORA_FBI_RECRUITING_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 31 | 27 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; IRC_OFFERS: IRC_REPORT_JOB_OFFER_DATA|IRC_REPORT_JOB_OFFER_OTHER_COMPENSATION_DATA|IRC_REPORT_JOB_OFFER_SALARY_DATA |
| ORA_FBI_SHARE_DATA_ACCESS_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 2 | 2 | - |
| ORA_FBI_SUCCESSION_MANAGEMENT_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 5 | 4 | PER_ALL_PEOPLE_F: HRM_REPORT_SUCCESSION_PLAN_CANDIDATE_DATA|HRM_REPORT_SUCCESSION_PLAN_INCUMBENT_DATA |
| ORA_FBI_TALENT_REVIEW_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_TIME_AND_LABOR_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 32 | 29 | PER_ALL_PEOPLE_F: HXT_REPORT_ATTENDANCE_VIOLATIONS_DATA|HXT_REPORT_TIME_CHANGE_REQUESTS_DATA|HXT_REPORT_TIME_LABOR_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_VACANCY_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 17 | 17 | - |
| ORA_FBI_WORKFORCE_ASSIGNMENT_SALARY_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 36 | 33 | PER_ALL_ASSIGNMENTS_M: CMP_REPORT_SALARY_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA |
| ORA_FBI_WORKFORCE_MODELING_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 1 | 1 | - |
| ORA_FBI_WORKFORCE_PROFILE_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 2 | 2 | - |
| ORA_FBI_WORKFORCE_TRANSACTION_ANALYSIS_DUTY_HCM | ORA_FBI_*_DUTY_HCM | 44 | 39 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA|PER_REPORT_SENIORITY_DATE_DATA; PER_ALL_PEOPLE_F: PER_REPORT_PERSON_CHECKLIST_DATA|PER_REPORT_PERSON_DATA|PER_REPORT_PERSON_EXTRA_INFORMATION_DATA|PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA |
| ORA_HTS_WORKFORCE_SCHEDULE_ADMINISTRATOR_TRANSACTION_ANALYSIS_DUTY | other analysis duty | 15 | 15 | - |
| ORA_HTS_WORKFORCE_SCHEDULE_MANAGER_TRANSACTION_ANALYSIS_DUTY | other analysis duty | 11 | 11 | - |
| ORA_PER_ABSENCE_ANALYSIS_DUTY | other analysis duty | 2 | 2 | - |
| ORA_PER_HUMAN_RESOURCES_SPECIALIST_TRANSACTION_DASHBOARD_ANALYSIS_DUTY | other analysis duty | 26 | 26 | - |
| ORA_PER_MANAGER_TRANSACTION_DASHBOARD_ANALYSIS_DUTY | other analysis duty | 15 | 8 | PER_ALL_ASSIGNMENTS_M: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_ASG_RESPONSIBILITIES: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_ASSIGNMENT_EXTRA_INFO_M: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_ASSIGNMENT_SUPERVISORS_F: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_ASSIGN_GRADE_STEPS_F: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_ASSIGN_WORK_MEASURES_F: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA; PER_PERIODS_OF_SERVICE: PER_REVIEW_WORKER_AVAILABILITY_DATA|PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA |
| ORA_PJF_PROJECTS_REPORTING_ANALYSIS_DUTY | other analysis duty | 9 | 8 | PJB_BILLING_EVENTS: PJB_EXTRACT_N_WAREHOUSE_PROJECT_BILLING_EVENTS_DATA|PJB_MANAGE_PROJECT_BILLING_EVENT_DATA |
| ORA_ZSP_PRODUCT_RECOMMENDATION_ANALYSIS_DUTY | other analysis duty | 5 | 1 | ESS_REQUEST_HISTORY: ESS_REQUEST_CANCEL|ESS_REQUEST_HOLD|ESS_REQUEST_LOCK|ESS_REQUEST_READ|ESS_REQUEST_RELEASE |
| XXKD_FBI_ABSENCE_MANAGEMENT_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 19 | 18 | PER_ALL_ASSIGNMENTS_M: ANC_REPORT_ABSENCE_RECORD_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_AVAILABILITY_PATTERNS_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 19 | 18 | PER_ALL_ASSIGNMENTS_M: ANC_REPORT_AVAILABILITY_PATTERNS_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_CAREER_DEV_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 29 | 28 | PER_ALL_PEOPLE_F: HRG_REPORT_CAREER_DEVELOPMENT_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_COMPENSATION_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 41 | 36 | PER_ALL_ASSIGNMENTS_M: CMP_REPORT_COMPENSATION_ALLOCATION_DATA|CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA|CMP_REPORT_SALARY_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_DOCUMENTS_OF_RECORD_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 27 | 25 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_PERSON_DATA|PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA; PER_ALL_PEOPLE_F: PER_REPORT_PERSON_DATA|PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA |
| XXKD_FBI_GOAL_MANAGEMENT_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 30 | 29 | PER_ALL_ASSIGNMENTS_M: HRG_REPORT_PERFORMANCE_GOAL_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_HCM_QUESTIONNAIRES_GENERAL_SURVEY_RESPONSES_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 1 | 1 | - |
| XXKD_FBI_INDIVIDUAL_COMPENSATION_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 48 | 39 | HR_ALL_ORGANIZATION_UNITS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; HR_ORG_UNIT_CLASSIFICATIONS_F: PER_REPORT_DEPARTMENT_DATA|PER_REPORT_LEGAL_EMPLOYER_DATA; PAY_PAY_RELATIONSHIPS_DN: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PAY_PAY_RELATIONSHIPS_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA; PER_ALL_ASSIGNMENTS_M: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA; PER_ALL_PEOPLE_F: PAY_REPORT_PAYROLL_RELATIONSHIP_DATA|PAY_REPORT_PERSON_PROCESS_RESULTS_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_PERFORMANCE_MANAGEMENT_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 32 | 30 | PER_ALL_ASSIGNMENTS_M: HRA_REPORT_CHECK_IN_DOCUMENT_DATA|HRA_REPORT_PERFORMANCE_DOCUMENT_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_TIME_AND_LABOR_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 28 | 27 | PER_ALL_PEOPLE_F: HXT_REPORT_TIME_LABOR_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_VACANCY_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 17 | 17 | - |
| XXKD_FBI_WORKFORCE_ASSIGNMENT_SALARY_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 36 | 33 | PER_ALL_ASSIGNMENTS_M: CMP_REPORT_SALARY_DATA|PER_REPORT_ASSIGNMENT_DATA|PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA |
| XXKD_FBI_WORKFORCE_MODELING_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 1 | 1 | - |
| XXKD_FBI_WORKFORCE_PROFILE_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 2 | 2 | - |
| XXKD_FBI_WORKFORCE_TRANSACTION_ANALYSIS_NEW | XXKD custom copy | 43 | 39 | PER_ALL_ASSIGNMENTS_M: PER_REPORT_PERSON_ASSIGNMENT_DATA|PER_REPORT_PERSON_DATA|PER_REPORT_SENIORITY_DATE_DATA; PER_ALL_PEOPLE_F: PER_REPORT_PERSON_CHECKLIST_DATA|PER_REPORT_PERSON_DATA|PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA |
| XXKD_XXKD_FBI_WORKFORCE_MODELING_TRANSACTION_ANALYSIS_NEW_NEW | XXKD custom copy | 1 | 1 | - |

## Appendix D. Top-300 BIP tables: outcome of the rule (tables with a security object or context; the 135 `none` tables are listed after the table)

| table | module | form | outcome | object : verdict : candidates |
|---|---|---|---|---|
| ZX_REP_TRX_DETAIL_T | ZX | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| XLE_ENTITY_PROFILES | XLE | direct | not_in_U | XLE_ENTITY_PROFILES:not_in_U: |
| WIE_WORK_ORDERS_B | WIE | via_reference | multi_context | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA; PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| RA_CUSTOMER_TRX_LINES_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| RA_CUSTOMER_TRX_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PSC_LNP_RECORD | PSC_PER | direct | not_in_U | PSC_LNP_RECORD:not_in_U: |
| PSC_LNP_PR_USER | PSC_PER | direct | not_in_U | PSC_LNP_PR_USER:not_in_U: |
| PO_HEADERS_ALL | PO | direct | ok | PO_HEADERS_ALL:unique_prefix:PO_VIEW_PO_DOC_ANALYSIS_DATA |
| POZ_SUPPLIER_SITES_ALL_M | POZ | via_reference | ambiguous_any | PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| POZ_SUPPLIERS_V | POZ | via_reference | ok | SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PJF_PROJECTS_ALL_VL | PJF | direct | ambiguous_prefix | PJF_PROJECTS_ALL_VL:ambiguous_prefix:PJF_MANAGE_PROJECT_TASK_STRUCTURE_DATA, PJF_VIEW_PROJECT_IN_PROJECT_LIST_DATA |
| PER_USERS | PER | direct | ok | PER_USERS:hcm_unique:PER_EDIT_USER_NAME_DATA |
| PER_PERSON_NAMES_F | PER | direct | hcm_ambiguous | PER_PERSON_NAMES_F:hcm_ambiguous:PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_PERSONS | PER | direct | ok | PER_PERSONS:hcm_unique:PER_REPORT_PUBLIC_PERSON_DATA |
| PER_IMAGES | PER | direct | ok | PER_IMAGES:hcm_unique:PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA |
| PER_EMAIL_ADDRESSES | PER | direct | hcm_ambiguous | PER_EMAIL_ADDRESSES:hcm_ambiguous:IRC_REPORT_PERSON_EMAIL_FOR_RECRUITING_DATA, PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_ASSIGNMENT_SUPERVISORS_F | PER | direct | hcm_ambiguous | PER_ASSIGNMENT_SUPERVISORS_F:hcm_ambiguous:PER_REVIEW_WORKER_AVAILABILITY_DATA, PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA |
| PER_ALL_PEOPLE_F | PER | direct | hcm_ambiguous | PER_ALL_PEOPLE_F:hcm_ambiguous:HRG_REPORT_CAREER_DEVELOPMENT_DATA, HRM_REPORT_SUCCESSION_PLAN_CANDIDATE_DATA, HRM_REPORT_SUCCESSION_PLAN_INCUMBENT_DATA, HXT_REPORT_ATTENDANCE_VIOLATIONS_DATA, HXT_REPORT_TIME_CHANGE_REQUESTS_DATA, HXT_REPORT_TIME_LABOR_DATA, PAY_REPORT_PAYROLL_RELATIONSHIP_DATA, PAY_REPORT_PERSON_PROCESS_RESULTS_DATA, PER_MANAGE_ABSENCE_CASE_DATA, PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA, PER_REPORT_PERSON_CHECKLIST_DATA, PER_REPORT_PERSON_CONTACT_DISABILITY_DATA, PER_REPORT_PERSON_DATA, PER_REPORT_PERSON_DISABILITY_DATA, PER_REPORT_PERSON_EXTRA_INFORMATION_DATA, PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA, PER_REPORT_WORK_SCHEDULE_ASSIGNMENT_DATA, PER_REVIEW_WORKER_AVAILABILITY_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_ALL_ASSIGNMENTS_M | PER | direct | hcm_ambiguous | PER_ALL_ASSIGNMENTS_M:hcm_ambiguous:ANC_REPORT_ABSENCE_RECORD_DATA, ANC_REPORT_AVAILABILITY_PATTERNS_DATA, ANC_REPORT_DONATIONS_DATA, CMP_REPORT_COMPENSATION_ALLOCATION_DATA, CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA, CMP_REPORT_SALARY_DATA, HRA_REPORT_CHECK_IN_DOCUMENT_DATA, HRA_REPORT_PERFORMANCE_DOCUMENT_DATA, HRG_REPORT_PERFORMANCE_GOAL_DATA, PAY_REPORT_PAYROLL_RELATIONSHIP_DATA, PER_REPORT_ASSIGNMENT_DATA, PER_REPORT_PERSON_ASSIGNMENT_DATA, PER_REPORT_PERSON_DATA, PER_REPORT_SENIORITY_DATE_DATA, PER_REPORT_VACANCY_DATA, PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA, PER_REVIEW_WORKER_AVAILABILITY_DATA, PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA |
| PER_ADDRESSES_F | PER | direct | hcm_ambiguous | PER_ADDRESSES_F:hcm_ambiguous:IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA, PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PAY_PAYROLL_ACTIONS | PAY | direct | hcm_none | PAY_PAYROLL_ACTIONS:hcm_none: |
| INV_ORG_PARAMETERS | INV | direct | ambiguous_prefix | INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| INV_ORGANIZATION_DEFINITIONS_V | INV | via_reference | multi_context | BUSINESS_UNIT_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| INV_ITEM_LOCATIONS | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| HZ_PARTY_SITES | HZ | direct | not_in_U | HZ_PARTY_SITES:not_in_U: |
| HZ_PARTIES | HZ | direct | ambiguous_prefix | HZ_PARTIES:ambiguous_prefix:HZ_VIEW_TRADING_COMMUNITY_CONTACT_DATA, HZ_VIEW_TRADING_COMMUNITY_PERSON_DATA |
| HZ_CUST_SITE_USES_ALL | HZ | direct | ok | HZ_CUST_SITE_USES_ALL:unique_prefix:HZ_VIEW_CUSTOMER_ACCOUNT_SITE_USE_DATA |
| HZ_CUST_ACCOUNTS | HZ | direct | ok | HZ_CUST_ACCOUNTS:unique_prefix:HZ_VIEW_CUSTOMER_ACCOUNT_DATA |
| HRT_PROFILE_ITEMS | HRT | direct | ok | HRT_PROFILE_ITEMS:hcm_unique:HRT_REPORT_TALENT_PROFILE_ITEM_DATA |
| HRT_PROFILES_B | HRT | direct | ok | HRT_PROFILES_B:hcm_unique:HRT_REPORT_TALENT_PROFILE_DATA |
| HRG_GOALS | HRG | direct | hcm_ambiguous | HRG_GOALS:hcm_ambiguous:HRG_REPORT_CAREER_DEVELOPMENT_DATA, HRG_REPORT_PERFORMANCE_GOAL_DATA |
| HRC_TXN_HEADER | HRC | direct | hcm_none | HRC_TXN_HEADER:hcm_none: |
| HRA_EVALUATIONS | HRA | direct | ok | HRA_EVALUATIONS:unique_prefix:HRA_REPORT_PERFORMANCE_DOCUMENT_DATA |
| GL_LEDGERS | GL | direct | ok | GL_LEDGERS:unique_prefix:GL_REPORT_GENERAL_LEDGER_DATA |
| FUN_ALL_BUSINESS_UNITS_V | FUN | direct | ambiguous_any | FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| FND_LOOKUP_VALUES_VL | FND | via_reference | ok | SET_ID->FND_SETID_SETS_VL:unique_single:CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA |
| FND_LOOKUP_VALUES_TL | FND | via_reference | ok | SET_ID->FND_SETID_SETS_VL:unique_single:CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA |
| FND_ATTACHED_DOCUMENTS | FND | registered_no_grant | registered_no_grant |  |
| EGP_SYSTEM_ITEMS_VL | EGP | via_reference | ambiguous_any | INVENTORY_ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA |
| AR_PAYMENT_SCHEDULES_ALL | AR | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA |
| AP_INVOICE_DISTRIBUTIONS_ALL | AP | via_reference | multi_context | EXPENDITURE_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA; PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| AP_INVOICES_ALL | AP | via_reference | multi_context | EXPENDITURE_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| AP_CHECKS_ALL | AP | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA |
| HR_DOCUMENTS_OF_RECORD | PER | direct | ok | HR_DOCUMENTS_OF_RECORD:hcm_unique:PER_REPORT_WORKER_DOCUMENTS_OF_RECORD_DATA |
| AP_INVOICE_PAYMENTS_ALL | AP | via_reference | multi_context | INV_ORG_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| POZ_SUPPLIER_SITES_V | POZ | via_reference | ambiguous_any | PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| IRC_CANDIDATES | IRC | direct | hcm_none | IRC_CANDIDATES:hcm_none: |
| HZ_CUST_ACCT_SITES_ALL | HZ | direct | ok | HZ_CUST_ACCT_SITES_ALL:unique_prefix:HZ_VIEW_CUSTOMER_ACCOUNT_SITE_DATA |
| CE_BANK_ACCT_USES_ALL | CE | via_reference | ambiguous_any | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| WIE_WO_OPERATIONS_B | WIE | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| PSC_LNP_PR | PSC_PER | direct | not_in_U | PSC_LNP_PR:not_in_U: |
| PER_PHONES | PER | direct | hcm_ambiguous | PER_PHONES:hcm_ambiguous:IRC_REPORT_PERSON_PHONE_FOR_RECRUITING_DATA, PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PO_LINES_ALL | PO | via_reference | ambiguous_any | PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; REQ_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; SOLDTO_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PJF_PROJ_ELEMENTS_VL | PJF | via_reference | hcm_ambiguous | CARRYING_OUT_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_PERIODS_OF_SERVICE | PER | direct | hcm_ambiguous | PER_PERIODS_OF_SERVICE:hcm_ambiguous:PER_REPORT_WORK_RELATIONSHIP_DATA, PER_REVIEW_WORKER_AVAILABILITY_DATA, PER_VIEW_MANAGER_TRANSACTION_DASHBOARD_DATA |
| WIE_WO_OPERATIONS_VL | WIE | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| PJB_BI_REPORT_DETAILS | PJB | via_reference | ambiguous_any | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PJC_ALLOC_RUNS_ALL | PJC | direct | not_in_U | PJC_ALLOC_RUNS_ALL:not_in_U: |
| XLA_AE_LINES | XLA | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| WSH_DELIVERY_DETAILS | WSH | via_reference | multi_context | ORGANIZATION_ID->INV_ORG_PARAMETERS:unique_prefix:WSH_MANAGE_DELIVERY_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| AP_INVOICE_LINES_ALL | AP | via_reference | multi_context | EXPENDITURE_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA; PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| XLA_AE_HEADERS | XLA | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PAY_PAY_RELATIONSHIPS_DN | PAY | direct | hcm_ambiguous | PAY_PAY_RELATIONSHIPS_DN:hcm_ambiguous:PAY_REPORT_PAYROLL_RELATIONSHIP_DATA, PAY_REPORT_PERSON_PROCESS_RESULTS_DATA |
| HR_ALL_ORGANIZATION_UNITS_F | PER | direct | hcm_ambiguous | HR_ALL_ORGANIZATION_UNITS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| HR_ORG_UNIT_CLASSIFICATIONS_F | PER | direct | hcm_ambiguous | HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| ZX_PARTY_TAX_PROFILE | ZX | direct | not_in_U | ZX_PARTY_TAX_PROFILE:not_in_U: |
| GL_PERIOD_STATUSES | GL | direct | not_in_U | GL_PERIOD_STATUSES:not_in_U: |
| RA_CUST_TRX_TYPES_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_ID->FND_SETID_SETS_VL:unique_single:CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA |
| PON_AUCTION_HEADERS_ALL | PON | direct | ok | PON_AUCTION_HEADERS_ALL:unique_prefix:PON_VIEW_SUPPLIER_NEGOTIATION_ANALYSIS_DATA |
| GL_SETS_OF_BOOKS | GL | via_reference | ok | SET_OF_BOOKS_ID->GL_LEDGERS:unique_prefix:GL_REPORT_GENERAL_LEDGER_DATA |
| CE_PAYMENT_INSTRUMENTS | CE | via_reference | ambiguous_any | UNMATCHED_LINE_SETTLEMNT_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| WIS_RESOURCES_VL | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| WIE_WORK_ORDERS_VL | WIE | via_reference | multi_context | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA; PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_PEOPLE_LEGISLATIVE_F | PER | direct | hcm_ambiguous | PER_PEOPLE_LEGISLATIVE_F:hcm_ambiguous:PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| FLA_LEASES_ALL | FUN | via_reference | ambiguous_any | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| WIS_WORK_CENTERS_VL | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| PJC_EXP_ITEMS_ALL | PJC | direct | ambiguous_prefix | PJC_EXP_ITEMS_ALL:ambiguous_prefix:PJC_EXTRACT_N_WAREHOUSE_PROJECT_EXPENDITURE_ITEM_DATA, PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA |
| FA_TRANSACTION_HEADERS | FA | via_reference | ok | BOOK_TYPE_CODE->FA_BOOK_CONTROLS:unique_prefix:FA_MANAGE_FIXED_ASSET_BOOK_DATA |
| PJF_PROJECTS_ALL_B | PJF | via_reference | multi_context | CARRYING_OUT_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PAY_ALL_PAYROLLS_F | PAY | direct | ok | PAY_ALL_PAYROLLS_F:hcm_unique:PAY_REPORT_PAYROLL_DEFINITION_DATA |
| FND_CURRENCIES_B | FND | direct | not_in_U | FND_CURRENCIES_B:not_in_U: |
| FLA_LEASE_DETAILS | FUN | via_reference | hcm_ambiguous | PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| AR_CASH_RECEIPTS_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| XCC_CONTROL_BUDGETS | XCC | direct | ok | XCC_CONTROL_BUDGETS:unique_prefix:XCC_REVIEW_BUDGETARY_CONTROL_BUDGET_DATA |
| INV_SECONDARY_INVENTORIES_VL | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| INV_LOT_NUMBERS | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| AP_1099_TAPE_DATA_ALL | AP | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA |
| EGP_SYSTEM_ITEMS_BV | EGP | via_reference | ambiguous_any | INVENTORY_ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA |
| PO_LINE_LOCATIONS_ALL | PO | via_reference | ambiguous_any | PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; REQ_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; SOLDTO_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| POZ_LOOKUP_CODES | POZ | direct | not_in_U | POZ_LOOKUP_CODES:not_in_U: |
| FND_LOOKUP_VALUES | FND | via_reference | ok | SET_ID->FND_SETID_SETS_VL:unique_single:CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA |
| FA_BOOK_CONTROLS | FA | direct | ok | FA_BOOK_CONTROLS:unique_prefix:FA_MANAGE_FIXED_ASSET_BOOK_DATA |
| PER_NATIONAL_IDENTIFIERS | PER | direct | hcm_ambiguous | PER_NATIONAL_IDENTIFIERS:hcm_ambiguous:PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_LOCATION_DETAILS_F | PER | direct | hcm_ambiguous | PER_LOCATION_DETAILS_F:hcm_ambiguous:PER_REPORT_LOCATION_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PER_JOBS_F | PER | direct | hcm_ambiguous | PER_JOBS_F:hcm_ambiguous:PER_REPORT_HR_JOB_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| FLA_LEASE_PAYMENT_HEADERS | FUN | via_reference | hcm_ambiguous | PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| OKC_K_HEADERS_VL | OKC | via_reference | multi_context | INV_ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| WIS_WD_OPERATION_REPORTS_V | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| FA_BOOKS | FA | via_reference | ok | BOOK_TYPE_CODE->FA_BOOK_CONTROLS:unique_prefix:FA_MANAGE_FIXED_ASSET_BOOK_DATA |
| WIS_WORK_DEFINITIONS_V | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| QA_IP_EVENTS | QA | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA |
| PO_DISTRIBUTIONS_ALL | PO | via_reference | multi_context | PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA; PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; REQ_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA; SOLDTO_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PAY_FLOW_INSTANCES | PAY | direct | ok | PAY_FLOW_INSTANCES:hcm_unique:PAY_REPORT_PAYROLL_FLOW_DATA |
| INV_MATERIAL_TXNS | INV | via_reference | multi_context | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA; PJC_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| EXM_EXPENSES | EXM | direct | ok | EXM_EXPENSES:unique_prefix:EXM_VIEW_EMPLOYEE_EXPENSE_DATA |
| WLF_LEARNING_ITEMS_F | WLF | direct | hcm_none | WLF_LEARNING_ITEMS_F:hcm_none: |
| HR_ORGANIZATION_INFORMATION_F | PER | direct | ok | HR_ORGANIZATION_INFORMATION_F:hcm_unique:PER_REPORT_LEGAL_EMPLOYER_DATA |
| ZX_LINES | ZX | direct | not_in_U | ZX_LINES:not_in_U: |
| WIE_OPERATION_TRANSACTIONS | WIE | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| PSC_LNP_FEE_RECORD | PSC_PER | direct | not_in_U | PSC_LNP_FEE_RECORD:not_in_U: |
| PO_SYSTEM_PARAMETERS_ALL | PO | via_reference | multi_context | INVENTORY_ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PJF_TASKS_V | PJF | via_reference | hcm_ambiguous | CARRYING_OUT_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| PSC_LNP_PARCEL_ADDRESS | PSC_PER | direct | not_in_U | PSC_LNP_PARCEL_ADDRESS:not_in_U: |
| IRC_SUBMISSIONS | IRC | direct | ok | IRC_SUBMISSIONS:hcm_unique:IRC_REPORT_CANDIDATE_JOB_APPLICATION_DATA |
| CMP_SALARY | CMP | direct | ok | CMP_SALARY:hcm_unique:CMP_REPORT_SALARY_DATA |
| CE_PMT_INSTR_BU_ASSIGNMENTS | CE | via_reference | ambiguous_any | BUSINESS_UNIT_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| AP_REPORTING_ENTITY_LINES_ALL | AP | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA |
| PAY_DIR_CARDS_F | PAY | direct | hcm_none | PAY_DIR_CARDS_F:hcm_none: |
| FND_SETID_SETS_VL | FND | direct | ok | FND_SETID_SETS_VL:unique_single:CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA |
| AR_CASH_RECEIPT_HISTORY_ALL | AR | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA |
| WIS_WORK_DEFINITIONS | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| JG_REPORTING_TRANSACTION_T | JG | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| GL_JE_LINES | GL | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_prefix:GL_REPORT_GENERAL_LEDGER_DATA |
| AR_RECEIVABLE_APPLICATIONS_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| AP_REPORTING_ENTITIES_ALL | AP | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA |
| HZ_RELATIONSHIPS | HZ | direct | ok | HZ_RELATIONSHIPS:unique_prefix:HZ_VIEW_TRADING_COMMUNITY_RELATIONSHIP_DATA |
| HRT_CONTENT_TYPES_B | HRT | direct | hcm_none | HRT_CONTENT_TYPES_B:hcm_none: |
| FND_LOOKUP_TYPES | FND | direct | not_in_U | FND_LOOKUP_TYPES:not_in_U: |
| RCV_SHIPMENT_HEADERS | RCV | via_reference | multi_context | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA; RMA_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| RCS_ORG_DEFINITIONS_LW_V | RCS | via_reference | multi_context | BUSINESS_UNIT_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA |
| PSC_LNP_REC_PARCEL | PSC_PER | direct | not_in_U | PSC_LNP_REC_PARCEL:not_in_U: |
| PJF_PROJ_ELEMENTS_B | PJF | via_reference | hcm_ambiguous | CARRYING_OUT_ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| AP_INV_SELECTION_CRITERIA_ALL | AP | via_reference | ok | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AP_REPORT_PAYABLES_DATA |
| XLA_TRANSACTION_ENTITIES | XLA | direct | ok | XLA_TRANSACTION_ENTITIES:unique_prefix:XLA_MANAGE_SUBLEDGER_SOURCE_TRANSACTION_DATA |
| PSC_BNP_PAYMENT_HIST_HDR | PSC_CC | direct | not_in_U | PSC_BNP_PAYMENT_HIST_HDR:not_in_U: |
| POZ_SUPPLIERS_PII | POZ | direct | not_in_U | POZ_SUPPLIERS_PII:not_in_U: |
| PJO_PLAN_VERSIONS_XFACE | PJO | via_reference | hcm_ambiguous | ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| OKC_K_HEADERS_ALL_B | OKC | direct | ok | OKC_K_HEADERS_ALL_B:unique_prefix:OKC_VIEW_CONTRACT_DATA |
| HZ_CONTACT_POINTS | HZ | direct | not_in_U | HZ_CONTACT_POINTS:not_in_U: |
| GL_JE_HEADERS | GL | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_prefix:GL_REPORT_GENERAL_LEDGER_DATA |
| WIE_WO_OPERATION_OUTPUTS | WIE | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| POQ_QUESTNAIRE_RESP_HEADERS | POQ | via_reference | ambiguous_any | PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PJC_PRJ_ASSETS_ALL | PJC | via_reference | ambiguous_any | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PJC_ALLOC_TXN_DETAILS | PJC | via_reference | hcm_ambiguous | ORGANIZATION_ID->HR_ORG_UNIT_CLASSIFICATIONS_F:hcm_ambiguous:PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| INV_TRANSACTION_LOT_NUMBERS | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| WLF_ASSIGNMENT_RECORDS_F | WLF | direct | hcm_none | WLF_ASSIGNMENT_RECORDS_F:hcm_none: |
| WIE_WO_OPERATION_MATERIALS | WIE | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| PAY_REPORT_CATEGORIES | PAY | direct | hcm_none | PAY_REPORT_CATEGORIES:hcm_none: |
| INV_UNIT_TRANSACTIONS | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| EGP_ITEM_CATEGORIES | EGP | via_reference | ambiguous_any | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA |
| AR_SYSTEM_PARAMETERS_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PSC_INS_INSPECTION | PSC_PER | direct | not_in_U | PSC_INS_INSPECTION:not_in_U: |
| PER_PERSON_ADDR_USAGES_F | PER | direct | hcm_ambiguous | PER_PERSON_ADDR_USAGES_F:hcm_ambiguous:IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA, PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |
| IRC_OFFERS | IRC | direct | hcm_ambiguous | IRC_OFFERS:hcm_ambiguous:IRC_REPORT_JOB_OFFER_DATA, IRC_REPORT_JOB_OFFER_OTHER_COMPENSATION_DATA, IRC_REPORT_JOB_OFFER_SALARY_DATA |
| INV_LICENSE_PLATE_NUMBERS | INV | via_reference | ambiguous_prefix | ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_prefix:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA |
| FLA_SYSTEM_OPTIONS_ALL | FUN | via_reference | multi_context | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA; ORG_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| EGP_SYSTEM_ITEMS_V | EGP | via_reference | ambiguous_any | INVENTORY_ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA; ORGANIZATION_ID->INV_ORG_PARAMETERS:ambiguous_any:INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_CYCLE_COUNT_DATA, INV_MANAGE_EXPECTED_SUPPLY_DATA, INV_MANAGE_INVENTORY_ORGANIZATION_PARAMETER_DATA, INV_MANAGE_INVENTORY_RESERVATION_DATA, INV_MANAGE_INVENTORY_TRANSACTION_DATA, INV_MANAGE_INVENTORY_TRANSFER_ORDER_DATA, INV_MANAGE_ITEM_LOCATOR_DATA, INV_MANAGE_ITEM_LOT_AND_ITEM_SERIAL_DATA, INV_MANAGE_ITEM_SUBINVENTORY_DATA, INV_MANAGE_ONHAND_QUANTITY_DATA, RCS_MAINTENANCE_ORG_DATA, RCS_QUALITY_ORG_DATA, RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA, RCV_MANAGE_RECEIVING_TRANSACTION_DATA, WSH_MANAGE_DELIVERY_DATA |
| WIS_WD_VERSION_REPORTS_V | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| WIS_WD_VERSIONS | WIS | via_reference | ok | ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| RCS_MFG_PARAMETERS_V | RCS | via_reference | multi_context | BUSINESS_UNIT_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; ORGANIZATION_ID->RCS_MFG_PARAMETERS:unique_prefix:RCS_PLANT_PARAMETERS_DATA |
| RA_CUST_TRX_LINE_GL_DIST_ALL | AR | via_reference | multi_context | ORG_ID->FUN_ALL_BUSINESS_UNITS_V:unique_prefix:AR_VIEW_RECEIVABLES_ACTIVITIES_DATA; SET_OF_BOOKS_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PSC_LNP_PARCEL_OWNER | PSC_PER | direct | not_in_U | PSC_LNP_PARCEL_OWNER:not_in_U: |
| PSC_COM_AGENCY_B | PSC_CC | via_reference | ok | LEDGER_ID->GL_LEDGERS:unique_single:GL_REPORT_GENERAL_LEDGER_DATA |
| PO_HEADERS_DRAFT_ALL | PO | via_reference | ambiguous_any | BILLTO_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; PRC_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; REQ_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA; SOLDTO_BU_ID->FUN_ALL_BUSINESS_UNITS_V:ambiguous_any:AP_REPORT_PAYABLES_DATA, AR_VIEW_RECEIVABLES_ACTIVITIES_DATA, DOO_MANAGE_ORCHESTRATION_ORDER_DATA |
| PER_ETHNICITIES | PER | direct | hcm_ambiguous | PER_ETHNICITIES:hcm_ambiguous:PER_REPORT_PERSON_DATA, PER_VIEW_HUMAN_RESOURCE_SPECIALIST_TRANSACTION_DASHBOARD_DATA |

`none` (135): ZX_REP_TRX_JX_EXT_T, ZX_REP_CONTEXT_T, POZ_SUPPLIERS, PJT_PRJ_ENTERPRISE_RESOURCE_VL, PJF_OPEN_XFACE_REPORT, PER_PERSON_NAMES_F_V, PER_MANAGER_HRCHY_DN, PER_JOBS_F_VL, PER_JOBS_F_TL, PER_GRADES_F_TL, PER_DEPARTMENTS, JG_ZZ_VAT_TRX_GT, INV_UNITS_OF_MEASURE_VL, HZ_LOCATIONS, HZ_GEOGRAPHIES, HR_ORGANIZATION_UNITS_F_TL, HR_LOOKUPS, HR_LOCATIONS_ALL_F_VL, HR_ALL_POSITIONS_F_TL, HR_ALL_ORGANIZATION_UNITS_TL, HR_ALL_ORGANIZATION_UNITS_F_VL, HRT_RATING_LEVELS_VL, HRT_PROFILE_TYP_SECTIONS_VL, HRT_PROFILES_VL, HRT_CONTENT_TYPES_VL, HRT_CONTENT_ITEMS_VL, HRT_CONTENT_ITEMS_TL, HRC_TXN_DATA, HRA_EVAL_SECTIONS, HRA_EVAL_ROLE_ACTIONS, HRA_EVAL_ROLES, HRA_EVAL_RATINGS, HRA_EVAL_PARTICIPANTS, HCM_LOOKUPS, GL_CODE_COMBINATIONS, FND_TERRITORIES_VL, FND_MESSAGES_VL, FND_LOOKUPS, FND_DOCUMENT_CATEGORIES_VL, FND_DOCUMENTS_VL, FND_DF_SEGMENTS_VL, FND_CURRENCIES_VL, CE_BANK_ACCOUNTS, HRT_CONTENT_ITEMS_B, AR_LOOKUPS, JE_ZZ_VAT_REP_TRX_T, HR_ALL_POSITIONS_F_VL, PER_GRADES_F_VL, GL_PERIODS, FND_DF_CONTEXTS_B, PER_LOCATION_DETAILS_F_VL, AP_LOOKUP_CODES, XLA_EVENTS, PJR_RESOURCE_REQUESTS, HRT_PROFILE_RELATIONS, HRA_EVAL_ITEMS, PJR_LOOKUPS, PER_DISPLAY_PHONES_V, PER_ACTION_REASONS_VL, HRG_GOAL_PLAN_GOALS, EGP_CATEGORIES_VL, PJR_ASSIGNMENT, HR_ORGANIZATION_V, XLE_REGISTRATIONS, PJC_TXN_ERRORS, PER_LEGISLATIVE_DATA_GROUPS_VL, FA_SYSTEM_CONTROLS, XLE_ETB_PROFILES, HZ_IMP_ERRORS, FND_VS_VALUES_B, PAY_REQUESTS, HRT_PROFILES_TL, PJS_LOOKUPS, PJC_LOOKUPS, PER_LOCATION_DETAILS_F_TL, PAY_DIR_CARD_COMPONENTS_F, PAY_FILE_DETAILS, FND_DF_CONTEXTS_VL, ZX_REPORT_CODES_ASSOC, WIS_WORK_METHODS_VL, WIE_WO_STATUSES_VL, PJC_ALLOC_EXCEPTIONS, HRQ_QSTNR_RESPONSES, HRQ_QSTNR_PARTICIPANTS, FND_DOCUMENT_ENTITIES_VL, PAY_PAYROLL_REL_ACTIONS, XLA_LOOKUPS, PSC_LNP_RECORD_TYPE_TL, PJT_PROJECT_ROLES_VL, PJR_RESOURCE_REQUEST_LINES, PJO_PROCESS_REPORT, PER_EXT_DELIVERY_OPTIONS_B, IRC_REQUISITIONS_VL, FA_ADDITIONS_B, CMP_SALARY_BASES_VL, PO_VERSIONS, PER_ACTION_OCCURRENCES, HRG_GOAL_MEASUREMENTS, AP_INCOME_TAX_REGIONS, ZX_REPORTING_TYPES_B, PJF_EXP_TYPES_VL, IRC_TEAM_MEMBERS, HR_DOCUMENT_TYPES_TL, HR_ALL_ORGANIZATION_UNITS_VL, HRT_PROFILE_TYP_SECTIONS, QA_SAMPLES, PSC_LNP_RECORD_TYPE_VL, PAY_ELEMENT_TYPES_VL, HTS_SCHEDULE_SHIFTS, HR_LOCATIONS_ALL_X, QA_SAMPLE_RESULTS, PER_ALL_ASSIGNMENTS_F, OSS_PRODUCTS, JG_ZZ_VAT_REP_STATUS, HR_ORGANIZATION_UNITS, PJT_ERROR_MESSAGES, PJF_PROJ_ROLE_TYPES_VL, PJF_LOOKUPS, PER_PERIODS_OF_SERVICE_V, IRC_MESSAGE_TRACKING, HR_DOCUMENT_TYPES_VL, PAY_OBJECT_ACTIONS, OSS_BALANCE_CODES, HRT_PROFILE_TP_SC_PRP_B, HRA_TMPL_ROLES, CE_BANK_BRANCHES_V, WLF_LEARNING_ITEMS_F_TL, PO_DOC_STYLE_LINES_VL, PER_GRADE_STEPS_F_VL, IRC_CAND_PROFILE_USAGES_M, HCM_EXTENDED_LOOKUP_CODES_VL, FND_KF_STR_INSTANCES_VL, XLA_SEG_RULE_DETAILS, PER_PERSON_SECURED_LIST_V, PER_NAME_STYLES_B

## Appendix E. Demo-log blocks per area (object_id / function_id are the demo pod's; names by predicate-text match)

| area | logs | demo object_id:function_id | matched object(s) | matched instance set(s) |
|---|---|---|---|---|
| Compensation - Workforce Compensation Real Time | 2 | 300000000008402:300000000011814 | ZMM_NOTES | ZMM_NOTES/ZMMNOTESZMM1513, ZMM_NOTES/ZMM_NOTES_ALL, ZMM_NOTES/ZMM_NOTES_AUTHOR, ZMM_NOTES/ZMM_NOTES_AUTHOR_AND_PUBLIC, ZMM_NOTES/ZMM_NOTES_AUTHOR_PRIVATE, ZMM_N |
| Distributed Order Orchestration - Fulfillment Lines Real Time | 26 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Distributed Order Orchestration - Order Headers Real Time | 4 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Distributed Order Orchestration - Order Holds Real Time | 3 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Distributed Order Orchestration - Order Lines Real Time | 2 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Distributed Order Orchestration - Price Adjustments Real Time | 2 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Distributed Order Orchestration - Process Instances Real Time | 6 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| General Ledger - Average Daily Balances Real Time | 1 | 300000000008587:300000000012225 | GL_LEDGERS | GL_LEDGERS/GLLEDGERSSTD |
| General Ledger - Journals Real Time | 7 | 300000000008587:300000000012225 | GL_LEDGERS | GL_LEDGERS/GLLEDGERSSTD |
| General Ledger - Transactional Average Daily Balances Real Time | 2 | 300000000008587:300000000012225 | GL_LEDGERS | GL_LEDGERS/GLLEDGERSSTD |
| Inventory - Inventory Transfer Order Real Time | 2 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Inventory - Kanban Activity Real Time | 1 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Manufacturing - Work Definitions Real Time | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Manufacturing - Work Order Performance Real Time | 1 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Manufacturing - Workstation Supervision Real Time | 1 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Payroll - Payroll Flows Real Time | 2 | 300000000000992:300000000002195 | ESS_REQUEST_HISTORY | ESS_REQUEST_HISTORY/REQS_ALL_OF_ONE_APP |
| Product Management - Change Order Approvals Real Time | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Change Order Real Time | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Item Catalog Category Hierarchy Real Time | 31 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Item Revisions Real Time | 2 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Item Supplier Associations Real Time | 31 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Structures Real Time | 9 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Structures and Components Real Time | 37 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Product Management - Where Used Real Time | 37 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Receivables - Customer Account Site Tax Profile Real Time | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Receivables - Customer Tax Profile Real Time | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| Sales - CRM Contact Note | 3 | 300000000008402:300000000011814 | ZMM_NOTES | ZMM_NOTES/ZMMNOTESZMM1513, ZMM_NOTES/ZMM_NOTES_ALL, ZMM_NOTES/ZMM_NOTES_AUTHOR, ZMM_NOTES/ZMM_NOTES_AUTHOR_AND_PUBLIC, ZMM_NOTES/ZMM_NOTES_AUTHOR_PRIVATE, ZMM_N |
| Sales - CRM Customer Note | 3 | 300000000008402:300000000011814 | ZMM_NOTES | ZMM_NOTES/ZMMNOTESZMM1513, ZMM_NOTES/ZMM_NOTES_ALL, ZMM_NOTES/ZMM_NOTES_AUTHOR, ZMM_NOTES/ZMM_NOTES_AUTHOR_AND_PUBLIC, ZMM_NOTES/ZMM_NOTES_AUTHOR_PRIVATE, ZMM_N |
| Sales - CRM Opportunity Note | 3 | 300000000008402:300000000011814 | ZMM_NOTES | ZMM_NOTES/ZMMNOTESZMM1513, ZMM_NOTES/ZMM_NOTES_ALL, ZMM_NOTES/ZMM_NOTES_AUTHOR, ZMM_NOTES/ZMM_NOTES_AUTHOR_AND_PUBLIC, ZMM_NOTES/ZMM_NOTES_AUTHOR_PRIVATE, ZMM_N |
| Shipping Real Time | 1 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| Subledger Accounting - Payables Summary Reconciliation Real Time | 2 | 300000000008587:300000000012225 | GL_LEDGERS | GL_LEDGERS/GLLEDGERSSTD |
| Subledger Accounting - Receivables Summary Reconciliation Real Time | 2 | 300000000008587:300000000012225 | GL_LEDGERS | GL_LEDGERS/GLLEDGERSSTD |
| Supply Chain Financial Orchestration Real Time | 4 | 300000000008651:300000000012367 | FUN_ALL_BUSINESS_UNITS_V, PJC_COMMITMENT_TXNS | FUN_ALL_BUSINESS_UNITS_V/FUNALLBUSINESSUNITSVSTD, PJC_COMMITMENT_TXNS/PJC_OTBI_CMT_TXN_BU_IS |
| custExt33f1cb05_ed40_4771_88b6_0aa4b769a070 | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
| custExt3ba2e2a8_70ef_4325_87bd_9e22d61f8abf | 1 | 300000000009596:300000000012207 | EGP_SYSTEM_ITEMS_B | EGP_SYSTEM_ITEMS_B/EGPSYSTEMITEMSBEGO1 |
