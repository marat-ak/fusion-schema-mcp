\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS work.grounding (
  unit_id     text PRIMARY KEY REFERENCES work.units(unit_id),
  ghash       text NOT NULL,
  inputs_hash text NOT NULL,
  payload     jsonb,
  built_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work.view_dep (
  unit_id    text NOT NULL,
  depends_on text NOT NULL,
  PRIMARY KEY (unit_id, depends_on)
);

CREATE TABLE IF NOT EXISTS work.enrichment (
  unit_id       text NOT NULL,
  ghash         text NOT NULL,
  model         text,
  run_id        text,
  produced_at   timestamptz,
  description   text,
  intents       jsonb,
  mechanics     text,
  rewritten_sql text,
  payload       jsonb,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  PRIMARY KEY (unit_id, ghash)
);

CREATE TABLE IF NOT EXISTS work.round_log (
  sweep int, step text, source text, rows_moved int, at timestamptz DEFAULT now()
);

-- ---------- view -> view dependency edges, derived from FACTS (replaces view_waves) ----------
INSERT INTO work.view_dep (unit_id, depends_on)
SELECT DISTINCT u.unit_id, dv.unit_id
FROM   work.units u
JOIN   work.f_tables ft ON ft.sql_key = u.sql_key
JOIN   work.units dv    ON dv.source = 'view'
                       AND upper(replace(dv.unit_id, 'view:', '')) = upper(ft.table_name)
WHERE  u.source = 'view'
  AND  dv.unit_id <> u.unit_id
ON CONFLICT DO NOTHING;

COMMIT;

-- ================= the sweep loop =================
DO $driver$
DECLARE
  sweep int := 0;
  n_ground int;
  n_enrich int;
  n_view int;
BEGIN
  LOOP
    sweep := sweep + 1;

    -- ---- S4: grounding. A view is eligible only when EVERY view it reads from
    --       already has an enrichment row. Others are eligible as soon as facts exist.
    INSERT INTO work.grounding (unit_id, ghash, inputs_hash, payload)
    SELECT u.unit_id,
           md5(u.sql_key || ':' || f.parser_version),
           md5(u.sql_key || ':' || f.parser_version),
           jsonb_build_object(
             'tables', (SELECT jsonb_agg(DISTINCT ft.table_name)
                        FROM work.f_tables ft WHERE ft.sql_key = u.sql_key),
             'joins',  (SELECT count(*) FROM work.f_joins j WHERE j.sql_key = u.sql_key))
    FROM   work.active_unit u
    JOIN   work.facts_run f ON f.sql_key = u.sql_key
    LEFT   JOIN work.grounding g ON g.unit_id = u.unit_id
    WHERE  g.unit_id IS NULL
      AND  u.excluded_reason IS NULL
      AND  NOT EXISTS (
             SELECT 1 FROM work.view_dep d
             WHERE  d.unit_id = u.unit_id
               AND  NOT EXISTS (SELECT 1 FROM work.enrichment e
                                WHERE e.unit_id = d.depends_on))
    ON CONFLICT (unit_id) DO NOTHING;
    GET DIAGNOSTICS n_ground = ROW_COUNT;

    -- ---- S5: enrich (oracle). 5a rewrite + 5b semantic in one statement.
    INSERT INTO work.enrichment (unit_id, ghash, model, run_id, produced_at,
                                 description, intents, mechanics, rewritten_sql)
    SELECT g.unit_id, g.ghash, 'oracle:v2026_09', NULL, now(),
           rq.description,
           nullif(rq.intents, '')::jsonb,
           rq.mechanics,
           CASE WHEN rq.source = 'otbi'
                 AND rq.clean_sql IS DISTINCT FROM rq.original_sql
                THEN rq.clean_sql END
    FROM   work.grounding g
    JOIN   v2026_09.report_queries rq ON rq.id = g.unit_id
    LEFT   JOIN work.enrichment e ON e.unit_id = g.unit_id AND e.ghash = g.ghash
    WHERE  e.unit_id IS NULL
      AND  rq.description IS NOT NULL AND rq.description <> ''
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n_enrich = ROW_COUNT;

    SELECT count(*) INTO n_view
    FROM   work.enrichment e JOIN work.units u ON u.unit_id = e.unit_id
    WHERE  u.source = 'view';

    INSERT INTO work.round_log (sweep, step, source, rows_moved)
    VALUES (sweep, 'S4_grounding', 'all', n_ground),
           (sweep, 'S5_enrich',    'all', n_enrich),
           (sweep, 'views_total',  'view', n_view);

    RAISE NOTICE 'sweep % : grounding +%  enrich +%  (views enriched total %)',
                 sweep, n_ground, n_enrich, n_view;

    EXIT WHEN n_ground = 0 AND n_enrich = 0;
    EXIT WHEN sweep > 40;   -- safety
  END LOOP;
END
$driver$;

-- ================= the view round distribution =================
SELECT sweep,
       rows_moved - lag(rows_moved) OVER (ORDER BY sweep) AS views_added_this_round,
       rows_moved AS views_total
FROM   work.round_log
WHERE  step = 'views_total'
ORDER  BY sweep;
