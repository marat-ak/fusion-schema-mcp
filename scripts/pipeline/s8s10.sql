\set ON_ERROR_STOP on
BEGIN;

DROP SCHEMA IF EXISTS v2026_10 CASCADE;
CREATE SCHEMA v2026_10;

-- ---------- S8: corpus ----------
CREATE TABLE v2026_10.report_queries AS
SELECT row_number() OVER (ORDER BY u.unit_id)   AS rid,
       u.unit_id                                 AS id,
       u.source, u.title, u.original_sql,
       coalesce(e.rewritten_sql, u.original_sql) AS clean_sql,
       e.description,
       (SELECT jsonb_agg(DISTINCT ft.table_name)
        FROM   work.f_tables ft WHERE ft.sql_key = u.sql_key)::text AS tables_used,
       (SELECT jsonb_agg(j.from_t || '.' || j.from_c || '=' ||
                         j.to_t   || '.' || j.to_c   ||
                         '[' || coalesce(j.join_type, 'WHERE') || ']')
        FROM   work.f_joins j WHERE j.sql_key = u.sql_key)::text    AS joins,
       e.intents::text AS intents,
       e.mechanics,
       (SELECT v.embedding FROM work.embeddings v
        WHERE  v.owner_kind='unit' AND v.owner_id=u.unit_id AND v.slot=0) AS embedding
FROM   work.active_unit u
JOIN   work.enrichment e ON e.unit_id = u.unit_id
WHERE  u.excluded_reason IS NULL;

ALTER TABLE v2026_10.report_queries ADD PRIMARY KEY (rid);
CREATE UNIQUE INDEX ON v2026_10.report_queries (id);

CREATE TABLE v2026_10.report_queries_vec_multi AS
SELECT row_number() OVER (ORDER BY rq.rid, v.slot) AS id,
       rq.rid AS qrowid, v.embedding
FROM   work.embeddings v
JOIN   v2026_10.report_queries rq ON rq.id = v.owner_id
WHERE  v.owner_kind = 'unit';

-- ---------- S8: schema side (remarks XML-decoded, FUSION wins name collisions) ----------
CREATE TABLE v2026_10.tables AS
SELECT DISTINCT ON (t.table_name)
       t.table_name                AS name,
       t.table_schem               AS schema,
       t.table_type                AS type,
       t.application_short_name    AS module,
       work.dec_xml(nullif(btrim(t.remarks), '')) AS remarks,
       work.dec_xml(nullif(btrim(t.view_text), '')) AS view_text
FROM   work.meta_tables t
WHERE  t.table_type IN ('TABLE', 'VIEW')
ORDER  BY t.table_name, (t.table_schem = 'FUSION') DESC;

CREATE UNIQUE INDEX ON v2026_10.tables (name);

CREATE TABLE v2026_10.columns AS
SELECT c.table_name, c.column_name AS name, c.type_name AS data_type,
       c.column_size::int AS size,
       (upper(coalesce(c.nullable,'')) = 'Y')::int AS nullable,
       work.dec_xml(nullif(btrim(c.remarks), '')) AS remarks,
       c.ordinal_position AS ordinal
FROM   work.meta_columns c
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = c.table_name);

CREATE TABLE v2026_10.pkeys AS
SELECT p.table_name, p.column_name, p.pkey_sequence AS seq
FROM   work.meta_pkeys p
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = p.table_name);

-- fkeys: keep the row if EITHER side survives (compile.ts:173)
CREATE TABLE v2026_10.fkeys AS
SELECT f.tablename AS child_table, f.foreign_table AS parent_table,
       f.foreign_key_column AS column_name, f.seq, f.name
FROM   work.meta_fkeys f
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = f.tablename)
   OR  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = f.foreign_table);

CREATE TABLE v2026_10.indexes AS
SELECT i.table_name, i.index_name,
       (upper(coalesce(i.non_unique,'')) <> 'TRUE')::int AS is_unique,
       i.ordinal_position AS ordinal, i.column_name
FROM   work.meta_indexes i
WHERE  EXISTS (SELECT 1 FROM v2026_10.tables t WHERE t.name = i.table_name);

CREATE TABLE v2026_10.relationships AS
SELECT from_table, from_col, to_table, to_col, evidence,
       occurrences, confidence, predicate, source
FROM   work.relationships;

-- ---------- S9: registries (oracle-filled; work.f_predicates is empty in emulation) ----------
CREATE TABLE v2026_10.table_predicates   AS SELECT * FROM v2026_09.table_predicates;
CREATE TABLE v2026_10.table_join_columns AS SELECT * FROM v2026_09.table_join_columns;
CREATE TABLE v2026_10.table_usages       AS SELECT * FROM v2026_09.table_usages;
CREATE TABLE v2026_10.table_grain        AS SELECT * FROM v2026_09.table_grain;

-- version stamps: MUST be written by the build, never left to a server boot
CREATE TABLE v2026_10.pred_meta  (k text PRIMARY KEY, v text);
CREATE TABLE v2026_10.usage_meta (k text PRIMARY KEY, v text);
CREATE TABLE v2026_10.grain_meta (k text PRIMARY KEY, v text);
INSERT INTO v2026_10.pred_meta  VALUES ('version','1');
INSERT INTO v2026_10.usage_meta VALUES ('version','1');
INSERT INTO v2026_10.grain_meta VALUES ('version','4');

CREATE TABLE v2026_10.catalog_meta (key text PRIMARY KEY, value text);
INSERT INTO v2026_10.catalog_meta VALUES
  ('tables',        (SELECT count(*)::text FROM v2026_10.tables)),
  ('columns',       (SELECT count(*)::text FROM v2026_10.columns)),
  ('fkeys',         (SELECT count(*)::text FROM v2026_10.fkeys)),
  ('relationships', (SELECT count(*)::text FROM v2026_10.relationships)),
  ('built_at',      now()::text);

COMMIT;

-- ---------- S10: indexes ----------
CREATE INDEX ON v2026_10.columns          (table_name);
CREATE INDEX ON v2026_10.pkeys            (table_name);
CREATE INDEX ON v2026_10.fkeys            (child_table);
CREATE INDEX ON v2026_10.indexes          (table_name);
CREATE INDEX ON v2026_10.table_predicates (table_name);
CREATE INDEX ON v2026_10.table_usages     (table_name, score DESC);
CREATE INDEX ON v2026_10.report_queries_vec_multi (qrowid);

ALTER TABLE v2026_10.tables ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple',
    coalesce(name,'') || ' ' || coalesce(remarks,''))) STORED;
CREATE INDEX ON v2026_10.tables USING gin (search);

-- ================= the gate =================
SELECT 'report_queries' AS t,
       (SELECT count(*) FROM v2026_10.report_queries) AS built,
       (SELECT count(*) FROM v2026_09.report_queries) AS baseline
UNION ALL SELECT 'tables',   (SELECT count(*) FROM v2026_10.tables),   (SELECT count(*) FROM v2026_09.tables)
UNION ALL SELECT 'columns',  (SELECT count(*) FROM v2026_10.columns),  (SELECT count(*) FROM v2026_09.columns)
UNION ALL SELECT 'pkeys',    (SELECT count(*) FROM v2026_10.pkeys),    (SELECT count(*) FROM v2026_09.pkeys)
UNION ALL SELECT 'fkeys',    (SELECT count(*) FROM v2026_10.fkeys),    (SELECT count(*) FROM v2026_09.fkeys)
UNION ALL SELECT 'indexes',  (SELECT count(*) FROM v2026_10.indexes),  (SELECT count(*) FROM v2026_09.indexes)
UNION ALL SELECT 'relationships', (SELECT count(*) FROM v2026_10.relationships), (SELECT count(*) FROM v2026_09.relationships)
UNION ALL SELECT 'vec_multi', (SELECT count(*) FROM v2026_10.report_queries_vec_multi), (SELECT count(*) FROM v2026_09.report_queries_vec_multi);

-- descriptions byte-identical for every shared id?
SELECT 'desc_differs' AS check, count(*) FROM v2026_10.report_queries a
JOIN   v2026_09.report_queries b USING (id)
WHERE  a.description IS DISTINCT FROM b.description;

-- id set comparison
SELECT (SELECT count(*) FROM v2026_10.report_queries a
        WHERE NOT EXISTS (SELECT 1 FROM v2026_09.report_queries b WHERE b.id=a.id)) AS only_in_built,
       (SELECT count(*) FROM v2026_09.report_queries b
        WHERE NOT EXISTS (SELECT 1 FROM v2026_10.report_queries a WHERE a.id=b.id)) AS only_in_baseline;
