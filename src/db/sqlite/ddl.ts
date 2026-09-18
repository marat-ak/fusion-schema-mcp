/**
 * The complete SQLite shape, idempotent (CREATE ... IF NOT EXISTS) — one place, applied at every
 * open. Replaces the per-module CREATE blocks + the runtime ALTER shims the modules used to carry.
 * Attached names: schemadb / enrichdb / cachedb / factsdb; MAIN = reports.sqlite.
 */
import { EMBED_DIM } from "../../corpus/embed.js";

export const DDL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schemadb.tables (
    name TEXT PRIMARY KEY, schema TEXT, type TEXT, module TEXT, remarks TEXT, view_text TEXT
  );
  CREATE TABLE IF NOT EXISTS schemadb.columns (
    table_name TEXT, name TEXT, data_type TEXT, size INTEGER, nullable INTEGER, remarks TEXT, ordinal INTEGER
  );
  CREATE TABLE IF NOT EXISTS schemadb.pkeys (table_name TEXT, column_name TEXT, seq INTEGER);
  CREATE TABLE IF NOT EXISTS schemadb.fkeys (child_table TEXT, parent_table TEXT, column_name TEXT, seq INTEGER, name TEXT);
  CREATE TABLE IF NOT EXISTS schemadb.indexes (table_name TEXT, index_name TEXT, is_unique INTEGER, ordinal INTEGER, column_name TEXT);
  CREATE TABLE IF NOT EXISTS schemadb.relationships (
    from_table TEXT, from_col TEXT, to_table TEXT, to_col TEXT,
    evidence TEXT, occurrences INTEGER, confidence TEXT, predicate TEXT, source TEXT
  );
  CREATE TABLE IF NOT EXISTS schemadb.meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE VIRTUAL TABLE IF NOT EXISTS schemadb.tables_fts USING fts5(name, remarks, module, content='');
`;

export const DDL_REPORTS = `
  CREATE TABLE IF NOT EXISTS main.report_queries (
    id TEXT PRIMARY KEY, source TEXT, title TEXT,
    original_sql TEXT, clean_sql TEXT, description TEXT,
    tables_used TEXT, joins TEXT, filters TEXT, lookup_types TEXT,
    security_predicate TEXT, approved INTEGER, embedding BLOB, reports TEXT, intents TEXT, mechanics TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS main.report_queries_vec USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIM}]);
  CREATE VIRTUAL TABLE IF NOT EXISTS main.report_queries_vec_multi USING vec0(embedding FLOAT[${EMBED_DIM}], +qrowid INTEGER);

  CREATE TABLE IF NOT EXISTS main.table_grain (
    table_name TEXT PRIMARY KEY,
    grain TEXT NOT NULL,
    multi_row INTEGER NOT NULL,
    dedup TEXT,
    signals TEXT,
    corpus_evidence INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS main.grain_meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS main.table_usages (
    table_name TEXT NOT NULL,
    query_id   TEXT NOT NULL,
    source     TEXT,
    title      TEXT,
    sql_chars  INTEGER NOT NULL DEFAULT 0,
    score      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS main.ix_table_usages ON table_usages(table_name, score DESC);
  CREATE TABLE IF NOT EXISTS main.usage_meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS main.table_predicates (
    table_name  TEXT NOT NULL,
    column_name TEXT NOT NULL,
    op          TEXT NOT NULL,
    literal     TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 0,
    role        TEXT NOT NULL DEFAULT 'structural'
  );
  CREATE INDEX IF NOT EXISTS main.ix_table_predicates ON table_predicates(table_name);
  CREATE TABLE IF NOT EXISTS main.pred_meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS main.layout_patterns (
    rowid INTEGER PRIMARY KEY,
    id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    format TEXT NOT NULL, format_exclusive INTEGER DEFAULT 0, dsl_support TEXT NOT NULL,
    description TEXT NOT NULL, when_to_use TEXT NOT NULL, intents TEXT NOT NULL,
    requires TEXT, composition TEXT, recipe TEXT, fixture_ref TEXT, pitfalls TEXT,
    trigger TEXT, why TEXT, instead TEXT, alternative TEXT,
    source_refs TEXT, verified TEXT NOT NULL, dsl_version TEXT, verified_at TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS main.layout_patterns_vec USING vec0(embedding float[${EMBED_DIM}], +prowid INTEGER);
  CREATE TABLE IF NOT EXISTS main.layout_meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS main.flexfields (
    application_id   INTEGER,
    flexfield_type   TEXT NOT NULL,
    flexfield_code   TEXT NOT NULL,
    deployment_status TEXT,
    context_code     TEXT NOT NULL,
    context_enabled  TEXT,
    multirow         TEXT,
    translatable     TEXT,
    segment_code     TEXT NOT NULL,
    column_name      TEXT,
    sequence_number  INTEGER,
    segment_name     TEXT,
    prompt           TEXT,
    display_type     TEXT,
    value_set_id     INTEGER,
    required         TEXT,
    segment_enabled  TEXT,
    source           TEXT NOT NULL DEFAULT 'admin-export',
    loaded_at        TEXT NOT NULL,
    UNIQUE(flexfield_type, application_id, flexfield_code, context_code, segment_code, source)
  );
  CREATE INDEX IF NOT EXISTS main.idx_flex_code    ON flexfields(flexfield_code);
  CREATE INDEX IF NOT EXISTS main.idx_flex_context ON flexfields(context_code);
  CREATE INDEX IF NOT EXISTS main.idx_flex_column  ON flexfields(column_name);
  CREATE TABLE IF NOT EXISTS main.adf_extensions (
    object_name         TEXT,
    table_name          TEXT NOT NULL,
    context_column_name TEXT,
    attribute_name      TEXT NOT NULL,
    column_name         TEXT NOT NULL,
    display_hint        TEXT,
    source              TEXT NOT NULL DEFAULT 'admin-export',
    loaded_at           TEXT NOT NULL,
    object_display      TEXT,
    field_display       TEXT,
    UNIQUE(object_name, table_name, attribute_name, column_name, source)
  );
  CREATE INDEX IF NOT EXISTS main.idx_adf_object ON adf_extensions(object_name);
  CREATE INDEX IF NOT EXISTS main.idx_adf_table  ON adf_extensions(table_name);
  CREATE INDEX IF NOT EXISTS main.idx_adf_attr   ON adf_extensions(attribute_name);

  CREATE TABLE IF NOT EXISTS main.enrich_usage (
    ts TEXT NOT NULL, model TEXT NOT NULL, source TEXT, n_items INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    sql_chars INTEGER, batch_id TEXT
  );
  CREATE INDEX IF NOT EXISTS main.idx_usage_model ON enrich_usage(model);
  CREATE TABLE IF NOT EXISTS main.batch_jobs (
    batch_id TEXT PRIMARY KEY, model TEXT, n INTEGER, submitted_at TEXT,
    status TEXT, completed_at TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS main.batch_items (
    batch_id TEXT, custom_id TEXT, row_id TEXT,
    PRIMARY KEY (batch_id, custom_id)
  );
  CREATE TABLE IF NOT EXISTS main.gjob_jobs (
    name TEXT PRIMARY KEY, model TEXT, n INTEGER, submitted_at TEXT, status TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS main.gjob_items (
    name TEXT, idx INTEGER, row_id TEXT, PRIMARY KEY (name, idx)
  );
  CREATE TABLE IF NOT EXISTS main.gjob_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active INTEGER, sources TEXT, model TEXT, cap REAL, wave INTEGER, batch_size INTEGER
  );
`;

export const DDL_ENRICH = `
  CREATE TABLE IF NOT EXISTS enrichdb.enrich (
    id TEXT PRIMARY KEY, source TEXT, title TEXT, source_hash TEXT,
    original_sql TEXT, clean_sql TEXT, description TEXT,
    tables_used TEXT, lookup_types TEXT, joins TEXT, filters TEXT,
    security_predicate TEXT, approved INTEGER DEFAULT 0, reports TEXT, intents TEXT, mechanics TEXT
  );
`;

export const DDL_CACHE = `
  CREATE TABLE IF NOT EXISTS cachedb.col_vec (hash TEXT PRIMARY KEY, vec BLOB);
`;

export const DDL_FACTS = `
  CREATE TABLE IF NOT EXISTS factsdb.table_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'table',
    column_name TEXT,
    kind        TEXT NOT NULL,
    grain       TEXT,
    dedup       TEXT,
    body        TEXT,
    author      TEXT,
    source      TEXT NOT NULL DEFAULT 'human',
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS factsdb.ix_table_rules ON table_rules(table_name, enabled);
  CREATE TABLE IF NOT EXISTS factsdb.facts_meta (k TEXT PRIMARY KEY, v TEXT);
`;

/** compile-time lookup indexes on the schema catalog (built AFTER the bulk load for speed). */
export const DDL_SCHEMA_INDEXES = `
  CREATE INDEX IF NOT EXISTS schemadb.idx_columns_table ON columns(table_name);
  CREATE INDEX IF NOT EXISTS schemadb.idx_columns_name ON columns(name);
  CREATE INDEX IF NOT EXISTS schemadb.idx_pkeys_table ON pkeys(table_name);
  CREATE INDEX IF NOT EXISTS schemadb.idx_fkeys_child ON fkeys(child_table);
  CREATE INDEX IF NOT EXISTS schemadb.idx_fkeys_parent ON fkeys(parent_table);
  CREATE INDEX IF NOT EXISTS schemadb.idx_indexes_table ON indexes(table_name);
  CREATE INDEX IF NOT EXISTS schemadb.idx_rel_from ON relationships(from_table);
  CREATE INDEX IF NOT EXISTS schemadb.idx_rel_to ON relationships(to_table);
`;
