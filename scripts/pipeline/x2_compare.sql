-- ============================================================================
-- X2 — EXPERIMENT. Compare the parse of the Qwen REWRITE (work.f2_*, x1) against
-- the parse of the machine OTBI SQL (work.f_*, p3), statement by statement.
--
-- Reads only. Creates three new comparison tables (`work.x2_*`) and prints the
-- report. `work.f_*`, `work.r_tables`, `work.relationships`, `work.clear_sql` and
-- every `v<ver>` schema are NOT touched.
--
--   docker exec -i stack-db psql -U postgres -d fusion_dev -f /tmp/x2_compare.sql
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

DROP TABLE IF EXISTS work.x2_cohort, work.x2_tables_cmp, work.x2_joins_cmp CASCADE;

-- ---------------------------------------------------------------- the cohort
-- Every OTBI statement that HAS a rewrite, with both parses' quality side by side.
CREATE TABLE work.x2_cohort AS
SELECT c.sql_hash,
       length(c.sql_text)       AS len_orig,
       length(c.rewritten_sql)  AS len_rw,
       f.parse_quality          AS q_orig,
       g.parse_quality          AS q_rw,
       g.parse_error            AS err_rw,
       f.parse_error            AS err_orig
FROM   work.clear_sql c
JOIN   work.facts_run  f ON f.sql_hash = c.sql_hash
JOIN   work.facts2_run g ON g.sql_hash = c.sql_hash
WHERE  c.source = 'otbi' AND c.rewritten_sql IS NOT NULL;
ALTER TABLE work.x2_cohort ADD PRIMARY KEY (sql_hash);

-- ---------------------------------------------------------------- tables
-- One row per (statement, table name) seen by EITHER parse, non-CTE only:
-- CTE names are not object references and the OBIS wrappers are all CTEs, so
-- counting them would flatter whichever side declares more of them.
CREATE TABLE work.x2_tables_cmp AS
WITH o AS (SELECT DISTINCT sql_hash, table_name FROM work.f_tables  WHERE NOT is_cte),
     r AS (SELECT DISTINCT sql_hash, table_name FROM work.f2_tables WHERE NOT is_cte),
     u AS (SELECT sql_hash, table_name FROM o WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
           UNION
           SELECT sql_hash, table_name FROM r WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort))
SELECT u.sql_hash, u.table_name,
       (o.sql_hash IS NOT NULL) AS in_orig,
       (r.sql_hash IS NOT NULL) AS in_rw,
       EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = u.table_name) AS in_dict,
       CASE
         WHEN u.table_name ~ '^SAWITH[0-9]*$'                  THEN 'sawith'
         WHEN u.table_name IN ('DUAL', 'XMLTABLE')             THEN 'obis_builtin'
         WHEN u.table_name ~ '^[TVD][0-9]{3,}$'                THEN 'machine_alias'
         WHEN EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = u.table_name)
                                                               THEN 'dictionary'
         ELSE 'unresolved'
       END AS klass
FROM   u
LEFT   JOIN o ON o.sql_hash = u.sql_hash AND o.table_name = u.table_name
LEFT   JOIN r ON r.sql_hash = u.sql_hash AND r.table_name = u.table_name;
CREATE INDEX ON work.x2_tables_cmp (sql_hash);

-- ---------------------------------------------------------------- joins
-- Canonical undirected edge: (from_t, from_c, to_t, to_c) ordered so A-B = B-A.
-- Self-joins are already impossible (the extractor requires lt <> rt).
CREATE TABLE work.x2_joins_cmp AS
WITH o AS (
  SELECT DISTINCT sql_hash,
         least(from_t || '.' || from_c, to_t || '.' || to_c)     AS a,
         greatest(from_t || '.' || from_c, to_t || '.' || to_c)  AS b
  FROM work.f_joins WHERE from_t IS NOT NULL AND to_t IS NOT NULL),
r AS (
  SELECT DISTINCT sql_hash,
         least(from_t || '.' || from_c, to_t || '.' || to_c)     AS a,
         greatest(from_t || '.' || from_c, to_t || '.' || to_c)  AS b
  FROM work.f2_joins WHERE from_t IS NOT NULL AND to_t IS NOT NULL),
u AS (SELECT sql_hash, a, b FROM o WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
      UNION
      SELECT sql_hash, a, b FROM r WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort))
SELECT u.sql_hash, u.a, u.b,
       split_part(u.a, '.', 1) AS ta, split_part(u.b, '.', 1) AS tb,
       (o.sql_hash IS NOT NULL) AS in_orig,
       (r.sql_hash IS NOT NULL) AS in_rw,
       (EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.a, '.', 1))
        AND EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.b, '.', 1))) AS both_in_dict
FROM   u
LEFT   JOIN o ON o.sql_hash = u.sql_hash AND o.a = u.a AND o.b = u.b
LEFT   JOIN r ON r.sql_hash = u.sql_hash AND r.a = u.a AND r.b = u.b;
CREATE INDEX ON work.x2_joins_cmp (sql_hash);

ANALYZE work.x2_cohort;
ANALYZE work.x2_tables_cmp;
ANALYZE work.x2_joins_cmp;

-- ============================================================================
-- 1. PARSE QUALITY
-- ============================================================================
\echo '=== 1a. cohort size + both parses side by side ==='
SELECT count(*) AS statements,
       round(avg(len_orig)) AS avg_len_orig, round(avg(len_rw)) AS avg_len_rw
FROM work.x2_cohort;

\echo '=== 1b. quality cross-tab: rows = original parse, cols = rewrite parse ==='
SELECT q_orig,
       count(*) FILTER (WHERE q_rw = 'full')      AS rw_full,
       count(*) FILTER (WHERE q_rw = 'full_lex')  AS rw_full_lex,
       count(*) FILTER (WHERE q_rw = 'fallback')  AS rw_fallback,
       count(*) FILTER (WHERE q_rw = 'failed')    AS rw_failed,
       count(*)                                    AS total
FROM work.x2_cohort GROUP BY 1 ORDER BY 6 DESC;

\echo '=== 1c. net movement ==='
WITH rank_q AS (SELECT * FROM (VALUES ('full',3),('full_lex',3),('fallback',2),('failed',1)) v(q, r))
SELECT count(*) FILTER (WHERE ro.r < rr.r) AS improved,
       count(*) FILTER (WHERE ro.r = rr.r) AS same,
       count(*) FILTER (WHERE ro.r > rr.r) AS regressed
FROM work.x2_cohort c JOIN rank_q ro ON ro.q = c.q_orig JOIN rank_q rr ON rr.q = c.q_rw;

\echo '=== 1d. rewrite parse errors, top messages ==='
SELECT left(err_rw, 90) AS rewrite_parse_error, count(*)
FROM work.x2_cohort WHERE err_rw IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 12;

-- ============================================================================
-- 2. TABLES
-- ============================================================================
\echo '=== 2a. table references: set comparison (distinct statement x table) ==='
SELECT count(*) FILTER (WHERE in_orig AND in_rw)       AS in_both,
       count(*) FILTER (WHERE in_orig AND NOT in_rw)   AS orig_only,
       count(*) FILTER (WHERE in_rw AND NOT in_orig)   AS rw_only,
       count(*)                                         AS union_total
FROM work.x2_tables_cmp;

\echo '=== 2b. per-side totals and dictionary-resolution rate ==='
SELECT 'original' AS side,
       count(*) FILTER (WHERE in_orig)                         AS refs,
       count(*) FILTER (WHERE in_orig AND in_dict)             AS resolve_in_dict,
       round(100.0 * count(*) FILTER (WHERE in_orig AND in_dict)
             / nullif(count(*) FILTER (WHERE in_orig), 0), 2)  AS pct
FROM work.x2_tables_cmp
UNION ALL
SELECT 'rewritten',
       count(*) FILTER (WHERE in_rw),
       count(*) FILTER (WHERE in_rw AND in_dict),
       round(100.0 * count(*) FILTER (WHERE in_rw AND in_dict)
             / nullif(count(*) FILTER (WHERE in_rw), 0), 2)
FROM work.x2_tables_cmp;

\echo '=== 2c. class breakdown per side (OBIS artifacts vs real objects) ==='
SELECT klass,
       count(*) FILTER (WHERE in_orig) AS orig_refs,
       count(*) FILTER (WHERE in_rw)   AS rw_refs
FROM work.x2_tables_cmp GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 2d. distinct tables per statement, both sides ==='
SELECT round(avg(n_orig), 2) AS avg_tables_orig, round(avg(n_rw), 2) AS avg_tables_rw,
       count(*) FILTER (WHERE n_rw > n_orig) AS stmts_rw_has_more,
       count(*) FILTER (WHERE n_rw = n_orig) AS stmts_equal_count,
       count(*) FILTER (WHERE n_rw < n_orig) AS stmts_rw_has_fewer,
       count(*) FILTER (WHERE n_rw = 0)      AS stmts_rw_zero_tables
FROM (SELECT c.sql_hash,
             count(*) FILTER (WHERE t.in_orig) AS n_orig,
             count(*) FILTER (WHERE t.in_rw)   AS n_rw
      FROM work.x2_cohort c LEFT JOIN work.x2_tables_cmp t USING (sql_hash)
      GROUP BY 1) s;

\echo '=== 2e. statements where the two table SETS differ at all ==='
SELECT count(*) FILTER (WHERE d = 0) AS identical_sets,
       count(*) FILTER (WHERE d > 0) AS differing_sets
FROM (SELECT sql_hash, count(*) FILTER (WHERE in_orig <> in_rw) AS d
      FROM work.x2_tables_cmp GROUP BY 1) s;

\echo '=== 2f. the tables the rewrite ADDS most often (dictionary-resolving only) ==='
SELECT table_name, count(*) AS stmts
FROM work.x2_tables_cmp WHERE in_rw AND NOT in_orig AND in_dict
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

\echo '=== 2g. the tables the rewrite DROPS most often (dictionary-resolving only) ==='
SELECT table_name, count(*) AS stmts
FROM work.x2_tables_cmp WHERE in_orig AND NOT in_rw AND in_dict
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- ============================================================================
-- 3. JOINS
-- ============================================================================
\echo '=== 3a. join edges: set comparison (distinct statement x canonical edge) ==='
SELECT count(*) FILTER (WHERE in_orig AND in_rw)     AS in_both,
       count(*) FILTER (WHERE in_orig AND NOT in_rw) AS orig_only,
       count(*) FILTER (WHERE in_rw AND NOT in_orig) AS rw_only,
       count(*)                                       AS union_total
FROM work.x2_joins_cmp;

\echo '=== 3b. per-side edge totals and both-tables-resolve rate ==='
SELECT 'original' AS side,
       count(*) FILTER (WHERE in_orig)                                AS edges,
       count(*) FILTER (WHERE in_orig AND both_in_dict)               AS both_resolve,
       round(100.0 * count(*) FILTER (WHERE in_orig AND both_in_dict)
             / nullif(count(*) FILTER (WHERE in_orig), 0), 2)         AS pct
FROM work.x2_joins_cmp
UNION ALL
SELECT 'rewritten',
       count(*) FILTER (WHERE in_rw),
       count(*) FILTER (WHERE in_rw AND both_in_dict),
       round(100.0 * count(*) FILTER (WHERE in_rw AND both_in_dict)
             / nullif(count(*) FILTER (WHERE in_rw), 0), 2)
FROM work.x2_joins_cmp;

\echo '=== 3c. statements by edge gain/loss ==='
SELECT count(*) FILTER (WHERE n_rw > n_orig) AS stmts_gained,
       count(*) FILTER (WHERE n_rw = n_orig) AS stmts_same_count,
       count(*) FILTER (WHERE n_rw < n_orig) AS stmts_lost,
       count(*) FILTER (WHERE n_orig > 0 AND n_rw = 0) AS stmts_rw_lost_all,
       count(*) FILTER (WHERE n_orig = 0 AND n_rw > 0) AS stmts_rw_from_nothing,
       round(avg(n_orig), 2) AS avg_edges_orig, round(avg(n_rw), 2) AS avg_edges_rw
FROM (SELECT c.sql_hash,
             count(*) FILTER (WHERE j.in_orig) AS n_orig,
             count(*) FILTER (WHERE j.in_rw)   AS n_rw
      FROM work.x2_cohort c LEFT JOIN work.x2_joins_cmp j USING (sql_hash)
      GROUP BY 1) s;

\echo '=== 3d. join_type distribution, each side ==='
SELECT 'original' AS side, join_type, count(*) AS edge_rows
FROM work.f_joins WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort) GROUP BY 1,2
UNION ALL
SELECT 'rewritten', join_type, count(*)
FROM work.f2_joins WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort) GROUP BY 1,2
ORDER BY 1, 3 DESC;

-- ============================================================================
-- 4. CORROBORATION against work.qwen_table_correction (OTBI subset)
-- ============================================================================
\echo '=== 4a. claim inventory on the cohort ==='
SELECT k.kind, count(*) AS claims, count(DISTINCT k.sql_hash) AS statements
FROM work.qwen_table_correction k
WHERE k.sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
GROUP BY 1;

\echo '=== 4b. does the REWRITE parse independently produce the claimed table? ==='
SELECT k.kind,
       count(*)                                                       AS claims,
       count(*) FILTER (WHERE rw.sql_hash IS NOT NULL)                AS in_rewrite_parse,
       round(100.0 * count(*) FILTER (WHERE rw.sql_hash IS NOT NULL) / count(*), 1) AS pct
FROM work.qwen_table_correction k
LEFT JOIN (SELECT DISTINCT sql_hash, table_name FROM work.f2_tables WHERE NOT is_cte) rw
       ON rw.sql_hash = k.sql_hash AND rw.table_name = k.table_name
WHERE k.sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
GROUP BY 1;

\echo '=== 4c. same, split by the verdict p3_reconcile already recorded ==='
SELECT k.kind, k.verdict,
       count(*) AS claims,
       count(*) FILTER (WHERE rw.sql_hash IS NOT NULL) AS in_rewrite_parse
FROM work.qwen_table_correction k
LEFT JOIN (SELECT DISTINCT sql_hash, table_name FROM work.f2_tables WHERE NOT is_cte) rw
       ON rw.sql_hash = k.sql_hash AND rw.table_name = k.table_name
WHERE k.sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
GROUP BY 1,2 ORDER BY 1, 3 DESC;

\echo '=== 4d. missing-claims: the three-way evidence grid ==='
SELECT k.in_dictionary, k.in_sql_text,
       count(*) AS claims,
       count(*) FILTER (WHERE rw.sql_hash IS NOT NULL) AS corroborated_by_rewrite
FROM work.qwen_table_correction k
LEFT JOIN (SELECT DISTINCT sql_hash, table_name FROM work.f2_tables WHERE NOT is_cte) rw
       ON rw.sql_hash = k.sql_hash AND rw.table_name = k.table_name
WHERE k.kind = 'missing' AND k.sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
GROUP BY 1,2 ORDER BY 3 DESC;

-- ============================================================================
-- 5. DOES IT HELP WHERE IT IS NEEDED? gains crossed with the ORIGINAL quality
-- ============================================================================
\echo '=== 5a. table + edge gains/losses by original parse_quality ==='
WITH per AS (
  SELECT c.sql_hash, c.q_orig,
         (SELECT count(*) FROM work.x2_tables_cmp t
          WHERE t.sql_hash = c.sql_hash AND t.in_rw AND NOT t.in_orig AND t.in_dict) AS tab_gain,
         (SELECT count(*) FROM work.x2_tables_cmp t
          WHERE t.sql_hash = c.sql_hash AND t.in_orig AND NOT t.in_rw AND t.in_dict) AS tab_loss,
         (SELECT count(*) FROM work.x2_joins_cmp j
          WHERE j.sql_hash = c.sql_hash AND j.in_rw AND NOT j.in_orig AND j.both_in_dict) AS edge_gain,
         (SELECT count(*) FROM work.x2_joins_cmp j
          WHERE j.sql_hash = c.sql_hash AND j.in_orig AND NOT j.in_rw AND j.both_in_dict) AS edge_loss
  FROM work.x2_cohort c)
SELECT q_orig, count(*) AS statements,
       sum(tab_gain) AS tables_gained, sum(tab_loss) AS tables_lost,
       sum(edge_gain) AS edges_gained, sum(edge_loss) AS edges_lost,
       count(*) FILTER (WHERE tab_gain > 0) AS stmts_w_table_gain,
       count(*) FILTER (WHERE edge_gain > 0) AS stmts_w_edge_gain
FROM per GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 5b. the same, but only where the rewrite ALSO parsed at least as well ==='
WITH rank_q AS (SELECT * FROM (VALUES ('full',3),('full_lex',3),('fallback',2),('failed',1)) v(q, r)),
per AS (
  SELECT c.sql_hash, c.q_orig,
         (SELECT count(*) FROM work.x2_tables_cmp t
          WHERE t.sql_hash = c.sql_hash AND t.in_rw AND NOT t.in_orig AND t.in_dict) AS tab_gain,
         (SELECT count(*) FROM work.x2_joins_cmp j
          WHERE j.sql_hash = c.sql_hash AND j.in_rw AND NOT j.in_orig AND j.both_in_dict) AS edge_gain
  FROM work.x2_cohort c JOIN rank_q ro ON ro.q = c.q_orig JOIN rank_q rr ON rr.q = c.q_rw
  WHERE rr.r >= ro.r)
SELECT q_orig, count(*) AS statements, sum(tab_gain) AS tables_gained, sum(edge_gain) AS edges_gained
FROM per GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 5c. the risk side: statements where the rewrite parse REGRESSED ==='
WITH rank_q AS (SELECT * FROM (VALUES ('full',3),('full_lex',3),('fallback',2),('failed',1)) v(q, r))
SELECT c.q_orig, c.q_rw, count(*) AS statements,
       sum((SELECT count(*) FROM work.x2_tables_cmp t
            WHERE t.sql_hash = c.sql_hash AND t.in_orig AND NOT t.in_rw AND t.in_dict)) AS dict_tables_lost,
       sum((SELECT count(*) FROM work.x2_joins_cmp j
            WHERE j.sql_hash = c.sql_hash AND j.in_orig AND NOT j.in_rw AND j.both_in_dict)) AS dict_edges_lost
FROM work.x2_cohort c JOIN rank_q ro ON ro.q = c.q_orig JOIN rank_q rr ON rr.q = c.q_rw
WHERE rr.r < ro.r
GROUP BY 1,2 ORDER BY 3 DESC;

-- ============================================================================
-- 6. FIDELITY OF THE REWRITE ITSELF — the model-output risks
--    (the rewrite is model output; if it elides, narrows or invents, it must
--     show up here rather than being absorbed into the gain columns)
-- ============================================================================
\echo '=== 6a. elision / truncation symptoms in the rewrite text ==='
SELECT count(*) AS cohort,
       count(*) FILTER (WHERE btrim(rw) LIKE '%,')                         AS ends_with_comma,
       count(*) FILTER (WHERE rw ~* '--[^\n]*(repeated|truncated|etc\.|omitted|and so on|remaining|similar)')
                                                                           AS elision_comment,
       count(*) FILTER (WHERE rw !~* '\mFROM\M')                           AS no_from_clause,
       count(*) FILTER (WHERE rw ~* '\.\.\.')                              AS ellipsis
FROM (SELECT rewritten_sql AS rw FROM work.clear_sql
      WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort)) s;

\echo '=== 6b. elision symptom vs the parse_quality the rewrite was awarded ==='
WITH s AS (
  SELECT c.sql_hash, g.parse_quality AS q_rw,
         (c.rewritten_sql ~* '--[^\n]*(repeated|truncated|etc\.|omitted|and so on|remaining|similar)'
          OR btrim(c.rewritten_sql) LIKE '%,' OR c.rewritten_sql !~* '\mFROM\M'
          OR c.rewritten_sql ~* '\.\.\.') AS suspect
  FROM work.clear_sql c JOIN work.facts2_run g USING (sql_hash)
  WHERE c.sql_hash IN (SELECT sql_hash FROM work.x2_cohort))
SELECT suspect, q_rw, count(*) FROM s GROUP BY 1,2 ORDER BY 1,3 DESC;

\echo '=== 6c. outer-join fidelity proxy: original (+)/OUTER markers vs rewrite outer keywords ==='
WITH s AS (
  SELECT (c.sql_text ~ '\(\+\)' OR c.sql_text ~* '\mouter\s+join\M') AS orig_has_outer,
         (c.rewritten_sql ~* '\m(left|right|full)\s+(outer\s+)?join\M'
          OR c.rewritten_sql ~ '\(\+\)')                             AS rw_has_outer
  FROM work.clear_sql c WHERE c.sql_hash IN (SELECT sql_hash FROM work.x2_cohort))
SELECT orig_has_outer, rw_has_outer, count(*) FROM s GROUP BY 1,2 ORDER BY 1,2;

\echo '=== 6d. FABRICATION TEST (case-insensitive): are gained edges grounded in the ORIGINAL text? ==='
WITH g AS (
  SELECT j.sql_hash, split_part(j.a,'.',1) ta, split_part(j.a,'.',2) ca,
                     split_part(j.b,'.',1) tb, split_part(j.b,'.',2) cb
  FROM work.x2_joins_cmp j WHERE j.in_rw AND NOT j.in_orig AND j.both_in_dict)
SELECT count(*) AS gained_edges,
       count(*) FILTER (WHERE upper(c.sql_text) ~ ('\m'||g.ta||'\M') AND upper(c.sql_text) ~ ('\m'||g.tb||'\M')
                          AND upper(c.sql_text) ~ ('\m'||g.ca||'\M') AND upper(c.sql_text) ~ ('\m'||g.cb||'\M'))
                                                       AS all_four_names_in_original,
       count(*) FILTER (WHERE NOT (upper(c.sql_text) ~ ('\m'||g.ta||'\M')
                              AND upper(c.sql_text) ~ ('\m'||g.tb||'\M'))) AS table_absent_from_original
FROM g JOIN work.clear_sql c USING (sql_hash);

\echo '=== 6e. the same test on LOST edges (they must all be in the original) ==='
WITH l AS (
  SELECT j.sql_hash, split_part(j.a,'.',1) ta, split_part(j.a,'.',2) ca,
                     split_part(j.b,'.',1) tb, split_part(j.b,'.',2) cb
  FROM work.x2_joins_cmp j WHERE j.in_orig AND NOT j.in_rw AND j.both_in_dict)
SELECT count(*) AS lost_edges,
       count(*) FILTER (WHERE upper(c.sql_text) ~ ('\m'||l.ta||'\M') AND upper(c.sql_text) ~ ('\m'||l.tb||'\M')
                          AND upper(c.sql_text) ~ ('\m'||l.ca||'\M') AND upper(c.sql_text) ~ ('\m'||l.cb||'\M'))
                                                       AS all_four_names_in_original,
       count(*) FILTER (WHERE upper(c.rewritten_sql) ~ ('\m'||l.ta||'\M')
                          AND upper(c.rewritten_sql) ~ ('\m'||l.tb||'\M'))
                                                       AS both_tables_kept_in_rewrite_text
FROM l JOIN work.clear_sql c USING (sql_hash);

\echo '=== 6f. lost / gained dictionary edges decomposed by the REWRITE parse quality ==='
SELECT g.parse_quality AS q_rw,
       count(*) FILTER (WHERE j.in_orig AND NOT j.in_rw) AS lost_dict_edges,
       count(*) FILTER (WHERE j.in_rw AND NOT j.in_orig) AS gained_dict_edges
FROM work.x2_joins_cmp j JOIN work.facts2_run g USING (sql_hash)
WHERE j.both_in_dict AND (j.in_orig <> j.in_rw)
GROUP BY 1 ORDER BY 2 DESC;

-- ============================================================================
-- 7. THE DECISION NUMBER — the DISTINCT relationship set
--    A relationship corpus consumes DEDUPED (table.col = table.col) pairs, not
--    per-statement edges. A lost edge that 400 other statements also carry costs
--    the corpus nothing; a gained edge no statement could see is a new fact.
-- ============================================================================
\echo '=== 7a. distinct relationships over the cohort, original vs rewrite ==='
WITH o AS (SELECT DISTINCT least(from_t||'.'||from_c, to_t||'.'||to_c) a,
                           greatest(from_t||'.'||from_c, to_t||'.'||to_c) b
           FROM work.f_joins WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
             AND from_t IS NOT NULL AND to_t IS NOT NULL),
     r AS (SELECT DISTINCT least(from_t||'.'||from_c, to_t||'.'||to_c) a,
                           greatest(from_t||'.'||from_c, to_t||'.'||to_c) b
           FROM work.f2_joins WHERE sql_hash IN (SELECT sql_hash FROM work.x2_cohort)
             AND from_t IS NOT NULL AND to_t IS NOT NULL),
     u AS (SELECT a,b FROM o UNION SELECT a,b FROM r)
SELECT count(*) FILTER (WHERE o.a IS NOT NULL AND r.a IS NOT NULL) AS in_both,
       count(*) FILTER (WHERE r.a IS NULL)                         AS orig_only,
       count(*) FILTER (WHERE o.a IS NULL)                         AS rewrite_only,
       count(*)                                                     AS union_total,
       count(*) FILTER (WHERE o.a IS NULL
              AND EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.a,'.',1))
              AND EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.b,'.',1)))
                                                                    AS rewrite_only_both_in_dict,
       count(*) FILTER (WHERE r.a IS NULL
              AND EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.a,'.',1))
              AND EXISTS (SELECT 1 FROM work.meta_tables m WHERE m.table_name = split_part(u.b,'.',1)))
                                                                    AS orig_only_both_in_dict
FROM u LEFT JOIN o USING (a,b) LEFT JOIN r USING (a,b);

\echo '=== 7b. the same, restricted to statements where BOTH parses reached full ==='
WITH ok AS (SELECT sql_hash FROM work.x2_cohort WHERE q_orig='full' AND q_rw='full'),
o AS (SELECT DISTINCT least(from_t||'.'||from_c,to_t||'.'||to_c) a, greatest(from_t||'.'||from_c,to_t||'.'||to_c) b
      FROM work.f_joins WHERE sql_hash IN (SELECT sql_hash FROM ok) AND from_t IS NOT NULL AND to_t IS NOT NULL),
r AS (SELECT DISTINCT least(from_t||'.'||from_c,to_t||'.'||to_c) a, greatest(from_t||'.'||from_c,to_t||'.'||to_c) b
      FROM work.f2_joins WHERE sql_hash IN (SELECT sql_hash FROM ok) AND from_t IS NOT NULL AND to_t IS NOT NULL),
u AS (SELECT a,b FROM o UNION SELECT a,b FROM r)
SELECT count(*) FILTER (WHERE o.a IS NOT NULL AND r.a IS NOT NULL) AS in_both,
       count(*) FILTER (WHERE r.a IS NULL) AS orig_only,
       count(*) FILTER (WHERE o.a IS NULL) AS rewrite_only
FROM u LEFT JOIN o USING (a,b) LEFT JOIN r USING (a,b);

\echo '=== 7c. what the rewrite adds against the WHOLE corpus relationship inventory ==='
WITH r AS (SELECT DISTINCT least(from_t||'.'||from_c,to_t||'.'||to_c) a, greatest(from_t||'.'||from_c,to_t||'.'||to_c) b
           FROM work.f2_joins WHERE from_t IS NOT NULL AND to_t IS NOT NULL),
o_all AS (SELECT DISTINCT least(from_t||'.'||from_c,to_t||'.'||to_c) a, greatest(from_t||'.'||from_c,to_t||'.'||to_c) b
          FROM work.f_joins WHERE from_t IS NOT NULL AND to_t IS NOT NULL)
SELECT (SELECT count(*) FROM o_all) AS corpus_distinct_rels_all_26204_statements,
       (SELECT count(*) FROM r)     AS rewrite_distinct_rels,
       (SELECT count(*) FROM r WHERE NOT EXISTS (SELECT 1 FROM o_all o WHERE o.a=r.a AND o.b=r.b))
                                    AS rewrite_adds_vs_whole_corpus;
