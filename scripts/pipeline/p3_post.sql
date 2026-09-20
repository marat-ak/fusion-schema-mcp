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

-- parse_quality is written HERE and only here: p1 no longer carries the old inventory column
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

\echo '--- PREDICATE REACH: the point of the parse (gen-2 has no predicate field at all) ---'
SELECT c.source,
       count(*)                                       AS statements,
       count(*) FILTER (WHERE p.sql_hash IS NOT NULL) AS with_parsed_predicates
FROM   work.clear_sql c
LEFT   JOIN (SELECT DISTINCT sql_hash FROM work.f_predicates) p ON p.sql_hash = c.sql_hash
GROUP  BY 1 ORDER BY 1;

\echo '--- JOIN TYPE: recoverable only from the parse ---'
SELECT join_type, count(*) AS pairs, count(DISTINCT sql_hash) AS statements
FROM   work.f_joins GROUP BY 1 ORDER BY 2 DESC;

-- ===========================================================================
-- DIVERGENCE: sqlglot's table set vs the MODEL's corrections to it.
--
-- The model was shown the round-0 facts and asked to confirm them; its verdict is
-- loaded in work.qwen_table_correction and NOT applied. This quantifies the gap so
-- the decision ("may the model overrule the parser, and where?") can be made on
-- numbers rather than on the feeling that one of them is better.
-- ===========================================================================
\echo '--- the model on the parser: confirmed / extra / missing ---'
SELECT c.source,
       count(*) FILTER (WHERE c.src_enrich_unit IS NOT NULL) AS judged,
       count(*) FILTER (WHERE c.tables_confirmed)            AS confirmed,
       count(*) FILTER (WHERE c.tables_confirmed IS FALSE)   AS disputed,
       count(*) FILTER (WHERE c.extra_tables IS NOT NULL)    AS claims_extra,
       count(*) FILTER (WHERE c.missing_tables IS NOT NULL)  AS claims_missing
FROM   work.clear_sql c GROUP BY 1 ORDER BY 1;

\echo '--- do the corrections agree with THIS parse? (the model judged the OLD round-0 facts) ---'
SELECT k.kind,
       count(*)                                          AS corrections,
       count(*) FILTER (WHERE t.sql_hash IS NOT NULL)    AS table_is_in_this_parse,
       count(*) FILTER (WHERE t.sql_hash IS NULL)        AS table_is_not_in_this_parse
FROM   work.qwen_table_correction k
LEFT   JOIN LATERAL (SELECT 1 AS sql_hash FROM work.f_tables f
                     WHERE f.sql_hash = k.sql_hash AND NOT f.is_cte
                       AND f.table_name = k.table_name LIMIT 1) t ON true
GROUP  BY 1 ORDER BY 1;

\echo '--- how many disputed statements would actually change if the corrections were applied ---'
SELECT count(DISTINCT k.sql_hash) AS statements_with_actionable_corrections
FROM   work.qwen_table_correction k
WHERE  (k.kind = 'extra'   AND     EXISTS (SELECT 1 FROM work.f_tables f
           WHERE f.sql_hash = k.sql_hash AND NOT f.is_cte AND f.table_name = k.table_name))
   OR  (k.kind = 'missing' AND NOT EXISTS (SELECT 1 FROM work.f_tables f
           WHERE f.sql_hash = k.sql_hash AND NOT f.is_cte AND f.table_name = k.table_name));
