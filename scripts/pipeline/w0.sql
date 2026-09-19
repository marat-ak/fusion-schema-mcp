\set ON_ERROR_STOP on
BEGIN;

CREATE SCHEMA IF NOT EXISTS work;

-- ---------- metadata: straight copy, unfiltered (all five TABLE_TYPEs retained) ----------
CREATE TABLE work.meta_tables  AS SELECT * FROM raw.meta_tables;
CREATE TABLE work.meta_columns AS SELECT * FROM raw.meta_columns;
CREATE TABLE work.meta_pkeys   AS SELECT * FROM raw.meta_pkeys;
CREATE TABLE work.meta_fkeys   AS SELECT * FROM raw.meta_fkeys;
CREATE TABLE work.meta_indexes AS SELECT * FROM raw.meta_indexes;

-- ---------- OTBI: identity split back apart; physical_sql is what became original_sql ----------
CREATE TABLE work.otbi_item AS
SELECT split_part(substr(unit_id, 6), '__', 1) AS subject_area,
       nullif(substr(substr(unit_id, 6),
                     position('__' in substr(unit_id, 6)) + 2), '') AS table_name,
       original_sql AS physical_sql
FROM   raw.sql_units
WHERE  source = 'otbi';

-- ---------- BIP: the datamodel path + its SQL ----------
CREATE TABLE work.bip_sql AS
SELECT u.title AS file_path, u.original_sql AS sql
FROM   raw.sql_units u
WHERE  u.source IN ('bip-report', 'catalog');

CREATE TABLE work.bip_ref AS
SELECT r.unit_id AS legacy_unit_id, r.path, r.title, r.idx
FROM   raw.unit_refs r;

COMMIT;

-- ---------- verify ----------
SELECT 'meta_tables'  AS t, count(*) FROM work.meta_tables
UNION ALL SELECT 'meta_columns', count(*) FROM work.meta_columns
UNION ALL SELECT 'meta_pkeys',   count(*) FROM work.meta_pkeys
UNION ALL SELECT 'meta_fkeys',   count(*) FROM work.meta_fkeys
UNION ALL SELECT 'meta_indexes', count(*) FROM work.meta_indexes
UNION ALL SELECT 'otbi_item',    count(*) FROM work.otbi_item
UNION ALL SELECT 'bip_sql',      count(*) FROM work.bip_sql
UNION ALL SELECT 'bip_ref',      count(*) FROM work.bip_ref
ORDER BY 1;

-- otbi ids with no '__' separator (expect 2: BU_Recipient, Contracts)
SELECT 'otbi_no_separator' AS check, count(*) FROM work.otbi_item WHERE table_name IS NULL;
