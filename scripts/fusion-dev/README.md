# `fusion_dev` raw loader — DEV BOX ONLY

Loads the upstream artefacts into schema **`raw`** of the **`fusion_dev`** database on `stack-db`,
unfiltered. This is a scratch/analysis layer: **it never ships**, no serving code reads it, and the
directory is excluded from the image build context (`.dockerignore`).

It deliberately does **not** apply `src/compile.ts`'s filtering, dedup or entity-decoding — every
source row and every source column survives, so the raw layer can be compared against what the
serving corpus kept.

## What it loads

| Target | Source |
|---|---|
| `raw.sql_units` | `sqls.sqlite` `sql_units` (the `x_*` regex fact tables are **not** loaded), merged with the unit identity of the staging enrich store (`ON CONFLICT DO NOTHING`, `sqls.sqlite` wins, `origin_file` records which) |
| `raw.enrichment` | `data/enrich.sqlite` `enrich` as **generation 1**. `model` / `run_id` / `produced_at` are NULL: that store carries no per-row attribution and none is invented |
| `raw.unit_refs` | the `reports` JSON arrays — which live in **`sqls.sqlite`**, not in the staging store (its `enrich` table is 13 columns wide and has no `reports` column) |
| `raw.meta_tables` / `meta_columns` / `meta_pkeys` / `meta_fkeys` / `meta_indexes` | `data/META_*.csv`, straight through `COPY … FORMAT csv`, one column per CSV column |

`raw.sql_units.sql_key` is a stored generated column, `md5(coalesce(sql_for_parse, original_sql))` —
the dedup key of `scripts/gpu-enrich/dedup_units.py`. Duplicate SQL paths group by it instead of
being deleted, and because the enrich-store rows populate only `original_sql`, the same expression
makes the two stores directly comparable on SQL text.

Not loaded by this script: the Qwen `/root/enrich-run/*.jsonl`, the serving corpus `reports.sqlite`,
embeddings, curated JSON, relationships JSON, `generated_table_cards`, `view_waves`, and
`/opt/fusion-catalog-v2/enrich.sqlite` (the 50 MB runtime store — the 1.1 GB one in `data/` is the
one this loads).

## Running it

Every input is an explicit argument — there are no defaults and no env fallbacks. Build/run only
inside the `CloudBeaver` WSL distro.

`data/enrich.sqlite` is WAL-mode and will not open read-only, so **copy it out first**, load from
the copy, and delete the copy afterwards — never open the repo file read-write, and never leave a
`-shm`/`-wal` beside it:

```bash
wsl -d CloudBeaver -u root -e bash -lc '
REPO=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp
mkdir -p /opt/rawload && cp "$REPO/data/enrich.sqlite" /opt/rawload/staging-enrich.sqlite

PW=$(grep -E "^FUSION_DEV_DB_PASSWORD=" /mnt/c/Marat/OSaaS/ClaudeShared/oservices/devops/.env | cut -d= -f2-)

docker run --rm --network oservices_default \
  -v /opt/fusion-catalog-v2:/v2:ro \
  -v /opt/rawload:/rawload \
  -v "$REPO/scripts/fusion-dev":/app/scripts/fusion-dev:ro \
  -v "$REPO/data":/csv:ro \
  --entrypoint node gnimsys/fusion-schema-mcp:latest \
  node_modules/.bin/tsx scripts/fusion-dev/load.mts \
    --sqls-sqlite      /v2/sqls.sqlite \
    --enrich-sqlite    /rawload/staging-enrich.sqlite \
    --meta-tables-csv  /csv/META_TABLES.csv \
    --meta-columns-csv /csv/META_COLUMNS.csv \
    --meta-pkeys-csv   /csv/META_PKEYS.csv \
    --meta-fkeys-csv   /csv/META_FKEYS.csv \
    --meta-indexes-csv /csv/META_INDEXES.csv \
    --database-url     "postgresql://fusion_dev:$PW@stack-db:5432/fusion_dev"

rm -rf /opt/rawload   # the 1.1 GB copy does not stay on the box
'
```

From outside the compose network use the published loopback instead:
`postgresql://fusion_dev:$PW@127.0.0.1:5432/fusion_dev` with `--network host`. The password is read
from that one variable in `devops/.env` and is never printed or logged.

`/opt/fusion-catalog-v2` and `/opt/fusion-catalog-test` are mounted read-only / not at all: the
loader never writes to either.

## Idempotency

The loader refuses to run when schema `raw` already has tables. Pass `--replace` to drop the tables
this `ddl.sql` defines (tables it does not own are listed and left alone) and re-load.

`ddl.sql` is the single source of the shape — the loader discovers its table list by scanning it.
