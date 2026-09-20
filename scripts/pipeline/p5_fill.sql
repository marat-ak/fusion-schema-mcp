-- ============================================================================
-- P5b — populate the release schema from `work`.
--
-- Run AFTER p5_ddl.sh, which created v2026_10 from the product's own
-- scripts/pg-import/ddl.sql. Every table that ddl.sql creates is filled here;
-- nothing is left for a server boot to build (plan §0: the serving container
-- BUILDS NOTHING), so every version stamp is written by this script.
--
-- The four registries are COMPUTED from `work`, never copied from v2026_09:
-- copying imported a live defect (table_usages was 19.5% dangling — 13,682 of
-- 70,071 rows pointing at pre-dedup otbi ids that no corpus row carries). Under
-- sql_hash keying that class of orphan is structurally impossible, and p6 proves
-- it is zero.
-- ============================================================================
\set ON_ERROR_STOP on
SET search_path = v2026_10, work, public;

-- Compact JSON array text (JSON.stringify's shape), for the JSON-in-text columns.
CREATE OR REPLACE FUNCTION work.jarr(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN v IS NULL OR jsonb_typeof(v) <> 'array' THEN '[]'
    ELSE coalesce((SELECT to_json(array_agg(e ORDER BY ord))::text
                   FROM jsonb_array_elements_text(v) WITH ORDINALITY AS t(e, ord)), '[]')
  END;
$fn$;

-- ===========================================================================
-- 1. the corpus
-- ===========================================================================
-- `id` = 'sql:' || sql_hash for EVERY row. That is not a new scheme: it is the
-- identity src/ingest.ts:108 already mints for runtime-staged SQL
-- (`sql:${hashSqlNormalized(sql)}`), and it is byte-identical to the shipped id
-- of all 6,389 bip-report rows. Aligning the vendor corpus with it means a
-- poller push of an already-known statement REPLACES that row instead of
-- duplicating it, and it is what makes a dangling registry impossible.
INSERT INTO v2026_10.report_queries
  (rid, id, source, title, original_sql, clean_sql, description,
   tables_used, joins, filters, lookup_types, security_predicate, approved, reports,
   embedding, intents, mechanics, semantics_json, low_confidence, origin)
SELECT row_number() OVER (ORDER BY c.sql_hash),
       'sql:' || c.sql_hash,
       c.source,
       c.title,
       c.sql_text,
       coalesce(c.rewritten_sql, c.sql_text),
       c.description,
       work.jarr(c.tables_used),
       work.jarr(c.joins),
       work.jarr(c.filters),
       work.jarr(c.lookup_types),
       c.security_predicate,
       c.approved,
       c.reports::text,
       v.embedding,
       work.jarr(c.intents),
       c.mechanics,
       c.semantics_json,
       c.low_confidence,
       'vendor'
FROM   work.clear_sql c
LEFT   JOIN work.embeddings v
       ON v.owner_kind = 'unit' AND v.owner_id = c.sql_hash AND v.slot = 0
ORDER  BY c.sql_hash;

-- one vector row per intent phrasing, in slot order
INSERT INTO v2026_10.report_queries_vec_multi (id, qrowid, embedding)
SELECT row_number() OVER (ORDER BY rq.rid, v.slot), rq.rid, v.embedding
FROM   work.embeddings v
JOIN   v2026_10.report_queries rq ON rq.id = 'sql:' || v.owner_id
WHERE  v.owner_kind = 'unit';

-- the enrich store: the vendor's delivered enrichment, one row per corpus row.
-- (v2026_09 shipped only the 6,389 poller-staged bip rows here; the whole L3 set
-- belongs in it — `description IS NULL` is the PENDING queue and `intents IS NULL`
-- is the re-enrich queue, both of which must be answerable from the release.)
INSERT INTO v2026_10.enrich
  (id, source, title, source_hash, original_sql, clean_sql, description,
   tables_used, lookup_types, joins, filters, security_predicate, approved, reports, intents, mechanics)
SELECT 'sql:' || c.sql_hash, c.source, c.title,
       encode(sha256(convert_to(c.sql_text, 'UTF8')), 'hex'),
       c.sql_text, coalesce(c.rewritten_sql, c.sql_text), c.description,
       work.jarr(c.tables_used), work.jarr(c.lookup_types), work.jarr(c.joins), work.jarr(c.filters),
       c.security_predicate, c.approved, c.reports::text, work.jarr(c.intents), c.mechanics
FROM   work.clear_sql c;

-- ===========================================================================
-- 2. flexfields / ADF extensions
--
-- FLAGGED: these 10,165 + 3,499 rows are OUR demo pod's configuration sitting in
-- a VENDOR schema. src/db/postgres/flex.ts needs them present, so they ship, but
-- they belong in `customer` per install — every customer would otherwise receive
-- our DFF/EFF segment layout as if it were theirs. Carried verbatim; they have no
-- upstream in `work` (their only loader is the admin ingest endpoint).
-- ===========================================================================
INSERT INTO v2026_10.flexfields
  (application_id, flexfield_type, flexfield_code, deployment_status, context_code, context_enabled,
   multirow, translatable, segment_code, column_name, sequence_number, segment_name, prompt,
   display_type, value_set_id, required, segment_enabled, source, loaded_at)
SELECT application_id, flexfield_type, flexfield_code, deployment_status, context_code, context_enabled,
       multirow, translatable, segment_code, column_name, sequence_number, segment_name, prompt,
       display_type, value_set_id, required, segment_enabled, source, loaded_at
FROM   v2026_09.flexfields;

INSERT INTO v2026_10.adf_extensions
  (object_name, table_name, context_column_name, attribute_name, column_name, source, loaded_at,
   display_hint, object_display, field_display)
SELECT object_name, table_name, context_column_name, attribute_name, column_name, source, loaded_at,
       display_hint, object_display, field_display
FROM   v2026_09.adf_extensions;

-- curated table rules: customer-owned, and correctly EMPTY in a vendor release
-- (the one dev row was moved to `customer` on 2026-09-18).
-- facts_meta carries the PARSER PIN: every f_* row, and therefore all four
-- registries, are valid only for this exact sqlglot build.
INSERT INTO v2026_10.facts_meta (k, v) VALUES ('version', '1');
INSERT INTO v2026_10.facts_meta (k, v)
SELECT 'parser_version', 'sqlglot==' || v FROM work.build_meta WHERE k = 'parser_version';

-- ===========================================================================
-- 3. the schema catalog
--
-- compile.ts semantics, reproduced exactly: TABLE/VIEW only, name-deduped with
-- the FUSION schema winning, nn() then decodeXmlEntities() on the text fields,
-- and children kept only for surviving objects — except fkeys, which keep a row
-- if EITHER side survives (compile.ts:173).
-- ===========================================================================
INSERT INTO v2026_10.tables (name, schema, type, module, remarks, view_text)
SELECT DISTINCT ON (work.nn(t.table_name))
       work.nn(t.table_name),
       work.nn(t.table_schem),
       upper(work.nn(t.table_type)),
       work.nn(t.application_short_name),
       work.dec_xml(work.nn(t.remarks)),
       work.dec_xml(work.nn(t.view_text))
FROM   work.meta_tables t
WHERE  upper(coalesce(work.nn(t.table_type), '')) IN ('TABLE', 'VIEW')
  AND  work.nn(t.table_name) IS NOT NULL
-- compile.ts's upsert is "first row wins, unless a later one is FUSION and the
-- incumbent is not" — so: FUSION first, then CSV order. `ctid` IS the CSV order
-- here (a COPY-loaded, never-updated heap).
ORDER  BY work.nn(t.table_name), (t.table_schem = 'FUSION') DESC, t.ctid;

INSERT INTO v2026_10.columns (table_name, name, data_type, size, nullable, remarks, ordinal)
SELECT work.nn(c.table_name), work.nn(c.column_name),
       coalesce(work.nn(c.type_name), work.nn(c.data_type)),
       c.column_size::int,
       (upper(coalesce(work.nn(c.nullable), '')) = 'Y')::int,
       work.dec_xml(work.nn(c.remarks)),
       c.ordinal_position
FROM   work.meta_columns c
WHERE  work.nn(c.column_name) IS NOT NULL
  AND  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = work.nn(c.table_name));

INSERT INTO v2026_10.pkeys (table_name, column_name, seq)
SELECT work.nn(p.table_name), work.nn(p.column_name), p.pkey_sequence
FROM   work.meta_pkeys p
WHERE  work.nn(p.column_name) IS NOT NULL
  AND  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = work.nn(p.table_name));

-- compile.ts reads the CSV's TABLE column as the CHILD and NAMEFULL as the name.
-- (The superseded s8s10.sql used TABLENAME + NAME: the row COUNT matched, but
-- 9,033 of 18,565 child_table values and every `name` value were wrong.)
INSERT INTO v2026_10.fkeys (child_table, parent_table, column_name, seq, name)
SELECT work.nn(f."table"), work.nn(f.foreign_table), work.nn(f.foreign_key_column), f.seq,
       coalesce(work.nn(f.namefull), work.nn(f.name))
FROM   work.meta_fkeys f
WHERE  work.nn(f."table") IS NOT NULL AND work.nn(f.foreign_table) IS NOT NULL
  AND (EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = work.nn(f."table"))
    OR EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = work.nn(f.foreign_table)));

INSERT INTO v2026_10.indexes (table_name, index_name, is_unique, ordinal, column_name)
SELECT work.nn(i.table_name), work.nn(i.index_name),
       (lower(coalesce(work.nn(i.non_unique), '')) = 'false')::int,
       i.ordinal_position, work.nn(i.column_name)
FROM   work.meta_indexes i
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = work.nn(i.table_name));

INSERT INTO v2026_10.relationships
  (from_table, from_col, to_table, to_col, evidence, occurrences, confidence, predicate, source)
SELECT from_table, from_col, to_table, to_col, evidence, occurrences, confidence, predicate, source
FROM   work.relationships;

-- ===========================================================================
-- 4. the four registries — COMPUTED from `work`
-- ===========================================================================

-- ---- table_usages (src/corpus/usageGraph.ts) -------------------------------
-- score = SOURCE_WEIGHT * 100000 + min(sql_chars, 90000);
-- SOURCE_WEIGHT bip-report 3 / view 2 / otbi 1; top 60 per table.
-- The table list is the PARSE's (work.f_tables, CTE names excluded), not the
-- enrichment column the runtime rebuild would read — the parse reaches every
-- source, the enrichment reaches otbi.
INSERT INTO v2026_10.table_usages (table_name, query_id, source, title, sql_chars, score)
SELECT table_name, query_id, source, title, sql_chars, score
FROM (
  SELECT ft.table_name,
         rq.id AS query_id, rq.source, rq.title,
         length(coalesce(rq.clean_sql, rq.original_sql, ''))                    AS sql_chars,
         (CASE rq.source WHEN 'bip-report' THEN 3 WHEN 'view' THEN 2 ELSE 1 END) * 100000
           + least(length(coalesce(rq.clean_sql, rq.original_sql, '')), 90000)  AS score,
         row_number() OVER (PARTITION BY ft.table_name
                            ORDER BY (CASE rq.source WHEN 'bip-report' THEN 3 WHEN 'view' THEN 2 ELSE 1 END) * 100000
                                     + least(length(coalesce(rq.clean_sql, rq.original_sql, '')), 90000) DESC,
                                     rq.id COLLATE "C")                         AS rn
  FROM  (SELECT DISTINCT sql_hash, table_name FROM work.f_tables WHERE NOT is_cte) ft
  JOIN   v2026_10.report_queries rq ON rq.id = 'sql:' || ft.sql_hash
  -- Real objects only. usageGraph.ts does NOT filter (predicateMiner.ts does), and
  -- v2026_09 carries 2,819 such rows; the richer parse would take that to 8,142.
  -- A usage row for an object the dump does not contain is UNREACHABLE — getTableUsages
  -- is only ever called with a name validateTable accepted — so the filter costs nothing
  -- and is what keeps the registry self-consistent.
  WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = ft.table_name)) x
WHERE  rn <= 60;
INSERT INTO v2026_10.usage_meta (k, v) VALUES ('version', '1');

-- ---- table_predicates (src/corpus/predicateMiner.ts) -----------------------
-- Source = work.f_predicates, the PINNED sqlglot parse: <table.column> <op>
-- <literal> with the column alias-resolved through its scope. occurrences =
-- DISTINCT statements (import_serving.mjs's `units.size`, at L3 grain); role =
-- discriminator at >= 8 distinct literals on the column, else structural.
--
-- Two predicateMiner.ts filters are applied on top of the parse — it is the code
-- that READS this table, and both drop things that are not rules:
--   * the LHS must be a real object (an unresolvable name cannot be attributed);
--   * a 6+-digit literal on a *_ID column is one row's id, not a filter idiom.
-- The parse's own `_is_literal` already subsumes predicateMiner's isLiteral(),
-- more precisely (AST node kind, not a regex over text).
INSERT INTO v2026_10.table_predicates (table_name, column_name, op, literal, occurrences, role)
SELECT p.table_name, p.column_name, p.op, left(p.literal, 80) AS literal,
       count(DISTINCT p.sql_hash) AS occurrences,
       CASE WHEN pc.distinct_literals >= 8 THEN 'discriminator' ELSE 'structural' END
FROM   work.f_predicates p
JOIN  (SELECT table_name, column_name, count(DISTINCT left(literal, 80)) AS distinct_literals
       FROM   work.f_predicates q
       WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = q.table_name)
         AND  NOT (q.column_name ~ '_ID$' AND regexp_replace(btrim(q.literal), '^''|''$', '', 'g') ~ '^[0-9]{6,}$')
       GROUP  BY 1, 2) pc
       ON pc.table_name = p.table_name AND pc.column_name = p.column_name
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = p.table_name)
  AND  NOT (p.column_name ~ '_ID$' AND regexp_replace(btrim(p.literal), '^''|''$', '', 'g') ~ '^[0-9]{6,}$')
GROUP  BY p.table_name, p.column_name, p.op, left(p.literal, 80), pc.distinct_literals;
INSERT INTO v2026_10.pred_meta (k, v) VALUES ('version', '1');

-- ---- table_join_columns (scripts/gpu-enrich/import_serving.mjs:177-235) -----
-- column PARTICIPATION share in join conditions: distinct statements joining on
-- (table, column) over distinct statements reading the table; kept at share >= 0.20.
INSERT INTO v2026_10.table_join_columns (table_name, column_name, units, share)
SELECT j.t, j.c, j.units, round((j.units::numeric / d.units), 3)::float8
FROM  (SELECT t, c, count(DISTINCT sql_hash) AS units
       FROM  (SELECT sql_hash, from_t AS t, from_c AS c FROM work.f_joins
              UNION ALL
              SELECT sql_hash, to_t, to_c FROM work.f_joins) s
       WHERE  t IS NOT NULL AND t <> '' AND c IS NOT NULL AND c <> ''
       GROUP  BY 1, 2) j
JOIN  (SELECT table_name, count(DISTINCT sql_hash) AS units
       FROM work.f_tables WHERE NOT is_cte GROUP BY 1) d ON d.table_name = j.t
WHERE  j.units::numeric / d.units >= 0.20
  -- real objects only, same reasoning as table_usages above
  AND  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = j.t);

-- ---- table_grain (src/corpus/grainRegistry.ts) -----------------------------
-- Schema signals from `columns` + corpus corroboration. The flag/revision column
-- is picked by ORDINAL, which is the order columnSignals() scans them in at
-- runtime, so the build and a runtime rebuild classify identically.
CREATE TEMP TABLE grain_sig AS
SELECT c.table_name,
       bool_or(lower(c.name) = 'effective_start_date')                                     AS eff,
       bool_or(lower(c.name) = 'language')                                                 AS lang,
       (array_agg(lower(c.name) ORDER BY c.ordinal)
         FILTER (WHERE lower(c.name) IN ('latest_rec_flag','latest_flag','current_flag','primary_flag')))[1] AS flag,
       (array_agg(lower(c.name) ORDER BY c.ordinal)
         FILTER (WHERE lower(c.name) IN ('revision_number','source_revision_number')))[1]  AS rev
FROM   v2026_10.columns c
WHERE  lower(c.name) IN ('effective_start_date','effective_end_date','latest_rec_flag','latest_flag',
                         'current_flag','primary_flag','revision_number','source_revision_number','language')
GROUP  BY c.table_name;
CREATE INDEX ON grain_sig (table_name);

-- Corpus corroboration: which statements apply a dedup idiom AND read a table whose
-- columns support it. The table attribution is the PARSE's (work.f_tables, CTEs
-- excluded) rather than the enrichment column grainRegistry.ts reads at runtime —
-- same coarse rule, a table list that reaches bip and view instead of otbi only.
CREATE TEMP TABLE grain_ev AS
WITH f AS (
  SELECT c.sql_hash,
         s.sql ~ 'between[\s\S]{0,60}effective_start_date'                        AS has_eff,
         (s.sql ~ 'latest_rec_flag|latest_flag|current_flag') AND (s.sql ~ '=[\s]*''y''') AS has_flag,
         (s.sql ~ 'max[\s]*\([\s]*object_version_number') OR (s.sql ~ 'source_revision_number') AS has_rev
  FROM   work.clear_sql c
  CROSS  JOIN LATERAL (SELECT lower(coalesce(c.rewritten_sql, c.sql_text, '') || ' ' || coalesce(c.sql_text, '')) AS sql) s)
SELECT g.table_name, count(*) AS evidence
FROM   f
JOIN  (SELECT DISTINCT sql_hash, table_name FROM work.f_tables WHERE NOT is_cte) ft
       ON ft.sql_hash = f.sql_hash
JOIN   grain_sig g ON g.table_name = ft.table_name
WHERE  (f.has_eff AND g.eff) OR (f.has_flag AND g.flag IS NOT NULL) OR (f.has_rev AND g.rev IS NOT NULL)
GROUP  BY g.table_name;

INSERT INTO v2026_10.table_grain (table_name, grain, multi_row, dedup, signals, corpus_evidence, note, updated_at)
SELECT s.table_name,
       CASE WHEN s.eff THEN 'effective_dated'
            WHEN s.table_name ~ '_TL$' THEN 'translation'
            WHEN s.flag IS NOT NULL THEN 'latest_flag'
            ELSE 'revision_suspect' END,
       1,
       CASE WHEN s.eff THEN
              'SYSDATE (or :as_of) BETWEEN effective_start_date AND effective_end_date'
              || CASE WHEN s.flag IS NOT NULL THEN ' AND ' || s.flag || ' = ''Y''' ELSE '' END
            WHEN s.table_name ~ '_TL$' THEN
              'LANGUAGE = ''US'' (or ''USERENV'') — or use the sibling _VL view which filters language automatically'
            WHEN s.flag IS NOT NULL THEN s.flag || ' = ''Y'''
            ELSE 'VERIFY grain (COUNT(*) GROUP BY <business key> HAVING COUNT(*)>1); if multi-row, keep the current revision via MAX(object_version_number) OVER (PARTITION BY <key>)'
       END,
       CASE WHEN s.eff THEN
              to_json(ARRAY['effective_start_date','effective_end_date']
                      || CASE WHEN s.flag IS NOT NULL THEN ARRAY[s.flag] ELSE ARRAY[]::text[] END)::text
            WHEN s.table_name ~ '_TL$' THEN
              to_json(ARRAY['_TL'] || CASE WHEN s.lang THEN ARRAY['language'] ELSE ARRAY[]::text[] END)::text
            WHEN s.flag IS NOT NULL THEN to_json(ARRAY[s.flag])::text
            ELSE to_json(ARRAY[s.rev])::text
       END,
       coalesce(e.evidence, 0),
       CASE WHEN s.eff THEN
              'Date-effective table (_F/_M): KEEPS MULTIPLE rows per key across time (open row ends 4712-12-31). '
              || 'Apply the BETWEEN predicate on EVERY date-tracked table in the join — a missing one MULTIPLIES.'
              || CASE WHEN s.flag IS NOT NULL
                      THEN ' This table also has ' || s.flag || ': a key can have several concurrent current rows — add ' || s.flag || '=''Y'' to pick one.'
                      ELSE '' END
            WHEN s.table_name ~ '_TL$' THEN
              'Translation table (_TL): one row PER INSTALLED LANGUAGE per id. Filter LANGUAGE or join the _VL view, else counts inflate by the number of languages.'
            WHEN s.flag IS NOT NULL THEN
              'Versioned table: keeps history; the current/primary row is flagged by ' || s.flag || '=''Y''.'
            ELSE
              'Has ' || s.rev || ' but no standard latest-flag and the corpus rarely dedups it. MAY retain revisions (like DOO_HEADERS_ALL keeping every order revision). Do NOT assume one-row-per-key — verify.'
       END,
       now()::text
FROM   grain_sig s
LEFT   JOIN grain_ev e ON e.table_name = s.table_name
-- a table whose ONLY signal is object_version_number / a bare language column is
-- not a grain signal at all (grainRegistry.ts's `continue`)
WHERE  s.eff OR s.table_name ~ '_TL$' OR s.flag IS NOT NULL OR s.rev IS NOT NULL;
INSERT INTO v2026_10.grain_meta (k, v) VALUES ('version', '4');

-- ===========================================================================
-- 5. the curated layout-pattern corpus (46 git-versioned rows — an INPUT)
-- ===========================================================================
INSERT INTO v2026_10.layout_patterns
  (rid, id, kind, name, format, format_exclusive, dsl_support, description, when_to_use, intents,
   requires, composition, recipe, fixture_ref, pitfalls, trigger, why, instead, alternative,
   source_refs, verified, dsl_version, verified_at)
SELECT rid, id, kind, name, format, format_exclusive, dsl_support, description, when_to_use, intents,
       requires, composition, recipe, fixture_ref, pitfalls, trigger, why, instead, alternative,
       source_refs, verified, dsl_version, verified_at
FROM   work.layout_pattern;

INSERT INTO v2026_10.layout_patterns_vec (id, prowid, embedding)
SELECT row_number() OVER (ORDER BY p.rid, v.slot), p.rid, v.embedding
FROM   work.embeddings v
JOIN   work.layout_pattern p ON p.id = v.owner_id
WHERE  v.owner_kind = 'layout';

-- the hash gate: loadLayoutPatterns() skips the runtime load while this matches
-- the JSONL it would read, which is what keeps the server from rebuilding at boot.
INSERT INTO v2026_10.layout_meta (k, v)
SELECT 'jsonl_hash', max(jsonl_hash) FROM work.layout_pattern;

-- ===========================================================================
-- 6. col_vec — the column-search embedding cache
--
-- Keyed by sha1("NAME: remarks")[:20] (src/corpus/colCache.ts), i.e. a CONTENT
-- hash: an entry stays valid for as long as that column text does, so carrying
-- the warmed entries forward is correct and saves the re-embed. A cold release
-- would simply start empty and warm itself.
-- ===========================================================================
INSERT INTO v2026_10.col_vec (hash, vec) SELECT hash, vec FROM v2026_09.col_vec;

-- ===========================================================================
-- 7. catalog_meta — the /health counters and the version triple.
-- `embedding_version` is what pg-import reads to write meta.seeds.embedding_model,
-- so it must name the model these vectors actually came from.
-- ===========================================================================
INSERT INTO v2026_10.catalog_meta (key, value) VALUES
  ('schema_version',    '2'),
  ('queries_version',   '2'),
  ('embedding_version', 'bge-small-en-v1.5-384'),
  ('ddl_version',       (SELECT v FROM work.build_meta WHERE k = 'ddl_version')),
  ('tables',            (SELECT count(*)::text FROM v2026_10.tables)),
  ('columns',           (SELECT count(*)::text FROM v2026_10.columns)),
  ('fkeys',             (SELECT count(*)::text FROM v2026_10.fkeys)),
  ('relationships',     (SELECT count(*)::text FROM v2026_10.relationships)),
  ('report_queries',    (SELECT count(*)::text FROM v2026_10.report_queries)),
  ('built_at_epoch',    (extract(epoch FROM now()) * 1000)::bigint::text);

-- identity sequences past the explicit keys we inserted
SELECT setval(pg_get_serial_sequence('v2026_10.report_queries', 'rid'),
              coalesce((SELECT max(rid) FROM v2026_10.report_queries), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('v2026_10.report_queries_vec_multi', 'id'),
              coalesce((SELECT max(id) FROM v2026_10.report_queries_vec_multi), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('v2026_10.table_rules', 'id'), 1, false);

ANALYZE v2026_10.report_queries;
ANALYZE v2026_10.report_queries_vec_multi;
ANALYZE v2026_10.tables;
ANALYZE v2026_10.columns;
ANALYZE v2026_10.table_usages;
ANALYZE v2026_10.table_predicates;
ANALYZE v2026_10.table_grain;
