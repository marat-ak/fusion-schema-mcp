-- ============================================================================
-- P3c2 — RECONCILIATION. Runs after p3_post, before p3_rel.
--
-- `work.f_tables` is the PARSE OF RECORD: exactly what one pinned sqlglot==30.18.0
-- run produced, and nothing else. That is what makes it reproducible, and this step
-- does not touch it.
--
-- `work.r_tables` is the RECONCILED FACT SET — the parse plus the model's accepted
-- corrections, every row carrying how it got there. **Downstream reads r_tables.**
-- No consumer reads f_tables as a fact source once this table exists: this file is
-- the only reader. (p3_facts creates it, p3_parse.py writes it and p3_post indexes
-- and counts it — that is the producer side, not consumption.) There is ONE
-- reconciled table, not a v1/v2 pair.
--
-- ---------------------------------------------------------------------------
-- THE VERDICT: ADD, DO NOT REMOVE. Measured, not assumed.
--
-- The two correction kinds are not symmetric and the evidence is not close.
--
--   extraTables — "this table is NOT used". 2,488 claims, 2,373 of which name a
--   table THIS parse independently finds. Of those 2,373:
--       2,373 (100 %)  the name occurs in the statement text as a standalone word
--       2,272 ( 96 %)  it is a real object in the vendor dictionary
--       1,432 ( 60 %)  it sits directly after FROM / JOIN / UPDATE / INTO
--       2,373 ( 95 % of all extra claims) come from statements where the model
--                      ALSO said tablesConfirmed = true — it asserted the table
--                      set was correct and listed exclusions in the same breath.
--   Two parsers (the lost August one that produced the facts the model reviewed,
--   and this one) plus the literal text agree against one model reading, and the
--   model contradicts itself on 95 % of the claims. REMOVAL IS UNSUPPORTABLE.
--   Nothing is removed. Those rows stay, marked `model_disputed`, so a consumer
--   that wants to weigh the objection still can.
--
--   missingTables — "you missed this table". 1,077 claims, 921 actionable (this
--   parse does not list them). The parse is known to under-report: qualify() drops
--   what it cannot bind, silently. Of the 921:
--         884 ( 96 %)  the name occurs in the statement text
--         781 ( 85 %)  it is a real object in the dictionary
--         747 ( 81 %)  BOTH — accepted, added as `model_added`
--         137          not a vendor object. 106 are bare names that are really
--                      query ALIASES (CC, GLL, FSV, GLBATCH…) or DUAL (29×) — the
--                      dictionary test is doing real work here. 31 are
--                      schema-qualified or package references (FUSION.SVC_…,
--                      HWM_FUNC_PRINTABLE_TC.CALCULATED_DAILY_TOTALS).
--          37          the name does not occur in the SQL at all — hallucinated
--   Only the 747 that are BOTH a real vendor object AND present in the text are
--   added. The other 174 keep a verdict in work.qwen_table_correction rather than
--   being silently dropped.
--
--   The leading `FUSION.` schema qualifier IS stripped (rule taken 2026-09-21; it
--   was 20 of the 31 schema-qualified rejects, 7 distinct names). The stripped
--   spelling is `qwen_table_correction.name_norm`, a generated column declared in
--   p2_promote.sql; every test and the added row use it, `table_name` stays the
--   claim as spelled. The verify block prints how many claims the strip touched.
--
--   THE TEST THAT SETTLES IT: where do the two kinds land relative to parse quality?
--   Additions cluster exactly where sqlglot ADMITS it could not read the statement —
--   502 of 747 (67 %) sit on `fallback`/`failed` parses, which are only 7.9 % of the
--   corpus. Removals do the opposite: 2,286 of 2,373 unsupported `extra` claims sit on
--   `full` parses, statements the parser read completely. The model is strongest exactly
--   where the parser is weakest, and weakest exactly where it is strongest.
--
--   THE HONEST WEAKNESS OF THE ADD SIDE: only 3 of the 747 additions sit directly after
--   FROM/JOIN. That is expected — a table in an obvious FROM position is one sqlglot
--   would have found — but it means 744 additions rest on "a real vendor object whose
--   name appears somewhere in the statement", which a column name or a string literal
--   could also satisfy. The parse-quality correlation above is what carries this, not
--   the text test on its own.
--
-- tablesConfirmed is folded in as a CONFIDENCE SIGNAL (`model_verdict`), never as
-- an action: 546 statements are `disputed`, the rest `confirmed` or `none`.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1 — test every claim against the SQL text and the dictionary
-- ---------------------------------------------------------------------------
UPDATE work.qwen_table_correction k SET
  in_parse = EXISTS (SELECT 1 FROM work.f_tables f
                     WHERE f.sql_hash = k.sql_hash AND NOT f.is_cte
                       AND f.table_name = k.name_norm),
  in_dictionary = EXISTS (SELECT 1 FROM work.meta_tables m
                          WHERE upper(m.table_name) = k.name_norm),
  in_sql_text = (work.norm_sql(c.sql_text)
                   ~ ('(^|[^a-z0-9_])' || lower(k.name_norm) || '([^a-z0-9_]|$)')),
  after_from_or_join = (work.norm_sql(c.sql_text)
                   ~ ('(from|join|update|into)[ (]+' || lower(k.name_norm) || '([^a-z0-9_]|$)'))
FROM work.clear_sql c
WHERE c.sql_hash = k.sql_hash;

-- ---------------------------------------------------------------------------
-- 2 — the verdict per claim. One rule, stated once.
-- ---------------------------------------------------------------------------
UPDATE work.qwen_table_correction SET
  applied = (kind = 'missing' AND NOT in_parse AND in_dictionary AND in_sql_text),
  verdict = CASE
    WHEN kind = 'extra'   AND NOT in_parse     THEN 'moot_parse_agrees'
    WHEN kind = 'extra'                        THEN 'unsupported_kept'
    WHEN kind = 'missing' AND in_parse         THEN 'moot_already_present'
    WHEN kind = 'missing' AND NOT in_sql_text  THEN 'rejected_name_absent_from_sql'
    WHEN kind = 'missing' AND NOT in_dictionary THEN 'rejected_not_a_vendor_object'
    WHEN kind = 'missing'                      THEN 'applied'
  END;

CREATE INDEX IF NOT EXISTS ix_qwen_corr_verdict ON work.qwen_table_correction (verdict);
ANALYZE work.qwen_table_correction;

-- ---------------------------------------------------------------------------
-- 3 — the reconciled fact set
--
-- provenance:
--   parser          the parse found it; this statement has no model verdict
--   agreed          the parse found it and the model did not object
--   model_disputed  the parse found it and the model called it extra — KEPT
--   model_added     the parse missed it and the evidence backed the model
--
-- The value `model_removed` does NOT occur. It is not an oversight: on the
-- numbers above nothing qualifies for removal, and inventing an empty category
-- would suggest otherwise.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS work.r_tables CASCADE;
CREATE TABLE work.r_tables (
  sql_hash      text    NOT NULL,
  table_name    text    NOT NULL,
  is_cte        boolean NOT NULL,
  provenance    text    NOT NULL,   -- parser | agreed | model_disputed | model_added
  model_verdict text    NOT NULL,   -- confirmed | disputed | none  (tablesConfirmed)
  PRIMARY KEY (sql_hash, table_name, is_cte)
);

-- 3a — every parse row, classified
INSERT INTO work.r_tables (sql_hash, table_name, is_cte, provenance, model_verdict)
SELECT f.sql_hash, f.table_name, f.is_cte,
       CASE
         WHEN c.tables_confirmed IS NULL THEN 'parser'
         WHEN NOT f.is_cte AND EXISTS (
                SELECT 1 FROM work.qwen_table_correction k
                WHERE k.sql_hash = f.sql_hash AND k.kind = 'extra'
                  AND k.name_norm = f.table_name)           THEN 'model_disputed'
         ELSE 'agreed'
       END,
       CASE WHEN c.tables_confirmed IS TRUE  THEN 'confirmed'
            WHEN c.tables_confirmed IS FALSE THEN 'disputed'
            ELSE 'none' END
FROM   work.f_tables f
JOIN   work.clear_sql c ON c.sql_hash = f.sql_hash
ON CONFLICT DO NOTHING;

-- 3b — the accepted additions
INSERT INTO work.r_tables (sql_hash, table_name, is_cte, provenance, model_verdict)
SELECT DISTINCT k.sql_hash, k.name_norm, false, 'model_added',
       CASE WHEN c.tables_confirmed IS TRUE  THEN 'confirmed'
            WHEN c.tables_confirmed IS FALSE THEN 'disputed'
            ELSE 'none' END
FROM   work.qwen_table_correction k
JOIN   work.clear_sql c ON c.sql_hash = k.sql_hash
WHERE  k.applied
ON CONFLICT DO NOTHING;

CREATE INDEX ix_r_tables_hash  ON work.r_tables (sql_hash);
CREATE INDEX ix_r_tables_table ON work.r_tables (table_name) WHERE NOT is_cte;
CREATE INDEX ix_r_tables_prov  ON work.r_tables (provenance);
ANALYZE work.r_tables;

-- ================= verify =================
\echo '--- the evidence: EXTRA claims (the case for removal) ---'
SELECT count(*)                                                     AS claims,
       count(*) FILTER (WHERE in_parse)                             AS this_parse_finds_it,
       count(*) FILTER (WHERE in_parse AND in_sql_text)             AS name_in_sql_text,
       count(*) FILTER (WHERE in_parse AND in_dictionary)           AS real_vendor_object,
       count(*) FILTER (WHERE in_parse AND after_from_or_join)      AS directly_after_from_join,
       count(*) FILTER (WHERE in_parse AND NOT in_sql_text)         AS name_absent_from_sql
FROM   work.qwen_table_correction WHERE kind = 'extra';

\echo '--- ...and the self-contradiction: extra claims raised WITH tablesConfirmed=true ---'
SELECT c.tables_confirmed, count(*) AS extra_claims, count(DISTINCT k.sql_hash) AS statements
FROM   work.qwen_table_correction k JOIN work.clear_sql c ON c.sql_hash = k.sql_hash
WHERE  k.kind = 'extra' GROUP BY 1 ORDER BY 1;

\echo '--- the evidence: MISSING claims (the case for adding) ---'
SELECT count(*)                                                          AS claims,
       count(*) FILTER (WHERE NOT in_parse)                              AS actionable,
       count(*) FILTER (WHERE NOT in_parse AND in_sql_text)              AS name_in_sql_text,
       count(*) FILTER (WHERE NOT in_parse AND in_dictionary)            AS real_vendor_object,
       count(*) FILTER (WHERE NOT in_parse AND in_dictionary AND in_sql_text) AS both_accepted,
       count(*) FILTER (WHERE NOT in_parse AND NOT in_dictionary)        AS not_a_vendor_object,
       count(*) FILTER (WHERE NOT in_parse AND NOT in_sql_text)          AS name_absent_from_sql
FROM   work.qwen_table_correction WHERE kind = 'missing';

\echo '--- every claim, by verdict ---'
SELECT kind, verdict, count(*) AS claims, count(DISTINCT sql_hash) AS statements,
       count(*) FILTER (WHERE applied) AS applied
FROM   work.qwen_table_correction GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo '--- rejected MISSING claims: what kind of name were they? ---'
SELECT verdict,
       count(*) FILTER (WHERE table_name LIKE '%.%')      AS qualified_or_package,
       count(*) FILTER (WHERE table_name NOT LIKE '%.%')  AS bare_name,
       count(*)                                           AS claims
FROM   work.qwen_table_correction
WHERE  kind = 'missing' AND verdict LIKE 'rejected%' GROUP BY 1 ORDER BY 1;

\echo '--- the FUSION. prefix strip: claims it touched, and what became of them ---'
SELECT count(*)                                    AS prefixed_claims,
       count(DISTINCT k.name_norm)                 AS distinct_names,
       count(*) FILTER (WHERE k.applied)           AS applied,
       count(*) FILTER (WHERE k.in_dictionary)     AS in_dictionary
FROM   work.qwen_table_correction k
WHERE  k.kind = 'missing' AND k.table_name <> k.name_norm;

\echo '--- THE TEST THAT SETTLES IT: claims vs parse quality ---'
SELECT c.parse_quality,
       (SELECT count(*) FROM work.clear_sql z WHERE z.parse_quality = c.parse_quality) AS corpus_statements,
       count(*) FILTER (WHERE k.applied)                       AS additions_applied,
       count(*) FILTER (WHERE k.verdict = 'unsupported_kept')  AS extra_claims_rejected
FROM   work.qwen_table_correction k JOIN work.clear_sql c ON c.sql_hash = k.sql_hash
GROUP  BY 1 ORDER BY 2 DESC;

\echo '--- how strong is the positional evidence for the additions? ---'
SELECT count(*) AS applied,
       count(*) FILTER (WHERE after_from_or_join)     AS directly_after_from_join,
       count(*) FILTER (WHERE NOT after_from_or_join) AS name_only_somewhere_in_text,
       count(DISTINCT table_name)                     AS distinct_objects
FROM   work.qwen_table_correction WHERE applied;

\echo '--- the reconciled fact set, by provenance ---'
SELECT provenance, count(*) AS rows, count(DISTINCT sql_hash) AS statements,
       count(DISTINCT table_name) AS objects
FROM   work.r_tables GROUP BY 1 ORDER BY 2 DESC;

\echo '--- r_tables vs f_tables: the delta is additions only ---'
SELECT (SELECT count(*) FROM work.f_tables)                      AS f_tables_rows,
       (SELECT count(*) FROM work.r_tables)                      AS r_tables_rows,
       (SELECT count(*) FROM work.r_tables WHERE provenance = 'model_added') AS added,
       (SELECT count(*) FROM work.f_tables f
        WHERE NOT EXISTS (SELECT 1 FROM work.r_tables r
                          WHERE r.sql_hash = f.sql_hash AND r.table_name = f.table_name
                            AND r.is_cte = f.is_cte))            AS dropped_must_be_zero;

\echo '--- which statements actually changed ---'
SELECT c.source,
       count(DISTINCT r.sql_hash) FILTER (WHERE r.provenance = 'model_added')    AS statements_gained_a_table,
       count(DISTINCT r.sql_hash) FILTER (WHERE r.provenance = 'model_disputed') AS statements_with_a_disputed_table
FROM   work.r_tables r JOIN work.clear_sql c ON c.sql_hash = r.sql_hash
GROUP  BY 1 ORDER BY 1;

\echo '--- confidence signal carried on the reconciled rows ---'
SELECT model_verdict, count(*) AS rows, count(DISTINCT sql_hash) AS statements
FROM   work.r_tables GROUP BY 1 ORDER BY 2 DESC;
