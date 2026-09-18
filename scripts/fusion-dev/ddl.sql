-- ddl_version: 2
--
-- DEV-ONLY raw layer: schema `raw` in the `fusion_dev` database on `stack-db`.
-- This is the UNFILTERED landing zone for the four upstream artefacts (the unit inventory, the
-- staging enrichment store, the vendor metadata CSVs, the corpus vectors). Nothing here is served:
-- compile.ts's filtering / dedup / entity-decoding is deliberately NOT applied, every source row
-- and every source column survives.
--
-- The loader (load.mts) discovers the table list by scanning this file for `CREATE TABLE raw.<x>`,
-- so this file is the single source of the shape. Order matters: sql_units before its children.

-- ---------------------------------------------------------------- units (the merged inventory)
-- Rows come from BOTH unit sources, merged on unit_id, sqls.sqlite winning (ON CONFLICT DO NOTHING
-- on the second pass). `origin_file` records which artefact actually produced the row.
--
-- sql_key is the dedup key of scripts/gpu-enrich/dedup_units.py, verbatim: duplicate SQL paths
-- GROUP BY it instead of being deleted. For sqls.sqlite BIP/OTBI rows sql_for_parse is populated,
-- for enrich-store rows only original_sql is, so the same expression makes the two stores
-- directly comparable on SQL text.
CREATE TABLE raw.sql_units (
  unit_id                text PRIMARY KEY,
  source                 text NOT NULL,           -- view | otbi | bip-report | catalog
  name                   text,
  title                  text,
  original_sql           text,
  sql_for_parse          text,
  clean_sql              text,
  parse_quality          text,
  parse_error            text,
  description            text,
  description_generated  text,
  intents                text,
  mechanics              text,
  semantics_json         text,
  description_v2         text,
  needs_review           integer,
  excluded_reason        text,
  reports                text,                    -- raw JSON array; exploded into raw.unit_refs
  tables_used_old        text,
  joins_old              text,
  filters_old            text,
  security_predicate_old text,
  origin_file            text NOT NULL,           -- sqls.sqlite | enrich.sqlite
  imported_at            timestamptz NOT NULL DEFAULT now(),
  sql_key                text GENERATED ALWAYS AS (md5(coalesce(sql_for_parse, original_sql))) STORED
);
CREATE INDEX ix_raw_sql_units_sql_key ON raw.sql_units (sql_key);
CREATE INDEX ix_raw_sql_units_source  ON raw.sql_units (source);

-- ---------------------------------------------------------------- enrichment generations
-- generation 1 = the 1.1 GB staging store (fusion-schema-mcp/data/enrich.sqlite).
-- model / run_id / produced_at are NULL BY DESIGN: that store carries no per-row attribution and
-- a guess must never be written into the data. A later generation that does carry attribution
-- fills them.
CREATE TABLE raw.enrichment (
  unit_id             text    NOT NULL REFERENCES raw.sql_units (unit_id),
  generation          integer NOT NULL,
  model               text,
  run_id              text,
  produced_at         timestamptz,
  description         text,
  tables_used         jsonb,
  lookup_types        jsonb,
  joins               jsonb,
  filters             jsonb,
  security_predicate  text,                       -- plain SQL predicate text, not JSON
  approved            integer,
  source_hash         text,                       -- sha256(original_sql), verified on the source
  sql_key             text,                       -- same expression as raw.sql_units.sql_key
  PRIMARY KEY (unit_id, generation)
);
CREATE INDEX ix_raw_enrichment_sql_key ON raw.enrichment (sql_key);
CREATE INDEX ix_raw_enrichment_gen     ON raw.enrichment (generation);

-- ---------------------------------------------------------------- BIP datamodel provenance
-- Exploded from the `reports` JSON arrays. `idx` is the element's own `index` field (the dataset
-- index inside the datamodel), not the array position.
CREATE TABLE raw.unit_refs (
  unit_id text NOT NULL REFERENCES raw.sql_units (unit_id),
  path    text,
  title   text,
  idx     integer
);
CREATE INDEX ix_raw_unit_refs_unit ON raw.unit_refs (unit_id);
CREATE INDEX ix_raw_unit_refs_path ON raw.unit_refs (path);

-- ---------------------------------------------------------------- embeddings (computed ONCE, here)
-- The vendor corpus vectors, lifted verbatim out of the SQLite catalog (`reports.sqlite`) so that
-- they are stored durably in raw and ship inside the release dump: no customer ever re-embeds the
-- vendor corpus. Nothing is re-computed on load - every vector is the exact 384-float blob that
-- sqlite-vec holds, converted to pgvector.
--
-- Identity is (owner_kind, owner_id, slot):
--   owner_kind 'unit'   -> report_queries.id,    slot 0 = description + LF + 'Tables: ' + the
--                          comma-joined tables_used list (embedTexts(), src/corpus/ingestStore.ts)
--   owner_kind 'layout' -> layout_patterns.id,   slot 0 = `${name}. ${description}`
--   slot 1..n           -> the n-th intent phrase, in the order embedTexts()/loadLayoutPatterns()
--                          produced it. Slot order = vec0 rowid order within the owner, verified
--                          empirically by the loader (see load.mts, step 5).
--
-- text_hash = md5 of the EXACT string that was passed to embed(), so an incremental refresh
-- re-embeds only the slots whose text changed. It is NULL where that string is not derivable from
-- what the catalog stores: slot 0 of a unit has three writer call-sites that passed DIFFERENT
-- `tables` arguments (src/ingest.ts embeds `e.tablesUsed`, `[]`, or the stored list) and
-- updateEnrichment never wrote the fresh list back, so the loader VERIFIES each unit slot 0 by
-- re-embedding the reconstructed text and only stores the hash when the vector comes back
-- identical. A NULL hash is a row an incremental refresh must re-embed rather than trust.
CREATE TABLE raw.embeddings (
  owner_kind text        NOT NULL,          -- unit | layout
  owner_id   text        NOT NULL,          -- report_queries.id | layout_patterns.id
  slot       smallint    NOT NULL,          -- 0 = description slot, 1..n = intent slots
  text_hash  text,                          -- md5 of the embedded string; NULL = not derivable
  model      text        NOT NULL,          -- the embedding model, verbatim from embedWorker.ts
  embedding  vector(384) NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, slot)
);

-- ---------------------------------------------------------------- vendor metadata (CSV, as-is)
-- One column per CSV column, in file order, lowercased. text everywhere except columns proven
-- integral by a full scan of the file; FND_ID and DECIMAL_DIGITS stay text because they carry the
-- literal string 'null'. The string 'null' is NOT translated to SQL NULL anywhere - raw means raw.
CREATE TABLE raw.meta_tables (
  table_schem            text,
  table_name             text,
  table_type             text,   -- TABLE | VIEW: the only place the view/table split is recorded
  remarks                text,
  real_table_schem       text,
  real_table_name        text,
  fnd_id                 text,
  view_text              text,
  application_short_name text,
  object_id              bigint,
  columns_loaded         text,
  real_object_type       text
);
CREATE INDEX ix_raw_meta_tables_name ON raw.meta_tables (table_name);

CREATE TABLE raw.meta_columns (
  table_schem       text,
  table_name        text,
  column_name       text,
  data_type         text,
  type_name         text,
  column_size       bigint,
  decimal_digits    text,
  nullable          text,
  remarks           text,
  char_octet_length bigint,
  ordinal_position  integer
);
CREATE INDEX ix_raw_meta_columns_table ON raw.meta_columns (table_name);

CREATE TABLE raw.meta_pkeys (
  pkey_sequence        integer,
  column_id            bigint,
  pkey_name            text,
  pkey_id              bigint,
  table_id             bigint,
  column_name          text,
  physical_column_name text,
  user_column_name     text,
  physical_table_name  text,
  table_name           text
);
CREATE INDEX ix_raw_meta_pkeys_table ON raw.meta_pkeys (table_name);

-- "table" is a reserved word; the CSV column is named TABLE, so it is kept quoted rather than
-- renamed - this layer does not rename vendor columns.
CREATE TABLE raw.meta_fkeys (
  tablename          text,
  "table"            text,
  foreign_table      text,
  foreign_key_column text,
  seq                integer,
  name               text,
  namefull           text
);
CREATE INDEX ix_raw_meta_fkeys_table   ON raw.meta_fkeys ("table");
CREATE INDEX ix_raw_meta_fkeys_foreign ON raw.meta_fkeys (foreign_table);

CREATE TABLE raw.meta_indexes (
  table_schem      text,
  table_name       text,
  non_unique       text,
  index_qualifier  text,
  index_name       text,
  type             integer,
  ordinal_position integer,
  column_name      text,
  asc_or_desc      text,
  cardinality      bigint,
  object_id        bigint
);
CREATE INDEX ix_raw_meta_indexes_table ON raw.meta_indexes (table_name);
