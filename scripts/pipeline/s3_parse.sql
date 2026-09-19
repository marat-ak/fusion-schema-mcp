\set ON_ERROR_STOP on
BEGIN;

-- Units eligible for grounding/enrichment: otbi is deduped to its canonical
-- representative; views and bip are NEVER deduped (identity is the unit, not the SQL).
CREATE OR REPLACE VIEW work.active_unit AS
SELECT u.*
FROM   work.units u
WHERE  u.source <> 'otbi'
   OR  EXISTS (SELECT 1 FROM work.canonical_unit c WHERE c.unit_id = u.unit_id);

CREATE TABLE IF NOT EXISTS work.facts_run (
  sql_key        text NOT NULL,
  parser_version text NOT NULL,
  parse_quality  text,
  PRIMARY KEY (sql_key, parser_version)
);
CREATE TABLE IF NOT EXISTS work.f_tables (sql_key text, table_name text,
                                          is_cte boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS work.f_joins  (sql_key text, from_t text, from_c text,
                                          to_t text, to_c text, join_type text);

-- ---------- ORACLE: parse quality comes from the v2 build's own parse output ----------
INSERT INTO work.facts_run (sql_key, parser_version, parse_quality)
SELECT DISTINCT ON (u.sql_key) u.sql_key, 'oracle-v2026_09', r.parse_quality
FROM   work.active_unit u
JOIN   raw.sql_units r ON r.sql_key = u.sql_key AND r.parse_quality IS NOT NULL
ORDER  BY u.sql_key, r.parse_quality
ON CONFLICT (sql_key, parser_version) DO NOTHING;

-- ---------- EXCLUSION is a PARSE output, not an inventory regex ----------
-- excluded_reason='dynamic_lexical' <=> parse_quality='full_lex' (verified: 144 = 144)
UPDATE work.units u
SET    excluded_reason = 'dynamic_lexical'
FROM   work.facts_run f
WHERE  f.sql_key = u.sql_key
  AND  f.parse_quality = 'full_lex'
  AND  u.excluded_reason IS DISTINCT FROM 'dynamic_lexical';

-- ---------- ORACLE: tables_used -> f_tables ----------
INSERT INTO work.f_tables (sql_key, table_name)
SELECT DISTINCT u.sql_key, t.tbl
FROM   work.active_unit u
JOIN   v2026_09.report_queries rq ON rq.id = u.unit_id
CROSS  JOIN LATERAL jsonb_array_elements_text(nullif(rq.tables_used,'')::jsonb) AS t(tbl)
WHERE  NOT EXISTS (SELECT 1 FROM work.f_tables x WHERE x.sql_key = u.sql_key);

-- ---------- ORACLE: joins ('FROM_T.FROM_C=TO_T.TO_C[TYPE]') -> f_joins ----------
WITH j AS (
  SELECT DISTINCT u.sql_key,
         regexp_replace(s.val, '\[.*\]$', '')        AS pair,
         (regexp_match(s.val, '\[([^\]]+)\]$'))[1]   AS jtype
  FROM   work.active_unit u
  JOIN   v2026_09.report_queries rq ON rq.id = u.unit_id
  CROSS  JOIN LATERAL jsonb_array_elements_text(nullif(rq.joins,'')::jsonb) AS s(val)
  WHERE  NOT EXISTS (SELECT 1 FROM work.f_joins x WHERE x.sql_key = u.sql_key)
)
INSERT INTO work.f_joins (sql_key, from_t, from_c, to_t, to_c, join_type)
SELECT j.sql_key,
       split_part(split_part(j.pair, '=', 1), '.', 1),
       split_part(split_part(j.pair, '=', 1), '.', 2),
       split_part(split_part(j.pair, '=', 2), '.', 1),
       split_part(split_part(j.pair, '=', 2), '.', 2),
       j.jtype
FROM   j;

CREATE INDEX IF NOT EXISTS ix_f_tables_key ON work.f_tables (sql_key);
CREATE INDEX IF NOT EXISTS ix_f_joins_key  ON work.f_joins  (sql_key);
CREATE INDEX IF NOT EXISTS ix_f_tables_tbl ON work.f_tables (table_name);

COMMIT;

-- ================= verify =================
SELECT 'facts_run' AS t, count(*) FROM work.facts_run
UNION ALL SELECT 'f_tables', count(*) FROM work.f_tables
UNION ALL SELECT 'f_joins',  count(*) FROM work.f_joins;

SELECT parse_quality, count(*) FROM work.facts_run GROUP BY 1 ORDER BY 2 DESC;

SELECT 'excluded_units' AS t, count(*) FROM work.units WHERE excluded_reason IS NOT NULL;

-- coverage: active units with vs without facts
SELECT u.source,
       count(*)                                                        AS active_units,
       count(*) FILTER (WHERE f.sql_key IS NOT NULL)                   AS with_facts,
       count(*) FILTER (WHERE f.sql_key IS NULL)                       AS no_facts
FROM   work.active_unit u
LEFT   JOIN work.facts_run f ON f.sql_key = u.sql_key
GROUP  BY u.source ORDER BY 1;
