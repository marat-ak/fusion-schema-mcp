\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS work.units (
  unit_id         text PRIMARY KEY,
  source          text NOT NULL,
  title           text,
  original_sql    text NOT NULL,
  sql_key         text GENERATED ALWAYS AS (md5(original_sql)) STORED,
  excluded_reason text
);

-- paths are REFERENCES, not identity (matches stageReport's reports[] model)
CREATE TABLE IF NOT EXISTS work.unit_ref (
  unit_id text NOT NULL,
  path    text NOT NULL,
  PRIMARY KEY (unit_id, path)
);

-- ---------- otbi: identity = subject_area__table_name ----------
INSERT INTO work.units (unit_id, source, title, original_sql)
SELECT 'otbi:' || o.subject_area || coalesce('__' || o.table_name, ''),
       'otbi',
       o.subject_area || '.' || coalesce(o.table_name, ''),
       o.physical_sql
FROM   work.otbi_item o
WHERE  NOT EXISTS (
         SELECT 1 FROM work.units u
         WHERE  u.unit_id = 'otbi:' || o.subject_area || coalesce('__' || o.table_name, ''))
ON CONFLICT (unit_id) DO NOTHING;

-- ---------- views: identity = the view name ----------
INSERT INTO work.units (unit_id, source, title, original_sql)
SELECT 'view:' || t.table_name, 'view', t.table_name, t.view_text
FROM   work.meta_tables t
WHERE  t.table_type = 'VIEW'
  AND  t.view_text IS NOT NULL AND btrim(t.view_text) <> ''
ON CONFLICT (unit_id) DO NOTHING;

-- ---------- bip: identity = content hash of the normalized SQL ----------
INSERT INTO work.units (unit_id, source, title, original_sql)
SELECT DISTINCT ON (work.bip_id(b.sql))
       work.bip_id(b.sql), 'bip-report', b.file_path, b.sql
FROM   work.bip_sql b
ORDER  BY work.bip_id(b.sql), b.file_path
ON CONFLICT (unit_id) DO NOTHING;

-- every path that carried a unit survives as a pointer row
INSERT INTO work.unit_ref (unit_id, path)
SELECT DISTINCT work.bip_id(b.sql), b.file_path
FROM   work.bip_sql b
WHERE  b.file_path IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------- exclusions: lexical &PARAM substitution makes SQL unparseable ----------
UPDATE work.units
SET    excluded_reason = 'dynamic_lexical'
WHERE  source = 'bip-report'
  AND  excluded_reason IS NULL
  AND  original_sql ~ '&[A-Za-z_][A-Za-z0-9_]*';

CREATE INDEX IF NOT EXISTS ix_units_sql_key ON work.units (sql_key);
CREATE INDEX IF NOT EXISTS ix_units_source  ON work.units (source);

COMMIT;

-- ================= verify =================
SELECT source, count(*) AS units,
       count(*) FILTER (WHERE excluded_reason IS NOT NULL) AS excluded,
       count(DISTINCT sql_key)                             AS distinct_sql
FROM   work.units GROUP BY source ORDER BY 1;

SELECT 'unit_ref' AS t, count(*) FROM work.unit_ref;

-- THE TEST: does every shipped corpus id exist in work.units?
SELECT rq.source,
       count(*)                    AS shipped,
       count(u.unit_id)            AS matched,
       count(*) - count(u.unit_id) AS missing
FROM   v2026_09.report_queries rq
LEFT   JOIN work.units u ON u.unit_id = rq.id
GROUP  BY rq.source ORDER BY 1;
