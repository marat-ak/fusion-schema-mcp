-- ============================================================================
-- X1a — EXPERIMENT (not part of the release build). Fact tables for a SECOND
-- parse: the same pinned sqlglot over `work.clear_sql.rewritten_sql` (the Qwen
-- rewrite of the OTBI machine SQL) instead of `sql_text`.
--
-- Purpose: MEASURE whether a two-pass OTBI flow (rewrite -> parse the rewrite)
-- produces better tables/joins than parsing the OBIS SQL directly. Nothing here
-- is read by the release build; `work.f_*`, `work.r_tables`, `work.relationships`
-- and every `v<ver>` schema are untouched.
--
-- Same keys (`sql_hash`), same column shapes as `p3_facts.sql`, so a comparison
-- is a plain set difference. Only the three fact tables the measurement needs are
-- created — columns/predicates/params/projection are not part of the question.
--
--   docker exec -i stack-db psql -U postgres -d fusion_dev -f /tmp/x1_facts2.sql
-- ============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS work.facts2_run, work.f2_tables, work.f2_joins CASCADE;

-- one row per rewritten statement: how far the parse of the REWRITE got
CREATE TABLE work.facts2_run (
  sql_hash       text PRIMARY KEY,
  parser_version text NOT NULL,
  parse_quality  text NOT NULL,   -- full | full_lex | fallback | failed
  parse_error    text
);

CREATE TABLE work.f2_tables (
  sql_hash   text NOT NULL,
  table_name text NOT NULL,
  is_cte     boolean NOT NULL DEFAULT false
);

CREATE TABLE work.f2_joins (
  sql_hash  text NOT NULL,
  from_t    text, from_c text,
  to_t      text, to_c   text,
  join_type text
);

SELECT 'x1 fact tables created' AS step,
       (SELECT count(*) FROM work.clear_sql
        WHERE source = 'otbi' AND rewritten_sql IS NOT NULL) AS rewrites_to_parse;
