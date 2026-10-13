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
