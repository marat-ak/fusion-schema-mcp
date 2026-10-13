# OTBI LOGLEVEL-7 trace capture guide (data-access security, revised phase 3)

**Why.** A data-access condition is only *proven* when an OTBI LOGLEVEL-7 trace shows the grant block OTBI itself
puts on a table: the security object, the privilege, the entity table that carries the block and the column the
query joins to it. Everything else the resolver uses is graded weaker (`inferred`, `rule`, `consensus`,
`strictest`). One capture of one subject area decides every residue table that area reads and upgrades the
area's `strictest` / `consensus` picks to `trace`. The capture list below is the approved re-plan list
(`docs/data-access-replan-2026-10-05.md` Q5): 15 analyses, in rank order, reaching the most residue tables first.

**What is captured and what is kept.** The capture (the Session Monitor page) contains the physical SQL with the
customer's grant predicates, user names and pod ids — it is customer data and stays **local**: drop it into
`fusion-schema-mcp/data/security/traces/` (gitignored). The loader (`scripts/pipeline/sec_trace.py`) keeps only
NAMES in the curated rules — object, privilege, entity table, `TABLE.COLUMN` — and, as evidence, the file name and
the SHA-256 + length of the grant blocks. Predicate text is never stored anywhere tracked.

## Who captures

- A user who **holds the subject area** (its duty role, as the analysis must return rows) **and** may set
  `LOGLEVEL` (the BI administrator privilege to set the session log level and to open *Manage Sessions*).
- **HCM areas (Benefits, Workforce Learning, Recruiting, Payroll) need the restricted HCM user** (decision 4): a
  user restricted by HCM security profiles (person / organization / payroll), NOT a global HR administrator — a
  global user's trace shows the `(1=1)` / view-all shape and decides nothing.
- Same pod as the layer the answer will use (the Kornit TEST host for now).

## The capture, step by step

1. **Analytics → New → Analysis**, pick the subject area exactly as named in the table below.
2. Add the folders / columns listed for the area (one column from each listed folder is enough; keep a measure of
   the fact folder so the BI server generates the fact query). Add a narrow filter (one period / a few days) so the
   run is quick — never remove the area's own security (no admin "bypass").
3. **Advanced** tab → *Prefix* box: `SET VARIABLE LOGLEVEL=7;` → *Apply SQL*.
4. **Results** tab — let the analysis run to completion (rows or "no results" both work: the SQL is logged either
   way).
5. **Administration → Manage Sessions** (the *Session Monitor*) → the cursor of your analysis (the newest one for
   your user) → **View Log**. Check that the log shows `Sending query to database` followed by `[[ … ]]` blocks
   containing `fnd_grants gnt` — if not, the LOGLEVEL prefix was not applied (step 3) or the area is not secured
   for that user.
6. Save the log page from the browser: **Save Page As → Web Page, Single File** (`.mhtml`) — or *Web Page,
   Complete* (`.html`). Both formats load.
7. File name: `NN-<area slug>-<YYYY-MM-DD>.mhtml`, `NN` = the rank below, the slug lower-case with dashes, e.g.
   `01-costing-cost-accounting-real-time-2026-10-07.mhtml`; a second capture of the same area adds `-b`.
   Drop it into `fusion-schema-mcp/data/security/traces/`.

## Loading a capture (developer, after the drop)

```bash
T=/mnt/c/.../fusion-schema-mcp; C=01-costing-cost-accounting-real-time-2026-10-07
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py extract data/security/traces/$C.mhtml --out data/security/traces/$C"
# run data/security/traces/$C/resolve.sql through pod-mcp runSql (read-only, one statement) on the SAME pod;
# save the reply verbatim as data/security/traces/$C/resolve.json
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py load data/security/traces/$C --area 'Costing - Cost Accounting Real Time' --instances <pod host> --dry-run"
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py load data/security/traces/$C --area 'Costing - Cost Accounting Real Time' --instances <pod host>"
```

The rows land in `scripts/pipeline/p5_security_rules.json` (`areaPrivileges`, source `trace`); the next release
label carries them (full chain, then `p9_release.sh`). `--instances` = the pod host (a trace proves the pair on that
pod); `*` only when the reviewer accepts the pair as Oracle-seeded for every pod. A trace that disagrees with an
existing trace row of the same (area, object) is refused — decide by hand.

## The 15 analyses, in rank order

Residue tables = the tables of the two coverage populations (OTBI fact tables, top-300 BIP tables) that release
v2027_08 still cannot secure for a developer in ANY of their areas and that no end-user rule (consensus, strictest)
reads either — computed from `scripts/pipeline/security_coverage_resolver.mts` on the Kornit TEST layer
(2026-10-05-v4): 219 tables; these 15 areas reach 88 (area, table) pairs. Per table: why it is blocked today, and
the folder(s) / presentation column(s) of the area that read it — put at least one listed column of each table in the
analysis (a measure of the area's fact folder too). The list is a starting point: a capture shows every secured
block of the analysis, so adding more folders of the same area costs nothing.

### 01. Costing - Cost Accounting Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `CST_COST_ELEMENTS_B` | the area decides no context | Cost Element → Cost Element Code, Cost Element Type Code, CST_COST_ELEMENTS_B_FLEX_CONTEXT_ |
| `EGP_SYSTEM_ITEMS_VL` | no privilege of the module on the object | -  Main → Item Style Item |
| `EGP_TRADING_PARTNER_ITEMS` | no named grant on the object | - Order Details → Customer Item Name |
| `FUN_ALL_BUSINESS_UNITS_V` | no privilege of the module on the object | Inventory Organization → Inventory Organization Business Unit Name; Prior Inventory Organization → Prior Organization Business Unit Name; Procurement Business Unit → Business Unit Date From, Business Unit Date To, Business Unit Status …; (+2 more folder(s)) |
| `INV_MATERIAL_TXNS` | the area decides no context | Inventory Transaction Details → Created By, Creation Date, Last Updated By … |
| `MSC_ANALYTIC_ITEMS` | no privilege of the module on the object | -  Inventory → Inventory Item; -  Lead Times → Cumulative Manufacturing Lead Time, Fixed Lead Time, Postprocessing Lead Time …; -  Main → Item Name |
| `PJF_PROJECTS_ALL_B` | HCM area duty unmapped / not holding it | Inventory Project → Contract Association Level, Current Project Status Code, PJF_PROJECTS_DESC_FLEX_LOCATION_ …; Inventory Project Date Attributes → Completion Date, Project Close Date, Project Start Date; Inventory Project Indicator Attributes → Capital Interest Eligible Flag, Cross Charge Flag, Cross Charge Nonlabor Flag …; (+9 more folder(s)) |
| `PJF_PROJ_ELEMENTS_B` | HCM area duty unmapped / not holding it | Inventory Task → ETC Calculation Method Name, Percent Complete Calculation Method Name, Project Management Source Code Name …; Inventory Task Codes → LOV Attribute 01, LOV Attribute 02, LOV Attribute 03 …; Inventory Task Indicator Attributes → Allow Cross Charge Flag, Billable Flag, Capitalizable Flag …; (+5 more folder(s)) |
| `PJF_PROJ_ELEMENTS_VL` | HCM area duty unmapped / not holding it | Inventory Project Codes → LOV Attribute 01, LOV Attribute 02, LOV Attribute 03 …; Inventory Task → Allow Capitalized Interest, ETC Calculation Method Name, Last Update Login …; Inventory Task Codes → LOV Attribute 01, LOV Attribute 02, LOV Attribute 03 …; (+7 more folder(s)) |
| `RCV_SHIPMENT_HEADERS` | the area decides no context | Inventory Transaction Details → Transaction Source Reference; - OSP PO Receipt → Receipt Header Number; - PO Receipt → Way Bill |
| `WIE_WORK_ORDERS_B` | the area decides no context | Work Order → Actual End Date, Actual Start Date, Back To Back Enabled …; Work Order Header Descriptive Flexfields → Work Order Key |

### 02. Benefits - Action Items Real Time — **HCM: capture with the restricted HCM user**

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `BEN_PER_BNF_ORG` | HCM object, no analysis-duty grant | Beneficiary → Existing Organization Name, Trustee Organization Name; Benefit Action Type → Existing Organization Name, Trustee Organization Name |
| `BEN_PER_LE_HABITS_COV_F` | HCM object, no analysis-duty grant | Benefit Person Habits → Coordinated Medical Plan Name, Covered In Another Plan, Created By … |
| `FND_SETID_SETS_VL` | no privilege of the module on the object | Department → Location Set Name, Set Name; Grade → Set Name; Grade Ladder → Grade Set; (+2 more folder(s)) |
| `HR_ORGANIZATION_INFORMATION_F` | HCM area duty unmapped / not holding it | Department_Canada Provincial Medical Department Information → Department_ORG_INFORMATION_EFF_ORA_HRX_CA_PM_DEPT_EffectiveEndDate, Department_ORG_INFORMATION_EFF_ORA_HRX_CA_PM_DEPT_EffectiveStartDate, Department_ORG_INFORMATION_EFF_ORA_HRX_CA_PM_DEPT_oraHrxCaPmDeptAccount …; Department_Canada Workers Compensation Department Information → Department_ORG_INFORMATION_EFF_ORA_HRX_CA_WC_DEPT_EffectiveEndDate, Department_ORG_INFORMATION_EFF_ORA_HRX_CA_WC_DEPT_EffectiveStartDate, Department_ORG_INFORMATION_EFF_ORA_HRX_CA_WC_DEPT_oraHrxCaWcDeptClUnit …; Department_France Department Information → Department_ORG_INFORMATION_EFF_HRX_FR_DEPT_CORPORATE_INFO_EffectiveEndDate, Department_ORG_INFORMATION_EFF_HRX_FR_DEPT_CORPORATE_INFO_EffectiveStartDate, Department_ORG_INFORMATION_EFF_HRX_FR_DEPT_CORPORATE_INFO_OrgInformationContext …; (+18 more folder(s)) |
| `INV_ORGANIZATION_DEFINITIONS_V` | the area decides no context | Location → Inventory Organization |
| `PER_ASSIGNMENT_SUPERVISORS_F` | HCM area duty unmapped / not holding it | Manager → Assignment Identifier, Manager Type, Manager Type Code …; Worker → Manager Assignment ID, Manager Assignment Primary Flag, Manager ID … |
| `PER_USERS` | HCM object, no analysis-duty grant | Manager → User Name; Worker → Employee Gender Code, Employee User Guid, Manager User Name … |
| `XLE_ENTITY_PROFILES` | no privilege of the module on the object | Legal Employer → Legal Employer Identifier |

### 03. Supply Chain Planning Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `EGP_ITEM_CATEGORIES` | no privilege of the module on the object | Inventory Item → Category Set Id |
| `MSC_ANALYTIC_FACT_CTO_V` | no privilege of the module on the object | Configure to Order Forecast Metrics → Final Option Demand Forecast, Final Planning Percent, Option Demand Forecast; Order Details → Demand Date |
| `MSC_ANALYTIC_FACT_DM_V` | no privilege of the module on the object | Demand Management Metrics → Bookings Forecast, Bookings History, Bookings History Value …; Order Details → Demand Date |
| `MSC_ANALYTIC_FACT_EXP` | no privilege of the module on the object | Exception Metrics → Exception Count, Exception Days, Exception Quantity …; Exception Type → Exception Type Id; Order Details → Demand Date |
| `MSC_ANALYTIC_FACT_INV_REPL_V` | no privilege of the module on the object | Inventory Analysis Metrics → Item Locations with Fill Rate Violations, Item Locations with Safety Stock Violations, Item Locations with Stockouts |
| `MSC_ANALYTIC_FACT_ORD_V` | no privilege of the module on the object | Order Details → Action, Actual Start Date, Arrival Set Name …; Order Metrics → Implemented Supply Quantity, Order Quantity, Order Value; Order Type → Order Type |
| `MSC_ANALYTIC_FACT_PEG_V` | no privilege of the module on the object | Order Details → Demand Date; Pegging Metrics → Pegged Quantity |
| `MSC_ANALYTIC_FACT_SOP_V` | no privilege of the module on the object | Order Details → Demand Date; Sales and Operations Planning Metrics → Consensus Forecast, Consensus Forecast Value, Final Sales Forecast … |

### 04. Marketing - CRM Campaign Performance

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `HZ_PARTY_SITES` | ambiguous privilege (pool 2) | Customer Contact Profile → Comments |
| `MKL_LEAD_ITEMS_ASSOC` | no privilege of the module on the object | Lead Facts → Estimated Revenue (Internal) |
| `MKT_RM_RESP_ITEM_ASSOC` | no privilege of the module on the object | Response Facts → Average Response Lag in Days, # Responses |
| `MKT_RM_RESPONSES` | no privilege of the module on the object | Opportunity Facts → Actual Opportunity Conversion Rate; Response → Hyperlink Name, Response Date, Source Response Method Name …; Response Facts → Average Response Lag in Days, Cumulative # Responders (Unique), % of Response Type … |
| `MKT_TM_TREATMENTS` | no privilege of the module on the object | Treatment → Treatment Channel, Treatment End Date, Treatment Id … |
| `MKT_TM_TRMT_ITEM_ASSOC` | no privilege of the module on the object | Offer Facts → # Offered Products |
| `MOO_REVN` | no privilege of the module on the object | Opportunity → Sales Channel, Sales Channel Code; Opportunity Facts → Actual Opportunity Conversion Rate, Closed Opportunity Revenue, Close Rate …; Order Facts → Average Order Size |
| `QSC_PROD_GRP_ITEMS_TREE_V` | no privilege of the module on the object | Product → Offered Ordered Product |

### 05. Workforce Learning - Learning Management Real Time — **HCM: capture with the restricted HCM user**

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `HRT_CONTENT_TYPES_B` | HCM object, no analysis-duty grant | - All Learning Outcome Profile Content → Content Type Id, Free Form; All Learning Prerequisite Profile Content → Content Type Id, Context Name, Free Form; All Profile Content → Content Type Id, Context Name, Free Form; (+10 more folder(s)) |
| `WLF_ASSIGNMENT_RECORDS_F` | HCM object, no analysis-duty grant | Assignment Status → Sub Status; Cost Details → Cost Details Line Amount, Cost Details Line Type, Line Used for Learner Cost; Learning Record Details → Assigned By Person Number, Assigned On Date, Assignment Record Creation Date …; (+2 more folder(s)) |
| `WLF_EVENTS` | HCM object, no analysis-duty grant | Assignment Profiles → Assigned By Person Identifier, Attributed Assigner; Event Details → Event Creation Date (As Date), Event Creation Date (As Indexed), Event Creation Date (As Timestamp); Inappropriate Learning Event → Event Incident Count, Event Incident Learning Item Count; (+2 more folder(s)) |
| `WLF_LEARNING_ITEMS_F` | HCM object, no analysis-duty grant | Duration Buckets → Longer than one hour count, Longer than one week count, One day to one week count …; Learning Item Duration Unit of Measure → Code, Description, Name; Learning Item Measures → Average Duration, Content Count, Course Count …; (+9 more folder(s)) |
| `WLF_LI_CONTENT_F` | HCM area duty unmapped / not holding it | Duration Buckets → Longer than one hour count, Longer than one week count, One day to one week count …; Learning Item Measures → Total Duration; Learning Record Tasks → Mastery Score, Maximum Allowed Attempts, Score Hidden From Learner …; (+1 more folder(s)) |

### 06. Benefits - Person Information Real Time — **HCM: capture with the restricted HCM user**

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `BEN_PER_BENEFIT_GROUP_F` | HCM object, no analysis-duty grant | Fact - Person Benefit Group → Count of Person Benefit Groups; Person Benefit Group → Benefit Group Name, Created By, Creation Date … |
| `BEN_PER_BNFTS_BAL_F` | HCM object, no analysis-duty grant | Fact - Person Benefit Balances → Count Of Person Balance Records; Person Benefit Balance → Created By, Creation Date, Effective End Date … |
| `BEN_PER_LE_HABITS_COV_F` | HCM object, no analysis-duty grant | Benefit Person Habits → Coordinated Medical Plan Name, Covered In Another Plan, Created By …; Fact - Benefit Person Habits → Count Of Person Habits |
| `BEN_QSTNR_RESPONSES` | HCM object, no analysis-duty grant | Benefits Survey Questionnaire Responses → Number Of Responses, Response Submitted Date Time |
| `HRT_NOTES` | HCM object, no analysis-duty grant | Benefits Notes → Benefits Notes, Benefits Notes Author, Benefits Notes Created By … |

### 07. CRM - Sales Predictor Input

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `FND_TERRITORIES_TL` | registered without a grant | Customer → Country; Revenue → Customer Country |
| `ZCA_AGREEMENT_ITEM` | no privilege of the module on the object | Agreement → Agreement Line Item Quantity |
| `ZCA_ASSET` | no privilege of the module on the object | Asset → Asset End Date, Asset Name, Asset Number …; Asset Facts → Quantity of Assets |
| `ZCA_BI_PRODUCT_DENORM` | no privilege of the module on the object | Agreement → Fixed Hierarchy Level, Product Integration Id, Product Name …; Asset → Hierarchy Level, Product Integration Id, Product Name …; Lead → Marketing Lead Status, Product Integration Id; (+3 more folder(s)) |

### 08. Projects - Labor Distribution Cost Analysis Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `PJC_ALLOC_RULES_ALL` | ambiguous privilege (pool 2) | Labor Schedules Details → Labor Version Comments, Labor Version Name, Labor Version Start Date …; - Labor Schedule Version Record Information → Labor Rules Created By, Labor Rules Created Date, Labor Rules Last Updated By … |
| `PJC_ALLOC_RUNS_ALL` | ambiguous privilege (pool 2) | - Allocation Run Record Information → Allocation Run Created By, Allocation Run Creation Date, Allocation Run Last Update Date …; Labor Cost Distributions Details → Batch Name, Cost Allocation Key flex ID, Document Code …; Labor Cost Distributions Measures → Pay Amount |
| `PJC_ALLOC_RUN_TARGETS` | HCM area duty unmapped / not holding it | Labor Cost Distributions Details → Exception Code, Exception Type, Message Details; Labor Cost Distributions Measures → Line Percentage |
| `PJC_ALLOC_TXN_DETAILS` | HCM area duty unmapped / not holding it | Labor Cost Distributions Details → Allocation Txn ID, Exception Type, Expenditure Item Date …; Labor Cost Distributions Measures → Total Allocation |
| `PJC_LD_SCH_TARGET_LINES` | HCM area duty unmapped / not holding it | Labor Schedules Details → Line Number; - Labor Schedule Version Distribution Rule Record Information → Labor Schedule Lines Created By, Labor Schedule Lines Created Date, Labor Schedule Lines Last Updated By … |
| `PJC_RULES_HDR` | the area decides no context | - Labor Schedule Record Information → Labor Header Created By, Labor Header Created Date, Labor Header Last Updated By …; Labor Schedules Details → Labor Schedule Type, Pay Element Id, Rule Header ID …; Payroll Costing Configuration → Legislative Data Group ID, Payroll Costing Concatenated Segments, Precedence |

### 09. Supplier Qualification - Qualifications and Assessments Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `POQ_ASSESSMENTS` | no privilege of the module on the object | Assessment → Assessment Evaluation Cycle Time (Days), Assessment Validity Time (Days), Count of Active Assessments …; Assessment Detail → Assessment, Assessment Automatically Evaluated, Assessment Creation Date … |
| `POQ_QUAL_ASMT_INIT_V` | no privilege of the module on the object | Assessment Detail → Assessment, Assessment Automatically Evaluated, Assessment Creation Date …; Assessment Qualification Detail → Automatically Evaluated, Automatic Requalification On Expiration, Automatic Requalification On New Response …; Initiative Detail → Automatically Accept Questionnaire Responses, Automatically Populate Questionnaire Responses, Cancellation Date …; (+2 more folder(s)) |
| `POQ_QUESTNAIRE_RESP_HEADERS` | no privilege of the module on the object | Qualification Survey Response Detail → Surrogate Response Entry Date, Surrogate Response Flag; Questionnaire Response Header → Count of Internal Questionnaires, Count of Supplier Questionnaires, Expected Questionnaire Response Cycle Time (Days) …; Questionnaire Response Header Detail → Acceptance Date, Acceptance Note, Cancellation Date … |
| `POQ_QUESTNAIRES_VL` | no privilege of the module on the object | Questionnaire Response Header → Count of Internal Questionnaires, Count of Supplier Questionnaires, Expected Questionnaire Response Cycle Time (Days); Questionnaire Response Header Detail → Due Date, Questionnaire Title, Questionnaire Type |

### 10. Public Sector Cloud - Deposit Account Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `PSC_BNP_DEPOSIT_ACCOUNT` | no privilege of the module on the object | Deposit Account → Access Type, Account Description, Account Lock …; Fact - Deposit Account → Count of Accounts Below Minimum Balance, Count of Active Accounts, Count of Active Accounts Pending Verification … |
| `PSC_BNP_DEPOSIT_ACCOUNT_ACTVTY` | no privilege of the module on the object | Deposit Account Activity → Account Number, Activity, Activity Origin …; Fact - Deposit Account → Balance, Begin Balance, Deposit Total … |
| `PSC_BNP_DEPOSIT_ACCOUNT_FUND` | no privilege of the module on the object | Deposit Account Fund → Account Number, Amount, Currency …; Fact - Deposit Account → Count of Active Accounts where Financial Guarantee Instrument has Expired |
| `PSC_LNP_FEE_RECORD` | no privilege of the module on the object | Fee Status → Fee Item, Fee Status |

### 11. Budgetary Control - Transactions Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `CMR_RCV_EVENTS` | the area decides no context | Receipt Accounting Distributions Details → Budgetary Control Enabled, Encumbrance Accounting Enabled, Funds Reservation Status; Receipt Accounting Transactions → Primary Quantity, Source Document Quantity, Transaction Amount …; Receipt Accounting Transactions Details → Accounted, Accounted Date, Accounting Receipt Number … |
| `FUN_ALL_BUSINESS_UNITS_V` | no privilege of the module on the object | Requisition Header - General Information → Requisition Business Unit Name |
| `OKC_K_HEADERS_VL` | the area decides no context | Invoice Distributions - Project Information → Award Name, Award Number |
| `PJF_PROJECTS_ALL_B` | the area decides no context | Control Budget → Source Budget Name; Invoice Lines - Project Information → Project Number; Project Details → Project Close Date, Project Number, Project Priority Name …; (+2 more folder(s)) |
| `PJF_PROJ_ELEMENTS_B` | HCM area duty unmapped / not holding it | Invoice Lines - Project Information → Task Number; Project Expenditures → Task Number |
| `PJF_PROJ_ELEMENTS_VL` | HCM area duty unmapped / not holding it | Payables Transaction Details → Task Name; Purchase Order Distributions - Project Information → Task Name; Requisition Distributions - Project Information → Task Name |
| `PO_DISTRIBUTIONS_DRAFT_ALL` | the area decides no context | Payables Transaction Details → Capitalization Flag, Project Expenditure Item Date; Purchase Order Distributions - General Information → Budget Date; Purchase Order Distributions - Project Information → Capitalization Flag, Project Expenditure Item Date |
| `POR_REQ_DISTRIBUTIONS_ALL` | the area decides no context | Requisition Distributions → Requisition Distribution Amount, Requisition Distribution Non-Recoverable Tax, Requisition Distribution Quantity …; Requisition Distributions - General Information → Budget Date, Distribution, Funds Status …; Requisition Distributions - Project Information → Capitalization Flag, Project Expenditure Item Date; (+1 more folder(s)) |
| `RCV_SHIPMENT_HEADERS` | the area decides no context | Invoice Distributions - Purchase Order Information → Distribution RCV Receipt Number; Invoice Lines - Purchase Order Information → RCV Receipt Number |
| `XCC_TR_LINES` | the area decides no context | Budgetary Control Transaction Amounts → Ledger Amount, Statistical Amount, Transaction Amount …; Budgetary Control Transaction Details → Budget Date, Currency Conversion Date, Quanity …; Line Amounts → Liquidated Amount, Liquidated Quantity; (+1 more folder(s)) |

### 12. Product Management - Item Supplier Uploads Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `EGO_ITEM_ASSOCIATIONS` | no privilege of the module on the object | Supplier → Supplier Primary Flag |
| `EGP_ITEM_ATTACHMENTS_INTF` | no privilege of the module on the object | Item Supplier Uploads → # of Products Created Without Attachments |
| `EGP_SYSTEM_ITEMS_INTERFACE` | no privilege of the module on the object | Item Supplier Uploads → Average New Item Introduction Cycle Time, # of Products Created, # of Products Created Without Attachments …; Supplier Product → Source Organization Code, Source System Code, Source Type … |

### 13. Recruiting - Recruiting Real Time — **HCM: capture with the restricted HCM user**

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `HRT_CONTENT_TYPES_B` | HCM object, no analysis-duty grant | Candidate - Language → Comments Extended Text, Content Type |
| `IRC_CANDIDATES` | HCM object, no analysis-duty grant | Candidate Details → Added By Flow, Availability Date, Candidate Deletion Date …; Candidate Pool - Member Candidates → Candidate Number; Facts - Candidates → Number of Candidates; (+3 more folder(s)) |
| `IRC_OFFERS` | ambiguous privilege (U) | Facts - Job Offer → Job Offer Acceptance Rate, Number of Active Job Offers, Number of Job Offers …; Job Application - Job Application Dates → Move To HR Date; Job Offer - Basic Information → Accepted Date, Accepted On Behalf, Additional Text 1 …; (+1 more folder(s)) |
| `IRC_REGULATORY_RESPONSES` | HCM object, no analysis-duty grant | - Brazil → CTPS_NUMBER_, CTPS_SERIES_, DATE_ISSUED_ …; - China → EXPATRIATE_v, HEALTH_STATUS_v, HUKOU_LOCATION_v …; Facts - Job Application Legislative Information → Number of Females in Candidate Job Applications, Number of Individuals who Did Not Indicate a Disability in Candidate Job Applications, Number of Individuals with a Disability in Candidate Job Applications …; (+13 more folder(s)) |
| `PER_ASSIGN_WORK_MEASURES_F` | HCM area duty unmapped / not holding it | Job Offer - Assignment Details → Calculate FTE and Headcount Automatically, Full-Time Equivalent, Headcount; Job Offer -  Compensation Details → Annualized Full-Time Salary, Annualized Salary |

### 14. Loyalty - Vouchers Real Time

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `LOY_MEMBER` | no privilege of the module on the object | Member → Class, Class Code, Class Desc …; Referral Source → Created By, Creation Date, Last Update Date … |
| `LOY_MEM_VCHR` | no privilege of the module on the object | Member Voucher Facts → Average Amount per Voucher, Average Quantity per Voucher, # of Accrual Transaction Vouchers …; Voucher → Created By, Creation Date, Discount Percentage … |
| `LOY_TXN` | the area decides no context | Transaction → Activity Date, Amount, Base Points … |

### 15. Payroll - Payroll Balances Real Time — **HCM: capture with the restricted HCM user**

| residue table | blocked today because | folder → columns to include |
|---|---|---|
| `PAY_BALANCE_DIMENSIONS` | HCM object, no analysis-duty grant | Balance Dimension → Balance Dimension Created By, Balance Dimension Creation Date, Balance Dimension ID …; Balance Value → Gross Earnings Relationship RUN, Net Pay Relationship RUN, Net Relationship RUN |
| `PAY_BALANCE_VALIDATION` | HCM object, no analysis-duty grant | Balance Value Details → Run Balance Status, Run Balance Status Code |
| `PAY_PAY_RELATIONSHIPS_DN` | ambiguous privilege (U) | Payroll Relationship → Effective End Date, Effective Start Date, End Date … |
| `PAY_PAYROLL_ACTIONS` | HCM object, no analysis-duty grant | Payroll Actions → Action Status, Action Status Code, Action Type … |

## After the captures

Load each capture (above), build the next release label, reload nothing on the pod side (the customer layer is
unchanged), and re-run `scripts/pipeline/security_coverage_resolver.sh <pod host>`: the traced areas' tables move to
grade `trace`, their `strictest` / `consensus` picks are replaced by the proven pair, and a trace that names the
context column of a multi-context table decides it (`column`). A capture whose blocks disagree with an existing
trace row is refused by the loader — compare the two captures and decide by hand.
