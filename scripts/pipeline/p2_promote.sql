-- ============================================================================
-- P2b — put the Qwen generation-2 enrichment on the L3 row.
--
-- Three things happen here, in order:
--
--   1. ID MAPPING.  The JSONL ids are the OLD unit ids (view:<NAME>, sql:<sha256>,
--      otbi:<subject>__<item>). They are L2 identities; everything downstream keys
--      on sql_hash, so each record is mapped through work.sql_unit.
--
--   2. COLLISION.   Several Qwen records can land on ONE sql_hash — two views with
--      byte-identical SQL, otbi canonicals that share a statement, a bip datamodel
--      that is also in the catalog archive. One record must win, deterministically:
--
--          ok DESC                              a successful call beats a failed one
--          (unit_id = primary_unit_id) DESC     the unit L3 already named as primary
--          unit_id ASC                          total order, no ties left
--
--      The winner's unit_id, file and ghash are recorded in src_enrich_*, and
--      n_enrich_units says how many records the hash had to choose between.
--
--   3. PROMOTION.   Columns are promoted OUT of the payload; the payload itself
--      stays whole in work.qwen_record.payload and is never rewritten. Promotion is
--      a convenience index over it, not a filter: all 23 fields get a column.
--
-- The parser corrections (tablesConfirmed / extraTables / missingTables) are loaded
-- and made joinable in work.qwen_table_correction. They are NOT applied to work.f_*
-- — whether the model may overrule sqlglot is a separate decision, and this build
-- deliberately leaves both sides visible instead of silently merging them.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1 + 2 — map and pick
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS work.qwen_map CASCADE;
CREATE TABLE work.qwen_map AS
SELECT r.unit_id,
       u.sql_hash,
       u.source AS l2_source,
       r.ok,
       (r.unit_id = c.primary_unit_id) AS is_primary_unit
FROM   work.qwen_record r
JOIN   work.sql_unit   u ON u.unit_id  = r.unit_id
JOIN   work.clear_sql  c ON c.sql_hash = u.sql_hash;

ALTER TABLE work.qwen_map ADD PRIMARY KEY (unit_id);
CREATE INDEX ix_qwen_map_hash ON work.qwen_map (sql_hash);

DROP TABLE IF EXISTS work.qwen_pick CASCADE;
CREATE TABLE work.qwen_pick AS
SELECT m.sql_hash,
       w.unit_id,
       m.n_units AS n_enrich_units
FROM  (SELECT sql_hash, count(*) AS n_units FROM work.qwen_map GROUP BY 1) m
JOIN  LATERAL (
        SELECT q.unit_id
        FROM   work.qwen_map q
        WHERE  q.sql_hash = m.sql_hash
        ORDER  BY q.ok DESC, q.is_primary_unit DESC, q.unit_id
        LIMIT  1) w ON true;

ALTER TABLE work.qwen_pick ADD PRIMARY KEY (sql_hash);
CREATE INDEX ix_qwen_pick_unit ON work.qwen_pick (unit_id);

-- ---------------------------------------------------------------------------
-- 3 — promote
--
-- Scalars land as text/boolean, every list lands as jsonb. work.je() maps the
-- schema's "nothing to say" spellings ('' / [] / {}) to NULL, so a NULL column
-- means the model had nothing, and a non-NULL column is always informative.
-- outputGrain is free text, not an enum: 'row', 'item-level', 'single aggregate
-- value' and ~2,000 other spellings all occur. It is promoted as written.
-- ---------------------------------------------------------------------------
UPDATE work.clear_sql c SET
  description      = work.te(r.payload->>'description'),
  title_human      = work.te(r.payload->>'titleHuman'),
  domain           = work.te(r.payload->>'domain'),
  output_grain     = work.te(r.payload->>'outputGrain'),
  view_advice      = work.te(r.payload->>'viewAdvice'),
  rewritten_sql    = work.te(r.payload->>'rewrittenSql'),
  tables_confirmed = CASE WHEN jsonb_typeof(r.payload->'tablesConfirmed') = 'boolean'
                          THEN (r.payload->>'tablesConfirmed')::boolean END,
  intents          = work.je(r.payload->'intents'),
  tags             = work.je(r.payload->'tags'),
  security         = work.je(r.payload->'security'),
  params           = work.je(r.payload->'params'),
  language         = work.je(r.payload->'language'),
  grain_handling   = work.je(r.payload->'grainHandling'),
  date_logic       = work.je(r.payload->'dateLogic'),
  flexfield        = work.je(r.payload->'flexfield'),
  plsql_functions  = work.je(r.payload->'plsqlFunctions'),
  computed_columns = work.je(r.payload->'computedColumns'),
  current_row      = work.je(r.payload->'currentRow'),
  quality_flags    = work.je(r.payload->'qualityFlags'),
  missing_remarks  = work.je(r.payload->'missingRemarks'),
  flex_missed      = work.je(r.payload->'flexMissed'),
  extra_tables     = work.je(r.payload->'extraTables'),
  missing_tables   = work.je(r.payload->'missingTables'),
  src_enrich_unit  = r.unit_id,
  src_enrich_file  = r.src_file,
  src_enrich_ghash = r.ghash,
  n_enrich_units   = p.n_enrich_units,
  enrich_ok        = r.ok,
  enrich_error     = r.error
FROM   work.qwen_pick p
JOIN   work.qwen_record r ON r.unit_id = p.unit_id
WHERE  p.sql_hash = c.sql_hash;

CREATE INDEX IF NOT EXISTS ix_clear_sql_enrich_queue ON work.clear_sql (source) WHERE src_enrich_unit IS NULL;
CREATE INDEX IF NOT EXISTS ix_clear_sql_ghash        ON work.clear_sql (src_enrich_ghash) WHERE src_enrich_ghash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- the model's parser corrections, as rows you can join to work.f_tables.
-- LOADED, not applied. `extra` = the model says sqlglot listed a table the SQL
-- does not really use; `missing` = the model says a used table is absent from the
-- facts. tables_confirmed=false on the L3 row is the summary flag.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS work.qwen_table_correction CASCADE;
CREATE TABLE work.qwen_table_correction (
  sql_hash   text NOT NULL,
  unit_id    text NOT NULL,
  kind       text NOT NULL,        -- extra | missing
  table_name text NOT NULL
);

INSERT INTO work.qwen_table_correction (sql_hash, unit_id, kind, table_name)
SELECT p.sql_hash, r.unit_id, k.kind, upper(btrim(v.t))
FROM   work.qwen_pick p
JOIN   work.qwen_record r ON r.unit_id = p.unit_id
CROSS  JOIN LATERAL (VALUES ('extra', 'extraTables'), ('missing', 'missingTables')) k(kind, key)
CROSS  JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(r.payload->k.key) = 'array' THEN r.payload->k.key ELSE '[]'::jsonb END) v(t)
WHERE  btrim(v.t) <> '';

CREATE INDEX ix_qwen_corr_hash  ON work.qwen_table_correction (sql_hash);
CREATE INDEX ix_qwen_corr_table ON work.qwen_table_correction (table_name, kind);
ANALYZE work.qwen_table_correction;
ANALYZE work.clear_sql;

-- ================= verify =================
\echo '--- the load: records, ids, ghash ---'
SELECT count(*)                                        AS records,
       count(*) FILTER (WHERE ok)                      AS ok,
       count(*) FILTER (WHERE NOT ok)                  AS ends_on_failure,
       count(*) FILTER (WHERE n_lines > 1)             AS retried_ids,
       sum(n_lines) - count(*)                         AS superseded_lines,
       count(ghash)                                    AS with_ghash,
       count(payload)                                  AS with_payload
FROM   work.qwen_record;

\echo '--- per primary file ---'
SELECT src_file, count(*) AS ids, count(*) FILTER (WHERE ok) AS ok,
       count(ghash) AS with_ghash, sum(n_lines) AS lines
FROM   work.qwen_record GROUP BY 1 ORDER BY 1;

\echo '--- id mapping: every JSONL id must reach an L2 unit and an L3 hash ---'
SELECT (SELECT count(*) FROM work.qwen_record)                     AS jsonl_ids,
       (SELECT count(*) FROM work.qwen_map)                        AS mapped_to_l3,
       (SELECT count(*) FROM work.qwen_record r
        WHERE NOT EXISTS (SELECT 1 FROM work.sql_unit u WHERE u.unit_id = r.unit_id)) AS unmapped;

\echo '--- collisions: hashes that had more than one Qwen record ---'
SELECT n_enrich_units, count(*) AS hashes
FROM   work.qwen_pick GROUP BY 1 ORDER BY 1;

\echo '--- how collisions were resolved (winner vs the records it beat) ---'
SELECT count(*) FILTER (WHERE p.n_enrich_units > 1)                        AS colliding_hashes,
       count(*) FILTER (WHERE p.n_enrich_units > 1 AND m.is_primary_unit)  AS won_as_primary_unit,
       count(*) FILTER (WHERE p.n_enrich_units > 1 AND NOT m.ok)           AS winner_is_a_failed_record
FROM   work.qwen_pick p JOIN work.qwen_map m ON m.unit_id = p.unit_id;

\echo '--- L3 enrichment coverage by source ---'
SELECT source,
       count(*)                                          AS statements,
       count(src_enrich_unit)                            AS enriched,
       count(*) FILTER (WHERE src_enrich_unit IS NULL)   AS no_gen2_record,
       count(src_enrich_ghash)                           AS with_ghash
FROM   work.clear_sql GROUP BY 1 ORDER BY 1;

\echo '--- the uncovered queue: SQL + parse facts, enrichment NULL ---'
SELECT c.source, c.l2_sources, count(*) AS statements,
       round(avg(length(c.sql_text)))   AS avg_sql_chars,
       max(length(c.sql_text))          AS max_sql_chars
FROM   work.clear_sql c WHERE c.src_enrich_unit IS NULL
GROUP  BY 1, 2 ORDER BY 3 DESC;

\echo '--- promoted column coverage (L3 grain, non-empty) ---'
SELECT count(*)                       AS l3_rows,
       count(description)             AS description,
       count(intents)                 AS intents,
       count(title_human)             AS title_human,
       count(domain)                  AS domain,
       count(output_grain)            AS output_grain,
       count(view_advice)             AS view_advice,
       count(rewritten_sql)           AS rewritten_sql,
       count(tags)                    AS tags
FROM   work.clear_sql;

SELECT count(security)         AS security,
       count(params)           AS params,
       count(language)         AS language,
       count(grain_handling)   AS grain_handling,
       count(date_logic)       AS date_logic,
       count(flexfield)        AS flexfield,
       count(plsql_functions)  AS plsql_functions,
       count(computed_columns) AS computed_columns,
       count(current_row)      AS current_row,
       count(quality_flags)    AS quality_flags,
       count(missing_remarks)  AS missing_remarks,
       count(flex_missed)      AS flex_missed
FROM   work.clear_sql;

\echo '--- the parser corrections: loaded, not applied ---'
SELECT count(*) FILTER (WHERE tables_confirmed IS FALSE) AS tables_confirmed_false,
       count(extra_tables)                               AS rows_with_extra_tables,
       count(missing_tables)                             AS rows_with_missing_tables
FROM   work.clear_sql;

SELECT kind, count(*) AS corrections, count(DISTINCT sql_hash) AS statements,
       count(DISTINCT table_name) AS objects
FROM   work.qwen_table_correction GROUP BY 1 ORDER BY 1;

\echo '--- ghash: the incremental key. otbi only — views/bip predate the field ---'
SELECT r.source, count(*) AS records, count(r.ghash) AS with_ghash,
       count(DISTINCT r.ghash) AS distinct_ghash
FROM   work.qwen_record r GROUP BY 1 ORDER BY 1;
