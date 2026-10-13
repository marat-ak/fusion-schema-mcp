/**
 * Provider-free parameter / result types of the catalog DB library. Callers (catalog.ts, ingest.ts,
 * corpus/*) see ONLY these shapes — never SQL, table names, rowids, vector encodings or a handle.
 */

// ---- meta ----
export interface Versions { schema: string; queries: string; embedding: string }

// ---- schema (schema.sqlite) ----
export interface TableRow { name: string; schema: string | null; type: string | null; module: string | null; remarks: string | null; view_text: string | null }
export interface ColumnRow { name: string; data_type: string | null; size: number | null; nullable: number | null; remarks: string | null; ordinal: number | null }
export interface IndexRow { index_name: string; is_unique: number | null; ordinal: number | null; column_name: string | null }
export interface FkRow { other: string; col: string | null; name: string | null }
export interface RelRow { other: string; from_col: string | null; to_col: string | null; evidence: string | null; occurrences: number | null; confidence: string | null }
export interface TableHit { name: string; type: string | null; module: string | null; remarks: string | null }
export interface ColumnSignal { table_name: string; col: string }
/** Bulk-load row shapes (compile.ts). Positional = the physical column order of the INSERT. */
export interface TableLoadRow { name: string; schema: string | null; type: string | null; module: string | null; remarks: string | null; view_text: string | null }
export type ColumnLoadRow = [table_name: string, name: string, data_type: string | null, size: number | null, nullable: number, remarks: string | null, ordinal: number | null];
export type PkeyLoadRow = [table_name: string, column_name: string, seq: number | null];
export type FkeyLoadRow = [child_table: string, parent_table: string, column_name: string | null, seq: number | null, name: string | null];
export type IndexLoadRow = [table_name: string, index_name: string | null, is_unique: number, ordinal: number | null, column_name: string | null];
export type MinedRelLoadRow = [from_table: string, from_col: string | null, to_table: string, to_col: string | null, evidence: string | null, occurrences: number | null, confidence: string | null];
export type OtbiRelLoadRow = [from_table: string, from_col: string | null, to_table: string, to_col: string | null, predicate: string | null];
export type SchemaLoadTable = "tables" | "columns" | "pkeys" | "fkeys" | "indexes" | "relationships_mined" | "relationships_otbi";

// ---- corpus (report_queries) ----
/** Row shape returned by KNN (the RQ_COLS projection of catalog.ts) + the query identity for multi-vector dedup. */
export interface CorpusHit {
  id: string; source: string; title: string; description: string | null; clean_sql: string | null;
  tables_used: string | null; joins: string | null; filters: string | null; lookup_types: string | null;
  intents: string | null; mechanics: string | null; distance: number; qrid?: number;
}
export interface CorpusRow {
  id: string; source: string; title: string; original_sql: string | null; clean_sql: string | null; description: string | null;
  tables_used: string | null; joins: string | null; filters: string | null; lookup_types: string | null; security_predicate: string | null;
}
export interface SiblingRow { id: string; sqlChars: number; description: string | null }
/** A title-prefix hit: `title` is the L2 unit title that matched (a `unit_titles` alias or the row's own),
 *  `canonicalTitle` the corpus row's title (the primary unit's — equal to `title` when the alias is it). */
export interface CorpusRowLite { id: string; source: string; title: string; canonicalTitle: string; description: string | null }
/** One L2 unit title → the corpus row carrying its statement (ddl_version 4 `unit_titles`). */
export interface UnitTitleRow { title: string; id: string; source: string }
export interface QueueRow { id: string; title: string; sql: string; source: string }
export interface MaterializeRow {
  id: string; title: string; originalSql: string; cleanSql: string | null; description: string;
  tablesUsed: string[]; lookupTypes: string[]; joins?: unknown[]; filters?: unknown[]; securityPredicate?: string | null;
  source?: string; reports?: unknown[]; intents?: string[]; mechanics?: string | null;
}
export interface EnrichmentPatch { description: string; intents: string[]; mechanics: string | null; cleanSql?: string | null }
export type ExportScope = "data" | "full";
export interface ImportRow {
  id: string; source?: string; title: string; original_sql: string; clean_sql?: string | null; description: string;
  tables_used?: string; joins?: string; filters?: string; lookup_types?: string; security_predicate?: string | null; reports?: string;
  embedding?: string; // base64 float32 (present on a "full" export)
}
/** compile.ts bulk row = an enriched staging row; identity assigned by the library in call order. */
export interface CorpusLoadRow {
  id: string; source: string; title: string; originalSql: string; cleanSql: string | null; description: string;
  tablesUsed: string[]; joins: unknown[]; filters: unknown[]; lookupTypes: string[]; securityPredicate: string | null; approved: number;
}
export interface GrainInputRow { tables_used: string | null; clean_sql: string | null; original_sql: string | null }
export interface UsageInputRow { id: string; source: string; title: string; tables_used: string; sql_chars: number }
export interface PredicateInputRow { filters: string }
export interface JoinColumnStat { column: string; units: number; share: number }
export interface PredicateStat { column: string; op: string; literal: string; occurrences: number }
export interface EmbeddingTarget { rid: number; description: string | null }

// ---- registries ----
export type RegistryKind = "grain" | "usage" | "predicates";
export interface GrainRegistryRow { table_name: string; grain: string; multi_row: number; dedup: string | null; signals: string | null; corpus_evidence: number; note: string | null; updated_at?: string | null }
export interface UsageRegistryRow { table_name: string; query_id: string; source: string | null; title: string | null; sql_chars: number; score: number }
export interface PredicateRegistryRow { table_name: string; column_name: string; op: string; literal: string; occurrences: number; role: string }
export interface UsageJoinRow { id: string; source: string; title: string; sql_chars: number; filters: string | null; joins: string | null; clean_sql: string | null; original_sql: string | null }
export interface PredicateRow { column_name: string; op: string; literal: string; occurrences: number; role: string }

// ---- plsql API inventory (pipeline-built: scripts/pipeline/p3_calls.* → p5_plsql.sql) ----
export interface PlsqlPackageRow { package_name: string; api_class: string; in_dictionary: number; module: string | null; module_source: string | null; functions: number; statements: number }
export interface PlsqlApiRow {
  package_name: string; function_name: string; api_class: string; module: string | null; module_source: string | null; in_dictionary: number;
  statements: number; units: number; reports: number; titles: number;
  by_source: string | null; arg_counts: string | null; found_in: string | null; top_tables: string | null; top_modules: string | null; samples: string | null;
}
export interface PlsqlApiTableRow { package_name: string; function_name: string; table_name: string; statements: number; share: number }
/** an api row joined to its co-occurrence with ONE table */
export interface PlsqlApiForTable extends PlsqlApiRow { table_statements: number; share: number }

// ---- OTBI presentation catalog (pipeline-built: scripts/pipeline/p3_otbi.* → p5_otbi.sql) ----
export interface OtbiSubjectAreaRow {
  name: string; pillar: string | null; n_folders: number; n_fact_folders: number; n_columns: number;
  fact_folders: string | null; in_lineage: number; in_crawl: number; in_corpus: number; text_hash: string | null;
}
export interface OtbiFolderRow {
  subject_area: string; name: string; kind: string; kind_source: string; description: string | null; desc_source: string | null;
  db_tables: string | null; n_columns: number; n_measures: number; in_lineage: number; in_crawl: number; in_corpus: number;
  unit_id: string | null; grain_note: string | null; nested: number; ordinal: number | null; text_hash: string | null;
}
export interface OtbiColumnRow {
  subject_area: string; folder: string; name: string; data_type: string | null; kind: string; aggregation: string | null;
  expression: string | null; db_refs: string | null; vo_refs: string | null; indexed: number; description: string | null; desc_source: string | null;
  gap_cause: string | null; in_lineage: number; in_crawl: number; in_probe: number; ordinal: number | null; text_hash: string | null;
}
/** One KNN hit over `otbi_vec`: the hash resolves to every entity that shares the text. */
export interface OtbiVecHit { text_hash: string; kind: string; distance: number }
export interface OtbiVecRow { text_hash: string; kind: string; vec: Float32Array }
export interface OtbiCounts { subjectAreas: number; folders: number; columns: number; vectors: number; vos: number; columnRefs: number; areaDuties: number; areaJobs: number }
/** The VO hop (ddl_version 9): one BI view object behind one presentation folder. */
export interface OtbiVoRow { subject_area: string; folder: string; vo_path: string; vo_def: string; db_objects: string; vo_attrs: string }
/** The exposure index (ddl_version 9): one physical column one presentation column reads (otbi_column.db_refs exploded). */
export interface OtbiColumnRefRow {
  subject_area: string; folder: string; folder_kind: string; column_name: string; table_name: string; db_column: string; src: string; via_expression: number;
}
/** A column ref with the presentation column's expression (the masking-shape check of the column whitelist). */
export interface OtbiColumnRefExpr extends OtbiColumnRefRow { expression: string | null }
/** Subject area -> duty role code (ddl_version 9) from Oracle's TBI guides, the code verbatim. */
export interface OtbiAreaDutyRow {
  subject_area: string; duty_code: string; duty_name: string; guide: string; guide_release: string; matched_by: string; guide_area: string;
}
/** What replaceAll writes besides the presentation catalog: the VO hop, the area -> duty map and its release
 *  stamps (the exposure index is derived from the columns' db_refs in the same transaction). */
/** Subject area -> guide JOB role code (ddl_version 10): through the area's duty codes or the job page itself. */
export interface OtbiAreaJobRow { subject_area: string; job_code: string; job_name: string | null; matched_by: string; guide: string }
export interface OtbiLineageInput {
  vos: OtbiVoRow[]; areaDuties: OtbiAreaDutyRow[]; areaJobs: OtbiAreaJobRow[]; guideRelease: string; unmappedAreas: Record<string, string>;
}

// ---- security (data-access facts, ddl_version 5; table_disallowed 6; names-only objects 7) ----
/** One `table_security` row: a context detected on one column of one object → the reference object
 *  the condition is generated on (the VIA_JOIN form). */
export interface TableSecurityRow {
  table_name: string; column_name: string; context: string; urda_column: string;
  ref_object: string | null; ref_column: string | null; is_primary: number; confidence: string; evidence: number; reason: string | null;
}
/** An object with an unresolved context column that no corpus source uses: never read in secured SQL. */
export interface TableDisallowedRow { table_name: string; reason: string }
/** One curated area/product → (object, privilege) row (ddl_version 8: names NOT NULL, `instance_scope`
 *  = '*' or ONE pod host); it OVERRIDES the resolver's rule for the tables of that product / subject area. */
export interface SecAreaPrivilegeRow {
  area_or_product: string; ordinal: number; obj_name: string; privilege: string; source: string; evidence: string; instance_scope: string;
  /** the (area, entity) key (ddl_version 9): the VO reference entity the evidence names; null = an area/product-level row */
  entity_table: string | null;
  vo_def: string | null;
  /** ddl_version 10: TABLE.COLUMN the entity joins in the evidence (a trace names it) — decides the column of that table */
  context_column: string | null;
}
/** A reference-data table (ddl_version 10): its family, the base it translates (translation), the evidence. */
export interface ReferenceFamilyRow { table_name: string; family: string; base_table: string | null; evidence: string }
/** The whole data-access fact set of a release (what replaceAll writes). */
export interface SecurityFacts {
  rows: TableSecurityRow[]; disallowed: TableDisallowedRow[]; areaPrivileges: SecAreaPrivilegeRow[]; referenceFamilies: ReferenceFamilyRow[];
  meta: Record<string, string>;
}

// ---- security: the per-instance customer layer (library migrations v2 + v3 / sqlite factsdb; src/securityLayer.ts) ----
/** The loaded layer of one pod instance: the export stamp that serves it (one layer per host). */
export interface SecInstanceRow { instance: string; stamp: string; loaded_at: string; grantee: string; counts: string }
/** One FND_OBJECTS registration of the instance (names only): the FROM object + key columns of the isolated form. */
export interface SecInstanceObjectRow {
  instance: string; obj_name: string; database_object_name: string;
  pk1_column: string | null; pk2_column: string | null; pk3_column: string | null; pk4_column: string | null; pk5_column: string | null;
}
/** One (object, privilege) that carries an active ALLOW grant on the instance, whoever the grantee, with the
 *  signature of its WHOLE grant set (v3 — the same `grant_sig` as U's: every granted pair forms equivalence
 *  classes, which is what pool 2 of the privilege choice decides on). */
export interface SecInstancePrivilegeRow { instance: string; obj_name: string; privilege: string; grant_sig: string; n_grants: number }
/** A customer copy of an FBI / analysis duty → the seeded duty it copies (v3, names only; e.g. a
 *  `<prefix>_FBI_…_DUTY_HCM_NEW` role → `ORA_FBI_…_DUTY_HCM`). */
export interface SecDutyAliasRow { instance: string; duty_role: string; seeded_role: string }
/** U: one (object, privilege, instance type) granted to the BI server identity. `grant_sig` is the
 *  signature of the pair's WHOLE grant set (grantee, instance type, instance-set NAME): two
 *  privileges with equal signatures produce the same predicate for every user. */
export interface SecUPairRow { instance: string; obj_name: string; privilege: string; instance_type: string; grant_sig: string; n_grants: number }
/** The HCM route: one (duty role, object, privilege) held by an FBI / analysis duty. */
export interface SecDutyPairRow { instance: string; duty_role: string; obj_name: string; privilege: string; grant_sig: string; n_grants: number }
/** What the loader hands replaceLayer (rows without the instance column). */
export interface SecLayerInput {
  grantee: string;
  objects: Omit<SecInstanceObjectRow, "instance">[];
  privileges: Omit<SecInstancePrivilegeRow, "instance">[];
  u: Omit<SecUPairRow, "instance">[];
  duties: Omit<SecDutyPairRow, "instance">[];
  aliases: Omit<SecDutyAliasRow, "instance">[];
  roleGrants: Omit<SecRoleGrantRow, "instance">[];
}
/** v4: one (role, object, privilege) a seeded job / abstract / discretionary role holds on the pod — names only. */
export interface SecRoleGrantRow { instance: string; role_name: string; obj_name: string; privilege: string }
export interface SecLayerCounts { objects: number; privileges: number; u: number; duties: number; aliases: number; roleGrants: number }

// ---- flex ----
export type FlexKind = "flexfields" | "adf_extensions";
export type FlexfieldLoadRow = [application_id: number | null, flexfield_type: string, flexfield_code: string, deployment_status: string | null, context_code: string, context_enabled: string | null, multirow: string | null, translatable: string | null, segment_code: string, column_name: string | null, sequence_number: number | null, segment_name: string | null, prompt: string | null, display_type: string | null, value_set_id: number | null, required: string | null, segment_enabled: string | null, source: string, loaded_at: string];
export type AdfLoadRow = [object_name: string | null, table_name: string, context_column_name: string | null, attribute_name: string, column_name: string, display_hint: string, source: string, loaded_at: string];
export interface FlexQuery { flexfieldCode?: string; context?: string; search?: string; type?: "DFF" | "EFF"; limit?: number }
export interface AdfQuery { object?: string; objectHint?: string; table?: string; search?: string; searchWords?: string[]; limit?: number }
export interface FlexCounts { total: number; dff: number; eff: number; sources: unknown }
export interface AdfCounts { total: number; customObjects: number; builtinTables: number }
/** One parsed App-Composer configuration-report field; the library runs the update-or-insert logic. */
export interface ConfigReportField {
  objName: string; isCustomObject: boolean; objDisplay: string | null; tableName: string | null;
  fieldName: string; colName: string | null; fieldDisplay: string | null; hintAdd: string; hint: string;
}

// ---- layout ----
export interface LayoutPatternRow {
  id: string; kind: "archetype" | "technique" | "antipattern"; name: string; format: "rtf" | "xpt" | "both" | "any";
  formatExclusive?: boolean; dslSupport: "supported" | "partial" | "unsupported" | "n/a"; description: string; whenToUse: string;
  intents: string[]; requires?: Record<string, unknown>; composition?: { nestsIn?: string[]; contains?: string[]; conflicts?: string[]; notes?: string };
  recipe?: unknown; fixtureRef?: string; pitfalls?: string[]; trigger?: string; why?: string; instead?: string[]; alternative?: string;
  sourceRefs?: unknown; verified: "render" | "pod" | "builder" | "prose"; dslVersion?: string;
}
/** Physical layout_patterns row (JSON columns as text) as read back; `rid` = identity. */
export interface LayoutDbRow { rid: number; id: string; kind: string; name: string; format: string; format_exclusive: number; dsl_support: string; description: string; when_to_use: string; intents: string; requires: string | null; composition: string | null; recipe: string | null; fixture_ref: string | null; pitfalls: string | null; trigger: string | null; why: string | null; instead: string | null; alternative: string | null; source_refs: string | null; verified: string; dsl_version: string | null; verified_at: string | null; distance?: number }

// ---- rules (facts) ----
export type RuleKind = "grain" | "note" | "caveat";
export interface TableRule { id: number; table: string; scope: "table" | "column"; column: string | null; kind: RuleKind; grain?: string | null; dedup?: string | null; body: string; author: string; source: "human" | "agent"; enabled: boolean; updatedAt: string }
export interface UpsertArgs { id?: number; table: string; scope?: "table" | "column"; column?: string | null; kind: RuleKind; grain?: string | null; dedup?: string | null; note?: string; author?: string; source?: "human" | "agent"; enabled?: boolean }

// ---- enrich (staging queue + usage ledger + job control) ----
export type ReportRef = { path?: string; title?: string; index?: number };
export interface SqlSource { id: string; source: "otbi" | "catalog" | "view"; title: string; originalSql: string; sourceHash: string; raw: any }
export interface EnrichRow {
  id: string; source: string; title: string; sourceHash: string; originalSql: string; cleanSql: string | null; description: string | null;
  tablesUsed: string[]; lookupTypes: string[]; joins: any[]; filters: string[]; securityPredicate: string | null; approved: number; reports: ReportRef[];
  intents?: string[]; mechanics?: string | null;
}
export interface Enrichment {
  cleanSql: string; description: string; tablesUsed: string[]; lookupTypes: string[]; joins: any[]; filters: string[]; securityPredicate: string | null;
  intents?: string[]; mechanics?: string | null;
}
export interface UsageRecord { ts: string; model: string; source?: string; nItems: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; sqlChars?: number; batchId?: string }
export interface UsageByModel { model: string; i: number | null; o: number | null; cr: number | null }
export interface UsagePerModel { model: string; calls: number; items: number | null; inp: number | null; outp: number | null; cread: number | null; ccreate: number | null }
export interface BatchJob { batch_id: string; model: string; n: number; status: string; submitted_at: string; completed_at?: string | null; note?: string | null }
export interface GeminiJob { name: string; model: string; n: number; status?: string; note?: string | null; submitted_at?: string }
export interface GeminiControl { active: number; sources: string; model: string; cap: number; wave: number; batch_size: number }
