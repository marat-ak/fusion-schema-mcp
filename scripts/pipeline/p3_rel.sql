-- ============================================================================
-- P3d — relationships, DERIVED. Two tiers, both from allowed inputs:
--
--   mined     work.f_joins            the equi-joins this build's own parse found
--   declared  work.meta_fkeys         the vendor's foreign keys
--
-- The previous build CARRIED this table out of v2026_09 (which had it from
-- mined_relationships.json plus an OTBI-crawl join graph). Carrying made the
-- release an input to its own rebuild and pinned a number nobody could recompute.
--
-- The mined tier is scripts/step5_relations.mjs' algorithm, moved onto the facts:
--   * the pair is canonicalised (A-B == B-A) so one edge is one row
--   * XMLTABLE / DUAL / SAWITHn aliases and anything not in meta_tables are dropped
--   * statements excluded as dynamic_lexical do not vote (p3_post sets that flag,
--     so this file runs AFTER it)
--   * occurrences counts DISTINCT L3 STATEMENTS — the fact grain. n_units counts the
--     L2 extractions behind them, which is the old L2-grain number, kept alongside
--     rather than silently substituted.
--   * confidence: >=3 statements HIGH, 2 MEDIUM, 1 LOW
--
-- WHAT IS NOT HERE: the 9,117-row `otbi` tier of v2026_09. It came from the OTBI
-- crawl `relations` block, which this build excludes. Its absence is deliberate and
-- visible, not a silent loss — see the README.
-- ============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS work.relationships CASCADE;
CREATE TABLE work.relationships (
  from_table       text NOT NULL,
  from_col         text,
  to_table         text NOT NULL,
  to_col           text,
  evidence         text,            -- join | fk
  occurrences      integer,         -- distinct L3 statements (mined tier)
  confidence       text,            -- HIGH | MEDIUM | LOW | DECLARED
  predicate        text,
  source           text NOT NULL,   -- mined | declared
  n_units          integer,         -- distinct L2 units behind the statements
  n_view           integer,
  n_otbi           integer,
  n_bip            integer,
  outer_share      real,
  matches_declared integer
);

-- ---- declared FK pairs, canonicalised, for matches_declared -----------------
DROP TABLE IF EXISTS pg_temp.fk_pair;
CREATE TEMP TABLE fk_pair AS
SELECT DISTINCT
       least(upper(f."table"), upper(f.foreign_table))    AS t1,
       greatest(upper(f."table"), upper(f.foreign_table)) AS t2,
       upper(f.foreign_key_column)                        AS c
FROM   work.meta_fkeys f
WHERE  f."table" IS NOT NULL AND f.foreign_table IS NOT NULL
  AND  f.foreign_key_column IS NOT NULL;
CREATE INDEX ON fk_pair (t1, t2, c);

-- ---- the mined tier ---------------------------------------------------------
DROP TABLE IF EXISTS pg_temp.j_canon;
CREATE TEMP TABLE j_canon AS
WITH real_t AS (SELECT DISTINCT upper(table_name) AS t FROM work.meta_tables WHERE table_name IS NOT NULL),
     j AS (
       SELECT jj.sql_hash,
              upper(jj.from_t) AS ft, upper(jj.from_c) AS fc,
              upper(jj.to_t)   AS tt, upper(jj.to_c)   AS tc,
              jj.join_type
       FROM   work.f_joins jj
       JOIN   work.clear_sql c ON c.sql_hash = jj.sql_hash AND c.excluded_reason IS NULL
       WHERE  jj.from_t IS NOT NULL AND jj.to_t IS NOT NULL
         AND  upper(jj.from_t) !~ '^(XMLTABLE|DUAL|SAWITH[0-9]+)$'
         AND  upper(jj.to_t)   !~ '^(XMLTABLE|DUAL|SAWITH[0-9]+)$')
SELECT j.sql_hash,
       CASE WHEN (j.ft, coalesce(j.fc,'')) <= (j.tt, coalesce(j.tc,'')) THEN j.ft ELSE j.tt END AS t1,
       CASE WHEN (j.ft, coalesce(j.fc,'')) <= (j.tt, coalesce(j.tc,'')) THEN j.fc ELSE j.tc END AS c1,
       CASE WHEN (j.ft, coalesce(j.fc,'')) <= (j.tt, coalesce(j.tc,'')) THEN j.tt ELSE j.ft END AS t2,
       CASE WHEN (j.ft, coalesce(j.fc,'')) <= (j.tt, coalesce(j.tc,'')) THEN j.tc ELSE j.fc END AS c2,
       (j.join_type ~* '(LEFT|RIGHT|FULL|OUTER)') AS is_outer
FROM   j
WHERE  j.ft IN (SELECT t FROM real_t) AND j.tt IN (SELECT t FROM real_t);

CREATE INDEX ON j_canon (sql_hash);

INSERT INTO work.relationships
  (from_table, from_col, to_table, to_col, evidence, occurrences, confidence,
   predicate, source, n_units, n_view, n_otbi, n_bip, outer_share, matches_declared)
SELECT a.t1, a.c1, a.t2, a.c2, 'join',
       a.occurrences,
       CASE WHEN a.occurrences >= 3 THEN 'HIGH' WHEN a.occurrences = 2 THEN 'MEDIUM' ELSE 'LOW' END,
       NULL, 'mined',
       a.n_units, a.n_view, a.n_otbi, a.n_bip,
       a.outer_share,
       CASE WHEN EXISTS (SELECT 1 FROM fk_pair f
                         WHERE f.t1 = a.t1 AND f.t2 = a.t2
                           AND f.c IN (a.c1, a.c2)) THEN 1 ELSE 0 END
FROM (
  SELECT g.t1, g.c1, g.t2, g.c2,
         count(DISTINCT g.sql_hash)                                   AS occurrences,
         (SELECT count(DISTINCT u.unit_id) FROM work.sql_unit u
          WHERE u.sql_hash = ANY (array_agg(DISTINCT g.sql_hash)))    AS n_units,
         count(DISTINCT g.sql_hash) FILTER (WHERE c.source = 'view')       AS n_view,
         count(DISTINCT g.sql_hash) FILTER (WHERE c.source = 'otbi')       AS n_otbi,
         count(DISTINCT g.sql_hash) FILTER (WHERE c.source = 'bip-report') AS n_bip,
         (count(*) FILTER (WHERE g.is_outer))::real / count(*)        AS outer_share
  FROM   j_canon g JOIN work.clear_sql c ON c.sql_hash = g.sql_hash
  GROUP  BY 1, 2, 3, 4) a;

-- ---- the declared tier ------------------------------------------------------
INSERT INTO work.relationships
  (from_table, from_col, to_table, to_col, evidence, occurrences, confidence,
   predicate, source, matches_declared)
SELECT DISTINCT upper(f."table"), upper(f.foreign_key_column),
       upper(f.foreign_table), upper(f.foreign_key_column),
       'fk', NULL::integer, 'DECLARED', NULL::text, 'declared', 1
FROM   work.meta_fkeys f
WHERE  f."table" IS NOT NULL AND f.foreign_table IS NOT NULL
  AND  f.foreign_key_column IS NOT NULL;

CREATE INDEX ix_rel_from ON work.relationships (from_table);
CREATE INDEX ix_rel_to   ON work.relationships (to_table);
ANALYZE work.relationships;

-- ================= verify =================
\echo '--- relationships by tier ---'
SELECT source, count(*) AS edges,
       count(*) FILTER (WHERE confidence = 'HIGH')   AS high,
       count(*) FILTER (WHERE confidence = 'MEDIUM') AS medium,
       count(*) FILTER (WHERE confidence = 'LOW')    AS low,
       sum(matches_declared)                         AS matches_declared_fk
FROM   work.relationships GROUP BY 1 ORDER BY 1;

\echo '--- top mined edges ---'
SELECT from_table, from_col, to_table, to_col, occurrences, n_units,
       n_view, n_otbi, n_bip, round(outer_share::numeric, 2) AS outer_share, confidence
FROM   work.relationships WHERE source = 'mined'
ORDER  BY occurrences DESC LIMIT 10;
