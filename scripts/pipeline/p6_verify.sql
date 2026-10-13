-- ============================================================================
-- P6 — the release gate. Every claim in the build report is produced here.
-- Read-only: it writes nothing.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
-- Runs in the BUILD database (work + the v2026_09 baseline present: every section) and, after
-- p9_release.sh, in the SERVED database (release-only sections; the rest are skipped, not faked).
SELECT (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'work'))::int     AS has_work,
       (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'v2026_09'))::int AS has_base,
       (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'work') AND
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'v2026_09'))::int AS has_both,
       current_database() AS db \gset
\echo '=== p6 release gate: {{V}} in' :db '-- work present:' :has_work ' baseline v2026_09 present:' :has_base

\echo '=== 1. {{V}} table inventory (vs v2026_09 where comparable) ==='
WITH n AS (
  SELECT c.relname AS t,
         (SELECT count(*) FROM information_schema.tables i WHERE i.table_schema='v2026_09' AND i.table_name=c.relname) AS in09
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='{{V}}' AND c.relkind='r')
SELECT n.t AS table,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM {{V}}.%I', n.t), false, true, '')))[1]::text::bigint AS {{V}},
       CASE WHEN n.in09 > 0 THEN
         (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM v2026_09.%I', n.t), false, true, '')))[1]::text::bigint END AS v2026_09
FROM n ORDER BY 1;

\echo '=== 2. schema side must reproduce EXACTLY ==='
SELECT 'tables' AS t, (SELECT count(*) FROM {{V}}.tables) AS built, 29802 AS expected
UNION ALL SELECT 'columns',       (SELECT count(*) FROM {{V}}.columns),       1449501
UNION ALL SELECT 'pkeys',         (SELECT count(*) FROM {{V}}.pkeys),         41407
UNION ALL SELECT 'fkeys',         (SELECT count(*) FROM {{V}}.fkeys),         18565
UNION ALL SELECT 'indexes',       (SELECT count(*) FROM {{V}}.indexes),       130442
UNION ALL SELECT 'relationships', (SELECT count(*) FROM {{V}}.relationships), 39571;  -- 30,203 mined (parse with correlated / inline-view / semi-join edges, 2026-09-30; 18,687 before) + 9,368 declared

\if :has_base
\echo '--- schema side CONTENT equality with v2026_09 (counts alone hid a real defect) ---'
SELECT 'tables' AS t,
       (SELECT count(*) FROM (SELECT name,schema,type,module,remarks,view_text FROM {{V}}.tables
                              EXCEPT SELECT name,schema,type,module,remarks,view_text FROM v2026_09.tables) x) AS only_in_new,
       (SELECT count(*) FROM (SELECT name,schema,type,module,remarks,view_text FROM v2026_09.tables
                              EXCEPT SELECT name,schema,type,module,remarks,view_text FROM {{V}}.tables) x) AS only_in_old
UNION ALL SELECT 'columns',
       (SELECT count(*) FROM (SELECT * FROM {{V}}.columns EXCEPT SELECT * FROM v2026_09.columns) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.columns EXCEPT SELECT * FROM {{V}}.columns) x)
UNION ALL SELECT 'pkeys',
       (SELECT count(*) FROM (SELECT * FROM {{V}}.pkeys EXCEPT SELECT * FROM v2026_09.pkeys) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.pkeys EXCEPT SELECT * FROM {{V}}.pkeys) x)
UNION ALL SELECT 'fkeys',
       (SELECT count(*) FROM (SELECT * FROM {{V}}.fkeys EXCEPT SELECT * FROM v2026_09.fkeys) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.fkeys EXCEPT SELECT * FROM {{V}}.fkeys) x)
UNION ALL SELECT 'indexes',
       (SELECT count(*) FROM (SELECT * FROM {{V}}.indexes EXCEPT SELECT * FROM v2026_09.indexes) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.indexes EXCEPT SELECT * FROM {{V}}.indexes) x)
UNION ALL SELECT 'relationships',
       (SELECT count(*) FROM (SELECT * FROM {{V}}.relationships EXCEPT SELECT * FROM v2026_09.relationships) x),
       (SELECT count(*) FROM (SELECT * FROM v2026_09.relationships EXCEPT SELECT * FROM {{V}}.relationships) x);
\endif

\if :has_work
\echo '--- what the TABLE_TYPE filter drops (reported, not decided) ---'
SELECT table_type, count(*) FROM work.meta_tables
WHERE upper(coalesce(table_type,'')) NOT IN ('TABLE','VIEW') GROUP BY 1 ORDER BY 2 DESC;
\endif

\echo '=== 3. corpus ==='
\if :has_work
SELECT (SELECT count(*) FROM {{V}}.report_queries) AS rows,
       (SELECT count(*) FROM work.clear_sql)          AS l3_rows,
       (SELECT count(*) FROM work.clear_sql WHERE description ~ '\S') AS l3_described,
       (SELECT count(*) FROM {{V}}.report_queries WHERE id NOT LIKE 'sql:%') AS non_sql_ids,
       (SELECT count(DISTINCT id) FROM {{V}}.report_queries) AS distinct_ids,
       (SELECT count(*) FROM {{V}}.report_queries WHERE embedding IS NULL) AS missing_embedding,
       (SELECT count(*) FROM {{V}}.report_queries WHERE description IS NULL) AS missing_description,
       (SELECT count(*) FROM {{V}}.report_queries WHERE intents = '[]') AS enrich_queue;
\else
SELECT (SELECT count(*) FROM {{V}}.report_queries) AS rows,
       (SELECT count(*) FROM {{V}}.report_queries WHERE id NOT LIKE 'sql:%') AS non_sql_ids,
       (SELECT count(DISTINCT id) FROM {{V}}.report_queries) AS distinct_ids,
       (SELECT count(*) FROM {{V}}.report_queries WHERE embedding IS NULL) AS missing_embedding,
       (SELECT count(*) FROM {{V}}.report_queries WHERE description IS NULL) AS missing_description,
       (SELECT count(*) FROM {{V}}.report_queries WHERE intents = '[]') AS enrich_queue;
\endif

SELECT source, count(*) FROM {{V}}.report_queries GROUP BY 1 ORDER BY 1;

\if :has_both
\echo '--- NO shipped query may become unreachable: every v2026_09 id maps to a live row ---'
SELECT r.source,
       count(*)                                              AS shipped,
       count(x.id)                                           AS reachable_via_l2_map,
       count(*) FILTER (WHERE x.id IS NULL)                  AS UNREACHABLE,
       count(*) FILTER (WHERE r.id = x.id)                   AS id_byte_preserved
FROM   v2026_09.report_queries r
LEFT   JOIN LATERAL (
         SELECT rq.id FROM work.sql_unit u
         JOIN {{V}}.report_queries rq ON rq.id = 'sql:' || u.sql_hash
         WHERE u.unit_id = r.id) x ON true
GROUP  BY 1 ORDER BY 1;
\endif

\if :has_base
\echo '--- titles: how many shipped titles no longer resolve via byTitle ---'
SELECT r.source, count(DISTINCT r.title) AS shipped_titles,
       count(DISTINCT r.title) FILTER (
         WHERE NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.title = r.title)) AS titles_lost
FROM   v2026_09.report_queries r GROUP BY 1 ORDER BY 1;
\endif

\if :has_base
\echo '--- the parse-derived columns: coverage vs v2026_09 ---'
SELECT 'tables_used' AS field,
       (SELECT count(*) FROM v2026_09.report_queries WHERE tables_used NOT IN ('','[]')) AS v2026_09,
       (SELECT count(*) FROM {{V}}.report_queries WHERE tables_used <> '[]')          AS {{V}}
UNION ALL SELECT 'joins',
       (SELECT count(*) FROM v2026_09.report_queries WHERE joins NOT IN ('','[]')),
       (SELECT count(*) FROM {{V}}.report_queries WHERE joins <> '[]')
UNION ALL SELECT 'filters',
       (SELECT count(*) FROM v2026_09.report_queries WHERE filters NOT IN ('','[]')),
       (SELECT count(*) FROM {{V}}.report_queries WHERE filters <> '[]')
UNION ALL SELECT 'lookup_types',
       (SELECT count(*) FROM v2026_09.report_queries WHERE lookup_types NOT IN ('','[]')),
       (SELECT count(*) FROM {{V}}.report_queries WHERE lookup_types <> '[]')
UNION ALL SELECT 'security_predicate (not decided: NULL)',
       (SELECT count(*) FROM v2026_09.report_queries WHERE coalesce(security_predicate,'') <> ''),
       (SELECT count(*) FROM {{V}}.report_queries WHERE coalesce(security_predicate,'') <> '')
UNION ALL SELECT 'reports',
       (SELECT count(*) FROM v2026_09.report_queries WHERE coalesce(reports,'') NOT IN ('','[]')),
       (SELECT count(*) FROM {{V}}.report_queries WHERE reports <> '[]')
UNION ALL SELECT 'mechanics',
       (SELECT count(*) FROM v2026_09.report_queries WHERE coalesce(mechanics,'') <> ''),
       (SELECT count(*) FROM {{V}}.report_queries WHERE coalesce(mechanics,'') <> '')
UNION ALL SELECT 'low_confidence = 1',
       (SELECT count(*) FROM v2026_09.report_queries WHERE low_confidence = 1),
       (SELECT count(*) FROM {{V}}.report_queries WHERE low_confidence = 1)
UNION ALL SELECT 'rewritten_sql (clean_sql <> original_sql)',
       (SELECT count(*) FROM v2026_09.report_queries WHERE clean_sql IS DISTINCT FROM original_sql),
       (SELECT count(*) FROM {{V}}.report_queries WHERE clean_sql IS DISTINCT FROM original_sql);
\endif

\echo '--- reports: one object shape for every source (ReportRef[]), the 50 cap ---'
SELECT source, count(*) AS rows, count(*) FILTER (WHERE reports <> '[]') AS with_refs,
       max(jsonb_array_length(reports::jsonb)) AS max_refs,
       count(*) FILTER (WHERE jsonb_array_length(reports::jsonb) = 50) AS at_cap,
       count(*) FILTER (WHERE jsonb_typeof((reports::jsonb)->0) NOT IN ('object')) AS non_object_refs
FROM   {{V}}.report_queries WHERE reports <> '[]' GROUP BY 1 ORDER BY 1;

\if :has_both
\echo '=== 4. text byte-identical to v2026_09 on every shared August-generation statement ==='
-- old id -> sql_hash through work.sql_unit; the winning record must be the 2026-08 one
-- (run_id IS NULL) for the texts to be the same generation. Re-enriched statements
-- (gap / recheck winners) are counted apart: they are EXPECTED to differ.
WITH m AS (
  SELECT q.id, q.description, q.mechanics, q.intents, r.description AS d09, r.mechanics AS m09, r.intents AS i09,
         (rec.run_id IS NULL) AS august
  FROM   {{V}}.report_queries q
  JOIN   work.clear_sql c ON c.sql_hash = substr(q.id, 5)
  JOIN   work.qwen_record rec ON rec.unit_id = c.src_enrich_unit
  JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
  WHERE  r.description IS NOT NULL)
SELECT CASE WHEN august THEN 'august winner (must be identical)' ELSE 're-enriched winner (expected to differ)' END AS generation,
       count(*) AS shared,
       count(*) FILTER (WHERE description = d09)                          AS description_identical,
       count(*) FILTER (WHERE description IS DISTINCT FROM d09)           AS description_DIFFERS,
       count(*) FILTER (WHERE mechanics IS NOT DISTINCT FROM m09)         AS mechanics_identical,
       count(*) FILTER (WHERE intents IS NOT DISTINCT FROM i09)           AS intents_identical
FROM   m GROUP BY 1 ORDER BY 1;

\echo '--- sample of any August-winner description that differs ---'
SELECT q.id, left(q.description, 80) AS built, left(r.description, 80) AS shipped
FROM   {{V}}.report_queries q
JOIN   work.clear_sql c ON c.sql_hash = substr(q.id, 5)
JOIN   work.qwen_record rec ON rec.unit_id = c.src_enrich_unit AND rec.run_id IS NULL
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  q.description IS DISTINCT FROM r.description LIMIT 5;

\echo '--- sample of any August-winner mechanics that differs ---'
SELECT q.id, left(q.mechanics, 100) AS built, left(r.mechanics, 100) AS shipped
FROM   {{V}}.report_queries q
JOIN   work.clear_sql c ON c.sql_hash = substr(q.id, 5)
JOIN   work.qwen_record rec ON rec.unit_id = c.src_enrich_unit AND rec.run_id IS NULL
JOIN   v2026_09.report_queries r ON r.id = c.src_enrich_unit
WHERE  q.mechanics IS DISTINCT FROM r.mechanics LIMIT 5;
\endif

\echo '=== 5. dangling references — every one must be ZERO ==='
SELECT 'table_usages.query_id -> report_queries.id' AS check, count(*) AS dangling,
       (SELECT count(*) FROM {{V}}.table_usages) AS rows
FROM   {{V}}.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.id = u.query_id)
UNION ALL
SELECT 'table_usages.table_name -> tables.name', count(*), (SELECT count(*) FROM {{V}}.table_usages)
FROM   {{V}}.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = u.table_name)
UNION ALL
SELECT 'table_predicates.table_name -> tables.name', count(*), (SELECT count(*) FROM {{V}}.table_predicates)
FROM   {{V}}.table_predicates p
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = p.table_name)
UNION ALL
SELECT 'table_join_columns.table_name -> tables.name', count(*), (SELECT count(*) FROM {{V}}.table_join_columns)
FROM   {{V}}.table_join_columns j
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = j.table_name)
UNION ALL
SELECT 'table_grain.table_name -> tables.name', count(*), (SELECT count(*) FROM {{V}}.table_grain)
FROM   {{V}}.table_grain g
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = g.table_name)
UNION ALL
SELECT 'plsql_api_tables.table_name -> tables.name', count(*), (SELECT count(*) FROM {{V}}.plsql_api_tables)
FROM   {{V}}.plsql_api_tables p
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = p.table_name)
UNION ALL
SELECT 'plsql_api_tables -> plsql_api', count(*), (SELECT count(*) FROM {{V}}.plsql_api_tables)
FROM   {{V}}.plsql_api_tables p
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.plsql_api a WHERE a.package_name = p.package_name AND a.function_name = p.function_name)
UNION ALL
SELECT 'plsql_api.samples[].sql_hash -> report_queries.id', count(*),
       (SELECT count(*) FROM {{V}}.plsql_api a, jsonb_array_elements(a.samples::jsonb) s)
FROM   {{V}}.plsql_api a, jsonb_array_elements(a.samples::jsonb) s
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.id = 'sql:' || (s->>'sql_hash'))
UNION ALL
SELECT 'enrich.id -> report_queries.id', count(*), (SELECT count(*) FROM {{V}}.enrich)
FROM   {{V}}.enrich e
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.id = e.id)
UNION ALL
SELECT 'vec_multi.qrowid -> report_queries.rid', count(*), (SELECT count(*) FROM {{V}}.report_queries_vec_multi)
FROM   {{V}}.report_queries_vec_multi m
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.rid = m.qrowid)
UNION ALL
SELECT 'layout_patterns_vec.prowid -> layout_patterns.rid', count(*), (SELECT count(*) FROM {{V}}.layout_patterns_vec)
FROM   {{V}}.layout_patterns_vec v
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.layout_patterns p WHERE p.rid = v.prowid);

\if :has_base
\echo '--- the SAME check against the SHIPPED artifact, for comparison ---'
SELECT 'v2026_09.table_usages dangling' AS check, count(*) AS dangling,
       count(DISTINCT u.query_id) AS distinct_ids,
       (SELECT count(*) FROM v2026_09.table_usages) AS rows
FROM   v2026_09.table_usages u
WHERE  NOT EXISTS (SELECT 1 FROM v2026_09.report_queries q WHERE q.id = u.query_id);
\endif

\echo '=== 6. vectors (multi must equal the work unit vectors; + the layout vectors) ==='
\if :has_work
SELECT (SELECT count(*) FROM {{V}}.report_queries_vec_multi) AS multi_vectors,
       (SELECT count(*) FROM {{V}}.report_queries WHERE embedding IS NOT NULL) AS row_vectors,
       (SELECT count(*) FROM work.embeddings WHERE owner_kind='unit') AS work_unit_vectors,
       (SELECT count(*) FROM {{V}}.layout_patterns_vec) AS layout_vectors,
       (SELECT count(*) FROM {{V}}.report_queries_vec_multi) + (SELECT count(*) FROM {{V}}.layout_patterns_vec) AS all_vectors;
\else
SELECT (SELECT count(*) FROM {{V}}.report_queries_vec_multi) AS multi_vectors,
       (SELECT count(*) FROM {{V}}.report_queries WHERE embedding IS NOT NULL) AS row_vectors,
       (SELECT count(*) FROM {{V}}.layout_patterns_vec) AS layout_vectors,
       (SELECT count(*) FROM {{V}}.report_queries_vec_multi) + (SELECT count(*) FROM {{V}}.layout_patterns_vec) AS all_vectors;
\endif

\echo '--- slots per corpus row ---'
SELECT slots, count(*) AS rows FROM (
  SELECT q.rid, count(m.id) AS slots
  FROM {{V}}.report_queries q LEFT JOIN {{V}}.report_queries_vec_multi m ON m.qrowid=q.rid
  GROUP BY 1) d GROUP BY 1 ORDER BY 1;

\if :has_work
\echo '--- slot 0 must equal report_queries.embedding for every row ---'
SELECT count(*) AS rows_checked,
       count(*) FILTER (WHERE q.embedding = e.embedding) AS slot0_matches,
       count(*) FILTER (WHERE q.embedding IS DISTINCT FROM e.embedding) AS MISMATCH
FROM   {{V}}.report_queries q
JOIN   work.embeddings e ON e.owner_kind='unit' AND e.owner_id = substr(q.id, 5) AND e.slot=0;
\endif

\echo '=== 6b. OTBI presentation catalog + unit_titles (ddl_version 4) ==='
SELECT (SELECT count(*) FROM {{V}}.otbi_subject_area) AS subject_areas,
       (SELECT count(*) FROM {{V}}.otbi_folder)       AS folders,
       (SELECT count(*) FROM {{V}}.otbi_folder WHERE kind = 'fact') AS fact_folders,
       (SELECT count(*) FROM {{V}}.otbi_column)       AS columns,
       (SELECT count(*) FROM {{V}}.otbi_column WHERE description IS NOT NULL) AS columns_described,
       (SELECT count(*) FROM {{V}}.otbi_column WHERE kind = 'measure') AS measures,
       (SELECT count(*) FROM {{V}}.otbi_vec)          AS otbi_vectors,
       (SELECT count(*) FROM {{V}}.unit_titles)       AS unit_titles;
\echo '--- OTBI dangling — every one must be ZERO ---'
SELECT 'otbi_column -> otbi_folder' AS ref, count(*) AS dangling
FROM   {{V}}.otbi_column c WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_folder f WHERE f.subject_area = c.subject_area AND f.name = c.folder)
UNION ALL SELECT 'otbi_folder -> otbi_subject_area', count(*)
FROM   {{V}}.otbi_folder f WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_subject_area s WHERE s.name = f.subject_area)
UNION ALL SELECT 'otbi_column.text_hash -> otbi_vec', count(*)
FROM   {{V}}.otbi_column c WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_vec v WHERE v.text_hash = c.text_hash)
UNION ALL SELECT 'otbi_folder.text_hash -> otbi_vec', count(*)
FROM   {{V}}.otbi_folder f WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_vec v WHERE v.text_hash = f.text_hash)
UNION ALL SELECT 'otbi_folder.unit_id -> unit_titles/report_queries', count(*)
FROM   {{V}}.otbi_folder f WHERE f.unit_id IS NOT NULL
  AND  NOT EXISTS (SELECT 1 FROM {{V}}.unit_titles u JOIN {{V}}.report_queries q ON q.id = u.id WHERE u.title = f.subject_area || '.' || f.name)
UNION ALL SELECT 'unit_titles.id -> report_queries.id', count(*)
FROM   {{V}}.unit_titles u WHERE NOT EXISTS (SELECT 1 FROM {{V}}.report_queries q WHERE q.id = u.id);
\echo '--- ddl_version 9: the VO hop (otbi_vo), the exposure index (otbi_column_ref), area -> duty codes (otbi_area_duty) ---'
SELECT (SELECT count(*) FROM {{V}}.otbi_vo)          AS vos,
       (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_vo) AS vo_areas,
       (SELECT count(*) FROM {{V}}.otbi_column_ref)  AS column_refs,
       (SELECT count(DISTINCT table_name) FROM {{V}}.otbi_column_ref) AS exposed_tables,
       (SELECT count(*) FROM {{V}}.otbi_column_ref WHERE via_expression = 1) AS refs_via_expression,
       (SELECT count(*) FROM {{V}}.otbi_area_duty)   AS area_duty_pairs,
       (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'name')  AS areas_by_name,
       (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'alias') AS areas_by_alias,
       (SELECT count(*) FROM jsonb_object_keys((SELECT v::jsonb FROM {{V}}.otbi_meta WHERE k = 'area_duty_unmapped'))) AS areas_unmapped,
       (SELECT count(*) FROM {{V}}.otbi_area_job)    AS area_job_pairs,
       (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_job) AS areas_with_jobs,
       (SELECT count(DISTINCT job_code) FROM {{V}}.otbi_area_job) AS job_codes;
\echo '--- GATE: the exposure index is exactly the exploded db_refs; every area is mapped XOR listed unmapped; no admin-class code; the stamps exist — the release FAILS on any line ---'
DO $$
DECLARE bad_otbi text;
BEGIN
  SELECT string_agg(m, '; ') INTO bad_otbi FROM (
    SELECT 'otbi_column_ref holds ' || r.n || ' rows, the exploded otbi_column.db_refs ' || x.n AS m
    FROM  (SELECT count(*) n FROM {{V}}.otbi_column_ref) r,
          (SELECT count(*) n FROM (SELECT DISTINCT c.subject_area, c.folder, c.name, e.t, e.c
                                   FROM {{V}}.otbi_column c
                                   CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(c.db_refs::jsonb) = 'array' THEN c.db_refs::jsonb ELSE '[]'::jsonb END) AS e(t text, c text)
                                   WHERE e.t IS NOT NULL AND e.c IS NOT NULL) d) x
    WHERE  r.n <> x.n
    UNION ALL SELECT 'otbi_column_ref -> otbi_column: ' || count(*) || ' row(s)' FROM {{V}}.otbi_column_ref r
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_column c WHERE c.subject_area = r.subject_area AND c.folder = r.folder AND c.name = r.column_name)
              HAVING count(*) > 0
    UNION ALL SELECT 'otbi_column_ref.folder_kind differs from otbi_folder.kind: ' || count(*) || ' row(s)' FROM {{V}}.otbi_column_ref r
              JOIN {{V}}.otbi_folder f ON f.subject_area = r.subject_area AND f.name = r.folder WHERE f.kind IS DISTINCT FROM r.folder_kind
              HAVING count(*) > 0
    UNION ALL SELECT 'otbi_vo -> otbi_folder: ' || count(*) || ' row(s)' FROM {{V}}.otbi_vo v
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_folder f WHERE f.subject_area = v.subject_area AND f.name = v.folder)
              HAVING count(*) > 0
    UNION ALL SELECT 'otbi_area_duty -> otbi_subject_area: ' || d.subject_area FROM {{V}}.otbi_area_duty d
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_subject_area s WHERE s.name = d.subject_area)
    UNION ALL SELECT 'otbi_area_duty.matched_by ' || coalesce(matched_by, 'NULL') || ' is not name | alias' FROM {{V}}.otbi_area_duty
              WHERE matched_by IS NULL OR matched_by NOT IN ('name', 'alias')
    UNION ALL SELECT 'an area mapped by name AND by alias: ' || subject_area FROM {{V}}.otbi_area_duty GROUP BY subject_area HAVING count(DISTINCT matched_by) > 1
    UNION ALL SELECT 'admin-class role shipped as an area holder: ' || subject_area || ' / ' || duty_code FROM {{V}}.otbi_area_duty
              WHERE duty_code ~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)'
    UNION ALL SELECT 'a duty code that is no identifier: ' || subject_area || ' / ' || duty_code FROM {{V}}.otbi_area_duty
              WHERE duty_code !~ '^[A-Z][A-Z0-9_$#]*$'
    UNION ALL SELECT 'area ' || s.name || ' is neither mapped to a duty code nor listed in otbi_meta.area_duty_unmapped' FROM {{V}}.otbi_subject_area s
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_area_duty d WHERE d.subject_area = s.name)
                AND NOT ((SELECT v::jsonb FROM {{V}}.otbi_meta WHERE k = 'area_duty_unmapped') ? s.name)
    UNION ALL SELECT 'area ' || k || ' is listed unmapped but carries duty codes (or is no shipped area)'
              FROM jsonb_object_keys((SELECT v::jsonb FROM {{V}}.otbi_meta WHERE k = 'area_duty_unmapped')) k
              WHERE EXISTS (SELECT 1 FROM {{V}}.otbi_area_duty d WHERE d.subject_area = k)
                 OR NOT EXISTS (SELECT 1 FROM {{V}}.otbi_subject_area s WHERE s.name = k)
    -- ddl_version 10: area -> guide JOB role codes (the job-role consensus input)
    UNION ALL SELECT 'otbi_area_job -> otbi_subject_area: ' || j.subject_area FROM {{V}}.otbi_area_job j
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_subject_area s WHERE s.name = j.subject_area)
    UNION ALL SELECT 'otbi_area_job.matched_by ' || coalesce(matched_by, 'NULL') || ' is not duty | page | duty,page' FROM {{V}}.otbi_area_job
              WHERE matched_by IS NULL OR matched_by NOT IN ('duty', 'page', 'duty,page')
    UNION ALL SELECT 'a job code that is no identifier, or an admin-class role: ' || subject_area || ' / ' || job_code FROM {{V}}.otbi_area_job
              WHERE job_code !~ '^[A-Z][A-Z0-9_$#]*$' OR job_code ~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)'
    UNION ALL SELECT 'otbi_area_job is empty — the job-role consensus would find nothing' WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_area_job)
    UNION ALL SELECT 'missing otbi_meta stamp ' || k FROM unnest(ARRAY['version', 'guide_release', 'area_duty_guides', 'area_duty_unmapped', 'area_duty_stats', 'area_job_stats']) k
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_meta m WHERE m.k = k)
  ) x;
  IF bad_otbi IS NOT NULL THEN RAISE EXCEPTION 'p6 gate FAILED: OTBI lineage / area-duty facts of {{V}}: %', bad_otbi; END IF;
END $$;
\echo '--- unit_titles: every shipped corpus row is reachable by at least its own title ---'
SELECT source, count(*) AS titles, count(DISTINCT id) AS statements FROM {{V}}.unit_titles GROUP BY 1 ORDER BY 1;
\echo '--- the three verification subject areas: lineage folders with / without a corpus unit (listQueriesForSubjectArea coverage) ---'
SELECT f.subject_area, count(*) FILTER (WHERE f.in_lineage = 1) AS lineage_folders,
       count(*) FILTER (WHERE f.in_lineage = 1 AND f.unit_id IS NOT NULL) AS with_unit,
       string_agg(f.name, ' | ' ORDER BY f.name) FILTER (WHERE f.in_lineage = 1 AND f.unit_id IS NULL) AS lineage_folders_without_unit
FROM   {{V}}.otbi_folder f
WHERE  f.subject_area IN ('General Ledger - Balances Real Time', 'Payables Invoices - Transactions Real Time', 'Workforce Management - Worker Assignment Real Time')
GROUP  BY 1 ORDER BY 1;

\echo '=== 6c. data-access security facts (ddl_version 5; table_disallowed 6; names-only sec_area_privilege 7; scoped, never nameless curated rows 8; (area, entity) keys + no pod export copies 9; audited primary + sensitive objects + context evidence refs in sec_meta; reference families + traced context columns 10) ==='
SELECT (SELECT count(*) FROM {{V}}.table_security WHERE confidence <> 'ambiguous')                    AS context_rows,
       (SELECT count(DISTINCT table_name) FROM {{V}}.table_security WHERE confidence <> 'ambiguous') AS objects,
       (SELECT count(DISTINCT table_name || '.' || column_name) FROM {{V}}.table_security WHERE confidence = 'ambiguous') AS ambiguous_columns,
       (SELECT count(*) FROM {{V}}.table_disallowed) AS disallowed_objects,
       (SELECT count(*) FROM {{V}}.sec_area_privilege) AS area_rows,
       (SELECT count(*) FROM {{V}}.sec_area_privilege WHERE entity_table IS NOT NULL) AS area_rows_with_entity,
       (SELECT count(*) FROM {{V}}.sec_area_privilege WHERE instance_scope <> '*') AS area_rows_instance_scoped,
       (SELECT count(*) FROM {{V}}.sec_meta)     AS sec_meta_keys;
\echo '--- GATE: a curated area row without an object / privilege NAME or without an instance scope — the release FAILS on any (no privilege-less call exists) ---'
SELECT area_or_product, ordinal, obj_name, privilege, source, instance_scope
FROM   {{V}}.sec_area_privilege WHERE coalesce(obj_name, '') = '' OR coalesce(privilege, '') = '' OR coalesce(instance_scope, '') = '' ORDER BY 1, 2;
DO $$
DECLARE nameless int;
BEGIN
  SELECT count(*) INTO nameless FROM {{V}}.sec_area_privilege WHERE coalesce(obj_name, '') = '' OR coalesce(privilege, '') = '' OR coalesce(instance_scope, '') = '';
  IF nameless > 0 THEN
    RAISE EXCEPTION 'p6 gate FAILED: % curated area row(s) in {{V}} without an object / privilege name or an instance scope (listed above) — name the pair in p5_security_rules.json areaPrivileges (or drop the row) and build a new label', nameless;
  END IF;
END $$;
\echo '--- GATE: an ambiguous row = an unresolved context column on a USED object — the release FAILS on any ---'
SELECT table_name, column_name, string_agg(context, ',' ORDER BY context) AS candidates, left(min(reason), 120) AS reason
FROM   {{V}}.table_security WHERE confidence = 'ambiguous' GROUP BY 1, 2 ORDER BY 1, 2;
DO $$
DECLARE n int;
BEGIN
  SELECT count(DISTINCT table_name || '.' || column_name) INTO n FROM {{V}}.table_security WHERE confidence = 'ambiguous';
  IF n > 0 THEN
    RAISE EXCEPTION 'p6 gate FAILED: % ambiguous data-access column(s) on USED objects in {{V}} (listed above) — resolve each (a rule or a curated override in p5_security_rules.json) and build a new label', n;
  END IF;
END $$;
\if :has_work
\echo '--- GATE: a disallowed object is used by no corpus statement (work.r_tables) ---'
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT d.table_name, ', ') INTO bad
  FROM   {{V}}.table_disallowed d JOIN work.r_tables r ON r.table_name = d.table_name AND NOT r.is_cte;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p6 gate FAILED: disallowed object(s) read by corpus statements: %', bad; END IF;
END $$;
\endif
\echo '--- disallowed objects ---'
SELECT table_name, left(reason, 140) AS reason FROM {{V}}.table_disallowed ORDER BY 1;
\echo '--- security dangling / shape — every one must be ZERO ---'
SELECT 'table_security -> columns' AS ref, count(*) AS bad
FROM   {{V}}.table_security s WHERE NOT EXISTS (SELECT 1 FROM {{V}}.columns c WHERE c.table_name = s.table_name AND c.name = s.column_name)
UNION ALL SELECT 'objects with a resolved row but no primary', count(*)
FROM  (SELECT table_name FROM {{V}}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1 HAVING sum(is_primary) <> 1) x
UNION ALL SELECT 'table_security row without a reference object / column', count(*)
FROM   {{V}}.table_security s WHERE s.ref_object IS NULL OR s.ref_column IS NULL
UNION ALL SELECT 'area row whose (area, entity) key names no dictionary table', count(*)
FROM   {{V}}.sec_area_privilege a WHERE a.entity_table IS NOT NULL AND NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = a.entity_table)
UNION ALL SELECT 'area row whose source (= the grade of its conditions) is not trace | inferred', count(*)
FROM   {{V}}.sec_area_privilege a WHERE a.source NOT IN ('trace', 'inferred')
UNION ALL SELECT 'a pod id in a shipped security table (digits-only name)', count(*)
FROM  (SELECT obj_name AS n FROM {{V}}.sec_area_privilege
       UNION ALL SELECT privilege FROM {{V}}.sec_area_privilege) x WHERE x.n ~ '^[0-9]+$'
UNION ALL SELECT 'missing stamp keys', count(*)
FROM   unnest(ARRAY['version','context_order','context_evidence_refs','hcm_prefixes','privilege_prefix_aliases','primary_audit','sensitive_objects','stats']) k
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.sec_meta m WHERE m.k = k);
\echo '--- ddl_version 10: the reference families (table_reference_family) + the traced context columns (sec_area_privilege.context_column) ---'
SELECT family, count(*) AS tables, count(base_table) AS with_base FROM {{V}}.table_reference_family GROUP BY 1 ORDER BY 1;
SELECT area_or_product, obj_name, privilege, source, entity_table, context_column FROM {{V}}.sec_area_privilege WHERE context_column IS NOT NULL ORDER BY 1, 2;
\echo '--- GATE: every family member a dictionary table with an evidence text, the five families present, a translation base real, a context column TABLE.COLUMN of the dictionary — the release FAILS on any line ---'
DO $$
DECLARE bad_ref text;
BEGIN
  SELECT string_agg(m, '; ') INTO bad_ref FROM (
    SELECT 'table_reference_family.family ' || coalesce(family, 'NULL') || ' is not lookup | translation | calendar | currency | territory' AS m
    FROM   {{V}}.table_reference_family WHERE family IS NULL OR family NOT IN ('lookup', 'translation', 'calendar', 'currency', 'territory')
    UNION ALL SELECT 'table_reference_family -> tables: ' || count(*) || ' row(s)' FROM {{V}}.table_reference_family r
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = r.table_name) HAVING count(*) > 0
    UNION ALL SELECT 'table_reference_family row without an evidence text: ' || table_name FROM {{V}}.table_reference_family WHERE coalesce(btrim(evidence), '') = ''
    UNION ALL SELECT 'reference family ' || f || ' is empty' FROM unnest(ARRAY['lookup', 'translation', 'calendar', 'currency', 'territory']) f
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.table_reference_family r WHERE r.family = f)
    UNION ALL SELECT 'a base_table on a non-translation row, or a base that is no dictionary table: ' || r.table_name FROM {{V}}.table_reference_family r
              WHERE r.base_table IS NOT NULL AND (r.family <> 'translation' OR NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = r.base_table))
    UNION ALL SELECT 'sec_area_privilege.context_column ' || a.context_column || ' (' || a.area_or_product || ') is not TABLE.COLUMN of the dictionary'
              FROM {{V}}.sec_area_privilege a WHERE a.context_column IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM {{V}}.columns c WHERE c.table_name = split_part(a.context_column, '.', 1) AND c.name = split_part(a.context_column, '.', 2))
    UNION ALL SELECT 'curated area rows of ' || area_or_product || ' disagree on ' || obj_name || ' (one privilege per area and object)' FROM {{V}}.sec_area_privilege
              GROUP BY area_or_product, obj_name, instance_scope HAVING count(DISTINCT privilege) > 1
  ) x;
  IF bad_ref IS NOT NULL THEN RAISE EXCEPTION 'p6 gate FAILED: reference families / context columns of {{V}}: %', bad_ref; END IF;
END $$;
\echo '--- GATE: the audited primary contexts (sec_meta.primary_audit), the context evidence objects (sec_meta.context_evidence_refs) and the sensitive objects (sec_meta.sensitive_objects) — the release FAILS on any line ---'
DO $$
DECLARE bad_meta text;
BEGIN
  SELECT string_agg(m, '; ') INTO bad_meta FROM (
    -- an audit: >= 1 context of the context order, source trace | crawl, an evidence text
    SELECT 'primary_audit.' || a.key || ' is malformed' AS m
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) a
    WHERE  s.k = 'primary_audit'
      AND (jsonb_typeof(a.value->'contexts') IS DISTINCT FROM 'array' OR jsonb_array_length(a.value->'contexts') = 0
           OR coalesce(a.value->>'source', '') NOT IN ('trace', 'crawl') OR coalesce(btrim(a.value->>'evidence'), '') = '')
    UNION ALL
    SELECT 'context_evidence_refs.' || e.key || ' is not one of sec_meta.context_order, or lists no object'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) e
    WHERE  s.k = 'context_evidence_refs'
      AND (NOT ((SELECT v::jsonb FROM {{V}}.sec_meta WHERE k = 'context_order') ? e.key)
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'array' OR jsonb_array_length(e.value) = 0)
    UNION ALL
    SELECT 'primary_audit.' || a.key || ' names context ' || c.v || ', not one of sec_meta.context_order'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) a, jsonb_array_elements_text(a.value->'contexts') AS c(v)
    WHERE  s.k = 'primary_audit' AND jsonb_typeof(a.value->'contexts') = 'array'
      AND NOT ((SELECT v::jsonb FROM {{V}}.sec_meta WHERE k = 'context_order') ? c.v)
    UNION ALL
    -- a sensitive object: a dictionary table read through its OWN object (the table itself), privilege names
    -- that are identifiers (whether a pod registers / grants them is the customer layer's verdict at plan time),
    -- masked twins real columns
    SELECT 'sensitive_objects.' || o.key || ': object ' || coalesce(o.value->>'object', '?') || ' is not the table itself, or the table is not in the dictionary'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) o
    WHERE  s.k = 'sensitive_objects'
      AND (o.value->>'object' IS DISTINCT FROM o.key OR NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = o.key))
    UNION ALL
    SELECT 'sensitive_objects.' || o.key || ': privilege ' || p.v || ' is not a privilege name'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) o, jsonb_array_elements_text(o.value->'privileges') AS p(v)
    WHERE  s.k = 'sensitive_objects' AND p.v !~ '^[A-Za-z][A-Za-z0-9_$#]*$'
    UNION ALL
    SELECT 'sensitive_objects.' || o.key || ' has no privilege'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) o
    WHERE  s.k = 'sensitive_objects' AND (jsonb_typeof(o.value->'privileges') IS DISTINCT FROM 'array' OR jsonb_array_length(o.value->'privileges') = 0)
    UNION ALL
    SELECT 'sensitive_objects.' || o.key || ': masked column ' || coalesce(mk->>'column', '?') || ' / ' || coalesce(mk->>'use', '?') || ' not in the dictionary'
    FROM   {{V}}.sec_meta s, jsonb_each(s.v::jsonb) o, jsonb_array_elements(o.value->'masked') mk
    WHERE  s.k = 'sensitive_objects'
      AND (NOT EXISTS (SELECT 1 FROM {{V}}.columns c WHERE c.table_name = o.key AND c.name = mk->>'column')
           OR NOT EXISTS (SELECT 1 FROM {{V}}.columns c WHERE c.table_name = o.key AND c.name = mk->>'use'))
  ) x;
  IF bad_meta IS NOT NULL THEN RAISE EXCEPTION 'p6 gate FAILED: data-access sec_meta facts of {{V}}: %', bad_meta; END IF;
END $$;
\echo '--- multi-context tables per name prefix: secured on the primary context only where the prefix is audited (the rest are BLOCKED by the table-keyed plan) ---'
SELECT split_part(m.table_name, '_', 1) AS prefix, count(*) AS multi_context_tables,
       ((SELECT v::jsonb FROM {{V}}.sec_meta WHERE k = 'primary_audit') ? split_part(m.table_name, '_', 1)) AS audited
FROM  (SELECT table_name FROM {{V}}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1 HAVING count(*) > 1) m
GROUP  BY 1 ORDER BY 2 DESC, 1 LIMIT 25;
\echo '--- the spec fixture objects (2026-09-29 §3 / 2026-10-02 §7 smoke): expected contexts ---'
SELECT table_name, string_agg(column_name || ':' || context || '->' || ref_object || CASE WHEN is_primary = 1 THEN '*' ELSE '' END
                              || ':' || confidence, ', ' ORDER BY is_primary DESC, column_name, context) AS rows
FROM   {{V}}.table_security s
WHERE  s.table_name IN ('AP_INVOICES_ALL', 'GL_JE_HEADERS', 'FA_BOOKS', 'INV_ONHAND_QUANTITIES_DETAIL', 'PO_HEADERS_ALL', 'PER_DEPARTMENTS', 'PER_ALL_PEOPLE_F')
GROUP  BY 1 ORDER BY 1;

\echo '=== 7. version stamps written by the BUILD (nothing may be built at boot) ==='
SELECT 'catalog_meta' AS t, key AS k, value AS v FROM {{V}}.catalog_meta
UNION ALL SELECT 'grain_meta',  k, v FROM {{V}}.grain_meta
UNION ALL SELECT 'usage_meta',  k, v FROM {{V}}.usage_meta
UNION ALL SELECT 'pred_meta',   k, v FROM {{V}}.pred_meta
UNION ALL SELECT 'layout_meta', k, v FROM {{V}}.layout_meta
UNION ALL SELECT 'facts_meta',  k, v FROM {{V}}.facts_meta
UNION ALL SELECT 'plsql_meta',  k, v FROM {{V}}.plsql_meta
UNION ALL SELECT 'otbi_meta',   k, v FROM {{V}}.otbi_meta
UNION ALL SELECT 'sec_meta',    k, left(v, 120) FROM {{V}}.sec_meta
ORDER BY 1, 2;

\echo '--- registry stamps must match the code constants that gate a boot rebuild ---'
\if :has_base
SELECT 'grain' AS registry, (SELECT v FROM {{V}}.grain_meta WHERE k='version') AS stamped, '4' AS code_constant
UNION ALL SELECT 'usage',      (SELECT v FROM {{V}}.usage_meta WHERE k='version'), '1'
UNION ALL SELECT 'predicates', (SELECT v FROM {{V}}.pred_meta  WHERE k='version'), '1'
UNION ALL SELECT 'layout jsonl_hash', (SELECT v FROM {{V}}.layout_meta WHERE k='jsonl_hash'),
                                      (SELECT v FROM v2026_09.layout_meta WHERE k='jsonl_hash');
\else
SELECT 'grain' AS registry, (SELECT v FROM {{V}}.grain_meta WHERE k='version') AS stamped, '4' AS code_constant
UNION ALL SELECT 'usage',      (SELECT v FROM {{V}}.usage_meta WHERE k='version'), '1'
UNION ALL SELECT 'predicates', (SELECT v FROM {{V}}.pred_meta  WHERE k='version'), '1';
\endif

\echo '=== 8. every table PgMeta.verify() addresses exists in the version schema ==='
WITH want(t) AS (VALUES
  ('tables'),('columns'),('pkeys'),('fkeys'),('indexes'),('relationships'),('catalog_meta'),
  ('report_queries'),('report_queries_vec_multi'),
  ('table_grain'),('grain_meta'),('table_usages'),('usage_meta'),('table_predicates'),('pred_meta'),
  ('table_join_columns'),('layout_patterns'),('layout_patterns_vec'),('layout_meta'),
  ('plsql_packages'),('plsql_api'),('plsql_api_tables'),('plsql_meta'),
  ('otbi_subject_area'),('otbi_folder'),('otbi_column'),('otbi_vec'),('otbi_meta'),('unit_titles'),
  ('otbi_vo'),('otbi_column_ref'),('otbi_area_duty'),('otbi_area_job'),
  ('table_security'),('table_disallowed'),('sec_area_privilege'),('sec_meta'),('table_reference_family'),
  ('flexfields'),('adf_extensions'),('enrich'),('col_vec'),('table_rules'),('facts_meta'))
SELECT w.t AS required_table,
       EXISTS (SELECT 1 FROM information_schema.tables i
               WHERE i.table_schema='{{V}}' AND i.table_name=w.t) AS present
FROM   want w ORDER BY 2, 1;

\echo '--- retired tables (ddl_version 9: the pod export copies) — must be absent ---'
SELECT r AS retired_table, EXISTS (SELECT 1 FROM information_schema.tables i WHERE i.table_schema = '{{V}}' AND i.table_name = r) AS present
FROM   unnest(ARRAY['sec_object', 'sec_privilege']) r;

\echo '=== 9. indexes on the release schema ==='
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='{{V}}' ORDER BY 1, 2;

\echo '=== 10. ownership: every object must belong to the database role (fusion_dev in the build DB, fusion after p9) ==='
SELECT pg_get_userbyid(c.relowner) AS owner, count(*) AS objects
FROM   pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE  n.nspname IN ('work','{{V}}') GROUP BY 1 ORDER BY 1;
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE n.nspname IN ('work','{{V}}');
