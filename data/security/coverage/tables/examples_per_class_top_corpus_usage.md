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
