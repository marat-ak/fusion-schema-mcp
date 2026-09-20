-- ============================================================================
-- P3a — the fact tables the REAL parse fills, keyed on sql_hash.
--
-- Run BEFORE p3_parse.sh. Facts are produced by sqlglot (pinned), not by reading
-- the enrichment back. Generation-2 has no predicate field at all, and the excluded
-- generation-1 `filters` only ever covered otbi, and only 7,164 of its 11,291 hashes
-- — bip had exactly ONE and catalog/view none, so 27 % of the corpus was the ceiling
-- for enrichment-derived predicates. Only a parse creates bip and view facts.
--
-- Tables carry no unique constraints: a COPY of 26k statements' worth of facts must
-- not abort half-way on a shape surprise. Uniqueness is ASSERTED in p3_post.sql.
-- ============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS work.facts_run, work.f_tables, work.f_columns, work.f_joins,
                     work.f_predicates, work.f_params, work.f_projection CASCADE;

-- one row per statement: which parser saw it and how far it got
CREATE TABLE work.facts_run (
  sql_hash       text PRIMARY KEY,
  parser_version text NOT NULL,
  parse_quality  text NOT NULL,   -- full | full_lex | fallback | failed
  parse_error    text
);

-- physical tables/views referenced; CTE names are flagged, never counted as objects
CREATE TABLE work.f_tables (
  sql_hash   text NOT NULL,
  table_name text NOT NULL,
  is_cte     boolean NOT NULL DEFAULT false
);

-- alias-resolved column references with their clause context
CREATE TABLE work.f_columns (
  sql_hash    text NOT NULL,
  table_name  text NOT NULL,
  column_name text NOT NULL,
  context     text            -- select|where|join|group|order|having|case|exists|subquery
);

-- equi-join pairs: ANSI ON equalities + comma-join WHERE equalities, with the join TYPE
-- (the type is provably unrecoverable from the enrichment, which flattens everything to WHERE)
CREATE TABLE work.f_joins (
  sql_hash  text NOT NULL,
  from_t    text, from_c text,
  to_t      text, to_c   text,
  join_type text
);

-- <table.column> <op> <literal> facts. `found_in` says WHERE the predicate sits, so a
-- consumer can tell a real filter from one buried in a CASE or an EXISTS subquery.
CREATE TABLE work.f_predicates (
  sql_hash    text NOT NULL,
  seq         integer NOT NULL,
  table_name  text NOT NULL,
  column_name text NOT NULL,
  op          text NOT NULL,
  literal     text NOT NULL,
  found_in    text
);

-- :binds and &lexical parameters. The lexical ones are what make a statement unparseable
-- as written — they are the ONLY legitimate source of excluded_reason='dynamic_lexical'.
CREATE TABLE work.f_params (
  sql_hash text NOT NULL,
  name     text NOT NULL,
  kind     text NOT NULL   -- bind | lexical
);

-- the statement's public interface: top-level output columns
CREATE TABLE work.f_projection (
  sql_hash    text NOT NULL,
  seq         integer NOT NULL,
  alias       text,
  source_expr text
);

-- relationships are DERIVED, in p3_rel.sql, from work.f_joins + work.meta_fkeys.
-- They used to be carried from v2026_09 (mined_relationships.json / otbi_relations.json
-- upstream of it), which made the release its own input. Nothing in this build reads
-- a shipped schema.

SELECT 'fact tables created' AS step,
       (SELECT count(*) FROM work.clear_sql) AS statements_to_parse;
