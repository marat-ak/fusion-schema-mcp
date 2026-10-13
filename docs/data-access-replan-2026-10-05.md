# Data-access re-plan after phase 2 (2026-10-05)

Read-only analysis + scratch experiments against release **v2027_07** (ddl_version 9) and the Kornit TEST
customer layer (stamp 2026-10-05). Nothing was built, released, deployed or changed in the served dev state;
the pod was read through `runSql` (5 read-only statements, one at a time). Scratch artefacts (the collector,
CSV dumps, analysis scripts and their outputs) stay in the session scratchpad (`…/scratchpad/replan/`).

Trigger: phase 2 moved population A's blocked count only 321 → 272 (area keying, best area). User decisions at the
review: (1) phase 3 as planned is not approved — re-plan first; (2) ambiguous privileges in end-user mode →
**strictest of candidates** (a row shows only if every candidate privilege allows it), graded `strictest`, stated in
the answer, replaced by a trace when one exists; (3) `scripts/pipeline/oracle_datasec_policies.csv` stays a local
build input; (4) the pod-mcp setup/entry leftovers stay for now.

**Method.** A scratch collector (`replan_collect.mts`, run in a throwaway `schema-mcp-build` container whose `dist/`
is the product resolver) resolved every (table, subject area) pair of the two populations — the same populations and
area order as `security_coverage_resolver.mts` (fact areas first, then by name, at most 10 areas per table) — but
resolved EVERY area and kept the blocked candidates: 1,328 tables, 4,778 (table, area) results. Lever experiments
were run over that output in Python (no code change); the pod facts the levers need were read with `runSql`.
"Secured" = secured in at least one of the table's areas (the best area); "end-user view" = the plan's end-user
rules (a pool-2 pick `granted` and an unverified `none` are not read).

Populations: **A** = the 1,142 tables of OTBI fact folders; **B** = the top-300 BIP tables.

## Summary of the measured levers

| lever (cumulative where marked) | A developer: secured / blocked / none | A end-user: readable | B developer: secured / blocked / none / no area | B end-user: readable |
|---|---|---|---|---|
| v2027_07 baseline (area keying) | 166 / 272 / 704 | 150 | 72 / 56 / 98 / 74 | 71 |
| + Q1 strictest of candidates | **286** / 152 / 704 | 271 | **90** / 38 / 98 / 74 | 90 |
| + Q2 job-role consensus (alone) | 208 / 230 / 704 | 193 | 85 / 43 / 98 / 74 | 84 |
| + Q2 + Q1 | **304** / 134 / 704 | 290 | **97** / 31 / 98 / 74 | 97 |
| + Q2 + Q1 + Q4 structural none (FK rule) | 304 / 134 / 704 | **887** | 97 / 31 / 98 / 74 | **188** |
| Q3 VO evidence for the context | no safe gain (see Q3) | — | — | — |

Per first-blocked class (developer view, tables):

| class (v2027_07) | A blocked | A by consensus | A by strictest | A by both | B blocked | B by consensus | B by strictest | B by both |
|---|---|---|---|---|---|---|---|---|
| ambiguous privilege (U + pool 2) | 112 | 23 | **112** | 112 | 16 | 6 | **16** | 16 |
| no privilege of the module/area on the object | 82 | 9 | 6 | 14 | 14 | 3 | 0 | 3 |
| multi-context: the area decides no entity | 32 | 10 | 1 | 11 | 9 | 4 | 0 | 4 |
| HCM object with no analysis-duty grant at all | 29 | 0 | 0 | 0 | 8 | 0 | 0 | 0 |
| HCM area-duty: unmapped / no duty of the area holds it | 13 | 0 | 0 | 0 | 6 | 0 | 0 | 0 |
| HCM area-duty: ambiguous | 1 | 0 | 1 | 1 | 2 | 0 | 2 | 2 |
| registered without grant / object without named grant | 3 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |

(The coverage report's "ambiguous privilege (U)" 40 counted one HCM area-duty ambiguity; re-classified here.)

## Q1 — Strictest of candidates

**CTE shape** (one condition, every candidate class AND-ed against the same object row; one name per grant-set
class — identical `grant_sig` = the same predicate for every user, so the equivalent names add nothing):

```sql
<alias>_sec as (select /*+ INLINE */ <projection> from <TABLE> t
  where t.<col> in (select sec$.<pk> from <object> sec$
                    where ({PRED:<object>|<p1>}) and ({PRED:<object>|<p2>}) [and …]))
```

grade `strictest`, the candidate list in the plan, every pair fetched in the ONE `getSecurityPredicate` call. AND
inside one subquery over the same `sec$` row is exactly the intersection of the candidates' rows (equivalent to
one `in (…)` per candidate). A `(1=2)` candidate empties the table: "no access" wording, never "no data".

**Gain.** A: all 112 ambiguous tables + 7 tables first-blocked otherwise but ambiguous in another of their areas
(6 "no module privilege", 1 "area decides no entity") + the 1 HCM area-duty ambiguity → **A 166 → 286 secured**
(end-user 150 → 271); **B 72 → 90** (end-user 71 → 90). Candidate sources of the strictest-graded tables (A 121 =
the 120 new + 1 that had only a pool-2 pick; B 19): A — pool 2 (all granted pairs by prefix) 75, U (the BI
identity's pairs) 45, HCM area duties 1; B — U 11, pool 2 6, duties 2.

**Pairs per table** (= distinct grant-set classes): A 2 ×27, 3 ×7, 4 ×12, 5 ×2, 6 ×21, 7 ×2, 9 ×32, 10 ×8, 12 ×9
(median 6, max 12); B 2 ×8, 4 ×1, 6 ×2, 10 ×5, 12 ×2. A 4-table query can need 20–40 pairs; the pod answered 47
pairs in one statement in 2.6 s (probe below). With a cap of ≤ 6 classes the gain is A 69 / B 11 tables.

Examples: `INV_ORG_PARAMETERS` / `INV_SECONDARY_INVENTORIES_VL` / `INV_LOT_NUMBERS` (U, 10 INV classes on
INV_ORG_PARAMETERS), `RCV_TRANSACTIONS` (U, 2 RCV classes), `PJC_EXP_ITEMS_ALL` (U: PJC_EXTRACT_N_WAREHOUSE… +
PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA), `HZ_PARTY_SITES` (pool 2: HZ_MANAGE_… + HZ_VIEW_TRADING_COMMUNITY_PERSON_ADDRESS_DATA),
`JTF_RS_RESOURCE_PROFILES` (pool 2, 6 HZ classes incl. HZ_REMOVE_/HZ_UPDATE_), `PAY_PAY_RELATIONSHIPS_DN` and
`IRC_OFFERS` (HCM area duties, 2 classes).

**Classes covered:** ambiguous U, ambiguous pool 2, HCM area-duty ambiguous, curated conflict (none in v2027_07).
**Not covered:** no candidate at all (no privilege of the module/area on the object), the context ambiguity
("area decides no entity" — strictest is about the privilege, not the column), HCM objects without duty grants,
registered-without-grant.

**Can it be WIDER than OTBI?** Only when OTBI's privilege P\* is NOT among the candidates (if P\* is a candidate,
the AND is a subset of P\*'s rows). Measured on the known areas — every curated (area, entity) row with its known
privilege (the AP trace + the 35 AQ3 demo-crawl areas), re-running the candidate rule as if the curated row did
not exist — over 226 (area, table) cases:

| outcome of the candidate rule on a known area | (area, table) |
|---|---|
| one class = P\* (the rule alone is right) | 140 |
| several classes, P\* inside (strictest is safe) | 10 |
| several classes, **P\* outside** (strictest could be wider) | **10** |
| one class ≠ P\* (the plain `rule` grade picks another privilege) | 21 |
| no candidate (blocked) | 45 |

All 10 "outside" and all 21 "one class ≠ P\*" cases are areas secured by ANOTHER product's privilege: Inventory -
Transfer Order, Manufacturing - Work Order Performance, Shipping, Supply Chain Financial Orchestration (OTBI uses
DOO_MANAGE_ORCHESTRATION_ORDER_DATA on the BU view; the rule offers AR_VIEW_RECEIVABLES_ACTIVITIES_DATA or
GMS_CREATE_AWARD_DATA). Among the 120 A tables strictest secures, 115 are read by an area whose fact modules include
the table's own module and 5 are "foreign dimensions" of their area (`EGO_CHANGE_LINES_B` in Manufacturing - Work
Definitions, `EGO_ENGINEERING_CHANGES_B` in Enterprise Quality Issues, `POQ_INITIATIVES` in Procurement - Purchasing,
`ZX_PARTY_TAX_PROFILE` in Costing - Landed Costs, `INV_LOT_NUMBERS` in Enterprise Quality Actions) — the structural
signature of the risk. **Exclusion:** (a) apply strictest only when the table's module is a fact module of the area
(drops the 5); (b) AND the area's known privilege (curated row, or the Q2 consensus pick) into the candidate set
whenever one exists — adding candidates only narrows, so P\* is then inside by construction; (c) cross-product areas
(DOO privilege in SCM areas) stay curated/traced.

**Over-restriction is the real cost** (never wider, often empty). Probe on the pod for the trace user (marat), the
14 most-used strictest tables, 47 pairs, access verdict only:

| strictest outcome for that user | tables |
|---|---|
| every candidate grants rows → AND = rows (intersection) | 5 (`HZ_CONTACT_POINTS`, `HZ_PARTIES`, `HZ_PARTY_SITES`, `INV_ORG_PARAMETERS`/RCS, `ZX_PARTY_TAX_PROFILE`) |
| every candidate `(1=2)` → empty, consistent with any single pick | 4 (`ACD_CONCEPT_B`, `IRC_OFFERS`, `PAY_PAY_RELATIONSHIPS_DN`, `PJC_EXP_ITEMS_ALL`) |
| **mixed: ≥ 1 candidate grants rows, ≥ 1 is `(1=2)` → AND empty** | **5** (`CST_COST_ORGS_V` 5 of 6 grant, `FND_SETID_SETS_VL` 5 of 7 global, the PJC BU set 3 of 6 global, `JTF_RS_RESOURCE_PROFILES` 5 of 6, `PJF_PROJECTS_ALL_VL` 1 of 2 global) |

Candidate sets that mix manage/update/remove privileges with view/report ones are the ones that empty (a report
user rarely holds them all). The answer must name the strictest rule and the missing privilege.

## Q2 — Area → job-role consensus privilege

**Facts.** FND_GRANTS on the pod (active ALLOW grants by grantee kind): seeded job roles 12,600 grants (244 roles,
646 objects, 10,355 SET), seeded duty roles 8,900 (701), other seeded 6,175, seeded abstract 1,052 (38), customer
roles 40,811 (1,118). Data-security grants ARE held by job roles directly, so the guides' job roles can be joined
to grants without a role-hierarchy walk. The guides give 212 job codes (job.jsonl) mapped to areas through their
duty codes (duty.jsonl `job_codes` × the release's `otbi_area_duty`) and their own `subject_areas`. One pod read
returned the 4,306 (job role, object, privilege) grants of the 212 guide jobs on the 74 objects the blocked classes
name.

**Rule tested.** For (area, object): the privileges the area's guide jobs hold on the object; when U (the BI
identity) holds any named privilege on the object, only U's privileges compete (OTBI's privileges are U's — a first
run without this restriction disagreed with the PO trace in 21 of 42 areas because non-procurement jobs hold
`PO_VIEW_PO_DOC_TXN_DATA`, not U's `PO_VIEW_PO_DOC_ANALYSIS_DATA`); else pool 2 (any granted pair); pick by grant-set
class: unanimous among the holder jobs, else a unique majority; ties = no pick.

**Validation** (known privileges): AP trace + AQ3 rows on their 40 areas — agree 16, disagree 3, no pick 21 (no
job holds a grant on the object 13, no guide job for the area 6, tie 1, none of U's privileges held 1). The 3
disagreements are the CRM note areas, where AQ3's own answer `read` is an untraced proposal (the consensus picks
`MKL_VIEW_SALES_LEAD_NOTE_DATA`). GL (5 areas) and DOO (5 areas) unanimous = the trace/crawl privilege; Payables 6 of
7 areas by majority (AP_REPORT_PAYABLES_DATA 5/7 jobs), 1 tie with AR_VIEW_RECEIVABLES_ACTIVITIES_DATA. PO trace
(`PO_HEADERS_ALL` / PO_VIEW_PO_DOC_ANALYSIS_DATA) over the 68 areas that read PO_HEADERS_ALL: agree 15, disagree 0, no
pick 53. The SCM areas secured by DOO's privilege are NOT found (their jobs hold no grant on the BU view).

**Gain** (developer view): A 166 → 208 (+42), B 72 → 85 (+13); by class: ambiguous 23 (A) / 6 (B), no module
privilege 9 / 3, area decides no entity 10 / 4 (the area's jobs hold grants on exactly ONE of the table's context
objects). On top of strictest: A 286 → 304, B 90 → 97, and 43 A tables get ONE consensus privilege instead of an AND
of up to 12 (fewer pairs, less emptying). Fixed by unanimity 30, by majority 15. Examples: `WIE_WORK_ORDERS_B` in
Supply Order → RCS_MFG_PARAMETERS / RCS_PLANT_PARAMETERS_DATA (decides the MFG context), `PJC_EXP_ITEMS_ALL` →
PJC_MANAGE_PROJECT_EXPENDITURE_ITEM_DATA, `HZ_PARTIES` (CRM Interaction Activity) → HZ_VIEW_TRADING_COMMUNITY_CONTACT_DATA,
`PSC_LNP_RECORD` → PSC_UPDATE_PSC_RECORD_DATA (pool 2: manage-type picks are common where U holds nothing).

**Customer copies.** On 8 key objects (BU view, ledger, inventory org, PO header, party, cost org, project, item)
60 customer job roles hold grants; 32 map to a seeded job by the name rule: 23 identical grant sets, 9 hold a SUBSET
(drop privileges), 0 add — seeded consensus is an upper bound for the copies.

**Does the customer layer keep grantee names per pair?** No: `sec_instance_privilege` keeps the grant-set signature
and count, `sec_instance_u` the BI identity's pairs, `sec_instance_duty` the FBI/analysis duty roles. The loader would
need ONE more page (names only): `role_grants-<n>.json` = DISTINCT (role_name, obj_name, privilege) for seeded job and
abstract roles (`ORA_%_JOB`, `ORA_%_ABSTRACT`; at most 13.7k grant rows on Kornit), a `customer.sec_instance_role_grant` table
(library migration v4), and the area → job map from the guides in the release (`otbi_area_job`, from job.jsonl /
duty.jsonl — already crawled).

## Q3 — "Area decides no entity" (32 in A): can otbi_vo decide the context?

First-area sub-cases (A ∪ B, 37 tables): the area's VOs reading the table join **none** of the contexts' entities
30, no VO of the area reads the table 6, several 1. Root cause: the VO hop records the objects behind MAPPED
attributes, not the security joins. The curated (area, entity) rows prove it — the VOs of the area that list the
entity OTBI binds: Payables 0 of 438 (fact VOs 0 of 67), DOO areas 0–6 of 65–502, Product Management 0–1 of 89–264,
GL Journals 6 of 83. Variants over the 159 (table, area) cases (44 tables):

| variant | decides one context | several | none | tables decided in ≥ 1 area |
|---|---|---|---|---|
| V1 every VO of the area (not only those reading the table) | 63 | 73 | 23 | 21 |
| V2 the table's VOs in any area | 24 | 13 | 122 | 4 |
| V3 a dimension folder named for exactly one context | 58 | 62 | 39 | 21 |

V1 is demonstrably wrong where it decides: it picks LEDGER for `AR_CASH_RECEIPTS_ALL` / `AR_ADJUSTMENTS_ALL` in the
Receivables areas because the lineage carries GL_LEDGERS but never the BU view (Receivables secure by BU). V3 is a
name heuristic. **Verdict: no safe gain from the lineage**; the job-role consensus decides 10 (A) / 4 (B) of these by
evidence of grants; the rest needs a per-prefix audit from a trace (AR → BU, CST/CMR → cost org vs inventory org,
FA → book, VRM, PJC …).

## Q4 — End-user readability of the 704 `none` tables without the crawl extractor

| rule | A (704 none) readable | B (98 none) readable |
|---|---|---|
| VO-structural (as proposed): every VO occurrence free of a pod-registered object, no context column | 438 (60 have no VO occurrence at all; 206 have a registered object in a VO) | 38 (5 / 55) |
| …same, registered objects with grants only | 439 | 40 |
| plan's crawl rule, structural proxy only (≥ 20 VO occurrences, unregistered, no context column; the slot test needs C3) | 45 | 10 |
| **declared-FK rule: no declared FK to a secured table (context column or registered object with grants)** | **597** (107 FK children stay blocked) | **91** (7) |

**Why the VO-structural rule is unreliable in both directions.** It blocks the most-used reference tables because
some VO that joins them also joins a registered object: `FND_LOOKUPS` (HZ_PARTIES, EGO_ENGINEERING_CHANGES_B),
`FND_CURRENCIES_TL`/`_VL`, `HR_ORGANIZATION_UNITS_F_TL` (464 areas), `GL_CODE_COMBINATIONS`, `GL_DAILY_RATES`,
`FND_TERRITORIES_VL`, `HZ_GEOGRAPHIES`, `HR_ALL_POSITIONS_F_TL` — a lookup joined into a secured VO is not secured
itself. And its "verified" side cannot be trusted: the lineage omits the security entities (Payables 0 of 438 VOs),
so "no registered object in its VOs" is not evidence of an unsecured VO. Most frequent registered objects in the VOs
of none tables: HZ_PARTIES 51, PER_ALL_PEOPLE_F 21, PO_HEADERS_ALL 17, PER_EMAIL_ADDRESSES 17, XLE_ENTITY_PROFILES 15.

**The declared-FK rule** asks the structural question that matters for a per-table CTE: is this a CHILD of secured
data (read standalone it shows rows OTBI shows only through the secured parent)? Risky cases: children whose FK is
not declared in the dictionary (247 A none tables relate to secured tables only through mined relationships — mostly
lookups/TL/calendars, e.g. `AP_LOOKUP_CODES`, `FND_CAL_DAY`, but the class is not proven); and over-restriction of
children that OTBI shows to everyone — `POZ_SUPPLIERS` (FK to HZ_PARTIES, VOs carry HZ_PARTIES / POZ_SUPPLIERS_PII /
ZX_PARTY_TAX_PROFILE) is blocked by BOTH rules although supplier headers are not a security object. `CE_BANK_ACCOUNTS`
(FK to HZ_PARTIES / XLE_ENTITY_PROFILES) is correctly kept blocked by the FK rule and wrongly opened by the VO rule.

## Q5 — What stays irreducible after Q1–Q4, and the minimum trace list

Residue after consensus + strictest (developer view): **143 distinct tables** (A 134, B 31): no candidate privilege
on the object 71, HCM object without any analysis-duty grant 30, area decides no entity 24, HCM area unmapped / no
area duty holds it 15, registered without grant 2, no named grant 1. By name prefix: PSC 16, CST 8, MSC 8, BEN 7,
PAY 6, POQ 6, EGP 5, MKT 5, PER 5, PJC 5. Plus, for end users, the 74 B tables no area reads (Q6) and the 107 + 7 FK
children of Q4.

Greedy capture list — ONE LOGLEVEL-7 analysis per area, each capture resolving every residue table that area reads
(upper bound: a capture shows the entity + privilege of every secured VO in the analysis):

| # | area to capture | residue tables reached | cumulative |
|---|---|---|---|
| 1 | Costing - Cost Accounting Real Time | 9 | 9 |
| 2 | Benefits - Action Items Real Time | 8 | 17 |
| 3 | Supply Chain Planning Real Time | 8 | 25 |
| 4 | Marketing - CRM Campaign Performance | 7 | 32 |
| 5 | Workforce Learning - Learning Management Real Time | 5 | 37 |
| 6 | Benefits - Person Information Real Time | 4 | 41 |
| 7 | CRM - Sales Predictor Input | 4 | 45 |
| 8 | Projects - Labor Distribution Cost Analysis Real Time | 4 | 49 |
| 9 | Supplier Qualification - Qualifications and Assessments Real Time | 4 | 53 |
| 10 | Public Sector Cloud - Deposit Account Real Time | 4 | 57 |
| 11–15 | Budgetary Control - Transactions; Product Management - Item Supplier Uploads; Recruiting - Recruiting; Loyalty - Vouchers; Payroll - Payroll Balances | 3 each | 72 |

15 captures reach 72 of the 143; the long tail (71 tables) is 1–2 tables per area. By family (first blocking area):
Public Sector Cloud 16, Costing 12, Payroll 8, Product Management 7, Supply Chain Planning 7, Benefits 6, CRM 6,
Projects 6, Sales 6, Supplier Qualification 6. The HCM families (Benefits, Payroll, Workforce Learning, Compensation:
45 tables) need the restricted HCM user of decision 4. The same captures also validate the strictest / consensus
picks of their areas (they replace a `strictest` grade by `trace`).

## Q6 — Facts that show the model is wrong or unusable for end users

1. **Reference data decides usability.** End-user baseline reads 150 of 1,142 A tables (13 %) and 71 of 300 B
   (24 %): every lookup / currency / calendar / org-name table is an unverified `none`, and almost every real question
   joins one. With Q1 + Q2 + the FK none-rule: A 887 (78 %), B 188 (63 %). Without a none-rule end-user mode is not
   usable.
2. **74 of the top-300 BIP tables are read by NO subject area** (2,718 of 12,485 = 22 % of those tables' BIP
   statements): `HR_ALL_ORGANIZATION_UNITS_TL`, `FND_LOOKUP_VALUES_VL`, `PER_IMAGES`, the ZX / JE / JG tax-reporting
   tables, `CE_BANK_ACCT_USES_ALL`, `POZ_SUPPLIER_SITES_V`, `GL_SETS_OF_BOOKS`, `FLA_LEASES_ALL`, `AP_1099_TAPE_DATA_ALL`…
   Under area keying an end user can never read them.
3. **The whitelist hides the columns correct SQL needs.** Of the top-300 BIP tables read by an area, on average 24 %
   (median 18 %) of the columns are exposed. Of 1,124 corpus FILTER columns on those tables, 534 are exposed somewhere,
   **334 are hidden in every area** (256 more belong to no-area tables); the hidden ones include the structural
   discriminators: `HR_LOOKUPS.LOOKUP_TYPE`, `AR_LOOKUPS.LOOKUP_TYPE`, `AP_LOOKUP_CODES.LOOKUP_TYPE`,
   `XLA_LOOKUPS.LOOKUP_TYPE`, `GL_LEDGERS.OBJECT_TYPE_CODE`, `HZ_CONTACT_POINTS.OWNER_TABLE_NAME`, `HZ_RELATIONSHIPS.SUBJECT_TYPE`
   — a lookup join without LOOKUP_TYPE is wrong SQL. Of 702 corpus JOIN columns 273 are hidden (the joinOnly keys
   recover some). Recommendation: a `filterOnly` key class = the corpus filter columns (`table_predicates`) — usable in
   WHERE / JOIN, never selected.
4. **The OTBI lineage lacks the security joins** (Q3, Q4): any VO-based rule for the context or for `none` is blind.
5. **The `rule` grade is not OTBI-proven:** on the known areas, of the 161 (area, table) cases where the rule picks
   ONE class, 21 (13 %) pick a different privilege than OTBI — every one an SCM area secured by DOO's privilege.
   End-user mode currently reads `rule` (83 of A's 166 secured).
6. **Strictest empties often** (Q1 probe: 5 of 14 tables empty for the trace user although a candidate grants rows).
7. **HCM coverage is weak:** 24 HCM areas have no guide code on the pod (never held), the 14 specific payroll duties
   are reached by no guide code, 30 + 15 HCM residue tables need the restricted HCM user + traces.

## Revised phase 3 — ordered steps with the measured gain

1. **FK none-rule + `filterOnly` keys** (release fact: per table, its declared FK parents that are secured; resolver:
   a `none` table without one is `structural`-readable for end users; the whitelist gains `filterOnly`). Gain: end-user
   **A +597, B +91** readable; correct lookup joins. No pod work.
2. **Strictest of candidates** (decision 2), scoped: own-module tables only, the known area privilege AND-ed in when
   present, a pair cap (≤ 6 classes = A 69 / B 11 of the 120 / 18) or no cap; answer names the rule + the missing
   privilege. Gain: **A +120 (+121 end-user), B +18 (+19)**; U-only variant A +46, B +13.
3. **Job-role consensus** (loader v4 `role_grants` page + `otbi_area_job` from the guides; grade `consensus`, ranked
   above `strictest`). Gain alone A +42 / B +13; on top of 2: **A +18, B +7**, and 43 strictest ANDs become one pair.
   Also flags `rule` picks outside the area's job-held set (Q6.5).
4. **Trace program re-targeted** (decision 12 widened): the 15 captures of Q5 (+72 residue tables, upper bound) +
   the per-prefix audits for the context class (AR, CST/CMR, FA, VRM, PJC); each capture replaces `strictest` /
   `consensus` by `trace` in its area.
5. **HCM**: the restricted HCM user (decision 4) + captures of Benefits / Payroll / Workforce Learning (45 residue
   tables).
6. **C3 crawl-slot extractor** (the plan's original phase 3) only as the evidence source for `none` and slot
   conflicts once 1–3 land — it no longer gates usability.

## Decisions for the user

1. Accept the **declared-FK none-rule** (grade `structural`) for end-user readability instead of the VO-structural
   rule (unreliable: the lineage lacks security joins) or waiting for the crawl extractor?
2. **Strictest scope:** include pool-2 candidates (75 of the 120 A tables; not OTBI-visible) or U-only (46)? Cap the
   pairs (≤ 6 classes) or not? Accept "no access" for users missing one candidate (5 of 14 for the trace user)?
3. Adopt the **job-role consensus** (loader v4 page, names only) as a grade above strictest?
4. Add **`filterOnly`** columns (filter on columns OTBI does not display — a deliberate deviation needed for correct SQL)?
5. Policy for the **74 no-area BIP tables**: never readable by end users (OTBI parity) or curated per-table exceptions?
6. Keep the **`rule` grade** readable for end users (13 % mismatch on the known cross-product areas) or require the
   consensus check / strictest when the area is cross-product?
7. Approve the **re-targeted capture list** (15 analyses, a user who holds those areas, BI admin LOGLEVEL 7).

## Appendix A — SQL used

### Pod (read-only, `runSql`, one at a time ≥ 5 s apart; names / counts / verdicts only)

```sql
-- P1: active ALLOW grants by grantee kind
SELECT CASE WHEN g.role_name LIKE 'ORA\_%\_JOB' ESCAPE '\' THEN 'seeded job'
            WHEN g.role_name LIKE 'ORA\_%\_DUTY%' ESCAPE '\' THEN 'seeded duty'
            WHEN g.role_name LIKE 'ORA\_%\_ABSTRACT' ESCAPE '\' THEN 'seeded abstract'
            WHEN g.role_name LIKE 'ORA\_%' ESCAPE '\' THEN 'seeded other'
            WHEN g.role_name IS NULL THEN 'no role name' ELSE 'custom' END AS role_kind,
       COUNT(*) AS grants, COUNT(DISTINCT g.role_name) AS roles, COUNT(DISTINCT g.object_id) AS objects,
       SUM(CASE WHEN g.instance_type = 'SET' THEN 1 ELSE 0 END) AS set_grants,
       SUM(CASE WHEN g.instance_type = 'GLOBAL' THEN 1 ELSE 0 END) AS global_grants
FROM fnd_grants g
WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)
GROUP BY <the same CASE> ORDER BY 2 DESC;

-- P2 (count, then the rows as a stored XML result): the guide job roles' grants on the blocked classes' objects
SELECT DISTINCT g.role_name AS r, o.obj_name AS o, ff.function_name AS p
FROM fnd_grants g JOIN fnd_objects o ON o.object_id = g.object_id
JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
JOIN fnd_form_functions ff ON ff.function_id = cmf.function_id
WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)
  AND o.obj_name IN (<the 74 objects>) AND g.role_name IN (<the 212 guide job codes>)
ORDER BY 2, 3, 1;                                   -- 4,306 rows

-- P3: access verdict per candidate pair for the running user (no predicate text leaves the pod)
WITH
FUNCTION osaas_acc(p_obj VARCHAR2, p_priv VARCHAR2) RETURN VARCHAR2 IS
  l_pred CLOB; l_status VARCHAR2(30); l_head VARCHAR2(200);
BEGIN
  FND_DATA_SECURITY.GET_SECURITY_PREDICATE(p_api_version => 1.0, p_privilege => p_priv, p_object_name => p_obj,
    p_grant_instance_type => 'UNIVERSAL', p_statement_type => 'OTHER', x_predicate => l_pred,
    x_return_status => l_status, p_table_alias => 'sec$');
  IF NVL(l_status, '?') <> 'T' THEN RETURN 'error:' || NVL(l_status, '?'); END IF;
  IF NVL(DBMS_LOB.GETLENGTH(l_pred), 0) > 60 THEN RETURN 'restricted'; END IF;
  l_head := REPLACE(REPLACE(REPLACE(DBMS_LOB.SUBSTR(l_pred, 60, 1), ' ', ''), CHR(10), ''), CHR(13), '');
  IF l_head = '(1=2)' THEN RETURN 'none'; END IF;
  IF l_head = '(1=1)' THEN RETURN 'global'; END IF;
  RETURN 'restricted';
EXCEPTION WHEN OTHERS THEN RETURN 'X';
END;
pairs AS (SELECT 1 AS n, '<object>' AS o, '<privilege>' AS p FROM dual UNION ALL …)   -- 47 pairs
SELECT n, o, p, osaas_acc(o, p) AS acc FROM pairs ORDER BY n;

-- P4: customer job copies vs their seeded twin on 8 key objects (identical / subset / superset)
WITH g AS (SELECT DISTINCT g.role_name AS r, o.obj_name AS o, ff.function_name AS p FROM fnd_grants g JOIN … WHERE <active ALLOW>
           AND o.obj_name IN (<8 objects>) AND (g.role_name LIKE 'ORA\_%\_JOB' ESCAPE '\' OR <a non-ORA role containing _JOB>)),
c AS (SELECT DISTINCT r AS copy_role, 'ORA_' || REGEXP_REPLACE(REGEXP_REPLACE(r, '^[A-Z0-9]+_', ''), '(_NEW|_COPY|_CUSTOM)+$', '') AS seeded_role
      FROM g WHERE r NOT LIKE 'ORA\_%' ESCAPE '\'),
pairs AS (SELECT c.* FROM c WHERE EXISTS (SELECT 1 FROM g WHERE g.r = c.seeded_role)),
cmp AS (SELECT p.copy_role, p.seeded_role,
          (SELECT COUNT(*) FROM g a WHERE a.r = p.copy_role AND NOT EXISTS (SELECT 1 FROM g b WHERE b.r = p.seeded_role AND b.o = a.o AND b.p = a.p)) AS only_copy,
          (SELECT COUNT(*) FROM g b WHERE b.r = p.seeded_role AND NOT EXISTS (SELECT 1 FROM g a WHERE a.r = p.copy_role AND a.o = b.o AND a.p = b.p)) AS only_seeded
        FROM pairs p)
SELECT COUNT(*) AS copy_pairs, SUM(CASE WHEN only_copy = 0 AND only_seeded = 0 THEN 1 ELSE 0 END) AS identical, … FROM cmp;
```

### Served database (read-only; temp tables in a rolled-back transaction)

```sql
-- Q4 VO-structural rule (tmp_none = the population tables whose best-area verdict is none)
CREATE TEMP TABLE reg AS SELECT obj_name AS name FROM customer.sec_instance_object WHERE instance = :'H'
                         UNION SELECT database_object_name FROM customer.sec_instance_object WHERE instance = :'H';
CREATE TEMP TABLE occ AS
SELECT n.table_name, v.subject_area, v.folder, v.vo_def, o.obj
FROM tmp_none n JOIN :V.otbi_vo v ON v.db_objects::jsonb ? n.table_name
CROSS JOIN LATERAL jsonb_array_elements_text(v.db_objects::jsonb) AS o(obj) WHERE o.obj <> n.table_name;
-- per table: VO occurrences, the registered objects met in them; verified = occurrences > 0 and none met

-- the security entity in the lineage: VOs of a curated area that list the entity the area binds
SELECT a.area_or_product, a.entity_table, count(DISTINCT (v.folder, v.vo_def)) AS vos,
       count(DISTINCT (v.folder, v.vo_def)) FILTER (WHERE v.db_objects::jsonb ? a.entity_table) AS vos_with_entity
FROM :V.sec_area_privilege a
JOIN :V.otbi_subject_area s ON s.name = a.area_or_product OR s.name LIKE a.area_or_product || ' %'
JOIN :V.otbi_vo v ON v.subject_area = s.name WHERE a.entity_table IS NOT NULL GROUP BY 1, 2;

-- Q4 declared-FK rule: none tables with a declared FK to a secured table (a context column, or a registered object with grants)
SELECT DISTINCT n.table_name FROM tmp_none n
JOIN :V.fkeys f ON f.child_table = n.table_name
 AND f.parent_table IN (SELECT table_name FROM :V.table_security WHERE confidence <> 'ambiguous'
                        UNION SELECT o.database_object_name FROM customer.sec_instance_object o
                              WHERE o.instance = :'H' AND EXISTS (SELECT 1 FROM customer.sec_instance_privilege p
                                                                  WHERE p.instance = o.instance AND p.obj_name = o.obj_name));

-- Q6 corpus filter / join columns vs the exposure index (top-300 BIP tables)
SELECT how, count(*) AS used_columns,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM exposed e WHERE e.table_name = u.table_name AND e.db_column = u.column_name)) AS exposed_somewhere,
       count(*) FILTER (WHERE NOT EXISTS (… = u.column_name) AND EXISTS (SELECT 1 FROM exposed e WHERE e.table_name = u.table_name)) AS hidden_in_every_area
FROM (SELECT table_name, column_name, 'filter' AS how FROM :V.table_predicates … UNION ALL
      SELECT table_name, column_name, 'join' FROM :V.table_join_columns …) u GROUP BY 1;
```

The per-(table, area) verdicts come from the product resolver itself (`dataSecurityFor(table, instance, area)` over
the collector's area list); the levers were simulated over its output: strictest = an ambiguity with ≥ 2 candidates on
one object; consensus = the Q2 rule on the blocked object (or, for the context class, on each context's reference
object, accepted when exactly one context gets a pick).
