# Catalog release pipeline

Builds the `work` schema and the `v<ver>` release schema in `fusion_dev` on `stack-db`.

Spec: `docs/superpowers/specs/2026-09-19-catalog-release-pipeline.md` (parent repo).

## The model — three levels

```
L1  source object (view / OTBI item / BIP datamodel)   -- not materialised yet
L2  work.sql_unit    the dirty SQL as extracted from a source object    116,006 rows
L3  work.clear_sql   the DEDUPED statement, id = content hash            26,204 rows
```

`sql_hash = sha256(work.norm_sql(original_sql))`. Every fact, every enrichment field, every
vector and every corpus row keys on it, and `report_queries.id` is `sql:<sql_hash>` — the same
identity `src/ingest.ts:108` mints for runtime-staged SQL.

**Dedup is on `original_sql`, NEVER on `clean_sql`.** 85,741 OTBI units carry 11,291 distinct
statements but 43,476 distinct v1 rewrites; the rewrite is an enrichment OUTPUT that lands on
the L3 row after dedup, not part of its key.

## Run order

| file | step | ~time |
|---|---|---|
| `p0_fn.sql`      | drop/create `work`; the function library (`norm_sql`, `sql_hash`, `dec_xml`, `nn`) | 1 s |
| `p1_l2_l3.sql`   | `meta_*` copies, L2 `sql_unit`, L3 `clear_sql`, `unit_ref` | 6.5 min |
| `p2_merge.sql`   | merge both enrichment generations onto the L3 row, field by field | 15 s |
| `p3_facts.sql`   | the `work.f_*` fact tables (DDL) + carry `relationships` | 2 s |
| `p3_parse.sh`    | the REAL pinned sqlglot parse (`p3_parse.py`) over all 26,204 statements | ~2 min |
| `p3_post.sql`    | fact indexes, exclusions from real `parse_quality`, divergence report | 6 s |
| `p4_vectors.sql` | the `work.embeddings` table | 1 s |
| `p4_run.sh`      | full deterministic re-embed, sharded (`p4_embed.mts` per shard) | ~20 min |
| `p5_ddl.sh`      | create `v<ver>` from the PRODUCT's `scripts/pg-import/ddl.sql` | 2 s |
| `p5_fill.sql`    | populate all 25 release tables from `work` | ~3 min |
| `p5_index.sql`   | pgvector index on every embedding column | see below |
| `p6_verify.sql`  | the gate: counts, content equality, dangling, stamps | 2 min |
| `p6_knn.mts`     | exact-KNN spot check through the serving statement | 30 s |

```bash
wsl -d CloudBeaver -u root -e bash -lc \
  'docker cp <file>.sql stack-db:/tmp/ && docker exec stack-db psql -U postgres -d fusion_dev -v ON_ERROR_STOP=1 -f /tmp/<file>.sql'
```

The `.sh` / `.mts` steps run themselves:

```bash
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p3_parse.sh'
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p4_run.sh 12'
wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_ddl.sh v2026_10'
```

Heredocs and inline SQL through the WSL bridge mangle quoting — always `docker cp` a file.

## Invariants

- Writes ONLY to `work` and `v<ver>`. `raw` and `v2026_09` are read-only inputs.
- The release DDL is never restated here: `p5_ddl.sh` derives it from
  `scripts/pg-import/ddl.sql` (the file `src/db/postgres/schemas.ts` and `PgMeta.verify()`
  are written against), substituting both `{{S}}` and `{{V}}` with the version schema.
- **Nothing is left for a server boot to build.** `p5_fill.sql` writes every version stamp
  (`grain_meta` 4, `usage_meta` 1, `pred_meta` 1, `layout_meta.jsonl_hash`, `facts_meta` 1),
  because a missing stamp makes the serving container rebuild — and a rebuild over a partial
  input silently replaces a good registry.
- The four registries (`table_grain`, `table_usages`, `table_predicates`, `table_join_columns`)
  are COMPUTED from the PARSE FACTS in `work.f_*`, never copied from `v2026_09` and never read
  back out of the enrichment (which only ever covered otbi).
- **The parser version is PINNED** in `scripts/sqlglot_extract.py` (`SQLGLOT_PIN`), asserted at
  import, and stamped into `v<ver>.facts_meta.parser_version`. The same SQL yields different
  facts across sqlglot releases, so an unpinned parser makes the stamp meaningless. Bumping the
  pin invalidates every `f_*` row and all four registries — rebuild them together.
- The parse needs `work.meta_columns` as its dictionary. Without it `qualify()` cannot bind an
  unqualified column to a table and those references are **silently dropped**, so the parse looks
  successful while producing thin facts.
- `report_queries.tables_used`, `.joins` and `.filters` keep the MERGED ENRICHMENT values, not
  the parse facts. Changing what the agent is served is a product decision; `p3_post.sql` prints
  the divergence so it can be made on numbers.
- The embedder is the product's own (`src/corpus/embed.ts` + `embedTexts()` from
  `src/corpus/ingestStore.ts`), imported, never reimplemented, and run inside
  `schema-mcp-build:latest` where the bge-small cache lives.
- Scripts run as `postgres`, so the last act of a build is
  `REASSIGN OWNED` / `ALTER ... OWNER TO fusion_dev` (`p7_own.sql`).

## What the build does NOT create

`meta.seeds`, `meta.active_version`, `meta.library_migrations` and the whole `customer` schema
are DATABASE-level, not version-level: `scripts/pg-import/import.mts` writes the first two and
`src/db/postgres/migrations.ts` the last. A serving database needs them in addition to the
version schema this pipeline produces.
