### Totals per class

| class | objects | TABLE | VIEW | corpus-used (>=1 statement) |
|---|---|---|---|---|
| DIRECT | 882 | 846 | 36 | 658 |
| VIA_JOIN | 4904 | 3275 | 1629 | 1829 |
| VIA_PARENT | 1953 | 1879 | 74 | 1117 |
| REGISTERED_NO_GRANT | 18 | 13 | 5 | 13 |
| DISALLOWED | 17 | 15 | 2 | 0 |
| UNSECURABLE | 22028 | 16870 | 5158 | 6286 |
| TOTAL | 29802 | 22898 | 6904 | 9903 |


### Top-20 modules by catalog objects, per class

| module | objects | DIRECT | VIA_JOIN | VIA_PARENT | REGISTERED_NO_GRANT | DISALLOWED | UNSECURABLE |
|---|---|---|---|---|---|---|---|
| GTG | 2536 | 0 | 13 | 0 | 0 | 0 | 2523 |
| MSC | 1526 | 3 | 332 | 1 | 0 | 0 | 1190 |
| FND | 987 | 28 | 40 | 3 | 3 | 0 | 913 |
| CST | 898 | 1 | 558 | 51 | 0 | 0 | 288 |
| PER | 861 | 86 | 291 | 9 | 0 | 0 | 475 |
| PAY | 684 | 145 | 225 | 13 | 0 | 0 | 301 |
| IRC | 669 | 14 | 89 | 13 | 0 | 0 | 553 |
| HEY | 634 | 6 | 10 | 32 | 0 | 0 | 586 |
| PSC_CC | 575 | 83 | 14 | 4 | 0 | 0 | 474 |
| CPQ | 546 | 0 | 3 | 0 | 0 | 0 | 543 |
| AR | 505 | 0 | 218 | 38 | 0 | 0 | 249 |
| FUN | 503 | 4 | 76 | 25 | 2 | 0 | 396 |
| ZCA | 491 | 16 | 6 | 36 | 0 | 0 | 433 |
| CSO | 412 | 4 | 2 | 153 | 0 | 0 | 253 |
| BEN | 395 | 23 | 69 | 5 | 0 | 0 | 298 |
| CN | 386 | 55 | 221 | 36 | 1 | 0 | 73 |
| FFS | 384 | 0 | 0 | 0 | 0 | 6 | 378 |
| HRT | 384 | 9 | 76 | 29 | 0 | 0 | 270 |
| IBY | 383 | 16 | 30 | 65 | 0 | 0 | 272 |
| OKC | 355 | 6 | 38 | 50 | 0 | 0 | 261 |


### Examples per class (top corpus usage)

| class | object | type | usage | evidence |
|---|---|---|---|---|
| DIRECT | INV_ORG_PARAMETERS | TABLE | 2612 | INV_ORG_PARAMETERS: 51 privileges, pk ORGANIZATION_ID |
| DIRECT | EGO_ITEM_EFF_B | TABLE | 2171 | EGO_ITEM_EFF_B: 8 privileges, pk EFF_LINE_ID |
| DIRECT | FND_VS_VALUES_VL | VIEW | 1749 | XXKD_COMPANY_SECURITY_RULE: 1 privileges, pk VALUE_ID; customer-only object |
| DIRECT | HZ_PARTIES | TABLE | 1695 | HZ_PARTIES: 21 privileges, pk PARTY_ID; isolation needed |
| DIRECT | PER_USERS | TABLE | 1017 | PER_USERS: 8 privileges, pk USER_ID; isolation needed |
| VIA_JOIN | FND_LOOKUP_VALUES_TL | TABLE | 3431 | SET_ID -> FND_SETID_SETS_VL.SET_ID [strict] 0 FND_ privileges |
| VIA_JOIN | EGP_SYSTEM_ITEMS_ALL_V | VIEW | 2253 | INVENTORY_ORGANIZATION_ID -> INV_ORG_PARAMETERS.ORGANIZATION_ID [leaky] 0 EGP_ privileges; ORGANIZATION_ID -> INV_ORG_PARAMETERS.ORGANIZATION_ID [strict] 0 EGP_ privileges |
| VIA_JOIN | EGP_ITEM_REVISIONS_V | VIEW | 2251 | ORGANIZATION_ID -> INV_ORG_PARAMETERS.ORGANIZATION_ID [strict] 0 EGP_ privileges |
| VIA_JOIN | PER_PERSON_NAMES_F_V | VIEW | 1603 | PERSON_ID -> PER_ALL_PEOPLE_F.PERSON_ID [strict] / PER_PERSON_SECURED_LIST_V 10 PER_ privileges |
| VIA_JOIN | HR_ORGANIZATION_UNITS_F_TL | TABLE | 768 | ORGANIZATION_ID -> HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID [strict] / PER_DEPARTMENT_SECURED_LIST_V 2 PER_ privileges |
| VIA_PARENT | ZCA_OBJECT_SHARE_VIEW | VIEW | 314 | OBJECT_ID -> SVC_SERVICE_REQUESTS.SR_ID via corpus_join [strict; chain strict; hops 1] |
| VIA_PARENT | POZ_SUPPLIERS | TABLE | 301 | PARTY_ID -> HZ_PARTIES.PARTY_ID via fk [strict; chain strict; hops 1] |
| VIA_PARENT | JTF_RS_REP_MANAGERS | TABLE | 296 | RESOURCE_ID -> HZ_PARTIES.PARTY_ID via fk [strict; chain strict; hops 1] |
| VIA_PARENT | ZCA_SALES_ACCOUNTS | TABLE | 257 | PARTY_ID -> HZ_PARTIES.PARTY_ID via fk [strict; chain strict; hops 1] |
| VIA_PARENT | HZ_PERSON_PROFILES | TABLE | 190 | PARTY_ID -> HZ_PARTIES.PARTY_ID via fk [strict; chain strict; hops 1] |
| REGISTERED_NO_GRANT | FND_TERRITORIES_TL | TABLE | 297 | FND_TERRITORIES_TL: no active grant |
| REGISTERED_NO_GRANT | FND_ATTACHED_DOCUMENTS | TABLE | 183 | FND_ATTACHED_DOCUMENTS: no active grant |
| REGISTERED_NO_GRANT | EGO_ITEM_EFF_VL | VIEW | 81 | EGO_ITEM_EFF_VL: 22 active grants but 0 registered privileges (grants carry no privilege) |
| REGISTERED_NO_GRANT | FLA_LEASES_ALL | TABLE | 76 | FLA_LEASES_ALL: no active grant |
| REGISTERED_NO_GRANT | WIS_WORK_DEFINITIONS | TABLE | 60 | WIS_WORK_DEFINITIONS: no active grant |
| DISALLOWED | CTO_PENDING_COPY_ENTITY_ORGS | TABLE | 0 | ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and CTO_PENDING_COPY_ENTITY_ORGS is used by no  |
| DISALLOWED | FFS_QBI_CAPACITY_AREA | TABLE | 0 | ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and FFS_QBI_CAPACITY_AREA is used by no corpus  |
| DISALLOWED | FFS_QBI_CAR_ORGANIZATION | TABLE | 0 | ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and FFS_QBI_CAR_ORGANIZATION is used by no corp |
| DISALLOWED | FFS_RESOURCE_LOG | TABLE | 0 | ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and FFS_RESOURCE_LOG is used by no corpus SQL ( |
| DISALLOWED | FFS_SCHEDULE | TABLE | 0 | ORGANIZATION_ID: no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type — and FFS_SCHEDULE is used by no corpus SQL (BIP, |
| UNSECURABLE | EGP_ITEM_CLASSES_VL | VIEW | 2262 | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| UNSECURABLE | HCM_LOOKUPS | VIEW | 1750 | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| UNSECURABLE | FND_LOOKUPS | VIEW | 794 | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| UNSECURABLE | FND_DF_CONTEXTS_VL | VIEW | 460 | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| UNSECURABLE | FND_CAL_DAY | TABLE | 404 | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |


### Condition shapes (FND_OBJECT_INSTANCE_SETS)

| shape | all sets | in active grant | active seed | as_is | isolated_required | pod_specific | HCM profile-compiled | HCM placeholder _S | HCM seed condition |
|---|---|---|---|---|---|---|---|---|---|
| literal_id | 2 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| constant_true | 841 | 520 | 520 | 0 | 520 | 0 | 247 | 1 | 1 |
| constant_false | 516 | 511 | 511 | 0 | 511 | 0 | 0 | 311 | 1 |
| grant_parameter | 182 | 36 | 36 | 33 | 3 | 0 | 0 | 0 | 18 |
| urda_direct | 59 | 55 | 55 | 52 | 3 | 0 | 0 | 0 | 0 |
| urda_derived | 87 | 78 | 78 | 73 | 5 | 0 | 0 | 0 | 0 |
| datasec_context | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| session_util | 2234 | 1474 | 1474 | 1451 | 23 | 0 | 536 | 0 | 59 |
| plain_column_filter | 920 | 871 | 858 | 653 | 205 | 0 | 5 | 0 | 28 |
| exists_other_object | 789 | 663 | 663 | 660 | 3 | 0 | 1 | 0 | 1 |
| other | 4 | 4 | 4 | 3 | 1 | 0 | 0 | 0 | 0 |
| TOTAL | 5634 | 4213 | 4199 | 2925 | 1274 | 0 | 790 | 312 | 108 |


### Customer layer (CREATED_BY <> SEED_DATA_FROM_APPLICATION)

| object | db object | in catalog | custom object | instance set | created by | active | links | privileges | shape |
|---|---|---|---|---|---|---|---|---|---|
| ConsumptionDetailsForSub_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| ConsumptionDetailsForSub_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| ConsumptionSummaryForSub_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| ConsumptionSummaryForSub_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementForCategoryFamily_c | MOO_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementForCategoryFamily_c | MOO_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementForMaxReplacement_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementForMaxReplacement_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementsForSub_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| EntitlementsForSub_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| KornitFileUploadRequest_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| KornitFileUploadRequest_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| KornitRestUtil_c | SVC_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| KornitRestUtil_c | SVC_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| KornitServiceCostTarget_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| KornitServiceCostTarget_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| KornitServiceLookup_c | MOT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| KornitServiceLookup_c | MOT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| MKT_IMP_JOBS | MKT_IMP_JOBS | Y | N | ORA_TOP_EXTN_JOBIM | <customer user> | Y | 4 | HZ_MANAGE_ORA_TOP_EXTN_JOB_FILE_IMPORT_ACTIVITY_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |
| MKT_IMP_JOBS | MKT_IMP_JOBS | Y | N | STD_IMPORT_JOBIM | <customer user> | Y | 4 | ZCX_MANAGE_STD_IMPORT_JOB_FILE_IMPORT_ACTIVITY_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |
| MKT_IMP_MAP | MKT_IMP_MAP | Y | N | ORA_TOP_EXTN_MAPIM | <customer user> | Y | 4 | HZ_MANAGE_ORA_TOP_EXTN_MAP_FILE_IMPORT_MAPPING_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |
| MKT_IMP_MAP | MKT_IMP_MAP | Y | N | STD_IMPORT_MAPIM | <customer user> | Y | 4 | ZCX_MANAGE_STD_IMPORT_MAP_FILE_IMPORT_MAPPING_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |
| MKT_IMP_OBJECTS | MKT_IMP_OBJECTS | Y | N | ORA_TOP_EXTN_OBJECTIM | <customer user> | Y | 4 | HZ_MANAGE_ORA_TOP_EXTN_OBJECT_FILE_IMPORT_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |
| MSC_ORGANIZATIONS | MSC_ORGANIZATION_SUBINV_V | Y | N | MSC_2_<id> | <customer user> | Y | 2 | MSC_VIEW_PLANS, read | literal_id |
| SubscriptionProductBGJob_c | SVC_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| SubscriptionProductBGJob_c | SVC_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_AIC_COMMITEMET_c | SVC_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_AIC_COMMITEMET_c | SVC_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDEU_300 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDIL_100 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDSL_321 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDTS_330 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDUK_310 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KDX_320 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_COMPANY_SECURITY_RULE | FND_VS_VALUES_VL | Y | Y | XXKD_GL_COMPANY_KTIL_150 | <customer user> | Y | 1 | read | plain_column_filter |
| XXKD_CONCUR2MESH_REQUESTS_c | SVC_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_CONCUR2MESH_REQUESTS_c | SVC_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_DAILY_COMMITMENT_CALC_c | MOT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_DAILY_COMMITMENT_CALC_c | MOT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_PIONET2AQ_ITEMS_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_PIONET2AQ_ITEMS_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICESFORAHDRSTGTBL_c | MOO_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICESFORAHDRSTGTBL_c | MOO_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICESFORALINESTGTBL_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICESFORALINESTGTBL_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICE_QUOTE_KITTING_S_c | HZ_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_SERVICE_QUOTE_KITTING_S_c | HZ_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_BILL_QTY_SUM_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_BILL_QTY_SUM_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_BOTTLES_c | ZCA_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_BOTTLES_c | ZCA_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_FIXA_ITEMS_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_FIXA_ITEMS_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_IMPRESSIONS_ALL_c | MKT_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_IMPRESSIONS_ALL_c | MKT_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_RFID_SUM_c | SVC_REF_ENTITIES | Y | Y | ZCX_MGRHIER_<id> | <customer user> | N | 0 |  | session_util |
| XXKD_TB_RFID_SUM_c | SVC_REF_ENTITIES | Y | Y | ZCX_OWNER_<id> | <customer user> | N | 0 |  | session_util |
| ZCA_OBJECTS | ZCA_OBJECTS | Y | N | STD_IMPORTEXPORT_OBJECTSIM | <customer user> | Y | 4 | ZCX_MANAGE_STD_IMPORTEXPORT_OBJECTS_FILE_IMPORT_OBJECT_TYPE_DATA, delete, read, update | plain_column_filter |


### Leaky / strict columns — top-50 corpus-used VIA_JOIN tables

| table | usage | column | context | reference object | NOT NULL | verdict | corpus joins | corpus filters | product privileges on reference |
|---|---|---|---|---|---|---|---|---|---|
| FND_LOOKUP_VALUES_TL | 3431 | SET_ID | SET | FND_SETID_SETS_VL.SET_ID | yes | strict | 80 | 3273 | 0 () |
| EGP_SYSTEM_ITEMS_ALL_V | 2253 | INVENTORY_ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 0 | 0 | 0 () |
| EGP_SYSTEM_ITEMS_ALL_V | 2253 | ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 2253 | 0 | 0 () |
| EGP_ITEM_REVISIONS_V | 2251 | ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 2251 | 0 | 0 () |
| PER_PERSON_NAMES_F_V | 1603 | PERSON_ID | HCM_PERSON | PER_ALL_PEOPLE_F.PERSON_ID | yes | strict | 1474 | 0 | 10 (PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA, PER_REPORT_PERSON_CHECKLIST_DATA, PER_REPORT_PERSON_CONTACT_DISABILITY_DATA…) |
| HR_ORGANIZATION_UNITS_F_TL | 768 | ORGANIZATION_ID | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID | yes | strict | 734 | 0 | 2 (PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA) |
| EGP_SYSTEM_ITEMS_VL | 402 | INVENTORY_ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 4 | 0 | 0 () |
| EGP_SYSTEM_ITEMS_VL | 402 | ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 312 | 0 | 0 () |
| PJF_PROJECTS_ALL_B | 357 | CARRYING_OUT_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | yes | strict | 27 | 0 | 0 () |
| PJF_PROJECTS_ALL_B | 357 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 46 | 4 | 3 (PJF_MANAGE_PROJECT_ACCOUNTING_PERIOD_STATUS_DATA, PJF_RUN_ACCOUNTING_PERIOD_PROCESSES_DATA, PJF_RUN_GENERATE_BURDEN_TRANSACTIONS_PROCESS_DATA) |
| FND_LOOKUP_VALUES_VL | 304 | SET_ID | SET | FND_SETID_SETS_VL.SET_ID | yes | strict | 0 | 40 | 0 () |
| AP_INVOICES_ALL | 267 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 37 | 0 | 9 (AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA, AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA, AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA…) |
| AP_INVOICES_ALL | 267 | EXPENDITURE_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 0 | 0 | 0 () |
| AP_INVOICES_ALL | 267 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 18 | 0 | 0 () |
| RA_CUSTOMER_TRX_ALL | 256 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 55 | 0 | 11 (AR_MANAGE_RECEIVABLES_ACTIVITIES_DATA, AR_MANAGE_RECEIVABLES_ACTIVITY_DATA, AR_MANAGE_RECEIVABLES_DISTRIBUTION_SET_DATA…) |
| RA_CUSTOMER_TRX_ALL | 256 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 15 | 0 | 0 () |
| HRT_PROFILES_VL | 245 | PERSON_ID | HCM_PERSON | PER_ALL_PEOPLE_F.PERSON_ID | no | leaky | 126 | 0 | 23 (HRT_REPORT_ACCOMPLISHMENT_CONTENT_TYPE_DATA, HRT_REPORT_ADVANCEMENT_READINESS_CONTENT_TYPE_DATA, HRT_REPORT_AREA_OF_STUDY_CONTENT_TYPE_DATA…) |
| PER_JOBS_F_TL | 242 | JOB_ID | HCM_JOB | PER_JOBS_F.JOB_ID | yes | strict | 211 | 0 | 1 (PER_REPORT_HR_JOB_DATA) |
| POZ_SUPPLIER_SITES_ALL_M | 236 | PRC_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 14 | 0 | 0 () |
| PO_LINES_ALL | 206 | PRC_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 6 | 0 | 0 () |
| PO_LINES_ALL | 206 | REQ_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 1 | 0 | 0 () |
| PO_LINES_ALL | 206 | SOLDTO_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| WIE_WORK_ORDERS_B | 194 | ORGANIZATION_ID | MFG_ORG | RCS_MFG_PARAMETERS.ORGANIZATION_ID | yes | strict | 35 | 0 | 0 () |
| WIE_WORK_ORDERS_B | 194 | PJC_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 2 | 0 | 0 () |
| AP_INVOICE_DISTRIBUTIONS_ALL | 191 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 24 | 0 | 9 (AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA, AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA, AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA…) |
| AP_INVOICE_DISTRIBUTIONS_ALL | 191 | EXPENDITURE_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 1 | 0 | 0 () |
| AP_INVOICE_DISTRIBUTIONS_ALL | 191 | PJC_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 5 | 0 | 0 () |
| AP_INVOICE_DISTRIBUTIONS_ALL | 191 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 12 | 0 | 0 () |
| POZ_SUPPLIERS_V | 190 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | no | leaky | 0 | 0 | 0 () |
| PER_LOCATION_DETAILS_F_VL | 188 | LOCATION_ID | HCM_LOC | PER_LOCATIONS.LOCATION_ID | yes | strict | 126 | 0 | 1 (PER_REPORT_LOCATION_DATA) |
| HR_ALL_ORGANIZATION_UNITS_F_VL | 175 | ORGANIZATION_ID | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID | yes | strict | 145 | 0 | 2 (PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA) |
| HR_ALL_ORGANIZATION_UNITS_F_VL | 175 | LOCATION_ID | HCM_LOC | PER_LOCATIONS.LOCATION_ID | no | leaky | 3 | 0 | 1 (PER_REPORT_LOCATION_DATA) |
| AP_INVOICE_LINES_ALL | 169 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 16 | 0 | 9 (AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA, AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA, AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA…) |
| AP_INVOICE_LINES_ALL | 169 | EXPENDITURE_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 0 | 0 | 0 () |
| AP_INVOICE_LINES_ALL | 169 | PJC_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 5 | 0 | 0 () |
| AP_INVOICE_LINES_ALL | 169 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 1 | 0 | 0 () |
| FUN_BU_PERF_V | 169 | BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 169 | 0 | 0 () |
| PO_LINE_LOCATIONS_ALL | 167 | PRC_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 0 | 0 | 0 () |
| PO_LINE_LOCATIONS_ALL | 167 | REQ_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| PO_LINE_LOCATIONS_ALL | 167 | SOLDTO_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| INV_ITEM_LOCATIONS | 154 | ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 25 | 0 | 39 (INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA, INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA, INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA…) |
| PJF_PROJ_ELEMENTS_B | 153 | CARRYING_OUT_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | yes | strict | 22 | 0 | 0 () |
| PJF_PROJ_ELEMENTS_VL | 153 | CARRYING_OUT_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | yes | strict | 9 | 0 | 0 () |
| PER_JOBS_F_VL | 148 | JOB_ID | HCM_JOB | PER_JOBS_F.JOB_ID | yes | strict | 133 | 0 | 1 (PER_REPORT_HR_JOB_DATA) |
| INV_ORGANIZATION_DEFINITIONS_V | 142 | ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 130 | 0 | 39 (INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA, INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA, INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA…) |
| INV_ORGANIZATION_DEFINITIONS_V | 142 | BUSINESS_UNIT_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| INV_ORGANIZATION_DEFINITIONS_V | 142 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | no | leaky | 2 | 0 | 0 () |
| PER_GRADES_F_TL | 139 | GRADE_ID | HCM_GRADE | PER_GRADES_F.GRADE_ID | yes | strict | 109 | 0 | 1 (PER_REPORT_ASSIGNMENT_GRADE_DATA) |
| HR_LOCATIONS_ALL_F_VL | 138 | LOCATION_ID | HCM_LOC | PER_LOCATIONS.LOCATION_ID | yes | strict | 127 | 0 | 1 (PER_REPORT_LOCATION_DATA) |
| WIE_WO_OPERATIONS_B | 138 | ORGANIZATION_ID | MFG_ORG | RCS_MFG_PARAMETERS.ORGANIZATION_ID | yes | strict | 21 | 0 | 0 () |
| EGP_SYSTEM_ITEMS_TL_V | 137 | ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 137 | 0 | 0 () |
| EGP_ITEM_CATEGORIES | 135 | ORGANIZATION_ID | ITM_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 41 | 0 | 0 () |
| ZX_REP_TRX_DETAIL_T | 134 | LEDGER_ID | LEDGER | GL_LEDGERS.LEDGER_ID | no | leaky | 1 | 0 | 0 () |
| PER_MANAGER_HRCHY_DN | 130 | PERSON_ID | HCM_PERSON | PER_ALL_PEOPLE_F.PERSON_ID | no | leaky | 103 | 0 | 10 (PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA, PER_REPORT_PERSON_CHECKLIST_DATA, PER_REPORT_PERSON_CONTACT_DISABILITY_DATA…) |
| PER_MANAGER_HRCHY_DN | 130 | ASSIGNMENT_ID | HCM_ASG | PER_ALL_ASSIGNMENTS_M.ASSIGNMENT_ID | no | leaky | 64 | 0 | 7 (PER_REPORT_ASSIGNMENT_DATA, PER_REPORT_PERSON_ASSIGNMENT_DATA, PER_REPORT_PERSON_DATA…) |
| PO_DISTRIBUTIONS_ALL | 128 | PRC_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 2 | 0 | 0 () |
| PO_DISTRIBUTIONS_ALL | 128 | PJC_ORGANIZATION_ID | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F.ORGANIZATION_ID | no | leaky | 4 | 0 | 0 () |
| PO_DISTRIBUTIONS_ALL | 128 | REQ_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 0 | 0 | 0 () |
| PO_DISTRIBUTIONS_ALL | 128 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 2 | 0 | 0 () |
| PO_DISTRIBUTIONS_ALL | 128 | SOLDTO_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| HR_ORGANIZATION_V | 123 | ORGANIZATION_ID | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F.ORGANIZATION_ID | yes | strict | 120 | 0 | 2 (PER_REPORT_DEPARTMENT_DATA, PER_REPORT_LEGAL_EMPLOYER_DATA) |
| HR_ORGANIZATION_V | 123 | LOCATION_ID | HCM_LOC | PER_LOCATIONS.LOCATION_ID | no | leaky | 3 | 0 | 1 (PER_REPORT_LOCATION_DATA) |
| RCV_SHIPMENT_HEADERS | 123 | ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 2 | 0 | 5 (RCV_MANAGE_INBOUND_SHIPMENT_DATA, RCV_MANAGE_RECEIVING_OPTION_DATA, RCV_MANAGE_RECEIVING_RECEIPT_DATA…) |
| RCV_SHIPMENT_HEADERS | 123 | RMA_BU_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 0 | 0 | 0 () |
| HR_ALL_POSITIONS_F_TL | 122 | POSITION_ID | HCM_POS | HR_ALL_POSITIONS_F.POSITION_ID | yes | strict | 105 | 0 | 1 (PER_REPORT_POSITION_DATA) |
| OKC_K_HEADERS_VL | 121 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 8 | 0 | 0 () |
| OKC_K_HEADERS_VL | 121 | INV_ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | no | leaky | 0 | 0 | 0 () |
| INV_ORG_PARAMETERS_V | 120 | ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 119 | 0 | 39 (INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA, INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA, INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA…) |
| INV_ORG_PARAMETERS_V | 120 | BUSINESS_UNIT_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | no | leaky | 3 | 0 | 0 () |
| RA_CUSTOMER_TRX_LINES_ALL | 118 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 20 | 0 | 11 (AR_MANAGE_RECEIVABLES_ACTIVITIES_DATA, AR_MANAGE_RECEIVABLES_ACTIVITY_DATA, AR_MANAGE_RECEIVABLES_DISTRIBUTION_SET_DATA…) |
| RA_CUSTOMER_TRX_LINES_ALL | 118 | SET_OF_BOOKS_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 2 | 0 | 0 () |
| PER_LEGISLATIVE_DATA_GROUPS_VL | 114 | LEGISLATIVE_DATA_GROUP_ID | HCM_LDG | PER_LEGISLATIVE_DATA_GROUPS.LEGISLATIVE_DATA_GROUP_ID | yes | strict | 91 | 0 | 1 (PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA) |
| XLA_AE_LINES | 110 | LEDGER_ID | LEDGER | GL_LEDGERS.LEDGER_ID | yes | strict | 28 | 0 | 0 () |
| AR_PAYMENT_SCHEDULES_ALL | 105 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 12 | 0 | 11 (AR_MANAGE_RECEIVABLES_ACTIVITIES_DATA, AR_MANAGE_RECEIVABLES_ACTIVITY_DATA, AR_MANAGE_RECEIVABLES_DISTRIBUTION_SET_DATA…) |
| DOO_FULFILL_LINES_ALL | 105 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 29 | 0 | 1 (DOO_MANAGE_ORCHESTRATION_ORDER_DATA) |
| DOO_FULFILL_LINES_ALL | 105 | INVENTORY_ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 7 | 0 | 0 () |
| PAY_PAYROLL_REL_ACTIONS | 104 | PAYROLL_RELATIONSHIP_ID | HCM_PAYREL | PAY_PAY_RELATIONSHIPS_DN.PAYROLL_RELATIONSHIP_ID | yes | strict | 50 | 0 | 3 (PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS, PAY_REPORT_PAYROLL_RELATIONSHIP_DATA, PAY_REPORT_PERSON_PROCESS_RESULTS_DATA) |
| FND_TREE_VL | 100 | SET_ID | SET | FND_SETID_SETS_VL.SET_ID | yes | strict | 0 | 0 | 0 () |
| AP_CHECKS_ALL | 99 | ORG_ID | BU | FUN_ALL_BUSINESS_UNITS_V.BU_ID | yes | strict | 54 | 0 | 9 (AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA, AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA, AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA…) |
| PER_ACTION_OCCURRENCES | 94 | POSITION_ID | HCM_POS | HR_ALL_POSITIONS_F.POSITION_ID | no | leaky | 0 | 0 | 1 (PER_REPORT_POSITION_DATA) |
| INV_SECONDARY_INVENTORIES_VL | 90 | ORGANIZATION_ID | INV_ORG | INV_ORG_PARAMETERS.ORGANIZATION_ID | yes | strict | 65 | 0 | 39 (INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA, INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA, INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA…) |


### module -> reference object -> privilege candidates (top products)

| product | context | reference object | VIA_JOIN columns | candidates | privileges (roles) |
|---|---|---|---|---|---|
| AP | BU | FUN_ALL_BUSINESS_UNITS_V | 71 | 9 | AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA (1 roles), AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA (9 roles), AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA (14 roles), AP_MANAGE_PAYABLES_INVOICE_DATA (93 roles, iso), AP_MANAGE_PAYABLES_SYSTEM_OPTION_DATA (14 roles), AP_MANAGE_PAYABLES_TAX_REPORTING_ENTITY_DATA (12 roles)… |
| AP | LEDGER | GL_LEDGERS | 26 | 0 | (none with prefix AP_ — unmapped) |
| AP | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 19 | 0 | (none with prefix AP_ — unmapped) |
| AP | INV_ORG | INV_ORG_PARAMETERS | 3 | 0 | (none with prefix AP_ — unmapped) |
| AP | SET | FND_SETID_SETS_VL | 1 | 1 | AP_MANAGE_PAYABLES_PAYMENT_TERMS_DATA (13 roles) |
| AP | (DIRECT objects) | - | 0 | - |  |
| AR | BU | FUN_ALL_BUSINESS_UNITS_V | 123 | 11 | AR_MANAGE_RECEIVABLES_ACTIVITIES_DATA (46 roles), AR_MANAGE_RECEIVABLES_ACTIVITY_DATA (16 roles), AR_MANAGE_RECEIVABLES_DISTRIBUTION_SET_DATA (13 roles), AR_MANAGE_RECEIVABLES_RECEIPTS_DATA (29 roles), AR_MANAGE_RECEIVABLES_RECEIPT_METHOD_ACCOUNT_DATA (12 roles), AR_MANAGE_RECEIVABLES_RECEIPT_SOURCE_DATA (12 roles)… |
| AR | LEDGER | GL_LEDGERS | 102 | 0 | (none with prefix AR_ — unmapped) |
| AR | SET | FND_SETID_SETS_VL | 24 | 11 | AR_MANAGE_RECEIVABLES_ACCOUNTING_RULE_DATA (13 roles), AR_MANAGE_RECEIVABLES_AUTOCASH_RULE_SET_DATA (12 roles), AR_MANAGE_RECEIVABLES_AUTOMATCH_RULE_SET_DATA (12 roles), AR_MANAGE_RECEIVABLES_BATCH_SOURCE_DATA (7 roles), AR_MANAGE_RECEIVABLES_LOCKBOX_DATA (7 roles), AR_MANAGE_RECEIVABLES_MEMO_LINE_TEMPLATE_DATA (13 roles)… |
| AR | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 1 | 0 | (none with prefix AR_ — unmapped) |
| AR | (DIRECT objects) | - | 0 | - |  |
| GL | LEDGER | GL_LEDGERS | 82 | 4 | GL_MANAGE_ACCOUNTING_PERIOD_STATUS_DATA (11 roles), GL_MANAGE_JOURNALS_TAX_DATA (20 roles), GL_REPORT_GENERAL_LEDGER_DATA (38 roles), GL_VIEW_ACCOUNTING_PERIOD_STATUS_DATA (17 roles) |
| GL | DAS | GL_ACCESS_SETS | 6 | 14 | GL_ADMINISTER_LEDGER_DATA (6 roles), GL_APPROVE_ACTUAL_JOURNAL_DATA (7 roles), GL_CLOSE_LEDGER_DATA (6 roles), GL_INQUIRE_AND_ANALYZE_GL_ACCOUNT_BALANCE_DATA (21 roles), GL_MANAGE_ACCESS_SET_DATA (1 roles), GL_MANAGE_ACCOUNTING_PERIOD_STATUS_DATA (6 roles)… |
| GL | BU | FUN_ALL_BUSINESS_UNITS_V | 4 | 0 | (none with prefix GL_ — unmapped) |
| GL | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 1 | 0 | (none with prefix GL_ — unmapped) |
| GL | (DIRECT objects) | - | 3 | - | GL_ACCESS_SETS, GL_LEDGERS, GL_PERIOD_STATUSES |
| PO | BU | FUN_ALL_BUSINESS_UNITS_V | 126 | 0 | (none with prefix PO_ — unmapped) |
| PO | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 14 | 0 | (none with prefix PO_ — unmapped) |
| PO | LEDGER | GL_LEDGERS | 12 | 0 | (none with prefix PO_ — unmapped) |
| PO | INV_ORG | INV_ORG_PARAMETERS | 3 | 0 | (none with prefix PO_ — unmapped) |
| PO | MFG_ORG | RCS_MFG_PARAMETERS | 1 | 0 | (none with prefix PO_ — unmapped) |
| PO | (DIRECT objects) | - | 1 | - | PO_HEADERS_ALL |
| POZ | BU | FUN_ALL_BUSINESS_UNITS_V | 20 | 0 | (none with prefix POZ_ — unmapped) |
| POZ | LEDGER | GL_LEDGERS | 1 | 0 | (none with prefix POZ_ — unmapped) |
| POZ | (DIRECT objects) | - | 5 | - | POZ_LOOKUP_CODES, POZ_SUPPLIERS_PII, POZ_SUPPLIER_SITES_PII, POZ_SUPP_REQUESTS_PII, POZ_SUP_REG_PII |
| INV | INV_ORG | INV_ORG_PARAMETERS | 136 | 39 | INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA (14 roles), INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA (4 roles), INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA (26 roles), INV_MANAGE_ABC_CLASS_DATA (27 roles), INV_MANAGE_ABC_COMPILE_HEADER_DATA (26 roles), INV_MANAGE_CYCLE_COUNT_DATA (25 roles)… |
| INV | BU | FUN_ALL_BUSINESS_UNITS_V | 14 | 0 | (none with prefix INV_ — unmapped) |
| INV | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 10 | 0 | (none with prefix INV_ — unmapped) |
| INV | LEDGER | GL_LEDGERS | 5 | 0 | (none with prefix INV_ — unmapped) |
| INV | (DIRECT objects) | - | 1 | - | INV_ORG_PARAMETERS |
| CST | COST_ORG | CST_COST_ORGS_V | 403 | 38 | CST_ANALYZE_GROSS_MARGIN_DATA (10 roles), CST_APPROVE_COST_ESTIMATES_DATA (1 roles), CST_APPROVE_STANDARD_COSTS_DATA (12 roles), CST_CREATE_COST_DISTRIBUTION_DATA (10 roles), CST_CREATE_COST_ESTIMATE_REQUESTS_DATA (1 roles), CST_EXTRACT_AND_WAREHOUSE_VALUATION_UNIT_DATA (2 roles)… |
| CST | INV_ORG | INV_ORG_PARAMETERS | 317 | 0 | (none with prefix CST_ — unmapped) |
| CST | BU | FUN_ALL_BUSINESS_UNITS_V | 97 | 0 | (none with prefix CST_ — unmapped) |
| CST | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 26 | 0 | (none with prefix CST_ — unmapped) |
| CST | LEDGER | GL_LEDGERS | 23 | 0 | (none with prefix CST_ — unmapped) |
| CST | SET | FND_SETID_SETS_VL | 17 | 15 | CST_EXTRACT_AND_WAREHOUSE_VALUATION_STRUCTURE_DATA (2 roles), CST_MANAGE_COST_ANALYSIS_MAPPINGS_DATA (18 roles), CST_MANAGE_COST_COMPONENTS_DATA (18 roles), CST_MANAGE_COST_ELEMENT_DATA (18 roles), CST_MANAGE_COST_PROFILE_DATA (18 roles), CST_MANAGE_COST_VALUATION_STRUCTURE_DATA (18 roles)… |
| CST | MFG_ORG | RCS_MFG_PARAMETERS | 2 | 0 | (none with prefix CST_ — unmapped) |
| CST | (DIRECT objects) | - | 1 | - | CST_COST_ORGS_V |
| PJF | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 46 | 0 | (none with prefix PJF_ — unmapped) |
| PJF | BU | FUN_ALL_BUSINESS_UNITS_V | 30 | 3 | PJF_MANAGE_PROJECT_ACCOUNTING_PERIOD_STATUS_DATA (5 roles), PJF_RUN_ACCOUNTING_PERIOD_PROCESSES_DATA (5 roles), PJF_RUN_GENERATE_BURDEN_TRANSACTIONS_PROCESS_DATA (3 roles) |
| PJF | SET | FND_SETID_SETS_VL | 11 | 0 | (none with prefix PJF_ — unmapped) |
| PJF | LEDGER | GL_LEDGERS | 7 | 0 | (none with prefix PJF_ — unmapped) |
| PJF | INV_ORG | INV_ORG_PARAMETERS | 1 | 0 | (none with prefix PJF_ — unmapped) |
| PJF | (DIRECT objects) | - | 3 | - | PJF_ALL_ORGANIZATIONS, PJF_PROJECTS_ALL_VL, PJF_RATE_OVERRIDES |
| PJC | BU | FUN_ALL_BUSINESS_UNITS_V | 50 | 18 | PJC_MANAGE_ELEMENT_LABOR_SCHEDULES_BUSINESS_UNIT_DATA (1 roles), PJC_MANAGE_PROJECT_ALLOCATION_RULE_DATA (5 roles), PJC_MANAGE_PROJECT_ALLOCATION_TRANSACTION_DATA (3 roles), PJC_MANAGE_PROJECT_CAPITALIZED_INTEREST_RATE_SCHEDULE_DATA (5 roles), PJC_MANAGE_PROJECT_CAPITAL_ASSET_DATA (3 roles), PJC_MANAGE_PROJECT_CAPITAL_INTEREST_DATA (5 roles)… |
| PJC | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 32 | 0 | (none with prefix PJC_ — unmapped) |
| PJC | LEDGER | GL_LEDGERS | 21 | 0 | (none with prefix PJC_ — unmapped) |
| PJC | INV_ORG | INV_ORG_PARAMETERS | 1 | 0 | (none with prefix PJC_ — unmapped) |
| PJC | (DIRECT objects) | - | 5 | - | PJC_ALLOC_RUNS_ALL, PJC_COMMITMENT_TXNS, PJC_COST_DIST_LINES_ALL, PJC_EXP_ITEMS_ALL, PJC_TXN_XFACE_ALL |
| FA | BOOK | FA_BOOK_CONTROLS | 92 | 7 | FA_ADD_FIXED_ASSET_DATA (11 roles), FA_CHANGE_FIXED_ASSET_DATA (11 roles), FA_MANAGE_FIXED_ASSET_BOOK_DATA (11 roles), FA_RETIRE_FIXED_ASSET_DATA (11 roles), FA_SUBMIT_FIXED_ASSETS_REPORTS (27 roles), FA_TRACK_FIXED_ASSET_DATA (12 roles)… |
| FA | LEDGER | GL_LEDGERS | 36 | 0 | (none with prefix FA_ — unmapped) |
| FA | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 4 | 0 | (none with prefix FA_ — unmapped) |
| FA | SET | FND_SETID_SETS_VL | 4 | 4 | FA_MANAGE_FIXED_ASSET_BONUS_RULE_DATA (10 roles), FA_MANAGE_FIXED_ASSET_CEILING_DATA (10 roles), FA_MANAGE_FIXED_ASSET_DEPRECIATION_METHOD_DATA (10 roles), FA_MANAGE_FIXED_ASSET_PRORATE_CONVENTION_DATA (10 roles) |
| FA | BU | FUN_ALL_BUSINESS_UNITS_V | 3 | 0 | (none with prefix FA_ — unmapped) |
| FA | (DIRECT objects) | - | 1 | - | FA_BOOK_CONTROLS |
| XLA | LEDGER | GL_LEDGERS | 60 | 0 | (none with prefix XLA_ — unmapped) |
| XLA | BU | FUN_ALL_BUSINESS_UNITS_V | 1 | 0 | (none with prefix XLA_ — unmapped) |
| XLA | PRJ_ORG | HR_ORG_UNIT_CLASSIFICATIONS_F | 1 | 0 | (none with prefix XLA_ — unmapped) |
| XLA | (DIRECT objects) | - | 3 | - | XLA_GL_LEDGERS, XLA_SUBLEDGERS, XLA_TRANSACTION_ENTITIES |
| PER | HCM_PERSON | PER_ALL_PEOPLE_F | 127 | 10 | PER_REPORT_MASS_DOWNLOAD_DOCUMENT_RECORD_DATA (2 roles, iso), PER_REPORT_PERSON_CHECKLIST_DATA (4 roles, iso), PER_REPORT_PERSON_CONTACT_DISABILITY_DATA (2 roles, iso), PER_REPORT_PERSON_DATA (50 roles, iso), PER_REPORT_PERSON_DISABILITY_DATA (2 roles, iso), PER_REPORT_PERSON_EXTRA_INFORMATION_DATA (2 roles, iso)… |
| PER | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 81 | 7 | PER_REPORT_ASSIGNMENT_DATA (15 roles, iso), PER_REPORT_PERSON_ASSIGNMENT_DATA (13 roles, iso), PER_REPORT_PERSON_DATA (42 roles, iso), PER_REPORT_SENIORITY_DATE_DATA (3 roles, iso), PER_REPORT_VACANCY_DATA (4 roles, iso), PER_REPORT_WORKER_DATA (1 roles)… |
| PER | HCM_LOC | PER_LOCATIONS | 62 | 1 | PER_REPORT_LOCATION_DATA (47 roles) |
| PER | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 58 | 2 | PER_REPORT_DEPARTMENT_DATA (47 roles, iso), PER_REPORT_LEGAL_EMPLOYER_DATA (19 roles, iso) |
| PER | HCM_POS | HR_ALL_POSITIONS_F | 42 | 1 | PER_REPORT_POSITION_DATA (49 roles, iso) |
| PER | HCM_JOB | PER_JOBS_F | 41 | 1 | PER_REPORT_HR_JOB_DATA (47 roles) |
| PER | HCM_LDG | PER_LEGISLATIVE_DATA_GROUPS | 39 | 1 | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA (21 roles, iso) |
| PER | HCM_GRADE | PER_GRADES_F | 26 | 1 | PER_REPORT_ASSIGNMENT_GRADE_DATA (44 roles) |
| PER | HCM_WR | PER_PERIODS_OF_SERVICE | 11 | 2 | PER_REPORT_WORKER_DATA (1 roles), PER_REPORT_WORK_RELATIONSHIP_DATA (3 roles, iso) |
| PER | HCM_PAYROLL | PAY_ALL_PAYROLLS_F | 4 | 0 | (none with prefix PER_ — unmapped) |
| PER | (DIRECT objects) | - | 86 | - | HR_ALL_ORGANIZATION_UNITS_F, HR_ALL_POSITIONS_F, HR_DOCUMENTS_OF_RECORD, HR_DOCUMENT_DELIVERY_PREFS, HR_DOCUMENT_TYPES_B, HR_DOR_MASS_REQUESTS, HR_GEN_AI_AGENTS_B, HR_GEN_AI_PROMPTS_SEED_B… |
| PAY | HCM_LDG | PER_LEGISLATIVE_DATA_GROUPS | 178 | 0 | (none with prefix PAY_ — unmapped) |
| PAY | HCM_PAYREL | PAY_PAY_RELATIONSHIPS_DN | 33 | 3 | PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS (2 roles, iso), PAY_REPORT_PAYROLL_RELATIONSHIP_DATA (16 roles, iso), PAY_REPORT_PERSON_PROCESS_RESULTS_DATA (17 roles, iso) |
| PAY | HCM_PAYROLL | PAY_ALL_PAYROLLS_F | 32 | 2 | PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS (2 roles, iso), PAY_REPORT_PAYROLL_DEFINITION_DATA (20 roles, iso) |
| PAY | HCM_PERSON | PER_ALL_PEOPLE_F | 31 | 2 | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA (15 roles, iso), PAY_REPORT_PERSON_PROCESS_RESULTS_DATA (15 roles, iso) |
| PAY | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 19 | 1 | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA (8 roles, iso) |
| PAY | HCM_FLOW | PAY_FLOWS | 8 | 1 | PAY_REPORT_PAYROLL_FLOW_DATA (12 roles, iso) |
| PAY | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 3 | 1 | PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS (2 roles, iso) |
| PAY | HCM_LOC | PER_LOCATIONS | 1 | 0 | (none with prefix PAY_ — unmapped) |
| PAY | (DIRECT objects) | - | 145 | - | PAY_ACTION_CONTEXTS, PAY_ACTION_INFORMATION, PAY_ALLOW_OVERRIDES_F, PAY_ALL_PAYROLLS_F, PAY_ARCHIVE_ITEMS, PAY_ASSIGNED_PAYROLLS_DN, PAY_ASSIGNED_PAYROLLS_F, PAY_AUTO_INDIRECTS_F… |
| BEN | HCM_PERSON | PER_ALL_PEOPLE_F | 37 | 1 | BEN_SELF_REPORT_A_LIFE_EVENT_DATA (1 roles, iso) |
| BEN | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 12 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 11 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_LDG | PER_LEGISLATIVE_DATA_GROUPS | 11 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_PAYROLL | PAY_ALL_PAYROLLS_F | 4 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_LOC | PER_LOCATIONS | 3 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_JOB | PER_JOBS_F | 3 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_GRADE | PER_GRADES_F | 2 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | HCM_POS | HR_ALL_POSITIONS_F | 2 | 0 | (none with prefix BEN_ — unmapped) |
| BEN | (DIRECT objects) | - | 23 | - | BEN_BENEFIT_RELATIONS_F, BEN_BENFTS_GRP, BEN_BILL_CHARGES, BEN_CRT_ORDR_CVRD_PER, BEN_CVRD_DPNT_CTFN_PRVDD, BEN_ELIG_PER_F, BEN_ELIG_RSLT_F, BEN_LER_F… |
| HRT | HCM_PERSON | PER_ALL_PEOPLE_F | 71 | 23 | HRT_REPORT_ACCOMPLISHMENT_CONTENT_TYPE_DATA (1 roles, iso), HRT_REPORT_ADVANCEMENT_READINESS_CONTENT_TYPE_DATA (1 roles, iso), HRT_REPORT_AREA_OF_STUDY_CONTENT_TYPE_DATA (1 roles, iso), HRT_REPORT_BEHAVIOR_CONTENT_TYPE_DATA (1 roles, iso), HRT_REPORT_CAREER_PREFERENCES_CONTENT_TYPE_DATA (1 roles, iso), HRT_REPORT_CAREER_STATEMENT_CONTENT_TYPE_DATA (1 roles, iso)… |
| HRT | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 12 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | HCM_JOB | PER_JOBS_F | 8 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | HCM_POS | HR_ALL_POSITIONS_F | 6 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | HCM_GRADE | PER_GRADES_F | 4 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 3 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | HCM_LOC | PER_LOCATIONS | 2 | 0 | (none with prefix HRT_ — unmapped) |
| HRT | (DIRECT objects) | - | 9 | - | HRQ_QSTNR_PART_GSVY_V, HRQ_SUBSCRIBERS_B, HRT_CHANNEL_MESSAGES, HRT_CONTENT_TYPES_B, HRT_NOTES, HRT_NOTES_V, HRT_PROFILES_B, HRT_PROFILE_INTERESTS… |
| CMP | HCM_PERSON | PER_ALL_PEOPLE_F | 67 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 59 | 3 | CMP_REPORT_COMPENSATION_ALLOCATION_DATA (4 roles, iso), CMP_REPORT_COMPENSATION_STOCK_GRANT_DATA (3 roles, iso), CMP_REPORT_SALARY_DATA (8 roles, iso) |
| CMP | HCM_JOB | PER_JOBS_F | 26 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_LDG | PER_LEGISLATIVE_DATA_GROUPS | 20 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_LOC | PER_LOCATIONS | 14 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_GRADE | PER_GRADES_F | 13 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_POS | HR_ALL_POSITIONS_F | 11 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 6 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_PAYROLL | PAY_ALL_PAYROLLS_F | 6 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | HCM_PAYREL | PAY_PAY_RELATIONSHIPS_DN | 4 | 0 | (none with prefix CMP_ — unmapped) |
| CMP | (DIRECT objects) | - | 7 | - | CMP_CWB_PERSON_RATES, CMP_MKT_COMPOSITES, CMP_SALARY, CMP_STOCK_DETAILS, CMP_TCS_PER_PERD_FEEDBACKS, CMP_TCS_PER_PERD_STMT, CMP_VC_PER_ELIG_PLANS |
| IRC | HCM_PERSON | PER_ALL_PEOPLE_F | 73 | 3 | IRC_REPORT_JOB_OFFER_DATA (1 roles, iso), IRC_REPORT_JOB_OFFER_OTHER_COMPENSATION_DATA (1 roles, iso), IRC_REPORT_JOB_OFFER_SALARY_DATA (1 roles, iso) |
| IRC | HCM_JOB | PER_JOBS_F | 9 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | HCM_LOC | PER_LOCATIONS | 8 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 7 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 2 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | HCM_POS | HR_ALL_POSITIONS_F | 2 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | HCM_GRADE | PER_GRADES_F | 2 | 0 | (none with prefix IRC_ — unmapped) |
| IRC | (DIRECT objects) | - | 14 | - | IRC_BC_CAND_RESULTS, IRC_CANDIDATES, IRC_COMM_CAMPAIGNS_V, IRC_EMP_COMMUNITIES_B, IRC_EMP_EVENTS_B, IRC_FOLLOWUP_TASKS, IRC_MANAGER_POSTS_V, IRC_OFFERS… |
| WLF | HCM_PERSON | PER_ALL_PEOPLE_F | 25 | 1 | WLF_REPORT_LEARNING_ASSIGNMENT_DATA (1 roles, iso) |
| WLF | HCM_JOB | PER_JOBS_F | 8 | 0 | (none with prefix WLF_ — unmapped) |
| WLF | HCM_ORG | HR_ALL_ORGANIZATION_UNITS_F | 8 | 0 | (none with prefix WLF_ — unmapped) |
| WLF | HCM_ASG | PER_ALL_ASSIGNMENTS_M | 6 | 0 | (none with prefix WLF_ — unmapped) |
| WLF | HCM_POS | HR_ALL_POSITIONS_F | 3 | 0 | (none with prefix WLF_ — unmapped) |
| WLF | HCM_LOC | PER_LOCATIONS | 3 | 0 | (none with prefix WLF_ — unmapped) |
| WLF | (DIRECT objects) | - | 14 | - | WLF_ASSIGNMENT_RECORDS_F, WLF_ASSIGNMENT_RECORDS_V, WLF_EVENTS, WLF_EVENT_ASSIGNMENTS_F, WLF_GRW_GUIDES_F, WLF_LEARNING_ITEMS_F, WLF_LEARNING_ITEMS_F_VL, WLF_LEARNING_PROGRAM_VL… |


### DIRECT objects — privileges per object (top-30 by corpus usage)

| object | type | usage | registered as | pk | privileges | isolation needed | customer sets | literal ids | view base tables |
|---|---|---|---|---|---|---|---|---|---|
| INV_ORG_PARAMETERS | TABLE | 2612 | INV_ORG_PARAMETERS | ORGANIZATION_ID | 51: INV_CONFFIGURE_INVENTORY_ATTRIBUTE_EXCEPTION_DATA, INV_CONFIGURE_ITEM_SHORTAGE_PARAMETER_DATA, INV_MANAGE_ABC_ASSIGNMENT_GROUP_DATA, INV_MANAGE_ABC_CLASS_DATA, INV_MANAGE_ABC_COMPILE_HEADER_DATA… | no | no | no | - |
| EGO_ITEM_EFF_B | TABLE | 2171 | EGO_ITEM_EFF_B | EFF_LINE_ID | 8: Edit KD EFF Attributes Priv, Edit KD PD Drawing Number, Edit KD PD Eng Information, ORA_HC_EFF_EDIT_PRIV, ORA_HC_EFF_VIEW_PRIV… | no | no | no | - |
| FND_VS_VALUES_VL | VIEW | 1749 | XXKD_COMPANY_SECURITY_RULE | VALUE_ID | 1: read | no | yes | no | FND_VS_VALUES_B, FND_VS_VALUES_TL |
| HZ_PARTIES | TABLE | 1695 | HZ_PARTIES | PARTY_ID | 21: HEY_CREATE_ADMISSIONS_APPLICATION_DATA, HEY_MANAGE_PERSON_PROFILE_DATA, HZ_MANAGE_TRADING_COMMUNITY_PERSON_SOCIAL_SECURITY_DATA, HZ_VIEW_ACCOUNT_DATA, HZ_VIEW_CONTACT_DATA… | yes | no | no | - |
| PER_USERS | TABLE | 1017 | PER_USERS | USER_ID | 8: PER_ASSIGN_USER_ROLES_DATA, PER_CREATE_USER_NAME_DATA, PER_EDIT_USER_NAME_DATA, PER_LINK_USER_ACCOUNT_DATA, PER_MANAGE_PERSON_ROLES_DETAILS_DATA… | yes | no | no | - |
| EGP_SYSTEM_ITEMS_B_V | VIEW | 950 | EGP_SYSTEM_ITEMS_B | INVENTORY_ITEM_ID,ORGANIZATION_ID | 31: EGO_CREATE_ITEM_CLASS_ITEM_DATA, EGO_MAINTAIN_ITEM_ASSET_MAINTENANCE_GROUP_DATA, EGO_MAINTAIN_ITEM_ATTRIBUTE_DATA, EGO_MAINTAIN_ITEM_BASIC_DATA, EGO_MAINTAIN_ITEM_COSTING_GROUP_DATA… | yes | no | no | EGP_ITEM_ORG_ASSOCIATIONS, EGP_SYSTEM_ITEMS_B |
| PER_ALL_ASSIGNMENTS_M | TABLE | 867 | PER_ALL_ASSIGNMENTS_M | ASSIGNMENT_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE,EFFECTIVE_LATEST_CHANGE,EFFECTIVE_SEQUENCE | 217: ANC_CHOOSE_ABSENCE_BUSINESS_TITLES_DATA, ANC_CHOOSE_ENROLLED_PLANS_DATA, ANC_CREATE_ACCRUAL_PLAN_ENROLLMENT_DATA, ANC_DISBURSE_ACCRUAL_PLAN_BALANCE_DATA, ANC_MAINTAIN_ABSENCE_RECORD_DATA… | yes | no | no | - |
| PER_ALL_PEOPLE_F | TABLE | 824 | PER_ALL_PEOPLE_F | PERSON_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 475: ANC_ADJUST_ACCRUAL_PLAN_BALANCE_DATA, ANC_CHOOSE_ABSENCE_AGREEMENTS_DATA, ANC_CHOOSE_ABSENCE_TYPES_DATA, ANC_CREATE_ACCRUAL_PLAN_ENROLLMENT_DATA, ANC_DISBURSE_ACCRUAL_PLAN_BALANCE_DATA… | yes | no | no | - |
| PER_PERSONS | TABLE | 600 | PER_PERSONS | PERSON_ID | 21: HRT_COMPARE_PUBLIC_SKILLS_DATA, HRT_VIEW_ENDORSEMENT_DATA, HRT_VIEW_HCM_PERSON_PUBLIC_NOTE_DATA, HRT_VIEW_PERSON_CAREER_PLANNING_DATA, HRT_VIEW_PERSON_SKILLS_AND_QUALIFICATIONS_DATA… | yes | no | no | - |
| HR_ALL_ORGANIZATION_UNITS_F | TABLE | 561 | HR_ALL_ORGANIZATION_UNITS_F | ORGANIZATION_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 19: HRX_FR_MANAGE_MONTHLY_DSN_DATA, IRC_CHOOSE_RECRUITING_ORGANIZATION_DATA, PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS, PAY_CHOOSE_PAYROLL_STATUTORY_UNIT_DATA, PAY_CHOOSE_TAX_REPORTING_UNIT_DATA… | yes | no | no | - |
| GL_LEDGERS | TABLE | 516 | GL_LEDGERS | LEDGER_ID | 9: GL_MANAGE_ACCOUNTING_PERIOD_STATUS_DATA, GL_MANAGE_JOURNALS_TAX_DATA, GL_REPORT_GENERAL_LEDGER_DATA, GL_VIEW_ACCOUNTING_PERIOD_STATUS_DATA, VRM_MANAGE_REVENUE_MANAGEMENT_DATA… | no | no | no | - |
| HRT_PROFILE_ITEMS | TABLE | 434 | HRT_PROFILE_ITEMS | PROFILE_ITEM_ID | 4: HRT_REPORT_TALENT_PROFILE_ITEM_DATA, HRT_VIEW_TALENT_PROFILE_ITEM_HR_DATA, HRT_VIEW_TALENT_PROFILE_ITEM_MANAGER_DATA, HRT_VIEW_TALENT_PROFILE_ITEM_WORKER_DATA | yes | no | no | - |
| FUN_ALL_BUSINESS_UNITS_V | VIEW | 430 | FUN_ALL_BUSINESS_UNITS_V | BU_ID | 192: AP_CREATE_PAYABLES_PAYMENT_REQUEST_DATA, AP_MANAGE_PAYABLES_DISTRIBUTION_SET_DATA, AP_MANAGE_PAYABLES_FINANCIALS_OPTION_DATA, AP_MANAGE_PAYABLES_INVOICE_DATA, AP_MANAGE_PAYABLES_SYSTEM_OPTION_DATA… | yes | no | no | HR_ALL_ORGANIZATION_UNITS_F_VL, HR_ORGANIZATION_INFORMATION_X, HR_ORG_UNIT_CLASSIFICATIONS_X |
| XLE_ENTITY_PROFILES | TABLE | 406 | XLE_ENTITY_PROFILES | LEGAL_ENTITY_ID | 6: CE_MANAGE_BANK_ACCOUNT_DATA, CE_MANAGE_PAYMENT_INSTRUMENT_DATA, CE_VIEW_PAYMENT_INSTRUMENT_DATA, delete, read… | no | no | no | - |
| HR_ORG_UNIT_CLASSIFICATIONS_F | TABLE | 387 | HR_ORG_UNIT_CLASSIFICATIONS_F | ORG_UNIT_CLASSIFICATION_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 19: HRX_FR_MANAGE_MONTHLY_DSN_DATA, IRC_CHOOSE_RECRUITING_ORGANIZATION_DATA, PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS, PAY_CHOOSE_PAYROLL_STATUTORY_UNIT_DATA, PAY_CHOOSE_TAX_REPORTING_UNIT_DATA… | yes | no | no | - |
| PER_PERSON_NAMES_F | TABLE | 380 | PER_PERSON_NAMES_F | PERSON_NAME_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 31: HRT_VIEW_TALENT_PROFILE_EXPQUAL_DATA, HRX_VIEW_US_END_OF_YEAR_1095C_FORM_DATA, PER_ADD_CONTINGENT_WORKER_DATA, PER_ADD_PENDING_WORKER_DATA, PER_ADD_PERSON_NONWORKER_DATA… | yes | no | no | - |
| PER_EMAIL_ADDRESSES | TABLE | 354 | PER_EMAIL_ADDRESSES | EMAIL_ADDRESS_ID | 35: HRT_VIEW_TALENT_PROFILE_EXPQUAL_DATA, HRX_VIEW_US_END_OF_YEAR_1095C_FORM_DATA, IRC_REPORT_PERSON_EMAIL_FOR_RECRUITING_DATA, IRC_VIEW_PERSON_EMAIL_FOR_RECRUITING_DATA, PER_ADD_CONTINGENT_WORKER_DATA… | yes | no | no | - |
| HZ_PARTY_SITES | TABLE | 349 | HZ_PARTY_SITES | PARTY_SITE_ID | 5: HZ_MANAGE_TRADING_COMMUNITY_PERSON_ADDRESS_DATA, HZ_VIEW_TRADING_COMMUNITY_PERSON_ADDRESS_DATA, delete, read, update | yes | no | no | - |
| HZ_CUST_ACCOUNTS | TABLE | 309 | HZ_CUST_ACCOUNTS | CUST_ACCOUNT_ID | 5: HZ_UPDATE_CUSTOMER_ACCOUNT_DATA, HZ_VIEW_CUSTOMER_ACCOUNT_DATA, delete, read, update | no | no | no | - |
| PO_HEADERS_ALL | TABLE | 295 | PO_HEADERS_ALL | PO_HEADER_ID | 4: AP_VIEW_AP_PO_DOC_TXN_DATA, PO_VIEW_PO_DOC_ANALYSIS_DATA, PO_VIEW_PO_DOC_TXN_DATA, read | no | no | no | - |
| PER_ADDRESSES_F | TABLE | 275 | PER_ADDRESSES_F | ADDRESS_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 35: HRT_VIEW_TALENT_PROFILE_EXPQUAL_DATA, HRX_VIEW_US_END_OF_YEAR_1095C_FORM_DATA, IRC_REPORT_PERSON_ADDRESS_FOR_RECRUITING_DATA, IRC_VIEW_PERSON_ADDRESS_FOR_RECRUITING_DATA, PER_ADD_CONTINGENT_WORKER_DATA… | yes | no | no | - |
| HR_ORGANIZATION_INFORMATION_F | TABLE | 273 | HR_ORGANIZATION_INFORMATION_F | ORG_INFORMATION_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 6: HRX_FR_MANAGE_MONTHLY_DSN_DATA, PAY_CHOOSE_PAYROLL_PROCESS_AND_REPORT_PARAMETERS, PAY_CHOOSE_PAYROLL_STATUTORY_UNIT_DATA, PAY_CHOOSE_TAX_REPORTING_UNIT_DATA, PER_CHOOSE_LEGAL_EMPLOYER_DATA… | yes | no | no | - |
| PER_PERIODS_OF_SERVICE | TABLE | 251 | PER_PERIODS_OF_SERVICE | PERIOD_OF_SERVICE_ID | 30: PER_AUDIT_WORK_RELATIONSHIP_DATA, PER_CANCEL_WORK_RELATIONSHIP_DATA, PER_CHANGE_WORKER_LEGAL_EMPLOYER_DATA, PER_CHANGE_WORKER_LOCATION_DATA, PER_CHANGE_WORKER_MANAGER_DATA… | yes | no | no | - |
| PER_LOCATION_DETAILS_F | TABLE | 248 | PER_LOCATION_DETAILS_F | LOCATION_DETAILS_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 8: PAY_MANAGE_LOCATION_COSTING_DATA, PAY_VIEW_LOCATION_COSTING_DATA, PER_AUDIT_LOCATION_DATA, PER_CHOOSE_LOCATION_DATA, PER_MANAGE_LOCATION_DATA… | yes | no | no | - |
| HRT_PROFILES_B | TABLE | 247 | HRT_PROFILES_B | PROFILE_ID | 21: HRT_ASSIGN_PUBLIC_SKILL_AS_HR_DATA, HRT_ASSIGN_PUBLIC_SKILL_AS_MANAGER_DATA, HRT_ASSIGN_PUBLIC_SKILL_AS_WORKER_DATA, HRT_COMPARE_TALENT_PROFILES_DATA, HRT_EDIT_PERSON_CAREER_PLANNING_DATA… | yes | no | no | - |
| SVC_SERVICE_REQUESTS | TABLE | 214 | SVC_SERVICE_REQUESTS | SR_ID | 7: SVC_DELETE_SR_HEADER_DATA, SVC_MANAGE_SR_HEADER_DATA, SVC_UPDATE_SR_HEADER_DATA, SVC_VIEW_SR_HEADER_DATA, delete… | no | no | no | - |
| PSC_LNP_RECORD | TABLE | 206 | PSC_LNP_RECORD | LNP_RECORD_KEY | 141: PSC_ACCESS_PREAPP_AI_AGENT_DATA, PSC_ACCESS_SANDBOXES_DATA, PSC_ADD_COMMENTS_TO_PERMITS_DATA, PSC_ADD_COMMENTS_TO_PERMIT_INTAKE_FORM_DATA, PSC_ADD_COMMENTS_TO_PERMIT_WORKFLOW_TASK_DATA… | yes | no | no | - |
| PER_ASSIGNMENT_SUPERVISORS_F | TABLE | 204 | PER_ASSIGNMENT_SUPERVISORS_F | ASSIGNMENT_SUPERVISOR_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 15: PER_AUDIT_WORKER_SUPERVISOR_DATA, PER_CHANGE_WORKER_LEGAL_EMPLOYER_DATA, PER_CHANGE_WORKER_LOCATION_DATA, PER_CHANGE_WORKER_MANAGER_DATA, PER_CHANGE_WORKER_WORKING_HOUR_DATA… | yes | no | no | - |
| PER_JOBS_F | TABLE | 191 | PER_JOBS_F | JOB_ID,EFFECTIVE_START_DATE,EFFECTIVE_END_DATE | 6: PER_AUDIT_HR_JOB_DATA, PER_CHOOSE_HR_JOB_DATA, PER_MANAGE_HR_JOB_DATA, PER_REPORT_HR_JOB_DATA, PER_VIEW_HR_JOB_DATA… | yes | no | no | - |
| PJF_PROJECTS_ALL_VL | VIEW | 186 | PJF_PROJECTS_ALL_VL | PROJECT_ID | 139: OKC_MANAGE_CONTRACT_DATA, PJB_MAINTAIN_PROJECT_CONTRACT_REVENUE_DATA, PJB_MANAGE_PROJECT_BILLING_EVENT_DATA, PJB_MANAGE_PROJECT_CONTRACT_INVOICE_DATA, PJB_VIEW_PROJECT_BILLING_EVENT_DATA… | yes | no | no | PJF_PROJECTS_ALL_B, PJF_PROJECTS_ALL_TL |


### VIA_PARENT — examples (top-20 by corpus usage)

| table | usage | join column | parent | parent class | source | NOT NULL | chain verdict | hops |
|---|---|---|---|---|---|---|---|---|
| ZCA_OBJECT_SHARE_VIEW | 314 | OBJECT_ID | SVC_SERVICE_REQUESTS.SR_ID | DIRECT | corpus_join (147 stmts, 100%) | yes | strict | 1 |
| POZ_SUPPLIERS | 301 | PARTY_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| JTF_RS_REP_MANAGERS | 296 | RESOURCE_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| ZCA_SALES_ACCOUNTS | 257 | PARTY_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| HZ_PERSON_PROFILES | 190 | PARTY_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| ZCA_S_ACCT_RESOURCES | 181 | RESOURCE_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| HZ_PARTY_USG_ASSIGNMENTS | 171 | PARTY_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| HZ_ORGANIZATION_PROFILES | 157 | PARTY_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| ZX_REP_TRX_JX_EXT_T | 124 | DETAIL_TAX_LINE_ID | ZX_REP_TRX_DETAIL_T.DETAIL_TAX_LINE_ID | VIA_JOIN | corpus_join (104 stmts, 95%) | no | leaky | 1 |
| PJF_OPEN_XFACE_REPORT | 123 | XFACE_REC_ID | PJF_PROJ_ELEMENTS_XFACE.PROJ_ELEMENT_XFACE_ID | VIA_JOIN | corpus_join (6 stmts, 67%) | no | leaky | 1 |
| HRA_EVAL_SECTIONS | 122 | EVALUATION_ID | HRA_EVALUATIONS.EVALUATION_ID | DIRECT | corpus_join (108 stmts, 95%) | no | leaky | 1 |
| HRA_EVAL_PARTICIPANTS | 111 | EVALUATION_ID | HRA_EVALUATIONS.EVALUATION_ID | DIRECT | corpus_join (87 stmts, 100%) | no | leaky | 1 |
| CE_BANK_ACCOUNTS | 103 | BANK_BRANCH_ID | HZ_PARTIES.PARTY_ID | DIRECT | fk | yes | strict | 1 |
| RCV_SHIPMENT_LINES | 102 | SHIPMENT_HEADER_ID | RCV_SHIPMENT_HEADERS.SHIPMENT_HEADER_ID | VIA_JOIN | fk | yes | leaky | 1 |
| HRQ_QSTNR_PARTICIPANTS | 93 | PARTICIPANT_ID | HRA_EVAL_PARTICIPANTS.EVAL_PARTICIPANT_ID | VIA_PARENT | corpus_join (5 stmts, 83%) | no | leaky | 1 |
| XLE_REGISTRATIONS | 90 | SOURCE_ID | XLE_ENTITY_PROFILES.LEGAL_ENTITY_ID | DIRECT | corpus_join (51 stmts, 61%) | no | leaky | 1 |
| HRA_EVAL_RATINGS | 87 | EVAL_PARTICIPANT_ID | HRA_EVAL_PARTICIPANTS.EVAL_PARTICIPANT_ID | VIA_PARENT | corpus_join (86 stmts, 60%) | no | leaky | 1 |
| JTF_RS_ROLE_RELATIONS | 87 | ROLE_RESOURCE_ID | JTF_RS_GROUP_MEMBERS.GROUP_MEMBER_ID | VIA_PARENT | corpus_join (50 stmts, 100%) | yes | strict | 1 |
| PJO_PLANNING_OPTIONS | 87 | PLAN_VERSION_ID | PJO_PLAN_VERSIONS_B.PLAN_VERSION_ID | DIRECT | corpus_join (71 stmts, 99%) | yes | strict | 1 |
| EGP_CATEGORY_SET_VALID_CATS | 84 | CATEGORY_ID | EGP_CATEGORIES_B.CATEGORY_ID | DIRECT | fk | yes | strict | 1 |


### HCM — totals per class (hcm=Y: HCM-prefixed objects, classified like everything else)

| class | objects | TABLE | VIEW | corpus-used (>=1 statement) |
|---|---|---|---|---|
| DIRECT | 337 | 320 | 17 | 252 |
| VIA_JOIN | 1050 | 561 | 489 | 421 |
| VIA_PARENT | 134 | 107 | 27 | 117 |
| REGISTERED_NO_GRANT | 0 | 0 | 0 | 0 |
| DISALLOWED | 0 | 0 | 0 | 0 |
| UNSECURABLE | 4059 | 3226 | 833 | 1599 |
| TOTAL | 5580 | 4214 | 1366 | 2389 |


### HCM — anchors (context column -> registered object; Report privilege; Oracle's secured list view)

| context column | anchor | class | usage | grant kinds (links) | report privilege | report-privilege links (kinds) / roles | secured list view | in dictionary | lineage = anchor | secured-list corpus usage | VIA_JOIN columns (primary tables) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PERSON_ID | PER_ALL_PEOPLE_F | DIRECT | 824 | {"GLOBAL": 219, "SET_closed": 465, "SET_cond": 30} | PER_REPORT_PERSON_DATA | {"GLOBAL": 1, "SET_closed": 1} / 50 | PER_PERSON_SECURED_LIST_V | yes | yes | 21 | 529 (529) |
| ASSIGNMENT_ID | PER_ALL_ASSIGNMENTS_M | DIRECT | 867 | {"SET_closed": 216, "GLOBAL": 156, "SET_cond": 4} | PER_REPORT_ASSIGNMENT_DATA | {"GLOBAL": 1, "SET_closed": 1} / 15 | PER_ASSIGNMENT_SECURED_LIST_V | yes | yes | 10 | 230 (36) |
| PAYROLL_RELATIONSHIP_ID | PAY_PAY_RELATIONSHIPS_DN | DIRECT | 145 | {"SET_closed": 45, "GLOBAL": 15} | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA | {"GLOBAL": 1, "SET_closed": 1} / 16 | - | - | - | 0 | 38 (19) |
| PERIOD_OF_SERVICE_ID | PER_PERIODS_OF_SERVICE | DIRECT | 251 | {"SET_closed": 29, "GLOBAL": 27} | PER_REPORT_WORK_RELATIONSHIP_DATA | {"GLOBAL": 1, "SET_closed": 1} / 3 | - | - | - | 0 | 15 (0) |
| ORGANIZATION_ID | HR_ALL_ORGANIZATION_UNITS_F | DIRECT | 561 | {"SET_closed": 19, "GLOBAL": 18} | PER_REPORT_DEPARTMENT_DATA | {"GLOBAL": 1, "SET_closed": 1} / 47 | PER_DEPARTMENT_SECURED_LIST_V | yes | yes | 0 | 116 (75) |
| POSITION_ID | HR_ALL_POSITIONS_F | DIRECT | 122 | {"GLOBAL": 7, "SET_closed": 7} | PER_REPORT_POSITION_DATA | {"GLOBAL": 1, "SET_closed": 1} / 49 | PER_POSITION_SECURED_LIST_V | yes | yes | 0 | 66 (31) |
| LEGISLATIVE_DATA_GROUP_ID | PER_LEGISLATIVE_DATA_GROUPS | DIRECT | 88 | {"GLOBAL": 5, "SET_closed": 5} | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA | {"GLOBAL": 1, "SET_closed": 1} / 21 | PER_LDG_SECURED_LIST_V | yes | yes | 0 | 272 (233) |
| PAYROLL_ID | PAY_ALL_PAYROLLS_F | DIRECT | 85 | {"GLOBAL": 5, "SET_closed": 5} | PAY_REPORT_PAYROLL_DEFINITION_DATA | {"GLOBAL": 1, "SET_closed": 1} / 20 | PAY_PAYROLL_SECURED_LIST_V | yes | yes | 0 | 54 (11) |
| JOB_ID | PER_JOBS_F | DIRECT | 191 | {"GLOBAL": 6, "SET_closed": 2} | PER_REPORT_HR_JOB_DATA | {"GLOBAL": 1} / 47 | PER_JOB_SECURED_LIST_V | yes | yes | 0 | 115 (50) |
| GRADE_ID | PER_GRADES_F | DIRECT | 65 | {"GLOBAL": 5, "SET_closed": 2} | PER_REPORT_ASSIGNMENT_GRADE_DATA | {"GLOBAL": 1} / 44 | PER_GRADE_SECURED_LIST_V | yes | yes | 0 | 47 (15) |
| LOCATION_ID | PER_LOCATIONS | DIRECT | 141 | {"GLOBAL": 8, "SET_closed": 3} | PER_REPORT_LOCATION_DATA | {"GLOBAL": 1} / 47 | PER_LOCATION_SECURED_LIST_V | yes | yes | 0 | 105 (41) |
| FLOW_ID | PAY_FLOWS | DIRECT | 10 | {"SET_closed": 6, "GLOBAL": 5, "SET_cond": 1} | PAY_REPORT_PAYROLL_FLOW_DATA | {"GLOBAL": 1, "SET_closed": 1} / 12 | PAY_FLOWS_SECURED_LIST_V | yes | yes | 0 | 14 (10) |


### HCM — DIRECT objects by grant mix (kinds of the object's active grant links)

| grant mix | objects | corpus-used | examples (top usage) |
|---|---|---|---|
| GLOBAL+SET_closed | 239 | 177 | PER_PERSONS, HR_ALL_ORGANIZATION_UNITS_F, HRT_PROFILE_ITEMS, HR_ORG_UNIT_CLASSIFICATIONS_F, PER_PERSON_NAMES_F, HR_ORGANIZATION_INFORMATION_F |
| SET_closed | 41 | 28 | HRT_CONTENT_TYPES_B, IRC_CANDIDATES, WLF_EVENTS, WLF_LI_CONTENT_F, WLF_RESOURCES_B, WLF_LEARNING_ITEMS_F_VL |
| GLOBAL+SET_closed+SET_cond | 27 | 27 | PER_USERS, PER_ALL_ASSIGNMENTS_M, PER_ALL_PEOPLE_F, PER_EMAIL_ADDRESSES, PER_ADDRESSES_F, HRT_PROFILES_B |
| GLOBAL+SET_cond | 12 | 5 | IRC_REC_EVENTS_B, HEY_TAG_ASSIGNMENT, HEY_TAG_B, IRC_EMP_COMMUNITIES_B, IRC_EMP_EVENTS_B, HEY_PERSON_TEST |
| GLOBAL | 12 | 12 | PER_GRADE_LADDERS_F, PER_RATE_VALUES_F, PAY_ACTION_INFORMATION, PER_RATES_F, HRQ_SUBSCRIBERS_B, IRC_REGULATORY_RESPONSES |
| SET_cond | 3 | 1 | BEN_ELIG_RSLT_F, IRC_FOLLOWUP_TASKS, IRC_MANAGER_POSTS_V |
| SET_closed+SET_cond | 1 | 0 | HRT_NOTES_V |
| GLOBAL+SET_cond+SET_open | 1 | 1 | IRC_SUBMISSIONS |
| GLOBAL+SET_closed+SET_cond+SET_open | 1 | 1 | WLF_LEARNING_ITEMS_F |


### HCM — linked seed conditions by template (instance sets in an active grant on HCM objects)

| sets | objects | family | example set | shape | emission | references | template |
|---|---|---|---|---|---|---|---|
| 313 | 312 | placeholder_S+seed_condition | ANCABSENCETYPESF_S | constant_false | isolated_required |  | $N = $N |
| 11 | 5 | seed_condition | HRCARMPROCESSB_SCM | plain_column_filter | as_is |  | &TABLE_ALIAS.$COL='$S' |
| 6 | 1 | seed_condition | BENELIGRSLTF_EHW | plain_column_filter | isolated_required |  | ELIG_OBJ_TYPE='$S' |
| 6 | 6 | profile_compiled+seed_condition | HRCARMPROCESSB_PRJ | plain_column_filter | as_is |  | &TABLE_ALIAS.$COL = '$S' |
| 6 | 6 | seed_condition | HRTPROFILESB_VIEWOWNRECORD_ERPSS | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID | (&TABLE_ALIAS.$COL = (SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) FROM DUAL)) |
| 6 | 3 | seed_condition | PERADDRESSES_R | session_util | as_is | FND_PROFILE.VALUE, IRC_CANDIDATES, IRC_TREAT_CWK_AS_EXTERNAL, PER_PERSON_ADDR_USAGES_F, PER_PERSON_TYPE_USAGES_M | (EXISTS (SELECT $N FROM PER_PERSON_ADDR_USAGES_F PADDU, IRC_CANDIDATES CAND WHERE PADDU.ADDRESS_ID=&TABLE_ALIAS.$COL AND PADDU.PERSON_ID= CAND.PERSON_ID AND NOT EXISTS (SELECT $N FROM FUSION.PER_PERSON_TYPE_USAGES_M PTU WHERE PTU.PERSON_ID=PADDU.PERSON_ID AND  |
| 3 | 3 | seed_condition | IRCCOMMCAMPAIGNSV_S | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_TEAM_MEMBERS | EXISTS (SELECT $N FROM IRC_TEAM_MEMBERS TM WHERE TM.OBJECT_ID = &TABLE_ALIAS.$COL AND TM.OBJECT_TYPE = '$S' AND TM.PERSON_ID = (SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) FROM DUAL)) |
| 2 | 1 | seed_condition | BENELIGRSLTF_EMPCOMM | plain_column_filter | isolated_required |  | ELIG_OBJ_TYPE ='$S' |
| 2 | 2 | seed_condition | HEYPERSONTESTHEY82 | session_util | as_is | HZ_SESSION_UTIL.GET_USER_PARTYID | &TABLE_ALIAS.$COL = (SELECT FUSION.HZ_SESSION_UTIL.GET_USER_PARTYID FROM DUAL) |
| 2 | 2 | seed_condition | HEYTAGASSIGNMENTHEY67 | session_util | as_is | FND_GLOBAL.USER_NAME | &TABLE_ALIAS.$COL = FND_GLOBAL.USER_NAME |
| 2 | 2 | seed_condition | HEY_TAG_ASSIGNMENT_1 | session_util | isolated_required | FND_GLOBAL.USER_GUID, HEY_DATA_SECURITY_PROFILE_B, HEY_DSP_CONDITION_VALUE, HEY_DSP_DATA_CONDITION, HEY_DSP_DATA_PRIVILEGE_GRANT, HEY_DSP_ROLE_ASSIGNMENT | (EXISTS (SELECT $N FROM HEY_DATA_SECURITY_PROFILE_B PRO, HEY_DSP_ROLE_ASSIGNMENT ASM, HEY_DSP_DATA_CONDITION CON, HEY_DSP_CONDITION_VALUE VAL, HEY_DSP_DATA_PRIVILEGE_GRANT PRI WHERE PRO.INSTANCE_SET_ID = &GRANT_ALIAS.INSTANCE_SET_ID AND PRO.PROFILE_ID = ASM.PR |
| 2 | 2 | seed_condition | HRC_DL_DS_SELF_INST | session_util | as_is | FND_GLOBAL.USER_NAME | ( &TABLE_ALIAS.$COL = FND_GLOBAL.USER_NAME AND &TABLE_ALIAS.$COL = '$S' ) |
| 2 | 2 | seed_condition | PERALLPEOPLEF_R | session_util | as_is | FND_PROFILE.VALUE, IRC_CANDIDATES, IRC_TREAT_CWK_AS_EXTERNAL, PER_PERSON_TYPE_USAGES_M | (EXISTS (SELECT $N FROM IRC_CANDIDATES CAND WHERE CAND.PERSON_ID=&TABLE_ALIAS.$COL) AND NOT EXISTS (SELECT $N FROM PER_PERSON_TYPE_USAGES_M PTU WHERE PTU.PERSON_ID=&TABLE_ALIAS.$COL AND (PTU.SYSTEM_PERSON_TYPE ='$S' OR (PTU.SYSTEM_PERSON_TYPE='$S' AND NVL(FND_ |
| 2 | 1 | seed_condition | PER_MANAGE_PERSONAL_JOURNEYS_INST | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID | &TABLE_ALIAS.$COL = '$S' AND &TABLE_ALIAS.$COL = NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) |
| 2 | 2 | seed_condition | PEREMAILADDRESSES_EXTCAN | session_util | as_is | FND_PROFILE.VALUE, IRC_CANDIDATES, IRC_TREAT_CWK_AS_EXTERNAL, PER_PERSON_TYPE_USAGES_M | ((EXISTS (SELECT $N FROM IRC_CANDIDATES CAND WHERE CAND.PERSON_ID=&TABLE_ALIAS.$COL) AND NOT EXISTS (SELECT $N FROM PER_PERSON_TYPE_USAGES_M PTU WHERE PTU.PERSON_ID=&TABLE_ALIAS.$COL AND (PTU.SYSTEM_PERSON_TYPE = '$S' OR (PTU.SYSTEM_PERSON_TYPE='$S' AND NVL(FN |
| 1 | 1 | seed_condition | HEYPERSONTESTSCOREHEY83 | session_util | as_is | HEY_PERSON_TEST, HZ_SESSION_UTIL.GET_USER_PARTYID | &TABLE_ALIAS.$COL IN (SELECT PERSON_TEST_ID FROM HEY_PERSON_TEST PT WHERE PT.PARTY_ID = (SELECT FUSION.HZ_SESSION_UTIL.GET_USER_PARTYID FROM DUAL)) |
| 1 | 1 | seed_condition | HEYPROXYGROUPHEY60 | session_util | as_is | HEY_PROXY_GROUP_MEMBER, HZ_SESSION_UTIL.GET_USER_PARTYID | ( EXISTS ( SELECT $N FROM HEY_PROXY_GROUP_MEMBER PROXYGROUPMEMBER WHERE ( PROXYGROUPMEMBER.MEMBER_PARTY_ID = (SELECT FUSION.HZ_SESSION_UTIL.GET_USER_PARTYID FROM DUAL)) AND ( &TABLE_ALIAS.$COL = PROXYGROUPMEMBER.PROXY_GROUP_ID ) AND PROXYGROUPMEMBER.MEMBER_TYP |
| 1 | 1 | seed_condition | HEYTAGASSIGNMENTHEY68 | session_util | as_is | HEY_TAG_B, HZ_SESSION_UTIL.GET_USER_PARTYID | &TABLE_ALIAS.$COL = (SELECT FUSION.HZ_SESSION_UTIL.GET_USER_PARTYID FROM DUAL) AND &TABLE_ALIAS.$COL = '$S' AND EXISTS (SELECT $N FROM HEY_TAG_B T WHERE T.TAG_ID = &TABLE_ALIAS.$COL AND T.TAG_TYPE_CODE = '$S' ) |
| 1 | 1 | seed_condition | HRC_DL_LAYOUT_MANAGE_SELF_INST | session_util | as_is | FND_GLOBAL.USER_NAME | &TABLE_ALIAS.$COL = FND_GLOBAL.USER_NAME AND STATUS = '$S' |
| 1 | 1 | profile_compiled | HCM_TAL_<id> | exists_other_object | as_is | HRT_POOLS_B | EXISTS(SELECT $N FROM HRT_POOLS_B P WHERE &TABLE_ALIAS.$COL = P.POOL_ID AND P.POOL_TYPE_CODE = '$S' AND (P.PRIVATE_FLAG IS NOT NULL AND P.PRIVATE_FLAG = '$S') ) |
| 1 | 1 | profile_compiled | HCM_TAL_<id> | session_util | as_is | FND_GLOBAL.USER_GUID, HRT_POOLS_B, HRT_POOL_OWNERS, PER_USERS | EXISTS (SELECT $N FROM HRT_POOLS_B P, HRT_POOL_OWNERS O WHERE P.POOL_ID = &TABLE_ALIAS.$COL AND P.POOL_ID = O.POOL_ID AND O.OWNER_PERSON_ID = (SELECT U.PERSON_ID FROM PER_USERS U WHERE U.USER_GUID=FND_GLOBAL.USER_GUID )) |
| 1 | 1 | seed_condition | HRTNOTESV_H | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, PER_ASSIGNMENT_SUPERVISORS_F | (EXISTS ( SELECT $N FROM PER_ASSIGNMENT_SUPERVISORS_F MH WHERE MH.MANAGER_ID = (SELECT MANAGER_ID FROM PER_ASSIGNMENT_SUPERVISORS_F P WHERE P.PERSON_ID = &TABLE_ALIAS.$COL AND TRUNC(SYSDATE) BETWEEN P.EFFECTIVE_START_DATE AND P.EFFECTIVE_END_DATE AND MANAGER_T |
| 1 | 1 | seed_condition | HRGENAIAGENTSB_FAMILY | grant_parameter | as_is |  | &TABLE_ALIAS.$COL = &GRANT_ALIAS.PARAMETER1 |
| 1 | 1 | seed_condition | HRGENAITOOLSB_FAMILY | grant_parameter | as_is |  | &TABLE_ALIAS.$COL IN (&GRANT_ALIAS.PARAMETER1, '$S') |
| 1 | 1 | seed_condition | IRCEMPCOMMUNITIESB_PUBINV | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_EMP_CMTY_MEMBERS | EXISTS (SELECT $N FROM DUAL WHERE (&TABLE_ALIAS.$COL = '$S' AND &TABLE_ALIAS.$COL = '$S') OR EXISTS (SELECT $N FROM IRC_EMP_CMTY_MEMBERS TM WHERE &TABLE_ALIAS.$COL = TM.EMP_COMMUNITY_ID AND TM.MEMBER_TYPE_CODE IN ('$S', '$S') AND TM.MEMBER_PERSON_ID = NVL(HRC_ |
| 1 | 1 | seed_condition | IRCEMPCOMMUNITIESB_S | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_EMP_CMTY_MEMBERS | EXISTS (( SELECT $N FROM IRC_EMP_CMTY_MEMBERS TM WHERE TM.MEMBER_PERSON_ID = NVL(HRC_SESSION_UTIL.GET_USER_PERSONID, -$N) AND TM.MEMBER_TYPE_CODE IN ('$S', '$S') AND &TABLE_ALIAS.$COL = TM.EMP_COMMUNITY_ID)) |
| 1 | 1 | seed_condition | IRCEMPEVENTSB_S | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_EMP_EVENTS_OWNERS | EXISTS (SELECT $N FROM IRC_EMP_EVENTS_OWNERS TM WHERE TM.EMP_EVENT_ID = &TABLE_ALIAS.$COL AND TM.OWNER_PERSON_ID = (SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) FROM DUAL)) |
| 1 | 1 | seed_condition | IRCFOLLOWUPTASKS_S | session_util | as_is | FND_GLOBAL.USER_GUID, IRC_TEAM_MEMBERS, PER_USERS | EXISTS (SELECT $N FROM IRC_TEAM_MEMBERS M WHERE M.OBJECT_ID = &TABLE_ALIAS.$COL AND M.OBJECT_TYPE LIKE '$S' AND M.PERSON_ID = (SELECT U.PERSON_ID FROM PER_USERS U WHERE U.USER_GUID=FND_GLOBAL.USER_GUID)) |
| 1 | 1 | seed_condition | IRCMANAGERPOSTSV_S | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_TEAM_MEMBERS | EXISTS (SELECT $N FROM IRC_TEAM_MEMBERS TM WHERE TM.OBJECT_ID = &TABLE_ALIAS.$COL AND TM.OBJECT_TYPE = '$S' AND TM.MEMBER_TYPE_CODE = '$S' AND TM.PERSON_ID = (SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) FROM DUAL)) |
| 1 | 1 | seed_condition | IRCOFFERS_MYHIERARCHY | session_util | as_is | HRC_SESSION_UTIL.GET_USER_PERSONID, IRC_TEAM_MEMBERS, PER_MANAGER_HRCHY_DN | EXISTS (SELECT $N FROM IRC_TEAM_MEMBERS M WHERE &TABLE_ALIAS.$COL = M.OBJECT_ID AND M.OBJECT_TYPE LIKE '$S' AND M.PERSON_ID IN((SELECT MANAGERHIERARCHY.PERSON_ID FROM PER_MANAGER_HRCHY_DN MANAGERHIERARCHY WHERE MANAGERHIERARCHY.MANAGER_ID = (SELECT HRC_SESSION |


### HCM — profile-compiled sets (HcmSecurityProfilesUI) by profile type

| profile type (HCM_<type>_<id>) | sets | objects | non-HCM-prefix objects | linked | active | templates | constant 1=1 | literal ids | profiles (set descriptions) | dominant template |
|---|---|---|---|---|---|---|---|---|---|---|
| PER | 631 | 91 | 19 | 1 | 1 | 22 | 94 | 0 | View All People; View All Workers; View All Workers:1; View Manager Hierarchy; View Manager Hierarchy:1; View Own Record; View Own Record:1 | EXISTS ((SELECT $N FROM PER_PERSONS P WHERE P.PERSON_ID=&TABLE_ALIAS.$COL AND ( P.PERSON_ID=(SELECT NVL(HRC_SESSION_UTIL.GET_USER_PERSONID,-$N) FROM DUAL) )) UNION ALL SELECT $N FROM PER_CONTACT_RELSH |
| LDG | 114 | 114 | 12 | 0 | 0 | 1 | 114 | 0 | View All Legislative Data Groups | $N=$N |
| PRL | 18 | 18 | 3 | 0 | 0 | 1 | 18 | 0 | View All Payrolls | $N=$N |
| FLP | 6 | 6 | 0 | 0 | 0 | 1 | 6 | 0 | View All Flows | $N=$N |
| ORG | 5 | 4 | 0 | 0 | 0 | 1 | 5 | 0 | View All Organizations; View All Organizations:1 | $N=$N |
| TAL | 3 | 1 | 1 | 2 | 2 | 3 | 1 | 0 | View All Public Talent Pools; View All Talent Pools; View By Ownership | $N = $N |
| DOR | 3 | 3 | 0 | 0 | 0 | 1 | 3 | 0 | View All Document Types | $N=$N |
| ORA_TXN | 2 | 1 | 0 | 0 | 0 | 2 | 1 | 1 | View All HCM Transactions; View All Transactions | EXISTS (SELECT $N FROM HRC_ARM_PROCESS_B ARM WHERE ARM.PROCESS_ID=&TABLE_ALIAS.$COL AND (FAMILY IN (SELECT FAMILY FROM HRC_TXN_SEC_PROF_ENTRY ENTRY WHERE ENTRY.FAMILY = ARM.FAMILY AND CATEGORY_CODE IS |
| POS | 2 | 2 | 0 | 0 | 0 | 1 | 2 | 0 | View All Positions | $N=$N |
| REQ | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | View All Job Requisitions; View My Team's Requisitions | ( EXISTS (SELECT $N FROM IRC_TEAM_MEMBERS M WHERE &TABLE_ALIAS.$COL = M.OBJECT_ID AND M.OBJECT_TYPE = '$S' AND M.PERSON_ID IN (SELECT HRC_SESSION_UTIL.GET_USER_PERSONID FROM DUAL) ) OR EXISTS (SELECT  |
| ELE | 2 | 2 | 0 | 0 | 0 | 1 | 2 | 0 | View All Elements | $N=$N |
| CNT | 1 | 1 | 1 | 0 | 0 | 1 | 1 | 0 | View All Countries | $N=$N |
| CND | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | View All Candidates | &TABLE_ALIAS.$COL = '$S' |


### HCM — VIA_JOIN tables (top-40 by corpus usage)

| table | type | usage | HCM context columns [verdict] | primary anchor | secured list view | report privilege (links) | report candidates |
|---|---|---|---|---|---|---|---|
| PER_PERSON_NAMES_F_V | VIEW | 1603 | PERSON_ID [strict] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 10 |
| HR_ORGANIZATION_UNITS_F_TL | TABLE | 768 | ORGANIZATION_ID [strict] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| HRT_PROFILES_VL | VIEW | 245 | PERSON_ID [leaky] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 23 |
| PER_JOBS_F_TL | TABLE | 242 | JOB_ID [strict] | PER_JOBS_F | PER_JOB_SECURED_LIST_V | PER_REPORT_HR_JOB_DATA {"GLOBAL": 1} | 1 |
| PER_LOCATION_DETAILS_F_VL | VIEW | 188 | LOCATION_ID [strict] | PER_LOCATIONS | PER_LOCATION_SECURED_LIST_V | PER_REPORT_LOCATION_DATA {"GLOBAL": 1} | 1 |
| HR_ALL_ORGANIZATION_UNITS_F_VL | VIEW | 175 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| PER_JOBS_F_VL | VIEW | 148 | JOB_ID [strict] | PER_JOBS_F | PER_JOB_SECURED_LIST_V | PER_REPORT_HR_JOB_DATA {"GLOBAL": 1} | 1 |
| PER_GRADES_F_TL | TABLE | 139 | GRADE_ID [strict] | PER_GRADES_F | PER_GRADE_SECURED_LIST_V | PER_REPORT_ASSIGNMENT_GRADE_DATA {"GLOBAL": 1} | 1 |
| HR_LOCATIONS_ALL_F_VL | VIEW | 138 | LOCATION_ID [strict] | PER_LOCATIONS | PER_LOCATION_SECURED_LIST_V | PER_REPORT_LOCATION_DATA {"GLOBAL": 1} | 1 |
| PER_MANAGER_HRCHY_DN | TABLE | 130 | PERSON_ID [leaky]; ASSIGNMENT_ID [leaky] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 10 |
| HR_ORGANIZATION_V | VIEW | 123 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| HR_ALL_POSITIONS_F_TL | TABLE | 122 | POSITION_ID [strict] | HR_ALL_POSITIONS_F | PER_POSITION_SECURED_LIST_V | PER_REPORT_POSITION_DATA {"GLOBAL": 1, "SET_closed": 1} | 1 |
| PER_LEGISLATIVE_DATA_GROUPS_VL | VIEW | 114 | LEGISLATIVE_DATA_GROUP_ID [strict] | PER_LEGISLATIVE_DATA_GROUPS | PER_LDG_SECURED_LIST_V | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA {"GLOBAL": 1, "SET_closed": 1} | 1 |
| PAY_PAYROLL_REL_ACTIONS | TABLE | 104 | PAYROLL_RELATIONSHIP_ID [strict] | PAY_PAY_RELATIONSHIPS_DN | - | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA {"GLOBAL": 1, "SET_closed": 1} | 3 |
| PER_ACTION_OCCURRENCES | TABLE | 94 | POSITION_ID [leaky] | HR_ALL_POSITIONS_F | PER_POSITION_SECURED_LIST_V | PER_REPORT_POSITION_DATA {"GLOBAL": 1, "SET_closed": 1} | 1 |
| HR_ALL_ORGANIZATION_UNITS_TL | VIEW | 86 | ORGANIZATION_ID [strict] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| PER_ALL_ASSIGNMENTS_F | VIEW | 86 | PERSON_ID [strict]; ASSIGNMENT_ID [strict]; PERIOD_OF_SERVICE_ID [leaky]; ORGANIZATION_ID [leaky]; POSITION_ID [leaky]; JOB_ID [leaky]; GRADE_ID [leaky]; LOCATION_ID [leaky] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 10 |
| PER_DEPARTMENTS | VIEW | 83 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| PAY_REQUESTS | TABLE | 75 | LEGISLATIVE_DATA_GROUP_ID [leaky] | PER_LEGISLATIVE_DATA_GROUPS | PER_LDG_SECURED_LIST_V | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| HR_ALL_POSITIONS_F_VL | VIEW | 73 | ORGANIZATION_ID [strict]; POSITION_ID [strict]; JOB_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| HRG_GOAL_PLAN_GOALS | TABLE | 71 | ASSIGNMENT_ID [leaky] | PER_ALL_ASSIGNMENTS_M | PER_ASSIGNMENT_SECURED_LIST_V | PER_REPORT_ASSIGNMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 1 |
| PER_DISPLAY_PHONES_V | VIEW | 68 | PERSON_ID [strict] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 10 |
| PAY_ELEMENT_TYPES_VL | VIEW | 66 | LEGISLATIVE_DATA_GROUP_ID [leaky] | PER_LEGISLATIVE_DATA_GROUPS | PER_LDG_SECURED_LIST_V | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| WLF_LI_CLASSES_F | TABLE | 59 | LOCATION_ID [leaky] | PER_LOCATIONS | PER_LOCATION_SECURED_LIST_V | PER_REPORT_LOCATION_DATA {"GLOBAL": 1} | 0 |
| PER_GRADES_F_VL | VIEW | 58 | GRADE_ID [strict] | PER_GRADES_F | PER_GRADE_SECURED_LIST_V | PER_REPORT_ASSIGNMENT_GRADE_DATA {"GLOBAL": 1} | 1 |
| IRC_TEAM_MEMBERS | TABLE | 42 | PERSON_ID [strict]; ASSIGNMENT_ID [strict] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 3 |
| PAY_ELE_CLASSIFICATIONS_VL | VIEW | 42 | LEGISLATIVE_DATA_GROUP_ID [leaky] | PER_LEGISLATIVE_DATA_GROUPS | PER_LDG_SECURED_LIST_V | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| HR_ALL_ORGANIZATION_UNITS | VIEW | 41 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| CMP_CWB_PERSON_INFO_V | VIEW | 39 | PERSON_ID [strict]; ASSIGNMENT_ID [strict]; ORGANIZATION_ID [leaky]; POSITION_ID [leaky]; PAYROLL_ID [leaky]; JOB_ID [leaky]; GRADE_ID [leaky]; LOCATION_ID [leaky] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| HR_ALL_ORGANIZATION_UNITS_VL | VIEW | 39 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| HR_LOCATIONS | VIEW | 39 | LOCATION_ID [strict] | PER_LOCATIONS | PER_LOCATION_SECURED_LIST_V | PER_REPORT_LOCATION_DATA {"GLOBAL": 1} | 1 |
| PER_GRADE_STEPS_F | TABLE | 39 | GRADE_ID [strict] | PER_GRADES_F | PER_GRADE_SECURED_LIST_V | PER_REPORT_ASSIGNMENT_GRADE_DATA {"GLOBAL": 1} | 1 |
| PAY_OBJECT_ACTIONS | TABLE | 38 | PAYROLL_RELATIONSHIP_ID [leaky] | PAY_PAY_RELATIONSHIPS_DN | - | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA {"GLOBAL": 1, "SET_closed": 1} | 3 |
| CMP_SALARY_BASES_VL | VIEW | 37 | LEGISLATIVE_DATA_GROUP_ID [leaky] | PER_LEGISLATIVE_DATA_GROUPS | PER_LDG_SECURED_LIST_V | PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| PAY_FILE_DETAILS | TABLE | 35 | PERSON_ID [leaky] | PER_ALL_PEOPLE_F | PER_PERSON_SECURED_LIST_V | PER_REPORT_PERSON_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| HR_ORGANIZATION_UNITS | VIEW | 33 | ORGANIZATION_ID [strict]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 2 |
| PER_VALID_GRADES_F | TABLE | 33 | POSITION_ID [leaky]; JOB_ID [leaky]; GRADE_ID [strict] | HR_ALL_POSITIONS_F | PER_POSITION_SECURED_LIST_V | PER_REPORT_POSITION_DATA {"GLOBAL": 1, "SET_closed": 1} | 1 |
| PER_LOCATION_LEG_F | TABLE | 32 | LOCATION_ID [strict] | PER_LOCATIONS | PER_LOCATION_SECURED_LIST_V | PER_REPORT_LOCATION_DATA {"GLOBAL": 1} | 1 |
| IRC_REQUISITIONS_VL | VIEW | 31 | ORGANIZATION_ID [leaky]; POSITION_ID [leaky]; JOB_ID [leaky]; GRADE_ID [leaky]; LOCATION_ID [leaky] | HR_ALL_ORGANIZATION_UNITS_F | PER_DEPARTMENT_SECURED_LIST_V | PER_REPORT_DEPARTMENT_DATA {"GLOBAL": 1, "SET_closed": 1} | 0 |
| PAY_ENTRY_USAGES | TABLE | 31 | PAYROLL_RELATIONSHIP_ID [strict] | PAY_PAY_RELATIONSHIPS_DN | - | PAY_REPORT_PAYROLL_RELATIONSHIP_DATA {"GLOBAL": 1, "SET_closed": 1} | 3 |


### HCM — the rest (top-30 corpus-used VIA_PARENT / UNSECURABLE / REGISTERED_NO_GRANT)

| table | type | usage | class | evidence |
|---|---|---|---|---|
| HCM_LOOKUPS | VIEW | 1750 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_LOCATION_DETAILS_F_TL | TABLE | 256 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_TYPES_VL | VIEW | 191 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_VL | VIEW | 169 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HR_LOOKUPS | VIEW | 160 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_TL | TABLE | 151 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_VL | VIEW | 140 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_B | TABLE | 132 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_TYP_SECTIONS_VL | VIEW | 132 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| WLF_LEARNING_ITEMS_F_TL | TABLE | 106 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTNR_PARTICIPANTS | TABLE | 93 | VIA_PARENT | PARTICIPANT_ID -> HRA_EVAL_PARTICIPANTS.EVAL_PARTICIPANT_ID via corpus_join [leaky; chain leaky; hops 1] |
| HRT_CONTENT_TYPES_TL | TABLE | 92 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_B | TABLE | 92 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_TL | TABLE | 87 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRC_TXN_DATA | TABLE | 78 | VIA_PARENT | TRANSACTION_ID -> HRC_TXN_HEADER.TRANSACTION_ID via corpus_join [strict; chain strict; hops 1] |
| HRQ_QSTNR_RESPONSES | TABLE | 77 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILES_TL | TABLE | 74 | VIA_PARENT | PROFILE_ID -> HRT_PROFILES_B.PROFILE_ID via corpus_join [strict; chain strict; hops 1] |
| HRQ_QUESTIONNAIRES_B | TABLE | 73 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_RELATIONS | TABLE | 72 | VIA_PARENT | PROFILE_ID -> HRT_PROFILES_B.PROFILE_ID via corpus_join [strict; chain strict; hops 1] |
| PER_ACTION_REASONS_TL | TABLE | 72 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTNR_QUESTIONS | TABLE | 69 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_ASSIGNMENT_STATUS_TYPES_TL | TABLE | 69 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_ACTION_REASONS_B | TABLE | 66 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| WLF_AR_RELATIONS_F | TABLE | 62 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_MODELS_B | TABLE | 61 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_MODELS_TL | TABLE | 59 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTN_RESPONSES | TABLE | 58 | UNSECURABLE | no context column, no FK and no dominant corpus join to a secured object |
| HRQ_QUESTIONS_B | TABLE | 58 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PAY_ELEMENT_TYPES_TL | TABLE | 58 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_TYP_SECTIONS | TABLE | 57 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |


### Samples (lengths)

| sample | length | grant types | merged set groups | excluded customer sets | excluded literal-id sets |
|---|---|---|---|---|---|
| PO_HEADERS_ALL / PO_VIEW_PO_DOC_TXN_DATA — alias form (table read alone, alias poh) | 5649 | SET | 9 | 0 | 0 |
| PO_HEADERS_ALL / PO_VIEW_PO_DOC_TXN_DATA — isolated form (mandatory when joined), alias poh | 5746 | SET | 9 | 0 | 0 |
| FUN_ALL_BUSINESS_UNITS_V / AP_REPORT_PAYABLES_DATA — alias form, alias bu | 2748 | GLOBAL+SET | 4 | 0 | 0 |
| AP_INVOICES_ALL.ORG_ID via FUN_ALL_BUSINESS_UNITS_V / AP_REPORT_PAYABLES_DATA — via-join form, alias ai | 2828 | GLOBAL+SET | 4 | 0 | 0 |
| PER_ALL_PEOPLE_F / PER_REPORT_PERSON_DATA — HCM anchor, compact isolated form (this pod: GLOBAL + the `_S` placeholder 1=2; BLIND to profile-compiled HCM_PER_<id> sets), alias pap | 1214 | GLOBAL+SET | 1 | 0 | 0 |
| PER_PERSON_NAMES_F_V.PERSON_ID via PER_PERSON_SECURED_LIST_V — Oracle's HCM BIP secured-list form (row-secured by the pod at run time), alias ppn | 76 |  | 0 | 0 | 0 |
| PER_PERSON_NAMES_F_V.PERSON_ID via PER_ALL_PEOPLE_F / PER_REPORT_PERSON_DATA — via-join compact form (same blindness as the anchor sample), alias ppn | 1110 | GLOBAL+SET | 1 | 0 | 0 |
