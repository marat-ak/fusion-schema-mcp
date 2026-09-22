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
export interface CorpusRowLite { id: string; source: string; title: string; description: string | null }
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
