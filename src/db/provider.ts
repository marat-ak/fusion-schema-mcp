/**
 * The FULL typed method set of the catalog DB — one method per SQL statement family, grouped by use
 * case. Every method has a base implementation (portable SQL, src/db/base/*) that a provider may
 * override where dialect / ranking / identity / transaction semantics differ. Transactions live
 * INSIDE these methods; callers never hold a handle and never see SQL.
 */
import type * as T from "./types.js";

export interface MetaApi {
  versions(): Promise<T.Versions | null>;
  setVersions(v: T.Versions): Promise<void>;
  set(key: string, value: string): Promise<void>;
  stats(): Promise<Record<string, string>>;
  activeVersion(): string;
  ensureDdl(): Promise<void>;
  ensureIndexes(): Promise<void>;
  finalizeBuild(): Promise<void>;
}

export interface SchemaApi {
  tableNames(): ReadonlySet<string>;
  reloadTableNames(): Promise<void>;
  getTable(name: string): Promise<T.TableRow | null>;
  moduleOf(name: string): Promise<string | undefined>;
  columns(table: string): Promise<T.ColumnRow[]>;
  columnCount(table: string): Promise<number>;
  primaryKey(table: string): Promise<string[]>;
  indexes(table: string): Promise<T.IndexRow[]>;
  fkeys(table: string): Promise<{ out: T.FkRow[]; in: T.FkRow[] }>;
  relationships(table: string): Promise<{ from: T.RelRow[]; to: T.RelRow[] }>;
  searchTables(tokens: string[], mode: "and" | "or", limit: number): Promise<T.TableHit[]>;
  columnSignals(): Promise<T.ColumnSignal[]>;
  bulkLoad(table: T.SchemaLoadTable, rows: unknown[]): Promise<number>;
  rebuildTablesFts(): Promise<void>;
}

export interface CorpusApi {
  knn(vec: Float32Array, k: number, opts?: { source?: string; multi?: boolean }): Promise<T.CorpusHit[]>;
  hasMultiVectors(): Promise<boolean>;
  byTitle(title: string): Promise<T.CorpusRow | null>;
  byId(id: string): Promise<T.CorpusRow | null>;
  siblings(title: string): Promise<T.SiblingRow[]>;
  byTitlePrefix(pattern: string, limit: number): Promise<T.CorpusRowLite[]>;
  nearTitles(pattern: string): Promise<string[]>;
  count(): Promise<number>;
  ids(): Promise<Set<string>>;
  titleAndSql(id: string): Promise<{ title: string; sql: string } | null>;
  materialize(rows: T.MaterializeRow[], vecs: Float32Array[][]): Promise<{ inserted: number; replaced: number }>;
  updateEnrichment(id: string, e: T.EnrichmentPatch, vecs: Float32Array[]): Promise<boolean>;
  reenrichQueue(sources: string[], limit: number, includeRedo?: boolean): Promise<T.QueueRow[]>;
  redoQueue(sources: string[], limit: number): Promise<T.QueueRow[]>;
  reenrichCounts(sources: string[]): Promise<{ total: number; done: number; pending: number }>;
  export(scope: T.ExportScope, source?: string): AsyncIterable<Record<string, unknown>>;
  importRows(rows: T.ImportRow[], vecs: Float32Array[]): Promise<{ imported: number; replaced: number }>;
  joinColumnStats(table: string, limit: number): Promise<T.JoinColumnStat[]>;
  rowsForGrain(): Promise<T.GrainInputRow[]>;
  rowsForUsage(): Promise<T.UsageInputRow[]>;
  rowsForPredicates(): Promise<T.PredicateInputRow[]>;
  bulkLoad(rows: T.CorpusLoadRow[], vecs: Float32Array[]): Promise<number>;
  /** provisioning: rows lacking an embedding (optionally only these sources) → caller re-embeds → setEmbeddings */
  rowsMissingEmbedding(sources?: string[]): Promise<T.EmbeddingTarget[]>;
  allRowsForEmbedding(): Promise<T.EmbeddingTarget[]>;
  setEmbeddings(entries: { rid: number; vec: Float32Array }[]): Promise<void>;
  rebuildVectorIndex(): Promise<void>;
  replaceSourcesFromSeed(seedFile: string, sources: string[]): Promise<number>;
}

export interface RegistriesApi {
  grain(table: string): Promise<T.GrainRegistryRow | null>;
  usages(table: string, limit: number): Promise<T.UsageJoinRow[]>;
  usageCount(table: string): Promise<number>;
  predicates(table: string): Promise<T.PredicateRow[]>;
  topPredicates(table: string, limit: number): Promise<T.PredicateStat[]>;
  version(kind: T.RegistryKind): Promise<string | null>;
  setVersion(kind: T.RegistryKind, v: string): Promise<void>;
  count(kind: T.RegistryKind): Promise<number>;
  replaceAll(kind: T.RegistryKind, rows: unknown[]): Promise<{ rows: number }>;
}

export interface FlexApi {
  replaceSnapshot(kind: T.FlexKind, source: string, rows: unknown[]): Promise<number>;
  queryFlexfields(q: T.FlexQuery, limit: number): Promise<any[]>;
  queryAdf(q: T.AdfQuery, limit: number): Promise<any[]>;
  flexfieldsCount(): Promise<T.FlexCounts>;
  adfCount(): Promise<T.AdfCounts>;
  applyConfigReport(fields: T.ConfigReportField[], nowIso: string): Promise<{ displayUpdated: number; inserted: number }>;
}

export interface LayoutApi {
  jsonlHash(): Promise<string | null>;
  replaceAll(rows: T.LayoutPatternRow[], vecs: Float32Array[][], hash: string): Promise<number>;
  knn(vec: Float32Array, k: number): Promise<T.LayoutDbRow[]>;
  get(id: string): Promise<T.LayoutDbRow | null>;
  count(): Promise<number>;
}

export interface RulesApi {
  upsert(a: T.UpsertArgs, nowIso: string): Promise<T.TableRule>;
  byId(id: number): Promise<T.TableRule | null>;
  delete(id: number): Promise<boolean>;
  forTable(table: string): Promise<T.TableRule[]>;
  list(table?: string): Promise<T.TableRule[]>;
}

export interface JobsApi {
  // Anthropic Message Batches (batch_jobs / batch_items)
  insertBatchJob(job: { batchId: string; model: string; n: number; submittedAt: string; status: string }, items: { customId: string; rowId: string }[]): Promise<void>;
  runningBatchJobs(): Promise<T.BatchJob[]>;
  finishedBatchJobs(): Promise<{ batch_id: string }[]>;
  allBatchJobs(): Promise<unknown[]>;
  setBatchStatus(batchId: string, status: string): Promise<void>;
  batchItems(batchId: string): Promise<{ custom_id: string; row_id: string }[]>;
  batchModel(batchId: string): Promise<string | null>;
  finishBatchJob(batchId: string, completedAt: string, note: string): Promise<void>;
  // native Gemini batches (gjob_jobs / gjob_items / gjob_control)
  insertGeminiJob(job: { name: string; model: string; n: number; submittedAt: string; status: string }, items: { idx: number; rowId: string }[]): Promise<void>;
  openGeminiJobs(): Promise<T.GeminiJob[]>;
  allGeminiJobs(): Promise<unknown[]>;
  setGeminiStatus(name: string, status: string): Promise<void>;
  finishGeminiJob(name: string, note: string): Promise<void>;
  geminiItems(name: string): Promise<{ idx: number; row_id: string }[]>;
  geminiModel(name: string): Promise<string | null>;
  setGeminiControl(c: T.GeminiControl): Promise<void>;
  getGeminiControl(): Promise<T.GeminiControl | null>;
}

export interface EnrichApi {
  stage(s: T.SqlSource, ref: T.ReportRef): Promise<boolean>;
  upsertSource(s: T.SqlSource): Promise<void>;
  pendingIds(sources: T.SqlSource[]): Promise<T.SqlSource[]>;
  setEnrichment(id: string, e: T.Enrichment): Promise<void>;
  pendingRows(): Promise<T.EnrichRow[]>;
  get(id: string): Promise<T.EnrichRow | null>;
  all(): Promise<T.EnrichRow[]>;
  iterateEnriched(): AsyncIterable<T.EnrichRow>;
  counts(): Promise<{ pending: number; enriched: number }>;
  recordUsage(u: T.UsageRecord): Promise<void>;
  clearBatchUsage(batchId: string): Promise<void>;
  usageByModelLike(modelLike: string): Promise<T.UsageByModel[]>;
  usagePerModel(): Promise<T.UsagePerModel[]>;
  jobs: JobsApi;
}

export interface ColCacheApi {
  get(hashes: string[]): Promise<Map<string, Float32Array>>;
  put(entries: { hash: string; vec: Float32Array }[]): Promise<void>;
  wipe(): Promise<void>;
}

export interface CatalogProvider {
  meta: MetaApi; schema: SchemaApi; corpus: CorpusApi; registries: RegistriesApi; flex: FlexApi;
  layout: LayoutApi; rules: RulesApi; enrich: EnrichApi; colCache: ColCacheApi;
  /** rev poll hook (per request): reload the active version + name snapshot when they moved. No-op on sqlite. */
  refreshIfMoved(): Promise<boolean>;
  close(): Promise<void>;
}
