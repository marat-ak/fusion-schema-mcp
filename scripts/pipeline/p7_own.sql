-- ============================================================================
-- P7 — ownership. The pipeline runs as `postgres`, so every object it creates is
-- born postgres-owned; the database's own role must own it or the serving role
-- cannot read (and a pg_dump --schema round-trip restores the wrong owner).
-- This is the last act of every build — the previous build shipped without it.
--
-- SCOPE IS EXPLICIT. It re-owns `work` and nothing else unless told otherwise:
--   psql -v schemas='work,v2026_10' -f p7_own.sql
-- A build that only rebuilds `work` must not reach into a release schema it did
-- not produce; ownership is a write, even when the new owner equals the old one.
-- THE OWNER IS EXPLICIT TOO (2026-09-21): `fusion_dev` in the build database, and
-- `fusion` — the serving role — after a restore into the `fusion` database:
--   psql -d fusion -v schemas='v2026_10' -v owner='fusion' -f p7_own.sql
-- ============================================================================
\set ON_ERROR_STOP on

\if :{?schemas}
\else
  \set schemas 'work'
\endif
\if :{?owner}
\else
  \set owner 'fusion_dev'
\endif

DROP TABLE IF EXISTS pg_temp.own_targets;
CREATE TEMP TABLE own_targets(s text);
INSERT INTO own_targets SELECT btrim(unnest(string_to_array(:'schemas', ',')));
DROP TABLE IF EXISTS pg_temp.own_owner;
CREATE TEMP TABLE own_owner(o text);
INSERT INTO own_owner VALUES (:'owner');

DO $own$
DECLARE
  target text := (SELECT o FROM own_owner);
  s text;
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
    RAISE EXCEPTION 'role % does not exist — refusing to guess an owner', target;
  END IF;

  FOR s IN SELECT t.s FROM own_targets t LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN CONTINUE; END IF;
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', s, target);

    -- tables, views, materialized views, sequences
    FOR r IN
      SELECT c.relname, c.relkind
      FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = s AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
        AND  NOT EXISTS (SELECT 1 FROM pg_depend d          -- identity sequences follow their table
                         WHERE d.objid = c.oid AND d.deptype = 'i')
    LOOP
      EXECUTE format('ALTER %s %I.%I OWNER TO %I',
                     CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                                    WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
                     s, r.relname, target);
    END LOOP;

    -- functions (the pipeline's helper library lives in `work`)
    FOR r IN
      SELECT p.oid::regprocedure AS sig
      FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE  n.nspname = s
    LOOP
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.sig, target);
    END LOOP;
  END LOOP;
END
$own$;

-- ================= verify: nothing may be left owned by anyone else =================
SELECT n.nspname AS schema, pg_get_userbyid(c.relowner) AS owner, count(*) AS objects
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname IN (SELECT s FROM own_targets) AND c.relkind IN ('r','v','m','S','p')
GROUP  BY 1, 2 ORDER BY 1, 2;

SELECT n.nspname AS schema, pg_get_userbyid(p.proowner) AS owner, count(*) AS functions
FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname IN (SELECT s FROM own_targets) GROUP BY 1, 2 ORDER BY 1, 2;

SELECT nspname AS schema, pg_get_userbyid(nspowner) AS owner
FROM   pg_namespace WHERE nspname IN (SELECT s FROM own_targets) ORDER BY 1;
