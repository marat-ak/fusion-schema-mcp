| sample | length | grant types | merged set groups | excluded customer sets | excluded literal-id sets |
|---|---|---|---|---|---|
| PO_HEADERS_ALL / PO_VIEW_PO_DOC_TXN_DATA — alias form (table read alone, alias poh) | 5649 | SET | 9 | 0 | 0 |
| PO_HEADERS_ALL / PO_VIEW_PO_DOC_TXN_DATA — isolated form (mandatory when joined), alias poh | 5746 | SET | 9 | 0 | 0 |
| FUN_ALL_BUSINESS_UNITS_V / AP_REPORT_PAYABLES_DATA — alias form, alias bu | 2748 | GLOBAL+SET | 4 | 0 | 0 |
| AP_INVOICES_ALL.ORG_ID via FUN_ALL_BUSINESS_UNITS_V / AP_REPORT_PAYABLES_DATA — via-join form, alias ai | 2828 | GLOBAL+SET | 4 | 0 | 0 |
| PER_ALL_PEOPLE_F / PER_REPORT_PERSON_DATA — HCM anchor, compact isolated form (this pod: GLOBAL + the `_S` placeholder 1=2; BLIND to profile-compiled HCM_PER_<id> sets), alias pap | 1214 | GLOBAL+SET | 1 | 0 | 0 |
| PER_PERSON_NAMES_F_V.PERSON_ID via PER_PERSON_SECURED_LIST_V — Oracle's HCM BIP secured-list form (row-secured by the pod at run time), alias ppn | 76 |  | 0 | 0 | 0 |
| PER_PERSON_NAMES_F_V.PERSON_ID via PER_ALL_PEOPLE_F / PER_REPORT_PERSON_DATA — via-join compact form (same blindness as the anchor sample), alias ppn | 1110 | GLOBAL+SET | 1 | 0 | 0 |
