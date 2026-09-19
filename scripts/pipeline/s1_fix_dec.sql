\set ON_ERROR_STOP on

-- Port of decodeXmlEntities() -- fusion-schema-mcp/src/xmlEntities.ts:13-23
-- &amp; is decoded LAST so a double-escaped &amp;quot; collapses in one pass.
-- SCOPE IS DELIBERATE: schema CSV text fields and view SQL only. NEVER bip-report SQL,
-- whose entity hits are string LITERALS inside REPLACE() (Irish payroll).
CREATE OR REPLACE FUNCTION work.dec_xml(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN s IS NULL OR position('&' in s) = 0 THEN s ELSE
    replace(replace(replace(replace(replace(replace(replace(
      s, '&quot;', '"'), '&apos;', ''''), '&#39;', ''''), '&#34;', '"'),
         '&lt;', '<'), '&gt;', '>'), '&amp;', '&')
  END;
$fn$;

BEGIN;
-- sql_key is GENERATED from original_sql, so it recomputes automatically
UPDATE work.units
SET    original_sql = work.dec_xml(original_sql)
WHERE  source = 'view' AND position('&' in original_sql) > 0;
COMMIT;

SELECT 'work_views'      AS t, count(*) FROM work.units WHERE source='view'
UNION ALL
SELECT 'sqlkey_in_raw', count(*) FROM work.units u
WHERE  u.source='view'
  AND  EXISTS (SELECT 1 FROM raw.sql_units r WHERE r.sql_key=u.sql_key AND r.source='view')
UNION ALL
SELECT 'sql_identical_to_raw', count(*) FROM work.units u
JOIN   raw.sql_units r ON r.unit_id = u.unit_id
WHERE  u.source='view' AND u.original_sql = r.original_sql;
