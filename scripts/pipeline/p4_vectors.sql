-- ============================================================================
-- P4a — the vector table. Populated by p4_embed.mts (which runs INSIDE the
-- fusion-schema-mcp build image and imports the repo's own embedder).
--
-- MULTIPLE vectors per statement, matching the sqlite shape:
--   slot 0     = `${description}\nTables: ${tables.join(", ")}`
--   slot 1..n  = one per intent, blanks filtered
-- exactly embedTexts(), src/corpus/ingestStore.ts:16-18.
-- Statements with no intents (the enrich queue) get slot 0 only.
-- ============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS work.embeddings;
CREATE TABLE work.embeddings (
  owner_kind text NOT NULL,          -- 'unit' (a clear_sql statement) | 'layout' (a pattern)
  owner_id   text NOT NULL,          -- sql_hash | layout pattern id
  slot       smallint NOT NULL,
  text_hash  text NOT NULL,          -- md5 of the EXACT text that produced this vector
  model      text NOT NULL,
  embedding  vector(384) NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, slot)
);
