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
  CREATE TABLE IF NOT EXISTS main.plsql_packages (
    package_name  TEXT PRIMARY KEY,
    api_class     TEXT NOT NULL,
    in_dictionary INTEGER NOT NULL DEFAULT 0,
    module        TEXT,
    module_source TEXT,
    functions     INTEGER NOT NULL DEFAULT 0,
    statements    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS main.plsql_api (
    package_name  TEXT NOT NULL,
    function_name TEXT NOT NULL,
    api_class     TEXT NOT NULL,
    module        TEXT,
    module_source TEXT,
    in_dictionary INTEGER NOT NULL DEFAULT 0,
    statements    INTEGER NOT NULL DEFAULT 0,
    units         INTEGER NOT NULL DEFAULT 0,
    reports       INTEGER NOT NULL DEFAULT 0,
    titles        INTEGER NOT NULL DEFAULT 0,
    by_source     TEXT,
    arg_counts    TEXT,
    found_in      TEXT,
    top_tables    TEXT,
    top_modules   TEXT,
    samples       TEXT,
    PRIMARY KEY (package_name, function_name)
  );
  CREATE INDEX IF NOT EXISTS main.ix_plsql_api_stmts ON plsql_api(statements DESC);
  CREATE TABLE IF NOT EXISTS main.plsql_api_tables (
    package_name  TEXT NOT NULL,
    function_name TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    statements    INTEGER NOT NULL,
    share         REAL NOT NULL,
    PRIMARY KEY (package_name, function_name, table_name)
  );
  CREATE INDEX IF NOT EXISTS main.ix_plsql_api_tables_t ON plsql_api_tables(table_name, statements DESC);
  CREATE TABLE IF NOT EXISTS main.plsql_meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS main.otbi_subject_area (
    name           TEXT PRIMARY KEY,
    pillar         TEXT,
    n_folders      INTEGER NOT NULL DEFAULT 0,
    n_fact_folders INTEGER NOT NULL DEFAULT 0,
    n_columns      INTEGER NOT NULL DEFAULT 0,
    fact_folders   TEXT,
    in_lineage     INTEGER NOT NULL DEFAULT 0,
    in_crawl       INTEGER NOT NULL DEFAULT 0,
    in_corpus      INTEGER NOT NULL DEFAULT 0,
    text_hash      TEXT
  );
  CREATE TABLE IF NOT EXISTS main.otbi_folder (
    subject_area TEXT NOT NULL,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    kind_source  TEXT NOT NULL,
    description  TEXT,
    desc_source  TEXT,
    db_tables    TEXT,
    n_columns    INTEGER NOT NULL DEFAULT 0,
    n_measures   INTEGER NOT NULL DEFAULT 0,
    in_lineage   INTEGER NOT NULL DEFAULT 0,
    in_crawl     INTEGER NOT NULL DEFAULT 0,
    in_corpus    INTEGER NOT NULL DEFAULT 0,
    unit_id      TEXT,
    grain_note   TEXT,
    nested       INTEGER NOT NULL DEFAULT 0,
    ordinal      INTEGER,
    text_hash    TEXT,
    PRIMARY KEY (subject_area, name)
  );
  CREATE TABLE IF NOT EXISTS main.otbi_column (
    subject_area TEXT NOT NULL,
    folder       TEXT NOT NULL,
    name         TEXT NOT NULL,
    data_type    TEXT,
    kind         TEXT NOT NULL,
    aggregation  TEXT,
    expression   TEXT,
    db_refs      TEXT,
    vo_refs      TEXT,
    indexed      INTEGER NOT NULL DEFAULT 0,
    description  TEXT,
    desc_source  TEXT,
    gap_cause    TEXT,
    in_lineage   INTEGER NOT NULL DEFAULT 0,
    in_crawl     INTEGER NOT NULL DEFAULT 0,
    in_probe     INTEGER NOT NULL DEFAULT 0,
    ordinal      INTEGER,
    text_hash    TEXT,
    PRIMARY KEY (subject_area, folder, name)
  );
  CREATE INDEX IF NOT EXISTS main.ix_otbi_column_hash ON otbi_column(text_hash);
  CREATE INDEX IF NOT EXISTS main.ix_otbi_folder_hash ON otbi_folder(text_hash);
  CREATE VIRTUAL TABLE IF NOT EXISTS main.otbi_vec USING vec0(embedding FLOAT[${EMBED_DIM}], +text_hash TEXT, +kind TEXT);
  CREATE TABLE IF NOT EXISTS main.otbi_meta (k TEXT PRIMARY KEY, v TEXT);
  -- the VO hop, the exposure index and the area -> duty map (same shape as ddl.sql ddl_version 9)
  CREATE TABLE IF NOT EXISTS main.otbi_vo (
    subject_area TEXT NOT NULL,
    folder       TEXT NOT NULL,
    vo_path      TEXT NOT NULL,
    vo_def       TEXT NOT NULL,
    db_objects   TEXT NOT NULL,
    vo_attrs     TEXT NOT NULL,
    PRIMARY KEY (subject_area, folder, vo_path, vo_def)
  );
  CREATE INDEX IF NOT EXISTS main.ix_otbi_vo_def ON otbi_vo(vo_def);
  CREATE TABLE IF NOT EXISTS main.otbi_column_ref (
    subject_area   TEXT NOT NULL,
    folder         TEXT NOT NULL,
    folder_kind    TEXT NOT NULL,
    column_name    TEXT NOT NULL,
    table_name     TEXT NOT NULL,
    db_column      TEXT NOT NULL,
    src            TEXT NOT NULL,
    via_expression INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (subject_area, folder, column_name, table_name, db_column)
  );
  CREATE INDEX IF NOT EXISTS main.ix_otbi_column_ref_table ON otbi_column_ref(table_name, db_column);
  CREATE INDEX IF NOT EXISTS main.ix_otbi_column_ref_area ON otbi_column_ref(subject_area, table_name);
  CREATE TABLE IF NOT EXISTS main.otbi_area_duty (
    subject_area  TEXT NOT NULL,
    duty_code     TEXT NOT NULL,
    duty_name     TEXT NOT NULL,
    guide         TEXT NOT NULL,
    guide_release TEXT NOT NULL,
    matched_by    TEXT NOT NULL,
    guide_area    TEXT NOT NULL,
    PRIMARY KEY (subject_area, duty_code)
  );
  CREATE TABLE IF NOT EXISTS main.otbi_area_job (
    subject_area TEXT NOT NULL,
    job_code     TEXT NOT NULL,
    job_name     TEXT,
    matched_by   TEXT NOT NULL,
    guide        TEXT NOT NULL,
    PRIMARY KEY (subject_area, job_code)
  );
  CREATE TABLE IF NOT EXISTS main.unit_titles (
    title  TEXT NOT NULL,
    id     TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (title, id)
  );
  CREATE INDEX IF NOT EXISTS main.ix_unit_titles_id ON unit_titles(id);

  CREATE TABLE IF NOT EXISTS main.table_security (
    table_name  TEXT NOT NULL,
    column_name TEXT NOT NULL,
    context     TEXT NOT NULL,
    urda_column TEXT NOT NULL,
    ref_object  TEXT,
    ref_column  TEXT,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    confidence  TEXT NOT NULL,
    evidence    INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    PRIMARY KEY (table_name, column_name, context)
  );
  CREATE TABLE IF NOT EXISTS main.table_disallowed (
    table_name TEXT PRIMARY KEY,
    reason     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS main.sec_area_privilege (
    area_or_product TEXT NOT NULL,
    ordinal         INTEGER NOT NULL,
    obj_name        TEXT NOT NULL,
    privilege       TEXT NOT NULL,
    source          TEXT NOT NULL,
    evidence        TEXT NOT NULL,
    instance_scope  TEXT NOT NULL,
    entity_table    TEXT,
    vo_def          TEXT,
    context_column  TEXT,
    PRIMARY KEY (area_or_product, ordinal)
  );
  CREATE TABLE IF NOT EXISTS main.sec_meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS main.table_reference_family (
    table_name TEXT PRIMARY KEY,
    family     TEXT NOT NULL,
    base_table TEXT,
    evidence   TEXT NOT NULL
  );

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
  -- the per-instance data-access security layer (names only; src/securityLayer.ts loads it, never boot) —
  -- same shape as the Postgres library migrations v2 + v3 (src/db/postgres/ddl.ts)
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance (
    instance  TEXT PRIMARY KEY,
    stamp     TEXT NOT NULL,
    loaded_at TEXT NOT NULL,
    grantee   TEXT NOT NULL,
    counts    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_object (
    instance             TEXT NOT NULL,
    obj_name             TEXT NOT NULL,
    database_object_name TEXT NOT NULL,
    pk1_column TEXT, pk2_column TEXT, pk3_column TEXT, pk4_column TEXT, pk5_column TEXT,
    PRIMARY KEY (instance, obj_name)
  );
  CREATE INDEX IF NOT EXISTS factsdb.ix_sec_instance_object_db ON sec_instance_object(instance, database_object_name);
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_privilege (
    instance  TEXT NOT NULL,
    obj_name  TEXT NOT NULL,
    privilege TEXT NOT NULL,
    grant_sig TEXT NOT NULL,
    n_grants  INTEGER NOT NULL,
    PRIMARY KEY (instance, obj_name, privilege)
  );
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_u (
    instance      TEXT NOT NULL,
    obj_name      TEXT NOT NULL,
    privilege     TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    grant_sig     TEXT NOT NULL,
    n_grants      INTEGER NOT NULL,
    PRIMARY KEY (instance, obj_name, privilege, instance_type)
  );
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_duty (
    instance  TEXT NOT NULL,
    duty_role TEXT NOT NULL,
    obj_name  TEXT NOT NULL,
    privilege TEXT NOT NULL,
    grant_sig TEXT NOT NULL,
    n_grants  INTEGER NOT NULL,
    PRIMARY KEY (instance, duty_role, obj_name, privilege)
  );
  CREATE INDEX IF NOT EXISTS factsdb.ix_sec_instance_duty_obj ON sec_instance_duty(instance, obj_name);
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_duty_alias (
    instance    TEXT NOT NULL,
    duty_role   TEXT NOT NULL,
    seeded_role TEXT NOT NULL,
    PRIMARY KEY (instance, duty_role)
  );
  CREATE TABLE IF NOT EXISTS factsdb.sec_instance_role_grant (
    instance  TEXT NOT NULL,
    role_name TEXT NOT NULL,
    obj_name  TEXT NOT NULL,
    privilege TEXT NOT NULL,
    PRIMARY KEY (instance, role_name, obj_name, privilege)
  );
  CREATE INDEX IF NOT EXISTS factsdb.ix_sec_instance_role_grant_obj ON sec_instance_role_grant(instance, obj_name);
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
