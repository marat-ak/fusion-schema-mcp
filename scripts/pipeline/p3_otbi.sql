-- ============================================================================
-- P3o-b — derive the OTBI presentation catalog in `work` from the staged sources
-- (p3_otbi_load.py): work.otbi_subject_area / otbi_folder / otbi_column / otbi_text.
--
-- Universe = lineage workbooks ∪ SOAP crawl (folders and columns), names VERBATIM.
-- Every fact carries where it came from:
--   db_refs      [{t, c, src:[lineage|probe|crawl]}] — the workbook's DATABASE_OBJECT/COLUMN, the
--                physical-SQL alias resolution (p3_otbi_load.py), and the crawler's own column
--                lineage (kept as a third voice: its alias→base map collides across OBIS lookup
--                subqueries, so it is never preferred over the other two)
--   kind         measure ⟺ an aggregate function sits on the column's alias chain in the probe SQL
--   description  NO LLM: a real remark reached through db_refs (table column remark from the vendor
--                dictionary; view column remark from work.view_column_remarks), or the referenced
--                remarks of a derived expression; else NULL and `gap_cause` says why.
--   text         what p4 embeds: column text carries NO subject area / folder, so identical columns
--                across subject areas share ONE vector (work.otbi_text is keyed by md5(text)).
-- Descriptions of FOLDERS are the existing otbi-unit enrichment (work.clear_sql.description reached
-- through the unit titled `<SA>.<Folder>`), never re-derived.
-- ============================================================================
\set ON_ERROR_STOP on
SET search_path = work, public;

-- a remark equal to the column name (spaces/underscores/case ignored) is not a meaning
CREATE OR REPLACE FUNCTION work.otbi_junk_remark(remark text, col text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT remark IS NULL OR btrim(remark) = ''
      OR lower(regexp_replace(remark, '[^A-Za-z0-9]+', '', 'g')) = lower(regexp_replace(col, '[^A-Za-z0-9]+', '', 'g'));
$fn$;

-- the folder → corpus-unit join is by title; work.sql_unit only carries hash/source indexes
CREATE INDEX IF NOT EXISTS ix_sql_unit_title ON work.sql_unit (title);

-- ---------------------------------------------------------------- 1. folders: lineage ∪ crawl
DROP TABLE IF EXISTS pg_temp.lin_folder;
CREATE TEMP TABLE lin_folder AS
SELECT subject_area, pres_table AS name,
       string_agg(DISTINCT pillar, ',' ORDER BY pillar) AS pillar,
       count(DISTINCT pres_column) AS n_lin_columns
FROM   work.otbi_lineage GROUP BY 1, 2;
CREATE UNIQUE INDEX ON lin_folder (subject_area, name);

DROP TABLE IF EXISTS work.otbi_folder;
CREATE TABLE work.otbi_folder (
  subject_area text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL,            -- fact | dimension
  kind_source  text NOT NULL,            -- measures | name | default
  description  text,
  desc_source  text,                     -- otbi-unit enrichment (work.clear_sql) | NULL
  db_tables    jsonb NOT NULL DEFAULT '[]',
  n_columns    int NOT NULL DEFAULT 0,
  n_measures   int NOT NULL DEFAULT 0,
  in_lineage   boolean NOT NULL,
  in_crawl     boolean NOT NULL,
  in_corpus    boolean NOT NULL,
  probe_status text,
  has_sql      boolean,
  unit_id      text,
  sql_hash     text,
  nested       boolean NOT NULL,         -- a `A > B > C` extension-folder path (crawl only)
  ship         boolean NOT NULL DEFAULT false, -- in the vendor release (the SCOPE rule, step 1b)
  ordinal      int,
  text         text,
  text_hash    text,
  PRIMARY KEY (subject_area, name)
);

INSERT INTO work.otbi_folder (subject_area, name, kind, kind_source, in_lineage, in_crawl, in_corpus, nested, ordinal,
                              probe_status, has_sql, unit_id, sql_hash, description, desc_source)
SELECT f.subject_area, f.name, 'dimension', 'default',
       l.subject_area IS NOT NULL, c.subject_area IS NOT NULL, u.unit_id IS NOT NULL,
       f.name LIKE '% > %', c.ordinal,
       p.status, p.has_sql, u.unit_id, u.sql_hash, cs.description,
       CASE WHEN cs.description IS NOT NULL THEN 'otbi-unit enrichment' END
FROM  (SELECT subject_area, name FROM lin_folder
       UNION
       SELECT subject_area, pres_table FROM work.otbi_crawl_folder) f
LEFT JOIN lin_folder l USING (subject_area, name)
LEFT JOIN work.otbi_crawl_folder c ON c.subject_area = f.subject_area AND c.pres_table = f.name
LEFT JOIN work.otbi_probe p ON p.subject_area = f.subject_area AND p.pres_table = f.name
LEFT JOIN LATERAL (SELECT u.unit_id, u.sql_hash FROM work.sql_unit u
                   WHERE u.source = 'otbi' AND u.title = f.subject_area || '.' || f.name
                   ORDER BY length(u.original_sql) DESC LIMIT 1) u ON TRUE
LEFT JOIN work.clear_sql cs ON cs.sql_hash = u.sql_hash;

-- ---------------------------------------------------------------- 1b. SCOPE — what the vendor release ships
-- The crawl enumerates our demo pod's WHOLE presentation layer: 2.09M columns, of which ~1.6M sit
-- in per-pod extension content — `A > B > C` paths (custom-object / EFF trees flattened by the
-- crawler), flat `… Extension` / `… Custom Attributes` folders (~976 ExtnAttribute placeholders
-- each) and `custExt<uuid>` subject areas (App Composer custom objects). That is customer
-- configuration, not vendor content (the same standing as flexfields/adf_extensions). The workbooks
-- are NOT the complete vendor folder list — they document DB-mapped columns only, so a vendor folder
-- without a DB mapping (`Learning Record Measures`, `Expense Lines`, `Benefit Plan`: 6,971 flat
-- crawl-only folders across 539 workbook subject areas, 5,862 of them with a corpus unit) is absent
-- from them and MUST still ship. The rule, in ONE place, reported in data/otbi_reconciliation.md:
--   ship = NOT a nested path
--      AND NOT a `custExt<uuid>` subject area
--      AND NOT (a crawl-only folder whose name says Extension / Custom Attributes)
-- Columns ship with their folder (a crawl-only column inside a lineage folder — a DFF segment on a
-- vendor folder — ships).
UPDATE work.otbi_folder f
SET    ship = NOT f.nested
           AND f.subject_area NOT LIKE 'custExt%'
           AND NOT (NOT f.in_lineage AND f.name ~* '\m(extension|custom attributes)\M');

-- ---------------------------------------------------------------- 2. columns: lineage ∪ crawl ∪ probe
DROP TABLE IF EXISTS pg_temp.lin_col;
CREATE TEMP TABLE lin_col AS
SELECT subject_area, pres_table AS folder, pres_column AS name,
       bool_or(indexed = 'YES') AS indexed,
       -- DB refs, root-AM fan-out collapsed: the same DATABASE_OBJECT.COLUMN reached through several
       -- VO paths is ONE ref
       coalesce((SELECT jsonb_agg(jsonb_build_object('t', t, 'c', c) ORDER BY t, c)
                 FROM (SELECT DISTINCT db_object AS t, db_column AS c FROM work.otbi_lineage x
                       WHERE x.subject_area = o.subject_area AND x.pres_table = o.pres_table AND x.pres_column = o.pres_column
                         AND x.db_object IS NOT NULL AND x.db_column IS NOT NULL) r), '[]'::jsonb) AS refs,
       coalesce((SELECT jsonb_agg(v ORDER BY v)
                 FROM (SELECT DISTINCT regexp_replace(vo_path, '^(CrmAnalyticsAM|FscmTopModelAM|HcmTopModelAnalyticsGlobalAM)\.', '') AS v
                       FROM work.otbi_lineage x
                       WHERE x.subject_area = o.subject_area AND x.pres_table = o.pres_table AND x.pres_column = o.pres_column
                         AND x.vo_path IS NOT NULL) r), '[]'::jsonb) AS vo_refs
FROM   work.otbi_lineage o
GROUP  BY 1, 2, 3;
CREATE UNIQUE INDEX ON lin_col (subject_area, folder, name);

DROP TABLE IF EXISTS pg_temp.probe_col;
CREATE TEMP TABLE probe_col AS
SELECT DISTINCT ON (subject_area, pres_table, logical_column)
       subject_area, pres_table AS folder, logical_column AS name, ordinal,
       aggregation, expression, expr_refs,
       CASE WHEN base_table IS NOT NULL AND base_column IS NOT NULL AND resolved
            THEN jsonb_build_array(jsonb_build_object('t', base_table, 'c', base_column)) ELSE '[]'::jsonb END AS crawl_refs
FROM   work.otbi_probe_column
ORDER  BY subject_area, pres_table, logical_column, ordinal;
CREATE UNIQUE INDEX ON probe_col (subject_area, folder, name);

DROP TABLE IF EXISTS work.otbi_column;
CREATE TABLE work.otbi_column (
  subject_area text NOT NULL,
  folder       text NOT NULL,
  name         text NOT NULL,
  data_type    text,                     -- crawl
  kind         text NOT NULL,            -- attribute | measure
  aggregation  text,                     -- sum | count | count distinct | min | max | avg
  expression   text,                     -- the resolved physical expression when it is not one plain column
  db_refs      jsonb NOT NULL DEFAULT '[]',   -- [{t, c, src:[…]}]
  vo_refs      jsonb NOT NULL DEFAULT '[]',
  indexed      boolean NOT NULL DEFAULT false,
  description  text,
  desc_source  text,                     -- table_remark | view_remark | expression_remarks | NULL
  gap_cause    text,                     -- NULL when described
  in_lineage   boolean NOT NULL,
  in_crawl     boolean NOT NULL,
  in_probe     boolean NOT NULL,
  ordinal      int,
  text         text,
  text_hash    text,
  PRIMARY KEY (subject_area, folder, name)
);

INSERT INTO work.otbi_column (subject_area, folder, name, data_type, kind, aggregation, expression, db_refs, vo_refs, indexed,
                              in_lineage, in_crawl, in_probe, ordinal)
SELECT u.subject_area, u.folder, u.name, c.data_type,
       CASE WHEN p.aggregation IS NOT NULL THEN 'measure' ELSE 'attribute' END,
       p.aggregation, p.expression,
       -- lineage ∪ probe ∪ crawl refs, one object per (t, c) with every source that named it
       coalesce((SELECT jsonb_agg(jsonb_build_object('t', t, 'c', c, 'src', src) ORDER BY ord)
                 FROM (SELECT t, c, jsonb_agg(src ORDER BY src) AS src, min(ord) AS ord
                       FROM (SELECT e->>'t' AS t, e->>'c' AS c, 'lineage' AS src, 10 + o AS ord
                             FROM jsonb_array_elements(coalesce(l.refs, '[]'::jsonb)) WITH ORDINALITY x(e, o)
                             UNION ALL
                             SELECT split_part(e, '.', 1), split_part(e, '.', 2), 'probe', o
                             FROM jsonb_array_elements_text(coalesce(p.expr_refs, '[]'::jsonb)) WITH ORDINALITY x(e, o)
                             WHERE e LIKE '%.%'
                             UNION ALL
                             SELECT e->>'t', e->>'c', 'crawl', 100 + o
                             FROM jsonb_array_elements(coalesce(p.crawl_refs, '[]'::jsonb)) WITH ORDINALITY x(e, o)) s
                       GROUP BY t, c) g), '[]'::jsonb),
       coalesce(l.vo_refs, '[]'::jsonb),
       coalesce(l.indexed, false),
       l.subject_area IS NOT NULL, c.subject_area IS NOT NULL, p.subject_area IS NOT NULL,
       coalesce(c.ordinal, p.ordinal)
FROM  (SELECT subject_area, folder, name FROM lin_col
       UNION
       SELECT subject_area, pres_table, pres_column FROM work.otbi_crawl_column
       UNION
       SELECT subject_area, folder, name FROM probe_col) u
LEFT JOIN lin_col l ON l.subject_area = u.subject_area AND l.folder = u.folder AND l.name = u.name
LEFT JOIN work.otbi_crawl_column c ON c.subject_area = u.subject_area AND c.pres_table = u.folder AND c.pres_column = u.name
LEFT JOIN probe_col p ON p.subject_area = u.subject_area AND p.folder = u.folder AND p.name = u.name;

-- ---------------------------------------------------------------- 3. remarks reachable through db_refs
DROP TABLE IF EXISTS pg_temp.ref_remark;
CREATE TEMP TABLE ref_remark AS
WITH refs AS (
  SELECT DISTINCT e->>'t' AS t, e->>'c' AS c FROM work.otbi_column, jsonb_array_elements(db_refs) e
)
SELECT r.t, r.c,
       CASE WHEN tr.remark IS NOT NULL THEN 'table_remark' WHEN vr.remark IS NOT NULL THEN 'view_remark' END AS src,
       coalesce(tr.remark, vr.remark) AS remark
FROM   refs r
LEFT JOIN LATERAL (
  SELECT work.dec_xml(work.nn(m.remarks)) AS remark
  FROM   work.meta_columns m
  WHERE  m.table_name = r.t AND m.column_name = r.c
    AND  NOT work.otbi_junk_remark(work.dec_xml(work.nn(m.remarks)), r.c)
  LIMIT 1) tr ON TRUE
LEFT JOIN LATERAL (
  SELECT v.remark
  FROM   work.view_column_remarks v
  WHERE  v.view_name = r.t AND v.column_name = r.c AND v.kind IN ('passthrough', 'computed')
    AND  NOT work.otbi_junk_remark(v.remark, r.c)
  ORDER  BY v.seq DESC LIMIT 1) vr ON TRUE;
CREATE UNIQUE INDEX ON ref_remark (t, c);

-- the remark line of a column: first ref (lineage first, then probe, then crawl) that has one;
-- a derived expression lists the remarks of every referenced column (up to 4)
DROP TABLE IF EXISTS pg_temp.col_desc;
CREATE TEMP TABLE col_desc AS
SELECT oc.subject_area, oc.folder, oc.name,
       (SELECT jsonb_build_object('src', rr.src, 'text', rr.remark || ' (' || rr.t || '.' || rr.c || ')')
        FROM   jsonb_array_elements(oc.db_refs) WITH ORDINALITY x(e, o)
        JOIN   ref_remark rr ON rr.t = e->>'t' AND rr.c = e->>'c'
        WHERE  rr.remark IS NOT NULL
        ORDER  BY o LIMIT 1) AS first_remark,
       (SELECT string_agg(rr.t || '.' || rr.c || ': ' || rr.remark, '; ' ORDER BY o)
        FROM  (SELECT e, o FROM jsonb_array_elements(oc.db_refs) WITH ORDINALITY x(e, o) ORDER BY o LIMIT 4) y
        JOIN   ref_remark rr ON rr.t = y.e->>'t' AND rr.c = y.e->>'c'
        WHERE  rr.remark IS NOT NULL) AS ref_remarks,
       (SELECT count(*) FROM jsonb_array_elements(oc.db_refs)) AS n_refs
FROM   work.otbi_column oc;
CREATE UNIQUE INDEX ON col_desc (subject_area, folder, name);

UPDATE work.otbi_column oc
SET    description = CASE
         WHEN oc.expression IS NOT NULL AND d.ref_remarks IS NOT NULL THEN oc.expression || ' — ' || d.ref_remarks
         WHEN d.first_remark IS NOT NULL THEN d.first_remark->>'text'
       END,
       desc_source = CASE
         WHEN oc.expression IS NOT NULL AND d.ref_remarks IS NOT NULL THEN 'expression_remarks'
         WHEN d.first_remark IS NOT NULL THEN d.first_remark->>'src'
       END
FROM   col_desc d
WHERE  d.subject_area = oc.subject_area AND d.folder = oc.folder AND d.name = oc.name;

-- why a column has no description — ONE cause, in this order
UPDATE work.otbi_column oc
SET    gap_cause = CASE
         WHEN oc.description IS NOT NULL THEN NULL
         WHEN p.subject_area IS NULL THEN 'no_probe'                                            -- folder never probed (lineage-only, or crawl folder the probe run did not reach)
         WHEN p.status IS DISTINCT FROM 'Successful Completion' THEN 'failed_probe'             -- nQSError / null status
         WHEN NOT p.has_sql THEN 'empty_sql_folder'                                             -- OBIS returned no physical SQL (GL Balances "Balances")
         WHEN p.alias_mismatch THEN 'alias_mismatch'                                            -- outer projection ≠ logical column count
         WHEN d.n_refs = 0 THEN 'unresolved_lineage'                                            -- no DB column reached by any source
         WHEN oc.expression IS NOT NULL THEN 'derived_no_remarks'                               -- expression, but none of its columns has a remark
         ELSE 'ref_without_remark'                                                              -- a DB column, but the dictionary / view remarks have nothing for it
       END
FROM   col_desc d
LEFT JOIN work.otbi_probe p ON p.subject_area = d.subject_area AND p.pres_table = d.folder
WHERE  d.subject_area = oc.subject_area AND d.folder = oc.folder AND d.name = oc.name;

-- ---------------------------------------------------------------- 4. folder roll-ups
UPDATE work.otbi_folder f
SET    n_columns  = s.n, n_measures = s.m,
       kind       = CASE WHEN s.m > 0 THEN 'fact'
                         WHEN f.name ~* '\m(fact|facts|amount|amounts|measure|measures|metrics|count|counts|balance|balances|total|totals|quantity|quantities|statistics)\M' THEN 'fact'
                         ELSE 'dimension' END,
       kind_source = CASE WHEN s.m > 0 THEN 'measures'
                          WHEN f.name ~* '\m(fact|facts|amount|amounts|measure|measures|metrics|count|counts|balance|balances|total|totals|quantity|quantities|statistics)\M' THEN 'name'
                          ELSE 'default' END,
       db_tables  = s.tables
FROM  (SELECT subject_area, folder, count(*) AS n, count(*) FILTER (WHERE kind = 'measure') AS m,
              coalesce((SELECT jsonb_agg(t ORDER BY t) FROM (SELECT DISTINCT e->>'t' AS t FROM work.otbi_column x, jsonb_array_elements(x.db_refs) e
                                                            WHERE x.subject_area = c.subject_area AND x.folder = c.folder) q), '[]'::jsonb) AS tables
       FROM   work.otbi_column c GROUP BY 1, 2) s
WHERE  s.subject_area = f.subject_area AND s.folder = f.name;

-- ---------------------------------------------------------------- 5. subject areas
DROP TABLE IF EXISTS work.otbi_subject_area;
CREATE TABLE work.otbi_subject_area (
  name           text PRIMARY KEY,
  pillar         text,
  n_folders      int NOT NULL,
  n_fact_folders int NOT NULL,
  n_columns      int NOT NULL,
  fact_folders   jsonb NOT NULL DEFAULT '[]',
  in_lineage     boolean NOT NULL,
  in_crawl       boolean NOT NULL,
  in_corpus      boolean NOT NULL,
  text           text,
  text_hash      text
);
INSERT INTO work.otbi_subject_area (name, pillar, n_folders, n_fact_folders, n_columns, fact_folders, in_lineage, in_crawl, in_corpus)
SELECT f.subject_area,
       (SELECT string_agg(DISTINCT pillar, ',' ORDER BY pillar) FROM lin_folder l WHERE l.subject_area = f.subject_area),
       count(*), count(*) FILTER (WHERE kind = 'fact'), sum(n_columns),
       coalesce(jsonb_agg(name ORDER BY name) FILTER (WHERE kind = 'fact'), '[]'::jsonb),
       bool_or(in_lineage), bool_or(in_crawl), bool_or(in_corpus)
FROM   work.otbi_folder f GROUP BY 1;

-- ---------------------------------------------------------------- 6. embedding texts (dedup by md5)
UPDATE work.otbi_column
SET    text = name || CASE WHEN kind = 'measure' THEN ' (measure' || coalesce(', ' || aggregation, '') || ')' ELSE '' END
              || CASE WHEN description IS NOT NULL THEN ': ' || left(description, 500) ELSE '' END;
UPDATE work.otbi_column SET text_hash = md5(text);

UPDATE work.otbi_folder f
SET    text = f.subject_area || ' > ' || f.name || ' (' || f.kind || ')'
              || CASE WHEN f.description IS NOT NULL THEN ': ' || left(f.description, 400) ELSE '' END
              || coalesce(' Columns: ' || c.cols, '')
FROM  (SELECT subject_area, folder, string_agg(name, ', ' ORDER BY ordinal NULLS LAST, name) AS cols
       FROM  (SELECT subject_area, folder, name, ordinal, row_number() OVER (PARTITION BY subject_area, folder ORDER BY ordinal NULLS LAST, name) rn
              FROM work.otbi_column) x WHERE rn <= 40 GROUP BY 1, 2) c
WHERE  c.subject_area = f.subject_area AND c.folder = f.name;
UPDATE work.otbi_folder SET text = subject_area || ' > ' || name || ' (' || kind || ')' WHERE text IS NULL;
UPDATE work.otbi_folder SET text_hash = md5(text);

UPDATE work.otbi_subject_area s
SET    text = s.name || coalesce(' (' || s.pillar || ')', '') || ': ' || s.n_folders || ' folders'
              || CASE WHEN s.n_fact_folders > 0 THEN '; facts: ' || (SELECT string_agg(x, ', ') FROM (SELECT jsonb_array_elements_text(s.fact_folders) x LIMIT 20) q) ELSE '' END
              || coalesce('; folders: ' || f.names, '')
FROM  (SELECT subject_area, string_agg(name, ', ' ORDER BY nested, ordinal NULLS LAST, name) AS names
       FROM  (SELECT subject_area, name, nested, ordinal, row_number() OVER (PARTITION BY subject_area ORDER BY nested, ordinal NULLS LAST, name) rn
              FROM work.otbi_folder) x WHERE rn <= 60 GROUP BY 1) f
WHERE  f.subject_area = s.name;
UPDATE work.otbi_subject_area SET text_hash = md5(text);

-- the texts p4 embeds: SHIPPED entities only (the scope rule above), one row per distinct text
DROP TABLE IF EXISTS work.otbi_text;
CREATE TABLE work.otbi_text (text_hash text PRIMARY KEY, kind text NOT NULL, text text NOT NULL);
INSERT INTO work.otbi_text (text_hash, kind, text)
SELECT text_hash, min(kind), min(text) FROM (
  SELECT c.text_hash, 'column' AS kind, c.text
  FROM   work.otbi_column c JOIN work.otbi_folder f ON f.subject_area = c.subject_area AND f.name = c.folder WHERE f.ship
  UNION ALL SELECT text_hash, 'folder', text FROM work.otbi_folder WHERE ship
  UNION ALL SELECT s.text_hash, 'subject_area', s.text FROM work.otbi_subject_area s
  WHERE  EXISTS (SELECT 1 FROM work.otbi_folder f WHERE f.subject_area = s.name AND f.ship)) x
GROUP BY text_hash;

CREATE INDEX ON work.otbi_column (text_hash);
CREATE INDEX ON work.otbi_column (subject_area, folder);
CREATE INDEX ON work.otbi_folder (text_hash);
ANALYZE work.otbi_subject_area; ANALYZE work.otbi_folder; ANALYZE work.otbi_column; ANALYZE work.otbi_text;

-- ---------------------------------------------------------------- 7. the build line
SELECT 'subject_areas' AS entity, count(*) AS rows, count(*) FILTER (WHERE in_lineage) AS in_lineage, count(*) FILTER (WHERE in_crawl) AS in_crawl,
       count(*) FILTER (WHERE in_corpus) AS in_corpus, NULL::bigint AS described,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM work.otbi_folder f WHERE f.subject_area = s.name AND f.ship)) AS shipped
FROM   work.otbi_subject_area s
UNION ALL
SELECT 'folders', count(*), count(*) FILTER (WHERE in_lineage), count(*) FILTER (WHERE in_crawl), count(*) FILTER (WHERE in_corpus),
       count(*) FILTER (WHERE description IS NOT NULL), count(*) FILTER (WHERE ship) FROM work.otbi_folder
UNION ALL
SELECT 'columns', count(*), count(*) FILTER (WHERE c.in_lineage), count(*) FILTER (WHERE c.in_crawl), count(*) FILTER (WHERE c.in_probe),
       count(*) FILTER (WHERE c.description IS NOT NULL), count(*) FILTER (WHERE f.ship)
FROM   work.otbi_column c JOIN work.otbi_folder f ON f.subject_area = c.subject_area AND f.name = c.folder
UNION ALL
SELECT 'texts (distinct, shipped, to embed)', count(*), count(*) FILTER (WHERE kind = 'column'), count(*) FILTER (WHERE kind = 'folder'),
       count(*) FILTER (WHERE kind = 'subject_area'), NULL, count(*) FROM work.otbi_text;
