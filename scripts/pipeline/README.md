# Catalog release pipeline

Builds the `work` schema in `fusion_dev` on `stack-db`, and from it a `v<ver>` release schema;
`p9_release.sh` moves a release into the served database.

**`fusion_dev.v<ver>` is a RELEASE — immutable after `p7_own.sql`, byte-equal to what is
distributed. Only `work` is scratch. Any content change — one more table, one more row — is a
NEW label through the full chain (`p5_ddl.sh <ver>` → … → `p7_own.sql`), never an edit of an
existing `v<ver>`.** (Learned 2026-09-22: `p5_plsql.sh v2026_10` run against the distributed
release left `fusion_dev.v2026_10` ≠ `fusion.v2026_10`; reverted 2026-09-23, `v2026_11` built.)

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

Then `p4_run.sh` — incremental since 2026-09-21, so it re-embeds exactly the statements whose text
moved (slot 0 carries the table list AND the description). Run of 2026-09-21 after the recheck:
2,897 owners changed → 11,564 vectors embedded, 23,121 unchanged (the August-text statements,
byte-identical), 1 owner gone (4 rows deleted: `sql:883169ae…`, whose failed recheck line
superseded its good August record — a last-wins casualty, see below), 2m21s over 12 shards.
`work.embeddings`: 94,174 → 104,363 vectors, unit owners 23,471 → 26,018, every described
statement has a vector. `p4_knn.mts` on three gap-described probes: same top-1 as the shipped
corpus on 3/3, the gap statement surfaces at rank 5 (1099 distribution) and rank 6 (India GSTR1);
the Israeli-withholding probe's top-10 is the ten pre-existing withholding data models (10/10
overlap), the new row outside it.

**Last OK line wins (rule, 2026-09-21).** `qwen_record` used to keep the last line per unit id,
so a recheck line that FAILED replaced the successful record it was re-doing (`sql:883169ae…`
lost its August description and its vector). `p2_qwen_load.py` now lets a failed line supersede
only while the id has no ok record in any journal; a permanent failure stays a failure. The
reload restored TWO statements, not one: that recheck giant, and
`otbi:Absence Management - Leave Donations Real Time__Worker`, whose August otbi file holds an
ok line followed by a failed retry (last-line-wins had counted it as a failure, which is why it
was in the gap cohort — where it failed again). Text generations: August 23,121 → 23,123, gap
2,495, recheck 402; described statements 26,018 → **26,020**; `model_added` 890 / 401 unchanged;
p4 re-embedded exactly those 2 owners (8 vectors) → 104,147 unit + 224 layout = 104,371.

**Run of 2026-09-21 — measured.** Gap run: 2,582 → 2,548 ok / 34 failed (20 client-wall
timeouts, 14 truncated JSON; all giants at or near the 40,000 clip — they belong with the
oversized-deferred set, not with a plain retry). After that load: `missingTables` reported
1,077 (August) + 239 (gap) = 1,316; in text 1,228; in dictionary 1,098; already in parse 174;
**added 878 over 401 statements** (766 August incl. 19 rescued by the `FUSION.` strip, 112 gap).
Flagged-but-did-not-enumerate (`tablesConfirmed=false`, `missingTables=[]`): 91 August + 180 gap.
Recheck export: 2,898 candidates, 2,495 grounding unchanged, **403 moved** (350 August + 51 gap
`model_added` + 2 gap whose view cards moved), $0.38; run 402 ok / 1 failed
(`sql:883169ae…`, truncated JSON) in 7.6 min.

**Claims are a UNION across generations; text is last-wins.** The first load of the recheck
journal exposed it: `work.qwen_record` keeps one record per unit id, and the reconcile read the
table claims off that record only — but the recheck record had been shown the 878 additions IN its
FACTS block, so it did not repeat them, and the rebuild dropped them: `model_added` 878 → 180
(measured over the 403 prompts: 878 additions shown, 811 accepted silently, 61 called `extra`,
168 re-listed as `missing`, 710 lost). A later generation that omits a claim has not retracted it;
it saw the table. So `p2_qwen_load.py` now also writes **`work.qwen_claim`** — one row per claim
per journal LINE, every generation, with `run_id` and the `ghash` it was made against — and
`p2_promote.sql` fills `qwen_table_correction` from it (DISTINCT over statement, unit, generation,
kind, name; `run_id` on every row). `qwen_record` is unchanged: the text has exactly one current
generation and stays last-wins. The acceptance rule is untouched. Verified on the full reload
(ten primaries + gap + recheck): `model_added` **890 rows over 401 statements** — the 878
restored plus 12 names the recheck generation claimed new — 0 dropped; text generations
unchanged (August 23,121 · gap 2,495 · recheck 402 statements); a further `export` reports
**8 moved of 2,897**, every one explained: 6 carry those recheck-first additions, 2 reference a
view the recheck re-described (its card moved). That is grounding that genuinely changed, not
oscillation; running them is a judgement call ($0.01), not a repair.

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
| `p3_parse.sh`    | the REAL pinned sqlglot parse (`p3_parse.py`) over all 26,204 statements. Since 2026-09-30 a column resolves through the enclosing scopes (correlated subqueries), through inline views / CTEs to the physical column (every UNION branch), and `col IN (SELECT c …)` / a correlated equality inside `EXISTS` are `SEMI` join edges (f_joins 97,976 → 140,736; mined relationships 18,687 → 30,203). Unit tests: `test/test_sqlglot_extract.py` (python:3.12-slim + the pin) | ~2.5 min |
| `p3_post.sql`    | fact indexes, exclusions from real `parse_quality` | 4 s |
| `p3_reconcile.sql` | test every model claim, then `work.r_tables` — the reconciled fact set | 10 s |
| `p2_recheck.sh`  | after an enrichment run: `load` (journal → record → promote → reconcile → report → own), `export` (grounding moved), `run` (enrich) — see *Recheck* | load 40 s |
| `p3_rel.sql`     | `work.relationships` derived from `f_joins` + `meta_fkeys` | 6 s |
| `p3_calls.sh`    | PL/SQL call facts (`p3_calls.sql` DDL → `p3_calls.py extract` → `work.f_calls`), classified + rolled up by `p3_calls_post.sql` into `work.plsql_api` / `plsql_api_tables` / `plsql_packages` (dictionary PACKAGE objects ∪ called packages), exported to `data/plsql_api_usage.{json,csv,md}` | 45 s |
| `p3_otbi.sh`     | `OTBI_SRC=<distro dir> p3_otbi.sh [stage\|derive\|report\|all]` — the OTBI presentation catalog: `stage` (`p3_otbi_load.py`: lineage workbooks + SOAP crawl + probes → `work.otbi_lineage` / `otbi_crawl_*` / `otbi_probe*`, incl. the physical-SQL alias resolver), `derive` (`p3_otbi.sql` → `work.otbi_subject_area` / `otbi_folder` / `otbi_column` / `otbi_text`, the `ship` scope rule), `report` (`p3_otbi_report.sql` → `data/otbi_gap_list.md` + `data/otbi_reconciliation.md`). See *The OTBI presentation catalog* below | stage 6 min, derive 12 min |
| `p4_vectors.sql` | the `work.embeddings` table | 1 s |
| `p4_run.sh`      | incremental re-embed by `text_hash`, sharded (`p4_embed.mts` per shard): embeds changed slots only, deletes stale slots / gone owners; full on an empty table. Since ddl_version 4 it also embeds `work.otbi_text` (owner_kind `otbi`, one vector per distinct presentation text) and REQUIRES `p3_otbi.sh` to have run | 27 min full / ~2 min incremental, 12 shards |
| `p4_knn.mts`     | KNN probe of `work.embeddings` (+ `v2026_09` alongside) — p4's own gate, since p6 needs p5 | 40 s |
| `run_sql.sh`     | runner for the release `.sql` steps: `bash run_sql.sh <file.sql> <ver> [psql args]` substitutes `{{V}}`, stages the file in `stack-db`, runs it with `ON_ERROR_STOP` (`DB=` selects the database, default `fusion_dev`) | — |
| `p5_ddl.sh`      | `p5_ddl.sh <ver>` (label REQUIRED, `v<YYYY_MM>`): create `v<ver>` from the PRODUCT's `scripts/pg-import/ddl.sql`, stamp `work.build_meta.ddl_version` from its header | 2 s |
| `p5_fill.sql`    | populate the release tables from `work` (described statements, `sql:` ids, parse-derived fact columns, `r_tables` registries); `catalog_meta.ddl_version` = `work.build_meta.ddl_version` | 72 s |
| `p5_plsql.sh`    | `p5_plsql.sh <ver>`: `v<ver>.plsql_packages` / `plsql_api` / `plsql_api_tables` / `plsql_meta` (ddl_version 3) from `work.plsql_*` — one transaction, DELETE + INSERT, a step of the chain for the release being BUILT (samples restricted to shipped ids, api_tables to real objects) | 2 s |
| `p5_otbi.sh`     | `p5_otbi.sh <ver> <tbi release>` (both REQUIRED): `v<ver>.otbi_subject_area` / `otbi_folder` / `otbi_column` / `otbi_vec` / `otbi_meta` (ddl_version 4) from `work.otbi_*` + `work.embeddings` (`otbi` owners), shipped scope only (`work.otbi_folder.ship`); `grain_note` from the release's own `table_grain`; since ddl_version 9 also `otbi_vo` (the VO hop, from `work.otbi_lineage`), `otbi_column_ref` (the exposure index = every shipped column's `db_refs` exploded), `otbi_column.vo_refs` and `otbi_area_duty` (subject area → duty CODE from Oracle's TBI guides, `data/otbi/tbi_guides/<tbi release>/area_duty.jsonl`, matched by the normalized name or a curated rename alias of `otbi_area_aliases.json`; admin-class roles excluded; every unmatched area listed in `otbi_meta.area_duty_unmapped`) — after `p5_fill.sql` (which also fills `unit_titles`), before `p5_index.sql` | 1 min |
| `p5_security.sh` | `p5_security.sh <ver>`: `v<ver>.table_security` / `table_disallowed` / `sec_area_privilege` / `table_reference_family` / `sec_meta` (ddl_version 10) — the data-access security facts, NAMES ONLY (spec 2026-10-02 §7: no predicate text, no pod id; the condition is generated on the target pod by `FND_DATA_SECURITY.GET_SECURITY_PREDICATE`): every context column of every object → its reference object (exclusions → exact names → suffixes → the `ORGANIZATION_ID` chain: FK → [vote] → prefix → [vote] → sibling → [vote] → HCM view lineage → own id space → non-org partners, where [vote] = a fixpoint in which a resolved pass-through view column decides, else the corpus join partners' COLUMN contexts vote by statements, a tie going to the own prefix family → curated overrides `add` / `set` / `none`; an unresolved column on a USED object = `ambiguous` rows, which FAIL the p6 gate; on an object no corpus source uses = a `table_disallowed` row), Oracle precedent + join evidence from `work`, the curated area → (object, privilege) rows that OVERRIDE the resolver's rule (`sec_area_privilege`, rules `areaPrivileges`: every row names its pair and its instance scope — one shipped row per host of `instances`, `'*'` = every pod; the nameless `pending` rows are gone since v2027_05, the 35 demo-pod areas ship as `inferred`; ddl_version 9: `entity` = the (area, entity) key, the dictionary table the row's evidence binds the grant block to, `voDef` the VO when known; ddl_version 10: `column` = the TABLE.COLUMN a trace names → `context_column`, written by `sec_trace.py`), the reference families (`table_reference_family`, ddl_version 10, rules `referenceFamilies`: lookup / calendar / currency / territory / translation by name pattern AND reference-shaped columns, one row per table with its evidence — the end-user structural none rule reads them), the resolver's module filter (`sec_meta.privilege_prefix_aliases`, rules `privilegePrefixAliases.map`), the audited primary contexts (`sec_meta.primary_audit`, rules `primaryByPrefix.<prefix>.audit` — only these prefixes' multi-context tables are secured by the table-keyed plan; AP → BU from the Kornit OTBI trace, GL → LEDGER and DOO → BU from the demo crawl's grant blocks that name the entity they bind to, graded `crawl`), each context's evidence objects (`sec_meta.context_evidence_refs` — the area-keyed plan reads a VO's physical objects against them), the sensitive objects (`sec_meta.sensitive_objects`, rules `sensitive.rows`: national identifiers / passports / visas / licences / salary / supplier PII / bank accounts through their own pair(s), the masked twins derived from the dictionary) and `sec_meta` (stamps, context order, HCM prefixes, stats). Nothing of any customer pod is read (ddl_version 9: the pod export copies `sec_object` / `sec_privilege` are gone) — what differs per POD (registrations, grants, U, duties) lives ONLY in the customer layer, see *The customer security layer* below. Curated input = `p5_security_rules.json` (spliced verbatim; a rule / area-map change is a new label) + Oracle's own policies `oracle_datasec_policies.csv` (a LOCAL, gitignored input; the top source: `oracle_policy` columns + the module family of an application; see "Oracle's data-security policies" below; a new extract is a new label). After `p5_fill.sql`, before `p5_index.sql`. Tests: `test/securityJob.test.ts` runs this job on a synthetic dictionary + the SYNTHETIC policy fixture `test/fixtures/datasec-policies.csv` (postgres) | 1.5 min |
| `p5_index.sql`   | pgvector HNSW index on every searched embedding column | 40 s |
| `p6_verify.sql`  | the release gate: counts, content equality, dangling, stamps. Sections that read `work` / `v2026_09` are guarded (`\if`) so the same file runs in the served database after p9 | 2 min |
| `p6_knn.mts`     | exact-KNN spot check through the serving statement (`VER=<ver>` required; `v2026_09` is the baseline it is read against) | 30 s |
| `p6_otbi.mts`    | the OTBI gate THROUGH THE PRODUCT CODE (postgres provider + catalog.ts + otbiStore.ts): points the BUILD database's `meta.active_version` at `VER`, then listQueriesForSubjectArea coverage of the three verification subject areas, checkOtbiSql over the 33 real BI EE dataset SQLs (`test/fixtures/otbi-biee.json`), searchOtbi / describeOtbiFolder probes | 1 min |
| `p7_own.sql`     | `ALTER ... OWNER TO :owner` (default `fusion_dev`; `fusion` after a restore) — the last act of every build | 1 s |
| `p8_verify.sql`  | VERIFICATION ONLY against `v2026_09`; writes nothing | 20 s |
| `p9_release.sh`  | `p9_release.sh <ver> <target-db> <owner>` — the release move: dump `v<ver>` from `fusion_dev`, restore ALONGSIDE the served version (never drops the previous one), `p7_own.sql` with the target's role, `meta.seeds` from the release's OWN stamps (`catalog_meta.ddl_version` / `embedding_version`, gated against the `ddl.sql` header), `meta.active_version` switched LAST, `p6_verify.sql` in the target, the served-version line. Re-run = no-op with a message; a leftover schema = refused | ~3 min |
| `sec_layer_load.sh` | NOT a chain step — `sec_layer_load.sh <pod host> <stamp> <dir> <grantee>`: loads ONE pod's data-access security layer (its FND_OBJECTS registrations + key columns, every granted (object, privilege) with its grant-set signature, U = the pairs granted to the BI server identity, the FBI / analysis-duty pairs, the customer duty copies → their seeded twins, v4: the seeded job roles' grants — names only) into the SERVED database's `customer.sec_instance_*` through the product's own loader (`src/securityLayer.ts`, library migrations v2 + v3 + v4 applied first — v3 and v4 each empty every loaded layer, reload each pod); keyed by the pod host, one layer per host with its export stamp, a re-import replaces it. See *The customer security layer* | 20 s |
| `sec_trace.py` | NOT a chain step — the names-only OTBI trace loader: `extract` a LOGLEVEL-7 Session Monitor capture → resolve its ids through runSql → `load` the (object, privilege, entity, column) rows into `p5_security_rules.json` (source trace). See *The OTBI trace loader* + `docs/trace-capture-guide.md` | 1 s |

```bash
wsl -d CloudBeaver -u root -e bash -lc \
  'docker cp <file>.sql stack-db:/tmp/ && docker exec stack-db psql -U postgres -d fusion_dev -v ON_ERROR_STOP=1 -f /tmp/<file>.sql'
```

The release `.sql` steps (`p5_fill`, `p5_index`, `p6_verify`) name the release as `{{V}}` and run
through `run_sql.sh <file> <ver>` (`p7_own.sql` runs through the same runner, taking its
`-v schemas=` / `-v owner=`); the `.sh` / `.mts` steps run themselves. A full release build from a
finished `work`:

```bash
P=/mnt/c/.../scripts/pipeline; V=v2026_11          # the label: v<YYYY_MM>, the next free one
wsl -d CloudBeaver -u root -e bash -lc "bash $P/p5_ddl.sh $V"                                   # DDL + work.build_meta.ddl_version
wsl -d CloudBeaver -u root -e bash -lc "bash $P/run_sql.sh p5_fill.sql $V"
wsl -d CloudBeaver -u root -e bash -lc "bash $P/p5_plsql.sh $V"
wsl -d CloudBeaver -u root -e bash -lc "bash $P/p5_otbi.sh $V 26d"                              # the OTBI catalog + (ddl_version 9) VO hop, exposure index, area -> duty codes of the TBI guides 26d
wsl -d CloudBeaver -u root -e bash -lc "bash $P/p5_security.sh $V"                              # ddl_version 9: data-access facts, names only (p5_security_rules.json + the local Oracle policy extract)
wsl -d CloudBeaver -u root -e bash -lc "bash $P/run_sql.sh p5_index.sql $V"
wsl -d CloudBeaver -u root -e bash -lc "bash $P/run_sql.sh p6_verify.sql $V"
wsl -d CloudBeaver -u root -e bash -lc "docker run --rm --network oservices_default -v /tmp/pipeline-p6:/app/scripts/pipeline \
  -e DATABASE_URL=postgres://postgres:<pw>@stack-db:5432/fusion_dev -e VER=$V schema-mcp-build:latest npx tsx /app/scripts/pipeline/p6_knn.mts"
wsl -d CloudBeaver -u root -e bash -lc "bash $P/run_sql.sh p7_own.sql $V -v schemas=work,$V -v owner=fusion_dev"   # the last act: the release is now immutable
wsl -d CloudBeaver -u root -e bash -lc "bash $P/p9_release.sh $V fusion fusion"                 # move + switch (see below)
```

(`p6_knn.mts` is staged on the distro fs first — `cp scripts/pipeline/*.mts /tmp/pipeline-p6/` —
because the 9p `/mnt/c` mount does not bind-mount reliably; `p4_run.sh` does the same.) The
earlier `p2_qwen.sh` / `p3_parse.sh` / `p4_run.sh 12` steps take no label: they build `work`.

Heredocs and inline SQL through the WSL bridge mangle quoting — always `docker cp` a file.

### The release build — `v2026_10`, built 2026-09-21

`p5_fill.sql` was reworked onto the promoted columns and `r_tables` (it read columns
`p2_merge.sql` used to write, `f_tables`, and the old mixed `reports` shape). The user
decisions it implements, and where each lands:

1. **Corpus ids = `sql:<sql_hash>` for every source.** bip already was; otbi and view switch.
   The old ids are kept as REFERENCE rows in `reports`: ONE shape for all sources,
   `T.ReportRef` objects `{path, title, index}` (`src/db/base/enrich.ts` parses the column as
   `ReportRef[]`) — bip keeps exactly today's semantics (the crawl's `unit_ref` paths,
   `title = path`), and every other L2 unit that fed the statement (`otbi:<subject>__<item>`,
   `view:<NAME>`, `catalog:<path>#<seq>`) is a reference row with `path` = that old unit id and
   `title` = the unit's title. Capped at 50 per row — the cap `import_serving.mjs` applied
   (`paths.slice(0, 50)`); one otbi statement is shared by 14,009 units and 241 rows hit the cap;
   the full set is `work.sql_unit`. **For the PG-provider step:** `catalog.ts getReportQuery`
   tests `/^(sql:|view:)/` — every id is `sql:` now so it keeps working, but `view:` no longer
   names a row, and 67 otbi + 81 view + 18 bip shipped TITLES no longer resolve through
   `byTitle` (the title now lives on the hash's primary unit; a colliding unit's title is in
   `reports`/`l2_titles` only). Serving code was not touched.
2. **`tables_used` / `joins` / `filters` / `lookup_types` from the PARSE.** `tables_used` =
   `work.r_tables` (reconciled), physical objects, artifacts dropped, codepoint order; `joins` =
   `work.f_joins` as `FROM_T.FROM_C=TO_T.TO_C[TYPE]` (v2026_09's string shape); `filters` =
   `work.f_predicates` in `where`/`join` position only (a predicate inside a CASE or a subquery
   is not a filter of the statement), as `TABLE.COLUMN <op> literal`, statement order,
   de-duplicated; `lookup_types` = the literals of `EQ`/`IN` predicates on a column named exactly
   `LOOKUP_TYPE`, IN-lists split on commas, quotes stripped, sorted. **`security_predicate` stays
   NULL — not decided**, empty exactly as v2026_09 shipped it. `mechanics` and `low_confidence`
   reproduce `import_serving.mjs` (`work.mechanics_of`) — byte-identical to v2026_09 on all
   23,121 August-generation rows. `semantics_json` is the whole winning payload as jsonb text
   (JS `JSON.stringify` spacing differs; readers parse it). `approved = 1` on every vendor row
   (what the product's own importer writes).
3. **Membership = described statements only**: 26,020 = the embedding owners. Table-less rows
   stay in. The 184 undescribed L3 rows are not shipped.

Registries roll up over the SHIPPED corpus from `r_tables`/`f_joins`/`f_predicates`, so a
dangling `table_usages` row is impossible by construction. `relationships` = `work.relationships`
(28,055: 18,687 mined from `f_joins` + 9,368 declared from `meta_fkeys`); the p6 content-equality
row for it reports a full diff against v2026_09 BY DESIGN (that table carried the excluded OTBI
crawl tier and convention-mined edges). `col_vec` is carried from v2026_09 (953 rows) and
flagged in the script: it is a content-hash cache with no `work` input. There is no
`report_queries_fts` anywhere in the product DDL or serving code (only the generated
`tables.search` column, filled on insert) — nothing to build. `meta.active_version` is NOT
switched: the build would set `version = 'v2026_10'` (with a `meta.seeds` row
`embedding_model = bge-small-en-v1.5-384`, `ddl_version = 2`).

**Measured (p6 / p6_knn / p8), before → after where comparable:**

| item | v2026_09 | v2026_10 |
|---|---|---|
| `report_queries` | 23,746 | **26,020** after the last-OK-wins reload (26,018 on the first build: bip 8,744 · otbi 11,278 · view 5,996), all `sql:` ids |
| descriptions on shared August-generation statements | — | **23,123 / 23,123 byte-identical** (mechanics and intents too); 375 re-enriched differ as expected |
| tables / columns / pkeys / fkeys / indexes | 29,802 / 1,449,501 / 41,407 / 18,565 / 130,442 | identical, content EXCEPT = 0 both ways |
| relationships | 14,009 | 28,055 |
| `table_usages` (dangling) | 70,071 (13,682 dangling, 6,245 ids) | 63,061 (**0**) |
| `table_predicates` / `table_join_columns` / `table_grain` | 15,736 / 15,972 / 3,792 | 15,459 / 15,664 / 3,792, dangling 0 |
| vectors: `report_queries_vec_multi` + `layout_patterns_vec` | 95,614 + 224 | **104,147 + 224 = 104,371** (104,363 on the first build); slot 0 = `embedding` on every row |
| filters / lookup_types / joins / tables_used non-empty | 0 / 0 / 17,213 / 23,163 | 15,864 / 6,523 / 17,634 / 25,312 |
| `reports` non-empty | 11,455 (mixed shape) | 26,018 (one object shape) |
| version stamps | — | all six written by the build, registry stamps = code constants |
| ownership | — | `fusion_dev` on all 28 objects (`p7_own.sql -v schemas='work,v2026_10'`) |
| build time | — | p5_fill 1m12s, HNSW indexes 197 MB + 51 MB + 456 kB |

**KNN (`p6_knn.mts`, the same six probes as `p4_knn.mts`): mean top-10 overlap 6.8/10, same
top-1 on 2/6** — down from 9.0/10, and the whole drop is MEMBERSHIP, not the index: `p4_knn.mts`
(exact scan over the same 26,018 owners) gives the identical 6.8/10; the non-overlapping hits
are the newly described gap statements — on "general ledger journal lines" nine of the ten are
new bip datamodels ("Journal Drill Down Information YTD", "GLJeLines2DM", …) scoring 0.90 against
the shipped rows' 0.86. The one difference between exact and HNSW is a top-1 flip on the
fixed-assets probe (3/6 exact vs 2/6 HNSW) — the documented 95 % recall at `hnsw.ef_search = 40`.

**Gaps, reported not papered over:**
- **159 shipped v2026_09 rows are not in v2026_10** (161 before the last-OK-wins reload). Every
  one maps to an L3 row (p8 §1: 0 unreachable); they are absent because they have no
  generation-2 description: 144 bip are the `dynamic_lexical` exclusion (v2026_09 carried gen-1
  text for them, which is out by rule), 15 are enrichment failures from the gap run (11 bip + 4
  view — the truncated-JSON / timed-out giants).
- 166 shipped titles no longer resolve via `byTitle` (above, item 1).
- `col_vec` carried, `flexfields`/`adf_extensions` carried (our demo pod's configuration in a
  vendor schema — flagged in the script since the first build).

### Into `fusion` — `p9_release.sh` (2026-09-23; the 2026-09-21 move was done by hand)

The release schema moves between databases as a plain custom-format dump; `meta` is
database-level. `p9_release.sh <ver> <target-db> <owner>` is the whole move, and the first
concrete piece of the "upgrade job" the DB-library plan named:

```bash
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p9_release.sh v2026_11 fusion fusion'
```

It refuses unless the release exists in `fusion_dev` with its own stamps, the target has
`meta.seeds` + `meta.active_version`, and the target does not already hold `v<ver>` (a re-run
against the served version is a no-op with a message; a leftover schema is refused, never
dropped). Then: `pg_dump -Fc -n v<ver>` → `pg_restore --no-owner --exit-on-error` ALONGSIDE the
served version (the previous schema stays — rollback is
`UPDATE meta.active_version SET version='<previous>'`, which `refreshIfMoved()` follows) →
`p7_own.sql -v schemas=v<ver> -v owner=<owner>` → `ddl_version` + `embedding_version` read FROM
THE RESTORED `catalog_meta` (never typed; `ddl_version` gated against the `ddl.sql` header, i.e.
what the serving image's `EXPECTED_DDL_VERSION` speaks) → `ANALYZE` → one transaction: upsert
`meta.seeds`, then switch `meta.active_version` LAST → `p6_verify.sql` in the target
(release-only sections) → the `served: db=… active_version=… ddl_version=… embedding_model=…`
line. After it: the serving image must be built from a `ddl.sql` with the same header, then
`docker compose build fusion-schema-mcp && up -d` from `devops/`. Rehearsed 2026-09-23 against a
throwaway `fusion_rehearsal` (meta block + `v2026_10` served, `v2026_11` moved in: 388 MB dump,
2 min, byte-equal on every table, second run no-op, `v2026_10` re-activatable, dropped).
`pg_restore` REBUILDS the three HNSW indexes, and a parallel build fails on the container's
`/dev/shm` (`could not resize shared memory segment`) — p9 runs it with
`PGOPTIONS='-c max_parallel_maintenance_workers=0 -c maintenance_work_mem=1GB'`, the same setting
`p5_index.sql` uses; the 2026-09-21 hand restore only got through by luck.

The 2026-09-21 move of `v2026_10` was the same sequence by hand (`DROP SCHEMA IF EXISTS` first —
the one thing p9 does NOT do). `p7_own.sql` takes the owner as a variable (`-v owner=`, default
`fusion_dev`). Verified then in
`fusion` as role `fusion`: all 25 tables count-identical to `fusion_dev.v2026_10` (26,020 /
104,147 / 29,802 …), four `vector` columns, the three HNSW indexes restored (197 MB / 51 MB /
456 kB) and chosen by the planner, exact-KNN top-10 identical across the two databases, 0 objects
not owned by `fusion`, `meta.active_version = v2026_10` (the `v2026_09` seeds row is left in
place; that schema does not exist in `fusion`). `raw`, `v2026_09`, `/opt/fusion-catalog-test/`
untouched.

**The provider** (`src/db/postgres/`) already resolved `meta.active_version` at open and put it on
every pooled connection's `search_path` (`refreshIfMoved()` rebuilds the pool when the pointer
moves), and `PgMeta.verify()` builds nothing at boot — the registry stamps the build writes are the
code constants the `ensure*Registry()` gates compare against, so boot finds them "present". Three
changes were needed for the v2026_10 shape, nothing else in the MCP was touched:

- `provider.ts`: `hnsw.ef_search = 100` on every pooled connection (startup parameter). pgvector's
  default 40 measured 95.0 % recall@10 against the exact scan `PgCorpus.knn` is documented to
  match; 100 measured 100 % for +0.08 ms per probe. Verified through the pool: `SHOW` returns 100.
- `corpus.ts`: `byTitle()` — the exact, indexed statement first ("largest SQL wins", unchanged),
  and on a miss a scan of `reports[].title` (`jsonb_array_elements`), so the 166 shipped titles
  that belonged to a unit which lost the collision pick still resolve to their statement.
- `catalog.ts`: `getReportQuery` treats `sql:` as the only id shape (`/^sql:/`); `view:` and
  `otbi:` are reference paths in `reports`, not ids. The old `/^(sql:|view:)/` was removed, not
  kept as a fallback.

Typecheck + `npm test` (the SQL-placement gate + 27 tests) pass on both `CATALOG_DB=sqlite` and
`CATALOG_DB=postgres` (throwaway database on `stack-db`), run inside `schema-mcp-build:latest`.

**Switching the dev container** (devops, not done here): `fusion-schema-mcp` selects the provider
with `CATALOG_DB=postgres` and takes the connection as `DATABASE_URL` (`postgresql://fusion:<pw>@
stack-db:5432/fusion` — the `fusion` role's password from the stack secrets, never a literal in
compose); it must be on the `oservices_default` network. With that, `DATA_DIR` and every
`*_DB` sqlite override (`schema.sqlite`, `reports.sqlite`, `enrich.sqlite`, `cache.sqlite`,
`facts.sqlite`) and the `/opt/fusion-catalog-test` mount are unused by the catalog path. Not a
fallback: `CATALOG_DB` is required and the sqlite provider stays a coexisting, selectable
provider (`src/db/index.ts`), which is the product's design and a decision for the user, not
legacy this pass removed.

## The OTBI presentation catalog — `p3_otbi.*`, `p5_otbi.*`, `p6_otbi.mts` (ddl_version 4, 2026-09-28)

The grounding for the business persona's logical SQL (`docs/superpowers/specs/2026-09-28-business-
persona-logical-sql-design.md` §4.1–4.3; the KB article is `knowledgebase/articles/otbi-logical-sql.md`).
Three inputs, staged ONCE on the distro fs (`OTBI_SRC`, no default): the six release-13 (26B) lineage
workbooks, the demo pod's SOAP crawl (`subject_areas.json`, 664 subject areas / 87,451 folders /
2,092,580 columns with `dataType`) and the per-folder probes (`presentation_tables.jsonl`, 86,875
folders: status, the logical column list, the crawler's lineage, the physical SQL).

- **`p3_otbi_load.py`** stages them verbatim (the workbook's literal quotes around dash-folders are the
  one normalisation) and resolves every probe's OBIS alias chain: the outermost `cN` is
  `logicalColumns[N-1]`; `Dx.cM` references are followed through the `SAWITHk` CTEs, the join groups
  (`(((A D1 left outer join B D2 On …) …)` — parentheses that are NOT subqueries are stripped) and the
  ADF derived tables down to `TABLE.COLUMN`; the first aggregate met is the column's `aggregation`, a
  non-trivial expression its `expression`. 741,245 lineage rows (328,734 distinct columns); 949,451
  probe columns; 86,875 probes (86,358 ok, 758 ok-without-SQL, 517 failed, 755 alias mismatches).
  It resolves where the crawler's own lineage collides (`C61309499` = `HCM_LOOKUPS.MEANING` in every
  lookup subquery): lineage-vs-probe refs agree or nest on 250,882 of 256,566 columns that both cover,
  probe-vs-crawl disagree on 49,721 of 792,961.
- **`p3_otbi.sql`** derives `work.otbi_subject_area` (665) / `otbi_folder` (87,509) / `otbi_column`
  (2,093,707), descriptions from existing data only (`desc_source` table_remark / view_remark /
  expression_remarks; `gap_cause` otherwise), the `ship` scope (§1b: not a nested `A > B > C` path,
  not a `custExt<uuid>` subject area, not a crawl-only `… Extension` / `… Custom Attributes` folder —
  the workbooks under-document vendor folders without DB mapping, so crawl-only flat folders inside
  workbook subject areas DO ship: 7,108 of them, 5,999 with a corpus unit) and `work.otbi_text` —
  one row per distinct shipped text, md5-keyed: **99,340** (71,349 column texts for 493,995 shipped
  columns: a column text carries no subject area / folder, so one vector serves every location).
- **`p3_otbi_report.sql`** → `data/otbi_gap_list.md` (shipped scope: 132,332 of 493,995 columns
  without description, by cause; a dedupe estimate of 17–19k distinct items for an LLM pass) and
  `data/otbi_reconciliation.md` (lineage-only / crawl-only / corpus-only, the ship-scope table, the
  three-source DB-ref agreement, probe coverage, the three verification subject areas).
- **`p4_run.sh`** embeds `work.otbi_text` (owner_kind `otbi`, owner_id = text_hash, slot 0, incremental).
- **`p5_fill.sql`** fills `unit_titles` (every L2 unit title → its statement's row; spec §4.2);
  **`p5_otbi.sh <ver>`** projects the shipped scope + `otbi_vec` + `grain_note` (from the release's own
  `table_grain`); **`p5_index.sql`** adds the HNSW index on `otbi_vec`; **`p6_verify.sql` §6b** counts
  and dangling checks; **`p6_otbi.mts`** = the gate through the product code (below).

**ddl_version 9 (v2027_07, plan 2026-10-04 phase 2)** — the lineage the area-keyed data-access plan reads:
`otbi_vo` (subject area, folder, vo_path, vo_def → the VO's physical `db_objects` + mapped `vo_attrs`, from
`work.otbi_lineage`; 74,094 rows), `otbi_column.vo_refs` (the VO(s) a column is read through),
`otbi_column_ref` (the exposure index: one row per (presentation column, distinct physical table.column) of
`db_refs`, with the folder kind, the sources and `via_expression`; 643,341 rows — `foldersOfTable` reads it,
p6 gates it equal to the exploded `db_refs`) and `otbi_area_duty` (subject area → duty role CODE from Oracle's
Transactional BI guides: `p3_tbi_guides.py` crawls them into `data/otbi/tbi_guides/<release>/`
(`docs/tbi-guides-crawl.md`), `p3_tbi_aliases.py` writes the curated renames `otbi_area_aliases.json` — a catalog
area whose name matches no guide page, paired with ONE guide area by a mutual-best normalized-name similarity
≥ 0.90 AND an identical duty set among the competing candidates, the evidence recorded per alias; 23 accepted,
7 rejected (denied in end-user mode)). `p5_otbi.sh <ver> 26d`: 1,447 pairs, 511 areas by name + 23 by alias,
108 unmapped (`otbi_meta.area_duty_unmapped`: custom subject areas, guide pages without roles, areas in no
guide); admin-class roles (`BI_ADMINISTRATOR` / `BI_AUTHOR` / `BI_CONSUMER` shapes) are never area holders.

Shipped in `v2026_12`: 642 subject areas, 27,349 folders (1,778 fact), 493,995 columns (361,663
described = 73.2 %; 9,998 measures with aggregation; 99.9 % with dataType), 99,340 vectors, and
`unit_titles` = 107,855 rows (otbi 85,715 titles → 11,279 statements, catalog 9,833, bip 6,234);
`in_corpus` / `unit_id` are set only where the folder's statement is in the release (12 shipped
folders have a unit without enrichment and therefore no served statement). p6 gates: every
shipped entity has its vector, 0 dangling; `p6_otbi.mts` — every lineage folder with a unit is
listed for the three verification subject areas (GL Balances 8/16 have a unit, AP Invoices 93/95,
Worker Assignment 64/64), 26 of 31 catalogued BI EE datasets lint clean and 5 fail only on named
pod-specific content (4 extension-folder datasets, 2 flex columns), 2 select from a `custExt` area. NOT shipped and reported: 58,904 nested extension paths
(513,981 columns), 1,143 Extension / Custom Attributes folders (1,083,874 columns), 23 `custExt`
subject areas (113 folders) — the demo pod's configuration, the standing of flexfields/adf_extensions;
a ruling to confirm, not a fact.

## Oracle's data-security policies — `oracle_datasec_policies.csv` (p5_security input, 2026-09-30)

**Provenance.** Oracle's seeded data-security policies whose predicate uses URDA, extracted read-only
from a Fusion pod on 2026-09-30 (seeded metadata — the same on every pod of a release; the pod
release was not recorded with the extract). The file carries instance-set PREDICATE text read from a
customer pod, so it is a LOCAL input: gitignored, never in the image (the job test runs on the synthetic
`test/fixtures/datasec-policies.csv`), and only the names its parse yields reach a release. Extracted with:
`SELECT o.database_object_name, o.obj_name, ois.instance_set_name, DBMS_LOB.SUBSTR(ois.predicate,1000,1)
FROM fnd_objects o JOIN fnd_object_instance_sets ois ON ois.object_id = o.object_id
WHERE UPPER(ois.predicate) LIKE '%FUN_USER_ROLE_DATA_ASGNMNTS%'` — 150 instance sets on 60 objects,
predicates cut at 1,000 characters (7 are). Kept verbatim (header `TABLE_NAME,OBJ_NAME,INSTANCE_SET_NAME,
PREDICATE`, multi-line quoted predicates); `p5_security.sh` stages it in `stack-db` and the job's
`\copy` reads it. A new extract = a new release label.

**What the job does with it** (`p5_security.sql` §2b / §4b / chain stage 0, rules `oraclePolicy` +
`moduleFamilies`): every predicate is parsed (a paren/quote-aware scan, no guessing) into its
top-level `<col> IN (SELECT …)` lists. Shape `direct` = the object's column filtered by
`SELECT <URDA context column> FROM FUN_USER_ROLE_DATA_ASGNMNTS` → that column's context is Oracle's
(confidence `oracle_policy`, evidence = its instance sets, named with the OBJ_NAME in the reason),
replacing every rule / chain / curated candidate of the column; several contexts on one column (one
set per module, `INV_ORG_PARAMETERS`) → the standard set (`STD`) decides, the others are named;
no standard set → a reported `conflict` (`XLA_TRANSACTION_ENTITIES.SECURITY_ID_INT_1`). Shapes
`derived` (a mapping object between URDA and the column), `exists` (another object), `datasec`
(`DATASEC_CONTEXT_TYPE_CODE`: legal entity, budget level, award org hierarchy), `non_context`
(`COLLABORATION_DOC_ID`) and `unparsed` never become facts — they are reported in `sec_meta`
(`policy_sets` per set with its reason, `policy_columns` per column, `policy_source`). The **module
family** of an application (`module_families`) comes from the org-family sets' codes (the set name
after the compacted OBJ_NAME): a code that is a catalog application gives it that set's context
(WIE → MFG_ORG; MNT, ENQ, INV, DOS, RCV → INV_ORG), a set of another code on an object's own
`ORGANIZATION_ID` gives the object's application its context (CSE → INV_ORG via CSEASSETSBMNT77);
`judgment` entries (WIS → MFG_ORG, QA → INV_ORG) carry their reason and fail the build if the
policies also speak for that application. It decides the generic `ORGANIZATION_ID` of an object
without its own policy right after the declared FK, ahead of the votes / lineage / prefix. (The
OTBI-mined `FND_GRANTS` triples — demo-pod ids — are gone since 2026-10-02, spec §7: the privilege
NAME per object comes from `p5_security_rules.json` `areaPrivileges`; the pod export `data/security/`
and its `sec_object` / `sec_privilege` copies are gone since ddl_version 9 — what a pod registers and grants is
its customer layer; see "Data-access security facts" in the KB article.)

## The customer security layer — `sec_layer_load.sh` (`customer.sec_instance_*`, library migrations v2 2026-10-03 + v3 2026-10-05 + v4 2026-10-05)

The resolver (`src/corpus/dataAccess.ts`: the tool `getDataAccessPredicate({instance, tables})` and the
`dataSecurity` pushed by getTable / getColumns / validateColumns / validateTable when called with
`instance`) chooses, per table of a query, the (object, privilege) pair whose condition the pod generates
— and what that choice depends on differs per pod: which security objects THIS pod registers (with their
key columns), which (object, privilege) pairs carry a grant on it, U = the pairs granted to the BI server
identity `FUSION_APPS_OBIA_BIEE_APPID` (the OTBI-visible security points; privilege = U ∩ object, generic
read/update/delete/insert excluded, filtered by the secured table's module prefix through
`privilegePrefixAliases`), every granted pair with its grant-set signature (pool 2 of the privilege choice),
the FBI / analysis-duty pairs (the HCM route) and the customer copies of those duties. Customer objects,
customer duty copies and grant changes make these per-instance, so they are NOT in the immutable release:
they live in the served database's `customer` schema — `sec_instance` (one row per pod host: `stamp`,
`loaded_at`, `grantee`, `counts`), `sec_instance_object`, `sec_instance_privilege` (+ `grant_sig`,
`n_grants` since v3), `sec_instance_u`, `sec_instance_duty`, `sec_instance_duty_alias` (v3) (`src/db/postgres/ddl.ts`
migrations v2 + v3; sqlite: `factsdb`, `src/db/sqlite/ddl.ts`) —
keyed by the pod host EXACTLY as `runSql` reports `instance`, one layer per host with its export stamp
(`layerStamp` in every plan); a re-import replaces the host's rows in ONE transaction and records the new
stamp. The instance is a REQUIRED input of every call that involves the layer — no default instance, no
"one layer loaded ⇒ that one"; an unknown host is a loud error naming the loaded ones. NAMES ONLY: no
predicate text, no instance-set text, no id; `grant_sig` is `SUM(DISTINCT ORA_HASH(grantee || type ||
instance-set NAME))` over a pair's whole grant set — equal signatures = the same predicate for every user,
which is how the resolver treats privileges with identical grant sets as equivalent (`equivalentTo`). The
same signature is exported on the privileges, u and duties pages, and the loader refuses pages that
disagree (= exported at different moments). **v3 (2026-10-05)** added the signature to every granted pair
and the alias page; the migration EMPTIES every layer loaded before it (a layer without signatures is never
served) — reload each pod with the v3 export; until then the plan says the layer is not loaded. **v4 (2026-10-05,
revised phase 3)** added `sec_instance_role_grant` = every (role, object, privilege) NAME the pod's seeded job /
abstract / discretionary roles hold (the job-role consensus: the job roles Oracle's TBI guides name for a subject area
vote on the privilege of an object — `otbi_area_job` in the release); the migration EMPTIES every layer loaded before it
(a layer without the role grants would make the consensus silently find nothing) — reload each pod with the v4 export.
Customer copies of the job roles are NOT exported: on Kornit TEST the 32 name-matched copies hold identical (23) or
subset (9) grant sets of their seeded twins on the key objects, never more — the seeded roles' consensus bounds them.

**Export** — read-only, on the pod, through `runSql` (one query at a time, ≥ 5 s apart, pages small
enough to stay inline: the reply must carry every row — `rows.length == rowCount`, no `rowsInline`). Save
each reply VERBATIM (the whole JSON, `instance` included) as `<dir>/<kind>-<n>.json`, `n` = 1..N in page
order; `<dir>` = `data/security/instances/<pod host>/<stamp>/` (customer data of one pod — kept out of git like
the `data/security/*.csv` export; NOTE `.gitignore`'s `data/*.json` does not cover this nested path).

```sql
-- objects-<n>.json: FND_OBJECTS — the API name, the FROM object of the isolated form, the key columns (pages of 600)
SELECT obj_name, database_object_name, pk1_column_name, pk2_column_name, pk3_column_name, pk4_column_name, pk5_column_name
FROM fnd_objects ORDER BY obj_name
OFFSET 0 ROWS FETCH NEXT 600 ROWS ONLY;                        -- then OFFSET 600, 1200, … until a short page

-- privileges-<n>.json: every (object, privilege) with an active ALLOW grant, whoever the grantee, with the signature of
-- its WHOLE grant set — the `sig` CTE of the u / duties pages over ALL grantees (v3; pages of 1,500 with maxRows 1501:
-- the two signature columns push a 2,500-row page past runSql's 256 KB inline limit)
WITH act AS (
  SELECT g.object_id, g.menu_id, g.grantee_key, g.instance_type, g.instance_set_id FROM fnd_grants g
  WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)),
pairs AS (
  SELECT a.object_id, cmf.function_id, a.grantee_key, a.instance_type, a.instance_set_id
  FROM act a JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = a.menu_id),
sig AS (
  SELECT p.object_id, p.function_id,
         SUM(DISTINCT ORA_HASH(p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-'))) AS grant_sig,
         COUNT(DISTINCT p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-')) AS n_grants
  FROM pairs p LEFT JOIN fnd_object_instance_sets s ON s.instance_set_id = p.instance_set_id
  GROUP BY p.object_id, p.function_id)
SELECT o.obj_name, ff.function_name AS privilege, sig.grant_sig, sig.n_grants
FROM sig JOIN fnd_objects o ON o.object_id = sig.object_id JOIN fnd_form_functions ff ON ff.function_id = sig.function_id
ORDER BY 1, 2 OFFSET 0 ROWS FETCH NEXT 1500 ROWS ONLY;          -- then OFFSET 1500, 3000, …

-- u-<n>.json: U — the pairs granted to the BI server identity, with the grant-set signature (one page on Kornit: 328 rows)
WITH act AS (
  SELECT g.object_id, g.menu_id, g.role_name, g.grantee_key, g.instance_type, g.instance_set_id FROM fnd_grants g
  WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)),
pairs AS (
  SELECT a.object_id, cmf.function_id, a.role_name, a.grantee_key, a.instance_type, a.instance_set_id
  FROM act a JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = a.menu_id),
u AS (SELECT DISTINCT object_id, function_id, instance_type FROM pairs WHERE role_name = 'FUSION_APPS_OBIA_BIEE_APPID'),
sig AS (
  SELECT p.object_id, p.function_id,
         SUM(DISTINCT ORA_HASH(p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-'))) AS grant_sig,
         COUNT(DISTINCT p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-')) AS n_grants
  FROM pairs p LEFT JOIN fnd_object_instance_sets s ON s.instance_set_id = p.instance_set_id
  WHERE (p.object_id, p.function_id) IN (SELECT object_id, function_id FROM u)
  GROUP BY p.object_id, p.function_id)
SELECT o.obj_name, ff.function_name AS privilege, u.instance_type, sig.grant_sig, sig.n_grants
FROM u JOIN fnd_objects o ON o.object_id = u.object_id JOIN fnd_form_functions ff ON ff.function_id = u.function_id
JOIN sig ON sig.object_id = u.object_id AND sig.function_id = u.function_id
ORDER BY 1, 2, 3;                                               -- page it the same way (OFFSET/FETCH) past 2,500 rows

-- duties-<n>.json: the FBI / analysis-duty pairs with the same signature (pages of 1,000)
WITH act AS (
  SELECT g.object_id, g.menu_id, g.role_name, g.grantee_key, g.instance_type, g.instance_set_id FROM fnd_grants g
  WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)),
pairs AS (
  SELECT a.object_id, cmf.function_id, a.role_name, a.grantee_key, a.instance_type, a.instance_set_id
  FROM act a JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = a.menu_id),
d AS (SELECT DISTINCT role_name AS duty_role, object_id, function_id FROM pairs
      WHERE role_name LIKE '%FBI%' OR role_name LIKE '%ANALYSIS_DUTY%'),
sig AS (
  SELECT p.object_id, p.function_id,
         SUM(DISTINCT ORA_HASH(p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-'))) AS grant_sig,
         COUNT(DISTINCT p.grantee_key || ':' || p.instance_type || ':' || NVL(s.instance_set_name, '-')) AS n_grants
  FROM pairs p LEFT JOIN fnd_object_instance_sets s ON s.instance_set_id = p.instance_set_id
  WHERE (p.object_id, p.function_id) IN (SELECT object_id, function_id FROM d)
  GROUP BY p.object_id, p.function_id)
SELECT d.duty_role, o.obj_name, ff.function_name AS privilege, sig.grant_sig, sig.n_grants
FROM d JOIN fnd_objects o ON o.object_id = d.object_id JOIN fnd_form_functions ff ON ff.function_id = d.function_id
JOIN sig ON sig.object_id = d.object_id AND sig.function_id = d.function_id
ORDER BY 1, 2, 3 OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY;       -- then OFFSET 1000, …

-- aliases-<n>.json: the customer copies of those duties -> the seeded duty each copies (v3; one page; an empty result is
-- still a page). Name rule: a non-ORA_ role holding `FBI_` copies 'ORA_' || its name from `FBI_` on, trailing `_NEW`s cut,
-- kept only when that seeded role holds grants itself (e.g. <prefix>_FBI_PERSON_…_DUTY_HCM_NEW -> ORA_FBI_PERSON_…_DUTY_HCM).
-- A copy named otherwise is not aliased (it still serves the duty map with its own grants).
WITH d AS (
  SELECT DISTINCT g.role_name FROM fnd_grants g
  WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)
    AND (g.role_name LIKE '%FBI%' OR g.role_name LIKE '%ANALYSIS_DUTY%')),
c AS (
  SELECT role_name AS duty_role,
         'ORA_' || REGEXP_REPLACE(SUBSTR(role_name, INSTR(role_name, 'FBI_')), '(_NEW)+$', '') AS seeded_role
  FROM d WHERE role_name NOT LIKE 'ORA\_%' ESCAPE '\' AND INSTR(role_name, 'FBI_') > 0)
SELECT c.duty_role, c.seeded_role FROM c WHERE c.seeded_role IN (SELECT role_name FROM d) ORDER BY 1;

-- role_grants-<n>.json (v4): every (role, object, privilege) NAME of the seeded job / abstract / discretionary roles, generic
-- read / update / delete / insert left out (pages of 1,100 with maxRows 1101 — about 190 KB inline; Kornit TEST: 9 pages,
-- 9,767 rows, 291 roles, 579 objects; the seeded `%_DUTY_OBI` reporting duties the guides list as job codes hold no data grant there)
SELECT DISTINCT g.role_name AS role_name, o.obj_name AS obj_name, ff.function_name AS privilege
FROM fnd_grants g
JOIN fnd_objects o ON o.object_id = g.object_id
JOIN fnd_compiled_menu_functions cmf ON cmf.menu_id = g.menu_id
JOIN fnd_form_functions ff ON ff.function_id = cmf.function_id
WHERE g.grant_type = 'ALLOW' AND g.start_date <= SYSDATE AND (g.end_date IS NULL OR g.end_date >= SYSDATE)
  AND g.role_name LIKE 'ORA\_%' ESCAPE '\'
  AND (g.role_name LIKE '%\_JOB' ESCAPE '\' OR g.role_name LIKE '%\_ABSTRACT' ESCAPE '\' OR g.role_name LIKE '%\_DISCRETIONARY' ESCAPE '\')
  AND LOWER(ff.function_name) NOT IN ('read', 'update', 'delete', 'insert')
ORDER BY 1, 2, 3 OFFSET 0 ROWS FETCH NEXT 1100 ROWS ONLY;      -- then OFFSET 1100, 2200, … until a short page
```

**Load** — the product's own loader (`src/securityLayer.ts`, `npm run sec-layer`) in the service image,
against the service's OWN catalog configuration (`CATALOG_DB` + `DATABASE_URL` read from the running
`fusion-schema-mcp` container — never typed, never a new variable); it applies the library migrations
first (the layer tables are migrations v2 + v3 + v4), checks every page (exported from THAT host, complete
inline, no overlapping pages, every U / duty pair among the granted pairs WITH the same signature, every
granted pair on a registered object, every alias linking two duties of the duty pages, every role grant a
granted pair) and replaces the host's layer in one transaction:

```bash
wsl -d CloudBeaver -u root -e bash -lc "bash $P/sec_layer_load.sh <pod host> <stamp> <dir> FUSION_APPS_OBIA_BIEE_APPID"
```

All four arguments are REQUIRED (`<grantee>` = the role the `u` pages were exported for, recorded with
the layer). The serving container reads the layer on its next request — no restart (a library-version bump
needs the loader run BEFORE the new image serves: `meta.verify()` refuses a database without the expected
migration). Refresh after a Fusion quarterly update or a security change (a new stamp, same command).
Kornit TEST, 2026-10-03 (stamp `2026-10-03`, v2): 1,028 objects, 7,051 granted pairs, U 328 rows (140
objects / 326 pairs), 1,641 duty pairs. Kornit TEST, 2026-10-05 (stamp `2026-10-05`, v3, release v2027_06):
1,028 objects, 7,051 granted pairs in 4,974 (object, grant set) classes, U 328 rows (140 objects), 1,641 duty
pairs (71 duties), 16 duty aliases (the `XXKD_FBI_…_NEW` copies); a re-run reloads to the same counts.
Kornit TEST, 2026-10-05 (stamp `2026-10-05-v4`, v4, release v2027_08): the same objects / privileges / U / duties /
aliases pages + 9 `role_grants` pages = 9,767 role grants of 291 seeded job / abstract / discretionary roles on 579
objects (every one a granted pair); loaded in 1 s after migration v4.

What the resolver does with it — the full rules are the header of `src/corpus/dataAccess.ts` (the one source;
phase 1 = the TABLE-keyed developer plan, phase 2 = the (subject area, VO entity) keying + the end-user plan,
revised phase 3 = the job-role consensus, the strictest of candidates, the known area privilege, the structural none
rule, filter-only columns, the no-area policy). In short: route = a sensitive side table through its own object and
privilege(s) → the table itself when the instance registers it with a grant in U or the duty map (`direct`) → ONE
context column through its reference object (`reference`; table keying: the release's primary, multi-context only
under an audited prefix; area keying: the context the area binds, the column a trace names) → pool 2 (`direct`).
Privilege, first that applies: curated row (area keying: keyed to the condition's entity, else any row of the area on
the object) → sensitive → HCM duty map (area keying: the area's duties) → U ∩ product prefixes, one grant-set class
(`rule`) → the job-role consensus of the area (`consensus`, area keying, non-HCM, from `customer.sec_instance_role_grant`)
→ END-USER only: the strictest of candidates (`strictest`, the area's own-module tables, every class AND-ed in the one
condition) → pool 2 (`granted`, developer only). Anything else = `blocked` with the candidates. The END-USER plan
reads a `none` table by the structural rule (`structural`: no declared / mined relationship to secured data, or a
reference-family member) and never a business table no subject area reads (`readInstead`). Coverage through the
resolver: `security_coverage_resolver.sh <pod host>` (developer + end-user views per (table, area), the
consensus-vs-rule disagreements, the decision-4 check).

## The OTBI trace loader — `sec_trace.py` (names only, revised phase 3, 2026-10-05)

NOT a chain step: it turns ONE OTBI LOGLEVEL-7 capture (a Session Monitor export, HTML or MHTML) into curated
`areaPrivileges` rows of `p5_security_rules.json` (source `trace`); a release built afterwards carries them
(`sec_area_privilege`, the row's `column` → `context_column`). Predicate text is never stored or printed — the
evidence is the capture's file name, the number of grant blocks and their SHA-256 + length; the ids live only in the
gitignored drop folder. Which analyses to capture and how: `docs/trace-capture-guide.md`.

```bash
T=/mnt/c/.../fusion-schema-mcp
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py extract 'data/security/traces/<capture>.mhtml' --out data/security/traces/<capture>"
#   -> <capture>/blocks.json (per grant block: object / function / instance-set ids, the entity alias + its FROM table + key,
#      the TABLE.COLUMNs the statement joins to that key, block hashes) + <capture>/resolve.sql (ONE read-only statement)
#   run resolve.sql through pod-mcp runSql on the pod the capture came from; save the reply VERBATIM as <capture>/resolve.json
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py load data/security/traces/<capture> --area '<subject area>' --instances <pod host> --dry-run"
wsl -d CloudBeaver -u root -e bash -lc "cd $T && python3 scripts/pipeline/sec_trace.py load data/security/traces/<capture> --area '<subject area>' --instances <pod host>"
```

One row per (object, privilege) of the capture: `{area, object, privilege, source: "trace", instances, entity?,
column?, evidence}` — `entity` when the blocks name exactly one FROM table for their alias, `column` when exactly one
TABLE.COLUMN joins its key (else the row stays area-level and the note says why). The upsert keeps every other byte
of the rules file: a row of the same (area, object) is REPLACED (an inferred row, or a trace row with the same
privilege); a trace row of that (area, object) naming ANOTHER privilege refuses the load (two traces disagree — decide
by hand). `--area` and `--instances` are required (a pod host exactly as runSql reports `instance`, or `*` when the
pair is Oracle-seeded and the reviewer accepts it for every pod). Tests: `test/test_sec_trace.py` (synthetic capture,
`python3 test/test_sec_trace.py` in the distro). Acceptance 2026-10-05: both Kornit TEST captures
(`data/security/coverage/Session Monitor.html` and `.mhtml`, different runs) reproduce the AP row —
`FUN_ALL_BUSINESS_UNITS_V` / `AP_REPORT_PAYABLES_DATA`, entity `FUN_BU_PERF_V` (alias `BusinessUnit`, key `BU_ID`),
joined by `AP_INVOICES_ALL.ORG_ID`; loaded into the `Payables` row (rules 8).

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
  unless told otherwise (`psql -v schemas='work,v2026_11'`): ownership is a write, and a build must
  not reach into a schema it did not produce.
- **`fusion_dev.v<ver>` is a release: immutable after `p7_own.sql`, byte-equal to what `p9` moved
  into `fusion`. Only `work` is scratch.** Any content change is a NEW label through the full
  chain; no step is ever re-run against an existing release (`p5_ddl.sh` starts with
  `DROP SCHEMA IF EXISTS v<ver>`, so a re-run of a label is a rebuild, not an edit — and a label
  that `fusion` serves is never rebuilt). Labels are `v<YYYY_MM>` (`provider.ts` rejects anything
  else), the next free one. The one table the serving container writes into the active version
  schema at runtime is `col_vec` (the column-embedding cache, `schemas.ts` role `version`); it
  grows in `fusion` and is the only tolerated drift.
- `meta.seeds.ddl_version` / `embedding_model` are never typed: `p5_fill` stamps them into
  `catalog_meta` from `work.build_meta` (which `p5_ddl.sh` took from the `ddl.sql` header), and
  `p9` copies the stamps of the restored schema.

## What the build does NOT create

`meta.seeds`, `meta.active_version`, `meta.library_migrations` and the whole `customer` schema are
DATABASE-level, not version-level: `scripts/pg-import/import.mts` writes the first two on a first
import, `p9_release.sh` on every release move, and `src/db/postgres/migrations.ts` the last. A
serving database needs them in addition to the version schema.

`work.embeddings` and `work.layout_pattern` exist only after `p4` runs — a fresh `work` has no
vectors until `p4_vectors.sql` + `p4_run.sh` are run. The 2026-09-20 build ran them: 23,471 owners
→ 93,950 unit vectors, plus 46 layout owners → 224, in 26m56s over 12 shards. Since 2026-09-21
`p4_embed.mts` is incremental by `text_hash` (the 46 layout owners are still re-embedded on every
run by shard 0 — 224 vectors, seconds — and `work.layout_pattern` re-staged with them).
