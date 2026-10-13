-- ============================================================================
-- P5e — the OTBI presentation catalog of a release schema, from `work` (p3_otbi.* + p4).
--
-- Fills {{V}}.otbi_subject_area / otbi_folder / otbi_column / otbi_vec / otbi_meta (ddl_version 4) and,
-- since ddl_version 9 (plan 2026-10-04 C1 / C2 / C5), otbi_vo (the VO hop from work.otbi_lineage),
-- otbi_column_ref (otbi_column.db_refs exploded: the exposure index) and otbi_area_duty (subject area ->
-- duty CODE from Oracle's TBI guides, staged by p5_otbi.sh from data/otbi/tbi_guides/<release>/
-- area_duty.jsonl at /tmp/p5tbi.jsonl, matched to the catalog's area names by the normalized name or by
-- a curated rename alias of scripts/pipeline/otbi_area_aliases.json, spliced verbatim at the
-- placeholder line) and, since ddl_version 10, otbi_area_job (subject area -> guide JOB role code: the job codes
-- of the area's duties — duty.jsonl, staged at /tmp/p5tbiduty.jsonl — and the job pages that list the area —
-- job.jsonl, staged at /tmp/p5tbijob.jsonl; the job-role consensus of the data-access resolver reads it).
-- {{V}} / {{TBI_RELEASE}} are substituted by p5_otbi.sh. ONE transaction, DELETE then
-- INSERT, on the release being BUILT. It is NOT a repair tool: a built release is immutable.
--
-- SCOPE = work.otbi_folder.ship (decided ONCE, in p3_otbi.sql, and reported in
-- data/otbi_reconciliation.md): the vendor presentation layer — every folder the release-26B
-- lineage workbooks document, plus the crawl's flat folders of the same subject areas. The
-- crawl's extension trees (`A > B > C` paths and `… Extension` / `… Custom Attributes` folders:
-- our demo pod's flexfield / custom-object columns, 1.6M of the 2.1M crawled columns) are NOT
-- vendor content; they are counted, not shipped — the same standing as flexfields/adf_extensions.
--
-- grain_note: the table_grain notes of the folder's mapped multi-row tables, from the release's
-- OWN registry (p5_fill.sql built it a step earlier) — never recomputed here.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

-- the curated rename aliases (p3_tbi_aliases.py -> otbi_area_aliases.json, verbatim)
CREATE TEMP TABLE tbi_alias_doc (j jsonb) ON COMMIT DROP;
INSERT INTO tbi_alias_doc VALUES ($aliases$
{{ALIASES}}
$aliases$::jsonb);
-- the guide crawl: one JSON object per line, read verbatim (a CSV dialect whose quote / delimiter never occur)
CREATE TEMP TABLE tbi_raw (line text) ON COMMIT DROP;
\copy tbi_raw (line) FROM '/tmp/p5tbi.jsonl' WITH (FORMAT csv, DELIMITER E'\x01', QUOTE E'\x02')
CREATE TEMP TABLE tbi_duty_raw (line text) ON COMMIT DROP;
\copy tbi_duty_raw (line) FROM '/tmp/p5tbiduty.jsonl' WITH (FORMAT csv, DELIMITER E'\x01', QUOTE E'\x02')
CREATE TEMP TABLE tbi_job_raw (line text) ON COMMIT DROP;
\copy tbi_job_raw (line) FROM '/tmp/p5tbijob.jsonl' WITH (FORMAT csv, DELIMITER E'\x01', QUOTE E'\x02')

-- the catalog-match normalization of p3_tbi_guides.py / p3_tbi_aliases.py: NFKC, case-folded, every Unicode
-- dash to '-', the spacing around '-' unified, whitespace runs collapsed, trimmed
CREATE FUNCTION pg_temp.tbi_norm(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT btrim(regexp_replace(regexp_replace(
           translate(lower(normalize(s, NFKC)), U&'\2010\2011\2012\2013\2014\2015\2212\FE58\FE63\FF0D', '----------'),
           '\s*-\s*', ' - ', 'g'), '\s+', ' ', 'g'))
$f$;

CREATE TEMP TABLE tbi_ad ON COMMIT DROP AS
SELECT DISTINCT x.j->>'subject_area' AS guide_area, x.j->>'duty_code' AS duty_code, x.j->>'duty_name' AS duty_name,
       x.j->>'guide' AS guide, x.j->>'guide_release' AS guide_release
FROM  (SELECT line::jsonb AS j FROM tbi_raw WHERE btrim(line) <> '') x;
-- admin-class roles are never subject-area holders (decision 2026-10-05: fail closed) — reported, never shipped
CREATE TEMP TABLE tbi_admin ON COMMIT DROP AS
SELECT * FROM tbi_ad WHERE duty_code ~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)';
DELETE FROM tbi_ad WHERE duty_code ~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)';
CREATE TEMP TABLE tbi_alias ON COMMIT DROP AS
SELECT a->>'catalog' AS catalog_area, a->>'guide' AS guide_area FROM tbi_alias_doc d, jsonb_array_elements(d.j->'aliases') a;
-- the guides' duty pages (duty -> job codes) and job pages (job -> name, subject areas): identifier-shaped codes only
-- (the crawl's three placeholder pages carry none); admin-class roles are never area holders
CREATE TEMP TABLE tbi_duty_job ON COMMIT DROP AS
SELECT DISTINCT x.j->>'duty_code' AS duty_code, jc AS job_code, x.j->>'guide' AS guide
FROM  (SELECT line::jsonb AS j FROM tbi_duty_raw WHERE btrim(line) <> '') x, jsonb_array_elements_text(coalesce(x.j->'job_codes', '[]')) jc
WHERE jc ~ '^[A-Z][A-Z0-9_]*$' AND jc !~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)';
CREATE TEMP TABLE tbi_job ON COMMIT DROP AS
SELECT DISTINCT ON (x.j->>'job_code') x.j->>'job_code' AS job_code, x.j->>'job_name' AS job_name, x.j->>'guide' AS guide, x.j->'subject_areas' AS areas
FROM  (SELECT line::jsonb AS j FROM tbi_job_raw WHERE btrim(line) <> '') x
WHERE x.j->>'job_code' ~ '^[A-Z][A-Z0-9_]*$' AND x.j->>'job_code' !~* '^(ORA_)?BI_?(ADMINISTRATOR|AUTHOR|CONSUMER)'
ORDER BY x.j->>'job_code', x.j->>'guide';

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(m, '; ') INTO bad FROM (
    SELECT 'the guide crawl (/tmp/p5tbi.jsonl) is empty' AS m WHERE NOT EXISTS (SELECT 1 FROM tbi_ad)
    UNION ALL SELECT 'guide row without area / code / name / guide / release' FROM tbi_ad
              WHERE coalesce(guide_area, '') = '' OR coalesce(duty_code, '') = '' OR coalesce(duty_name, '') = '' OR coalesce(guide, '') = '' OR coalesce(guide_release, '') = ''
    UNION ALL SELECT 'alias catalog area ' || a.catalog_area || ' is not in work.otbi_subject_area' FROM tbi_alias a
              WHERE NOT EXISTS (SELECT 1 FROM work.otbi_subject_area s WHERE s.name = a.catalog_area)
    UNION ALL SELECT 'alias catalog area ' || a.catalog_area || ' already matches a guide area by name' FROM tbi_alias a
              WHERE EXISTS (SELECT 1 FROM tbi_ad d WHERE pg_temp.tbi_norm(d.guide_area) = pg_temp.tbi_norm(a.catalog_area))
    UNION ALL SELECT 'alias guide area ' || a.guide_area || ' is not in the guide crawl' FROM tbi_alias a
              WHERE NOT EXISTS (SELECT 1 FROM tbi_ad d WHERE d.guide_area = a.guide_area)
    UNION ALL SELECT 'alias catalog area listed twice: ' || catalog_area FROM tbi_alias GROUP BY catalog_area HAVING count(*) > 1
    UNION ALL SELECT 'the guide duty pages (/tmp/p5tbiduty.jsonl) name no job code' WHERE NOT EXISTS (SELECT 1 FROM tbi_duty_job)
    UNION ALL SELECT 'the guide job pages (/tmp/p5tbijob.jsonl) are empty' WHERE NOT EXISTS (SELECT 1 FROM tbi_job)) s;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_otbi: guide crawl / aliases invalid: %', bad; END IF;
END $$;

DELETE FROM {{V}}.otbi_vec;
DELETE FROM {{V}}.otbi_column_ref;
DELETE FROM {{V}}.otbi_vo;
DELETE FROM {{V}}.otbi_area_duty;
DELETE FROM {{V}}.otbi_area_job;
DELETE FROM {{V}}.otbi_column;
DELETE FROM {{V}}.otbi_folder;
DELETE FROM {{V}}.otbi_subject_area;
DELETE FROM {{V}}.otbi_meta;

INSERT INTO {{V}}.otbi_subject_area (name, pillar, n_folders, n_fact_folders, n_columns, fact_folders, in_lineage, in_crawl, in_corpus, text_hash)
SELECT s.name, s.pillar,
       f.n, f.nf, f.nc,
       coalesce(f.facts, '[]'),
       s.in_lineage::int, s.in_crawl::int, s.in_corpus::int, s.text_hash
FROM   work.otbi_subject_area s
JOIN  (SELECT subject_area, count(*) AS n, count(*) FILTER (WHERE kind = 'fact') AS nf, sum(n_columns) AS nc,
              jsonb_agg(name ORDER BY name) FILTER (WHERE kind = 'fact')::text AS facts
       FROM   work.otbi_folder WHERE ship GROUP BY 1) f ON f.subject_area = s.name;

INSERT INTO {{V}}.otbi_folder (subject_area, name, kind, kind_source, description, desc_source, db_tables, n_columns, n_measures,
                               in_lineage, in_crawl, in_corpus, unit_id, grain_note, nested, ordinal, text_hash)
SELECT f.subject_area, f.name, f.kind, f.kind_source, f.description, f.desc_source, f.db_tables::text, f.n_columns, f.n_measures,
       f.in_lineage::int, f.in_crawl::int,
       -- corpus coverage as THIS release serves it: a unit whose statement is not shipped (no
       -- enrichment, 12 folders) is not reachable through getReportQuery, so it is not claimed here
       (u.title IS NOT NULL)::int, CASE WHEN u.title IS NOT NULL THEN f.unit_id END,
       (SELECT string_agg(t || ': ' || g.grain || ' — ' || coalesce(g.dedup, ''), '; ' ORDER BY t)
        FROM   jsonb_array_elements_text(f.db_tables) t
        JOIN   {{V}}.table_grain g ON g.table_name = t),
       f.nested::int, f.ordinal, f.text_hash
FROM   work.otbi_folder f
LEFT   JOIN LATERAL (SELECT u.title FROM {{V}}.unit_titles u WHERE u.title = f.subject_area || '.' || f.name LIMIT 1) u ON TRUE
WHERE  f.ship;

INSERT INTO {{V}}.otbi_column (subject_area, folder, name, data_type, kind, aggregation, expression, db_refs, vo_refs, indexed, description,
                               desc_source, gap_cause, in_lineage, in_crawl, in_probe, ordinal, text_hash)
SELECT c.subject_area, c.folder, c.name, c.data_type, c.kind, c.aggregation, c.expression, c.db_refs::text, c.vo_refs::text, c.indexed::int, c.description,
       c.desc_source, c.gap_cause, c.in_lineage::int, c.in_crawl::int, c.in_probe::int, c.ordinal, c.text_hash
FROM   work.otbi_column c
JOIN   work.otbi_folder f ON f.subject_area = c.subject_area AND f.name = c.folder
WHERE  f.ship;

-- C2: the exposure index — one row per (presentation column, distinct physical (table, column) ref); the same
-- folder set each folder's db_tables lists (both derived from the columns' db_refs)
INSERT INTO {{V}}.otbi_column_ref (subject_area, folder, folder_kind, column_name, table_name, db_column, src, via_expression)
SELECT oc.subject_area, oc.folder, f.kind, oc.name, r.t, r.c,
       coalesce(string_agg(DISTINCT s.src, ',' ORDER BY s.src), ''),
       max(CASE WHEN coalesce(btrim(oc.expression), '') <> '' THEN 1 ELSE 0 END)
FROM   work.otbi_column oc
JOIN   work.otbi_folder f ON f.subject_area = oc.subject_area AND f.name = oc.folder AND f.ship
CROSS  JOIN LATERAL jsonb_to_recordset(oc.db_refs) AS r(t text, c text, src jsonb)
LEFT   JOIN LATERAL jsonb_array_elements_text(coalesce(r.src, '[]'::jsonb)) AS s(src) ON TRUE
WHERE  jsonb_typeof(oc.db_refs) = 'array' AND r.t IS NOT NULL AND r.c IS NOT NULL
GROUP  BY oc.subject_area, oc.folder, f.kind, oc.name, r.t, r.c;

-- C1: the VO hop — every view object behind a shipped folder, its physical objects and mapped attributes
INSERT INTO {{V}}.otbi_vo (subject_area, folder, vo_path, vo_def, db_objects, vo_attrs)
SELECT l.subject_area, l.pres_table, l.vo_path, l.vo_def,
       coalesce(jsonb_agg(DISTINCT l.db_object ORDER BY l.db_object) FILTER (WHERE coalesce(l.db_object, '') <> ''), '[]'::jsonb)::text,
       jsonb_agg(DISTINCT jsonb_build_object('attr', l.vo_attr, 'db_object', l.db_object, 'db_column', l.db_column))::text
FROM   work.otbi_lineage l
JOIN   work.otbi_folder f ON f.subject_area = l.subject_area AND f.name = l.pres_table AND f.ship
WHERE  coalesce(l.vo_path, '') <> '' AND coalesce(l.vo_def, '') <> ''
GROUP  BY l.subject_area, l.pres_table, l.vo_path, l.vo_def;

-- C5: subject area -> duty code, by the normalized name, else by a curated rename alias (never both)
INSERT INTO {{V}}.otbi_area_duty (subject_area, duty_code, duty_name, guide, guide_release, matched_by, guide_area)
SELECT s.name, d.duty_code, min(d.duty_name), string_agg(DISTINCT d.guide, ',' ORDER BY d.guide),
       string_agg(DISTINCT d.guide_release, ',' ORDER BY d.guide_release), 'name', min(d.guide_area)
FROM   {{V}}.otbi_subject_area s
JOIN   tbi_ad d ON pg_temp.tbi_norm(d.guide_area) = pg_temp.tbi_norm(s.name)
GROUP  BY s.name, d.duty_code
UNION ALL
SELECT s.name, d.duty_code, min(d.duty_name), string_agg(DISTINCT d.guide, ',' ORDER BY d.guide),
       string_agg(DISTINCT d.guide_release, ',' ORDER BY d.guide_release), 'alias', min(d.guide_area)
FROM   {{V}}.otbi_subject_area s
JOIN   tbi_alias a ON a.catalog_area = s.name
JOIN   tbi_ad d ON d.guide_area = a.guide_area
GROUP  BY s.name, d.duty_code;

-- ddl_version 10: area -> guide JOB role codes — the job codes of the area's duties (duty pages), plus the job pages
-- that list the area (by the normalized name, or the guide area a curated rename alias maps)
INSERT INTO {{V}}.otbi_area_job (subject_area, job_code, job_name, matched_by, guide)
SELECT subject_area, job_code, min(job_name), string_agg(DISTINCT matched_by, ',' ORDER BY matched_by),
       string_agg(DISTINCT guide, ',' ORDER BY guide)
FROM (
  SELECT d.subject_area, dj.job_code, j.job_name, 'duty' AS matched_by, dj.guide
  FROM   {{V}}.otbi_area_duty d JOIN tbi_duty_job dj ON dj.duty_code = d.duty_code
  LEFT   JOIN tbi_job j ON j.job_code = dj.job_code
  UNION ALL
  SELECT s.name, j.job_code, j.job_name, 'page', j.guide
  FROM   tbi_job j CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(j.areas, '[]')) ga
  JOIN   {{V}}.otbi_subject_area s ON pg_temp.tbi_norm(s.name) = pg_temp.tbi_norm(ga)
  UNION ALL
  SELECT a.catalog_area, j.job_code, j.job_name, 'page', j.guide
  FROM   tbi_job j CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(j.areas, '[]')) ga
  JOIN   tbi_alias a ON a.guide_area = ga
  JOIN   {{V}}.otbi_subject_area s ON s.name = a.catalog_area) u
GROUP  BY subject_area, job_code;

-- one vector per distinct shipped text (p4_embed.mts, owner_kind 'otbi', owner_id = text_hash)
INSERT INTO {{V}}.otbi_vec (text_hash, kind, embedding)
SELECT t.text_hash, t.kind, e.embedding
FROM   work.otbi_text t
JOIN   work.embeddings e ON e.owner_kind = 'otbi' AND e.owner_id = t.text_hash AND e.slot = 0;

INSERT INTO {{V}}.otbi_meta (k, v) VALUES
  ('version',  '1'),
  ('built_at', now()::text),
  ('sources',  'r13-26b lineage workbooks (cx, fin, grc, hcm, ppm, scm-and-prc) + fa-exqw-dev2 SOAP crawl 2026-07 + per-folder probes; descriptions from dictionary / view remarks, no LLM; area -> duty codes from Oracle TBI guides (p3_tbi_guides.py)'),
  ('scope',    'lineage folders + flat crawl folders of the same subject areas; extension trees (nested paths, Extension / Custom Attributes folders) not shipped'),
  ('guide_release', '{{TBI_RELEASE}}');
-- the guides' own releases and the areas the gate can never open (no duty code: custom areas, renames without
-- evidence, areas in no guide) — every shipped area is mapped or listed here (p6 gate)
INSERT INTO {{V}}.otbi_meta (k, v)
SELECT 'area_duty_guides', jsonb_object_agg(guide, rel)::text FROM (SELECT guide, string_agg(DISTINCT guide_release, ',') rel FROM tbi_ad GROUP BY guide) g
UNION ALL
SELECT 'area_duty_unmapped', coalesce(jsonb_object_agg(s.name,
         CASE WHEN s.name LIKE 'custExt%' THEN 'custom subject area' ELSE 'no duty in the TBI guides {{TBI_RELEASE}} (no page, a page without roles, or a rename without evidence)' END), '{}'::jsonb)::text
FROM   {{V}}.otbi_subject_area s WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_area_duty d WHERE d.subject_area = s.name)
UNION ALL
SELECT 'area_duty_stats', jsonb_build_object(
  'areas_mapped_by_name', (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'name'),
  'areas_mapped_by_alias', (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'alias'),
  'pairs', (SELECT count(*) FROM {{V}}.otbi_area_duty), 'codes', (SELECT count(DISTINCT duty_code) FROM {{V}}.otbi_area_duty),
  'admin_class_codes_excluded', (SELECT count(*) FROM tbi_admin))::text
UNION ALL
SELECT 'area_job_stats', jsonb_build_object(
  'pairs', (SELECT count(*) FROM {{V}}.otbi_area_job), 'areas', (SELECT count(DISTINCT subject_area) FROM {{V}}.otbi_area_job),
  'job_codes', (SELECT count(DISTINCT job_code) FROM {{V}}.otbi_area_job),
  'pairs_by_duty', (SELECT count(*) FROM {{V}}.otbi_area_job WHERE matched_by LIKE '%duty%'),
  'pairs_by_page_only', (SELECT count(*) FROM {{V}}.otbi_area_job WHERE matched_by = 'page'))::text;

COMMIT;

ANALYZE {{V}}.otbi_subject_area; ANALYZE {{V}}.otbi_folder; ANALYZE {{V}}.otbi_column; ANALYZE {{V}}.otbi_vec;
ANALYZE {{V}}.otbi_vo; ANALYZE {{V}}.otbi_column_ref; ANALYZE {{V}}.otbi_area_duty; ANALYZE {{V}}.otbi_area_job;

SELECT 'otbi_vo' AS t, count(*) AS rows FROM {{V}}.otbi_vo
UNION ALL SELECT 'otbi_column_ref', count(*) FROM {{V}}.otbi_column_ref
UNION ALL SELECT 'otbi_area_duty', count(*) FROM {{V}}.otbi_area_duty
UNION ALL SELECT 'areas mapped (name)', count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'name'
UNION ALL SELECT 'areas mapped (alias)', count(DISTINCT subject_area) FROM {{V}}.otbi_area_duty WHERE matched_by = 'alias'
UNION ALL SELECT 'areas unmapped', count(*) FROM {{V}}.otbi_subject_area s WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_area_duty d WHERE d.subject_area = s.name)
UNION ALL SELECT 'otbi_area_job', count(*) FROM {{V}}.otbi_area_job
UNION ALL SELECT 'areas with guide job roles', count(DISTINCT subject_area) FROM {{V}}.otbi_area_job;

-- the gate lines: every shipped entity must have its vector, no text_hash without a vector
SELECT 'otbi_subject_area' AS t, count(*) AS rows, count(*) FILTER (WHERE description IS NOT NULL) AS described FROM (SELECT NULL::text AS description FROM {{V}}.otbi_subject_area) x
UNION ALL SELECT 'otbi_folder', count(*), count(*) FILTER (WHERE description IS NOT NULL) FROM {{V}}.otbi_folder
UNION ALL SELECT 'otbi_column', count(*), count(*) FILTER (WHERE description IS NOT NULL) FROM {{V}}.otbi_column
UNION ALL SELECT 'otbi_vec', count(*), NULL FROM {{V}}.otbi_vec;
SELECT 'columns without a vector' AS check, count(*) AS n FROM {{V}}.otbi_column c WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_vec v WHERE v.text_hash = c.text_hash)
UNION ALL SELECT 'folders without a vector', count(*) FROM {{V}}.otbi_folder f WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_vec v WHERE v.text_hash = f.text_hash)
UNION ALL SELECT 'subject areas without a vector', count(*) FROM {{V}}.otbi_subject_area s WHERE NOT EXISTS (SELECT 1 FROM {{V}}.otbi_vec v WHERE v.text_hash = s.text_hash);
