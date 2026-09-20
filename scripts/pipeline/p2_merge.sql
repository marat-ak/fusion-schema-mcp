-- ============================================================================
-- P2 — merge BOTH enrichment generations onto the L3 row, field by field.
--
-- The two generations are COMPLEMENTARY, not successive drafts:
--
--   gen-1  raw.enrichment            109,616 rows  catalog 17,798 / otbi 85,741 /
--                                    view 6,077 / bip-report ZERO.
--                                    HAS filters, lookup_types, security_predicate.
--                                    Has NO intents, NO mechanics.
--   gen-2  v2026_09.report_queries    23,746 rows  bip 6,389 / otbi 11,279 /
--                                    view 6,078 / catalog ZERO.
--                                    HAS intents + mechanics; ships filters,
--                                    lookup_types and security_predicate EMPTY on
--                                    EVERY row.
--
-- Rule: per sql_hash, per FIELD, the newest NON-EMPTY value wins. gen-2 therefore
-- takes description/intents/mechanics/tables_used/joins, and gen-1 fills
-- filters/lookup_types/security_predicate — which is the whole point of the merge:
-- those three columns exist in raw and ship EMPTY in the product today.
--
-- Within one generation several L2 units can map to one hash; the pick is
-- deterministic: non-empty first (the candidate set is already filtered), then
-- the most recent produced_at, then the lowest unit_id. Every winner's unit_id is
-- recorded in a src_* column so provenance stays inspectable.
--
-- SHAPE NOTE: gen-1 `joins` is a DIFFERENT wire shape from gen-2 —
-- [{"from":"T.C","to":"T.C","outer":true}] vs ["T.C=T.C[TYPE]"]. The corpus column
-- has ONE canonical shape, so gen-1 joins are converted to the gen-2 string form
-- (outer -> [OUTER], else [WHERE]) before they can win. No mixed wire ships.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---- emptiness helpers: one definition of "this field carries no information" ----
CREATE OR REPLACE FUNCTION work.je(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN v IS NULL THEN NULL
           WHEN jsonb_typeof(v) = 'null' THEN NULL
           WHEN jsonb_typeof(v) = 'array'  AND jsonb_array_length(v) = 0 THEN NULL
           WHEN jsonb_typeof(v) = 'object' AND v = '{}'::jsonb THEN NULL
           WHEN jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '' THEN NULL
           ELSE v
         END;
$fn$;

CREATE OR REPLACE FUNCTION work.te(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN v IS NULL OR btrim(v) = '' THEN NULL ELSE v END;
$fn$;

-- JSON-in-text (the gen-2 wire shape) -> jsonb, NULL when absent or unparseable.
CREATE OR REPLACE FUNCTION work.as_json(v text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN work.je(v::jsonb);
EXCEPTION WHEN others THEN RETURN NULL;
END;
$fn$;

-- gen-1 join objects -> the canonical gen-2 string form.
CREATE OR REPLACE FUNCTION work.joins_g1_to_g2(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT work.je(
    (SELECT jsonb_agg(DISTINCT (j->>'from') || '=' || (j->>'to') ||
                      '[' || CASE WHEN (j->>'outer')::boolean THEN 'OUTER' ELSE 'WHERE' END || ']')
     FROM jsonb_array_elements(v) j
     WHERE j->>'from' IS NOT NULL AND j->>'to' IS NOT NULL));
$fn$;

-- ---------------------------------------------------------------------------
-- the candidate set: one row per (sql_hash, contributing L2 unit, generation)
-- ---------------------------------------------------------------------------
CREATE TABLE work.enrich_cand (
  sql_hash    text NOT NULL,
  unit_id     text NOT NULL,
  gen         smallint NOT NULL,
  produced_at timestamptz,
  description        text,
  intents            jsonb,
  mechanics          text,
  tables_used        jsonb,
  joins              jsonb,
  filters            jsonb,
  lookup_types       jsonb,
  security_predicate text,
  rewritten_sql      text,
  semantics_json     text,
  low_confidence     integer,
  approved           integer,
  PRIMARY KEY (sql_hash, unit_id, gen)
);

-- gen-1
INSERT INTO work.enrich_cand
SELECT u.sql_hash, e.unit_id, e.generation::smallint, e.produced_at,
       work.te(e.description),
       NULL::jsonb,                       -- gen-1 has no intents
       NULL::text,                        -- gen-1 has no mechanics
       work.je(e.tables_used),
       work.joins_g1_to_g2(e.joins),
       work.je(e.filters),
       work.je(e.lookup_types),
       work.te(e.security_predicate),
       NULL::text, NULL::text, NULL::integer,
       e.approved
FROM   raw.enrichment e
JOIN   work.sql_unit u ON u.unit_id = e.unit_id;

-- gen-2 (the shipped release). produced_at is unknown for this generation.
INSERT INTO work.enrich_cand
SELECT u.sql_hash, r.id, 2::smallint, NULL,
       work.te(r.description),
       work.as_json(r.intents),
       work.te(r.mechanics),
       work.as_json(r.tables_used),
       work.as_json(r.joins),
       work.as_json(r.filters),
       work.as_json(r.lookup_types),
       work.te(r.security_predicate),
       -- the Qwen rewrite: an enrichment OUTPUT, kept only where it really differs
       CASE WHEN r.source = 'otbi' AND r.clean_sql IS DISTINCT FROM r.original_sql
            THEN work.te(r.clean_sql) END,
       work.te(r.semantics_json),
       r.low_confidence,
       r.approved
FROM   v2026_09.report_queries r
JOIN   work.sql_unit u ON u.unit_id = r.id;

CREATE INDEX ix_enrich_cand_hash ON work.enrich_cand (sql_hash);

-- ---------------------------------------------------------------------------
-- the pick: newest non-empty wins, per field.
-- ORDER BY gen DESC, produced_at DESC NULLS LAST, unit_id
-- ---------------------------------------------------------------------------
CREATE TABLE work.clear_pick AS
WITH h AS (SELECT sql_hash FROM work.clear_sql),
pick AS (
  SELECT h.sql_hash,
    (SELECT c.description FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.description IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS description,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.description IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_description,
    (SELECT c.gen         FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.description IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS gen_description,
    (SELECT c.intents     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.intents IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS intents,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.intents IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_intents,
    (SELECT c.mechanics   FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.mechanics IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS mechanics,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.mechanics IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_mechanics,
    (SELECT c.tables_used FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.tables_used IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS tables_used,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.tables_used IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_tables_used,
    (SELECT c.gen         FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.tables_used IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS gen_tables_used,
    (SELECT c.joins       FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.joins IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS joins,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.joins IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_joins,
    (SELECT c.gen         FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.joins IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS gen_joins,
    (SELECT c.filters     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.filters IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS filters,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.filters IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_filters,
    (SELECT c.lookup_types FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.lookup_types IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS lookup_types,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.lookup_types IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_lookup_types,
    (SELECT c.security_predicate FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.security_predicate IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS security_predicate,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.security_predicate IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_security_predicate,
    (SELECT c.rewritten_sql FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.rewritten_sql IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS rewritten_sql,
    (SELECT c.unit_id     FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.rewritten_sql IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS src_rewritten_sql,
    (SELECT c.semantics_json FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.semantics_json IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS semantics_json,
    (SELECT c.low_confidence FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash AND c.low_confidence IS NOT NULL
      ORDER BY c.gen DESC, c.produced_at DESC NULLS LAST, c.unit_id LIMIT 1)            AS low_confidence,
    -- approved: a row is approved unless EVERY contributing generation said otherwise
    (SELECT max(c.approved) FROM work.enrich_cand c WHERE c.sql_hash=h.sql_hash)        AS approved
  FROM h)
SELECT * FROM pick;

ALTER TABLE work.clear_pick ADD PRIMARY KEY (sql_hash);

UPDATE work.clear_sql c SET
  description        = p.description,
  intents            = p.intents,
  mechanics          = p.mechanics,
  tables_used        = p.tables_used,
  joins              = p.joins,
  filters            = p.filters,
  lookup_types       = p.lookup_types,
  security_predicate = p.security_predicate,
  rewritten_sql      = p.rewritten_sql,
  semantics_json     = p.semantics_json,
  low_confidence     = p.low_confidence,
  approved           = coalesce(p.approved, 1),
  src_description        = p.src_description,
  src_intents            = p.src_intents,
  src_mechanics          = p.src_mechanics,
  src_tables_used        = p.src_tables_used,
  src_joins              = p.src_joins,
  src_filters            = p.src_filters,
  src_lookup_types       = p.src_lookup_types,
  src_security_predicate = p.src_security_predicate,
  src_rewritten_sql      = p.src_rewritten_sql,
  gen_description        = p.gen_description,
  gen_tables_used        = p.gen_tables_used,
  gen_joins              = p.gen_joins
FROM work.clear_pick p WHERE p.sql_hash = c.sql_hash;

-- the enrich queue: everything that still has no v2 semantics
CREATE INDEX ix_clear_sql_enrich_queue ON work.clear_sql (source) WHERE intents IS NULL;

-- ================= verify =================
\echo '--- candidates by generation ---'
SELECT gen, count(*) AS rows, count(DISTINCT sql_hash) AS hashes FROM work.enrich_cand GROUP BY 1 ORDER BY 1;

\echo '--- gen-1 provenance gap: produced_at / model are uniformly NULL in raw.enrichment ---'
SELECT count(*) AS gen1_rows,
       count(produced_at) AS with_produced_at,
       count(*) FILTER (WHERE model IS NOT NULL) AS with_model
FROM   raw.enrichment;

\echo '--- coverage of the merged L3 row ---'
SELECT count(*)                                            AS l3_rows,
       count(description)                                  AS has_description,
       count(intents)                                      AS has_intents,
       count(mechanics)                                    AS has_mechanics,
       count(tables_used)                                  AS has_tables_used,
       count(joins)                                        AS has_joins,
       count(filters)                                      AS has_filters,
       count(lookup_types)                                 AS has_lookup_types,
       count(security_predicate)                           AS has_security_predicate,
       count(rewritten_sql)                                AS has_rewritten_sql,
       count(*) FILTER (WHERE intents IS NULL)             AS enrich_queue
FROM   work.clear_sql;

\echo '--- THE RECOVERY: fields that ship EMPTY in v2026_09 and are non-empty now ---'
SELECT 'filters'            AS field, count(*) FILTER (WHERE filters IS NOT NULL)            AS recovered,
       (SELECT count(*) FROM v2026_09.report_queries WHERE filters IS NOT NULL AND filters NOT IN ('','[]')) AS in_v2026_09
FROM   work.clear_sql
UNION ALL SELECT 'lookup_types', count(*) FILTER (WHERE lookup_types IS NOT NULL),
       (SELECT count(*) FROM v2026_09.report_queries WHERE lookup_types IS NOT NULL AND lookup_types NOT IN ('','[]')) FROM work.clear_sql
UNION ALL SELECT 'security_predicate', count(*) FILTER (WHERE security_predicate IS NOT NULL),
       (SELECT count(*) FROM v2026_09.report_queries WHERE security_predicate IS NOT NULL AND security_predicate <> '') FROM work.clear_sql
UNION ALL SELECT 'rewritten_sql', count(*) FILTER (WHERE rewritten_sql IS NOT NULL), NULL FROM work.clear_sql;

\echo '--- which generation won each field ---'
SELECT 'description' AS field, gen_description AS gen, count(*) FROM work.clear_sql GROUP BY 1,2
UNION ALL SELECT 'tables_used', gen_tables_used, count(*) FROM work.clear_sql GROUP BY 1,2
UNION ALL SELECT 'joins', gen_joins, count(*) FROM work.clear_sql GROUP BY 1,2
ORDER BY 1,2;

\echo '--- the enrich queue (intents IS NULL) by source ---'
SELECT source, count(*) FROM work.clear_sql WHERE intents IS NULL GROUP BY 1 ORDER BY 1;

\echo '--- descriptions byte-identical to v2026_09 where gen-2 won ---'
SELECT count(*) AS gen2_description_rows,
       count(*) FILTER (WHERE c.description = r.description) AS byte_identical,
       count(*) FILTER (WHERE c.description IS DISTINCT FROM r.description) AS differs
FROM   work.clear_sql c
JOIN   v2026_09.report_queries r ON r.id = c.src_description
WHERE  c.gen_description = 2;
