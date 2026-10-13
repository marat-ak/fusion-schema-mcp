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
