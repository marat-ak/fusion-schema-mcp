-- ============================================================================
-- P3d-post — classify the call facts against the vendor dictionary and roll
-- them up into the PL/SQL API inventory (work.plsql_api / work.plsql_api_tables).
--
-- Runs after p3_calls.py extract. Re-runnable without a re-scan: everything here
-- is derived from work.f_calls + work.meta_tables + work.r_tables + work.sql_unit.
--
-- Classes (per package, then per call):
--   oracle   standard Oracle packages / types (DBMS_*, UTL_*, SYS.*, XMLTYPE, …)
--   custom   XX* — customer objects (cannot exist in SaaS; carried from migrated reports)
--   fusion   a PACKAGE object of the vendor dictionary (work.meta_tables table_type='PACKAGE',
--            in_dictionary = true), OR the package is called WITH parens and a non-method
--            function (JA_AU_API: in SaaS nothing but Oracle-shipped code can be called, so a
--            real call proves the class). The dictionary carries no module for packages, so
--            module = the dominant APPLICATION_SHORT_NAME of the tables sharing the package's
--            prefix (module_source 'prefix'), else the dominant module of the tables the calling
--            SQL reads (module_source 'usage').
--   method   an unclassified left part with an XMLType / collection METHOD on the right
--            (x.EXTRACT(…), rowtype.GETCLOBVAL(), t.COUNT) — an expression, not a package
--   unknown  the rest — reviewed by hand in the report, never silently promoted
-- A package that is ONLY ever referenced without parens (FND_GLOBAL.USER_NAME) stays in the
-- inventory only when >= 2 distinct statements reference it.
-- ============================================================================
\set ON_ERROR_STOP on

CREATE INDEX IF NOT EXISTS ix_f_calls_hash ON work.f_calls (sql_hash);
CREATE INDEX IF NOT EXISTS ix_f_calls_api  ON work.f_calls (package_name, function_name);
ANALYZE work.f_calls;

-- one row per (sql_hash, seq)
DO $$
DECLARE d bigint;
BEGIN
  SELECT count(*) - count(DISTINCT (sql_hash, seq)) INTO d FROM work.f_calls;
  IF d <> 0 THEN RAISE EXCEPTION 'f_calls: % duplicate (sql_hash, seq) rows', d; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- package classification
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS work.plsql_pkg_class;
CREATE TABLE work.plsql_pkg_class AS
WITH pref AS (
  SELECT split_part(table_name, '_', 1) AS p, count(*) AS n,
         mode() WITHIN GROUP (ORDER BY application_short_name) AS module
  FROM   work.meta_tables
  WHERE  table_type IN ('TABLE', 'VIEW') AND application_short_name IS NOT NULL
  GROUP  BY 1 HAVING count(*) >= 5),
pk AS (
  SELECT package_name, count(DISTINCT sql_hash) AS statements,
         count(DISTINCT sql_hash) FILTER (WHERE NOT paren) AS bare_statements,
         bool_or(paren AND function_name NOT IN ('EXTRACT', 'EXTRACTVALUE', 'GETSTRINGVAL', 'GETCLOBVAL', 'GETNUMBERVAL',
                                                 'GETBLOBVAL', 'EXISTSNODE', 'GETROOTELEMENT', 'TRANSFORM', 'ISFRAGMENT',
                                                 'GETNAMESPACE', 'COUNT', 'FIRST', 'LAST', 'NEXT', 'PRIOR', 'EXISTS',
                                                 'DELETE', 'TRIM', 'EXTEND', 'LIMIT')) AS real_call,
         bool_or(coalesce(schema_name, '') IN ('SYS', 'SYSTEM', 'XDB', 'MDSYS', 'CTXSYS', 'DBSNMP', 'OUTLN')) AS sys_schema
  FROM   work.f_calls GROUP BY 1),
dict AS (SELECT DISTINCT table_name AS package_name FROM work.meta_tables WHERE table_type = 'PACKAGE')
SELECT pk.package_name, pk.statements, pk.bare_statements, pk.real_call,
       (d.package_name IS NOT NULL) AS in_dictionary,
       CASE
         WHEN pk.sys_schema
           OR pk.package_name ~ '^(DBMS_|UTL_|XMLTYPE$|XMLTYPE_|XMLDOM|XMLPARSER|XSLPROCESSOR|HTP$|HTF$|OWA_|CTX_|SDO_|ANYDATA|ANYTYPE|APEX_|WWV_|ORA_|SYS$|SYS_|JSON_|OLAP|STANDARD$|ODCI|DBMS$|XDB|MDSYS|CTXSYS|SYSTEM$|WPG_|SEM_)'
           THEN 'oracle'
         WHEN pk.package_name ~ '^XX' THEN 'custom'
         WHEN d.package_name IS NOT NULL THEN 'fusion'
         WHEN pk.real_call THEN 'fusion'
         ELSE 'unknown'
       END AS api_class,
       CASE WHEN pk.package_name ~ '^XX' THEN NULL ELSE pref.module END AS module,
       CASE WHEN pk.package_name !~ '^XX' AND pref.module IS NOT NULL THEN 'prefix' END AS module_source
FROM   pk LEFT JOIN pref ON pref.p = split_part(pk.package_name, '_', 1)
LEFT JOIN dict d USING (package_name);

-- ---------------------------------------------------------------------------
-- the inventory: one row per package.function
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS work.plsql_api, work.plsql_api_tables;

CREATE TABLE work.plsql_api AS
WITH c AS (
  SELECT f.sql_hash, f.package_name, f.function_name, f.arg_count, f.paren, f.found_in, f.snippet, f.truncated,
         CASE WHEN pc.api_class = 'unknown'
                AND f.function_name IN ('EXTRACT', 'EXTRACTVALUE', 'GETSTRINGVAL', 'GETCLOBVAL', 'GETNUMBERVAL',
                                        'GETBLOBVAL', 'EXISTSNODE', 'GETROOTELEMENT', 'TRANSFORM', 'ISFRAGMENT',
                                        'GETNAMESPACE', 'COUNT', 'FIRST', 'LAST', 'NEXT', 'PRIOR', 'EXISTS',
                                        'DELETE', 'TRIM', 'EXTEND', 'LIMIT')
              THEN 'method' ELSE pc.api_class END AS api_class,
         pc.module, pc.module_source, pc.in_dictionary
  FROM   work.f_calls f JOIN work.plsql_pkg_class pc USING (package_name)
  -- a bare-only package (never a real call) needs corroboration: >= 2 distinct statements
  WHERE  pc.real_call OR pc.bare_statements >= 2 OR f.paren),
per_stmt AS (SELECT DISTINCT sql_hash, package_name, function_name, api_class, module, module_source, in_dictionary FROM c),
units AS (
  SELECT ps.package_name, ps.function_name,
         count(DISTINCT u.unit_id) AS units, count(DISTINCT u.title) AS titles
  FROM   per_stmt ps JOIN work.sql_unit u USING (sql_hash) GROUP BY 1, 2),
reports AS (
  SELECT ps.package_name, ps.function_name, count(DISTINCT r.path) AS reports
  FROM   per_stmt ps JOIN work.sql_unit u USING (sql_hash) JOIN work.unit_ref r ON r.unit_id = u.unit_id
  GROUP  BY 1, 2),
by_source AS (
  SELECT package_name, function_name, jsonb_object_agg(source, n ORDER BY source) AS by_source
  FROM  (SELECT ps.package_name, ps.function_name, cs.source, count(*) AS n
         FROM   per_stmt ps JOIN work.clear_sql cs USING (sql_hash) GROUP BY 1, 2, 3) s
  GROUP  BY 1, 2),
args AS (
  SELECT package_name, function_name, jsonb_object_agg(k, n ORDER BY k) AS arg_counts
  FROM  (SELECT package_name, function_name, coalesce(arg_count::text, '?') AS k, count(*) AS n
         FROM   c GROUP BY 1, 2, 3) s
  GROUP  BY 1, 2),
found AS (
  SELECT package_name, function_name, jsonb_object_agg(found_in, n ORDER BY found_in) AS found_in
  FROM  (SELECT package_name, function_name, found_in, count(*) AS n FROM c GROUP BY 1, 2, 3) s
  GROUP  BY 1, 2),
tabs AS (
  SELECT ps.package_name, ps.function_name, r.table_name, count(DISTINCT ps.sql_hash) AS n
  FROM   per_stmt ps JOIN work.r_tables r USING (sql_hash)
  WHERE  NOT r.is_cte
  GROUP  BY 1, 2, 3),
top_tabs AS (
  SELECT package_name, function_name,
         jsonb_agg(jsonb_build_object('table', table_name, 'statements', n) ORDER BY n DESC, table_name) AS top_tables
  FROM  (SELECT *, row_number() OVER (PARTITION BY package_name, function_name ORDER BY n DESC, table_name) AS rn FROM tabs) t
  WHERE  rn <= 8 GROUP BY 1, 2),
mods AS (
  SELECT package_name, function_name,
         jsonb_agg(jsonb_build_object('module', module, 'statements', n) ORDER BY n DESC, module) AS top_modules
  FROM  (SELECT package_name, function_name, module, n,
                row_number() OVER (PARTITION BY package_name, function_name ORDER BY n DESC, module) AS rn
         FROM  (SELECT ps.package_name, ps.function_name, mt.application_short_name AS module, count(DISTINCT ps.sql_hash) AS n
                FROM   per_stmt ps JOIN work.r_tables r USING (sql_hash)
                JOIN   work.meta_tables mt ON mt.table_name = r.table_name AND mt.table_type IN ('TABLE', 'VIEW')
                WHERE  NOT r.is_cte AND mt.application_short_name IS NOT NULL
                GROUP  BY 1, 2, 3) m) x
  WHERE  rn <= 5 GROUP BY 1, 2),
samples AS (
  -- two shortest complete snippets from distinct statements: described (= shippable) first, then
  -- real BIP reports first, so the release copy (p5_plsql.sql) keeps them after its corpus filter
  SELECT package_name, function_name,
         jsonb_agg(jsonb_build_object('snippet', snippet, 'sql_hash', sql_hash, 'source', source, 'title', title)
                   ORDER BY rn) AS samples
  FROM  (SELECT c.package_name, c.function_name, c.snippet, c.sql_hash, cs.source, cs.title,
                row_number() OVER (PARTITION BY c.package_name, c.function_name
                                   ORDER BY (cs.description IS NULL), (cs.source <> 'bip-report'), c.truncated, length(c.snippet), c.sql_hash) AS rn
         FROM  (SELECT DISTINCT ON (package_name, function_name, sql_hash) package_name, function_name, sql_hash, snippet, truncated
                FROM   c ORDER BY package_name, function_name, sql_hash, truncated, length(snippet)) c
         JOIN   work.clear_sql cs USING (sql_hash)) s
  WHERE  rn <= 2 GROUP BY 1, 2)
SELECT ps.api_class,
       coalesce(ps.module, md.top_modules->0->>'module')                  AS module,
       CASE WHEN ps.module IS NOT NULL THEN ps.module_source
            WHEN md.top_modules->0->>'module' IS NOT NULL THEN 'usage' END AS module_source,
       ps.package_name, ps.function_name, ps.in_dictionary,
       count(DISTINCT ps.sql_hash)      AS statements,
       coalesce(u.units, 0)             AS units,
       coalesce(rp.reports, 0)          AS reports,
       coalesce(u.titles, 0)            AS titles,
       bs.by_source, a.arg_counts, fd.found_in,
       tt.top_tables, md.top_modules, sm.samples
FROM   per_stmt ps
LEFT JOIN units     u  USING (package_name, function_name)
LEFT JOIN reports   rp USING (package_name, function_name)
LEFT JOIN by_source bs USING (package_name, function_name)
LEFT JOIN args      a  USING (package_name, function_name)
LEFT JOIN found     fd USING (package_name, function_name)
LEFT JOIN top_tabs  tt USING (package_name, function_name)
LEFT JOIN mods      md USING (package_name, function_name)
LEFT JOIN samples   sm USING (package_name, function_name)
GROUP  BY ps.api_class, ps.module, ps.module_source, ps.package_name, ps.function_name, ps.in_dictionary,
          u.units, u.titles, rp.reports, bs.by_source, a.arg_counts, fd.found_in, tt.top_tables, md.top_modules, sm.samples;

ALTER TABLE work.plsql_api ADD PRIMARY KEY (package_name, function_name);

-- package level: the dictionary's PACKAGE objects ∪ every package the corpus calls. A package
-- with statements = 0 EXISTS on the pod but no shipped report calls it (INV_QUANTITY_TREE_PUB).
DROP TABLE IF EXISTS work.plsql_packages;
CREATE TABLE work.plsql_packages AS
WITH pref AS (
  SELECT split_part(table_name, '_', 1) AS p, mode() WITHIN GROUP (ORDER BY application_short_name) AS module
  FROM   work.meta_tables WHERE table_type IN ('TABLE', 'VIEW') AND application_short_name IS NOT NULL
  GROUP  BY 1 HAVING count(*) >= 5),
d AS (SELECT DISTINCT table_name AS package_name FROM work.meta_tables WHERE table_type = 'PACKAGE'),
a AS (SELECT package_name, api_class, min(module) AS module, min(module_source) AS module_source,
             count(*) AS functions, count(DISTINCT s) AS statements
      FROM   work.plsql_api, LATERAL (SELECT sql_hash AS s FROM work.f_calls f
                                      WHERE f.package_name = plsql_api.package_name AND f.function_name = plsql_api.function_name) x
      WHERE  api_class IN ('fusion', 'oracle', 'custom')
      GROUP  BY 1, 2)
SELECT coalesce(a.package_name, d.package_name)                  AS package_name,
       coalesce(a.api_class, 'fusion')                           AS api_class,
       (d.package_name IS NOT NULL)                              AS in_dictionary,
       coalesce(a.module, pref.module)                           AS module,
       coalesce(a.module_source, CASE WHEN pref.module IS NOT NULL THEN 'prefix' END) AS module_source,
       coalesce(a.functions, 0)                                  AS functions,
       coalesce(a.statements, 0)                                 AS statements
FROM   d FULL JOIN a USING (package_name)
LEFT JOIN pref ON pref.p = split_part(coalesce(a.package_name, d.package_name), '_', 1);
ALTER TABLE work.plsql_packages ADD PRIMARY KEY (package_name);

-- api × table co-occurrence: share = statements calling the api AND reading the table
-- over statements reading the table (the same denominator table_join_columns uses)
CREATE TABLE work.plsql_api_tables AS
SELECT a.package_name, a.function_name, t.table_name, t.n AS statements,
       round(t.n::numeric / d.n, 4)::float8 AS share
FROM  (SELECT ps.package_name, ps.function_name, r.table_name, count(DISTINCT ps.sql_hash) AS n
       FROM  (SELECT DISTINCT sql_hash, package_name, function_name FROM work.f_calls) ps
       JOIN   work.r_tables r USING (sql_hash) WHERE NOT r.is_cte GROUP BY 1, 2, 3) t
JOIN   work.plsql_api a USING (package_name, function_name)
JOIN  (SELECT table_name, count(DISTINCT sql_hash) AS n FROM work.r_tables WHERE NOT is_cte GROUP BY 1) d USING (table_name)
WHERE  a.api_class IN ('fusion', 'oracle', 'custom', 'unknown');
CREATE INDEX ix_plsql_api_tables_t ON work.plsql_api_tables (table_name, statements DESC);
ANALYZE work.plsql_api; ANALYZE work.plsql_api_tables;

-- ---------------------------------------------------------------------------
-- the report a reviewer reads
-- ---------------------------------------------------------------------------
SELECT api_class, count(DISTINCT package_name) AS packages, count(*) AS functions,
       sum(statements) AS call_statements
FROM   work.plsql_api GROUP BY 1 ORDER BY 3 DESC;

SELECT 'unknown left parts to review (top 40 by statements)' AS note;
SELECT package_name, function_name, statements, units, left(samples->0->>'snippet', 90) AS sample
FROM   work.plsql_api WHERE api_class = 'unknown' ORDER BY statements DESC, package_name LIMIT 40;

SELECT 'fusion packages classified by USAGE (no table prefix) — review' AS note;
SELECT package_name, count(*) AS functions, sum(statements) AS statements, min(module) AS module
FROM   work.plsql_api WHERE api_class = 'fusion' AND module_source = 'usage' GROUP BY 1 ORDER BY 3 DESC LIMIT 40;

SELECT 'schema-qualified calls (schema_name set) by schema' AS note;
SELECT schema_name, count(*) FROM work.f_calls WHERE schema_name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;

SELECT 'enrichment cross-check: plsql_functions names the parse did NOT find (top 20)' AS note;
SELECT n, count(*) FROM (
  SELECT regexp_replace(upper(e->>'name'), '^FUSION\.', '') AS n FROM work.clear_sql, jsonb_array_elements(plsql_functions) e
  WHERE jsonb_typeof(plsql_functions) = 'array' AND e->>'name' LIKE '%.%') x
WHERE NOT EXISTS (SELECT 1 FROM work.plsql_api a WHERE a.package_name || '.' || a.function_name = x.n)
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
