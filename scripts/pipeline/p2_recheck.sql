-- ============================================================================
-- P2-recheck — REPORT ONLY. Writes nothing. Run after p2_promote + p3_reconcile.
--
-- The question it answers: over EVERY Qwen record now loaded (the 2026-08 run, the
-- gap run, the recheck run), what did the model's `missingTables` claims come to?
-- The rule that decides is p3_reconcile.sql's, unchanged and not restated here:
--   applied  ⟺  kind='missing' AND NOT in_parse AND in_dictionary AND in_sql_text
-- and an applied claim is a `model_added` row in work.r_tables. This file only
-- counts the outcome, by origin, plus the bucket that has NO rule yet: records
-- that said tablesConfirmed=false and enumerated nothing.
--
-- Claims come from EVERY journal line (work.qwen_claim → qwen_table_correction), so
-- `origin` here is the generation that MADE the claim, not the current record's.
-- ============================================================================
\set ON_ERROR_STOP on

\echo '--- MISSING claims by run origin (2026-08 run has run_id NULL) ---'
SELECT coalesce(split_part(k.run_id, '-', 1), 'august')            AS origin,
       count(*)                                                    AS reported,
       count(*) FILTER (WHERE k.in_sql_text)                       AS in_text,
       count(*) FILTER (WHERE k.in_dictionary)                     AS in_dictionary,
       count(*) FILTER (WHERE k.verdict = 'moot_already_present')  AS already_present,
       count(*) FILTER (WHERE k.applied)                           AS added,
       count(DISTINCT k.sql_hash) FILTER (WHERE k.applied)         AS statements_gained,
       count(*) FILTER (WHERE k.table_name <> k.name_norm)         AS fusion_prefixed
FROM   work.qwen_table_correction k
WHERE  k.kind = 'missing'
GROUP  BY 1 ORDER BY 1;

\echo '--- all origins together ---'
SELECT count(*)                                                    AS reported,
       count(*) FILTER (WHERE in_sql_text)                         AS in_text,
       count(*) FILTER (WHERE in_dictionary)                       AS in_dictionary,
       count(*) FILTER (WHERE verdict = 'moot_already_present')    AS already_present,
       count(*) FILTER (WHERE applied)                             AS added,
       count(DISTINCT sql_hash) FILTER (WHERE applied)             AS statements_gained
FROM   work.qwen_table_correction WHERE kind = 'missing';

\echo '--- rejected MISSING names, top 20, with the reason ---'
SELECT k.table_name, k.verdict AS reason, count(*) AS claims
FROM   work.qwen_table_correction k
WHERE  k.kind = 'missing' AND NOT k.applied AND k.verdict LIKE 'rejected%'
GROUP  BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 20;

\echo '--- flagged but did not enumerate: tablesConfirmed=false AND missingTables=[] (MEASURE ONLY; current records) ---'
SELECT coalesce(split_part(r.run_id, '-', 1), 'august') AS origin,
       count(*)                                          AS ok_records,
       count(*) FILTER (WHERE (r.payload->>'tablesConfirmed')::boolean IS FALSE) AS confirmed_false,
       count(*) FILTER (WHERE (r.payload->>'tablesConfirmed')::boolean IS FALSE
                          AND coalesce(jsonb_array_length(
                                CASE WHEN jsonb_typeof(r.payload->'missingTables') = 'array'
                                     THEN r.payload->'missingTables' END), 0) = 0) AS false_and_no_missing
FROM   work.qwen_record r
WHERE  r.ok AND jsonb_typeof(r.payload->'tablesConfirmed') = 'boolean'
GROUP  BY 1 ORDER BY 1;

\echo '--- the reconciled fact set now ---'
SELECT provenance, count(*) AS rows, count(DISTINCT sql_hash) AS statements
FROM   work.r_tables GROUP BY 1 ORDER BY 2 DESC;

\echo '--- records by origin ---'
SELECT coalesce(split_part(run_id, '-', 1), 'august') AS origin,
       count(*) AS records, count(*) FILTER (WHERE ok) AS ok, count(ghash) AS with_ghash
FROM   work.qwen_record GROUP BY 1 ORDER BY 1;
