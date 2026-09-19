\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS work.embeddings (
  owner_kind text NOT NULL,
  owner_id   text NOT NULL,
  slot       smallint NOT NULL,
  text_hash  text,
  model      text NOT NULL,
  embedding  vector(384) NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, slot)
);

CREATE TABLE IF NOT EXISTS work.relationships (
  from_table  text, from_col text,
  to_table    text, to_col   text,
  evidence    text, occurrences integer, confidence text, predicate text,
  source      text NOT NULL,
  inputs_hash text
);

-- ---------- S6: slot 0 = the description vector ----------
INSERT INTO work.embeddings (owner_kind, owner_id, slot, model, embedding)
SELECT 'unit', rq.id, 0, 'Xenova/bge-small-en-v1.5', rq.embedding
FROM   v2026_09.report_queries rq
JOIN   work.enrichment e ON e.unit_id = rq.id
WHERE  rq.embedding IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------- S6: slots 1..n = one per intent, insert order preserves slot order ----------
INSERT INTO work.embeddings (owner_kind, owner_id, slot, model, embedding)
SELECT 'unit', rq.id,
       (row_number() OVER (PARTITION BY m.qrowid ORDER BY m.id) - 1)::smallint,
       'Xenova/bge-small-en-v1.5', m.embedding
FROM   v2026_09.report_queries_vec_multi m
JOIN   v2026_09.report_queries rq ON rq.rid = m.qrowid
JOIN   work.enrichment e ON e.unit_id = rq.id
ON CONFLICT DO NOTHING;

-- ---------- S7: relationships ----------
INSERT INTO work.relationships
       (from_table, from_col, to_table, to_col, evidence,
        occurrences, confidence, predicate, source, inputs_hash)
SELECT r.from_table, r.from_col, r.to_table, r.to_col, r.evidence,
       r.occurrences, r.confidence, r.predicate, r.source, 'oracle:v2026_09'
FROM   v2026_09.relationships r
WHERE  NOT EXISTS (
         SELECT 1 FROM work.relationships w
         WHERE  w.from_table IS NOT DISTINCT FROM r.from_table
           AND  w.from_col   IS NOT DISTINCT FROM r.from_col
           AND  w.to_table   IS NOT DISTINCT FROM r.to_table
           AND  w.to_col     IS NOT DISTINCT FROM r.to_col
           AND  w.source     = r.source);

COMMIT;

-- ================= verify =================
SELECT 'embeddings' AS t, count(*) AS rows, count(DISTINCT owner_id) AS owners,
       max(slot) AS max_slot FROM work.embeddings
UNION ALL
SELECT 'relationships', count(*), count(DISTINCT source), NULL FROM work.relationships;

SELECT source, count(*) FROM work.relationships GROUP BY 1 ORDER BY 1;

-- enrichment coverage by source
SELECT u.source,
       count(*) AS active,
       count(*) FILTER (WHERE g.unit_id IS NOT NULL) AS grounded,
       count(*) FILTER (WHERE e.unit_id IS NOT NULL) AS enriched,
       count(*) FILTER (WHERE v.owner_id IS NOT NULL) AS embedded
FROM   work.active_unit u
LEFT   JOIN work.grounding  g ON g.unit_id = u.unit_id
LEFT   JOIN work.enrichment e ON e.unit_id = u.unit_id
LEFT   JOIN work.embeddings v ON v.owner_kind='unit' AND v.owner_id=u.unit_id AND v.slot=0
GROUP  BY u.source ORDER BY 1;
