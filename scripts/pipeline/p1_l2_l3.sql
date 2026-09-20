-- ============================================================================
-- P1 — the two levels that exist in `work`.
--
--   L2  work.sql_unit   the dirty SQL as it was extracted from a source object.
--                       116,006 rows, one per extraction. Identity = unit_id.
--   L3  work.clear_sql  the DEDUPED SQL. Identity = sql_hash = sha256(norm_sql()).
--                       26,204 rows. EVERYTHING downstream keys on this.
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
--
-- Dropped from raw.sql_units:
--   sql_for_parse  — NULL or byte-identical to original_sql on all 116,006 (verified below)
--   clean_sql      — an enrichment OUTPUT; it lands on the L3 row after dedup
-- Kept beyond the four identity columns: parse_quality, because the exclusion
-- rule (p3) is a PARSE output, never an inventory regex.
-- ---------------------------------------------------------------------------
CREATE TABLE work.sql_unit (
  unit_id       text PRIMARY KEY,
  source        text NOT NULL,
  title         text,
  original_sql  text NOT NULL,
  parse_quality text,
  sql_hash      text NOT NULL
);

INSERT INTO work.sql_unit (unit_id, source, title, original_sql, parse_quality, sql_hash)
SELECT u.unit_id,
       u.source,
       u.title,
       cl.txt,
       nullif(btrim(coalesce(u.parse_quality, '')), ''),
       work.sql_hash(cl.txt)
FROM   raw.sql_units u
CROSS  JOIN LATERAL (SELECT CASE WHEN u.source = 'view'
                                 THEN work.clean_view_text(u.original_sql)
                                 ELSE u.original_sql END AS txt) cl
WHERE  cl.txt IS NOT NULL;

CREATE INDEX ix_sql_unit_hash   ON work.sql_unit (sql_hash);
CREATE INDEX ix_sql_unit_source ON work.sql_unit (source);

-- L2 -> report reference rows (paths are REFERENCES, never identity).
-- bip units carry their .xdm paths in raw.unit_refs; every other unit references
-- itself by its own title.
CREATE TABLE work.unit_ref (
  unit_id text NOT NULL,
  path    text NOT NULL,
  title   text,
  idx     integer,
  PRIMARY KEY (unit_id, path, idx)
);

INSERT INTO work.unit_ref (unit_id, path, title, idx)
SELECT r.unit_id, r.path, r.title, coalesce(r.idx, 0)
FROM   raw.unit_refs r
WHERE  r.path IS NOT NULL
  AND  EXISTS (SELECT 1 FROM work.sql_unit u WHERE u.unit_id = r.unit_id)
ON CONFLICT DO NOTHING;

INSERT INTO work.unit_ref (unit_id, path, title, idx)
SELECT u.unit_id, u.title, u.title, 0
FROM   work.sql_unit u
WHERE  u.title IS NOT NULL
  AND  NOT EXISTS (SELECT 1 FROM work.unit_ref r WHERE r.unit_id = u.unit_id)
ON CONFLICT DO NOTHING;

CREATE INDEX ix_unit_ref_unit ON work.unit_ref (unit_id);

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
-- ---------------------------------------------------------------------------
CREATE TABLE work.clear_sql (
  sql_hash        text PRIMARY KEY,
  sql_text        text NOT NULL,
  source          text NOT NULL,
  title           text,
  primary_unit_id text NOT NULL,
  n_units         integer NOT NULL,
  l2_sources      text NOT NULL,      -- JSON array of the raw sources behind this hash
  reports         jsonb NOT NULL,     -- [{path,title,index}] — every L2 reference
  parse_quality   text,
  excluded_reason text,
  -- ---- merged enrichment (filled by p2) ----
  description        text,
  intents            jsonb,
  mechanics          text,
  tables_used        jsonb,
  joins              jsonb,
  filters            jsonb,
  lookup_types       jsonb,
  security_predicate text,
  rewritten_sql      text,
  semantics_json     text,
  low_confidence     integer,
  approved           integer NOT NULL DEFAULT 1,
  -- ---- provenance: which L2 unit won each field ----
  src_description        text,
  src_intents            text,
  src_mechanics          text,
  src_tables_used        text,
  src_joins              text,
  src_filters            text,
  src_lookup_types       text,
  src_security_predicate text,
  src_rewritten_sql      text,
  gen_description        smallint,
  gen_tables_used        smallint,
  gen_joins              smallint
);

INSERT INTO work.clear_sql (sql_hash, sql_text, source, title, primary_unit_id,
                            n_units, l2_sources, reports, parse_quality)
SELECT g.sql_hash,
       p.original_sql,
       CASE WHEN p.source IN ('bip-report', 'catalog') THEN 'bip-report' ELSE p.source END,
       p.title,
       p.unit_id,
       g.n_units,
       g.l2_sources,
       coalesce(g.reports, '[]'::jsonb),
       g.parse_quality
FROM (
  SELECT u.sql_hash,
         count(*)                                    AS n_units,
         to_jsonb(array_agg(DISTINCT u.source ORDER BY u.source))::text AS l2_sources,
         -- parse quality of the GROUP: the worst outcome any unit of it produced
         -- ('full_lex' is what marks a statement unparseable by substitution).
         min(u.parse_quality) FILTER (WHERE u.parse_quality IS NOT NULL) AS parse_quality,
         (SELECT jsonb_agg(DISTINCT jsonb_build_object('path', r.path, 'title', r.title, 'index', r.idx))
          FROM   work.unit_ref r
          JOIN   work.sql_unit u2 ON u2.unit_id = r.unit_id
          WHERE  u2.sql_hash = u.sql_hash)           AS reports
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
\echo '--- L2 / L3 row counts ---'
SELECT 'raw.sql_units'   AS t, count(*) FROM raw.sql_units
UNION ALL SELECT 'work.sql_unit (L2)', count(*) FROM work.sql_unit
UNION ALL SELECT 'work.clear_sql (L3)', count(*) FROM work.clear_sql
UNION ALL SELECT 'work.unit_ref', count(*) FROM work.unit_ref;

\echo '--- sql_for_parse really is redundant (expect differs = 0) ---'
SELECT count(*) FILTER (WHERE sql_for_parse IS NULL)                        AS null_rows,
       count(*) FILTER (WHERE sql_for_parse = original_sql)                 AS identical,
       count(*) FILTER (WHERE sql_for_parse IS NOT NULL
                          AND sql_for_parse IS DISTINCT FROM original_sql)  AS differs
FROM   raw.sql_units;

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

\echo '--- every shipped v2026_09 id resolves to a live L3 row? ---'
SELECT r.source,
       count(*)                                  AS shipped,
       count(u.unit_id)                          AS maps_to_l2,
       count(c.sql_hash)                         AS maps_to_l3,
       count(*) FILTER (WHERE c.sql_hash IS NULL) AS unreachable
FROM   v2026_09.report_queries r
LEFT   JOIN work.sql_unit  u ON u.unit_id  = r.id
LEFT   JOIN work.clear_sql c ON c.sql_hash = u.sql_hash
GROUP  BY 1 ORDER BY 1;

\echo '--- shipped bip ids are byte-identical to sql:<hash> (expect 6389/6389) ---'
SELECT count(*) AS bip_shipped,
       count(*) FILTER (WHERE r.id = 'sql:' || u.sql_hash) AS id_preserved
FROM   v2026_09.report_queries r JOIN work.sql_unit u ON u.unit_id = r.id
WHERE  r.source = 'bip-report';

\echo '--- titles that lose their own row to dedup (byTitle becomes unreachable for these) ---'
SELECT u.source,
       count(DISTINCT u.title) AS l2_titles,
       count(DISTINCT c.title) AS l3_titles,
       count(DISTINCT u.title) - count(DISTINCT c.title) AS titles_without_own_row
FROM   work.sql_unit u JOIN work.clear_sql c ON c.sql_hash = u.sql_hash
GROUP  BY 1 ORDER BY 1;
