# PL/SQL package usage across the Fusion report-SQL corpus

Scope: 26,204 L3 statements (content-deduped SQL) from 116,006 L2 units; 4,862 statements carry at least one dotted call; 29,143 call facts. Extraction: masked lexical scan (`scripts/pipeline/p3_calls.py`), classification over the vendor dictionary (`p3_calls_post.sql`). Ranking = distinct statements; `units` = distinct L2 source units, `reports` = distinct BIP catalog paths (otbi/view have none).

## Per class

| class | packages | functions | call statements (sum) | units (sum) |
|---|---|---|---|---|
| fusion | 451 | 2940 | 11502 | 27445 |
| oracle | 9 | 17 | 115 | 281 |
| method | 3 | 3 | 41 | 155 |

## Top 40 by distinct statements

| # | package.function | class | module | statements | units | reports | args | top tables |
|---|---|---|---|---|---|---|---|---|
| 1 | `HZ_SESSION_UTIL.GET_USER_PARTYID` | fusion | HZ | 469 | 892 | 0 | 0 | ZCA_OBJECT_SHARE_VIEW, ZCA_ACCESS_GROUP_MEMBERS_VIEW, HZ_PARTIES |
| 2 | `PER_BIPNTF_UTILITY.GETATTRIBUTEFROMTXNCONTEXT` | fusion | PER | 407 | 1274 | 66 | 2,3 | HCM_LOOKUPS, XMLTABLE, PER_ALL_ASSIGNMENTS_M |
| 3 | `HRC_SESSION_UTIL.GET_USER_PERSONID` | fusion | HRC | 354 | 1313 | 2 | 0 | PER_PERSONS, PER_PERIODS_OF_SERVICE, PER_CONTACT_RELSHIPS_F |
| 4 | `FND_GLOBAL.USER_GUID` | fusion | FND | 342 | 453 | 6 | 0 | FND_SESSION_ROLE_SETS, FND_COMPILED_MENU_FUNCTIONS, FND_GRANTS |
| 5 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFOREOBYNAME` | fusion | PER | 284 | 804 | 27 | 2,3 | HCM_LOOKUPS, FND_DF_SEGMENTS_VL, FND_TERRITORIES_VL |
| 6 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFOREO` | fusion | PER | 250 | 803 | 29 | 2,3 | FND_DF_SEGMENTS_VL, HCM_LOOKUPS, FND_DF_CONTEXTS_B |
| 7 | `FND_GLOBAL.USER_NAME` | fusion | FND | 211 | 375 | 22 | 0 | ZCA_OBJECT_SHARE_VIEW, HZ_PARTIES, ZCA_ACCESS_GROUP_MEMBERS_VIEW |
| 8 | `PER_BIPNTF_FLEX.GETATTRIBUTE` | fusion | PER | 209 | 658 | 45 | 4 | PER_BIPNTF_FLEX, PER_BIPNTF_UTILITY, HCM_LOOKUPS |
| 9 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFORVO` | fusion | PER | 193 | 633 | 44 | 2,3 | PER_BIPNTF_FLEX, PER_BIPNTF_UTILITY, HCM_LOOKUPS |
| 10 | `FND_PROFILE.VALUE` | fusion | FND | 189 | 431 | 51 | 1 | HRT_PROFILE_ITEMS, HRT_CONTENT_TYPES_VL, HRT_PROFILE_TYP_SECTIONS_VL |
| 11 | `FND_GLOBAL.SESSION_ROLE_SET_KEY` | fusion | FND | 176 | 241 | 0 | 0 | FND_SESSION_ROLE_SETS, FND_COMPILED_MENU_FUNCTIONS, FND_GRANTS |
| 12 | `PER_BIPNTF_UTILITY.GETSTRINGATTRIBUTEFROMTXNMODEL` | fusion | PER | 171 | 572 | 53 | 3 | HCM_LOOKUPS, XMLTABLE, DUAL |
| 13 | `FND_GLOBAL.GET_CONN_DS_ATTRIBUTE` | fusion | FND | 169 | 234 | 0 | 1 | FND_COMPILED_MENU_FUNCTIONS, FND_GRANTS, FND_SESSION_ROLE_SETS |
| 14 | `PER_BIPNTF_UTILITY.GETATTRIBUTEVALUE` | fusion | PER | 154 | 495 | 31 | 5 | HCM_LOOKUPS, XMLTABLE, FND_DF_SEGMENTS_VL |
| 15 | `PER_BIPNTF_FLEX.GETSEGMENTVALUE` | fusion | PER | 149 | 458 | 30 | 2,3,12 | FND_DF_SEGMENTS_VL, FND_DF_CONTEXTS_B, HRC_TXN_HEADER |
| 16 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPEFOREO` | fusion | PER | 145 | 479 | 23 | 2,3 | XMLTABLE, PER_BIPNTF_UTILITY, HRC_TXN_HEADER |
| 17 | `FND_FLEX_EXT.GET_SEGS` | fusion | FND | 133 | 281 | 43 | 4,5 | INV_ITEM_LOCATIONS, EGP_SYSTEM_ITEMS_VL, FND_LOOKUPS |
| 18 | `PER_BIPNTF_FLEX.GETDFFSEGMENTVALUE` | fusion | PER | 119 | 355 | 32 | 3 | FND_DF_SEGMENTS_VL, HCM_LOOKUPS, FND_TERRITORIES_VL |
| 19 | `PER_BIPNTF_UTILITY.GETATTRIBUTEVALUEFROMCDATA` | fusion | PER | 110 | 305 | 19 | 4,5 | HCM_LOOKUPS, FND_TERRITORIES_VL, FND_DF_SEGMENTS_VL |
| 20 | `HZ_SESSION_UTIL.GET_USER_BUSINESS_UNITS` | fusion | HZ | 95 | 269 | 0 | 0 | ZCA_ACCESS_GROUP_MEMBERS_VIEW, ZCA_OBJECT_SHARE_VIEW, OKC_K_HEADERS_ALL_B |
| 21 | `PER_NOTIFICATION_SECURITY.MULTIPRIV_SECUREDATA` | fusion | PER | 94 | 245 | 38 | 8 | HCM_LOOKUPS, FND_TERRITORIES_VL, DUAL |
| 22 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPE` | fusion | PER | 92 | 351 | 22 | 2 | XMLTABLE, DUAL, PER_BIPNTF_UTILITY |
| 23 | `FND_FLEX_XML_PUBLISHER_APIS.PROCESS_KFF_COMBINATION_1` | fusion | FND | 88 | 153 | 8 | 9 | GL_CODE_COMBINATIONS, FND_LOOKUP_VALUES_TL, FND_DF_CONTEXTS_VL |
| 24 | `PER_BIPNTF_UTILITY.CHECK_COMPARE_SECURITY` | fusion | PER | 86 | 251 | 9 | 3 | PER_BIPNTF_UTILITY, XMLTABLE, PER_BIPNTF_FLEX |
| 25 | `PER_BIPNTF_UTILITY.GETDATEVALUE` | fusion | PER | 79 | 236 | 15 | 5 | XMLTABLE, HCM_LOOKUPS, PER_GRADES_F_VL |
| 26 | `FND_GLOBAL.CURRENCY` | fusion | FND | 78 | 254 | 22 | 0 | FINANCIALS_SYSTEM_PARAMS_ALL, FND_CURRENCIES_VL, FND_CURRENCIES_B |
| 27 | `PER_BIPNTF_FLEX.GETDFFATTRIBUTESFROMCOMPARE` | fusion | PER | 54 | 218 | 40 | 5 | PER_BIPNTF_FLEX, PER_BIPNTF_UTILITY, FND_DF_SEGMENTS_VL |
| 28 | `PER_BIPNTF_UTILITY.ISNODEEXISTS` | fusion | PER | 54 | 162 | 12 | 2 | PER_BIPNTF_FLEX, PER_BIPNTF_UTILITY, TXNINFO |
| 29 | `PER_BIPNTF_UTILITY.GETDATEVALUEFROMCDATA` | fusion | PER | 51 | 135 | 12 | 4,5 | HCM_LOOKUPS, FND_TERRITORIES_VL, FND_DF_SEGMENTS_VL |
| 30 | `HZ_FORMAT_PUB.FORMAT_ADDRESS` | fusion | HZ | 47 | 126 | 30 | 1,2,4,8,11,14,18 | HZ_PARTIES, HZ_PARTY_SITES, HZ_LOCATIONS |
| 31 | `INV_CONVERT.INV_UM_CONVERT` | fusion | INV | 47 | 72 | 10 | 7,9,10 | WIE_WO_OPERATIONS_B, EGP_SYSTEM_ITEMS_VL, WIE_WORK_ORDERS_B |
| 32 | `PER_ADDRESS_FORMAT.FORMAT_ADDRESS` | fusion | PER | 45 | 122 | 35 | 21,22,24,26 | PAY_INSTALLED_LEGISLATIONS, PER_PERSON_NAMES_F_V, PER_ADDRESSES_F |
| 33 | `INV_CONVERT.CONVERT_QTY` | fusion | INV | 45 | 93 | 8 | 4 | FND_LOOKUPS, EGP_SYSTEM_ITEMS_VL, INV_UNITS_OF_MEASURE_VL |
| 34 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCE` | fusion | PER | 44 | 150 | 9 | 2 | HRT_CONTENT_TYPES_VL, HRT_PROFILE_ITEMS, HRT_PROFILES_VL |
| 35 | `GL_CURRENCY_API.GET_CLOSEST_RATE_SQL` | fusion | GL | 43 | 179 | 14 | 5 | CMP_PLANS_TL, HCM_LOOKUPS, FND_CURRENCIES_TL |
| 36 | `POZ_UTIL.FORMAT_NAME` | fusion | POZ | 40 | 93 | 13 | 1,2,3 | HZ_PARTIES, POZ_SUPPLIER_SITES_ALL_M, POQ_QUESTNAIRE_RESP_HEADERS |
| 37 | `ROWTYPE.GETCLOBVAL` | method | PER | 39 | 151 | 25 | 0 | PER_BIPNTF_FLEX, PER_BIPNTF_UTILITY, FND_LOOKUP_VALUES_TL |
| 38 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPEFOREOBYNAME` | fusion | PER | 39 | 97 | 15 | 2,4,6 | HCM_LOOKUPS, XMLTABLE, FND_TERRITORIES_VL |
| 39 | `PAY_REPORT_DELIVERY.GET_DEL_PARAM_VALUE` | fusion | PAY | 39 | 83 | 26 | 6 | PAY_PAYROLL_ACTIONS, PER_EXT_DELIVERY_OPTIONS_B, PAY_ACTION_INFORMATION |
| 40 | `HZ_UTILITY_V2PVT.GET_MESSAGE` | fusion | HZ | 36 | 71 | 0 | 12 | HZ_IMP_ERRORS, MKT_IMP_JOBS, HZ_IMP_ACCOUNTRELS |

## Top 40 Fusion application APIs by distinct BIP reports

| # | package.function | module | reports | statements | sample |
|---|---|---|---|---|---|
| 1 | `PER_BIPNTF_UTILITY.GETATTRIBUTEFROMTXNCONTEXT` | PER | 66 | 407 | `per_bipntf_utility.getattributefromtxncontext(:transId, 'Points')` |
| 2 | `PER_BIPNTF_UTILITY.GETSTRINGATTRIBUTEFROMTXNMODEL` | PER | 53 | 171 | `per_bipntf_utility.getStringAttributeFromTxnModel(:transId,'STATE','HRC_TXN_DATA')` |
| 3 | `FND_PROFILE.VALUE` | FND | 51 | 189 | `FND_PROFILE.VALUE('FND_CURRENCY')` |
| 4 | `PER_BIPNTF_FLEX.GETATTRIBUTE` | PER | 45 | 209 | `per_bipntf_flex.GETATTRIBUTE('JobVO',VALUE(RowType),'Name','OldValue')` |
| 5 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFORVO` | PER | 44 | 193 | `per_bipntf_utility.extractxmlsequenceforvo(:transId,'JobVO')` |
| 6 | `FND_FLEX_EXT.GET_SEGS` | FND | 43 | 133 | `fnd_flex_ext.get_segs('GL', 'GL#', :HI_COA_ID, 0)` |
| 7 | `PER_BIPNTF_FLEX.GETDFFATTRIBUTESFROMCOMPARE` | PER | 40 | 54 | `per_bipntf_flex.getDFFAttributesFromCompare(:transId,'PhoneDFF','PhoneVORow','FALSE','PER_PHONES_DFF')` |
| 8 | `PER_NOTIFICATION_SECURITY.MULTIPRIV_SECUREDATA` | PER | 38 | 94 | `per_notification_security.multipriv_SecureData(:privilege,'OR' , 'PER_PERIODS_OF_SERVICE', service.PERIOD_OF_S` |
| 9 | `PER_ADDRESS_FORMAT.FORMAT_ADDRESS` | PER | 35 | 45 | `PER_ADDRESS_FORMAT.FORMAT_ADDRESS(Aline1, Aline2, Aline3 , Aline4 , city,Pcode, state, province, county, fnum,` |
| 10 | `PER_BIPNTF_FLEX.GETDFFSEGMENTVALUE` | PER | 32 | 119 | `per_bipntf_flex.getDFFSegmentValue('PER_PHONES','PHONE_ID = '\|\| t.PhoneId , 'PERSON_ID')` |
| 11 | `PER_BIPNTF_UTILITY.GETATTRIBUTEVALUE` | PER | 31 | 154 | `per_bipntf_utility.getAttributeValue(:transId,'PersonEO',value(PersonEO),'PERSON_ID:java.lang.Long', 1)` |
| 12 | `PER_BIPNTF_FLEX.GETSEGMENTVALUE` | PER | 30 | 149 | `PER_BIPNTF_FLEX.getSegmentValue(ValueSetId, NewValue)` |
| 13 | `HZ_FORMAT_PUB.FORMAT_ADDRESS` | HZ | 30 | 47 | `HZ_FORMAT_PUB.format_address(loc.location_id)` |
| 14 | `PER_BIPNTF_UTILITY.EXTRACTVALUEBYXPATH` | PER | 30 | 27 | `per_bipntf_utility.extractvaluebyxpath(:transid, '/*/TransCtx/CSA_DOR_Visited')` |
| 15 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFOREO` | PER | 29 | 250 | `per_bipntf_utility.extractXMLSequenceForEO(:transId, 'PhoneEO')` |
| 16 | `PER_BIPNTF_UTILITY.EXTRACTXMLSEQUENCEFOREOBYNAME` | PER | 27 | 284 | `per_bipntf_utility.extractXMLSequenceForEOByName(:transId,'oracle.apps.hcm.addresses.publicModel.entity.Addres` |
| 17 | `PAY_REPORT_DELIVERY.GET_DEL_PARAM_VALUE` | PAY | 26 | 39 | `pay_report_delivery.get_del_param_value('3',del_opt.ext_delivery_option_id,del_opt.delivery_type,null,'PPA',pr` |
| 18 | `MO_UTILS.GET_ORG_NAME` | AR | 25 | 13 | `MO_UTILS.GET_ORG_NAME(ps.org_id)` |
| 19 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPEFOREO` | PER | 23 | 145 | `per_bipntf_utility.extractXMLTypeForEO(:transId,'JobDEO',0)` |
| 20 | `FND_GLOBAL.USER_NAME` | FND | 22 | 211 | `select fnd_global.user_name` |
| 21 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPE` | PER | 22 | 92 | `per_bipntf_utility.extractXMLType(:transId,'TransCtx')` |
| 22 | `FND_GLOBAL.CURRENCY` | FND | 22 | 78 | `Y_CODE as "CurrencyCode1", FND_GLOBAL.CURRENCY` |
| 23 | `PER_BIPNTF_FLEX.GETEFFATTRIBUTESFROMCOMPARE` | PER | 21 | 23 | `per_bipntf_flex.getEFFAttributesFromCompare(:transId,'GradeLegDeveloper','GradeVORow')` |
| 24 | `PAY_REPORT_DELIVERY.GET_OUTPUT_FILE_NAME` | PAY | 20 | 23 | `pay_report_delivery.get_output_file_name(del_opt.output_name,:EFFECTIVE_DATE,del_opt.ext_delivery_option_id,de` |
| 25 | `PER_BIPNTF_UTILITY.GETATTRIBUTEVALUEFROMCDATA` | PER | 19 | 110 | `per_bipntf_utility.getAttributeValueFromCdata(CDATAValue,:transId, 'PHONE_ID:java.lang.Long',1)` |
| 26 | `PAY_REPORT_DELIVERY.GET_DEL_CHANNEL` | PAY | 18 | 21 | `pay_report_delivery.get_del_channel(del_opt.delivery_type,del_opt.ext_delivery_option_id,pri.payroll_action_id` |
| 27 | `PSC_BIP_PII_SECURITY.SECUREDATA` | PSC_CC | 18 | 19 | `psc_bip_pii_security.secureData('PSC_PRINT_PERMIT_DATA', 'PSC_LNP_RECORD', "PSC_LNP_RECORD"."LNP_RECORD_KEY",n` |
| 28 | `PER_BIPNTF_UTILITY.GETDATEVALUE` | PER | 15 | 79 | `per_bipntf_utility.getDateValue(:transId, 'JobDEO',value(JobDetails),'JOB_ID:java.lang.Long\|EFFECTIVE_START_D` |
| 29 | `PER_BIPNTF_UTILITY.EXTRACTXMLTYPEFOREOBYNAME` | PER | 15 | 39 | `per_bipntf_utility.extractXMLTypeForEOByName(:transId,TxnInfo.entity,'PeriodOfServiceEO','1')` |
| 30 | `PER_NOTIFICATION_SECURITY.SECUREDATA` | PER | 15 | 28 | `per_notification_security.secureData('PER_VIEW_PERSON_EMAIL_DATA', 'PER_EMAIL_ADDRESSES',EmailAddressPEO.EMAIL` |
| 31 | `PER_BIPNTF_UTILITY.GETNUMBERATTRIBUTEFROMTXNMODEL` | PER | 15 | 25 | `per_bipntf_utility.getNumberAttributeFromTxnModel(:transId,'object_id','hrc_txn_header')` |
| 32 | `GL_CURRENCY_API.GET_CLOSEST_RATE_SQL` | GL | 14 | 43 | `fusion.gl_currency_api.get_closest_rate_sql( NVL(CurrencyCode, ' '), FND_GLOBAL.CURRENCY , sysdate , 'Corporat` |
| 33 | `PER_BIPNTF_FLEX.GETDFFATTRIBUTESFORCOMPAREDATA` | PER | 14 | 23 | `per_bipntf_flex.getDFFAttributesForCompareData(:transId,'ContractDFF','ContractsNDEVORow')` |
| 34 | `POZ_UTIL.FORMAT_NAME` | POZ | 13 | 40 | `POZ_UTIL.FORMAT_NAME(FIRST_NAME , LAST_NAME)` |
| 35 | `GL_CURRENCY_API.CONVERT_CLOSEST_AMOUNT_SQL` | GL | 13 | 25 | `gl_currency_api.convert_closest_amount_sql(chk.currency_code, fnd_profile.value('FND_CURRENCY'), sysdate, nvl(` |
| 36 | `POZ_UTIL.FORMAT_ADDRESS` | POZ | 13 | 20 | `POZ_UTIL.format_address(SiteEO.LOCATION_ID)` |
| 37 | `PER_BIPNTF_UTILITY.ISNODEEXISTS` | PER | 12 | 54 | `per_bipntf_utility.isNodeExists(:transId,'//COMPAREDATA/CompareVO')` |
| 38 | `PER_BIPNTF_UTILITY.GETDATEVALUEFROMCDATA` | PER | 12 | 51 | `per_bipntf_utility.getDateValueFromCdata(CDATAValue,:transId,'PERSON_NAME_ID:java.lang.Long\|EFFECTIVE_START_D` |
| 39 | `PER_BIPNTF_UTILITY.EXTRACTEO` | PER | 12 | 35 | `per_bipntf_utility.extractEO(:transId,'RateDEO', 3)` |
| 40 | `POZ_UTIL.FORMAT_NAME_DISP` | POZ | 12 | 16 | `poz_util.format_name_disp(first_name,middle_name,last_name)` |
