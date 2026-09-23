-- ============================================================================
-- P5d — the PL/SQL API inventory of a release schema, from `work` (p3_calls.*).
--
-- Fills {{V}}.plsql_packages / plsql_api / plsql_api_tables / plsql_meta (ddl_version 3).
-- {{V}} is substituted by p5_plsql.sh. ONE transaction, DELETE then INSERT, on the
-- release being BUILT (a separate step so the inventory has its own gate line, not a
-- paragraph of p5_fill.sql; part of the chain so a rebuild never silently drops it the
-- way the runtime-inserted custom rows were dropped). It is NOT a repair tool: a built
-- release is immutable, and a release that lacks the inventory gets a new label.
--
-- Scope: counts are over ALL L3 statements (work.plsql_api, the analysis of record);
-- `samples` keep only statements the release ships (getReportQuery must resolve every
-- sample id); plsql_api_tables keeps real objects of the release only, at >= 2
-- statements or >= 5 % share. `method` rows (x.EXTRACT(), rowtype.GETCLOBVAL()) are
-- expressions, not packages, and are not shipped.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DELETE FROM {{V}}.plsql_api_tables;
DELETE FROM {{V}}.plsql_api;
DELETE FROM {{V}}.plsql_packages;
DELETE FROM {{V}}.plsql_meta;

INSERT INTO {{V}}.plsql_packages (package_name, api_class, in_dictionary, module, module_source, functions, statements)
SELECT package_name, api_class, in_dictionary::int, module, module_source, functions, statements
FROM   work.plsql_packages
WHERE  api_class IN ('fusion', 'oracle', 'custom');

INSERT INTO {{V}}.plsql_api (package_name, function_name, api_class, module, module_source, in_dictionary,
                             statements, units, reports, titles, by_source, arg_counts, found_in,
                             top_tables, top_modules, samples)
SELECT a.package_name, a.function_name, a.api_class, a.module, a.module_source, a.in_dictionary::int,
       a.statements, a.units, a.reports, a.titles,
       a.by_source::text, a.arg_counts::text, a.found_in::text, a.top_tables::text, a.top_modules::text,
       coalesce((SELECT jsonb_agg(s ORDER BY o)
                 FROM   jsonb_array_elements(a.samples) WITH ORDINALITY AS x(s, o)
                 WHERE  EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.id = 'sql:' || (s->>'sql_hash'))),
                '[]'::jsonb)::text
FROM   work.plsql_api a
WHERE  a.api_class IN ('fusion', 'oracle', 'custom');

INSERT INTO {{V}}.plsql_api_tables (package_name, function_name, table_name, statements, share)
SELECT t.package_name, t.function_name, t.table_name, t.statements, t.share
FROM   work.plsql_api_tables t
JOIN   {{V}}.plsql_api a USING (package_name, function_name)
WHERE  EXISTS (SELECT 1 FROM {{V}}.tables x WHERE x.name = t.table_name)
  AND  (t.statements >= 2 OR t.share >= 0.05);

INSERT INTO {{V}}.plsql_meta (k, v) VALUES
  ('version',   '1'),
  ('built_at',  now()::text),
  ('extractor', 'scripts/pipeline/p3_calls.py masked lexical scan v1'),
  ('scope',     'counts over all L3 statements; samples restricted to shipped corpus rows; api_tables real objects only, >=2 statements or >=5% share');

COMMIT;

ANALYZE {{V}}.plsql_packages; ANALYZE {{V}}.plsql_api; ANALYZE {{V}}.plsql_api_tables;

SELECT 'plsql_packages' AS t, count(*) AS rows, count(*) FILTER (WHERE statements > 0) AS used FROM {{V}}.plsql_packages
UNION ALL SELECT 'plsql_api', count(*), count(*) FILTER (WHERE samples <> '[]') FROM {{V}}.plsql_api
UNION ALL SELECT 'plsql_api_tables', count(*), count(DISTINCT table_name) FROM {{V}}.plsql_api_tables;
