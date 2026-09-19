\set ON_ERROR_STOP on

-- Port of normalizeSql() -- fusion-schema-mcp/src/corpus/sources.ts:23-31
--
-- CRITICAL: JavaScript's \s matches UNICODE whitespace; PostgreSQL's \s is ASCII-only.
-- A single U+00A0 in one bip query made the naive port diverge. We therefore translate
-- every character in JS's \s set to a plain space FIRST, after which ASCII \s is exact.
-- JS \s = \f \n \r \t \v        -
--         　 ﻿   (the non-ASCII ones are listed below, 19 of them)
CREATE OR REPLACE FUNCTION work.norm_sql(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(s,
                 chr(160)  || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
                 chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
                 chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
                 chr(8239) || chr(8287) || chr(12288) || chr(65279),
                 '                   '),                   -- 19 spaces, one per char
               '--[^\n]*', ' ', 'g'),                      -- line comments FIRST
             '/\*.*?\*/', ' ', 'gs'),                      -- block comments SECOND
           '\s+', ' ', 'g')));                             -- collapse, trim, lowercase
$fn$;

CREATE OR REPLACE FUNCTION work.bip_id(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'sql:' || encode(sha256(convert_to(work.norm_sql(s), 'UTF8')), 'hex');
$fn$;

SELECT u.source,
       count(*)                                                        AS units,
       count(*) FILTER (WHERE work.bip_id(u.original_sql) = u.unit_id)  AS id_matches,
       count(*) FILTER (WHERE work.bip_id(u.original_sql) <> u.unit_id) AS id_differs
FROM   raw.sql_units u
WHERE  u.source = 'bip-report'
GROUP  BY u.source;
