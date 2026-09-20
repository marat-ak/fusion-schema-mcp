-- ============================================================================
-- P0 — the function library of the three-level catalog pipeline.
--
-- Drops and recreates `work`. Everything downstream depends only on these four
-- functions; they are the pieces of the one-level pipeline that were PROVEN
-- correct and are carried over verbatim.
-- ============================================================================
\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS work CASCADE;
CREATE SCHEMA work;

-- ---------------------------------------------------------------------------
-- norm_sql() — port of normalizeSql(), fusion-schema-mcp/src/corpus/sources.ts:23-31
--
-- CRITICAL: JavaScript's \s matches UNICODE whitespace; PostgreSQL's \s is ASCII-only.
-- A single U+00A0 in one bip query made the naive port diverge. We therefore translate
-- every character in JS's \s set to a plain space FIRST, after which ASCII \s is exact.
-- Line comments are stripped BEFORE block comments (JS applies them in that order).
-- Verified: 6,389/6,389 bip-report ids reproduce today's shipped `sql:<sha256>` exactly.
-- ---------------------------------------------------------------------------
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

-- L3 identity. `sql:` + this hex is the shipped bip-report id, so the bip half of the
-- corpus keeps its shipped ids for free.
CREATE OR REPLACE FUNCTION work.sql_hash(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(sha256(convert_to(work.norm_sql(s), 'UTF8')), 'hex');
$fn$;

-- ---------------------------------------------------------------------------
-- dec_xml() — port of decodeXmlEntities(), src/xmlEntities.ts:13-23.
-- `&amp;` is decoded LAST so a double-escaped `&amp;quot;` collapses in one pass.
-- SCOPE IS DELIBERATE: schema CSV text fields and view SQL only. NEVER bip-report SQL,
-- whose entity hits are string LITERALS inside REPLACE() (Irish payroll Revenue models).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.dec_xml(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN s IS NULL OR position('&' in s) = 0 THEN s ELSE
    replace(replace(replace(replace(replace(replace(replace(
      s, '&quot;', '"'), '&apos;', ''''), '&#39;', ''''), '&#34;', '"'),
         '&lt;', '<'), '&gt;', '>'), '&amp;', '&')
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- nn() — port of nn(), src/util.ts:4-9: trim, then map ''/'null' (any case) to NULL.
-- JS String.trim() strips the full Unicode whitespace set; btrim(s) strips spaces only,
-- so the trim here is an explicit regexp over the same set norm_sql() translates.
-- Getting this exactly right matters: 507 shipped views keep a trailing CRLF that
-- btrim() would have left in place, and the byte-identity check would fail.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.js_trim(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
           regexp_replace(s, '^[\s' ||
             chr(160)  || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
             chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
             chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
             chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', ''),
           '[\s' ||
             chr(160)  || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
             chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
             chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
             chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+$', '');
$fn$;

CREATE OR REPLACE FUNCTION work.nn(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN s IS NULL THEN NULL
           WHEN work.js_trim(s) = '' THEN NULL
           WHEN lower(work.js_trim(s)) = 'null' THEN NULL
           ELSE work.js_trim(s)
         END;
$fn$;

-- The view-text cleanup, as ONE function: nn() semantics, then dec_xml(), then the
-- JS-trim again (decoding can expose whitespace). compile.ts does `dec(nn(v))`.
CREATE OR REPLACE FUNCTION work.clean_view_text(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT work.dec_xml(work.nn(s));
$fn$;
