# Catalog release pipeline

Builds the `work` schema in `fusion_dev` on `stack-db`, and from it a `v<ver>` release schema.

## The model — three levels

```
L1  source object (view / OTBI item / BIP datamodel)   -- not materialised
L2  work.sql_unit    the dirty SQL as extracted from a source object    116,006 rows
L3  work.clear_sql   the DEDUPED statement, id = content hash            26,204 rows
```

`sql_hash = sha256(work.norm_sql(original_sql))`. Every fact, every enrichment field, every
vector and every corpus row keys on it, and `report_queries.id` is `sql:<sql_hash>` — the same
identity `src/ingest.ts:108` mints for runtime-staged SQL.

**Dedup is on `original_sql`, NEVER on `clean_sql`.** 85,741 OTBI units carry 11,291 distinct
statements but 43,476 distinct v1 rewrites; the rewrite is an enrichment OUTPUT that lands on
the L3 row after dedup, not part of its key.

L3 decomposes as bip-only 756 + catalog-only 2,524 + catalog∩bip 5,633 + otbi 11,291 +
view 6,000 = 26,204. The three source groups are disjoint by hash.

## Where the data comes from — and where it does not

`work` is built from **two derived sources and the vendor dictionary**, nothing else:

| input | what it gives |
|---|---|
| `raw.sql_units` — `unit_id, source, title, original_sql` ONLY | the L2 inventory and the SQL text |
| `raw.unit_refs` | the crawl's BIP report / datamodel paths (acquisition, like `sql_units` itself) |
| `raw.meta_tables/columns/pkeys/fkeys/indexes` | the dictionary (the parse needs it, see below) |
| a fresh pinned `sqlglot` parse of the 26,204 L3 statements | every `work.f_*` fact |
| `/root/enrich-run/enrich_output.{view.w0..w7,bip,otbi}.jsonl` | the Qwen generation-2 enrichment |

**Excluded, deliberately, and not silently re-introduced anywhere:**

- **`raw.enrichment`** — 109,616 generation-1 (Gemini) rows. Out entirely.
- **the carried generation-1 text on `raw.sql_units`**: `description`, `intents`, `mechanics`,
  `clean_sql`, `description_generated`, `description_v2`, `semantics_json`, `reports`.
- **the OTBI crawl `relations` block** and everything it fed (`filters`, `lookup_types`,
  `security_predicate`, otbi `joins`). `src/corpus/otbiMeta.ts` reads it; it is Oracle crawl
  metadata, not model output, and it is out this pass.
- **the old parser output**: `tables_used_old`, `joins_old`, `filters_old`,
  `security_predicate_old`, `sql_for_parse`, `parse_quality`, `parse_error`.
- **`mined_relationships.json`, `otbi_relations.json`** — `work.relationships` is derived in
  `p3_rel.sql` from `work.f_joins` + `work.meta_fkeys`, never carried.
- **`enrich_output.otbi.round1-local-stale.jsonl`** — superseded; `p2_qwen_load.py` refuses it by
  name.
- **`v2026_09` AS A DATA SOURCE.** The previous build read generation-2 back out of the shipped
  release, which made "rebuilt from raw" a fiction: the release was reconstructing itself from its
  own lossy projection (4 of the model's 23 fields). Exactly one current file reads it —
  `p8_verify.sql`, which writes nothing. In `p0`–`p4` and `p7` every occurrence of the string
  `v2026_09` is on a comment line (`grep -n v2026_09 p[0-47]* | grep -v -- --` comes back empty);
  that is the point of the split, and it is worth re-checking after any edit.
  The 145 rows `v2026_09` ships that have no record in the JSONL are the proof it was never a clean
  source: 144 bip-report rows carry `raw.sql_units.description/intents/mechanics` byte-for-byte —
  an OLDER generation, not Qwen — and one view row's text matches nothing in `raw` at all.
## References — two columns, because there are two kinds

`v2026_09.report_queries.reports` was one column holding two incompatible shapes and covering
11,455 rows: `[{path,title,index}]` objects on **176** bip rows, bare title strings on **11,279**
otbi rows, empty on all 6,078 views. This build keeps them apart.

| column | shape | source | covers |
|---|---|---|---|
| `clear_sql.reports` | `[{path,index}]` | `work.unit_ref` ← `raw.unit_refs` | 6,389 bip-report hashes, 7,817 refs, 1,415 distinct paths |
| `clear_sql.l2_titles` | `["title", …]` | the contributing L2 units | all 26,204 hashes |

`raw.unit_refs` is **bip-report only** — all 6,389 of those units, and nothing for otbi or view. So
`reports` alone cannot replace `l2_titles`: for otbi, `l2_titles` *is* what `v2026_09` shipped in
`reports` (the canonical's alias titles), and for views nothing else exists. Both earn their place.
On the bip side the crawl gives 6,389 hashes where the release had 176 — 36x the path coverage.

`unit_ref.title` is dropped: byte-identical to `path` on all 7,817 rows, so a release-time
projection can emit `title = path` if a serving shape still wants the three-key object.

`unit_refs` is also the only real basis for **L1** (the source object), which `siblings()` and
`listQueriesForSubjectArea()` currently fake with title-string matching (`byTitle` takes "the
largest SQL sharing a title"; subject areas are matched `"<area>.%"` then `"<area>%"`). **L1 is not
built this pass.**

## The Qwen generation-2 load — what the JSONL actually contains

Ten primary files, 24,016 lines, **23,610 distinct ids**, 23,559 of which end on a successful line.

- **Ids are OLD unit ids** — `view:<NAME>`, `sql:<sha256>`, `otbi:<subject>__<item>` — mapped
  through `work.sql_unit` to `sql_hash`. All 23,610 map; none is orphaned.
- **Last line per id wins.** The files are append-mode resume logs; 384 ids have more than one
  line, 406 lines are superseded. Counting lines instead of ids is what produced the "388
  differing rows" ghost.
- **Collisions**: 50 sql_hashes have more than one Qwen record (39 view, 11 otbi; one view hash has
  14). All 50 have candidates whose descriptions differ, so the pick is material, not cosmetic.
  It is deterministic: `ok DESC, (unit_id = primary_unit_id) DESC, unit_id ASC`. The winner is
  recorded in `clear_sql.src_enrich_unit` / `src_enrich_file` / `src_enrich_ghash`, and
  `n_enrich_units` says how many it beat.
- **`ghash` is otbi-only.** It is the grounding hash — the key of the FACTS the model was shown,
  and the only thing that can make a later run incremental. `enrich_client.py:210` writes
  `"ghash": u.get("ghash")`, and only the otbi input file carries one: the view and bip waves ran
  before the field existed. 11,277 of 23,610 records have it. **This is a real gap**: a future
  incremental run can skip re-enriching otbi but not views or bip.
- **There is no model, run id or timestamp on any record.** `enrich_client.py` resolves
  `MODEL_NAME` from the endpoint at startup and never writes it per row; `usage` (token counts) is
  all the per-call provenance that exists, and it is stored.

`work.qwen_record` keeps the **whole payload** (`payload jsonb`, all 23 fields) plus `src_file`,
`line_no`, `n_lines`, `ok`, `error`, `ghash`, `usage`. `p2_promote.sql` promotes columns OUT of it
onto the L3 row; promotion is an index over the payload, never a filter.

### Promoted columns

All 23 fields get a column on `work.clear_sql`; the payload stays whole underneath.

| promoted as | fields |
|---|---|
| text | `description`, `title_human`, `domain`, `output_grain`, `view_advice`, `rewritten_sql` |
| boolean | `tables_confirmed` |
| jsonb (array of string) | `intents`, `tags`, `quality_flags`, `missing_remarks`, `flex_missed`, `extra_tables`, `missing_tables` |
| jsonb (array of object) | `security`, `params`, `language`, `grain_handling`, `date_logic`, `flexfield`, `plsql_functions`, `computed_columns`, `current_row` |

`output_grain` is FREE TEXT, not an enum — `row`, `item-level`, `single aggregate value` and
~2,000 other spellings all occur. It is promoted as written; normalising it is a separate job.

`mechanics` is NOT stored: it is a digest `scripts/gpu-enrich/import_serving.mjs:mechanicsOf()`
builds from `security + currentRow + grainHandling + dateLogic + flexfield + params + outputGrain`,
all of which are now first-class columns. Same for the old `low_confidence` boolean
(`missingRemarks` ∪ `tablesConfirmed=false` ∪ `qualityFlags`). Both are release-time derivations
now, not stored state that can drift from its inputs.

### The parser corrections: `f_tables` is the parse, `r_tables` is the reconciled fact set

The model was shown the round-0 facts and asked to confirm them. Its claims land in
`work.qwen_table_correction (sql_hash, unit_id, kind, table_name)` — `extra` = sqlglot listed a
table the SQL does not use, `missing` = a used table is absent — with `clear_sql.tables_confirmed`
as the summary flag. 546 statements disputed, 2,488 `extra` claims over 665 statements, 1,077
`missing` over 459.

`work.f_tables` stays **exactly what one pinned `sqlglot==30.18.0` run produced**. That is what
makes the parse reproducible and it is never edited. `p3_reconcile.sql` produces
`work.r_tables` — the reconciled fact set, one row per `(sql_hash, table_name, is_cte)`, every row
carrying how it got there. **Downstream reads `r_tables`;** the only consumer of `f_tables` is that
step. One reconciled table, not a v1/v2 pair.

| provenance | rows | statements | meaning |
|---|---|---|---|
| `agreed` | 143,004 | 22,823 | parse found it, model did not object |
| `parser` | 12,245 | 2,457 | parse found it, statement has no model verdict |
| `model_disputed` | 2,372 | 642 | parse found it, model called it extra — **kept** |
| `model_added` | 766 | 350 | parse missed it, evidence backed the model (2026-08 records; the gap and recheck runs add theirs — see *Recheck* below) |

157,621 parse rows + 766 additions = 158,387; **0 dropped**. `model_verdict` carries
`tablesConfirmed` as a confidence signal on every row (confirmed 144,896 / none 12,245 /
disputed 1,227), never as an action.

**The verdict is ADD, DO NOT REMOVE, and it is measured.** `model_removed` is not a provenance
value here — inventing an empty category would imply the question was close. It is not:

- **`extraTables` — removal unsupportable.** 2,373 of 2,488 claims name a table this parse finds
  independently. Of those 2,373: **100 %** have the name in the statement text, 96 % are real
  vendor objects, 60 % sit directly after `FROM`/`JOIN`/`UPDATE`/`INTO`, and **2,373 were raised on
  statements where the model simultaneously said `tablesConfirmed = true`** — it asserted the table
  set was correct while listing exclusions. Two parsers plus the literal text against one
  self-contradicting model reading. Those rows stay, flagged.
- **`missingTables` — adding supported, with a filter.** 921 of 1,077 are actionable; the parse is
  known to under-report (`qualify()` drops what it cannot bind, silently). **747** are both a real
  vendor object *and* present in the statement text — applied. 137 are not vendor objects (106 are
  query ALIASES — `CC`, `GLL`, `FSV`, `GLBATCH` — or `DUAL`, 29x; the dictionary test earns its
  keep), and 37 name something absent from the SQL entirely. All 174 keep a verdict in
  `qwen_table_correction`, none is silently dropped.

**The test that settles it — where each kind lands relative to parse quality:**

| parse_quality | corpus statements | additions applied | extra claims rejected |
|---|---|---|---|
| `full` | 23,981 (91.5 %) | 245 | 2,286 |
| `fallback` | 1,838 (7.0 %) | 452 | 87 |
| `failed` | 234 (0.9 %) | 50 | 0 |

Additions cluster where sqlglot **admits** it could not read the statement — 502 of 747 (67 %) on
the 7.9 % of the corpus that is `fallback` or `failed`. Removals do the exact opposite: 2,286 of
2,373 rejected `extra` claims sit on `full` parses, statements the parser read completely. The
model is strongest precisely where the parser is weakest, and weakest where it is strongest.

**The honest weakness of the add side**: only **3** of the 747 additions sit directly after
`FROM`/`JOIN`. That is expected — a table in an obvious FROM position is one sqlglot would have
found — but it means 744 rest on "a real vendor object whose name appears somewhere in the
statement", a test a column name or string literal could also pass. The parse-quality correlation
is what carries the decision, not the text test alone. 156 `missing` claims are already moot
because this parse finds those tables itself, which is direct evidence that some of what the model
reported was a defect of the lost August extractor rather than of sqlglot as such.

Every claim carries its evidence (`in_parse`, `in_dictionary`, `in_sql_text`,
`after_from_or_join`) and a `verdict`, so the decision is auditable rather than asserted.

**The `FUSION.` prefix IS stripped (rule taken 2026-09-21).** 20 claims over 7 names
(`FUSION.SVC_SERVICE_REQUESTS`, `FUSION.PER_BIPNTF_FLEX`, …) were rejected only because the model
spelled the schema qualifier. `work.qwen_table_correction.name_norm` — a generated column declared
in `p2_promote.sql`, `regexp_replace(table_name, '^FUSION\.', '')` — is the spelling every test and
the added row use; `table_name` stays the claim as spelled. 19 of the 20 applied (one was moot,
the parse already had it): 747 → 766 additions, 342 → 350 statements.

### What has no generation-2 enrichment

2,733 L3 statements (10.4 %) carry SQL and parse facts and `description IS NULL`:

| cause | bip-report | otbi | view |
|---|---|---|---|
| no record in the JSONL at all | 2,668 | 14 | 0 |
| record exists but ends on a failure line | 32 | 11 | 8 |

The 2,668 bip are 2,524 catalog-only statements (they exist only in the staging crawl) **plus 144
bip-report L2 units that are simply absent from `enrich_output.bip.jsonl`** — none of those 144
hashes is rescued by another unit. The 51 failures are truncated JSON (the model hit
`max_tokens`); their error text is stored. This is a **queryable queue**
(`WHERE src_enrich_unit IS NULL` has its own partial index), not a hidden gap.

Those 144 are not arbitrary: **every one of them is `excluded_reason='dynamic_lexical'`**, and
`export_wave.py` selected `WHERE excluded_reason IS NULL`. They were excluded on purpose, not
lost. The full exclusion cohort is 151 — the other 7 are catalog-only and already counted in the
2,524. So the queue decomposes two ways over the same 2,668 rows: by origin 2,524 catalog-only +
144 bip, by eligibility 2,517 never-a-candidate + 151 deliberately excluded.

### Filling the queue: p2_gap_*

The run set is **2,582**, not 2,733: the 151 `dynamic_lexical` statements stay excluded (below).

`p2_gap_export.py` builds the prompt payload out of `work`, and it is a PORT of
`scripts/gpu-enrich/export_wave.py` — the script that produced all 23,610 records we hold — not a
new prompt. Measured against it on a 199-unit otbi control: **198 of 199 payloads are byte-
identical, ghash included.** The one that differs is a card labelled `[UNKNOWN]` instead of
`[TABLE]`, because 128 objects in the run's `schema.sqlite` (bare name+type stubs: no remarks, no
module, no columns — `AP_INVOICES`, `AP_CHECKS`, …) exist in no `raw` table, so `work` cannot know
them. 17 of the 128 are referenced by 87 statements in the queue.

`p2_gap_run.py` imports `enrich_client.py` for the contract (23-field strict schema, system
prompt, `one()` with its retry) and supplies only the orchestration the original could not: the
endpoint URL, model id and concurrency are REQUIRED arguments with no default and no host in the
source, resume is grounding-versioned on `ghash`, and every row is stamped with `model`, `run_id`
and `produced_at`. Those three are now columns on `work.qwen_record` and are read by
`p2_qwen_load.py`. They are **nullable and never backfilled**: the 23,610 existing rows genuinely
have no such data (`enrich_client.py` resolved the model name once at startup and wrote it
nowhere), and a value invented for them would be a fabrication wearing the shape of provenance.

`p2_gap_dryrun.py` renders every request with no network and gates on block order, ghash
recomputation, the clip and the truncation note.

```bash
wsl -d CloudBeaver -u root -e bash -lc 'SQLS_DB=/root/enrich-run/sqls.sqlite bash …/p2_gap.sh vcr'
wsl -d CloudBeaver -u root -e bash -lc 'OUTDIR=/root/gap-run FLEX=OFF bash …/p2_gap.sh export'
wsl -d CloudBeaver -u root -e bash -lc 'OUTDIR=/root/gap-run CPT=5.16 bash …/p2_gap.sh dryrun'
```

#### work.view_column_remarks — an acquisition, and the only copy

The vendor dictionary carries a remark on 99.9 % of TABLE columns (1,205,092 of 1,205,723) and on
**0 of 243,778 VIEW columns**. Every VIEW column meaning the 2026-08 prompts ever showed came from
one derived table — the base remark inherited through the view's projection, plus
`computed`/`constant`/`unresolved` verdicts — built during the v2 catalog pass and never carried
into `raw`. `p2_gap_vcr.py` lands its 222,510 rows (200,438 with a remark, over 5,982 views) in
`work.view_column_remarks`.

**Source: `/root/enrich-run/sqls.sqlite`, and there is no other copy.** 3.7 GB, WAL mode, and it is
the database the 2026-08 run itself read — evidence, not a working file. Opened
`mode=ro&immutable=1` so SQLite skips locking and the WAL entirely and creates no `-wal`/`-shm`;
the directory is mounted read-only in the container as well; size, mtime and md5 are checked
unchanged after the load. `seq` is the sqlite rowid and is load-bearing, not a surrogate:
`export_wave.py` builds `vrem[(v, c)] = rm` over an unordered scan, which is LAST WINS, and 2
(view, column) pairs have duplicate rows that disagree.

It is **not part of the p0–p8 chain**: `p0_fn.sql` drops `work`, so a rebuild drops this table.
Re-run `p2_gap.sh vcr` after any rebuild, or fold it into `p1_l2_l3.sql` beside the `meta_*` copies.

What it bought on the run set: 5,099 VIEW column references over 487 statements, 4,894 (96.0 %)
covered by the derived table. 987 of those are the junk case (the remark is the column name again)
and the export's guard drops them, leaving 405 statements with a real new meaning. **404 ghashes
moved** — the one that did not is `view:ZX_WHT_TRX_DETAILS_V`, already at `columnNotes`' 120-group
cap, so its new meanings fell past the cut. 3,518 column meanings and 286 predicate annotations
landed; predicate annotation coverage went from 56.3 % to 68.9 %.

#### Recheck: p2_recheck_* — the tables the model added never reached the prompt they came from

A `missingTables` claim is made against the FACTS block the model was shown, so an accepted
addition (`model_added` in `r_tables`) is by definition a table that was absent from that
statement's prompt. The recheck closes the loop: fold the finished journal in, re-reconcile, re-export
every enriched statement whose grounding moved, enrich those, fold that journal in too.

```bash
W='wsl -d CloudBeaver -u root -e bash -lc'; P=/mnt/c/.../scripts/pipeline/p2_recheck.sh
$W "OUTDIR=/root/gap-run ENRICH_DIR=/root/enrich-run JOURNALS=enrich_output.gap.jsonl bash $P load"
$W "OUTDIR=/root/gap-run FLEX=OFF bash $P export"
$W "OUTDIR=/root/gap-run ENV_FILE=/root/enrich-run/.env MODEL=<served id> CONC=512 bash $P run"
$W "OUTDIR=/root/gap-run ENRICH_DIR=/root/enrich-run JOURNALS=enrich_output.gap.jsonl,enrich_output.recheck.jsonl bash $P load"
```

- **`load`** = `p2_qwen_load.py` with `EXTRA_FILES` (the journals, read AFTER the ten primaries,
  in the order given; last line per id wins across files, so a recheck record supersedes the
  record it re-did) → `p2_promote.sql` → `p3_reconcile.sql` → `p2_recheck.sql` (report only) →
  `p7_own.sql`. The load is still a full DROP + COPY of `work.qwen_record`, so it is idempotent by
  construction, and `p3_reconcile.sql` is the ONLY add rule — the recheck restates nothing.
- **`export`** = `p2_gap.sh export` with `COHORT=recheck` → `p2_gap_export.py --cohort recheck`.
  Candidates: every enriched statement that carries a `model_added` row OR whose winning record
  came from a `run_id`-stamped run (a ghash comparable with this exporter's). Written only when the
  freshly computed ghash differs from `clear_sql.src_enrich_ghash` (NULL always differs: the
  2026-08 view/bip records and every failure record). The 2026-08 otbi ghashes are NOT comparable
  (lost-extractor facts) — they qualify through `model_added` only, never on ghash, or the whole
  August run would "differ".
- **`run`** = `p2_gap_run.py` with the gap run's exact shape; run id `recheck-<utc>`, journal
  `enrich_output.recheck.jsonl`, log `run.recheck.log`, resume-safe by ghash.
- **`p2_recheck.sql`** prints, by origin (`august` / `gap` / `recheck`): reported / in-text /
  in-dictionary / already-present / added, the top-20 rejected names with reason, and the bucket
  with NO rule — `tablesConfirmed=false AND missingTables=[]` (91 on the 2026-08 run; measured,
  not acted on).

Not done here, and now stale for every re-enriched statement: the `p4` vectors (slot 0 carries the
table list AND the description, both of which moved). Re-embed those rows before a release.

**Run of 2026-09-21 — measured.** Gap run: 2,582 → 2,548 ok / 34 failed (20 client-wall
timeouts, 14 truncated JSON; all giants at or near the 40,000 clip — they belong with the
oversized-deferred set, not with a plain retry). After that load: `missingTables` reported
1,077 (August) + 239 (gap) = 1,316; in text 1,228; in dictionary 1,098; already in parse 174;
**added 878 over 401 statements** (766 August incl. 19 rescued by the `FUSION.` strip, 112 gap).
Flagged-but-did-not-enumerate (`tablesConfirmed=false`, `missingTables=[]`): 91 August + 180 gap.
Recheck export: 2,898 candidates, 2,495 grounding unchanged, **403 moved** (350 August + 51 gap
`model_added` + 2 gap whose view cards moved), $0.38; run 402 ok / 1 failed
(`sql:883169ae…`, truncated JSON) in 7.6 min.

**DEFECT FOUND ON THE SECOND LOAD — OPEN, NOT FIXED. The additions do not survive their own
recheck.** `work.qwen_record` keeps ONE record per unit id (last line wins, across files), and
`p3_reconcile.sql` rebuilds `r_tables` from the parse plus the claims of the CURRENT winning
record only. The recheck record was produced with the 878 additions already in its FACTS block,
so it does not report them as `missing` any more — and the reconcile, seeing no claim, drops them:
`model_added` 878 → 180 (the 168 the model re-listed anyway, plus 12 new). Measured over the 403
prompts: 878 additions shown, **811 accepted silently** (not in `extraTables`), 61 called
`extra`, 168 re-listed as `missing`; **710 lost from `r_tables`**. Consequence today: the recheck
descriptions were written against a table set `r_tables` no longer lists, and a further
`export` would flag all 403 as "moved" again — an oscillation, not convergence. The claim history
is the missing thing: a claim that was evidence-backed and applied has to stay applied across
record generations, and it lives only in the journals. The fix is a grain change (keep every
generation's claims — e.g. a claims table loaded from ALL journal lines, with `3b` adding from it
— or keep `qwen_record` per `(unit_id, run_id)`), which is a decision, not a patch; until it is
taken, do not run `export` again after a recheck `load`, and treat `r_tables` as under-counting
on those 401 statements. To put the pre-recheck fact set back: `load` with
`JOURNALS=enrich_output.gap.jsonl` alone (the recheck text then leaves `work` with it).

#### What the port still cannot carry

- **`ghash` on the new rows is not comparable with the stored otbi values.** Same formula; the
  grounding underneath it is the fresh pinned parse, not the lost August extractor's `x_*`. A
  third of the stored otbi ghashes are already unreproducible even by `export_wave.py` itself —
  its junk-remark guard post-dates that export (133 of 199 control units still match).
- **The dictionary stringifies JSON null.** `work.meta_columns.remarks` holds the four-character
  text `null` on exactly the 244,409 rows where the source had SQL NULL (17,022 in `meta_tables`,
  11,426 in `application_short_name`). The exporter maps it back; a port that did not would assert
  "COLUMN: null" as a meaning a quarter of a million times.

And one trap worth naming, because it is silent: **never let Postgres order a fact list.**
`p3_parse.py` wrote each list through Python `sorted()` — codepoint order, matching sqlite's
BINARY collation. Postgres' default collation ignores `_` at the primary level, so `ORDER BY
table_name` returns `BEN_BILL_CHARGE_DETAILS` before `BEN_BILL_CHARGES`. That reordered the table
list on 18 of 199 control units and moved every one of their ghashes. The exporter fetches
unordered and sorts in Python.

#### Decisions taken on the queue (2026-09-20), so they are not rediscovered as bugs

**The SQL clip stays at 40,000 characters**, unchanged from the original run. Two consequences are
accepted knowingly, and both are real:

- The clip sends **27.0 %** of the run set's oversized SQL — 132 statements, 19.56 M chars of
  statement, 5.28 M sent; otbi 8.0 %, bip 46.1 %, view 81.1 %. For the **13 OTBI giants**
  (677–746 KB, all `fallback`)
  **not one** of their fact tables appears in the first 40,000 characters: the largest is 746,649
  chars of which the opening 40 KB is nothing but an outer alias list (`c1 AS "Extension Attribute
  Character 003"` … `c975`), with 749 SELECTs, 747 FROMs, 351 JOINs and 706 SAWITH references all
  past the cut. Those prompts are near-content-free by construction, not by accident.
- Two *different* OTBI statements — 728,366 and 696,347 chars, different `sql_hash` — have
  byte-identical first 40,000 characters, so they clip to the same prompt, carry the same `ghash`,
  and will receive the same answer. That is the single shared ghash in the payload; it is correct
  behaviour of the key (same grounding, same hash), not a collision.

Mitigating, and worth remembering before anyone "fixes" this: the FACTS are parsed from the
**full** statement, so nothing is lost to the clip on a `full` parse. It bites hardest exactly
where the parse is `fallback` and there are no joins or predicates to carry.

**The 151 `dynamic_lexical` statements stay excluded — deferred, not forgotten.** They are not
hard: small (avg 3,307 chars), and 147 of 151 have table facts because `p3_parse.py` substitutes
`&X -> NULL` and retries. The problem is that the substitution then **lies in the FACTS**: 71 of
the 151 carry a literal `NULL` in their projection (`select &p_vendor_type_col from dual` becomes
`[0] _COL_0 = NULL` with no tables), 149 still show the `&` token in the SQL block, and nothing in
the prompt says a substitution happened. The fix is to re-parse with a placeholder that survives
(`&X -> X_LEXICAL`) so the facts stop lying — which changes `work.f_*`, the frozen parse of
record, and is therefore a **p3 decision, not an export flag**. Until then the export keeps
`export_wave.py`'s own `WHERE excluded_reason IS NULL`. The debt: 151 statements, 271 lexical
params over 125 distinct names, 88 of them substituting inside `WHERE`, 9 inside `SELECT`, 1 after
`FROM`.

**No flexfield map** (`FLEX=OFF`). The original applied one to the otbi wave only —
`enrich_input.otbi.jsonl` carries 1,276 `flexfield (value by CONTEXT_CODE)` annotations,
`enrich_input.bip.jsonl` and `enrich_input.view.w0.jsonl` carry none, and `clear_sql.flex_missed`
is empty on every bip and view row. The queue is 99 % bip, so `OFF` is what preserves the shape.
Turning it on changes 9 of the 2,582 statements and adds 65 annotations.

### Vectors: what gets one, and what slot 0 is made of

`embedTexts()` (`src/corpus/ingestStore.ts:16-18`) is the whole contract: **slot 0** is
`${description}\nTables: ${tables.join(", ")}`, **slots 1..n** are one per non-blank intent, in
order. `p4_embed.mts` imports it rather than restating it. Two things about slot 0 are decisions,
not details:

- **No description ⇒ no vector.** The 2,733 statements with `description IS NULL` are embedded
  NOT AT ALL. `materialize()` — the product's own writer — already drops them
  (`/\S/.test(r.description)`), and the reason is retrieval, not tidiness: `"" + "\nTables: …"`
  is a real point in the space, so such a row answers questions it has nothing to do with. It
  ships with facts and no vectors until the enrich queue reaches it; unfindable beats wrong.
  `p5_fill.sql` already LEFT JOINs the vectors, so `report_queries.embedding IS NULL` on exactly
  those rows and they contribute no `report_queries_vec_multi` rows at all.
- **The table list is `r_tables`, not `f_tables`.** Slot 0 takes the RECONCILED set — physical
  tables only (`is_cte = false`), parser artifacts dropped (`XMLTABLE|DUAL|SAWITH\d+|TABLE\d+`,
  the same `ARTIFACT` regex `import_serving.mjs` applied to `x_tables`), de-duplicated, then
  sorted with JS `.sort()`. The sort happens in JS on purpose: the importer sorted there, and a
  SQL `ORDER BY` would put the order at the mercy of the database collation.

That second choice is a **fidelity difference from the shipped `v2026_09` vectors**, and it is
measured, not assumed. Reconstructing v2026_09's own slot-0 text for all 23,471 enriched
statements: the description is byte-identical on every one, the raw `f_tables` list is
byte-identical on every one, and **342 statements (1.46 %) differ — exactly the 342 that
`p3_reconcile.sql` gave the 747 model additions**. 747 tables added, 0 removed, max 16 on one
statement; 337 of the 342 are `bip-report`. So the slot-0 KNN drift against the shipped corpus is
bounded by those 342 rows and is additive by construction. The artifact filter is load-bearing
here: without it 424 statements would differ instead of 342.

And it is small in practice. `p4_knn.mts` over six natural-language questions: mean top-10
agreement with the shipped corpus **9.0/10**, the same top-1 on 6/6, and **not one** of the six
disagreements is a drifted statement — all six are v2026_09 rank-11/12 rows crossing the boundary
because the two corpora differ in membership (23,746 rows there, 23,471 embeddable here).

## Run order

| file | step | ~time |
|---|---|---|
| `p0_fn.sql`      | drop/create `work`; function library (`norm_sql`, `sql_hash`, `dec_xml`, `nn`, `je`, `te`) + `build_meta` | 1 s |
| `p1_l2_l3.sql`   | `meta_*` copies, L2 `sql_unit`, L3 `clear_sql` | 75 s |
| `p2_qwen.sh`     | load the ten primary JSONL into `work.qwen_record` (`p2_qwen_load.py`) | 7 s |
| `p2_promote.sql` | map ids → `sql_hash`, resolve collisions, promote 23 columns, corrections table | 11 s |
| `p3_facts.sql`   | the `work.f_*` fact tables (DDL) | 2 s |
| `p3_parse.sh`    | the REAL pinned sqlglot parse (`p3_parse.py`) over all 26,204 statements | ~2 min |
| `p3_post.sql`    | fact indexes, exclusions from real `parse_quality` | 4 s |
| `p3_reconcile.sql` | test every model claim, then `work.r_tables` — the reconciled fact set | 10 s |
| `p2_recheck.sh`  | after an enrichment run: `load` (journal → record → promote → reconcile → report → own), `export` (grounding moved), `run` (enrich) — see *Recheck* | load 40 s |
| `p3_rel.sql`     | `work.relationships` derived from `f_joins` + `meta_fkeys` | 6 s |
| `p4_vectors.sql` | the `work.embeddings` table | 1 s |
| `p4_run.sh`      | full deterministic re-embed, sharded (`p4_embed.mts` per shard) | 27 min / 12 shards |
| `p4_knn.mts`     | KNN probe of `work.embeddings` (+ `v2026_09` alongside) — p4's own gate, since p6 needs p5 | 40 s |
| `p5_ddl.sh`      | create `v<ver>` from the PRODUCT's `scripts/pg-import/ddl.sql` | 2 s |
| `p5_fill.sql`    | populate all 25 release tables from `work` | ~3 min |
| `p5_index.sql`   | pgvector index on every embedding column | |
| `p6_verify.sql`  | the release gate: counts, content equality, dangling, stamps | 2 min |
| `p6_knn.mts`     | exact-KNN spot check through the serving statement | 30 s |
| `p7_own.sql`     | `ALTER ... OWNER TO fusion_dev` — the last act of every build | 1 s |
| `p8_verify.sql`  | VERIFICATION ONLY against `v2026_09`; writes nothing | 20 s |

```bash
wsl -d CloudBeaver -u root -e bash -lc \
  'docker cp <file>.sql stack-db:/tmp/ && docker exec stack-db psql -U postgres -d fusion_dev -v ON_ERROR_STOP=1 -f /tmp/<file>.sql'
```

The `.sh` / `.mts` steps run themselves:

```bash
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p2_qwen.sh'
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p3_parse.sh'
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p4_run.sh 12'
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_ddl.sh v2026_10'
```

Heredocs and inline SQL through the WSL bridge mangle quoting — always `docker cp` a file.

### p5–p6 are STALE against the current `work` shape

`p0`–`p4` and `p7`–`p8` are current. `p4` was stale too until 2026-09-20 — it read a
`clear_sql.tables_used` column that `p2_merge.sql` wrote and `p2_promote.sql` does not, so it
could not run at all; it now takes slot 0’s table list from `work.r_tables` (above).

`p5_fill.sql` still reads the merged-enrichment columns that
`p2_merge.sql` used to write (`tables_used`, `joins`, `filters`, `lookup_types`,
`security_predicate`, `semantics_json`, `low_confidence`) and will fail against the columns
`p2_promote.sql` writes instead. It also reads `work.f_tables` directly, which is now the wrong
source — the registries must be built from **`work.r_tables`** — and `clear_sql.reports` is
`[{path,index}]` now, not the old mixed shape. The 2026-09-20 pass rebuilt `work` only, by
instruction, and did not run or rewrite the release steps. **Do not run `p5`/`p6` before reworking
`p5_fill.sql`** onto the promoted columns and `r_tables` — and decide there what
`report_queries.tables_used/.joins/.filters` should be served from now that the merged enrichment is
gone and only parse facts remain.


## Experiments — `x*` scripts, NOT part of the build

Scripts whose name starts with `x` are **measurements**, not build steps. They write only to their
own clearly-named tables, nothing in `p0`–`p8` reads them, and the run order above never invokes
them. They are kept in-tree so a decision they informed can be re-checked rather than re-argued.

### `x1`/`x2` — should OTBI be a two-pass flow (rewrite → parse the rewrite)?

| file | what it does |
|---|---|
| `x1_facts2.sql` | DDL for `work.facts2_run`, `work.f2_tables`, `work.f2_joins` |
| `x1_parse_rewrite.py` / `.sh` | the SAME pinned `sqlglot==30.18.0` parse, over `clear_sql.rewritten_sql` instead of `sql_text`, OTBI only (11,266 statements with a rewrite) |
| `x2_compare.sql` | builds `work.x2_cohort` / `x2_tables_cmp` / `x2_joins_cmp` and prints the full comparison |

`x1_parse_rewrite.py` is a thin I/O shim: it imports `sqlglot_extract` unchanged and imports
`p3_parse.load_dictionary` / `p3_parse.resolver` from the release driver, so both parses see the
same unfiltered `work.meta_columns` (1,449,501 columns / 29,802 objects). Without that dictionary
`qualify()` silently drops unresolvable columns instead of raising, and the rewrite would look
better for free. Full parse: **12 s**, 927 statements/s.

**The result is a split decision, and the two halves point opposite ways.**

*Per statement the rewrite is worse.* Parse quality regresses on 616 statements and improves on 24
(the original OTBI parse was already 99.8 % `full`, so there was almost nothing to gain).
Dictionary-resolving table references: 65,487 original vs 58,869 rewritten — 6,775 lost against 98
gained, a 69:1 loss ratio. Dictionary resolution itself does *not* improve (96.5 % original,
96.0 % rewritten): the OBIS `SAWITH` wrappers were already correctly flagged as CTEs by the
existing parse, so there was no artifact problem to fix. Per-statement join edges: 12,469 gained,
10,421 lost.

*Per corpus the rewrite is much better.* A relationship corpus consumes DEDUPED
`(table.col = table.col)` pairs, and a lost edge that four hundred other statements also carry
costs it nothing. Distinct relationships over the cohort: **5,331 in both, 362 original-only,
5,898 rewrite-only** (5,400 with both tables in the dictionary). Against the whole corpus's
19,254 distinct relationships from all 26,204 statements, the rewrite contributes **5,625 that no
original parse anywhere produced** — +29 %. The reason is structural: OBIS joins its `SAWITH`
blocks to each other on machine column aliases (`SAWITH0 D1 left outer join SAWITH1 D2 On
D1.c3 = D2.c2`) and wraps single tables in derived tables, and `sqlglot_extract.resolve()` returns
`None` for both, so the top-level joins are invisible to the direct parse. The rewrite flattens
them. 12,387 of 12,469 gained edges have all four names present in the original text
(case-insensitive), and only **2** name a table absent from the original — the gains are grounded,
not invented.

**Measured costs of the two-pass flow, all real:**

- **Elision that `parse_quality` does not catch.** 238 rewrites carry a truncation symptom
  (`-- ... repeated for 950+ columns ...`, a trailing comma, no `FROM`); **120 of them still parse
  `full`**. `109d2da0…` collapses a 723,947-char original into 347 chars plus a comment.
- **Outer-join semantics are unreliable.** 2,938 statements have `(+)` or `OUTER JOIN` in the
  original and no outer keyword anywhere in the rewrite; 12 have the reverse. Hand-read
  `7a8cbc04…`: the original's `left outer join` between two `SAWITH` blocks comes back as
  `INNER JOIN`. The rewrite's rich `join_type` distribution (29,840 INNER / 18,546 LEFT vs the
  original's 59,287 flat `WHERE`) is therefore *more detailed but not more trustworthy*.
- **Dead-branch pruning deletes real relationships.** `0dd487e1…` has `AND ((1=2))` inside
  `SAWITH0`; the model correctly concluded the branch returns nothing and dropped it — along with
  four genuine receiving-table joins (`RCV_SHIPMENT_HEADERS`/`_LINES`/`RCV_TRANSACTIONS`/
  `INV_ORG_PARAMETERS_V`). Semantically defensible, corpus-destructive.
- **Plain drops.** `a42bb662…` keeps `WHERE 1=2` but silently drops `PO_HEADERS_ALL` and its join
  to `PO_LINES_DRAFT_ALL`, which are explicit in the original.
- **Transitive re-anchoring inflates both gain and loss.** `b66b9991…` re-centres a `PERSON_ID`
  star from `PER_ALL_ASSIGNMENTS_M` onto `PER_PERSON_NAMES_F_V`: 2 edges lost, 2 gained, same
  result set, all four true.

**Where it helps is not where it was expected to.** Crossed against the ORIGINAL `parse_quality`,
the 11,238 `full` statements yield 5 gained tables against 6,700 lost, while the 28 `fallback`/
`failed` statements yield 93 gained against 75 lost and 171 gained edges against 0 lost — 20 of
those 28 move to `full`. The same correlation the table corrections showed holds here: the model
is strongest exactly where the parser failed. But that is 28 statements out of 11,266.

**The corroboration test could not be run.** `work.qwen_table_correction` holds 1,077 `missing`
claims corpus-wide, but only **6 of them, on ONE OTBI statement**, are in this cohort (1,002 are
bip-report, 69 view). The rewrite corroborates **none** of the six: on `4498eb97…` it produces two
different tables instead. The `extra` side is answerable and points the same way as
`p3_reconcile.sql` already found — 670 of 994 OTBI `extra` claims (67 %) reappear in the model's
own rewrite, the model contradicting itself from a second route.

**Not determined here:** whether the same gain is reachable deterministically. Two of the three
structural causes of the direct parse's blindness are extractor gaps, not OTBI-SQL gaps — a derived
table wrapping exactly one physical table could resolve to that table, and Oracle `(+)` could be
read as an outer join instead of being flattened to `WHERE`. If those two changes recover most of
the 5,400 relationships, the two-pass flow buys little at the cost of trusting model output.
That comparison has not been measured.
## Invariants

- Writes ONLY to `work` (and to `v<ver>` when the release steps run). `raw` is a read-only input;
  `v2026_09` is not an input at all.
- The release DDL is never restated here: `p5_ddl.sh` derives it from `scripts/pg-import/ddl.sql`
  (the file `src/db/postgres/schemas.ts` and `PgMeta.verify()` are written against).
- **Nothing is left for a server boot to build.** `p5_fill.sql` writes every version stamp
  (`grain_meta`, `usage_meta`, `pred_meta`, `layout_meta.jsonl_hash`, `facts_meta`), because a
  missing stamp makes the serving container rebuild — and a rebuild over a partial input silently
  replaces a good registry.
- The four registries (`table_grain`, `table_usages`, `table_predicates`, `table_join_columns`)
  are COMPUTED from the PARSE FACTS in `work.f_*`, never copied and never read back out of the
  enrichment.
- **The parser version is PINNED** in `scripts/sqlglot_extract.py` (`SQLGLOT_PIN`), asserted at
  import, stamped on every `work.facts_run` row and into `work.build_meta.parser_version`. The same
  SQL yields different facts across sqlglot releases. Bumping the pin invalidates every `f_*` row
  and all four registries — rebuild them together.
- The parse needs `work.meta_columns` as its dictionary. Without it `qualify()` cannot bind an
  unqualified column to a table and those references are **silently dropped**, so the parse looks
  successful while producing thin facts. The copy is UNFILTERED on purpose.
- **`work.f_tables` is the parse of record and is never edited.** Corrections are applied in
  `p3_reconcile.sql`, into `work.r_tables`. Downstream reads `r_tables`; the reconcile step is the
  only consumer of `f_tables`. If the sqlglot pin moves, both rebuild together.
- **Exclusion is a parse output.** `parse_quality='full_lex'` ⟺ `excluded_reason='dynamic_lexical'`
  ⟺ the statement only parsed after its `&LEXICAL` parameters were substituted. Never a regex over
  the inventory.
- `work.norm_sql()` keeps its `translate()` of the Unicode whitespace set: JavaScript's `\s`
  matches U+00A0, PostgreSQL's does not, and one NBSP mints a wrong hash. The view-text cleanup
  uses `work.js_trim()`, not `btrim()` — `btrim` trims spaces only and would leave 507 views with
  a trailing CRLF.
- The embedder is the product's own (`src/corpus/embed.ts` + `embedTexts()`), imported, never
  reimplemented, and run inside `schema-mcp-build:latest` where the bge-small cache lives.
- Scripts run as `postgres`, so the last act of a build is `p7_own.sql`. It re-owns `work` ONLY
  unless told otherwise (`psql -v schemas='work,v2026_10'`): ownership is a write, and a build must
  not reach into a schema it did not produce.

## What the build does NOT create

`meta.seeds`, `meta.active_version`, `meta.library_migrations` and the whole `customer` schema are
DATABASE-level, not version-level: `scripts/pg-import/import.mts` writes the first two and
`src/db/postgres/migrations.ts` the last. A serving database needs them in addition to the version
schema.

`work.embeddings` and `work.layout_pattern` exist only after `p4` runs — a fresh `work` has no
vectors until `p4_vectors.sql` + `p4_run.sh` are run. The 2026-09-20 build ran them: 23,471 owners
→ 93,950 unit vectors, plus 46 layout owners → 224, in 26m56s over 12 shards.
