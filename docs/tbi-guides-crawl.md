# TBI subject-area guides crawl (`scripts/pipeline/p3_tbi_guides.py`)

Oracle publishes, per Fusion pillar, a guide "Subject Areas for Transactional Business Intelligence in
<product>" on docs.oracle.com. Its subject-area, duty-role and job-role pages state which duty roles and
job roles secure each OTBI subject area, with the roles' code names. The crawler turns the latest
release of every guide into JSONL keyed on the role **Code Name**. Consumer: the release table
`otbi_area_duty` (plan component C5, wired in phase 2 by the schema-mcp pipeline) for (a) the HCM
privilege choice per area (the area's duties ∩ the pod's duty grants) and (b) the function-gate
fallback branch.

Standalone and read-only: public HTML only; no database, pod or credential is used and no other repo
file is read or written.

## Source and discovery

- **Seed**: the OTBI page "Oracle Fusion Cloud Applications Content",
  `https://docs.oracle.com/en/cloud/saas/otbi/fa-index.html`. It has one "Subject areas" link per
  pillar (`pls/topic/lookup?ctx=fa-latest&id=<BOOK>`), so a pillar Oracle adds there is picked up
  without a code change.
- **Valid guide index** = `https://docs.oracle.com/en/cloud/saas/<product>/[<rel>/]<book>/index.html`
  whose `<meta name="dcterms.isVersionOf">` is the book id. Any other landing fails that guide.
- **Latest release**: a versioned guide (`/<product>/<rel>/<book>/`) is compared with the product hub
  (`/en/cloud/saas/<product>/` redirects to the current release). If the hub is on a newer release
  that publishes the book, the crawl moves to it. Unversioned guides ("FA Latest") have no release in
  the path; their build date (`dcterms.created`) and part number (`dcterms.identifier`) go into
  `guides.jsonl`.
- **TOC**: the guide's `index.html` builds its TOC with JavaScript, which is why rendering fetchers saw
  empty pages. The same TOC is static HTML in `<book>/toc.htm`, with the chapters "Subject Areas",
  "Business Questions", "Job Roles" and "Duty Roles" (`<li><span class="wrap">N Title</span><ul>`).
  The crawler reads the SA, JR and DR chapters. The BQ chapter and each chapter's "Overview" page are
  skipped.

Pitfalls the crawler handles:

| Pitfall | Handling |
|---|---|
| A missing page answers HTTP 200 with a release landing hub (soft 404). Example: every versioned HCM slug (`human-resources/26d/faohb/…`) lands on `human-resources/index.html` | A fetch counts only if it ends on the requested URL (fragment and percent-encoding ignored). Anything else is recorded as a failed page |
| HCM, Sales/Service, Risk and Student guides exist only unversioned ("FA Latest") | `guide_release` = the published label `FA Latest`. The build date and part number go into `guides.jsonl` |
| PSSAG (Permitting and Licensing): Oracle's own fa-index link is a 404 (it uses the wrong lookup context; the guide lives under `public-sector-compliance-regulation-common`) | The operator passes `--guide-index PSSAG=<index URL>`. Without it the run fails on PSSAG and names it |
| Responses have no charset header, so requests would decode them as ISO-8859-1 | Bodies are decoded as UTF-8, which every page declares |

Politeness: one request at a time, at least 1.1 s apart, `User-Agent:
oservices-fusion-schema-mcp/p3_tbi_guides (…)`. Network errors, 429 and 5xx are retried 5 times with
exponential backoff, and `Retry-After` is honoured.

## Page model

| Page (TOC chapter) | Read | Example |
|---|---|---|
| subject area (`Subject Areas`) | `<h1>` = area name. Sections "Job Roles" and "Duty Roles": `li > a.xref` link to the role pages | `Payables-Invoices-Transactions-Real-Time-SA-193.html` |
| duty role (`Duty Roles`) | section "Code Name" (`FBI_*_DUTY`, …), "Job Roles", "Subject Areas" | `FBI_PAYABLES_INVOICE_TRANSACTION_ANALYSIS_DUTY` |
| job role (`Job Roles`) | section "Code Name" (`ORA_*_JOB`; a few self-service reporting *duties* are listed in this chapter and keep their own codes), "Duty Roles", "Subject Areas" | `ORA_AP_ACCOUNTS_PAYABLE_SPECIALIST_JOB` |

A role reference resolves through its link to the crawled page's Code Name. File names and page ids
differ per release, so nothing is keyed on them. An unlinked reference resolves by exact name among the
guide's role pages. Anything else goes to `unresolved` in `guides.jsonl` and produces no row.

## Output: `data/otbi/tbi_guides/<release>/`

`<release>` = the highest versioned guide release crawled, in lowercase (e.g. `26d`). The "FA Latest"
guides are the current documentation at that release. A new Oracle release lands in a new directory.

| File | One row per | Fields |
|---|---|---|
| `area_duty.jsonl` | (guide, subject area, duty), from the SA page's "Duty Roles" list | `subject_area, duty_code, duty_name, guide, guide_release, url` (SA page) |
| `duty.jsonl` | (guide, duty code) | `duty_code, duty_name, job_codes[], subject_areas[], guide, guide_release, url` |
| `job.jsonl` | (guide, job code) | `job_code, job_name, duty_codes[], subject_areas[], guide, guide_release, url` |
| `guides.jsonl` | guide | `title, product, guide_release, versioned, doc_id, created, index_url, hub_release, discovered_via, seed, toc_pages, pages_fetched, failed[], unresolved[], anomalies[], cross_check` |

- `guide` is the book id (`FAOFB`, `FAOHB`, …).
- Rows are per guide. The same area or duty can appear in several guides (the OTBI usage/performance
  and security areas are in most of them). Consumers take DISTINCT on (subject_area, duty_code).
- Names are the page text with whitespace collapsed, as HTML renders it.
- Files are sorted, UTF-8 and LF.
- `cross_check` compares the area → duty edges read on SA pages with the duty → area edges read on DR
  pages of the same guide (`only_on_area_page`, `only_on_duty_page`, plus examples).

## Run (WSL, CloudBeaver distro)

```
wsl -d CloudBeaver -u root -e bash -lc 'rm -rf /tmp/tbi-guides && mkdir -p /tmp/tbi-guides/app /tmp/tbi-guides/out && cp /mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/scripts/pipeline/p3_tbi_guides.py /tmp/tbi-guides/app/ && docker run --rm --name tbi-guides-crawl -v /tmp/tbi-guides:/stage python:3.12-slim sh -c "pip install -q --root-user-action=ignore requests beautifulsoup4 lxml && python /stage/app/p3_tbi_guides.py --out /stage/out --cache /stage/cache --guide-index PSSAG=https://docs.oracle.com/en/cloud/saas/public-sector-compliance-regulation-common/26c/pssag/index.html" && mkdir -p /mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/data/otbi/tbi_guides && cp -r /tmp/tbi-guides/out/. /mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/data/otbi/tbi_guides/'
```

- The run makes about 1,100 requests, which takes about 21 minutes. The stage dir is wiped first, so
  every run is a fresh crawl.
- **Exit 0**: the release directory is copied into the repo.
- **Exit 1** (a guide or a page failed): nothing is copied. `/tmp/tbi-guides/out/<release>/guides.jsonl`
  names what failed. To re-parse without re-fetching, re-run only the `docker run …` part. It reuses
  `/tmp/tbi-guides/cache`.
- Other options: `--only BOOK[,BOOK]` limits the crawl to some guides. A crawl made only of
  unversioned guides cannot name its release directory and stops.
- The PSSAG URL contains a release (`26c`). When Public Sector publishes a newer release, the hub check
  moves the crawl forward by itself. If Oracle moves the guide, the run fails on PSSAG and the URL must
  be updated. Drop the option once Oracle fixes its fa-index link.

## Checking against the catalog

Match on a normalized name: NFKC, casefold, every Unicode dash to `-`, the spacing around `-` unified
(the guide has `Recruiting-Hiring Events Real Time`), whitespace runs collapsed, trimmed. The catalog
stores names verbatim, and 8 of its areas carry double spaces. The catalog's names come from
(read-only):

```
wsl -d CloudBeaver -u root -e bash -lc 'docker exec stack-db psql -U postgres -d fusion -At -c "select name from v2027_05.otbi_subject_area order by 1"'
```

## Run of 2026-10-05 (release dir `26d`)

| Guide | Pillar | Product path | Release | Built, doc id | SA / DR / JR pages |
|---|---|---|---|---|---|
| FAOHB | Human Capital Management | `human-resources` | FA Latest | 2025-06-24, G34734-01 | 140 / 57 / 26 |
| FAOEC | Sales and Fusion Service | `sales` | FA Latest | 2026-09-10, F77865-17 | 172 / 45 / 58 |
| FAOFB | Financials | `financials` | 26D | 2026-09-02, G59635-01 | 51 / 26 / 45 |
| FAOPB | Procurement | `procurement` | 26D | 2026-09-28, G59681-01 | 26 / 19 / 25 |
| FAOSM | Supply Chain & Manufacturing | `supply-chain-and-manufacturing` | 26D | 2026-09-28, G59739-01 | 104 / 31 / 34 |
| FAOPM | Project Management | `project-management` | 26D | 2026-09-23, G59688-01 | 40 / 27 / 17 |
| FAORM | Risk Management | `risk-management-and-compliance` | FA Latest | 2026-09-09, G59710-01 | 11 / 9 / 8 |
| PSSAG | Permitting and Licensing (`--guide-index`) | `public-sector-compliance-regulation-common` | 26C | 2026-06-14, G57546-01 | 20 / 18 / 29 |
| FAOST | Student Management | `student-management` | FA Latest | 2026-03-05, G27878-02 | 16 / 9 / 10 |

- **Fetching**: 1,097 requests (index, hub, toc and pages, no retries needed); all 1,073 of 1,073
  pages parsed, 0 failed.
- **Rows**:
  - `area_duty` 1,516: 1,483 distinct (area, duty) pairs over 541 areas.
  - `duty` 240 rows: 210 distinct codes.
  - `job` 250 rows: 212 distinct codes.
  - The SA → DR and DR → SA edges agree in every guide.
- **Anomalies logged (11)**:
  - 6 HCM subject-area pages publish no role sections: Payroll Flows, Recruiting Opportunity
    Marketplace, Recruiting Setup Details, Learning Content Items, Worker Compliance Results, Feedback
    Notes by Recipient.
  - 2 Code Names repaired: FAOHB `FBI_WORKFORCE_SENSITIVE_DATA_ACCESS_AUDIT_TRANSACTION_ANALYSIS_DUTY)`
    and PSSAG `FBI_PSC_AGENCY_CODE_CASE_INSPECTIONS_ INQUIRY_DUTY`.
  - 3 placeholder role pages without a code: FAOHB "Not Applicable", FAOEC "testrole" and "test job".
    The 3 unresolved references all point to "Not Applicable".
- **Spot check**: "Payables Invoices - Transactions Real Time" has 6 duties: `FBI_GRANTS_MANAGEMENT_`,
  `FBI_INTER_COMPANY_`, `FBI_PAYABLES_INVOICE_`, `FBI_PAYABLES_TO_LEDGER_RECONCILIATION_`,
  `FBI_PROJECT_COSTING_` and `FBI_PROJECT_JOURNALS_TRANSACTION_ANALYSIS_DUTY`.
- **Catalog match** (`v2027_05.otbi_subject_area`, 642 areas): 511 match (79.6 %), each with at least
  one duty. The 131 unmatched areas break down as:
  - 29 are the same area under another name. The 30 unmatched guide names are these 29 plus one area
    the catalog lacks, `Workforce Management - Vacancy Real Time`. Examples:
    `Distributed Order Orchestration - *` = `Order Management - *`;
    `Fiscal Document *` = `Costing - Fiscal Document *`;
    `Sales - CRM Activity *` = `CRM - CRM Activity * Real Time`;
    `Data Security - Incidents Real Time` = `Cybersecurity - Incidents Real Time`;
    `Public Sector Cloud - Contractor License Real Time` = `Public Sector Cloud - Contractor License`.
  - 6 are the HCM pages without role sections.
  - 96 appear in no guide. CX: Loyalty, Marketing, Marketing Segmentation, Subscription Management,
    Territory Management, Partners, Knowledge Management, Incentive Compensation, Sales Predictor.
    SCM: Maintenance, Manufacturing workstations, Product Management, Installed Base. Plus a few newer
    HCM areas.

## Notes for the phase-2 loader

- **Renames**: a name join leaves the 29 renamed areas without duties. Closing that gap needs a curated
  alias list, which this crawl does not invent.
- **HCM code shape**: the HCM guide (built 2025-06-24) codes 44 duties `FBI_*_DUTY`, 10
  `ORA_FBI_*_DUTY_HCM` and 3 otherwise. 8 duties appear under both shapes, as separate pages. The pod
  grants under `ORA_FBI_*_DUTY_HCM`. Of the 48 seeded duties in `customer.sec_instance_duty`:
  - 9 match a guide code verbatim.
  - 22 match only via `ORA_<FBI code>_HCM`.
  - 17 have no twin at all. 14 of them are the granular payroll duties
    `ORA_FBI_PAYROLL_*_TRANSACTION_DUTY_HCM`, where the guide has a single
    `FBI_PAYROLL_TRANSACTION_ANALYSIS_DUTY`. The others are Learning (the guide has
    `ORA_FBI_LEARNING_TRANSACTION_ANALYSIS_DUTY` without `_HCM`), Availability Patterns and Person
    Disability.

  The FBI ↔ `ORA_FBI_*_HCM` equivalence and the payroll gap are phase-2 decisions. The crawler keeps
  Oracle's codes verbatim.
