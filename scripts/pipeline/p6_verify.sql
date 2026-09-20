-- ============================================================================
-- P6 — the release gate. Every claim in the build report is produced here.
-- Read-only: it writes nothing.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

\echo '=== 1. v2026_10 table inventory (vs v2026_09 where comparable) ==='
WITH n AS (
  SELECT c.relname AS t,
         (SELECT count(*) FROM information_schema.tables i WHERE i.table_schema='v2026_09' AND i.table_name=c.relname) AS in09
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='v2026_10' AND c.relkind='r')
SELECT n.t AS table,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM v2026_10.%I', n.t), false, true, '')))[1]::text::bigint AS v2026_10,
       CASE WHEN n.in09 > 0 THEN
         (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM v2026_09.%I', n.t), false, true, '')))[1]::text::bigint END AS v2026_09
FROM n ORDER BY 1;

\echo '=== 2. schema side must reproduce EXACTLY ==='
SELECT 'tables' AS t, (SELECT count(*) FROM v2026_10.tables) AS built, 29802 AS expected
UNION ALL SELECT 'columns',       (SELECT count(*) FROM v2026_10.columns),       1449501
UNION ALL SELECT 'pkeys',         (SELECT count(*) FROM v2026_10.pkeys),         41407
UNION ALL SELECT 'fkeys',         (SELECT count(*) FROM v2026_10.fkeys),         18565
UNION ALL SELECT 'indexes',       (SELECT count(*) FROM v2026_10.indexes),       130442
UNION ALL SELECT 'relationships', (SELECT count(*) FROM v2026_10.relationships), 14009;

\echo '--- schema side CONTENT equality with v2026_09 (counts alone hid a real defect) ---'
SELECT 'tables' AS t,
       (SELECT count(*) FROM (SELECT name,schema,type,module,remarks,view_text FROM v2026_10.tables
                              EXCEPT SELECT name,schema,type,module,remarks,view_text FROM v2026_09.tables) x) AS only_in_new,
       (SELECT count(*) FROM (SELECT name,schema,type,module,remarks,view_text FROM v2026_09.tables
                              EXCEPT SELECT name,schema,type,module,remarks,view_text FROM v2026_10.tables) x) AS only_in_old
UNION ALL SELECT 'columns',
       (SELECT count(*) FROM (SELECT * FROM v2026_10.columns EXCEPT SELECT * FROM v2026_09.columns) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.columns EXCEPT SELECT * FROM v2026_10.columns) x)
UNION ALL SELECT 'pkeys',
       (SELECT count(*) FROM (SELECT * FROM v2026_10.pkeys EXCEPT SELECT * FROM v2026_09.pkeys) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.pkeys EXCEPT SELECT * FROM v2026_10.pkeys) x)
UNION ALL SELECT 'fkeys',
       (SELECT count(*) FROM (SELECT * FROM v2026_10.fkeys EXCEPT SELECT * FROM v2026_09.fkeys) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.fkeys EXCEPT SELECT * FROM v2026_10.fkeys) x)
UNION ALL SELECT 'indexes',
       (SELECT count(*) FROM (SELECT * FROM v2026_10.indexes EXCEPT SELECT * FROM v2026_09.indexes) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.indexes EXCEPT SELECT * FROM v2026_10.indexes) x)
UNION ALL SELECT 'relationships',
       (SELECT count(*) FROM (SELECT * FROM v2026_10.relationships EXCEPT SELECT * FROM v2026_09.relationships) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.relationships EXCEPT SELECT * FROM v2026_10.relationships) x);

\echo '--- what the TABLE_TYPE filter drops (reported, not decided) ---'
SELECT table_type, count(*) FROM work.meta_tables
WHERE upper(coalesce(table_type,'')) NOT IN ('TABLE','VIEW') GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 3. corpus ==='
SELECT (SELECT count(*) FROM v2026_10.report_queries) AS rows,
       (SELECT count(*) FROM work.clear_sql)          AS l3_rows,
       (SELECT count(DISTINCT id) FROM v2026_10.report_queries) AS distinct_ids,
       (SELECT count(*) FROM v2026_10.report_queries WHERE embedding IS NULL) AS missing_embedding,
       (SELECT count(*) FROM v2026_10.report_queries WHERE description IS NULL) AS missing_description,
       (SELECT count(*) FROM v2026_10.report_queries WHERE intents = '[]') AS enrich_queue;

SELECT source, count(*) FROM v2026_10.report_queries GROUP BY 1 ORDER BY 1;

\echo '--- NO shipped query may become unreachable: every v2026_09 id maps to a live row ---'
SELECT r.source,
       count(*)                                              AS shipped,
       count(x.id)                                           AS reachable_via_l2_map,
       count(*) FILTER (WHERE x.id IS NULL)                  AS UNREACHABLE,
       count(*) FILTER (WHERE r.id = x.id)                   AS id_byte_preserved
FROM   v2026_09.report_queries r
LEFT   JOIN LATERAL (
         SELECT rq.id FROM work.sql_unit u
         JOIN v2026_10.report_queries rq ON rq.id = 'sql:' || u.sql_hash
         WHERE u.unit_id = r.id) x ON true
GROUP  BY 1 ORDER BY 1;

\echo '--- titles: how many shipped titles no longer resolve via byTitle ---'
SELECT r.source, count(DISTINCT r.title) AS shipped_titles,
       count(DISTINCT r.title) FILTER (
         WHERE NOT EXISTS (SELECT 1 FROM v2026_10.report_queries q WHERE q.title = r.title)) AS titles_lost
FROM   v2026_09.report_queries r GROUP BY 1 ORDER BY 1;

\echo '--- the merge recovery: three columns that ship EMPTY in v2026_09 ---'
SELECT 'filters' AS field,
       (SELECT count(*) FROM v2026_09.report_queries WHERE filters NOT IN ('','[]')) AS v2026_09,
       (SELECT count(*) FROM v2026_10.report_queries WHERE filters <> '[]')          AS v2026_10,
       (SELECT count(*) FROM work.enrich_cand WHERE gen=1 AND filters IS NOT NULL)   AS l2_values_recovered
UNION ALL SELECT 'lookup_types',
       (SELECT count(*) FROM v2026_09.report_queries WHERE lookup_types NOT IN ('','[]')),
       (SELECT count(*) FROM v2026_10.report_queries WHERE lookup_types <> '[]'),
       (SELECT count(*) FROM work.enrich_cand WHERE gen=1 AND lookup_types IS NOT NULL)
UNION ALL SELECT 'security_predicate',
       (SELECT count(*) FROM v2026_09.report_queries WHERE security_predicate IS NOT NULL AND security_predicate<>''),
       (SELECT count(*) FROM v2026_10.report_queries WHERE security_predicate IS NOT NULL AND security_predicate<>''),
       (SELECT count(*) FROM work.enrich_cand WHERE gen=1 AND security_predicate IS NOT NULL)
UNION ALL SELECT 'rewritten_sql (clean_sql <> original_sql)',
       (SELECT count(*) FROM v2026_09.report_queries WHERE clean_sql IS DISTINCT FROM original_sql),
       (SELECT count(*) FROM v2026_10.report_queries WHERE clean_sql IS DISTINCT FROM original_sql),
       NULL;

\echo '=== 4. descriptions byte-identical to v2026_09 wherever gen-2 won ==='
SELECT count(*) AS gen2_won,
       count(*) FILTER (WHERE q.description = r.description)            AS byte_identical,
       count(*) FILTER (WHERE q.description IS DISTINCT FROM r.description) AS DIFFERS
FROM   work.clear_sql c
JOIN   v2026_10.report_queries q ON q.id = 'sql:' || c.sql_hash
JOIN   v2026_09.report_queries r ON r.id = c.src_description
WHERE  c.gen_description = 2;

\echo '=== 5. dangling references — every one must be ZERO ==='
SELECT 'table_usages.query_id -> report_queries.id' AS check, count(*) AS dangling,
       (SELECT count(*) FROM v2026_10.table_usages) AS rows
FROM   v2026_10.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.report_queries q WHERE q.id = u.query_id)
UNION ALL
SELECT 'table_usages.table_name -> tables.name', count(*), (SELECT count(*) FROM v2026_10.table_usages)
FROM   v2026_10.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = u.table_name)
UNION ALL
SELECT 'table_predicates.table_name -> tables.name', count(*), (SELECT count(*) FROM v2026_10.table_predicates)
FROM   v2026_10.table_predicates p
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = p.table_name)
UNION ALL
SELECT 'table_join_columns.table_name -> tables.name', count(*), (SELECT count(*) FROM v2026_10.table_join_columns)
FROM   v2026_10.table_join_columns j
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = j.table_name)
UNION ALL
SELECT 'table_grain.table_name -> tables.name', count(*), (SELECT count(*) FROM v2026_10.table_grain)
FROM   v2026_10.table_grain g
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = g.table_name)
UNION ALL
SELECT 'enrich.id -> report_queries.id', count(*), (SELECT count(*) FROM v2026_10.enrich)
FROM   v2026_10.enrich e
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.report_queries q WHERE q.id = e.id)
UNION ALL
SELECT 'vec_multi.qrowid -> report_queries.rid', count(*), (SELECT count(*) FROM v2026_10.report_queries_vec_multi)
FROM   v2026_10.report_queries_vec_multi m
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.report_queries q WHERE q.rid = m.qrowid)
UNION ALL
SELECT 'layout_patterns_vec.prowid -> layout_patterns.rid', count(*), (SELECT count(*) FROM v2026_10.layout_patterns_vec)
FROM   v2026_10.layout_patterns_vec v
WHERE  NOT EXISTS (SELECT 1 FROM v2026_10.layout_patterns p WHERE p.rid = v.prowid);

\echo '--- the SAME check against the SHIPPED artifact, for comparison ---'
SELECT 'v2026_09.table_usages dangling' AS check, count(*) AS dangling,
       count(DISTINCT u.query_id) AS distinct_ids,
       (SELECT count(*) FROM v2026_09.table_usages) AS rows
FROM   v2026_09.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM v2026_09.report_queries q WHERE q.id = u.query_id);

\echo '=== 6. vectors ==='
SELECT (SELECT count(*) FROM v2026_10.report_queries_vec_multi) AS multi_vectors,
       (SELECT count(*) FROM v2026_10.report_queries WHERE embedding IS NOT NULL) AS row_vectors,
       (SELECT count(*) FROM work.embeddings WHERE owner_kind='unit') AS work_unit_vectors,
       (SELECT count(*) FROM v2026_10.layout_patterns_vec) AS layout_vectors;

\echo '--- slots per corpus row ---'
SELECT slots, count(*) AS rows FROM (
  SELECT q.rid, count(m.id) AS slots
  FROM v2026_10.report_queries q LEFT JOIN v2026_10.report_queries_vec_multi m ON m.qrowid=q.rid
  GROUP BY 1) d GROUP BY 1 ORDER BY 1;

\echo '--- slot 0 must equal report_queries.embedding for every row ---'
SELECT count(*) AS rows_checked,
       count(*) FILTER (WHERE q.embedding = e.embedding) AS slot0_matches,
       count(*) FILTER (WHERE q.embedding IS DISTINCT FROM e.embedding) AS MISMATCH
FROM   v2026_10.report_queries q
JOIN   work.embeddings e ON e.owner_kind='unit' AND e.owner_id = substr(q.id, 5) AND e.slot=0;

\echo '=== 7. version stamps written by the BUILD (nothing may be built at boot) ==='
SELECT 'catalog_meta' AS t, key AS k, value AS v FROM v2026_10.catalog_meta
UNION ALL SELECT 'grain_meta',  k, v FROM v2026_10.grain_meta
UNION ALL SELECT 'usage_meta',  k, v FROM v2026_10.usage_meta
UNION ALL SELECT 'pred_meta',   k, v FROM v2026_10.pred_meta
UNION ALL SELECT 'layout_meta', k, v FROM v2026_10.layout_meta
UNION ALL SELECT 'facts_meta',  k, v FROM v2026_10.facts_meta
ORDER BY 1, 2;

\echo '--- registry stamps must match the code constants that gate a boot rebuild ---'
SELECT 'grain' AS registry, (SELECT v FROM v2026_10.grain_meta WHERE k='version') AS stamped, '4' AS code_constant
UNION ALL SELECT 'usage',      (SELECT v FROM v2026_10.usage_meta WHERE k='version'), '1'
UNION ALL SELECT 'predicates', (SELECT v FROM v2026_10.pred_meta  WHERE k='version'), '1'
UNION ALL SELECT 'layout jsonl_hash', (SELECT v FROM v2026_10.layout_meta WHERE k='jsonl_hash'),
                                      (SELECT v FROM v2026_09.layout_meta WHERE k='jsonl_hash');

\echo '=== 8. every table PgMeta.verify() addresses exists in the version schema ==='
WITH want(t) AS (VALUES
  ('tables'),('columns'),('pkeys'),('fkeys'),('indexes'),('relationships'),('catalog_meta'),
  ('report_queries'),('report_queries_vec_multi'),
  ('table_grain'),('grain_meta'),('table_usages'),('usage_meta'),('table_predicates'),('pred_meta'),
  ('table_join_columns'),('layout_patterns'),('layout_patterns_vec'),('layout_meta'),
  ('flexfields'),('adf_extensions'),('enrich'),('col_vec'),('table_rules'),('facts_meta'))
SELECT w.t AS required_table,
       EXISTS (SELECT 1 FROM information_schema.tables i
               WHERE i.table_schema='v2026_10' AND i.table_name=w.t) AS present
FROM   want w ORDER BY 2, 1;

\echo '=== 9. indexes on the release schema ==='
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='v2026_10' ORDER BY 1, 2;

\echo '=== 10. ownership: every object must belong to fusion_dev ==='
SELECT pg_get_userbyid(c.relowner) AS owner, count(*) AS objects
FROM   pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE  n.nspname IN ('work','v2026_10') GROUP BY 1 ORDER BY 1;
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE n.nspname IN ('work','v2026_10');
