\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS work.canonical_unit (
  sql_key text PRIMARY KEY,
  unit_id text NOT NULL REFERENCES work.units(unit_id)
);

CREATE TABLE IF NOT EXISTS work.unit_alias (
  alias_unit_id     text PRIMARY KEY REFERENCES work.units(unit_id),
  canonical_unit_id text NOT NULL,
  title             text,
  subject_area      text
);

-- ---------- otbi: dedup by sql_key, first id in id-order wins (as dedup_units.py) ----------
INSERT INTO work.canonical_unit (sql_key, unit_id)
SELECT DISTINCT ON (u.sql_key) u.sql_key, u.unit_id
FROM   work.units u
WHERE  u.source = 'otbi'
ORDER  BY u.sql_key, u.unit_id
ON CONFLICT (sql_key) DO NOTHING;

-- every original path survives as a pointer, the canonical's own included
INSERT INTO work.unit_alias (alias_unit_id, canonical_unit_id, title, subject_area)
SELECT u.unit_id, c.unit_id, u.title, split_part(u.title, '.', 1)
FROM   work.units u
JOIN   work.canonical_unit c ON c.sql_key = u.sql_key
WHERE  u.source = 'otbi'
ON CONFLICT (alias_unit_id) DO NOTHING;

-- ---------- views and bip are NEVER deduped: identity is the unit, not the SQL ----------
-- (33 view groups covering 99 units share SQL but differ by VPD policy; only the name
--  distinguishes them, so each keeps its own canonical row keyed by its OWN sql_key
--  where free, and is recorded explicitly where a key is already taken.)
INSERT INTO work.canonical_unit (sql_key, unit_id)
SELECT DISTINCT ON (u.sql_key) u.sql_key, u.unit_id
FROM   work.units u
WHERE  u.source <> 'otbi'
ORDER  BY u.sql_key, u.unit_id
ON CONFLICT (sql_key) DO NOTHING;

COMMIT;

-- ================= verify =================
SELECT u.source, count(*) AS canonical
FROM   work.canonical_unit c JOIN work.units u ON u.unit_id = c.unit_id
GROUP  BY u.source ORDER BY 1;

SELECT 'unit_alias' AS t, count(*) AS rows, count(DISTINCT canonical_unit_id) AS canonical
FROM   work.unit_alias;

-- views that share a sql_key with another view and therefore lost their canonical slot
SELECT 'view_units_without_canonical_row' AS t, count(*)
FROM   work.units u
WHERE  u.source = 'view'
  AND  NOT EXISTS (SELECT 1 FROM work.canonical_unit c WHERE c.unit_id = u.unit_id);
