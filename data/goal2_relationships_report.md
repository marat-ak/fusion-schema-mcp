# Goal 2 — Mined Table Relationships Report

Generated: 2026-07-04T18:01:55.512Z
Catalog SQL input: `C:\Marat\OSaaS\ClaudeShared\Bip\all_sql_queries.json`

## Summary

- Declared FK rows (META_FKEYS.csv): **18565**
- Unique declared FK table.col<->table.col pairs: **9359**
- Tables/views scanned for VIEW_TEXT: **6077** (processed 6077, skipped 0)
- Catalog SQL queries scanned: **17876** (physical/joinable: 1772, skipped as logical-BI-SQL or no-join: 7490)
- **JOIN-mined candidates (VIEW_TEXT + catalog SQL, pre-merge): 1894**
- **Tight PK-name-match candidates (pre-merge, after blacklist/specificity/cap filters): 3000**
- **Shared *_ID column-group summary entries (aggregated, not pairwise): 10561**
- Final deduplicated new relationships before total-cap: **4892**
- **Total NEW mined relationships emitted (after 20,000 cap): 4892**

### By evidence type (a relationship may have more than one)

- `pk_name`: 3000
- `shared_id`: 2041
- `join`: 1894

### By final confidence

- HIGH: 3765
- MEDIUM: 1127
- LOW: 0

### Coverage

- Distinct tables that gained at least one new edge: **2936**

### Shared *_ID column groups (top 20 by table fan-out)

These are informational groupings only (NOT emitted as pairwise relationships).

| Column | # Tables | Is PK somewhere | Sample tables |
|---|---|---|---|
| PROMOTION_ID | 30 | Y | ATC_PROMOTIONS, ATC_PROM_PATTERNS, CMP_CWB_POST_PERSON, CMP_CWB_POST_PERSON_SEL_V, CMP_CWB_PROMOTIONS, DOO_ORDER_CHARGE_COMPONENTS, ... |
| RESOURCE_SOURCE_ID | 30 | n | PJF_LATESTPROJECTMANAGER_V, PJF_PROJECT_PARTIES, PJF_PROJECT_PARTIES_H, PJF_PROJECT_PARTIES_INT, PJF_PROJ_ALL_MEMBERS_V, PJF_PROJ_TEAM_MEMBERS_V, ... |
| CAT_ID | 30 | Y | CMP_TCS_ALL_OBJECTS_IN_CAT, CMP_TCS_CAT, CMP_TCS_CAT_ITEM_HRCHY, CMP_TCS_CAT_TL, CMP_TCS_CAT_VL, CMP_TCS_COL_IN_CAT, ... |
| TCL_ID | 30 | n | OKC_STI_ASSET_LINES_GT, OKC_STI_ASSET_LINES_H_INT, OKC_STI_ASSET_LINES_INT, OKC_STI_ASSET_LINES_R_INT, OKC_STI_DEFAULTS_GT, OKC_STI_DEFAULTS_H_INT, ... |
| LL_RULE_ID | 30 | n | CN_RULE_RESULTS_L1_GT, CN_RULE_RESULTS_L2_GT, CN_RULE_RESULTS_L3_GT, CN_RULE_RESULTS_L4_GT, CN_RULE_RESULTS_L5_GT, CN_RULE_RESULTS_WT_GT, ... |
| WIN_RULE_ID | 30 | n | CN_RULE_RESULTS_L1_GT, CN_RULE_RESULTS_L2_GT, CN_RULE_RESULTS_L3_GT, CN_RULE_RESULTS_L4_GT, CN_RULE_RESULTS_L5_GT, CN_RULE_RESULTS_WT_GT, ... |
| UL_RULE_ID | 30 | n | CN_RULE_RESULTS_L1_GT, CN_RULE_RESULTS_L2_GT, CN_RULE_RESULTS_L3_GT, CN_RULE_RESULTS_L4_GT, CN_RULE_RESULTS_L5_GT, CN_RULE_RESULTS_WT_GT, ... |
| PL_TYP_ID | 30 | Y | BEN_ACTY_BASE_RT_F, BEN_BENEFIT_ACTIONS, BEN_BILL_CHARGE_DETAILS, BEN_BILL_CHARGE_DETAILS_, BEN_BILL_ENRT_RSLT, BEN_BILL_ENRT_RSLT_, ... |
| CASE_ID | 30 | Y | ANC_PER_ABS_CERTS, ANC_PER_ABS_PLAN_ENTRIES, ANC_PER_ABS_PLAN_ENTRIES_, ANC_PER_ABS_PLN_SUMM_ENT, ANC_PER_ABS_PLN_SUMM_ENT_, ANC_PER_ABS_QUAL_ENTL, ... |
| ASSIGNMENT_STATUS_TYPE_ID | 30 | Y | ANC_ABSENCE_TYPES_F, ANC_ABSENCE_TYPES_VL, BEN_ELIG_EE_STAT_PRTE, CMP_CWB_PERSON_INFO, CMP_CWB_PERSON_INFO_V, CMP_CWB_POST_PERSON, ... |
| CURRENT_PHASE_ID | 30 | n | EGP_EXPLOSIONS_V, EGP_ITEM_REVISIONS_AUDIT_V, EGP_ITEM_REVISIONS_B, EGP_ITEM_REVISIONS_B_, EGP_ITEM_REVISIONS_B_V, EGP_ITEM_REVISIONS_INTERFACE, ... |
| VALUE_DEFN_ID | 30 | Y | PAY_ALLOW_OVERRIDES_F, PAY_ALLOW_OVERRIDES_VL, PAY_CALCULATION_UNITS_F, PAY_CIR_COMP_DETAILS_VL, PAY_OLD_RANGE_ITEMS_F, PAY_OLD_RANGE_ITEMS_F_, ... |
| STD_COST_ID | 30 | Y | CST_ALL_EXPENSE_POOL_TXNS_V, CST_B_STD_COSTS_V, CST_COST_ESTIMATE_ASSIGNS, CST_ESTIMATE_REQUEST_DETAILS, CST_LAYER_COSTS, CST_LAYER_COSTS_I_GT, ... |
| CONVERSATION_ID | 30 | Y | EXM_VENDOR_EXPENSES, FAI_EXT_CHAT_CORRELATION, FAI_USER_CONVERSATIONS, HRC_MESSAGE_USAGE_IDN, HWR_CNST_B, HWR_CNST_CNST_PAR_XREF, ... |
| RESOURCE_ORG_ID | 30 | n | HZ_PARTIES_CONTACT_SECURITY, HZ_PARTIES_CONTACT_SECURITY_, MKL_LEAD_RS_ACC_LEVELS, MKT_BDT_BUDGETS_B, MKT_BDT_BUDGETS_B_, MKT_BDT_BUDGETS_VL, ... |
| TRANSFER_COST_ORG_ID | 30 | n | CST_ACCT_INTRANSIT_DAILY, CST_ACCT_TRANSFER_DTLS_V, CST_ALL_COST_TRANSACTIONS_11_V, CST_ALL_COST_TRANSACTIONS_V, CST_COSTED_INTRANSIT_DAILY, CST_DEL_INV_QTY_LAST_RECORD_GT, ... |
| TAX_LINE_ID | 30 | Y | AP_INVOICE_EXTRACT_DETAILS_V, AR_CRH_APP_GT, AR_MFAR_CM_PRO_GT, AR_XLA_LINES_EXTRACT, JG_ES_MODELO_DECL_LINES, JG_FSCL_TAX_LINES_ALL, ... |
| TAX_JURISDICTION_ID | 30 | Y | CMR_RETRO_PRICE_TAX_EVENTS_GT, CMR_TRADE_TAXES_GT, CMR_TRANSACTION_TAXES, CMR_XLA_TAXES_V, CMR_XLA_TRADE_TAXES_V, CST_TRADE_EVENT_TAXES, ... |
| TAX_REGIME_ID | 30 | Y | CMR_TRADE_TAXES_GT, CST_TRADE_EVENT_TAXES, JG_FSCL_TAX_LINES_ALL, ZX_DETAIL_TAX_LINES_GT, ZX_DETAIL_TAX_LINES_GT_V, ZX_DETAIL_TAX_LINES_QUOTE_V, ... |
| STAKEHOLDER_ID | 30 | Y | GTG_RC_STAKEHOLDER_ATTR, HNS_STAKEHOLDERS, HNS_STAKEHOLDERS_, JV_ACCOUNTING_HEADERS, JV_ASSIGNMENT_RULES_B, JV_ASSIGNMENT_RULES_B_, ... |

## Top ~50 highest-confidence new relationships

| # | From Table | From Col | To Table | To Col | Evidence | Occ. | Confidence | From Idx | To Idx |
|---|---|---|---|---|---|---|---|---|---|
| 1 | HRG_GOAL_TARGET_OUTCOMES | BUSINESS_GROUP_ID | HRT_RATING_LEVELS_VL | BUSINESS_GROUP_ID | join | 130 | HIGH | n | n |
| 2 | PAY_PAY_RELATIONSHIPS_DN | PERSON_ID | PER_ALL_ASSIGNMENTS_M | PERSON_ID | join | 102 | HIGH | Y | Y |
| 3 | HRT_PROFILES_VL | PROFILE_ID | HRT_PROFILE_ITEMS | PROFILE_ID | join | 80 | HIGH | n | Y |
| 4 | PSC_LNP_PR | LNP_RECORD_KEY | PSC_LNP_RECORD | LNP_RECORD_KEY | join | 67 | HIGH | Y | Y |
| 5 | FND_ATTACHED_DOCUMENTS | DOCUMENT_ID | FND_DOCUMENTS_VL | DOCUMENT_ID | join | 66 | HIGH | Y | n |
| 6 | PSC_LNP_PR | PLAN_REVIEW_KEY | PSC_LNP_PR_USER | PLAN_REVIEW_KEY | join | 63 | HIGH | Y | Y |
| 7 | GMS_AWARD_MASS_IMPORT_JOBS | LOAD_REQUEST_ID | GMS_AWD_PRJ_TSK_BRD_INT | LOAD_REQUEST_ID | join | 60 | HIGH | Y | n |
| 8 | HRA_EVALUATIONS | EVALUATION_ID | HRA_EVAL_SECTIONS | EVALUATION_ID | join | 54 | HIGH | Y | Y |
| 9 | HRA_EVALUATIONS | BUSINESS_GROUP_ID | HRA_EVAL_SECTIONS | BUSINESS_GROUP_ID | join | 54 | HIGH | n | n |
| 10 | HRA_TMPL_DEFNS_B | TEMPLATE_DEFN_ID | HRA_TMPL_SECTIONS | TEMPLATE_DEFN_ID | join,shared_id | 54 | HIGH | Y | Y |
| 11 | HRA_TMPL_DEFNS_B | BUSINESS_GROUP_ID | HRA_TMPL_SECTIONS | BUSINESS_GROUP_ID | join | 54 | HIGH | Y | Y |
| 12 | HRA_EVALUATIONS | EVALUATION_ID | HRA_EVAL_RATINGS | EVALUATION_ID | join | 50 | HIGH | Y | Y |
| 13 | PSC_INS_INSPECTION | INSPECTION_TYPE | PSC_INS_INSPECTION_TYPE_B | INSPECTION_TYPE | join | 36 | HIGH | n | Y |
| 14 | MSC_EXCEPTION_NOTIFY_DETAILS | EXCEPTION_ID | MSC_PLAN_MEASURE_EXP_DTLS | EXCEPTION_ID | join | 36 | HIGH | Y | Y |
| 15 | HRT_PROFILES_VL | PERSON_ID | PER_PERSON_NAMES_F_V | PERSON_ID | join | 34 | HIGH | n | n |
| 16 | FND_LOOKUP_VALUES_TL | LOOKUP_TYPE | HR_STANDARD_LOOKUPS | LOOKUP_TYPE | join | 34 | HIGH | Y | n |
| 17 | FND_LOOKUP_VALUES_TL | LOOKUP_CODE | HR_STANDARD_LOOKUPS | LOOKUP_CODE | join | 34 | HIGH | Y | n |
| 18 | WLF_EVENTS | EVENT_ID | WLF_EVENT_ATTEMPTS | EVENT_ID | join | 33 | HIGH | Y | Y |
| 19 | HRG_GOALS | GOAL_ID | HRG_GOAL_PLAN_GOALS | GOAL_ID | join | 32 | HIGH | Y | Y |
| 20 | HRT_CONTENT_TYPES_VL | CONTENT_TYPE_ID | HRT_PROFILE_ITEMS | CONTENT_TYPE_ID | join | 32 | HIGH | n | Y |
| 21 | PER_PERSON_NAMES_F_V | PERSON_ID | PER_USERS | PERSON_ID | join | 30 | HIGH | n | Y |
| 22 | HRT_PROFILES_B | PERSON_ID | PER_ALL_PEOPLE_F | PERSON_ID | join | 30 | HIGH | Y | Y |
| 23 | HRT_PROFILES_B | PROFILE_ID | HRT_PROFILE_ITEMS | PROFILE_ID | join | 30 | HIGH | Y | Y |
| 24 | HRT_PROFILES_VL | PROFILE_ID | HRT_PROFILE_KEYWORDS | PROFILE_ID | join | 25 | HIGH | n | Y |
| 25 | HRT_PROFILES_VL | BUSINESS_GROUP_ID | HRT_PROFILE_KEYWORDS | BUSINESS_GROUP_ID | join | 25 | HIGH | n | n |
| 26 | ZX_REPORTING_CODES_VL | REPORTING_CODE_ID | ZX_REPORT_CODES_ASSOC | REPORTING_CODE_ID | join,shared_id | 24 | HIGH | n | n |
| 27 | PER_EXT_DELIVERY_OPTIONS_B | EXT_DELIVERY_OPTION_ID | PER_EXT_DELIVERY_OPTION_DTLS | EXT_DELIVERY_OPTION_ID | join,shared_id | 24 | HIGH | Y | n |
| 28 | FND_ATTACHED_DOCUMENTS | LAST_UPDATED_BY | PER_USERS | USERNAME | join | 24 | HIGH | n | Y |
| 29 | PAY_PAYROLL_ACTIONS | PAYROLL_ACTION_ID | PAY_PAYROLL_REL_ACTIONS | PAYROLL_ACTION_ID | join | 23 | HIGH | Y | Y |
| 30 | WLF_ASSIGNMENT_RECORDS_F | ASSIGNMENT_RECORD_ID | WLF_ASSIGNMENT_TASKS_F | ASSIGNMENT_RECORD_ID | join,shared_id | 23 | HIGH | Y | Y |
| 31 | PER_PERSON_NAMES_F | PERSON_ID | PSC_LNP_PR_USER | REVIEWER_ID | join | 22 | HIGH | Y | n |
| 32 | PER_IMAGES | PERSON_ID | PER_PERSON_NAMES_F_V | PERSON_ID | join | 20 | HIGH | Y | n |
| 33 | HR_ORGANIZATION_UNITS | ORGANIZATION_ID | HR_ORG_UNIT_CLASSIFICATIONS_F | ORGANIZATION_ID | join | 20 | HIGH | n | Y |
| 34 | HRG_GOAL_TARGET_OUTCOMES | TARGET_RATING_LEVEL_ID | HRT_RATING_LEVELS_VL | RATING_LEVEL_ID | join | 20 | HIGH | Y | n |
| 35 | HRG_GOAL_TARGET_OUTCOMES | TARGET_RATING_LEVEL_ID2 | HRT_RATING_LEVELS_VL | RATING_LEVEL_ID | join | 20 | HIGH | n | n |
| 36 | HRG_GOAL_TARGET_OUTCOMES | TARGET_RATING_LEVEL_ID3 | HRT_RATING_LEVELS_VL | RATING_LEVEL_ID | join | 20 | HIGH | n | n |
| 37 | HRT_CONTENT_ITEMS_VL | BUSINESS_GROUP_ID | HRT_EDUCATION_ITEMS_V | BUSINESS_GROUP_ID | join | 20 | HIGH | n | n |
| 38 | HR_DOR_SECURED_LIST_V | PERSON_ID | PER_ASSIGNMENT_SUPERVISORS_F_V | PERSON_ID | join | 20 | HIGH | n | n |
| 39 | HRA_EVALUATIONS | EVALUATION_ID | HRA_EVAL_STEPS | EVALUATION_ID | join | 19 | HIGH | Y | Y |
| 40 | HRQ_QSTNR_PARTICIPANTS | QSTNR_PARTICIPANT_ID | HRQ_QSTNR_RESPONSES | QSTNR_PARTICIPANT_ID | join,shared_id | 19 | HIGH | Y | Y |
| 41 | WLF_ASSIGNMENT_TASKS_F | LEARNING_ITEM_ID | WLF_LI_ACTIVITIES_F | LEARNING_ITEM_ID | join | 19 | HIGH | Y | Y |
| 42 | WLF_EVENTS | LEARNING_ITEM_ID | WLF_LEARNING_ITEMS_F_VL | LEARNING_ITEM_ID | join | 19 | HIGH | Y | n |
| 43 | HRA_EVAL_SECTIONS | BUSINESS_GROUP_ID | HRT_CONTENT_ITEM_RD_VL | BUSINESS_GROUP_ID | join | 18 | HIGH | n | n |
| 44 | HRQ_QSTNR_PARTICIPANTS | BUSINESS_GROUP_ID | HRQ_QSTNR_RESPONSES | BUSINESS_GROUP_ID | join | 18 | HIGH | Y | n |
| 45 | EGP_SYSTEM_ITEMS_BV | INVENTORY_ITEM_ID | QA_IP_EVENTS | INVENTORY_ITEM_ID | join | 18 | HIGH | n | Y |
| 46 | EGP_SYSTEM_ITEMS_BV | ORGANIZATION_ID | QA_IP_EVENTS | ORGANIZATION_ID | join | 18 | HIGH | n | n |
| 47 | PJF_PROJ_ROLE_TYPES_VL | PROJECT_ROLE_ID | PJF_RATE_SCHEDULE_LINES | PROJECT_ROLE_ID | join | 17 | HIGH | n | Y |
| 48 | INV_RESERVATIONS | DEMAND_SOURCE_HEADER_ID | WSH_DELIVERY_DETAILS | SOURCE_HEADER_ID | join | 16 | HIGH | Y | Y |
| 49 | INV_RESERVATIONS | DEMAND_SOURCE_LINE_ID | WSH_DELIVERY_DETAILS | SOURCE_LINE_ID | join | 16 | HIGH | Y | Y |
| 50 | ZX_ACCOUNTS | LEDGER_ID | ZX_LINES | LEDGER_ID | join | 16 | HIGH | Y | Y |

## Notes

- JOIN evidence comes primarily from VIEW_TEXT (Oracle physical SQL); catalog report SQL contributed a small supplementary set — most catalog queries are BI *logical* SQL ("Subject Area"."Column") and were skipped per design. This tier is untouched by the anti-blowup fixes below and remains the most trustworthy signal.
- PK-name-match (tightened): a non-PK column in table T shares its exact name with a PK column of table U. Only qualifies if the column name ends in _ID/_CODE/_KEY, is not in the generic/system/"WHO"-column blacklist (ID, OBJECT_ID, CREATED_BY, LAST_UPDATE_DATE, etc.), and the PK column name is owned by at most 3 tables (otherwise it's a generic naming convention, not a specific business key). HIGH confidence when the column name stem also matches U's table-name stem, else MEDIUM. Capped at 10 emitted edges per source table and 3,000 total for this tier.
- shared_id_columns (aggregated, LOW/supplementary): previously this heuristic emitted one row per (table,table) pair sharing an *_ID column name, which exploded combinatorially (82K+ pairs, and the PK-name tier hit 4.29M before this fix) because a handful of near-universal column names are shared by hundreds/thousands of tables. It is now a SEPARATE summary of (column -> list of tables), only for specific business-key columns (same qualifying-suffix + blacklist rule as PK-name) shared by at most 30 tables. It is folded into an existing join/pk_name relationship as corroborating evidence only — it never creates a new pairwise edge by itself.
- Total output is capped at 20,000 relationships (sorted by confidence, then occurrences, so only the LOW-confidence tail would ever be dropped). Written via a streaming JSON writer (one element serialized at a time) rather than `JSON.stringify` on the whole array, so the previous "RangeError: Invalid string length" crash cannot recur even if future changes increase the cap.
- All candidates are validated against META_COLUMNS.csv (streamed) to confirm the table and column actually exist, and checked against META_FKEYS.csv in both directions to exclude already-declared relationships.
