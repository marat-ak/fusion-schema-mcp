-- ============================================================================
-- P1 — the two levels that exist in `work`.
--
--   L2  work.sql_unit   the dirty SQL as it was extracted from a source object.
--                       116,006 rows, one per extraction. Identity = unit_id.
--   L3  work.clear_sql  the DEDUPED SQL. Identity = sql_hash = sha256(norm_sql()).
--                       26,204 rows. EVERYTHING downstream keys on this.
--
-- INPUT DISCIPLINE (this build): of raw.sql_units only unit_id, source, title and
-- original_sql are read. That table also carries generation-1 text (description,
-- intents, mechanics, clean_sql, description_v2, semantics_json, reports) and the
-- OLD parser's output (tables_used_old, joins_old, filters_old,
-- security_predicate_old, sql_for_parse, parse_quality, parse_error); none of it
-- is read. parse_quality in particular is now a PARSE output written by p3 from a
-- fresh pinned sqlglot run, never carried from the inventory.
--
-- Dedup is on `original_sql`, NEVER on `clean_sql`: 85,741 otbi units carry
-- 11,291 distinct source statements but 43,476 distinct v1 LLM rewrites, and the
-- rewrite is an enrichment OUTPUT that belongs ON the L3 row, not IN its key.
--
-- L1 (the source object: view / otbi item / BIP datamodel) is deliberately OMITTED
-- this pass — L2 already carries its title, and no serving path needs it yet.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- metadata: straight copy of raw, unfiltered (all five TABLE_TYPEs retained).
-- The TABLE/VIEW filter is a RELEASE decision and lives in p5, not here.
-- The parse (p3) needs the UNFILTERED column dictionary or qualify() silently
-- drops every column it cannot bind.
-- ---------------------------------------------------------------------------
CREATE TABLE work.meta_tables  AS SELECT * FROM raw.meta_tables;
CREATE TABLE work.meta_columns AS SELECT * FROM raw.meta_columns;
CREATE TABLE work.meta_pkeys   AS SELECT * FROM raw.meta_pkeys;
CREATE TABLE work.meta_fkeys   AS SELECT * FROM raw.meta_fkeys;
CREATE TABLE work.meta_indexes AS SELECT * FROM raw.meta_indexes;
CREATE INDEX ix_work_meta_tables_name  ON work.meta_tables  (table_name);
CREATE INDEX ix_work_meta_columns_tbl  ON work.meta_columns (table_name);
CREATE INDEX ix_work_meta_pkeys_tbl    ON work.meta_pkeys   (table_name);
CREATE INDEX ix_work_meta_indexes_tbl  ON work.meta_indexes (table_name);

-- ---------------------------------------------------------------------------
-- L2 — one row per extracted SQL unit.
--
-- `original_sql` carries the view-text cleanup (nn() + dec_xml()); MEASURED to be
-- a no-op on all 6,078 raw view rows (they were loaded from the already-compiled
-- schema.sqlite view_text), so this copy is byte-exact either way. It stays
-- because it is what makes the invariant TRUE rather than accidental.
-- ---------------------------------------------------------------------------
CREATE TABLE work.sql_unit (
  unit_id       text PRIMARY KEY,
  source        text NOT NULL,
  title         text,
  original_sql  text NOT NULL,
  sql_hash      text NOT NULL
);

INSERT INTO work.sql_unit (unit_id, source, title, original_sql, sql_hash)
SELECT u.unit_id,
       u.source,
       u.title,
       cl.txt,
       work.sql_hash(cl.txt)
FROM   raw.sql_units u
CROSS  JOIN LATERAL (SELECT CASE WHEN u.source = 'view'
                                 THEN work.clean_view_text(u.original_sql)
                                 ELSE u.original_sql END AS txt) cl
WHERE  cl.txt IS NOT NULL;

CREATE INDEX ix_sql_unit_hash   ON work.sql_unit (sql_hash);
CREATE INDEX ix_sql_unit_source ON work.sql_unit (source);

-- ---------------------------------------------------------------------------
-- L3 — the deduped statement. PK = sql_hash.
--
-- The primary unit (the one whose title and SQL text represent the group) is
-- picked deterministically: source rank, then title, then unit_id. The three
-- source groups are DISJOINT by hash (verified below), so the rank only ever
-- decides between bip-report and catalog — two extractions of the same BIP
-- datamodel SQL, where the poller's forward-slash path is the better title.
--
-- `source` is the SERVING label and must stay inside the corpus vocabulary the
-- ranking code knows (usageGraph SOURCE_WEIGHT: bip-report | view | otbi), so
-- catalog-derived rows are labelled bip-report — they ARE BIP datamodel SQL,
-- harvested from the catalog archive instead of the poller.
--
-- `l2_titles` replaces the old `reports` column. The .xdm path references live in
-- raw.unit_refs, which is NOT one of this build's allowed inputs; the titles of
-- the contributing L2 units are, and they carry the same "which objects use this
-- statement" signal. See the README: rebuilding report_queries.reports needs a
-- decision about unit_refs, it is not silently filled from a title.
--
-- Every enrichment column below is filled by p2 from the Qwen JSONL, and is NULL
-- until then. Nothing here comes from raw.enrichment or from v2026_09.
-- ---------------------------------------------------------------------------
CREATE TABLE work.clear_sql (
  sql_hash        text PRIMARY KEY,
  sql_text        text NOT NULL,
  source          text NOT NULL,
  title           text,
  primary_unit_id text NOT NULL,
  n_units         integer NOT NULL,
  l2_sources      text NOT NULL,      -- JSON array of the raw sources behind this hash
  l2_titles       jsonb NOT NULL,     -- every contributing L2 unit's title
  -- ---- parse outputs (p3) ----
  parse_quality   text,
  excluded_reason text,
  -- ---- Qwen generation-2 enrichment (p2) — scalars ----
  description     text,
  title_human     text,
  domain          text,
  output_grain    text,
  view_advice     text,
  rewritten_sql   text,
  tables_confirmed boolean,
  -- ---- Qwen generation-2 enrichment (p2) — structured ----
  intents         jsonb,
  tags            jsonb,
  security        jsonb,
  params          jsonb,
  language        jsonb,
  grain_handling  jsonb,
  date_logic      jsonb,
  flexfield       jsonb,
  plsql_functions jsonb,
  computed_columns jsonb,
  current_row     jsonb,
  quality_flags   jsonb,
  missing_remarks jsonb,
  flex_missed     jsonb,
  extra_tables    jsonb,
  missing_tables  jsonb,
  -- ---- provenance of the enrichment ----
  src_enrich_unit  text,     -- which L2 unit's Qwen record won this row
  src_enrich_file  text,     -- which primary JSONL it came from
  src_enrich_ghash text,     -- the grounding hash the model was given (otbi only)
  n_enrich_units   integer,  -- how many Qwen records landed on this hash
  enrich_ok        boolean,  -- false = the model failed on this unit, payload is NULL
  enrich_error     text
);

INSERT INTO work.clear_sql (sql_hash, sql_text, source, title, primary_unit_id,
                            n_units, l2_sources, l2_titles)
SELECT g.sql_hash,
       p.original_sql,
       CASE WHEN p.source IN ('bip-report', 'catalog') THEN 'bip-report' ELSE p.source END,
       p.title,
       p.unit_id,
       g.n_units,
       g.l2_sources,
       g.l2_titles
FROM (
  SELECT u.sql_hash,
         count(*)                                                       AS n_units,
         to_jsonb(array_agg(DISTINCT u.source ORDER BY u.source))::text AS l2_sources,
         coalesce(to_jsonb(array_remove(array_agg(DISTINCT u.title), NULL)), '[]'::jsonb) AS l2_titles
  FROM   work.sql_unit u
  GROUP  BY u.sql_hash) g
JOIN LATERAL (
  SELECT u.unit_id, u.source, u.title, u.original_sql
  FROM   work.sql_unit u
  WHERE  u.sql_hash = g.sql_hash
  ORDER  BY CASE u.source WHEN 'view' THEN 0 WHEN 'otbi' THEN 1
                          WHEN 'bip-report' THEN 2 WHEN 'catalog' THEN 3 ELSE 9 END,
            u.title NULLS LAST, u.unit_id
  LIMIT  1) p ON true;

CREATE INDEX ix_clear_sql_source ON work.clear_sql (source);
CREATE INDEX ix_clear_sql_title  ON work.clear_sql (title text_pattern_ops);

-- ================= verify =================
\echo '--- L2 / L3 row counts (expect 116006 / 26204) ---'
SELECT 'raw.sql_units'   AS t, count(*) FROM raw.sql_units
UNION ALL SELECT 'work.sql_unit (L2)', count(*) FROM work.sql_unit
UNION ALL SELECT 'work.clear_sql (L3)', count(*) FROM work.clear_sql;

\echo '--- the view-text cleanup changed how many rows? (expect 0 — it is exact either way) ---'
SELECT count(*) AS view_rows_changed
FROM   raw.sql_units r JOIN work.sql_unit u ON u.unit_id = r.unit_id
WHERE  r.source = 'view' AND r.original_sql IS DISTINCT FROM u.original_sql;

\echo '--- L2 by source, with distinct hashes ---'
SELECT source, count(*) AS units, count(DISTINCT sql_hash) AS hashes
FROM   work.sql_unit GROUP BY 1 ORDER BY 1;

\echo '--- L3 decomposition (expect bip-only 756 / catalog-only 2524 / both 5633 / otbi 11291 / view 6000) ---'
WITH h AS (
  SELECT sql_hash,
         bool_or(source = 'bip-report') AS b,
         bool_or(source = 'catalog')    AS c,
         bool_or(source = 'otbi')       AS o,
         bool_or(source = 'view')       AS v
  FROM   work.sql_unit GROUP BY 1)
SELECT count(*) FILTER (WHERE b AND NOT c) AS bip_only,
       count(*) FILTER (WHERE c AND NOT b) AS catalog_only,
       count(*) FILTER (WHERE b AND c)     AS bip_and_catalog,
       count(*) FILTER (WHERE o)           AS otbi,
       count(*) FILTER (WHERE v)           AS view,
       count(*) FILTER (WHERE (b OR c)::int + o::int + v::int > 1) AS cross_group_overlap,
       count(*)                            AS total
FROM   h;

\echo '--- L3 by serving source ---'
SELECT source, count(*) AS hashes, sum(n_units) AS l2_units FROM work.clear_sql GROUP BY 1 ORDER BY 1;

\echo '--- titles that lose their own row to dedup (byTitle becomes unreachable for these) ---'
SELECT u.source,
       count(DISTINCT u.title) AS l2_titles,
       count(DISTINCT c.title) AS l3_titles,
       count(DISTINCT u.title) - count(DISTINCT c.title) AS titles_without_own_row
FROM   work.sql_unit u JOIN work.clear_sql c ON c.sql_hash = u.sql_hash
GROUP  BY 1 ORDER BY 1;
