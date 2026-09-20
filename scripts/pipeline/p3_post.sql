-- ============================================================================
-- P3c — after the parse: indexes, the REAL exclusion rule, and the divergence
-- report between what the parse found and what the enrichment claims.
--
-- excluded_reason is now a genuine parse output: 'dynamic_lexical' ⟺ the parser
-- could not read the statement as written and only succeeded after substituting
-- its &LEXICAL parameters (parse_quality='full_lex'). The previous build derived
-- this from v2026_09's per-unit parse column; this derives it from a parse of the
-- L3 statement itself.
-- ============================================================================
\set ON_ERROR_STOP on

CREATE INDEX ix_f_tables_hash      ON work.f_tables      (sql_hash);
CREATE INDEX ix_f_tables_table     ON work.f_tables      (table_name) WHERE NOT is_cte;
CREATE INDEX ix_f_columns_hash     ON work.f_columns     (sql_hash);
CREATE INDEX ix_f_columns_table    ON work.f_columns     (table_name, column_name);
CREATE INDEX ix_f_joins_hash       ON work.f_joins       (sql_hash);
CREATE INDEX ix_f_joins_from       ON work.f_joins       (from_t, from_c);
CREATE INDEX ix_f_joins_to         ON work.f_joins       (to_t, to_c);
CREATE INDEX ix_f_predicates_hash  ON work.f_predicates  (sql_hash);
CREATE INDEX ix_f_predicates_table ON work.f_predicates  (table_name, column_name);
CREATE INDEX ix_f_params_hash      ON work.f_params      (sql_hash);
CREATE INDEX ix_f_projection_hash  ON work.f_projection  (sql_hash);
ANALYZE work.f_tables; ANALYZE work.f_columns; ANALYZE work.f_joins;
ANALYZE work.f_predicates; ANALYZE work.f_params; ANALYZE work.facts_run;

-- ---------------------------------------------------------------------------
-- exclusions — a PARSE output, never an inventory regex
-- ---------------------------------------------------------------------------
UPDATE work.clear_sql SET excluded_reason = NULL WHERE excluded_reason IS NOT NULL;
UPDATE work.clear_sql c
SET    excluded_reason = 'dynamic_lexical'
FROM   work.facts_run f
WHERE  f.sql_hash = c.sql_hash AND f.parse_quality = 'full_lex';

-- the parse_quality of record now lives on the L3 row too (p1 stored the L2 units')
UPDATE work.clear_sql c
SET    parse_quality = f.parse_quality
FROM   work.facts_run f WHERE f.sql_hash = c.sql_hash;

INSERT INTO work.build_meta (k, v)
SELECT 'parser_version', max(parser_version) FROM work.facts_run
ON CONFLICT (k) DO UPDATE SET v = excluded.v;

-- ================= verify =================
\echo '--- parse coverage: every statement must have exactly one facts_run row ---'
SELECT (SELECT count(*) FROM work.clear_sql)                                  AS statements,
       (SELECT count(*) FROM work.facts_run)                                  AS parsed,
       (SELECT count(DISTINCT parser_version) FROM work.facts_run)            AS parser_versions,
       (SELECT max(parser_version) FROM work.facts_run)                       AS parser_version,
       (SELECT count(*) FROM work.clear_sql c
        WHERE NOT EXISTS (SELECT 1 FROM work.facts_run f WHERE f.sql_hash = c.sql_hash)) AS unparsed;

\echo '--- parse_quality distribution ---'
SELECT f.parse_quality, count(*) AS statements,
       round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct
FROM   work.facts_run f GROUP BY 1 ORDER BY 2 DESC;

\echo '--- parse_quality by source (L3 grain) ---'
SELECT c.source, f.parse_quality, count(*)
FROM   work.clear_sql c JOIN work.facts_run f ON f.sql_hash = c.sql_hash
GROUP  BY 1, 2 ORDER BY 1, 3 DESC;

\echo '--- exclusions: full_lex must equal dynamic_lexical ---'
SELECT (SELECT count(*) FROM work.facts_run WHERE parse_quality = 'full_lex')        AS full_lex,
       (SELECT count(*) FROM work.clear_sql WHERE excluded_reason='dynamic_lexical') AS dynamic_lexical,
       (SELECT count(DISTINCT sql_hash) FROM work.f_params WHERE kind='lexical')     AS statements_with_lexical_params;

\echo '--- fact volumes, and how many statements each reaches ---'
SELECT 'f_tables (physical)' AS fact, count(*) AS rows, count(DISTINCT sql_hash) AS statements,
       count(DISTINCT table_name) AS objects FROM work.f_tables WHERE NOT is_cte
UNION ALL SELECT 'f_tables (cte)', count(*), count(DISTINCT sql_hash), count(DISTINCT table_name) FROM work.f_tables WHERE is_cte
UNION ALL SELECT 'f_columns', count(*), count(DISTINCT sql_hash), count(DISTINCT table_name) FROM work.f_columns
UNION ALL SELECT 'f_joins', count(*), count(DISTINCT sql_hash), count(DISTINCT from_t) FROM work.f_joins
UNION ALL SELECT 'f_predicates', count(*), count(DISTINCT sql_hash), count(DISTINCT table_name) FROM work.f_predicates
UNION ALL SELECT 'f_params', count(*), count(DISTINCT sql_hash), count(DISTINCT kind) FROM work.f_params
UNION ALL SELECT 'f_projection', count(*), count(DISTINCT sql_hash), NULL FROM work.f_projection;

\echo '--- PREDICATE REACH: the point of the parse (enrichment ceiling was otbi-only) ---'
SELECT c.source,
       count(*)                                                        AS statements,
       count(*) FILTER (WHERE p.sql_hash IS NOT NULL)                  AS with_parsed_predicates,
       count(*) FILTER (WHERE c.filters IS NOT NULL)                   AS with_enrichment_filters
FROM   work.clear_sql c
LEFT   JOIN (SELECT DISTINCT sql_hash FROM work.f_predicates) p ON p.sql_hash = c.sql_hash
GROUP  BY 1 ORDER BY 1;

\echo '--- JOIN TYPE: recoverable from the parse, flattened to WHERE by the enrichment ---'
SELECT join_type, count(*) AS pairs, count(DISTINCT sql_hash) AS statements
FROM   work.f_joins GROUP BY 1 ORDER BY 2 DESC;

-- ===========================================================================
-- DIVERGENCE: parse facts vs the merged enrichment that STILL SHIPS in
-- report_queries.tables_used / .joins. The served columns are deliberately left
-- alone (a product decision, not a build detail) — this quantifies the gap.
-- ===========================================================================
\echo '--- tables_used: parsed set vs enriched set, per statement ---'
WITH p AS (SELECT sql_hash, array_agg(DISTINCT table_name ORDER BY table_name) AS t
           FROM work.f_tables WHERE NOT is_cte GROUP BY 1),
     e AS (SELECT c.sql_hash, array_agg(DISTINCT upper(btrim(v)) ORDER BY upper(btrim(v))) AS t
           FROM work.clear_sql c CROSS JOIN LATERAL jsonb_array_elements_text(c.tables_used) x(v)
           WHERE jsonb_typeof(c.tables_used)='array' GROUP BY 1),
     j AS (SELECT c.sql_hash, coalesce(p.t, '{}') AS pt, coalesce(e.t, '{}') AS et
           FROM work.clear_sql c LEFT JOIN p ON p.sql_hash=c.sql_hash LEFT JOIN e ON e.sql_hash=c.sql_hash)
SELECT count(*)                                                                AS statements,
       count(*) FILTER (WHERE pt = et)                                         AS identical,
       count(*) FILTER (WHERE pt @> et AND NOT pt = et)                        AS parse_superset,
       count(*) FILTER (WHERE et @> pt AND NOT pt = et)                        AS enrichment_superset,
       count(*) FILTER (WHERE NOT pt @> et AND NOT et @> pt)                   AS disjointish,
       sum(cardinality(pt))                                                    AS parsed_mentions,
       sum(cardinality(et))                                                    AS enriched_mentions
FROM   j;

\echo '--- filters: also a SERVED column, also left as the merged enrichment ---'
SELECT (SELECT count(*) FROM work.clear_sql WHERE filters IS NOT NULL)        AS served_statements_with_filters,
       (SELECT count(DISTINCT sql_hash) FROM work.f_predicates)              AS parsed_statements_with_predicates,
       (SELECT count(*) FROM work.clear_sql c
        WHERE c.filters IS NULL
          AND EXISTS (SELECT 1 FROM work.f_predicates p WHERE p.sql_hash = c.sql_hash)) AS parse_only,
       (SELECT count(*) FROM work.clear_sql c
        WHERE c.filters IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM work.f_predicates p WHERE p.sql_hash = c.sql_hash)) AS enrichment_only;

\echo '--- joins: unordered column-pair sets, parsed vs enriched ---'
WITH p AS (SELECT sql_hash, array_agg(DISTINCT pair ORDER BY pair) AS s FROM (
             SELECT sql_hash,
                    least(from_t||'.'||from_c, to_t||'.'||to_c) || '|' ||
                    greatest(from_t||'.'||from_c, to_t||'.'||to_c) AS pair
             FROM work.f_joins WHERE from_t IS NOT NULL AND to_t IS NOT NULL) z GROUP BY 1),
     e AS (SELECT sql_hash, array_agg(DISTINCT pair ORDER BY pair) AS s FROM (
             SELECT c.sql_hash,
                    least(upper(split_part(regexp_replace(v,'\[.*\]$',''),'=',1)),
                          upper(split_part(regexp_replace(v,'\[.*\]$',''),'=',2))) || '|' ||
                    greatest(upper(split_part(regexp_replace(v,'\[.*\]$',''),'=',1)),
                             upper(split_part(regexp_replace(v,'\[.*\]$',''),'=',2))) AS pair
             FROM work.clear_sql c CROSS JOIN LATERAL jsonb_array_elements_text(c.joins) x(v)
             WHERE jsonb_typeof(c.joins)='array' AND position('=' in v) > 0) z GROUP BY 1),
     j AS (SELECT c.sql_hash, coalesce(p.s,'{}') AS ps, coalesce(e.s,'{}') AS es
           FROM work.clear_sql c LEFT JOIN p ON p.sql_hash=c.sql_hash LEFT JOIN e ON e.sql_hash=c.sql_hash)
SELECT count(*)                                            AS statements,
       count(*) FILTER (WHERE ps = es)                     AS identical,
       count(*) FILTER (WHERE ps <> '{}' AND es = '{}')    AS parse_only,
       count(*) FILTER (WHERE ps = '{}' AND es <> '{}')    AS enrichment_only,
       count(*) FILTER (WHERE ps <> es AND ps <> '{}' AND es <> '{}') AS both_but_differ,
       sum(cardinality(ps))                                AS parsed_pairs,
       sum(cardinality(es))                                AS enriched_pairs
FROM   j;
