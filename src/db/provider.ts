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
  /** Title lookups resolve through `unit_titles` (every L2 unit title → its statement's row) OR the row's
   *  own `title` (a runtime-ingested row has no unit_titles entry). "Largest SQL wins" among several rows. */
  byTitle(title: string): Promise<T.CorpusRow | null>;
  byId(id: string): Promise<T.CorpusRow | null>;
  siblings(title: string): Promise<T.SiblingRow[]>;
  byTitlePrefix(pattern: string, limit: number): Promise<T.CorpusRowLite[]>;
  nearTitles(pattern: string): Promise<string[]>;
  /** Full replace of `unit_titles` (the upgrade job / tests; the release build fills it in p5_fill.sql). */
  replaceUnitTitles(rows: T.UnitTitleRow[]): Promise<number>;
  unitTitleCount(): Promise<number>;
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
  /** the distinct columns real report SQL filters this table on (table_predicates) — the end-user filter-only keys */
  predicateColumns(table: string): Promise<string[]>;
  version(kind: T.RegistryKind): Promise<string | null>;
  setVersion(kind: T.RegistryKind, v: string): Promise<void>;
  count(kind: T.RegistryKind): Promise<number>;
  replaceAll(kind: T.RegistryKind, rows: unknown[]): Promise<{ rows: number }>;
}

export interface PlsqlApi {
  /** apis co-occurring with a table, most-called first (the pushed `mostlyUsedApis` + findPlsqlApi({table})) */
  forTable(table: string, limit: number): Promise<T.PlsqlApiForTable[]>;
  /** name search: every token must appear in PACKAGE.FUNCTION (upper-cased), most-called first */
  search(tokens: string[], limit: number): Promise<T.PlsqlApiRow[]>;
  apisOfPackage(pkg: string, limit: number): Promise<T.PlsqlApiRow[]>;
  package(pkg: string): Promise<T.PlsqlPackageRow | null>;
  /** package-name search over the dictionary ∪ corpus packages (an unused package still resolves) */
  packagesLike(tokens: string[], limit: number): Promise<T.PlsqlPackageRow[]>;
  counts(): Promise<{ packages: number; apis: number; apiTables: number }>;
  version(): Promise<string | null>;
  /** Full rebuild of the four tables in one transaction (the upgrade job / tests; never boot). */
  replaceAll(pkgs: T.PlsqlPackageRow[], apis: T.PlsqlApiRow[], apiTables: T.PlsqlApiTableRow[], version: string): Promise<{ packages: number; apis: number; apiTables: number }>;
}

export interface OtbiApi {
  subjectArea(name: string): Promise<T.OtbiSubjectAreaRow | null>;
  subjectAreaNames(): Promise<string[]>;
  folders(subjectArea: string): Promise<T.OtbiFolderRow[]>;
  folder(subjectArea: string, name: string): Promise<T.OtbiFolderRow | null>;
  columns(subjectArea: string, folder: string): Promise<T.OtbiColumnRow[]>;
  /** where else in ONE subject area a column name occurs (the lint's "did you mean this folder") */
  foldersWithColumn(subjectArea: string, column: string): Promise<string[]>;
  /** every (subject area, folder, kind) whose presentation columns read this table (the exposure index otbi_column_ref) */
  foldersOfTable(table: string): Promise<{ subject_area: string; folder: string; kind: string }[]>;
  /** the column refs of a table inside the given subject areas, each with its presentation column's expression */
  columnRefsOfTable(table: string, subjectAreas: string[]): Promise<T.OtbiColumnRefExpr[]>;
  /** per physical column of a table: in how many distinct subject areas a presentation column reads it */
  exposedIn(table: string): Promise<{ db_column: string; areas: number }[]>;
  /** the distinct physical tables the FACT folders of a subject area read */
  factTablesOfArea(subjectArea: string): Promise<string[]>;
  /** the VOs behind the folders of a subject area that read a table (otbi_vo.db_objects contains it) */
  vosOfTableInArea(table: string, subjectArea: string): Promise<T.OtbiVoRow[]>;
  /** the TBI-guide duty codes of a subject area (verbatim), ordered by code */
  areaDuties(subjectArea: string): Promise<T.OtbiAreaDutyRow[]>;
  /** the TBI-guide JOB role codes of a subject area (ddl_version 10), ordered by code */
  areaJobs(subjectArea: string): Promise<T.OtbiAreaJobRow[]>;
  /** every physical table some subject area reads (the exposure index), ordered by name */
  readTableNames(): Promise<string[]>;
  /** otbi_meta as k -> v (version, guide_release, area_duty_unmapped, ...) */
  meta(): Promise<Record<string, string>>;
  /** KNN over otbi_vec — one hit per distinct text; the caller resolves hashes to entities */
  knn(vec: Float32Array, k: number): Promise<T.OtbiVecHit[]>;
  columnsByHash(hashes: string[], subjectArea: string | undefined, perHash: number): Promise<T.OtbiColumnRow[]>;
  foldersByHash(hashes: string[], subjectArea: string | undefined): Promise<T.OtbiFolderRow[]>;
  subjectAreasByHash(hashes: string[]): Promise<T.OtbiSubjectAreaRow[]>;
  counts(): Promise<T.OtbiCounts>;
  version(): Promise<string | null>;
  /** Full rebuild of the OTBI tables in one transaction (the upgrade job / tests; never boot; the release build
   *  fills them in p5_otbi.sql): the exposure index is derived from the columns' db_refs exactly as p5_otbi.sql does. */
  replaceAll(sas: T.OtbiSubjectAreaRow[], folders: T.OtbiFolderRow[], columns: T.OtbiColumnRow[], vecs: T.OtbiVecRow[], version: string,
    lineage: T.OtbiLineageInput): Promise<T.OtbiCounts>;
}

export interface SecurityApi {
  /** every table_security row of one object, primary first */
  forTable(table: string): Promise<T.TableSecurityRow[]>;
  /** the object's table_disallowed row, or null */
  disallowed(table: string): Promise<T.TableDisallowedRow | null>;
  /** the curated rows on one object whose scope is '*' or this instance, in curated order (the resolver matches the area) */
  areaPrivileges(objName: string, instance: string): Promise<T.SecAreaPrivilegeRow[]>;
  /** sec_meta as k → v (version stamps, context order, hcm prefixes, privilege-prefix aliases, export stamp, stats) */
  meta(): Promise<Record<string, string>>;
  version(): Promise<string | null>;
  counts(): Promise<{ rows: number; tables: number; disallowed: number; areaRows: number; referenceTables: number }>;
  /** the reference-family row of one table (ddl_version 10), or null */
  referenceFamily(table: string): Promise<T.ReferenceFamilyRow | null>;
  /** Full rebuild of the five tables in one transaction (the upgrade job / tests; the release build fills them in p5_security.sql; never boot). */
  replaceAll(f: T.SecurityFacts): Promise<{ rows: number; disallowed: number; areaRows: number; referenceTables: number; meta: number }>;

  // ---- the per-instance customer layer (names only; src/securityLayer.ts loads it — an admin action, never boot) ----
  /** the layer row of one pod host (exactly as runSql reports `instance`), or null when none is loaded */
  layer(instance: string): Promise<T.SecInstanceRow | null>;
  /** every loaded layer (for the unknown-instance error: the hosts that exist) */
  layers(): Promise<T.SecInstanceRow[]>;
  /** the instance's registration under this OBJ_NAME, or null */
  instanceObject(instance: string, objName: string): Promise<T.SecInstanceObjectRow | null>;
  /** the instance's registrations whose OBJ_NAME or database object is this catalog table (exact OBJ_NAME first) */
  instanceObjectsForTable(instance: string, table: string): Promise<T.SecInstanceObjectRow[]>;
  /** does (object, privilege) carry an active grant on the instance (any grantee)? */
  instancePrivilegeExists(instance: string, objName: string, privilege: string): Promise<boolean>;
  /** every granted (object, privilege) of one object on the instance with its grant-set signature (privilege order) — pool 2 */
  grantedPairs(instance: string, objName: string): Promise<T.SecInstancePrivilegeRow[]>;
  /** U rows of one object (privilege, instance type order) */
  uPairs(instance: string, objName: string): Promise<T.SecUPairRow[]>;
  /** the duty-map rows of one object (duty, privilege order) */
  dutyPairs(instance: string, objName: string): Promise<T.SecDutyPairRow[]>;
  /** the customer duty copies of the instance → their seeded twins (duty order) */
  dutyAliases(instance: string): Promise<T.SecDutyAliasRow[]>;
  /** the distinct FBI / analysis duty role names holding grants on the instance (the HCM code mapping of the gate) */
  dutyRoles(instance: string): Promise<string[]>;
  /** v4: the (role, privilege) pairs the given roles hold on one object on the instance (role, privilege order) — the job-role consensus */
  roleGrants(instance: string, objName: string, roles: string[]): Promise<{ role_name: string; privilege: string }[]>;
  /** Replace the whole layer of one instance in ONE transaction (idempotent; a new stamp replaces the previous rows). */
  replaceLayer(instance: string, stamp: string, layer: T.SecLayerInput, nowIso: string): Promise<T.SecLayerCounts>;
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
  meta: MetaApi; schema: SchemaApi; corpus: CorpusApi; registries: RegistriesApi; plsql: PlsqlApi; otbi: OtbiApi; security: SecurityApi; flex: FlexApi;
  layout: LayoutApi; rules: RulesApi; enrich: EnrichApi; colCache: ColCacheApi;
  /** rev poll hook (per request): reload the active version + name snapshot when they moved. No-op on sqlite. */
  refreshIfMoved(): Promise<boolean>;
  close(): Promise<void>;
}
