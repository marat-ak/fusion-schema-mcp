-- ============================================================================
-- P3 — per-statement FACTS, keyed on sql_hash.
--
--   work.f_tables      one row per (statement, table it reads)
--   work.f_joins       one row per (statement, join condition)
--   work.f_predicates  one row per (statement, hardcoded filter predicate)
--   work.relationships the mined + otbi relationship graph
--
-- f_tables / f_joins are extracted from the MERGED enrichment (p2), which is the
-- same oracle s3_parse.sql read — only re-keyed from a per-unit md5 to sql_hash.
-- f_predicates is new: it parses the `filters` the merge just recovered, which is
-- the per-SQL predicate source the registries need and which the product ships
-- empty today.
--
-- EXCLUSION IS A PARSE OUTPUT, NOT AN INVENTORY REGEX.
-- excluded_reason='dynamic_lexical' <=> some unit of the statement parsed
-- 'full_lex' (verified: 144 = 144). An `&[A-Za-z_]` regex over the inventory is
-- WRONG — it excluded 557 units of which 368 had shipped.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- exclusions
-- ---------------------------------------------------------------------------
UPDATE work.clear_sql c
SET    excluded_reason = 'dynamic_lexical'
WHERE  EXISTS (SELECT 1 FROM work.sql_unit u
               WHERE u.sql_hash = c.sql_hash AND u.parse_quality = 'full_lex');

-- ---------------------------------------------------------------------------
-- f_tables — from the merged tables_used
-- `is_cte` stays false throughout: the merged enrichment carries no CTE marking
-- (the round-0 x_tables flag lives only in the WSL working catalog). It exists so
-- the join-share denominator below reads the same as import_serving.mjs's.
-- ---------------------------------------------------------------------------
CREATE TABLE work.f_tables (
  sql_hash   text NOT NULL,
  table_name text NOT NULL,
  is_cte     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sql_hash, table_name)
);

INSERT INTO work.f_tables (sql_hash, table_name)
SELECT DISTINCT c.sql_hash, upper(btrim(t.val))
FROM   work.clear_sql c
CROSS  JOIN LATERAL jsonb_array_elements_text(c.tables_used) t(val)
WHERE  c.tables_used IS NOT NULL
  AND  jsonb_typeof(c.tables_used) = 'array'
  AND  btrim(t.val) <> ''
ON CONFLICT DO NOTHING;

CREATE INDEX ix_f_tables_table ON work.f_tables (table_name);

-- ---------------------------------------------------------------------------
-- f_joins — from the merged joins ('FROM_T.FROM_C=TO_T.TO_C[TYPE]')
-- ---------------------------------------------------------------------------
CREATE TABLE work.f_joins (
  sql_hash  text NOT NULL,
  from_t    text,
  from_c    text,
  to_t      text,
  to_c      text,
  join_type text
);

INSERT INTO work.f_joins (sql_hash, from_t, from_c, to_t, to_c, join_type)
SELECT DISTINCT c.sql_hash,
       upper(split_part(split_part(pair, '=', 1), '.', 1)),
       upper(split_part(split_part(pair, '=', 1), '.', 2)),
       upper(split_part(split_part(pair, '=', 2), '.', 1)),
       upper(split_part(split_part(pair, '=', 2), '.', 2)),
       jtype
FROM   work.clear_sql c
CROSS  JOIN LATERAL jsonb_array_elements_text(c.joins) s(val)
CROSS  JOIN LATERAL (SELECT regexp_replace(s.val, '\[.*\]$', '')      AS pair,
                            (regexp_match(s.val, '\[([^\]]+)\]$'))[1] AS jtype) x
WHERE  c.joins IS NOT NULL AND jsonb_typeof(c.joins) = 'array'
  AND  position('=' in pair) > 0;

CREATE INDEX ix_f_joins_hash ON work.f_joins (sql_hash);
CREATE INDEX ix_f_joins_from ON work.f_joins (from_t, from_c);
CREATE INDEX ix_f_joins_to   ON work.f_joins (to_t, to_c);

-- ---------------------------------------------------------------------------
-- f_predicates — parse the merged `filters`, predicateMiner.ts semantics:
--   PRED_RE      /^(T(\.T)*?)\.(C)\s*(=|<>|!=|IN|LIKE|BETWEEN)\s*(.+)$/i
--                (the `p` flag is Postgres's exact equivalent of JS's default:
--                 `.` does not cross a newline, `$` is end-of-string only)
--   table        = the LAST dotted segment of the LHS (schema prefix stripped)
--   isLiteral    RHS is a hardcoded literal, not a bind or a column
--   isInstanceKeyNoise  a 6+-digit literal on a *_ID column is one row id, not a rule
--   literal      = rhs.trim() truncated to 80 chars
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.is_literal(rhs text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN btrim(rhs) = ''                              THEN false
           WHEN btrim(rhs) ~ '^[:?@$]'                       THEN false
           WHEN btrim(rhs) ~ '^''.*'''                       THEN true
           WHEN btrim(rhs) ~ '^-?[0-9]'                      THEN true
           WHEN btrim(rhs) ~ '^\('                           THEN true
           WHEN btrim(rhs) ~* '^(SYSDATE|TRUNC|TO_DATE|TO_CHAR|DATE)([^A-Za-z0-9_]|$)' THEN true
           ELSE false
         END;
$fn$;

CREATE OR REPLACE FUNCTION work.is_instance_key_noise(col text, lit text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT col ~* '_ID$' AND regexp_replace(btrim(lit), '^''|''$', '', 'g') ~ '^[0-9]{6,}$';
$fn$;

CREATE TABLE work.f_predicates (
  sql_hash    text NOT NULL,
  table_name  text NOT NULL,
  column_name text NOT NULL,
  op          text NOT NULL,
  literal     text NOT NULL
);

INSERT INTO work.f_predicates (sql_hash, table_name, column_name, op, literal)
SELECT DISTINCT c.sql_hash,
       upper(split_part(m.m[1], '.', array_length(string_to_array(m.m[1], '.'), 1))) AS table_name,
       upper(m.m[3]) AS column_name,
       upper(m.m[4]) AS op,
       left(btrim(m.m[5]), 80) AS literal
FROM   work.clear_sql c
CROSS  JOIN LATERAL jsonb_array_elements_text(c.filters) f(val)
CROSS  JOIN LATERAL (SELECT regexp_match(btrim(f.val),
         '^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*?)\.([A-Za-z0-9_]+)[[:space:]]*(=|<>|!=|IN|LIKE|BETWEEN)[[:space:]]*(.+)$',
         'pi') AS m) m
WHERE  c.filters IS NOT NULL AND jsonb_typeof(c.filters) = 'array'
  AND  m.m IS NOT NULL
  AND  work.is_literal(m.m[5])
  AND  NOT work.is_instance_key_noise(m.m[3], m.m[5])
  -- only REAL objects: an unresolved alias cannot be attributed to a table
  AND  EXISTS (SELECT 1 FROM work.meta_tables t
               WHERE upper(t.table_type) IN ('TABLE','VIEW')
                 AND t.table_name = upper(split_part(m.m[1], '.', array_length(string_to_array(m.m[1], '.'), 1))));

CREATE INDEX ix_f_predicates_hash  ON work.f_predicates (sql_hash);
CREATE INDEX ix_f_predicates_table ON work.f_predicates (table_name);

-- ---------------------------------------------------------------------------
-- relationships — CARRIED, not recomputed.
--
-- The mined tier is aggregated by scripts/step5_relations.mjs from the round-0
-- `x_joins` facts, which live ONLY in the WSL working catalog
-- (/opt/fusion-catalog-v2/sqls.sqlite) and were never loaded into `raw`; the otbi
-- tier comes from the OTBI metadata join graph. Neither input is reachable from
-- this database, and re-deriving the mined tier from work.f_joins would change
-- `occurrences` (it counts DISTINCT UNITS, and the unit grain moved from L2 to
-- L3), so the graph is carried verbatim. This is the one release table whose
-- source is v2026_09 rather than `work`.
-- ---------------------------------------------------------------------------
CREATE TABLE work.relationships AS
SELECT from_table, from_col, to_table, to_col, evidence,
       occurrences, confidence, predicate, source
FROM   v2026_09.relationships;

-- ================= verify =================
\echo '--- exclusions: parse output, not inventory regex (expect 144) ---'
SELECT count(*) FILTER (WHERE excluded_reason = 'dynamic_lexical') AS excluded,
       count(*) FILTER (WHERE parse_quality   = 'full_lex')        AS full_lex
FROM   work.clear_sql;

\echo '--- what an &PARAM inventory regex WOULD have excluded (the wrong answer) ---'
SELECT count(*) AS regex_would_exclude,
       count(*) FILTER (WHERE excluded_reason IS NULL) AS of_which_not_really_excluded
FROM   work.clear_sql WHERE sql_text ~ '&[A-Za-z_][A-Za-z0-9_]*';

\echo '--- facts ---'
SELECT 'f_tables' AS t, count(*) AS rows, count(DISTINCT sql_hash) AS statements, count(DISTINCT table_name) AS tables FROM work.f_tables
UNION ALL SELECT 'f_joins', count(*), count(DISTINCT sql_hash), count(DISTINCT from_t) FROM work.f_joins
UNION ALL SELECT 'f_predicates', count(*), count(DISTINCT sql_hash), count(DISTINCT table_name) FROM work.f_predicates
UNION ALL SELECT 'relationships', count(*), NULL, NULL FROM work.relationships;

\echo '--- join type vocabulary (one canonical shape after the gen-1 conversion) ---'
SELECT join_type, count(*) FROM work.f_joins GROUP BY 1 ORDER BY 2 DESC;

\echo '--- predicate roles preview ---'
WITH percol AS (
  SELECT table_name, column_name, count(DISTINCT literal) d
  FROM work.f_predicates GROUP BY 1,2)
SELECT count(*) FILTER (WHERE d >= 8) AS discriminator_cols,
       count(*) FILTER (WHERE d <  8) AS structural_cols FROM percol;
