/**
 * Runtime ingest into the report-SQL corpus (report_queries + report_queries_vec) held in
 * catalog.sqlite. Opens a SEPARATE writable connection (catalog.ts holds a read-only one).
 *
 * Each report's SQLs are stored under ids `bip-report:<groupKey>#<i>`, so re-ingesting the same
 * report REPLACES its prior rows (idempotent) — we delete every row whose id has that prefix,
 * then insert the fresh set with new rowids. Embeddings are the same local bge-small-en-v1.5
 * vectors used elsewhere (no external model call); we embed a synthesized description built from
 * the report path + extracted tables + classified domain. Domain itself is not stored — it is
 * recomputed at query time by findSimilarQueries from tables_used — but is folded into the
 * embedded description so intent search can hit it.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed } from "./embed.js";
import { classifyDomain } from "./domain.js";
import { reportsDbPath, schemaDbPath, isSingleFile, sqlQuote } from "../dbPaths.js";

// SPLIT DBs: the writable corpus connection opens reports.sqlite (report_queries* + vec0) and
// ATTACHes schema.sqlite read-only so moduleOf() can resolve `FROM tables`. catalog.ts holds a
// separate read-only connection to the same reports.sqlite.
const DB_PATH = reportsDbPath();

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`reports DB not found at ${DB_PATH} (provision or migrate first).`);
  }
  const d = new Database(DB_PATH);
  d.pragma("busy_timeout = 10000"); // tolerate the read-only reader connection briefly locking
  loadVec(d);
  if (!isSingleFile()) {
    d.exec(`ATTACH DATABASE '${sqlQuote(schemaDbPath())}' AS schemadb`);
  }
  // report_queries.reports = JSON list of source reports that use this (deduped) SQL; embedding = the
  // bge-small vector as a BLOB (kept alongside report_queries_vec so the vec index can be rebuilt from
  // blobs without re-embedding). Added at runtime so pre-split/legacy DBs pick them up without recompile.
  try { d.exec("ALTER TABLE report_queries ADD COLUMN reports TEXT"); } catch { /* already present */ }
  try { d.exec("ALTER TABLE report_queries ADD COLUMN embedding BLOB"); } catch { /* already present */ }
  // v2 enrichment: NL intents (JSON array) + the once-analyzed mechanics playbook.
  try { d.exec("ALTER TABLE report_queries ADD COLUMN intents TEXT"); } catch { /* already present */ }
  try { d.exec("ALTER TABLE report_queries ADD COLUMN mechanics TEXT"); } catch { /* already present */ }
  // multi-vector index: one row per intent phrase (plus one for description+tables), all pointing
  // at the query rowid via +qrowid. KNN here matches the closest PHRASING; callers dedup by qrowid.
  d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS report_queries_vec_multi USING vec0(embedding FLOAT[384], +qrowid INTEGER)");
  _db = d;
  return d;
}

/** Texts embedded for one query row: description(+tables) first, then each NL intent phrase. */
export function embedTexts(description: string, tables: string[], intents: string[]): string[] {
  return [`${description}\nTables: ${tables.join(", ")}`, ...intents.filter((s) => s && s.trim())];
}

/** Replace this query's multi-vector rows with freshly computed ones. */
function replaceMultiVec(d: Database.Database, qrowid: number | bigint, vecs: Float32Array[]): void {
  const rid = BigInt(qrowid); // vec0 rejects JS numbers ("Only integers are allowed") — bind BigInt
  d.prepare("DELETE FROM report_queries_vec_multi WHERE qrowid = ?").run(rid);
  const ins = d.prepare("INSERT INTO report_queries_vec_multi (embedding, qrowid) VALUES (?, ?)");
  for (const v of vecs) ins.run(Buffer.from(v.buffer), rid);
}

/**
 * v2 re-enrichment writer: update one MATERIALIZED corpus row in place with the new
 * {description, intents, mechanics} and rebuild its vectors (legacy desc vector + multi-vector).
 * Embeddings are computed by the CALLER (batched) and passed in aligned with embedTexts() order.
 */
export function updateEnrichment(
  id: string,
  e: { description: string; intents: string[]; mechanics: string | null; cleanSql?: string | null },
  vecs: Float32Array[],
): boolean {
  const d = db();
  const row = d.prepare("SELECT rowid FROM report_queries WHERE id = ?").get(id) as { rowid: number } | undefined;
  if (!row) return false;
  const tx = d.transaction(() => {
    d.prepare(
      `UPDATE report_queries SET description = ?, intents = ?, mechanics = ?${e.cleanSql ? ", clean_sql = ?" : ""}, embedding = ? WHERE rowid = ?`,
    ).run(
      ...(e.cleanSql
        ? [e.description, JSON.stringify(e.intents), e.mechanics, e.cleanSql, Buffer.from(vecs[0].buffer), row.rowid]
        : [e.description, JSON.stringify(e.intents), e.mechanics, Buffer.from(vecs[0].buffer), row.rowid]),
    );
    d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?").run(BigInt(row.rowid));
    d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(row.rowid), Buffer.from(vecs[0].buffer));
    replaceMultiVec(d, row.rowid, vecs);
  });
  tx();
  return true;
}

/** Rows still lacking v2 enrichment for the given sources — the re-enrich worker's queue.
 *  `includeRedo` also catches BATCH-DEGRADED rows: "(no notable mechanics)" on a non-trivial SQL
 *  (>3000 chars) is a known artifact of prompt-batching, not an honest empty. */
/** Rows already riding an unfinished batch job must not be re-submitted by the next chunk. */
const NOT_IN_FLIGHT = `id NOT IN (
  SELECT bi.row_id FROM batch_items bi
  JOIN batch_jobs bj ON bj.batch_id = bi.batch_id
  WHERE bj.status NOT IN ('done','failed','canceled'))`;
function hasBatchTables(d: Database.Database): boolean {
  try { d.prepare("SELECT 1 FROM batch_jobs LIMIT 1").get(); return true; } catch { return false; }
}

export function reenrichQueue(sources: string[], limit: number, includeRedo = false): { id: string; title: string; sql: string; source: string }[] {
  const d = db();
  const ph = sources.map(() => "?").join(",");
  const cond = includeRedo
    ? `(mechanics IS NULL OR (mechanics = '(no notable mechanics)' AND LENGTH(COALESCE(clean_sql, original_sql)) > 3000))`
    : `mechanics IS NULL`;
  const inflight = hasBatchTables(d) ? ` AND ${NOT_IN_FLIGHT}` : "";
  return d.prepare(
    `SELECT id, title, COALESCE(clean_sql, original_sql) AS sql, source
     FROM report_queries WHERE source IN (${ph}) AND ${cond}${inflight}
     ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT ?`,
  ).all(...sources, limit) as any[];
}

/** Only the batch-degraded rows (for the Opus redo batch). */
export function redoQueue(sources: string[], limit: number): { id: string; title: string; sql: string; source: string }[] {
  const d = db();
  const ph = sources.map(() => "?").join(",");
  const inflight = hasBatchTables(d) ? ` AND ${NOT_IN_FLIGHT}` : "";
  return d.prepare(
    `SELECT id, title, COALESCE(clean_sql, original_sql) AS sql, source
     FROM report_queries WHERE source IN (${ph})
       AND mechanics = '(no notable mechanics)' AND LENGTH(COALESCE(clean_sql, original_sql)) > 3000${inflight}
     ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT ?`,
  ).all(...sources, limit) as any[];
}

export function reenrichCounts(sources: string[]): { total: number; done: number; pending: number } {
  const d = db();
  const ph = sources.map(() => "?").join(",");
  const total = (d.prepare(`SELECT COUNT(*) c FROM report_queries WHERE source IN (${ph})`).get(...sources) as any).c;
  const done = (d.prepare(`SELECT COUNT(*) c FROM report_queries WHERE source IN (${ph}) AND mechanics IS NOT NULL`).get(...sources) as any).c;
  return { total, done, pending: total - done };
}

// ---- enrichment usage accounting (per model call) ----
// One row per LLM call (a batch of `n_items` SQLs), so cost analysis is exact: sum tokens, derive
// per-SQL averages, project the remaining queue and the full corpus at published API rates.
function ensureUsage(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS enrich_usage (
      ts TEXT NOT NULL, model TEXT NOT NULL, source TEXT, n_items INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      sql_chars INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_usage_model ON enrich_usage(model);
  `);
  try { d.exec("ALTER TABLE enrich_usage ADD COLUMN batch_id TEXT"); } catch { /* already present */ }
}

export interface UsageRecord {
  ts: string; model: string; source?: string; nItems: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  sqlChars?: number; batchId?: string;
}
export function recordUsage(u: UsageRecord): void {
  const d = db();
  ensureUsage(d);
  d.prepare(`INSERT INTO enrich_usage
    (ts, model, source, n_items, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, sql_chars, batch_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    u.ts, u.model, u.source ?? null, u.nItems, u.inputTokens, u.outputTokens,
    u.cacheReadTokens, u.cacheCreationTokens, u.sqlChars ?? null, u.batchId ?? null,
  );
}

/** Idempotent re-ingest support: wipe a batch's usage rows before (re)recording them. */
export function clearBatchUsage(batchId: string): void {
  const d = db();
  ensureUsage(d);
  d.prepare("DELETE FROM enrich_usage WHERE batch_id = ?").run(batchId);
}

// Published API pricing per 1M tokens (USD). Cache reads billed ~10% of input; cache writes ~1.25x.
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 }, "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5": { in: 10, out: 50 },
  // Message Batches = 50% of the sync rate
  "claude-opus-5@batch": { in: 2.5, out: 12.5 }, "claude-sonnet-5@batch": { in: 1.5, out: 7.5 },
  "claude-haiku-4-5@batch": { in: 0.5, out: 2.5 },
};
function dollars(model: string, inTok: number, outTok: number, cacheRead: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5"];
  return ((inTok - cacheRead) * p.in + cacheRead * p.in * 0.1 + outTok * p.out) / 1e6;
}

/** Aggregate usage + project cost for the remaining reenrich queue and the whole corpus. */
export function usageStats(sources: string[]): unknown {
  const d = db();
  ensureUsage(d);
  const perModel = d.prepare(`
    SELECT model, COUNT(*) calls, SUM(n_items) items,
      SUM(input_tokens) inp, SUM(output_tokens) outp,
      SUM(cache_read_tokens) cread, SUM(cache_creation_tokens) ccreate
    FROM enrich_usage GROUP BY model`).all() as any[];
  const corpusTotal = (d.prepare("SELECT COUNT(*) c FROM report_queries").get() as any).c;
  const { total: srcTotal, done, pending } = reenrichCounts(sources);

  const models = perModel.map((m) => {
    const perSqlIn = m.items ? m.inp / m.items : 0;
    const perSqlOut = m.items ? m.outp / m.items : 0;
    const spent = dollars(m.model, m.inp, m.outp, m.cread);
    const perSql = m.items ? spent / m.items : 0;
    return {
      model: m.model, calls: m.calls, sqlsEnriched: m.items,
      inputTokens: m.inp, outputTokens: m.outp, cacheReadTokens: m.cread,
      perSqlInputTokens: Math.round(perSqlIn), perSqlOutputTokens: Math.round(perSqlOut),
      apiCostSpentUsd: +spent.toFixed(2), apiCostPerSqlUsd: +perSql.toFixed(5),
      projectRemainingQueueUsd: +(perSql * pending).toFixed(2),
      projectWholeCorpusUsd: +(perSql * corpusTotal).toFixed(2),
    };
  });
  return {
    note: "apiCost = equivalent cost at published API rates (subscription runs are $0 marginal). Projections use the per-SQL average of THIS model.",
    queue: { sources, total: srcTotal, done, pending, corpusTotal },
    models,
  };
}

// ---- table -> Fusion module lookup (authoritative signal for classifyDomain) ----
let _qModule: Database.Statement | null = null;
const _moduleCache = new Map<string, string | undefined>();
function moduleOf(table: string): string | undefined {
  if (_moduleCache.has(table)) return _moduleCache.get(table);
  _qModule ??= db().prepare("SELECT module FROM tables WHERE name = ?");
  const mod = (_qModule.get(table.toUpperCase()) as any)?.module ?? undefined;
  _moduleCache.set(table, mod);
  return mod;
}

const SQL_KEYWORDS = new Set([
  "DUAL", "TABLE", "LATERAL", "SELECT", "WHERE", "LEFT", "RIGHT", "INNER", "OUTER", "FULL",
  "CROSS", "JOIN", "ON", "USING", "AS", "WITH", "JSON_TABLE", "XMLTABLE", "VALUES", "PROCEDURE",
  "FUNCTION", "GROUP", "ORDER", "PARTITION",
]);

/** Best-effort table extraction from raw SQL (drives prefix-based domain classification). */
export function extractTables(sql: string): string[] {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
  const re =
    /\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const parts = m[1].split(".").map((p) => p.replace(/"/g, ""));
    const last = parts[parts.length - 1].toUpperCase();
    if (/^[A-Z][A-Z0-9_$]*$/.test(last) && last.length > 2 && !SQL_KEYWORDS.has(last)) out.add(last);
  }
  return [...out];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function corpusCount(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM report_queries").get() as any).n as number;
}

export interface IngestSql {
  hash?: string;
  text: string;
}

export interface IngestReportInput {
  /** Stable identity for this report; re-ingesting the same key replaces its prior rows. */
  groupKey: string;
  /** Human title / report path stored on each row and searchable via getReportQuery. */
  title: string;
  provenance?: "shared" | "custom" | string;
  reportPath?: string;
  sqls: IngestSql[];
}

export interface IngestReportResult {
  groupKey: string;
  inserted: number;
  replaced: number;
  domains: string[];
}

/**
 * Replace all corpus rows for `groupKey` with the given SQLs (idempotent).
 * Returns per-report counts. Embeddings are computed before the (synchronous) DB transaction.
 */
export async function ingestReport(input: IngestReportInput): Promise<IngestReportResult> {
  const d = db();
  const sqls = (input.sqls ?? []).filter((s) => s && typeof s.text === "string" && /\S/.test(s.text));

  // Build rows (tables + domain + description) up front, then embed the descriptions.
  const rows = sqls.map((s, i) => {
    const tables = extractTables(s.text);
    const domain = classifyDomain(tables, input.title, moduleOf);
    const suffix = sqls.length > 1 ? ` #${i}` : "";
    const description =
      `${input.title}${suffix} — Oracle Fusion BIP report physical SQL` +
      `${input.provenance ? ` (${input.provenance})` : ""}. Domain: ${domain}.` +
      (tables.length ? ` Tables: ${tables.join(", ")}.` : "");
    return {
      id: `bip-report:${input.groupKey}#${i}`,
      title: `${input.title}${suffix}`,
      sql: s.text,
      tables,
      domain,
      description,
    };
  });

  const vecs = rows.length ? await embed(rows.map((r) => r.description)) : [];

  const pattern = `bip-report:${escapeLike(input.groupKey)}#%`;
  const delOld = d.prepare(
    `SELECT rowid FROM report_queries WHERE id LIKE ? ESCAPE '\\'`,
  );
  const delRq = d.prepare("DELETE FROM report_queries WHERE rowid = ?");
  const delVec = d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?");
  const insRq = d.prepare(
    `INSERT INTO report_queries
       (rowid, id, source, title, original_sql, clean_sql, description,
        tables_used, joins, filters, lookup_types, security_predicate, approved, embedding)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
  );
  const insVec = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  const maxRowid = d.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM report_queries");

  let replaced = 0;
  const tx = d.transaction(() => {
    for (const r of delOld.all(pattern) as any[]) {
      delVec.run(r.rowid);
      delRq.run(r.rowid);
      replaced++;
    }
    let next = (maxRowid.get() as any).m as number;
    rows.forEach((r, i) => {
      const rowid = BigInt(next + 1 + i);
      const emb = Buffer.from(vecs[i].buffer);
      insRq.run(
        rowid, r.id, "bip-report", r.title, r.sql, r.sql, r.description,
        JSON.stringify(r.tables), "[]", "[]", "[]", null, emb,
      );
      insVec.run(rowid, emb);
    });
  });
  tx();

  return {
    groupKey: input.groupKey,
    inserted: rows.length,
    replaced,
    domains: [...new Set(rows.map((r) => r.domain))],
  };
}

// ---- staged-pipeline materializer -------------------------------------------------------------
// The runtime ingest pipeline (ingest.ts) stages SQL in enrich.sqlite and enriches it with a model
// (model-quality description + tables_used). `materialize` takes those ENRICHED staging rows and
// makes them searchable by inserting into report_queries + report_queries_vec. Domain is NOT stored
// (findSimilarQueries recomputes it from tables_used at query time); we embed the model description.

/** An enriched staging row ready to become a searchable corpus entry. */
export interface MaterializeRow {
  id: string;
  title: string;
  originalSql: string;
  cleanSql: string | null;
  description: string;
  tablesUsed: string[];
  lookupTypes: string[];
  joins?: unknown[];
  filters?: unknown[];
  securityPredicate?: string | null;
  source?: string;
  reports?: unknown[]; // source reports referencing this (deduped) SQL
  intents?: string[];
  mechanics?: string | null;
}

/** ids already present in report_queries — lets the materializer skip already-searchable rows. */
export function materializedIds(): Set<string> {
  const rows = db().prepare("SELECT id FROM report_queries").all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Insert enriched staging rows into report_queries + report_queries_vec. Idempotent by id: a row
 * whose id already exists is deleted (with its vec) and re-inserted with a fresh rowid. Embeddings
 * are computed (local bge-small) before the synchronous DB transaction. `approved` is set to 1.
 */
export async function materialize(rows: MaterializeRow[]): Promise<{ inserted: number; replaced: number }> {
  const clean = rows.filter((r) => r && r.id && typeof r.description === "string" && /\S/.test(r.description));
  if (clean.length === 0) return { inserted: 0, replaced: 0 };
  const d = db();
  // one embed batch covering every row's texts (description+tables first, then each intent)
  const perRow = clean.map((r) => embedTexts(r.description, r.tablesUsed ?? [], r.intents ?? []));
  const flat = perRow.flat();
  const flatVecs = await embed(flat);
  const offsets: number[] = [];
  perRow.reduce((off, texts, i) => { offsets[i] = off; return off + texts.length; }, 0);

  const qById = d.prepare("SELECT rowid FROM report_queries WHERE id = ?");
  const delRq = d.prepare("DELETE FROM report_queries WHERE rowid = ?");
  const delVec = d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?");
  const delMulti = d.prepare("DELETE FROM report_queries_vec_multi WHERE qrowid = ?");
  const insRq = d.prepare(
    `INSERT INTO report_queries
       (rowid, id, source, title, original_sql, clean_sql, description,
        tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding,
        intents, mechanics)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
  );
  const insVec = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  const insMulti = d.prepare("INSERT INTO report_queries_vec_multi (embedding, qrowid) VALUES (?, ?)");
  const maxRowid = d.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM report_queries");

  let inserted = 0;
  let replaced = 0;
  const tx = d.transaction(() => {
    let next = (maxRowid.get() as any).m as number; // new rowids strictly exceed all existing → no collisions
    clean.forEach((r, i) => {
      const prev = qById.get(r.id) as { rowid: number } | undefined;
      if (prev) { delVec.run(prev.rowid); delMulti.run(prev.rowid); delRq.run(prev.rowid); replaced++; }
      const rowid = BigInt(++next);
      const rowVecs = perRow[i].map((_t, k) => flatVecs[offsets[i] + k]);
      const emb = Buffer.from(rowVecs[0].buffer);
      insRq.run(
        rowid, r.id, r.source ?? "bip-report", r.title, r.originalSql, r.cleanSql ?? r.originalSql, r.description,
        JSON.stringify(r.tablesUsed ?? []), JSON.stringify(r.joins ?? []),
        JSON.stringify(r.filters ?? []), JSON.stringify(r.lookupTypes ?? []),
        r.securityPredicate ?? null, JSON.stringify(r.reports ?? []), emb,
        JSON.stringify(r.intents ?? []), r.mechanics ?? null,
      );
      insVec.run(rowid, emb);
      for (const v of rowVecs) insMulti.run(Buffer.from(v.buffer), rowid);
      inserted++;
    });
  });
  tx();
  return { inserted, replaced };
}

// ---- portable export / import -----------------------------------------------------------------
// Move a corpus between environments. `data` = the report_queries rows (SQL + enrichment: description,
// tables_used, ...) WITHOUT embeddings — import re-embeds locally (cheap, no Gemini). `full` also
// carries the bge-small embedding (base64), so import restores it verbatim with no re-embed.

export type ExportScope = "data" | "full";

/** Stream corpus rows (optionally filtered by `source`, e.g. "bip-report"). Generator = O(1) memory. */
export function* exportCorpus(scope: ExportScope, source?: string): Generator<Record<string, unknown>> {
  const d = db();
  const where = source ? "WHERE q.source = ?" : "";
  const sql = scope === "full"
    ? `SELECT q.*, v.embedding AS _emb FROM report_queries q
         LEFT JOIN report_queries_vec v ON v.rowid = q.rowid ${where} ORDER BY q.rowid`
    : `SELECT q.* FROM report_queries q ${where} ORDER BY q.rowid`;
  const stmt = d.prepare(sql);
  const iter = (source ? stmt.iterate(source) : stmt.iterate()) as Iterable<any>;
  for (const r of iter) {
    const row: Record<string, unknown> = {
      id: r.id, source: r.source, title: r.title,
      original_sql: r.original_sql, clean_sql: r.clean_sql, description: r.description,
      tables_used: r.tables_used, joins: r.joins, filters: r.filters,
      lookup_types: r.lookup_types, security_predicate: r.security_predicate, approved: r.approved,
      reports: r.reports,
    };
    if (scope === "full" && r._emb) row.embedding = Buffer.from(r._emb).toString("base64");
    yield row;
  }
}

export interface ImportRow {
  id: string; source?: string; title: string;
  original_sql: string; clean_sql?: string | null; description: string;
  tables_used?: string; joins?: string; filters?: string; lookup_types?: string;
  security_predicate?: string | null; reports?: string;
  embedding?: string; // base64 float32 (present on a "full" export)
}

/** Insert/replace corpus rows. Rows without an `embedding` are re-embedded locally (bge-small). */
export async function importCorpus(rows: ImportRow[]): Promise<{ imported: number; replaced: number; embedded: number }> {
  const clean = rows.filter((r) => r && r.id && typeof r.description === "string");
  if (clean.length === 0) return { imported: 0, replaced: 0, embedded: 0 };
  const d = db();

  // Re-embed only rows that arrived without an embedding.
  const needEmbed = clean.filter((r) => !r.embedding);
  const embVecs = needEmbed.length ? await embed(needEmbed.map((r) => r.description)) : [];
  const embMap = new Map<string, Float32Array>();
  needEmbed.forEach((r, i) => embMap.set(r.id, embVecs[i]));

  const qById = d.prepare("SELECT rowid FROM report_queries WHERE id = ?");
  const delRq = d.prepare("DELETE FROM report_queries WHERE rowid = ?");
  const delVec = d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?");
  const insRq = d.prepare(
    `INSERT INTO report_queries
       (rowid, id, source, title, original_sql, clean_sql, description,
        tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  );
  const insVec = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
  const maxRowid = d.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM report_queries");

  let imported = 0, replaced = 0, embedded = 0;
  const tx = d.transaction(() => {
    let next = (maxRowid.get() as any).m as number;
    for (const r of clean) {
      const prev = qById.get(r.id) as { rowid: number } | undefined;
      if (prev) { delVec.run(prev.rowid); delRq.run(prev.rowid); replaced++; }
      const rowid = BigInt(++next);
      let vec: Buffer;
      if (r.embedding) vec = Buffer.from(r.embedding, "base64");
      else { vec = Buffer.from(embMap.get(r.id)!.buffer); embedded++; }
      insRq.run(
        rowid, r.id, r.source ?? "bip-report", r.title, r.original_sql, r.clean_sql ?? r.original_sql, r.description,
        r.tables_used ?? "[]", r.joins ?? "[]", r.filters ?? "[]", r.lookup_types ?? "[]", r.security_predicate ?? null,
        r.reports ?? "[]", vec,
      );
      insVec.run(rowid, vec);
      imported++;
    }
  });
  tx();
  return { imported, replaced, embedded };
}
