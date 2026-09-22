-- ============================================================================
-- P3d — the PL/SQL CALL facts, keyed on sql_hash: every `PKG.FUNC(` /
-- `SCHEMA.PKG.FUNC(` reference in the 26,204 L3 statements.
--
-- Run BEFORE p3_calls.sh (which fills it with p3_calls.py and then rolls it up
-- with p3_calls_post.sql). A fact table like its f_* siblings: no unique
-- constraints (a COPY must not abort on a shape surprise), assertions live in
-- p3_calls_post.sql. Dropped and rebuilt whole — a re-run is a rebuild.
-- ============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS work.f_calls CASCADE;

CREATE TABLE work.f_calls (
  sql_hash      text    NOT NULL,
  seq           integer NOT NULL,   -- statement order
  schema_name   text,               -- the leading part of a 3-part call (FUSION.PKG.FN), else NULL
  package_name  text    NOT NULL,   -- upper-cased
  function_name text    NOT NULL,   -- upper-cased; a procedure looks the same statically
  arg_count     integer,            -- top-level commas + 1 (0 = empty parens); NULL = unbalanced (clipped SQL)
  paren         boolean NOT NULL,   -- false = parameterless reference (FND_GLOBAL.USER_ID), see p3_calls.py
  found_in      text    NOT NULL,   -- sql | plsql (inside WITH FUNCTION/PROCEDURE or a DECLARE/BEGIN block)
  pos           integer NOT NULL,   -- char offset in clear_sql.sql_text
  snippet       text    NOT NULL,   -- the call expression as written (literals kept), whitespace-collapsed
  truncated     boolean NOT NULL    -- snippet cut at SNIPPET_MAX or the parens never closed
);

SELECT 'f_calls created' AS step, (SELECT count(*) FROM work.clear_sql) AS statements_to_scan;
