-- ============================================================================
-- P5f — data-access security facts of a release schema (ddl_version 10).
--
-- Fills {{V}}.table_security / table_disallowed / sec_area_privilege / table_reference_family / sec_meta. {{V}} and the curated
-- rules (scripts/pipeline/p5_security_rules.json, verbatim, at the placeholder line) are substituted by p5_security.sh. ONE transaction, DELETE then INSERT, on the
-- release being BUILT (after p5_fill.sql — it reads the release's own dictionary — before
-- p5_index.sql). NOT a repair tool: a built release is immutable; a release that lacks the facts,
-- or needs a rule / policy extract changed, gets a new label through the full chain.
--
-- NAMES ONLY (spec 2026-10-02 §7): no predicate text and no pod id is computed or stored here. The
-- release ships the context column -> reference object map (table_security), the curated area ->
-- (object, privilege) map with its (area, entity) keys (sec_area_privilege) and sec_meta; nothing of
-- any customer pod (ddl_version 9: the pod export copies sec_object / sec_privilege are gone — what
-- differs per pod lives ONLY in the customer layer); the condition itself is
-- produced on the TARGET pod at SQL-generation time by FND_DATA_SECURITY.GET_SECURITY_PREDICATE.
--
-- Inputs: the release dictionary {{V}}.tables / columns / pkeys / fkeys (the projection of
-- work.meta_* the serving side knows), the pinned parse facts work.f_joins / r_tables, the view
-- pass-through lineage work.view_column_remarks, the statement text work.clear_sql (URDA
-- precedent), the corpus-usage sources (below), the rules JSON and Oracle's own seeded data-security
-- policies (oracle_datasec_policies.csv — a LOCAL, gitignored input read from a pod: instance-set
-- predicate text; staged by p5_security.sh at /tmp/p5policy.csv and read by psql's \copy; only the
-- parse result's names reach the release). Order (spec 2026-09-29 §5, analysis
-- "Recommendations for Step 2", plan 2026-09-30 R1-R6, Oracle policy 2026-09-30):
--   exclusions -> exact names -> suffixes (never %_SET_ID) -> ORACLE POLICY (the top source: a
--   column Oracle filters by a URDA context column takes that context, every other candidate of
--   the column goes) -> ORGANIZATION_ID chain -> curated overrides (add | set | none)
--   -> unresolved columns: USED object => 'ambiguous' rows (the p6 gate fails the release),
--   UNUSED object => table_disallowed -> evidence / confidence -> primary flag -> the area map
--   -> the reference families (ddl_version 10: lookup / calendar / currency / territory / translation by name
--   pattern AND reference-shaped columns, each row with its evidence; the end-user none rule reads them)
--   -> the sensitive objects -> sec_meta (incl. the audited primary contexts, the sensitive objects,
--   every policy row's parse and the module families, for the report).
-- The ORGANIZATION_ID chain, per column, first signal wins, a resolved column is final:
--   Oracle policy on the column -> FK parent family -> module family (an object without its own
--   policy: its application's org context, derived from the policies' instance-set codes)
--   -> [vote] -> own prefix family -> [vote] -> sibling columns -> [vote]
--   -> HCM lineage (an unresolved view column passing an HCM column through is excluded)
--   -> own id space (R4) -> non-org partners only (R5) -> unresolved.
-- [vote] = a fixpoint over the columns resolved so far (name rules + chain): a column passed
-- through by / passing through a pass-through view column takes that column's context (view
-- lineage, R3); else its corpus join partners' COLUMN contexts vote by statements (R2); majority
-- wins, a tie goes to the object's own prefix family, else the column is tied (unresolved).
-- EVERY detected context column is a row (the facts); is_primary marks the ONE context the table-keyed
-- plan secures — for a table with several context columns only when its name prefix carries an audited
-- primary (rules primaryByPrefix.<prefix>.audit -> sec_meta.primary_audit; plan 2026-10-04 decision 1).
-- Every rule-named object/column must exist in {{V}} — a typo fails the build, never a
-- silent no-op.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE sec_rules (j jsonb) ON COMMIT DROP;
INSERT INTO sec_rules VALUES ($rules$
{{RULES}}
$rules$::jsonb);

-- Oracle's seeded data-security policies: FND_OBJECTS x FND_OBJECT_INSTANCE_SETS whose predicate uses
-- FUN_USER_ROLE_DATA_ASGNMNTS (predicates cut at 1,000 characters by the extract)
CREATE TEMP TABLE sec_pol_raw (table_name text, obj_name text, instance_set_name text, predicate text) ON COMMIT DROP;
\copy sec_pol_raw FROM '/tmp/p5policy.csv' WITH (FORMAT csv, HEADER true)

-- ---- 1. the twelve URDA contexts -------------------------------------------------------
CREATE TEMP TABLE sec_ctx ON COMMIT DROP AS
SELECT x.c->>'context' AS context, x.c->>'urda' AS urda_column,
       split_part(x.c->>'ref', '.', 1) AS ref_object, split_part(x.c->>'ref', '.', 2) AS ref_column,
       ARRAY(SELECT jsonb_array_elements_text(x.c->'evidenceRefs')) AS evidence_refs,
       x.o::int AS ord
FROM   sec_rules r, jsonb_array_elements(r.j->'contexts') WITH ORDINALITY AS x(c, o);

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT m, ', ') INTO bad FROM (
    SELECT c.ref_object || '.' || c.ref_column AS m FROM sec_ctx c
    WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.columns x WHERE x.table_name = c.ref_object AND x.name = c.ref_column)
    UNION ALL
    SELECT e FROM sec_ctx c, unnest(c.evidence_refs) e
    WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = e)
    UNION ALL
    SELECT 'unknown context ' || ctx FROM (
      SELECT e->>'context' AS ctx FROM sec_rules r, jsonb_array_elements(r.j->'exactNames') e
      UNION SELECT s->>'context' FROM sec_rules r, jsonb_array_elements(r.j->'suffixes') s
      UNION SELECT o->>'context' FROM sec_rules r, jsonb_array_elements(r.j->'overrides') o
      UNION SELECT d.key FROM sec_rules r, jsonb_each(r.j#>'{organizationId,domains}') d
      UNION SELECT a FROM sec_rules r, jsonb_array_elements_text(r.j#>'{organizationId,ambiguousCandidates}') a
      UNION SELECT v FROM sec_rules r, jsonb_each(r.j->'primaryByPrefix') p, jsonb_array_elements_text(p.value->'contexts') v
             WHERE p.key NOT LIKE '\_%'
      UNION SELECT c FROM sec_rules r, jsonb_array_elements_text(r.j#>'{moduleFamilies,contexts}') c
      UNION SELECT m->>'context' FROM sec_rules r, jsonb_array_elements(r.j#>'{moduleFamilies,judgment}') m) u
    WHERE ctx NOT IN (SELECT context FROM sec_ctx)
    UNION ALL
    SELECT 'oraclePolicy.standardSetCode missing' FROM sec_rules r WHERE coalesce(r.j#>>'{oraclePolicy,standardSetCode}', '') = ''
    UNION ALL
    SELECT 'oraclePolicy.standardSetCode ' || (r.j#>>'{oraclePolicy,standardSetCode}') || ' is also a catalog application'
    FROM   sec_rules r WHERE EXISTS (SELECT 1 FROM {{V}}.tables t WHERE upper(t.module) = r.j#>>'{oraclePolicy,standardSetCode}')
    UNION ALL
    SELECT 'moduleFamilies.contexts missing' FROM sec_rules r WHERE jsonb_array_length(coalesce(r.j#>'{moduleFamilies,contexts}', '[]')) = 0
    UNION ALL
    SELECT 'moduleFamilies judgment ' || coalesce(m->>'app', 'null') || ': ' ||
           CASE WHEN coalesce(m->>'reason', '') = '' THEN 'no reason'
                WHEN NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE upper(t.module) = m->>'app') THEN 'not a catalog application'
                ELSE 'context ' || coalesce(m->>'context', 'null') || ' not in moduleFamilies.contexts' END
    FROM   sec_rules r, jsonb_array_elements(r.j#>'{moduleFamilies,judgment}') m
    WHERE  coalesce(m->>'reason', '') = '' OR NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE upper(t.module) = m->>'app')
       OR  NOT (r.j#>'{moduleFamilies,contexts}') ? coalesce(m->>'context', '')
    UNION ALL
    SELECT 'Oracle policy extract (oracle_datasec_policies.csv) is empty' WHERE NOT EXISTS (SELECT 1 FROM sec_pol_raw)
    UNION ALL
    SELECT 'Oracle policy row with an empty field: ' || coalesce(table_name, '?') || ' / ' || coalesce(instance_set_name, '?') FROM sec_pol_raw
    WHERE  coalesce(btrim(table_name), '') = '' OR coalesce(btrim(obj_name), '') = '' OR coalesce(btrim(instance_set_name), '') = '' OR coalesce(btrim(predicate), '') = ''
    UNION ALL
    SELECT 'Oracle policy instance set listed twice: ' || upper(btrim(table_name)) || ' / ' || upper(btrim(instance_set_name)) FROM sec_pol_raw
    GROUP  BY upper(btrim(table_name)), upper(btrim(instance_set_name)) HAVING count(*) > 1
    UNION ALL
    SELECT 'URDA column ' || c.urda_column || ' of context ' || c.context || ' is not in FUN_USER_ROLE_DATA_ASGNMNTS' FROM sec_ctx c
    WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.columns x WHERE x.table_name = 'FUN_USER_ROLE_DATA_ASGNMNTS' AND x.name = c.urda_column)
    UNION ALL
    SELECT 'override op ' || coalesce(o->>'op', 'null') || ' not supported (add | set | none)' FROM sec_rules r, jsonb_array_elements(r.j->'overrides') o
    WHERE  coalesce(o->>'op', '') NOT IN ('add', 'set', 'none')
    UNION ALL
    SELECT 'override ' || (o->>'op') || ' on ' || (o->>'table') || '.' || (o->>'column') ||
           CASE WHEN o->>'op' = 'none' THEN ' carries a context' ELSE ' has no context' END
    FROM   sec_rules r, jsonb_array_elements(r.j->'overrides') o
    WHERE  (o->>'op' = 'none') = (o->>'context' IS NOT NULL)
    UNION ALL
    SELECT 'override without a reason on ' || (o->>'table') || '.' || (o->>'column') FROM sec_rules r, jsonb_array_elements(r.j->'overrides') o
    WHERE  coalesce(o->>'reason', '') = ''
    UNION ALL
    SELECT 'prefix ' || p.v || ' in two organizationId domains' FROM sec_rules r, jsonb_each(r.j#>'{organizationId,domains}') d,
           jsonb_array_elements_text(d.value) AS p(v)
    GROUP  BY p.v HAVING count(*) > 1
    UNION ALL
    SELECT 'organizationId.orgIdPartnerRe missing' FROM sec_rules r WHERE coalesce(r.j#>>'{organizationId,orgIdPartnerRe}', '') = ''
    UNION ALL
    SELECT 'override column ' || (o->>'table') || '.' || (o->>'column') FROM sec_rules r, jsonb_array_elements(r.j->'overrides') o
    WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.columns x WHERE x.table_name = o->>'table' AND x.name = o->>'column')
    UNION ALL
    -- primaryByPrefix: {prefix: {contexts: [...], audit?: {source: trace | crawl, evidence}}}
    SELECT 'primaryByPrefix.' || p.key || ' is not {contexts: [..], audit?: {source, evidence}}'
    FROM   sec_rules r, jsonb_each(r.j->'primaryByPrefix') p
    WHERE  p.key NOT LIKE '\_%'
      AND (jsonb_typeof(p.value) IS DISTINCT FROM 'object' OR jsonb_typeof(p.value->'contexts') IS DISTINCT FROM 'array'
           OR jsonb_array_length(p.value->'contexts') = 0
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(p.value) k WHERE k NOT IN ('contexts', 'audit')))
    UNION ALL
    SELECT 'primaryByPrefix.' || p.key || '.audit: source must be trace | crawl and the evidence non-empty'
    FROM   sec_rules r, jsonb_each(r.j->'primaryByPrefix') p
    WHERE  p.key NOT LIKE '\_%' AND p.value ? 'audit'
      AND (coalesce(p.value#>>'{audit,source}', '') NOT IN ('trace', 'crawl') OR coalesce(btrim(p.value#>>'{audit,evidence}'), '') = '')
  ) s;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_security: rules invalid against {{V}}: %', bad; END IF;
END $$;

-- ---- 2. objects + object-level exclusions ---------------------------------------------
CREATE TEMP TABLE sec_obj ON COMMIT DROP AS
SELECT t.name, t.type, split_part(t.name, '_', 1) AS prefix, upper(t.module) AS module,
       CASE WHEN t.name ~ (r.j#>>'{exclude,objectNameRe}') THEN 'catalog noise / GTG copy'
            WHEN t.name IN (SELECT jsonb_array_elements_text(r.j#>'{exclude,objects}')) THEN 'security object'
            WHEN split_part(t.name, '_', 1) IN (SELECT jsonb_array_elements_text(r.j#>'{exclude,hcmPrefixes}'))
                 THEN 'HCM (security profiles, out of scope)'
            WHEN t.type = 'VIEW' AND t.view_text ~* (r.j#>>'{exclude,securedViewTextRe}') THEN 'view already embeds security'
       END AS excluded
FROM   {{V}}.tables t, sec_rules r;
CREATE INDEX ON sec_obj (name);

-- ---- 2b. Oracle's own policies: every instance set parsed, never guessed ----------------------
-- the number of SELECT subqueries open at position pos of p (quoted literals skipped)
CREATE FUNCTION pg_temp.sec_seldepth(p text, pos int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE st boolean[] := '{}'; q boolean := false; ch text; i int; n int := 0;
BEGIN
  FOR i IN 1..pos - 1 LOOP
    ch := substr(p, i, 1);
    IF ch = '''' THEN q := NOT q;
    ELSIF q THEN CONTINUE;
    ELSIF ch = '(' THEN st := st || (substr(p, i + 1, 40) ~* '^\s*SELECT\M');
    ELSIF ch = ')' AND cardinality(st) > 0 THEN st := st[1:cardinality(st) - 1];
    END IF;
  END LOOP;
  FOR i IN 1..cardinality(st) LOOP IF st[i] THEN n := n + 1; END IF; END LOOP;
  RETURN n;
END $f$;

-- the position of the ')' that closes the '(' at pos; 0 = it never closes (a predicate cut at 1,000 chars)
CREATE FUNCTION pg_temp.sec_close(p text, pos int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE d int := 0; q boolean := false; ch text; i int;
BEGIN
  FOR i IN pos..length(p) LOOP
    ch := substr(p, i, 1);
    IF ch = '''' THEN q := NOT q;
    ELSIF q THEN CONTINUE;
    ELSIF ch = '(' THEN d := d + 1;
    ELSIF ch = ')' THEN d := d - 1; IF d = 0 THEN RETURN i; END IF;
    END IF;
  END LOOP;
  RETURN 0;
END $f$;

-- the position of keyword kw at paren depth 0 of s (0 = absent)
CREATE FUNCTION pg_temp.sec_kw(s text, kw text) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE d int := 0; q boolean := false; ch text; i int; n int := length(kw);
BEGIN
  FOR i IN 1..length(s) LOOP
    ch := substr(s, i, 1);
    IF ch = '''' THEN q := NOT q;
    ELSIF q THEN CONTINUE;
    ELSIF ch = '(' THEN d := d + 1;
    ELSIF ch = ')' THEN d := d - 1;
    ELSIF d = 0 AND upper(substr(s, i, n)) = upper(kw)
          AND (i = 1 OR substr(s, i - 1, 1) !~ '[A-Za-z0-9_$#.]') AND substr(s, i + n, 1) !~ '[A-Za-z0-9_$#]' THEN RETURN i;
    END IF;
  END LOOP;
  RETURN 0;
END $f$;

-- every `<col> IN (SELECT ...)` of a predicate OUTSIDE any SELECT subquery (the object's own column,
-- qualified by &TABLE_ALIAS, an ADF view-object alias or nothing, optionally inside TO_CHAR()):
-- the column, the subquery's first select item, its FROM items (at the subquery's own top level),
-- the subquery text and the span pos..cls of the IN-list. An IN-list INSIDE a subquery belongs to a
-- mapping (e.g. CST_COST_INV_ORGS.INV_ORG_ID), never to the object.
CREATE FUNCTION pg_temp.sec_pol_in(p text)
RETURNS TABLE (n int, col_qual text, col text, sel_qual text, sel_col text, sel_items int, from_items jsonb, sub text, pos int, cls int)
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  re constant text := '(?:TO_CHAR\s*\(\s*)?((?:&TABLE_ALIAS|[A-Za-z_][A-Za-z0-9_$#]*)\.)?([A-Za-z_][A-Za-z0-9_$#]*)\s*\)?\s+IN\s*\(\s*(?:\(\s*)?SELECT\M';
  k int; i int; mend int; op int; c2 int; body text; sl text; rest text; frm text; f int; w int; u int; it text; s1 text[];
BEGIN
  k := regexp_count(p, re, 1, 'i');
  FOR i IN 1..k LOOP
    pos := regexp_instr(p, re, 1, i, 0, 'i');
    IF pg_temp.sec_seldepth(p, pos) > 0 THEN CONTINUE; END IF;
    mend := regexp_instr(p, re, 1, i, 1, 'i');
    op := pos - 1 + regexp_instr(substr(p, pos, mend - pos), '\mIN\s*\(', 1, 1, 1, 'i') - 1;
    cls := pg_temp.sec_close(p, op);
    body := CASE WHEN cls > 0 THEN substr(p, op + 1, cls - op - 1) ELSE substr(p, op + 1) END;
    IF body ~ '^\s*\(' THEN                              -- IN ((SELECT ...)): one grouping paren
      c2 := pg_temp.sec_close(body, strpos(body, '('));
      IF c2 > 0 AND substr(body, c2 + 1) ~ '^\s*$' THEN body := substr(body, strpos(body, '(') + 1, c2 - strpos(body, '(') - 1); END IF;
    END IF;
    sub := body;
    body := regexp_replace(body, '^\s*SELECT\s+(DISTINCT\s+)?', '', 'i');
    f := pg_temp.sec_kw(body, 'FROM');
    n := i;
    col_qual := rtrim(regexp_substr(p, re, 1, i, 'i', 1), '.');
    col := upper(regexp_substr(p, re, 1, i, 'i', 2));
    sel_qual := NULL; sel_col := NULL; sel_items := NULL; from_items := '[]'::jsonb;
    IF f > 0 THEN
      sl := btrim(substr(body, 1, f - 1));
      sel_items := cardinality(string_to_array(sl, ','));
      s1 := regexp_match(btrim(split_part(sl, ',', 1)),
                         '^(?:([A-Za-z_][A-Za-z0-9_$#]*)\.)?([A-Za-z_][A-Za-z0-9_$#]*)(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_$#]*)?$', 'i');
      IF s1 IS NOT NULL THEN sel_qual := upper(s1[1]); sel_col := upper(s1[2]); END IF;
      rest := substr(body, f + 4);
      w := pg_temp.sec_kw(rest, 'WHERE'); u := pg_temp.sec_kw(rest, 'UNION');
      frm := CASE WHEN w > 0 AND (u = 0 OR w < u) THEN substr(rest, 1, w - 1) WHEN u > 0 THEN substr(rest, 1, u - 1) ELSE rest END;
      FOREACH it IN ARRAY string_to_array(frm, ',') LOOP
        s1 := regexp_match(btrim(it), '^([A-Za-z_][A-Za-z0-9_$#.]*)(?:\s+([A-Za-z_][A-Za-z0-9_$#]*))?$', 'i');
        from_items := from_items || jsonb_build_array(CASE WHEN s1 IS NULL THEN jsonb_build_object('t', upper(btrim(it)), 'alias', NULL)
                                                           ELSE jsonb_build_object('t', upper(s1[1]), 'alias', upper(s1[2])) END);
      END LOOP;
    END IF;
    RETURN NEXT;
  END LOOP;
END $f$;

-- the URDA context columns a predicate reads from FUN_USER_ROLE_DATA_ASGNMNTS (qualified by an alias
-- the predicate binds to it, or selected straight from it), in context order
CREATE FUNCTION pg_temp.sec_urda_refs(p text) RETURNS text[] LANGUAGE sql STABLE AS $f$
  WITH a AS (
    SELECT 'FUN_USER_ROLE_DATA_ASGNMNTS' AS al
    UNION SELECT upper(m[1]) FROM regexp_matches(p, 'FUN_USER_ROLE_DATA_ASGNMNTS\s+(?!WHERE\M)([A-Za-z_][A-Za-z0-9_$#]*)', 'gi') AS m)
  SELECT coalesce(array_agg(x.urda_column ORDER BY x.ord), '{}') FROM sec_ctx x
  WHERE  p ~* ('\m(' || (SELECT string_agg(al, '|') FROM a) || ')\.' || x.urda_column || '\M')
     OR  p ~* ('SELECT\s+' || x.urda_column || '\s+FROM\s+FUN_USER_ROLE_DATA_ASGNMNTS\M')
$f$;

-- one row per instance set: the predicate (whitespace collapsed), whether the extract cut it, the
-- set's CODE (the set name after its compacted OBJ_NAME: the longest catalog application short name
-- it starts with, else its leading letters) and the predicate normalized for matching mined grants
CREATE TEMP TABLE sec_pol ON COMMIT DROP AS
WITH r AS (
  SELECT upper(btrim(table_name)) AS table_name, upper(btrim(obj_name)) AS obj_name, upper(btrim(instance_set_name)) AS set_name,
         predicate AS raw, btrim(regexp_replace(predicate, '\s+', ' ', 'g')) AS p
  FROM   sec_pol_raw),
c AS (
  SELECT r.*, ltrim(substr(r.set_name, 1 + (SELECT max(i) FROM generate_series(0, least(length(r.set_name), length(replace(r.obj_name, '_', '')))) AS g(i)
                                             WHERE left(r.set_name, i) = left(replace(r.obj_name, '_', ''), i))), '_') AS suffix
  FROM   r),
apps AS (SELECT DISTINCT module FROM sec_obj WHERE module ~ '^[A-Z][A-Z0-9_]*$')
SELECT c.table_name, c.obj_name, c.set_name, c.raw, c.p, length(c.raw) >= 1000 AS truncated,
       coalesce((SELECT a.module FROM apps a WHERE left(c.suffix, length(a.module)) = a.module ORDER BY length(a.module) DESC LIMIT 1),
                substring(c.suffix from '^[A-Z]+')) AS code,
       upper(regexp_replace(regexp_replace(regexp_replace(c.p, '&GRANT_ALIAS\.', 'GNT.', 'gi'),
                                           '^(?:&TABLE_ALIAS|[A-Za-z_][A-Za-z0-9_$#]*)\.', '', 'i'), '\s+', '', 'g')) AS norm,
       (t.name IS NOT NULL) AS in_catalog,
       NULL::text AS kind, NULL::text AS why
FROM   c LEFT JOIN {{V}}.tables t ON t.name = c.table_name;

-- every top-level IN-list and its shape: direct = the object's column IN (SELECT <URDA context
-- column> FROM FUN_USER_ROLE_DATA_ASGNMNTS ...); datasec = a generic DATASEC_CONTEXT; non_context =
-- another URDA column; derived = the list comes from a mapping object fed by URDA; NULL = an
-- IN-list with no URDA in it (an OR'd alternative, not a security form)
CREATE TEMP TABLE sec_pol_m ON COMMIT DROP AS
SELECT s.table_name, s.set_name, x.*,
       (SELECT coalesce(e->>'alias', e->>'t') FROM jsonb_array_elements(x.from_items) e WHERE e->>'t' = 'FUN_USER_ROLE_DATA_ASGNMNTS' LIMIT 1) AS urda_alias,
       NULL::text AS kind
FROM   sec_pol s CROSS JOIN LATERAL pg_temp.sec_pol_in(s.p) x;
UPDATE sec_pol_m m SET kind = CASE
    WHEN m.urda_alias IS NOT NULL AND (m.sel_qual IS NULL OR m.sel_qual = m.urda_alias)
         AND m.sel_col IN (SELECT name FROM {{V}}.columns WHERE table_name = 'FUN_USER_ROLE_DATA_ASGNMNTS')
    THEN CASE WHEN m.sel_col IN (SELECT urda_column FROM sec_ctx) THEN 'direct'
              WHEN m.sel_col LIKE 'DATASEC\_CONTEXT\_VALUE%' THEN 'datasec' ELSE 'non_context' END
    WHEN m.sub ~* 'FUN_USER_ROLE_DATA_ASGNMNTS' THEN CASE WHEN m.sub ~* 'DATASEC_CONTEXT_TYPE_CODE' THEN 'datasec' ELSE 'derived' END
  END;

-- the instance set's shape (its best IN-list, else the form of the whole predicate) and, for every
-- shape that yields no column fact, why
UPDATE sec_pol s SET
  kind = CASE WHEN EXISTS (SELECT 1 FROM sec_pol_m m WHERE m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'direct') THEN 'direct'
              WHEN EXISTS (SELECT 1 FROM sec_pol_m m WHERE m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'derived') THEN 'derived'
              WHEN s.p ~* 'DATASEC_CONTEXT_TYPE_CODE' THEN 'datasec'
              WHEN EXISTS (SELECT 1 FROM sec_pol_m m WHERE m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'non_context') THEN 'non_context'
              WHEN s.p ~* '\mEXISTS\s*\(' THEN 'exists'
              ELSE 'unparsed' END;
UPDATE sec_pol s SET why = CASE s.kind
    WHEN 'derived' THEN (SELECT string_agg(DISTINCT m.col || ' by ' || coalesce(m.sel_qual || '.', '') || coalesce(m.sel_col, '?') || ' of ' ||
                                  (SELECT string_agg(e->>'t', ', ') FROM jsonb_array_elements(m.from_items) e WHERE e->>'t' <> 'FUN_USER_ROLE_DATA_ASGNMNTS'), '; ')
                         FROM sec_pol_m m WHERE m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'derived')
                        || ' - derived from URDA.' || coalesce(nullif(array_to_string(pg_temp.sec_urda_refs(s.p), '/'), ''), '?')
                        || ' through a mapping object: no direct context column'
    WHEN 'datasec' THEN 'generic data-security context ' || coalesce((regexp_match(s.p, 'DATASEC_CONTEXT_TYPE_CODE\s*=\s*''([^'']+)''', 'i'))[1], '?')
                        || ' (URDA.DATASEC_CONTEXT_VALUEn) - not one of the twelve contexts'
    WHEN 'non_context' THEN (SELECT string_agg(DISTINCT m.col || ' by URDA.' || m.sel_col, '; ') FROM sec_pol_m m
                             WHERE m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'non_context') || ' - not one of the twelve context columns'
    WHEN 'exists' THEN 'EXISTS through another object (' || coalesce((SELECT string_agg(DISTINCT upper(v[1]), ', ') FROM regexp_matches(s.p, '&TABLE_ALIAS\.([A-Za-z_][A-Za-z0-9_$#]*)', 'gi') AS v), '?')
                       || ' of the object correlated; URDA.' || coalesce(nullif(array_to_string(pg_temp.sec_urda_refs(s.p), '/'), ''), '?')
                       || ' applied to that other object) - no column of this object is filtered'
    WHEN 'unparsed' THEN 'no top-level <column> IN (SELECT ... FUN_USER_ROLE_DATA_ASGNMNTS ...), EXISTS or DATASEC form'
  END || CASE WHEN s.truncated THEN ' [predicate cut at 1,000 chars by the extract]' ELSE '' END
WHERE  s.kind <> 'direct';

-- direct: the (object column, context) of every direct IN-list, with what the set adds around it
CREATE TEMP TABLE sec_poldir ON COMMIT DROP AS
SELECT DISTINCT s.table_name, s.obj_name, s.set_name, s.code, m.col AS column_name, x.context, x.urda_column,
       concat_ws('; ',
         CASE WHEN s.truncated THEN 'predicate cut at 1,000 chars' END,
         CASE WHEN s.p ~* '&GRANT_ALIAS\.PARAMETER' THEN 'conditioned on a grant parameter' END,
         CASE WHEN jsonb_array_length(m.from_items) > 1
              THEN 'narrowed through ' || (SELECT string_agg(e->>'t', ', ') FROM jsonb_array_elements(m.from_items) e WHERE e->>'t' <> 'FUN_USER_ROLE_DATA_ASGNMNTS') END,
         CASE WHEN m.sub ~* '\mUNION\M' THEN 'widened by a UNION' END,
         CASE WHEN (substr(s.p, 1, m.pos - 1) || CASE WHEN m.cls > 0 THEN substr(s.p, m.cls + 1) ELSE '' END) ~ '[A-Za-z]'
              THEN 'other conditions around the IN-list' END) AS flags
FROM   sec_pol s
JOIN   sec_pol_m m ON m.table_name = s.table_name AND m.set_name = s.set_name AND m.kind = 'direct'
JOIN   sec_ctx x ON x.urda_column = m.sel_col;

-- per (object, column): the context Oracle filters it by. Several contexts (one instance set per
-- module) => the object's standard set decides, the others are named; no standard set => conflict
CREATE TEMP TABLE sec_polcol ON COMMIT DROP AS
WITH std AS (SELECT r.j#>>'{oraclePolicy,standardSetCode}' AS c FROM sec_rules r),
g AS (
  SELECT d.table_name, d.column_name, min(d.obj_name) AS obj_name,
         array_agg(DISTINCT d.context ORDER BY d.context) AS ctxs,
         array_agg(DISTINCT d.context ORDER BY d.context) FILTER (WHERE d.code = std.c) AS std_ctxs
  FROM   sec_poldir d, std GROUP BY 1, 2)
SELECT g.table_name, g.column_name, g.obj_name, g.ctxs, c.ordinal,
       CASE WHEN c.name IS NULL THEN NULL WHEN cardinality(g.ctxs) = 1 THEN g.ctxs[1] WHEN cardinality(g.std_ctxs) = 1 THEN g.std_ctxs[1] END AS context,
       CASE WHEN c.name IS NULL THEN 'not in the catalog' WHEN cardinality(g.ctxs) = 1 THEN 'single'
            WHEN cardinality(g.std_ctxs) = 1 THEN 'standard_set' ELSE 'conflict' END AS decided_by,
       NULL::text AS sets, 0 AS n_sets, NULL::text AS reason
FROM   g LEFT JOIN {{V}}.columns c ON c.table_name = g.table_name AND c.name = g.column_name;
UPDATE sec_polcol c SET
  sets    = (SELECT string_agg(d.set_name, ', ' ORDER BY d.set_name) FROM sec_poldir d
             WHERE d.table_name = c.table_name AND d.column_name = c.column_name AND d.context = c.context),
  n_sets  = (SELECT count(*) FROM sec_poldir d WHERE d.table_name = c.table_name AND d.column_name = c.column_name AND d.context = c.context)
WHERE  c.context IS NOT NULL;
UPDATE sec_polcol c SET reason =
  'Oracle data-security policy ' || c.obj_name || ': instance set(s) ' || c.sets || ' filter ' || c.column_name || ' by URDA.' ||
  (SELECT x.urda_column FROM sec_ctx x WHERE x.context = c.context) ||
  coalesce(' (' || nullif((SELECT string_agg(DISTINCT d.flags, '; ') FROM sec_poldir d
                           WHERE d.table_name = c.table_name AND d.column_name = c.column_name AND d.context = c.context AND d.flags <> ''), '') || ')', '') ||
  CASE WHEN c.decided_by = 'standard_set'
       THEN '; per module also ' || (SELECT string_agg(d.set_name || ' by URDA.' || d.urda_column, ', ' ORDER BY d.set_name) FROM sec_poldir d
                                     WHERE d.table_name = c.table_name AND d.column_name = c.column_name AND d.context <> c.context)
            || ' - the standard set decides' ELSE '' END
WHERE  c.context IS NOT NULL;

-- the module org-context rule, derived from the policies (moduleFamilies._doc): an org-family set
-- (its predicate uses the URDA column of a family context) whose CODE is a catalog application
-- gives that application the set's context (code evidence); a set of another code on an object's
-- own ORGANIZATION_ID gives the object's application that context (object evidence). The standard
-- code is the object's own set, not a module. Code evidence first; several contexts = mixed.
CREATE TEMP TABLE sec_pol_org ON COMMIT DROP AS
SELECT s.table_name, s.set_name, s.code, o.module AS obj_module,
       ARRAY(SELECT x.context FROM sec_ctx x, sec_rules r
             WHERE (r.j#>'{moduleFamilies,contexts}') ? x.context AND x.urda_column = ANY (pg_temp.sec_urda_refs(s.p)) ORDER BY x.context) AS ctxs,
       EXISTS (SELECT 1 FROM sec_poldir d, sec_rules r WHERE d.table_name = s.table_name AND d.set_name = s.set_name
               AND d.column_name = r.j#>>'{organizationId,column}') AS on_org_col
FROM   sec_pol s LEFT JOIN sec_obj o ON o.name = s.table_name;
DELETE FROM sec_pol_org WHERE cardinality(ctxs) = 0;

CREATE TEMP TABLE sec_modfam ON COMMIT DROP AS
WITH std AS (SELECT r.j#>>'{oraclePolicy,standardSetCode}' AS c FROM sec_rules r),
ev AS (
  SELECT o.code AS app, 'code' AS how, o.ctxs[1] AS context, o.set_name FROM sec_pol_org o, std
  WHERE  cardinality(o.ctxs) = 1 AND o.code <> std.c
  UNION ALL
  SELECT o.obj_module, 'object', o.ctxs[1], o.set_name FROM sec_pol_org o, std
  WHERE  cardinality(o.ctxs) = 1 AND o.on_org_col AND o.code <> std.c AND o.code IS DISTINCT FROM o.obj_module AND o.obj_module IS NOT NULL),
agg AS (SELECT app, how, array_agg(DISTINCT context ORDER BY context) AS ctxs, string_agg(DISTINCT set_name, ', ' ORDER BY set_name) AS sets FROM ev GROUP BY 1, 2),
pick AS (SELECT DISTINCT ON (app) * FROM agg ORDER BY app, (how = 'code') DESC)
SELECT p.app, p.how, CASE WHEN cardinality(p.ctxs) = 1 THEN p.ctxs[1] END AS context, p.ctxs, p.sets,
       EXISTS (SELECT 1 FROM sec_obj b WHERE b.module = p.app) AS is_app, NULL::text AS reason
FROM   pick p
UNION ALL
SELECT m->>'app', 'judgment', m->>'context', ARRAY[m->>'context'], NULL, true, m->>'reason'
FROM   sec_rules r, jsonb_array_elements(r.j#>'{moduleFamilies,judgment}') m;

-- the policy-derived inputs must agree with the curated rules — never two answers for one thing
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT m, '; ') INTO bad FROM (
    SELECT 'judgment for ' || j.app || ' but the policies give it ' || coalesce(e.context, 'mixed ' || array_to_string(e.ctxs, '/')) || ' (' || e.sets || ')' AS m
    FROM   sec_modfam j JOIN sec_modfam e ON e.app = j.app AND e.how <> 'judgment' WHERE j.how = 'judgment'
    UNION ALL
    SELECT 'organizationId.domains.' || d.key || ' lists ' || p.v || ' but its module family is ' || f.context || ' (' || coalesce(f.sets, f.reason) || ')'
    FROM   sec_rules r
    CROSS  JOIN LATERAL jsonb_each(r.j#>'{organizationId,domains}') d
    CROSS  JOIN LATERAL jsonb_array_elements_text(d.value) AS p(v)
    JOIN   sec_modfam f ON f.app = p.v AND f.context IS NOT NULL AND f.context <> d.key
    UNION ALL
    SELECT 'curated override ' || (o->>'op') || ' on ' || (o->>'table') || '.' || (o->>'column') || ' - Oracle policy decides that column (' || c.sets || ')'
    FROM   sec_rules r
    CROSS  JOIN LATERAL jsonb_array_elements(r.j->'overrides') o
    JOIN   sec_polcol c ON c.table_name = o->>'table' AND c.column_name = o->>'column' AND c.context IS NOT NULL
  ) s;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_security: rules contradict the Oracle policies: %', bad; END IF;
END $$;

-- the columns any rule can name (exact, suffix, the generic org id, curated adds)
CREATE TEMP TABLE sec_col ON COMMIT DROP AS
SELECT c.table_name, c.name AS column_name, c.ordinal, c.nullable,
       nullif(c.remarks, 'null') AS remarks, o.prefix, o.excluded AS obj_excluded,
       CASE WHEN nullif(c.remarks, 'null') ~* (r.j#>>'{exclude,columnRemarkRe}') THEN 'remark: internal use / unused' END AS col_excluded
FROM   {{V}}.columns c JOIN sec_obj o ON o.name = c.table_name, sec_rules r
WHERE  c.name IN (SELECT e->>'column' FROM jsonb_array_elements(r.j->'exactNames') e)
   OR  c.name ~ ANY (ARRAY(SELECT s->>'columnRe' FROM jsonb_array_elements(r.j->'suffixes') s))
   OR  c.name = r.j#>>'{organizationId,column}'
   OR  EXISTS (SELECT 1 FROM jsonb_array_elements(r.j->'overrides') ov WHERE ov->>'table' = c.table_name AND ov->>'column' = c.name);
CREATE INDEX ON sec_col (table_name);

CREATE TEMP TABLE sec_cand (
  table_name text, column_name text, context text, confidence text,
  rule_order int, pref int, ordinal int, reason text, excluded text, chain_evidence int NOT NULL DEFAULT 0
) ON COMMIT DROP;

-- ---- 3. exact names --------------------------------------------------------------------
INSERT INTO sec_cand (table_name, column_name, context, confidence, rule_order, pref, ordinal, reason, excluded)
SELECT c.table_name, c.column_name, e.e->>'context', 'name', e.o::int, 0, c.ordinal,
       'name ' || c.column_name || ' -> ' || (e.e->>'context'),
       coalesce(c.obj_excluded, c.col_excluded,
                CASE WHEN c.table_name ~ (r.j#>'{exclude,contextObjectRe}'->>(e.e->>'context')) THEN 'context object pattern' END)
FROM   sec_col c, sec_rules r, jsonb_array_elements(r.j->'exactNames') WITH ORDINALITY AS e(e, o)
WHERE  c.column_name = e.e->>'column'
  AND  (e.e->>'objectRe' IS NULL OR c.table_name ~ (e.e->>'objectRe'))
  AND  ((e.e->>'remarkRe' IS NULL AND e.e->'prefixes' IS NULL)
        OR c.remarks ~* (e.e->>'remarkRe')
        OR c.prefix IN (SELECT jsonb_array_elements_text(e.e->'prefixes')));

-- ---- 4. suffixes: only where the object has no usable exact-name column of that context --
INSERT INTO sec_cand (table_name, column_name, context, confidence, rule_order, pref, ordinal, reason, excluded)
SELECT c.table_name, c.column_name, s.s->>'context', 'name', 100 + s.o::int,
       coalesce((SELECT p.o FROM jsonb_array_elements_text(s.s->'preference') WITH ORDINALITY AS p(v, o) WHERE p.v = c.column_name), 99)::int,
       c.ordinal,
       'suffix ' || c.column_name || ' -> ' || (s.s->>'context') || ' (no exact-name ' || (s.s->>'context') || ' column on the object)',
       coalesce(c.obj_excluded, c.col_excluded,
                CASE WHEN c.table_name ~ (r.j#>'{exclude,contextObjectRe}'->>(s.s->>'context')) THEN 'context object pattern' END)
FROM   sec_col c, sec_rules r, jsonb_array_elements(r.j->'suffixes') WITH ORDINALITY AS s(s, o)
WHERE  c.column_name ~ (s.s->>'columnRe')
  AND  NOT EXISTS (SELECT 1 FROM sec_cand x WHERE x.table_name = c.table_name AND x.context = s.s->>'context' AND x.excluded IS NULL);

-- ---- 4b. Oracle policy: a column Oracle filters by a URDA context column takes that context ----
-- every rule candidate of the column goes (whatever the object exclusions say: Oracle secures it);
-- a conflict column (several contexts, no standard set) keeps its rule candidates and is reported
UPDATE sec_cand k SET excluded = 'replaced by Oracle policy'
FROM   sec_polcol c
WHERE  c.context IS NOT NULL AND k.table_name = c.table_name AND k.column_name = c.column_name AND k.excluded IS NULL;
INSERT INTO sec_cand (table_name, column_name, context, confidence, rule_order, pref, ordinal, reason, excluded, chain_evidence)
SELECT c.table_name, c.column_name, c.context, 'oracle_policy', 0, 0, c.ordinal, c.reason, NULL, c.n_sets
FROM   sec_polcol c WHERE c.context IS NOT NULL;

-- ---- 5. the generic ORGANIZATION_ID chain ----------------------------------------------
CREATE TEMP TABLE sec_dom ON COMMIT DROP AS
SELECT d.key AS context, p.v AS prefix
FROM   sec_rules r, jsonb_each(r.j#>'{organizationId,domains}') d, jsonb_array_elements_text(d.value) AS p(v);

-- one row per ORGANIZATION_ID column = its resolution: `context` NULL while open; `how` = the rule
-- that decided (fk | corpus_join | lineage | prefix | sibling | tie | own_id_space | non_org_partner |
-- hcm_lineage | hcm_sibling | curated_set | curated_none); a decided column is final
CREATE TEMP TABLE sec_ores ON COMMIT DROP AS
SELECT c.table_name, c.column_name, c.ordinal, c.prefix, d.context AS family,
       coalesce(c.obj_excluded, c.col_excluded) AS excluded,
       NULL::text AS context, NULL::text AS how, NULL::int AS stage, 0 AS n, NULL::text AS detail, NULL::text[] AS candidates
FROM   sec_col c CROSS JOIN sec_rules r LEFT JOIN sec_dom d ON d.prefix = c.prefix
WHERE  c.column_name = r.j#>>'{organizationId,column}';
CREATE UNIQUE INDEX ON sec_ores (table_name, column_name);

-- stage 0: Oracle policy on the column decides it (and anchors every vote that follows)
UPDATE sec_ores o SET context = c.context, how = 'oracle_policy', stage = 0, detail = c.obj_name || ' (' || c.sets || ')'
FROM   sec_polcol c
WHERE  c.context IS NOT NULL AND c.table_name = o.table_name AND c.column_name = o.column_name;

-- its corpus join partners (statement grain, both directions; SEMI edges included) ...
CREATE TEMP TABLE sec_jp ON COMMIT DROP AS
SELECT DISTINCT o.table_name, o.column_name, j.p AS p_table, j.pc AS p_column, j.sql_hash
FROM   sec_ores o
JOIN  (SELECT from_t AS t, from_c AS c, to_t AS p, to_c AS pc, sql_hash FROM work.f_joins
       UNION ALL SELECT to_t, to_c, from_t, from_c, sql_hash FROM work.f_joins) j
       ON j.t = o.table_name AND j.c = o.column_name AND j.p <> o.table_name;
CREATE INDEX ON sec_jp (table_name, column_name);
-- ... and its view pass-through links: `base` = the column this view column passes through,
-- `view` = a view column passing this column through (the same value either way)
CREATE TEMP TABLE sec_lp ON COMMIT DROP AS
SELECT DISTINCT o.table_name, o.column_name, l.p_table, l.p_column, l.dir
FROM   sec_ores o
JOIN  (SELECT view_name AS t, column_name AS c, src_table AS p_table, src_col AS p_column, 'base' AS dir
       FROM   work.view_column_remarks WHERE kind = 'passthrough'
       UNION ALL
       SELECT src_table, src_col, view_name, column_name, 'view'
       FROM   work.view_column_remarks WHERE kind = 'passthrough') l
       ON l.t = o.table_name AND l.c = o.column_name AND l.p_table <> o.table_name
WHERE  EXISTS (SELECT 1 FROM {{V}}.columns x WHERE x.table_name = l.p_table AND x.name = l.p_column);
CREATE INDEX ON sec_lp (table_name, column_name);

-- the votes of one step; sec_apply() decides every open column that received any
CREATE TEMP TABLE sec_vote (table_name text, column_name text, context text, how text, n int, detail text) ON COMMIT DROP;

-- majority by weight; a tie goes to the object's own prefix family when that is one of the tied
-- contexts, else the column is `tie` (unresolved, never a guess)
CREATE FUNCTION pg_temp.sec_apply(p_stage int) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE k int;
BEGIN
  WITH ranked AS (
    SELECT v.*, rank() OVER (PARTITION BY v.table_name, v.column_name ORDER BY v.n DESC) AS rk FROM sec_vote v),
  top AS (
    SELECT table_name, column_name, min(how) AS how, array_agg(context ORDER BY context) AS ctxs, max(n) AS n,
           string_agg(detail || ' (' || context || CASE WHEN how = 'corpus_join' THEN ', ' || n || ' statements' ELSE '' END || ')',
                      '; ' ORDER BY context) AS detail
    FROM   ranked WHERE rk = 1 GROUP BY 1, 2)
  UPDATE sec_ores o
  SET    context    = CASE WHEN cardinality(t.ctxs) = 1 THEN t.ctxs[1] WHEN o.family = ANY (t.ctxs) THEN o.family END,
         how        = CASE WHEN cardinality(t.ctxs) = 1 OR o.family = ANY (t.ctxs) THEN t.how ELSE 'tie' END,
         candidates = t.ctxs, stage = p_stage, n = t.n,
         detail     = t.detail || CASE WHEN cardinality(t.ctxs) > 1 AND o.family = ANY (t.ctxs)
                                       THEN '; tie broken by the object''s prefix family ' || o.prefix ELSE '' END
  FROM   top t
  WHERE  o.table_name = t.table_name AND o.column_name = t.column_name
    AND  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL;
  GET DIAGNOSTICS k = ROW_COUNT;
  TRUNCATE sec_vote;
  RETURN k;
END $f$;

-- [vote]: to a fixpoint over what is resolved so far (name-rule columns + decided chain columns).
-- A resolved lineage partner decides (the same value — R3); else the corpus join partners' COLUMN
-- contexts vote by statements (R2). Unclassified partners do not vote.
CREATE FUNCTION pg_temp.sec_fixpoint(p_stage int) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE it int := 0; k int; total int := 0;
BEGIN
  LOOP
    it := it + 1;
    IF it > 100 THEN RAISE EXCEPTION 'p5_security: ORGANIZATION_ID vote did not converge in 100 rounds (stage %)', p_stage; END IF;
    INSERT INTO sec_vote (table_name, column_name, context, how, n, detail)
    SELECT l.table_name, l.column_name, k.context, 'lineage', count(*)::int,
           string_agg(DISTINCT l.p_table || '.' || l.p_column, ', ')
    FROM   sec_ores o
    JOIN   sec_lp l ON l.table_name = o.table_name AND l.column_name = o.column_name
                   AND (l.dir = 'base' OR l.p_column = o.column_name)   -- a RENAMED view alias never feeds back
    JOIN  (SELECT table_name, column_name, context FROM sec_cand WHERE excluded IS NULL
           UNION SELECT table_name, column_name, context FROM sec_ores WHERE context IS NOT NULL) k
           ON k.table_name = l.p_table AND k.column_name = l.p_column
    WHERE  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
    GROUP  BY 1, 2, 3;
    INSERT INTO sec_vote (table_name, column_name, context, how, n, detail)
    SELECT j.table_name, j.column_name, k.context, 'corpus_join', count(DISTINCT j.sql_hash)::int,
           array_to_string((array_agg(DISTINCT j.p_table || '.' || j.p_column))[1:3], ', ')
    FROM   sec_ores o
    JOIN   sec_jp j ON j.table_name = o.table_name AND j.column_name = o.column_name
    JOIN  (SELECT table_name, column_name, context FROM sec_cand WHERE excluded IS NULL
           UNION SELECT table_name, column_name, context FROM sec_ores WHERE context IS NOT NULL) k
           ON k.table_name = j.p_table AND k.column_name = j.p_column
    WHERE  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
      AND  NOT EXISTS (SELECT 1 FROM sec_vote v WHERE v.table_name = o.table_name AND v.column_name = o.column_name)
    GROUP  BY 1, 2, 3;
    k := pg_temp.sec_apply(p_stage);
    total := total + k;
    EXIT WHEN k = 0;
  END LOOP;
  RETURN total;
END $f$;

DO $$
DECLARE k int; re text;
BEGIN
  SELECT r.j#>>'{organizationId,orgIdPartnerRe}' INTO re FROM sec_rules r;

  -- 1. declared FK parent family
  INSERT INTO sec_vote (table_name, column_name, context, how, n, detail)
  SELECT o.table_name, o.column_name, d.context, 'fk', count(DISTINCT f.parent_table)::int, string_agg(DISTINCT f.parent_table, ',')
  FROM   sec_ores o
  JOIN   {{V}}.fkeys f ON f.child_table = o.table_name AND f.column_name = o.column_name AND f.parent_table <> o.table_name
  JOIN   sec_dom d ON d.prefix = split_part(f.parent_table, '_', 1)
  WHERE  o.excluded IS NULL
  GROUP  BY 1, 2, 3;
  PERFORM pg_temp.sec_apply(1);

  -- 1b. the module family of an object without its own Oracle policy (moduleFamilies): ahead of
  --     the votes, lineage and prefix — the application decides manufacturing vs inventory org
  UPDATE sec_ores o SET context = f.context, how = 'module', stage = 1,
         detail = 'application ' || f.app || ' -> ' || f.context ||
                  CASE f.how WHEN 'judgment' THEN ' (' || f.reason || ')' ELSE ' (' || f.how || ' evidence: ' || f.sets || ')' END
  FROM   sec_obj b JOIN sec_modfam f ON f.app = b.module AND f.is_app AND f.context IS NOT NULL
  WHERE  b.name = o.table_name AND o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
    AND  NOT EXISTS (SELECT 1 FROM sec_pol s WHERE s.table_name = o.table_name);

  -- 2. [vote] over the anchored columns (Oracle policy + name rules + FK + module family)
  PERFORM pg_temp.sec_fixpoint(2);

  -- 3. the object's own prefix family
  UPDATE sec_ores SET context = family, how = 'prefix', stage = 3, detail = prefix
  WHERE  excluded IS NULL AND context IS NULL AND how IS NULL AND family IS NOT NULL;

  -- 4. [vote] again: prefix-resolved columns now vote too
  PERFORM pg_temp.sec_fixpoint(4);

  -- 5. sibling columns (an HCM win excludes the column)
  INSERT INTO sec_vote (table_name, column_name, context, how, n, detail)
  SELECT o.table_name, o.column_name, s.key, 'sibling', count(*)::int, string_agg(c.name, ',' ORDER BY c.name)
  FROM   sec_ores o
  CROSS  JOIN sec_rules r
  CROSS  JOIN LATERAL jsonb_each(r.j#>'{organizationId,siblings}') s
  CROSS  JOIN LATERAL jsonb_array_elements_text(s.value) AS v(col)
  JOIN   {{V}}.columns c ON c.table_name = o.table_name AND c.name = v.col
  WHERE  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
  GROUP  BY 1, 2, 3;
  PERFORM pg_temp.sec_apply(5);
  UPDATE sec_ores SET excluded = 'HCM org (sibling ' || detail || ')', context = NULL, how = 'hcm_sibling' WHERE context = 'HCM';

  -- 6. [vote] again
  PERFORM pg_temp.sec_fixpoint(6);

  -- 6b. R3: a view column still unresolved that passes an HCM object's column through is out of
  --     scope like that object (after the votes: INV_ORGANIZATION_DEFINITIONS_V also reads HR org
  --     units, and resolves by its own evidence first)
  UPDATE sec_ores o SET excluded = 'HCM (view lineage: passes ' || l.p_table || '.' || l.p_column || ' through)',
                        how = 'hcm_lineage', stage = 6
  FROM   sec_lp l JOIN sec_obj b ON b.name = l.p_table
  WHERE  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
    AND  l.table_name = o.table_name AND l.column_name = o.column_name
    AND  l.dir = 'base' AND b.excluded LIKE 'HCM%';

  -- 7. R4 own id space: the single-column key of a TABLE is that table's own id, not a security
  --    context — and so is a column whose FK parents / join partners are only such keys (a view
  --    passing one through is the same value)
  UPDATE sec_ores o SET how = 'own_id_space', stage = 7, detail = 'the single-column key of ' || o.table_name
  FROM   {{V}}.tables t
  WHERE  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL AND t.name = o.table_name AND t.type = 'TABLE'
    AND  EXISTS (SELECT 1 FROM {{V}}.pkeys p WHERE p.table_name = o.table_name AND p.column_name = o.column_name)
    AND  NOT EXISTS (SELECT 1 FROM {{V}}.pkeys p WHERE p.table_name = o.table_name AND p.seq > 1);
  LOOP
    WITH part AS (
      SELECT table_name, column_name, p_table, p_column, false AS same FROM sec_jp
      UNION SELECT o.table_name, o.column_name, f.parent_table, o.column_name, false
      FROM   sec_ores o JOIN {{V}}.fkeys f ON f.child_table = o.table_name AND f.column_name = o.column_name AND f.parent_table <> o.table_name
      UNION SELECT table_name, column_name, p_table, p_column, true FROM sec_lp),
    agg AS (
      SELECT p.table_name, p.column_name,
             string_agg(DISTINCT p.p_table || '.' || p.p_column, ', ') FILTER (WHERE r.how = 'own_id_space') AS list,
             bool_and(coalesce(r.how = 'own_id_space', false)) FILTER (WHERE NOT p.same) AS others_own,
             bool_or(coalesce(r.how = 'own_id_space', false)) AS any_own
      FROM   part p LEFT JOIN sec_ores r ON r.table_name = p.p_table AND r.column_name = p.p_column
      GROUP  BY 1, 2)
    UPDATE sec_ores o SET how = 'own_id_space', stage = 7, detail = 'its only partner(s) ' || a.list || ' are an own id space'
    FROM   agg a
    WHERE  o.table_name = a.table_name AND o.column_name = a.column_name
      AND  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL
      AND  a.any_own AND coalesce(a.others_own, true);
    GET DIAGNOSTICS k = ROW_COUNT;
    EXIT WHEN k = 0;
  END LOOP;

  -- 8. R5 non-org partners: every corpus join partner is a non-organization id (e.g. a resource
  --    GROUP_ID) — the column is that other id space; a view passing one through is the same value
  LOOP
    WITH agg AS (
      SELECT o.table_name, o.column_name,
             string_agg(DISTINCT j.p_table || '.' || j.p_column, ', ') AS list,
             bool_and(j.p_column !~ re OR coalesce(r.how IN ('own_id_space', 'non_org_partner'), false)) AS all_non_org
      FROM   sec_ores o
      JOIN   sec_jp j ON j.table_name = o.table_name AND j.column_name = o.column_name
      LEFT   JOIN sec_ores r ON r.table_name = j.p_table AND r.column_name = j.p_column
      GROUP  BY 1, 2
      UNION ALL
      SELECT o.table_name, o.column_name, string_agg(DISTINCT l.p_table || '.' || l.p_column, ', '), true
      FROM   sec_ores o
      JOIN   sec_lp l ON l.table_name = o.table_name AND l.column_name = o.column_name
      JOIN   sec_ores r ON r.table_name = l.p_table AND r.column_name = l.p_column AND r.how = 'non_org_partner'
      WHERE  NOT EXISTS (SELECT 1 FROM sec_jp j WHERE j.table_name = o.table_name AND j.column_name = o.column_name)
      GROUP  BY 1, 2)
    UPDATE sec_ores o SET how = 'non_org_partner', stage = 8, detail = 'every partner is a non-organization id: ' || a.list
    FROM   agg a
    WHERE  o.table_name = a.table_name AND o.column_name = a.column_name
      AND  o.excluded IS NULL AND o.context IS NULL AND o.how IS NULL AND a.all_non_org;
    GET DIAGNOSTICS k = ROW_COUNT;
    EXIT WHEN k = 0;
  END LOOP;
END $$;

-- resolved chain columns (an Oracle-policy column is already its oracle_policy candidate, §4b)
INSERT INTO sec_cand (table_name, column_name, context, confidence, rule_order, pref, ordinal, reason, excluded, chain_evidence)
SELECT o.table_name, o.column_name, o.context, o.how, 300, 0, o.ordinal,
       o.column_name || ' -> ' || o.context || ' by ' ||
       CASE o.how WHEN 'module'      THEN 'module family: ' || o.detail
                  WHEN 'fk'          THEN 'FK parent ' || o.detail
                  WHEN 'corpus_join' THEN 'corpus join partner column(s) ' || o.detail
                  WHEN 'lineage'     THEN 'view lineage ' || o.detail
                  WHEN 'prefix'      THEN 'object prefix ' || o.detail
                  WHEN 'sibling'     THEN 'sibling column(s) ' || o.detail END,
       NULL, CASE WHEN o.how = 'corpus_join' THEN o.n ELSE 0 END
FROM   sec_ores o
WHERE  o.context IS NOT NULL AND o.excluded IS NULL AND o.how <> 'oracle_policy';

-- ---- 6. curated overrides (validated in §1) --------------------------------------------
-- none: the column is not a security context — every candidate of THAT column goes (the object's
-- other columns keep theirs); set: the column's context is exactly the curated one — every other
-- candidate of the column is replaced; add: one more curated context row
UPDATE sec_cand k SET excluded = CASE ov->>'op' WHEN 'none' THEN 'curated none: ' || (ov->>'reason')
                                                ELSE 'replaced by curated set ' || (ov->>'context') END
FROM   sec_rules r, jsonb_array_elements(r.j->'overrides') ov
WHERE  ov->>'op' IN ('none', 'set') AND k.table_name = ov->>'table' AND k.column_name = ov->>'column' AND k.excluded IS NULL;
UPDATE sec_ores o SET how = 'curated_' || (ov->>'op'), context = ov->>'context', detail = ov->>'reason', stage = 9
FROM   sec_rules r, jsonb_array_elements(r.j->'overrides') ov
WHERE  ov->>'op' IN ('none', 'set') AND o.table_name = ov->>'table' AND o.column_name = ov->>'column';
INSERT INTO sec_cand (table_name, column_name, context, confidence, rule_order, pref, ordinal, reason, excluded)
SELECT ov->>'table', ov->>'column', ov->>'context', 'curated', 200, 0, c.ordinal, ov->>'reason', NULL
FROM   sec_rules r, jsonb_array_elements(r.j->'overrides') ov
JOIN   {{V}}.columns c ON c.table_name = ov->>'table' AND c.name = ov->>'column'
WHERE  ov->>'op' IN ('add', 'set');

-- still unresolved (no signal, or a tie): the candidate contexts, never a guess
CREATE TEMP TABLE sec_amb ON COMMIT DROP AS
SELECT o.table_name, o.column_name,
       CASE WHEN o.how = 'tie' THEN array_remove(o.candidates, 'HCM')
            ELSE ARRAY(SELECT jsonb_array_elements_text(r.j#>'{organizationId,ambiguousCandidates}')) END AS candidates,
       CASE WHEN o.how = 'tie'
            THEN o.column_name || ': tie between ' || array_to_string(o.candidates, ', ') || ' (' || o.detail || ')'
            ELSE o.column_name || ': no Oracle policy, FK, module family, corpus join, view lineage, org-family prefix, sibling column, own-key or partner rule resolves the organization type' END AS reason
FROM   sec_ores o, sec_rules r
WHERE  o.excluded IS NULL AND o.context IS NULL AND (o.how IS NULL OR o.how = 'tie');
DELETE FROM sec_amb WHERE cardinality(candidates) = 0;

-- corpus usage of the objects that still carry one (eight sources): a statement of every source
-- reading it (bip-report / otbi / view), a parsed join, a mined relationship, an OTBI lineage row,
-- an OTBI probe/crawl column reference, another dictionary view's text
CREATE TEMP TABLE sec_usage ON COMMIT DROP AS
WITH a AS (SELECT DISTINCT table_name FROM sec_amb),
u AS (
  SELECT rt.table_name, 'sql:' || q.source AS src
  FROM   work.r_tables rt JOIN work.clear_sql q ON q.sql_hash = rt.sql_hash
  WHERE  NOT rt.is_cte AND rt.table_name IN (SELECT table_name FROM a)
  UNION ALL SELECT from_t, 'join' FROM work.f_joins WHERE from_t IN (SELECT table_name FROM a)
  UNION ALL SELECT to_t, 'join' FROM work.f_joins WHERE to_t IN (SELECT table_name FROM a)
  UNION ALL SELECT from_table, 'relationship' FROM work.relationships WHERE source = 'mined' AND from_table IN (SELECT table_name FROM a)
  UNION ALL SELECT to_table, 'relationship' FROM work.relationships WHERE source = 'mined' AND to_table IN (SELECT table_name FROM a)
  UNION ALL SELECT upper(db_object), 'otbi_lineage' FROM work.otbi_lineage WHERE upper(db_object) IN (SELECT table_name FROM a)
  UNION ALL SELECT e->>'t', 'otbi_ref' FROM work.otbi_column c, jsonb_array_elements(c.db_refs) e
            WHERE jsonb_typeof(c.db_refs) = 'array' AND e->>'t' IN (SELECT table_name FROM a)
  UNION ALL SELECT a.table_name, 'view_text' FROM a JOIN {{V}}.tables t
            ON t.type = 'VIEW' AND t.name <> a.table_name AND t.view_text ~* ('\m' || a.table_name || '\M'))
SELECT a.table_name, count(u.src)::int AS hits, string_agg(DISTINCT u.src, ',') AS sources
FROM   a LEFT JOIN u ON u.table_name = a.table_name
GROUP  BY 1;

-- item objects: an inventory-org resolution means inventory ∪ item org (never on an Oracle policy)
UPDATE sec_cand k SET context = 'ITM_ORG', reason = k.reason || '; item object: inventory org ∪ item org assignment'
FROM   sec_obj o, sec_rules r
WHERE  o.name = k.table_name AND k.context = 'INV_ORG' AND k.confidence <> 'oracle_policy'
  AND  o.prefix IN (SELECT jsonb_array_elements_text(r.j->'itemOrgPrefixes'));

-- one row per (object, column, context): Oracle policy first, then curated, then the earliest rule
CREATE TEMP TABLE sec_final ON COMMIT DROP AS
SELECT DISTINCT ON (table_name, column_name, context) *
FROM   sec_cand WHERE excluded IS NULL
ORDER  BY table_name, column_name, context, (confidence = 'oracle_policy') DESC, (confidence = 'curated') DESC, rule_order;

-- ---- 7. evidence ------------------------------------------------------------------------
-- Oracle precedent: statements that filter by SELECT <urda col> FROM FUN_USER_ROLE_DATA_ASGNMNTS
CREATE TEMP TABLE sec_prec ON COMMIT DROP AS
WITH s AS (
  SELECT DISTINCT q.sql_hash, upper(m[1]) AS urda
  FROM   work.clear_sql q, sec_rules r,
         regexp_matches(q.sql_text, 'SELECT\s+(?:[A-Za-z0-9_$#]+\.)?([A-Za-z0-9_]+)\s+FROM\s+FUN_USER_ROLE_DATA_ASGNMNTS', 'gi') AS m
  WHERE  q.sql_text ~* 'FUN_USER_ROLE_DATA_ASGNMNTS'
    AND  q.source IN (SELECT jsonb_array_elements_text(r.j#>'{precedent,sources}')))
SELECT rt.table_name, c.context, count(DISTINCT s.sql_hash)::int AS stmts
FROM   s JOIN sec_ctx c ON c.urda_column = s.urda
JOIN   work.r_tables rt ON rt.sql_hash = s.sql_hash AND NOT rt.is_cte
GROUP  BY 1, 2;

-- statements joining the column to one of its context's reference objects
CREATE TEMP TABLE sec_jev ON COMMIT DROP AS
SELECT j.t AS table_name, j.c AS column_name, x.context, count(DISTINCT j.sql_hash)::int AS stmts
FROM  (SELECT from_t AS t, from_c AS c, to_t AS p, sql_hash FROM work.f_joins
       UNION ALL SELECT to_t, to_c, from_t, sql_hash FROM work.f_joins) j
JOIN   sec_ctx x ON j.p = ANY (x.evidence_refs)
WHERE  EXISTS (SELECT 1 FROM sec_final k WHERE k.table_name = j.t AND k.column_name = j.c AND k.context = x.context)
GROUP  BY 1, 2, 3;

-- ---- 8. the release tables ---------------------------------------------------------------
DELETE FROM {{V}}.table_security;
DELETE FROM {{V}}.table_disallowed;
DELETE FROM {{V}}.sec_area_privilege;
DELETE FROM {{V}}.sec_meta;

INSERT INTO {{V}}.table_security (table_name, column_name, context, urda_column, ref_object, ref_column,
                                  is_primary, confidence, evidence, reason)
-- Oracle policy rows: confidence oracle_policy, evidence = the instance sets;
-- the rest: Oracle (OTBI / view) precedent, else the rule's own evidence
SELECT k.table_name, k.column_name, k.context, x.urda_column, x.ref_object, x.ref_column, 0,
       CASE WHEN k.confidence = 'oracle_policy' THEN k.confidence WHEN p.stmts > 0 THEN 'oracle_precedent' ELSE k.confidence END,
       CASE WHEN k.confidence = 'oracle_policy' THEN k.chain_evidence
            WHEN p.stmts > 0 THEN p.stmts WHEN k.confidence = 'corpus_join' THEN k.chain_evidence ELSE coalesce(e.stmts, 0) END,
       CASE WHEN k.confidence = 'oracle_policy' THEN k.reason
            WHEN p.stmts > 0
            THEN p.stmts || ' Oracle statement(s) secure this object''s ' || k.context || ' via URDA.' || x.urda_column || '; ' || k.reason
            ELSE k.reason END
FROM   sec_final k
JOIN   sec_ctx x ON x.context = k.context
LEFT   JOIN sec_polcol pc ON pc.table_name = k.table_name AND pc.column_name = k.column_name AND pc.context = k.context
LEFT   JOIN sec_prec p ON p.table_name = k.table_name AND p.context = k.context
LEFT   JOIN sec_jev e ON e.table_name = k.table_name AND e.column_name = k.column_name AND e.context = k.context;

-- an unresolved column on a USED object: one 'ambiguous' row per candidate — the p6 gate FAILS the
-- release on any (resolve it: a rule, or a curated override)
INSERT INTO {{V}}.table_security (table_name, column_name, context, urda_column, ref_object, ref_column,
                                  is_primary, confidence, evidence, reason)
SELECT a.table_name, a.column_name, x.context, x.urda_column, x.ref_object, x.ref_column, 0, 'ambiguous', 0, a.reason
FROM   sec_amb a JOIN sec_usage u ON u.table_name = a.table_name AND u.hits > 0
CROSS  JOIN LATERAL unnest(a.candidates) AS cand(ctx)
JOIN   sec_ctx x ON x.context = cand.ctx
WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.table_security t
                   WHERE t.table_name = a.table_name AND t.column_name = a.column_name AND t.context = x.context);

-- an unresolved column on an object NO corpus source uses: the object is disallowed in secured SQL
INSERT INTO {{V}}.table_disallowed (table_name, reason)
SELECT a.table_name,
       string_agg(a.reason, '; ' ORDER BY a.column_name) || ' — and ' || a.table_name ||
       ' is used by no corpus SQL (BIP, OTBI, view text), join, relationship or OTBI lineage'
FROM   sec_amb a JOIN sec_usage u ON u.table_name = a.table_name AND u.hits = 0
GROUP  BY a.table_name;

-- primary = the ONE context the table-keyed plan secures: the object's prefix preference, else context
-- order; then the rule order (Oracle policy, exact, suffix, chain), the suffix preference, the column ordinal
WITH pp AS (
  SELECT p.key AS prefix, v.ctx, v.o::int AS o
  FROM   sec_rules r, jsonb_each(r.j->'primaryByPrefix') p, jsonb_array_elements_text(p.value->'contexts') WITH ORDINALITY AS v(ctx, o)
  WHERE  p.key NOT LIKE '\_%'),
ranked AS (
  SELECT t.table_name, t.column_name, t.context,
         row_number() OVER (PARTITION BY t.table_name
                            ORDER BY coalesce(pp.o, 1000), x.ord, k.rule_order, k.pref, k.ordinal, t.column_name COLLATE "C") AS rn
  FROM   {{V}}.table_security t
  JOIN   sec_ctx x ON x.context = t.context
  JOIN   sec_obj o ON o.name = t.table_name
  JOIN   sec_final k ON k.table_name = t.table_name AND k.column_name = t.column_name AND k.context = t.context
  LEFT   JOIN pp ON pp.prefix = o.prefix AND pp.ctx = t.context
  WHERE  t.confidence <> 'ambiguous')
UPDATE {{V}}.table_security t SET is_primary = 1
FROM   ranked r
WHERE  r.rn = 1 AND t.table_name = r.table_name AND t.column_name = r.column_name AND t.context = r.context;

-- ---- 9. the curated area map + the sensitive objects: names only, nothing of any pod ----------------
-- (ddl_version 9: the pod data-security export copies sec_object / sec_privilege are gone — what differs per
-- pod, its registrations and grants, lives ONLY in the customer layer; a curated name that a pod does not
-- register or grant is blocked there at plan time, naming it.)
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT m, '; ') INTO bad FROM (
    -- the area map: names only, every source a known one, every row scoped ('*' or pod hosts), an (area, entity) key real
    SELECT 'areaPrivileges row without area / object / privilege / source / evidence: ' || coalesce(x->>'area', '?') || '/' || coalesce(x->>'object', '?') AS m
    FROM   sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
    WHERE  coalesce(x->>'area', '') = '' OR coalesce(x->>'object', '') = '' OR coalesce(x->>'privilege', '') = '' OR coalesce(x->>'source', '') = '' OR coalesce(x->>'evidence', '') = ''
    UNION ALL SELECT 'areaPrivileges source ' || (x->>'source') || ' not one of trace | inferred (the grade its conditions carry)' FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              WHERE (x->>'source') NOT IN ('trace', 'inferred')
    UNION ALL SELECT 'areaPrivileges row ' || (x->>'area') || ' / ' || (x->>'object') || ' has no `instances` (a non-empty list of pod hosts, or ["*"])'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              WHERE jsonb_typeof(x->'instances') IS DISTINCT FROM 'array' OR jsonb_array_length(x->'instances') = 0
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(x->'instances') i WHERE btrim(i) = '')
    UNION ALL SELECT 'areaPrivileges row ' || (x->>'area') || ' / ' || (x->>'object') || ': entity ' || (x->>'entity') || ' is not in the dictionary'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              WHERE x ? 'entity' AND NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = x->>'entity')
    UNION ALL SELECT 'areaPrivileges row ' || (x->>'area') || ' / ' || (x->>'object') || ': unknown key ' || k
              FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x, jsonb_object_keys(x) k
              WHERE k NOT IN ('area', 'object', 'privilege', 'source', 'instances', 'evidence', 'entity', 'voDef', 'column')
    -- ddl_version 10: `column` = TABLE.COLUMN of the dictionary (the context column a trace names)
    UNION ALL SELECT 'areaPrivileges row ' || (x->>'area') || ' / ' || (x->>'object') || ': column ' || (x->>'column') || ' is not TABLE.COLUMN of the dictionary'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              WHERE x ? 'column' AND (x->>'column' !~ '^[A-Z][A-Z0-9_$#]*[.][A-Z][A-Z0-9_$#]*$'
                                      OR NOT EXISTS (SELECT 1 FROM {{V}}.columns c
                                                     WHERE c.table_name = split_part(x->>'column', '.', 1) AND c.name = split_part(x->>'column', '.', 2)))
    -- one privilege per (area, object): two rows of one area on one object that disagree would block every table on it
    UNION ALL SELECT 'areaPrivileges rows of ' || (x->>'area') || ' disagree on ' || (x->>'object') || ': ' || string_agg(DISTINCT x->>'privilege', ', ')
              FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              GROUP BY x->>'area', x->>'object' HAVING count(DISTINCT x->>'privilege') > 1
    -- ddl_version 10: the reference families (rules referenceFamilies.families)
    UNION ALL SELECT 'referenceFamilies.families is missing or empty' FROM sec_rules r
              WHERE jsonb_typeof(r.j#>'{referenceFamilies,families}') IS DISTINCT FROM 'array' OR jsonb_array_length(r.j#>'{referenceFamilies,families}') = 0
    UNION ALL SELECT 'referenceFamilies family ' || coalesce(f->>'family', '?') || ' is not one of lookup | translation | calendar | currency | territory, or has no nameRe'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{referenceFamilies,families}') f
              WHERE coalesce(f->>'family', '') NOT IN ('lookup', 'translation', 'calendar', 'currency', 'territory') OR coalesce(f->>'nameRe', '') = ''
    UNION ALL SELECT 'referenceFamilies family ' || (f->>'family') || ': unknown key ' || k
              FROM sec_rules r, jsonb_array_elements(r.j#>'{referenceFamilies,families}') f, jsonb_object_keys(f) k
              WHERE k NOT IN ('family', 'nameRe', 'allColumns', 'anyColumns', 'anyColumnSets', 'anyColumnRe', 'idColumnsRe', 'translation')
    UNION ALL SELECT 'referenceFamilies family listed twice: ' || (f->>'family') FROM sec_rules r, jsonb_array_elements(r.j#>'{referenceFamilies,families}') f
              GROUP BY f->>'family' HAVING count(*) > 1
    UNION ALL SELECT 'referenceFamilies: exactly the translation family carries `translation: true`, with allColumns' FROM sec_rules r
              WHERE (SELECT count(*) FROM jsonb_array_elements(r.j#>'{referenceFamilies,families}') f WHERE (f->>'translation')::boolean IS TRUE) <> 1
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.j#>'{referenceFamilies,families}') f
                            WHERE ((f->>'translation')::boolean IS TRUE) <> (f->>'family' = 'translation')
                               OR ((f->>'translation')::boolean IS TRUE AND jsonb_array_length(coalesce(f->'allColumns', '[]')) = 0))
    UNION ALL SELECT 'areaPrivileges row listed twice: ' || (x->>'area') || ' / ' || (x->>'object') || ' / ' || (x->>'privilege') FROM sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') x
              GROUP BY x->>'area', x->>'object', x->>'privilege' HAVING count(*) > 1
    UNION ALL SELECT 'areaPrivileges: `pending` rows are gone (every row names its pair) — remove the block' FROM sec_rules r WHERE r.j#>'{areaPrivileges,pending}' IS NOT NULL
    -- the sensitive objects: every row names a dictionary table read through its OWN object (the table itself) and >= 1 privilege
    UNION ALL SELECT 'sensitive row without table / object / privileges / evidence: ' || coalesce(x->>'table', '?')
              FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x
              WHERE coalesce(x->>'table', '') = '' OR coalesce(x->>'object', '') = '' OR coalesce(x->>'evidence', '') = ''
                 OR jsonb_typeof(x->'privileges') IS DISTINCT FROM 'array' OR jsonb_array_length(x->'privileges') = 0
                 OR (x ? 'maskedOnly' AND jsonb_typeof(x->'maskedOnly') IS DISTINCT FROM 'boolean')
    UNION ALL SELECT 'sensitive table listed twice: ' || (x->>'table') FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x
              GROUP BY x->>'table' HAVING count(*) > 1
    UNION ALL SELECT 'sensitive table ' || (x->>'table') || ' is not in the dictionary' FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x
              WHERE NOT EXISTS (SELECT 1 FROM {{V}}.tables t WHERE t.name = x->>'table')
    UNION ALL SELECT 'sensitive row ' || (x->>'table') || ' names object ' || (x->>'object') || ' — a sensitive table is read through its OWN object'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x WHERE x->>'object' <> x->>'table'
    UNION ALL SELECT 'sensitive row ' || (x->>'table') || ' is maskedOnly but the table carries no MASKED_<col> twin of a column'
              FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x
              WHERE (x->>'maskedOnly')::boolean IS TRUE
                AND NOT EXISTS (SELECT 1 FROM {{V}}.columns m JOIN {{V}}.columns c ON c.table_name = m.table_name AND c.name = substr(m.name, 8)
                                WHERE m.table_name = x->>'table' AND m.name LIKE 'MASKED\_%')
    -- the resolver's module filter: privilegePrefixAliases.map = {module: [privilege prefixes]}
    UNION ALL SELECT 'privilegePrefixAliases.map missing or not an object' FROM sec_rules r WHERE jsonb_typeof(r.j#>'{privilegePrefixAliases,map}') IS DISTINCT FROM 'object'
    UNION ALL SELECT 'privilegePrefixAliases.map.' || k || ' is not a non-empty list of prefixes' FROM sec_rules r, jsonb_each(r.j#>'{privilegePrefixAliases,map}') e(k, v)
              WHERE jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) = 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v) a WHERE a !~ '^[A-Z0-9]+$')
    UNION ALL SELECT 'the rules still carry the retired `export` section (the pod export is gone, ddl_version 9) — remove it' FROM sec_rules r WHERE r.j ? 'export'
  ) s;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_security: area map / sensitive objects invalid: %', bad; END IF;
END $$;

-- the area map: the curated rows, ONE shipped row per instance host of their scope ('*' or a pod host exactly
-- as runSql reports `instance`), with the (area, entity) key when the evidence names the VO reference entity
INSERT INTO {{V}}.sec_area_privilege (area_or_product, ordinal, obj_name, privilege, source, evidence, instance_scope, entity_table, vo_def, context_column)
SELECT area, row_number() OVER (PARTITION BY area ORDER BY o, io)::int, obj_name, privilege, source, evidence, instance_scope, entity_table, vo_def, context_column
FROM (
  SELECT x.r->>'area' AS area, x.o, i.io, x.r->>'object' AS obj_name, x.r->>'privilege' AS privilege, x.r->>'source' AS source, x.r->>'evidence' AS evidence,
         btrim(i.v) AS instance_scope, x.r->>'entity' AS entity_table, x.r->>'voDef' AS vo_def, x.r->>'column' AS context_column
  FROM   sec_rules r, jsonb_array_elements(r.j#>'{areaPrivileges,rows}') WITH ORDINALITY AS x(r, o),
         jsonb_array_elements_text(x.r->'instances') WITH ORDINALITY AS i(v, io)) u;

-- ---- 9b. the reference families (ddl_version 10): name pattern AND reference-shaped columns, one row per table ----------
-- (rules referenceFamilies; the first family in rules order wins; translation last, after the others). Nothing of a pod:
-- whether a translation's base is secured, and whether a member relates to secured data, is decided at plan time.
CREATE TEMP TABLE sec_refcols ON COMMIT DROP AS SELECT table_name, array_agg(name ORDER BY name) AS c FROM {{V}}.columns GROUP BY 1;
CREATE TEMP TABLE sec_refkeys ON COMMIT DROP AS SELECT table_name, array_agg(column_name ORDER BY seq, column_name) AS k FROM {{V}}.pkeys GROUP BY 1;
CREATE UNIQUE INDEX ON sec_refcols (table_name); CREATE UNIQUE INDEX ON sec_refkeys (table_name);
ANALYZE sec_refcols; ANALYZE sec_refkeys;  -- temp tables carry no statistics: without them the planner cross-joins the column arrays
CREATE TEMP TABLE sec_reffam ON COMMIT DROP AS
SELECT f.o AS ord, f.x->>'family' AS family, f.x->>'nameRe' AS name_re,
       ARRAY(SELECT jsonb_array_elements_text(coalesce(f.x->'allColumns', '[]'))) AS all_cols,
       ARRAY(SELECT jsonb_array_elements_text(coalesce(f.x->'anyColumns', '[]'))) AS any_cols,
       ARRAY(SELECT jsonb_array_elements_text(s) FROM jsonb_array_elements(coalesce(f.x->'anyColumnSets', '[]')) s) AS set_cols,
       f.x->'anyColumnSets' AS any_sets, f.x->>'anyColumnRe' AS any_col_re, f.x->>'idColumnsRe' AS id_re,
       coalesce((f.x->>'translation')::boolean, false) AS translation
FROM   sec_rules r, jsonb_array_elements(r.j#>'{referenceFamilies,families}') WITH ORDINALITY AS f(x, o);
-- every rule-named column must be a dictionary column somewhere (a typo fails the build, never a silent empty family)
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT f.family || '.' || c, '; ') INTO bad
  FROM   sec_reffam f, unnest(f.all_cols || f.any_cols || f.set_cols) c
  WHERE  NOT EXISTS (SELECT 1 FROM {{V}}.columns x WHERE x.name = c);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_security: referenceFamilies name columns no dictionary table carries: %', bad; END IF;
END $$;
DELETE FROM {{V}}.table_reference_family;
INSERT INTO {{V}}.table_reference_family (table_name, family, base_table, evidence)
SELECT DISTINCT ON (t.name) t.name, f.family, NULL,
       'name ...' || (regexp_match(t.name, '(' || f.name_re || ')'))[1] || ' (' || f.family || ' pattern); reference columns '
       || array_to_string(ARRAY(SELECT x FROM unnest(c.c) x
                                WHERE x = ANY (f.all_cols || f.any_cols || f.set_cols) OR (f.any_col_re IS NOT NULL AND x ~ f.any_col_re) LIMIT 6), ', ')
       || CASE WHEN f.id_re IS NULL THEN ''
               ELSE '; id columns ' || coalesce(nullif(array_to_string(ARRAY(SELECT x FROM unnest(c.c) x WHERE x ~ '_ID$' LIMIT 6), ', '), ''), 'none')
                    || ' (no business key)' END
FROM   {{V}}.tables t JOIN sec_refcols c ON c.table_name = t.name JOIN sec_reffam f ON NOT f.translation
WHERE  t.name ~ f.name_re
  AND  c.c @> f.all_cols
  AND  (cardinality(f.any_cols) = 0 OR c.c && f.any_cols)
  AND  (f.any_sets IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(f.any_sets) s WHERE c.c @> ARRAY(SELECT jsonb_array_elements_text(s))))
  AND  (f.any_col_re IS NULL OR EXISTS (SELECT 1 FROM unnest(c.c) x WHERE x ~ f.any_col_re))
  AND  (f.id_re IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(c.c) x WHERE x ~ '_ID$' AND x !~ f.id_re))
ORDER  BY t.name, f.ord;
-- translation: the _TL (itself, or the _VL's sibling) carries LANGUAGE + SOURCE_LANG; base = _B, else the stem; every *_ID
-- column a key column of the table / its _TL / its base, or a standard id
CREATE TEMP TABLE sec_reftl ON COMMIT DROP AS
SELECT t.name AS table_name, regexp_replace(t.name, '_VL$', '_TL') AS tl,
       coalesce((SELECT b.name FROM {{V}}.tables b WHERE b.name = regexp_replace(t.name, '_(TL|VL)$', '_B')),
                (SELECT b.name FROM {{V}}.tables b WHERE b.name = regexp_replace(t.name, '_(TL|VL)$', ''))) AS base
FROM   {{V}}.tables t, sec_reffam f WHERE f.translation AND t.name ~ f.name_re;
ANALYZE sec_reftl; ANALYZE sec_reffam;
INSERT INTO {{V}}.table_reference_family (table_name, family, base_table, evidence)
SELECT x.table_name, 'translation', x.base,
       CASE WHEN x.tl = x.table_name THEN 'name ..._TL with ' ELSE 'name ..._VL over ' || x.tl || ' with ' END || array_to_string(f.all_cols, ', ')
       || '; key columns ' || coalesce(nullif(array_to_string(ARRAY(SELECT DISTINCT k FROM unnest(coalesce(k1.k, '{}') || coalesce(k2.k, '{}') || coalesce(k3.k, '{}')) k
                                                                   WHERE k NOT IN ('LANGUAGE', 'SOURCE_LANG') ORDER BY k), ', '), ''), 'none declared')
       || '; every *_ID column a key or a standard id; ' || CASE WHEN x.base IS NULL THEN 'no base table in the dictionary' ELSE 'base ' || x.base END
FROM   sec_reftl x JOIN sec_reffam f ON f.translation
JOIN   sec_refcols c ON c.table_name = x.table_name
JOIN   sec_refcols tc ON tc.table_name = x.tl
LEFT   JOIN sec_refkeys k1 ON k1.table_name = x.table_name
LEFT   JOIN sec_refkeys k2 ON k2.table_name = x.tl
LEFT   JOIN sec_refkeys k3 ON k3.table_name = x.base
WHERE  tc.c @> f.all_cols
  AND  NOT EXISTS (SELECT 1 FROM {{V}}.table_reference_family r WHERE r.table_name = x.table_name)
  AND  NOT EXISTS (SELECT 1 FROM unnest(c.c) col
                   WHERE col ~ '_ID$' AND col !~ f.id_re
                     AND NOT col = ANY (coalesce(k1.k, '{}') || coalesce(k2.k, '{}') || coalesce(k3.k, '{}')));

-- ---- 10. sec_meta: stamps, context order + evidence objects, HCM prefixes, the privilege-prefix aliases, audits, sensitive, stats ----------
INSERT INTO {{V}}.sec_meta (k, v)
SELECT 'version', '2'
UNION ALL SELECT 'built_at', now()::text
UNION ALL SELECT 'source_release', '{{V}}'
UNION ALL SELECT 'rules_version', r.j->>'version' FROM sec_rules r
UNION ALL SELECT 'context_order', (SELECT jsonb_agg(context ORDER BY ord)::text FROM sec_ctx)
-- per context, the reference object and its evidence objects (rules contexts[].evidenceRefs): the area-keyed plan
-- reads a VO's db_objects against them to name the ONE context of a table the VO evidences
UNION ALL SELECT 'context_evidence_refs', (SELECT jsonb_object_agg(context, to_jsonb(evidence_refs || ARRAY[ref_object]))::text FROM sec_ctx)
UNION ALL SELECT 'hcm_prefixes', (r.j#>'{exclude,hcmPrefixes}')::text FROM sec_rules r
-- the resolver's module filter (rules privilegePrefixAliases.map): table module -> the privilege prefixes it may take
UNION ALL SELECT 'privilege_prefix_aliases', (r.j#>'{privilegePrefixAliases,map}')::text FROM sec_rules r
-- the audited primary contexts (rules primaryByPrefix.<prefix>.audit): name prefix -> {contexts, source, evidence};
-- only these prefixes' multi-context tables are secured by the table-keyed plan
UNION ALL SELECT 'primary_audit', coalesce((SELECT jsonb_object_agg(p.key, jsonb_build_object(
    'contexts', p.value->'contexts', 'source', p.value#>>'{audit,source}', 'evidence', p.value#>>'{audit,evidence}') ORDER BY p.key)
  FROM sec_rules r, jsonb_each(r.j->'primaryByPrefix') p WHERE p.key NOT LIKE '\_%' AND p.value ? 'audit'), '{}'::jsonb)::text
-- the sensitive objects (rules sensitive.rows): table -> its own object + privileges (anyOf when several) + the masked twins
UNION ALL SELECT 'sensitive_objects', coalesce((SELECT jsonb_object_agg(x->>'table', jsonb_build_object(
    'object', x->>'object', 'privileges', x->'privileges', 'evidence', x->>'evidence',
    'masked', CASE WHEN (x->>'maskedOnly')::boolean IS TRUE THEN
        (SELECT jsonb_agg(jsonb_build_object('column', c.name, 'use', m.name) ORDER BY c.name)
         FROM {{V}}.columns m JOIN {{V}}.columns c ON c.table_name = m.table_name AND c.name = substr(m.name, 8)
         WHERE m.table_name = x->>'table' AND m.name LIKE 'MASKED\_%')
      ELSE '[]'::jsonb END) ORDER BY x->>'table')
  FROM sec_rules r, jsonb_array_elements(r.j#>'{sensitive,rows}') x), '{}'::jsonb)::text
-- the Oracle policy input as parsed: every instance set (shape, the columns it maps, or why none),
-- every policy column (the context taken and how), the derived module families
UNION ALL SELECT 'policy_source', jsonb_build_object(
  'file', 'scripts/pipeline/oracle_datasec_policies.csv',
  'extract', 'FND_OBJECTS x FND_OBJECT_INSTANCE_SETS where UPPER(PREDICATE) LIKE ''%FUN_USER_ROLE_DATA_ASGNMNTS%'' (predicate cut at 1,000 chars)',
  'instance_sets', (SELECT count(*) FROM sec_pol), 'objects', (SELECT count(DISTINCT table_name) FROM sec_pol),
  'objects_not_in_catalog', (SELECT coalesce(jsonb_agg(DISTINCT table_name), '[]') FROM sec_pol WHERE NOT in_catalog))::text
UNION ALL SELECT 'policy_sets', (SELECT jsonb_agg(jsonb_build_object(
    'table', s.table_name, 'objName', s.obj_name, 'set', s.set_name, 'code', s.code, 'shape', s.kind,
    'columns', (SELECT jsonb_agg(jsonb_build_object('column', d.column_name, 'context', d.context, 'urda', d.urda_column, 'flags', nullif(d.flags, ''))
                                 ORDER BY d.column_name, d.context)
                FROM sec_poldir d WHERE d.table_name = s.table_name AND d.set_name = s.set_name),
    'why', s.why, 'truncated', s.truncated) ORDER BY s.table_name, s.set_name) FROM sec_pol s)::text
UNION ALL SELECT 'policy_columns', (SELECT jsonb_agg(jsonb_build_object(
    'table', c.table_name, 'column', c.column_name, 'context', c.context, 'decidedBy', c.decided_by,
    'contexts', (SELECT jsonb_object_agg(z.context, z.sets) FROM (SELECT d.context, string_agg(d.set_name, ', ' ORDER BY d.set_name) AS sets
                 FROM sec_poldir d WHERE d.table_name = c.table_name AND d.column_name = c.column_name GROUP BY 1) z))
    ORDER BY c.table_name, c.column_name) FROM sec_polcol c)::text
UNION ALL SELECT 'module_families', (SELECT jsonb_agg(jsonb_build_object(
    'app', f.app, 'context', f.context, 'how', f.how, 'contexts', to_jsonb(f.ctxs), 'evidence', f.sets, 'reason', f.reason,
    'catalogApplication', f.is_app) ORDER BY f.is_app DESC, f.app) FROM sec_modfam f)::text
UNION ALL SELECT 'stats', jsonb_build_object(
  'policy', jsonb_build_object(
      'sets_by_shape', (SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) n FROM sec_pol GROUP BY 1) s),
      'columns_by_decision', (SELECT jsonb_object_agg(decided_by, n) FROM (SELECT decided_by, count(*) n FROM sec_polcol GROUP BY 1) s),
      'module_applications', (SELECT count(*) FROM sec_modfam WHERE is_app AND context IS NOT NULL),
      'module_rule_columns', (SELECT count(*) FROM sec_ores WHERE how = 'module' AND excluded IS NULL)),
  'objects_with_context', (SELECT count(DISTINCT table_name) FROM {{V}}.table_security WHERE confidence <> 'ambiguous'),
  'rows_by_context', (SELECT jsonb_object_agg(context, n) FROM (SELECT context, count(*) n FROM {{V}}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1) s),
  'rows_by_confidence', (SELECT jsonb_object_agg(confidence, n) FROM (SELECT confidence, count(*) n FROM {{V}}.table_security GROUP BY 1) s),
  'ambiguous_on_used_columns', (SELECT count(*) FROM sec_amb a JOIN sec_usage u ON u.table_name = a.table_name AND u.hits > 0),
  'disallowed_objects', (SELECT count(*) FROM {{V}}.table_disallowed),
  'org_chain', (SELECT jsonb_object_agg(outcome, n) FROM (
      SELECT CASE WHEN how IS NOT NULL THEN how WHEN excluded IS NOT NULL THEN 'excluded object/column' ELSE 'unresolved' END AS outcome,
             count(*) n FROM sec_ores GROUP BY 1) s),
  'excluded_candidates', (SELECT jsonb_object_agg(excluded, n) FROM (SELECT excluded, count(*) n FROM (
      SELECT excluded FROM sec_cand WHERE excluded IS NOT NULL
      UNION ALL SELECT excluded FROM sec_ores WHERE excluded IS NOT NULL) e GROUP BY 1) s),
  'area_rows_by_source', (SELECT jsonb_object_agg(source, n) FROM (SELECT source, count(*) n FROM {{V}}.sec_area_privilege GROUP BY 1) s),
  'area_rows_with_entity', (SELECT count(*) FROM {{V}}.sec_area_privilege WHERE entity_table IS NOT NULL),
  'area_rows_with_column', (SELECT count(*) FROM {{V}}.sec_area_privilege WHERE context_column IS NOT NULL),
  'reference_tables_by_family', (SELECT coalesce(jsonb_object_agg(family, n), '{}') FROM (SELECT family, count(*) n FROM {{V}}.table_reference_family GROUP BY 1) s),
  'reference_translations_without_base', (SELECT count(*) FROM {{V}}.table_reference_family WHERE family = 'translation' AND base_table IS NULL),
  'primary_audit_prefixes', (SELECT coalesce(jsonb_agg(p.key ORDER BY p.key), '[]') FROM sec_rules r, jsonb_each(r.j->'primaryByPrefix') p
                             WHERE p.key NOT LIKE '\_%' AND p.value ? 'audit'),
  'multi_context_tables', (SELECT count(*) FROM (SELECT table_name FROM {{V}}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1 HAVING count(*) > 1) m),
  'sensitive_tables', (SELECT jsonb_array_length(coalesce(r.j#>'{sensitive,rows}', '[]')) FROM sec_rules r))::text;

\echo '--- ORGANIZATION_ID chain: every column decided by a rule other than name / FK / vote / prefix / sibling ---'
SELECT o.how, o.table_name, o.column_name, o.context, left(coalesce(o.detail, o.excluded), 110) AS detail,
       CASE WHEN a.table_name IS NULL THEN NULL WHEN u.hits > 0 THEN 'AMBIGUOUS ON A USED OBJECT (' || u.sources || ')' ELSE 'disallowed' END AS verdict
FROM   sec_ores o
LEFT   JOIN sec_amb a ON a.table_name = o.table_name AND a.column_name = o.column_name
LEFT   JOIN sec_usage u ON u.table_name = o.table_name
WHERE  o.how IN ('tie', 'own_id_space', 'non_org_partner', 'curated_set', 'curated_none') OR a.table_name IS NOT NULL
ORDER  BY (a.table_name IS NOT NULL AND u.hits > 0) DESC, o.how, o.table_name;

-- every Oracle policy column must have landed as exactly its oracle_policy row
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(m, '; ') INTO bad FROM (
    SELECT 'missing ' || c.table_name || '.' || c.column_name || ' -> ' || c.context AS m FROM sec_polcol c
    WHERE  c.context IS NOT NULL AND NOT EXISTS (SELECT 1 FROM {{V}}.table_security t WHERE t.table_name = c.table_name
                                                 AND t.column_name = c.column_name AND t.context = c.context AND t.confidence = 'oracle_policy')
    UNION ALL
    SELECT 'extra ' || t.table_name || '.' || t.column_name || ' -> ' || t.context || ' (' || t.confidence || ')' FROM {{V}}.table_security t
    JOIN   sec_polcol c ON c.table_name = t.table_name AND c.column_name = t.column_name AND c.context IS NOT NULL
    WHERE  t.confidence <> 'oracle_policy' OR t.context <> c.context) s;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'p5_security: Oracle policy columns not applied exactly: %', bad; END IF;
END $$;

\echo '--- Oracle policy: instance sets by shape (direct = a column fact; every other shape is reported, never guessed) ---'
SELECT kind AS shape, count(*) AS sets, count(DISTINCT table_name) AS objects FROM sec_pol GROUP BY 1 ORDER BY 2 DESC;
\echo '--- Oracle policy: sets with no column fact, and why ---'
SELECT table_name, set_name, kind AS shape, left(why, 150) AS why FROM sec_pol WHERE kind <> 'direct' ORDER BY kind, table_name, set_name;
\echo '--- Oracle policy: columns (context taken; standard_set = one set per module, the standard one decides; conflict = no fact) ---'
SELECT table_name, column_name, context, decided_by, left(array_to_string(ctxs, '/'), 30) AS contexts, left(sets, 90) AS sets
FROM   sec_polcol ORDER BY decided_by <> 'single' DESC, table_name, column_name;
\echo '--- module families (application -> org context of a generic ORGANIZATION_ID; how = code | object evidence | judgment) ---'
SELECT app, context, how, array_to_string(ctxs, '/') AS contexts, is_app AS catalog_app, left(coalesce(sets, reason), 120) AS evidence
FROM   sec_modfam ORDER BY is_app DESC, context NULLS FIRST, app;

COMMIT;

ANALYZE {{V}}.table_security; ANALYZE {{V}}.table_disallowed; ANALYZE {{V}}.sec_area_privilege; ANALYZE {{V}}.table_reference_family;

\echo '--- table_security rows per context (resolved), objects, primaries ---'
SELECT context, count(*) AS rows, count(DISTINCT table_name) AS objects, sum(is_primary) AS primaries
FROM   {{V}}.table_security WHERE confidence <> 'ambiguous' GROUP BY 1 ORDER BY 2 DESC;
\echo '--- by confidence ---'
SELECT confidence, count(*) AS rows, count(DISTINCT table_name) AS objects FROM {{V}}.table_security GROUP BY 1 ORDER BY 2 DESC;
\echo '--- stats ---'
SELECT v AS stats FROM {{V}}.sec_meta WHERE k = 'stats';
\echo '--- the reference families (ddl_version 10): tables per family, with examples ---'
SELECT family, count(*) AS tables, count(base_table) AS with_base,
       left(string_agg(table_name, ', ' ORDER BY table_name) FILTER (WHERE table_name ~ '^(FND|GL|HZ|AP|AR)_'), 160) AS examples
FROM   {{V}}.table_reference_family GROUP BY 1 ORDER BY 1;
\echo '--- the area map by source / (area, entity) key ---'
SELECT source, (entity_table IS NOT NULL) AS keyed, count(*) AS rows, count(DISTINCT area_or_product) AS areas,
       string_agg(DISTINCT coalesce(obj_name || ' / ' || privilege, '-'), '; ') AS pairs
FROM   {{V}}.sec_area_privilege GROUP BY 1, 2 ORDER BY 1, 2;
