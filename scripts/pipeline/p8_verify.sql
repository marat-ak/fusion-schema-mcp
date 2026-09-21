-- ============================================================================
-- P8 — VERIFICATION ONLY. The single file in this pipeline that reads v2026_09.
--
-- The shipped release is NOT an input to the build. It used to be: the previous
-- pass read generation-2 back out of v2026_09.report_queries, which made
-- "rebuilt from raw" a fiction — the release was reconstructing itself from its
-- own lossy projection (4 of the model's 23 fields).
--
-- So this file WRITES NOTHING. It compares, so that "the rebuild did not lose
-- anything it should have kept" is a measurement rather than a claim. Every other
-- file in scripts/pipeline/ can be grepped for `v2026_09` and comes back empty;
-- that is the property this split exists to make checkable.
--
--   wsl -d CloudBeaver -u root -e bash -lc 'docker cp p8_verify.sql stack-db:/tmp/ &&
--     docker exec stack-db psql -U postgres -d fusion_dev -f /tmp/p8_verify.sql'
-- ============================================================================
\set ON_ERROR_STOP on

\echo '=== 1. do the shipped ids still resolve to a live L3 row? ==='
SELECT r.source,
       count(*)                                   AS shipped,
       count(u.unit_id)                           AS maps_to_l2,
       count(c.sql_hash)                          AS maps_to_l3,
       count(*) FILTER (WHERE c.sql_hash IS NULL) AS unreachable
FROM   v2026_09.report_queries r
LEFT   JOIN work.sql_unit  u ON u.unit_id  = r.id
LEFT   JOIN work.clear_sql c ON c.sql_hash = u.sql_hash
GROUP  BY 1 ORDER BY 1;

\echo '=== 2. bip ids are content hashes: sql:<hash> must survive verbatim (expect 6389/6389) ==='
SELECT count(*)                                           AS bip_shipped,
       count(*) FILTER (WHERE r.id = 'sql:' || u.sql_hash) AS id_preserved
FROM   v2026_09.report_queries r JOIN work.sql_unit u ON u.unit_id = r.id
WHERE  r.source = 'bip-report';

\echo '=== 3. descriptions: shipped vs freshly loaded, where the SAME unit won ==='
-- Same unit_id on both sides => the same JSONL record => the text must be identical —
-- for the 2026-08 GENERATION (qwen_record.run_id IS NULL). A statement re-enriched by
-- the gap or recheck run keeps its unit id but carries new text: counted apart, and
-- expected to differ. A difference in the August row means the release was edited
-- after import, or the load is wrong.
SELECT CASE WHEN q.run_id IS NULL THEN 'august generation' ELSE 're-enriched (' || split_part(q.run_id, '-', 1) || ')' END AS generation,
       count(*)                                                  AS comparable_rows,
       count(*) FILTER (WHERE c.description = r.description)     AS byte_identical,
       count(*) FILTER (WHERE c.description IS DISTINCT FROM r.description) AS differs
FROM   work.clear_sql c
JOIN   work.qwen_record q ON q.unit_id = c.src_enrich_unit
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  c.description IS NOT NULL AND r.description IS NOT NULL
GROUP  BY 1 ORDER BY 1;

\echo '=== 3b. sample of any differing descriptions ==='
SELECT c.src_enrich_unit, left(c.description, 90) AS rebuilt, left(r.description, 90) AS shipped
FROM   work.clear_sql c
JOIN   work.qwen_record q ON q.unit_id = c.src_enrich_unit AND q.run_id IS NULL
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  c.description IS NOT NULL AND r.description IS NOT NULL
  AND  c.description IS DISTINCT FROM r.description
LIMIT  10;

\echo '=== 4. descriptions where a DIFFERENT unit won the hash (collision resolution) ==='
SELECT count(*)                                                  AS rows_where_winner_differs,
       count(*) FILTER (WHERE c.description = r.description)     AS same_text_anyway
FROM   work.clear_sql c
JOIN   work.sql_unit u ON u.sql_hash = c.sql_hash
JOIN   v2026_09.report_queries r ON r.id = u.unit_id
WHERE  c.src_enrich_unit IS NOT NULL AND u.unit_id <> c.src_enrich_unit
  AND  c.description IS NOT NULL AND r.description IS NOT NULL;

\echo '=== 5. intents + rewritten SQL, same-unit comparison ==='
SELECT count(*)                                                        AS comparable,
       count(*) FILTER (WHERE c.intents = work.je(r.intents::jsonb))   AS intents_identical
FROM   work.clear_sql c
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  c.intents IS NOT NULL AND r.intents IS NOT NULL AND r.intents <> '';

SELECT count(*)                                              AS shipped_rewrites,
       count(*) FILTER (WHERE c.rewritten_sql = r.clean_sql) AS identical
FROM   work.clear_sql c
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  c.rewritten_sql IS NOT NULL AND r.clean_sql IS NOT NULL;

\echo '=== 6. what the release ships that this build does NOT (the honest loss list) ==='
SELECT 'report_queries rows'  AS item, (SELECT count(*) FROM v2026_09.report_queries)                AS v2026_09,
       (SELECT count(*) FROM work.clear_sql WHERE src_enrich_unit IS NOT NULL)                       AS work_rebuilt
UNION ALL SELECT 'lookup_types non-empty (work: statements with a LOOKUP_TYPE predicate)',
       (SELECT count(*) FROM v2026_09.report_queries WHERE lookup_types NOT IN ('', '[]')),
       (SELECT count(DISTINCT sql_hash) FROM work.f_predicates WHERE column_name = 'LOOKUP_TYPE' AND op IN ('EQ','IN'))
UNION ALL SELECT 'security_predicate non-empty',
       (SELECT count(*) FROM v2026_09.report_queries WHERE coalesce(security_predicate,'') <> ''), 0
UNION ALL SELECT 'reports non-empty (MIXED shape: 176 bip objects + 11,279 otbi strings)',
       (SELECT count(*) FROM v2026_09.report_queries WHERE coalesce(reports,'') NOT IN ('', '[]')),
       (SELECT count(*) FROM work.clear_sql WHERE reports <> '[]'::jsonb
                                               OR l2_titles <> '[]'::jsonb)
UNION ALL SELECT 'relationships total',
       (SELECT count(*) FROM v2026_09.relationships),
       (SELECT count(*) FROM work.relationships)
UNION ALL SELECT 'relationships source=mined',
       (SELECT count(*) FROM v2026_09.relationships WHERE source = 'mined'),
       (SELECT count(*) FROM work.relationships WHERE source = 'mined')
UNION ALL SELECT 'relationships source=otbi (crawl, excluded)',
       (SELECT count(*) FROM v2026_09.relationships WHERE source = 'otbi'), 0;

\echo '=== 7. what this build has that the release does NOT ==='
SELECT 'statements (L3)'        AS item, (SELECT count(*) FROM work.clear_sql)      AS work_rebuilt,
       (SELECT count(*) FROM v2026_09.report_queries)                               AS v2026_09
UNION ALL SELECT 'parsed predicates', (SELECT count(*) FROM work.f_predicates), 0
UNION ALL SELECT 'parsed joins',      (SELECT count(*) FROM work.f_joins), 0
UNION ALL SELECT 'payloads kept whole (23 fields)', (SELECT count(*) FROM work.qwen_record WHERE payload IS NOT NULL), 0
UNION ALL SELECT 'rows with outputGrain',   (SELECT count(output_grain) FROM work.clear_sql), 0
UNION ALL SELECT 'rows with security',      (SELECT count(security) FROM work.clear_sql), 0
UNION ALL SELECT 'rows with params',        (SELECT count(params) FROM work.clear_sql), 0
UNION ALL SELECT 'table corrections loaded + adjudicated', (SELECT count(*) FROM work.qwen_table_correction), 0
UNION ALL SELECT 'reconciled table facts (r_tables)', (SELECT count(*) FROM work.r_tables), 0
UNION ALL SELECT '  of which model_added',   (SELECT count(*) FROM work.r_tables WHERE provenance='model_added'), 0
UNION ALL SELECT '  of which model_disputed (kept)', (SELECT count(*) FROM work.r_tables WHERE provenance='model_disputed'), 0
UNION ALL SELECT 'crawl path refs (unit_ref)', (SELECT count(*) FROM work.unit_ref), 0;

\echo '=== 8. path references: the crawl beats what the release shipped ==='
SELECT (SELECT count(*) FROM v2026_09.report_queries
        WHERE source='bip-report' AND coalesce(reports,'') NOT IN ('','[]')) AS v2026_09_bip_rows_with_paths,
       (SELECT count(*) FROM work.clear_sql
        WHERE source='bip-report' AND reports <> '[]'::jsonb)                AS work_bip_hashes_with_paths,
       (SELECT count(*) FROM work.unit_ref)                                  AS work_path_ref_rows,
       (SELECT count(DISTINCT path) FROM work.unit_ref)                      AS distinct_paths;

\echo '=== 9. otbi: l2_titles must reproduce what v2026_09 put in `reports` ==='
SELECT count(*)                                                       AS comparable,
       count(*) FILTER (WHERE c.l2_titles @> r.reports::jsonb)        AS titles_cover_shipped_reports,
       count(*) FILTER (WHERE NOT (c.l2_titles @> r.reports::jsonb))  AS shipped_has_a_title_we_lack
FROM   work.clear_sql c
JOIN   work.sql_unit u ON u.unit_id = c.primary_unit_id
JOIN   v2026_09.report_queries r ON r.id = u.unit_id
WHERE  c.source = 'otbi' AND coalesce(r.reports,'') NOT IN ('', '[]');
