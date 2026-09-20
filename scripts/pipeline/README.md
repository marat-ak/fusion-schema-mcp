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
| `model_added` | 747 | 342 | parse missed it, evidence backed the model |

157,621 parse rows + 747 additions = 158,368; **0 dropped**. `model_verdict` carries
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

Every claim carries its evidence (`in_parse`, `in_dictionary`, `in_sql_text`,
`after_from_or_join`) and a `verdict`, so the decision is auditable rather than asserted.

**Open, measured, not applied**: 20 of the 31 schema-qualified rejects (7 distinct names,
`FUSION.SVC_SERVICE_REQUESTS`, `FUSION.PER_BIPNTF_FLEX`, …) would resolve if a leading `FUSION.`
were stripped. Normalising a schema prefix is a rule change, not a reconciliation detail.

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
| `p3_rel.sql`     | `work.relationships` derived from `f_joins` + `meta_fkeys` | 6 s |
| `p4_vectors.sql` | the `work.embeddings` table | 1 s |
| `p4_run.sh`      | full deterministic re-embed, sharded (`p4_embed.mts` per shard) | ~20 min |
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

### p4–p6 are STALE against the current `work` shape

`p0`–`p3` and `p7`–`p8` are current. `p5_fill.sql` still reads the merged-enrichment columns that
`p2_merge.sql` used to write (`tables_used`, `joins`, `filters`, `lookup_types`,
`security_predicate`, `semantics_json`, `low_confidence`) and will fail against the columns
`p2_promote.sql` writes instead. It also reads `work.f_tables` directly, which is now the wrong
source — the registries must be built from **`work.r_tables`** — and `clear_sql.reports` is
`[{path,index}]` now, not the old mixed shape. The 2026-09-20 pass rebuilt `work` only, by
instruction, and did not run or rewrite the release steps. **Do not run `p5`/`p6` before reworking
`p5_fill.sql`** onto the promoted columns and `r_tables` — and decide there what
`report_queries.tables_used/.joins/.filters` should be served from now that the merged enrichment is
gone and only parse facts remain.

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

`work.embeddings` and `work.layout_pattern` exist only after `p4` runs. The 2026-09-20 pass skipped
embedding deliberately — the enrichment text is not settled, and a re-embed is ~25 minutes — so a
fresh `work` has no vectors until `p4_vectors.sql` + `p4_run.sh` are run.
