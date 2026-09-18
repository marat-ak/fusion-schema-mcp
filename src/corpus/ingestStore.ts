/**
 * Runtime ingest into the report-SQL corpus (report_queries + its vector index) — the SQL-free domain
 * layer over `db().corpus` / `db().enrich`: embedding discipline (vectors are computed HERE, before the
 * library's transaction), the export/import wire shape, and the enrichment cost model.
 *
 * Staging identity: ids are `sql:<normalized-sql-hash>` (ingest.ts) so re-pushing the same report
 * REPLACES its rows (idempotent by id — see `materialize`). Domain is not stored — findSimilarQueries
 * recomputes it from tables_used at query time.
 */
import { db, type MaterializeRow, type ImportRow, type ExportScope, type UsageRecord, type EnrichmentPatch } from "../db/index.js";
import { embedBulk as embed } from "./embed.js";

export type { MaterializeRow, ImportRow, ExportScope, UsageRecord };

/** Texts embedded for one query row: description(+tables) first, then each NL intent phrase. */
export function embedTexts(description: string, tables: string[], intents: string[]): string[] {
  return [`${description}\nTables: ${tables.join(", ")}`, ...intents.filter((s) => s && s.trim())];
}

/**
 * v2 re-enrichment writer: update one MATERIALIZED corpus row in place with the new
 * {description, intents, mechanics} and rebuild its vectors (legacy desc vector + multi-vector).
 * Embeddings are computed by the CALLER (batched) and passed in aligned with embedTexts() order.
 */
export async function updateEnrichment(id: string, e: EnrichmentPatch, vecs: Float32Array[]): Promise<boolean> {
  return db().corpus.updateEnrichment(id, e, vecs);
}

/** Rows still lacking v2 enrichment for the given sources — the re-enrich worker's queue. */
export async function reenrichQueue(sources: string[], limit: number, includeRedo = false) {
  return db().corpus.reenrichQueue(sources, limit, includeRedo);
}

/** Only the batch-degraded rows (for the Opus redo batch). */
export async function redoQueue(sources: string[], limit: number) {
  return db().corpus.redoQueue(sources, limit);
}

export async function reenrichCounts(sources: string[]): Promise<{ total: number; done: number; pending: number }> {
  return db().corpus.reenrichCounts(sources);
}

// ---- enrichment usage accounting (per model call) ----
// One row per LLM call (a batch of `n_items` SQLs), so cost analysis is exact: sum tokens, derive
// per-SQL averages, project the remaining queue and the full corpus at published API rates.
export async function recordUsage(u: UsageRecord): Promise<void> {
  return db().enrich.recordUsage(u);
}

/** Idempotent re-ingest support: wipe a batch's usage rows before (re)recording them. */
export async function clearBatchUsage(batchId: string): Promise<void> {
  return db().enrich.clearBatchUsage(batchId);
}

// Published API pricing per 1M tokens (USD). Cache reads billed ~10% of input; cache writes ~1.25x.
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 }, "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5": { in: 10, out: 50 },
  // Message Batches = 50% of the sync rate
  "claude-opus-5@batch": { in: 2.5, out: 12.5 }, "claude-sonnet-5@batch": { in: 1.5, out: 7.5 },
  "claude-haiku-4-5@batch": { in: 0.5, out: 2.5 },
  // Gemini flash-lite (2.5) published rates + native Batch API half-rate
  "gemini-flash-lite-latest": { in: 0.1, out: 0.4 }, "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-flash": { in: 0.3, out: 2.5 },
  "gemini-flash-lite-latest@batch": { in: 0.05, out: 0.2 }, "gemini-2.5-flash-lite@batch": { in: 0.05, out: 0.2 },
};
function dollars(model: string, inTok: number, outTok: number, cacheRead: number): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5"];
  return ((inTok - cacheRead) * p.in + cacheRead * p.in * 0.1 + outTok * p.out) / 1e6;
}

/** Total USD spent across usage rows whose model matches a LIKE pattern (e.g. "gemini%"). */
export async function spentUsd(modelLike: string): Promise<number> {
  const rows = await db().enrich.usageByModelLike(modelLike);
  return rows.reduce((a, r) => a + dollars(r.model, r.i ?? 0, r.o ?? 0, r.cr ?? 0), 0);
}

/** Aggregate usage + project cost for the remaining reenrich queue and the whole corpus. */
export async function usageStats(sources: string[]): Promise<unknown> {
  const perModel = await db().enrich.usagePerModel();
  const corpusTotal = await db().corpus.count();
  const { total: srcTotal, done, pending } = await reenrichCounts(sources);

  const models = perModel.map((m) => {
    const items = m.items ?? 0, inp = m.inp ?? 0, outp = m.outp ?? 0, cread = m.cread ?? 0;
    const perSqlIn = items ? inp / items : 0;
    const perSqlOut = items ? outp / items : 0;
    const spent = dollars(m.model, inp, outp, cread);
    const perSql = items ? spent / items : 0;
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

export async function corpusCount(): Promise<number> {
  return db().corpus.count();
}

// ---- staged-pipeline materializer -------------------------------------------------------------
// The runtime ingest pipeline (ingest.ts) stages SQL in the enrich store and enriches it with a model
// (model-quality description + tables_used). `materialize` takes those ENRICHED staging rows and
// makes them searchable. We embed the model description (+ each intent phrase) BEFORE the library's
// transaction, so no transaction ever awaits external work.

/** ids already present in the corpus — lets the materializer skip already-searchable rows. */
export async function materializedIds(): Promise<Set<string>> {
  return db().corpus.ids();
}

/** Insert enriched staging rows into the corpus. Idempotent by id (replace). `approved` is set to 1. */
export async function materialize(rows: MaterializeRow[]): Promise<{ inserted: number; replaced: number }> {
  const clean = rows.filter((r) => r && r.id && typeof r.description === "string" && /\S/.test(r.description));
  if (clean.length === 0) return { inserted: 0, replaced: 0 };
  // one embed batch covering every row's texts (description+tables first, then each intent)
  const perRow = clean.map((r) => embedTexts(r.description, r.tablesUsed ?? [], r.intents ?? []));
  const flat = perRow.flat();
  const flatVecs = await embed(flat);
  const offsets: number[] = [];
  perRow.reduce((off, texts, i) => { offsets[i] = off; return off + texts.length; }, 0);
  const vecs = perRow.map((texts, i) => texts.map((_t, k) => flatVecs[offsets[i] + k]));
  return db().corpus.materialize(clean, vecs);
}

// ---- portable export / import -----------------------------------------------------------------
// Move a corpus between environments. `data` = the report_queries rows (SQL + enrichment: description,
// tables_used, ...) WITHOUT embeddings — import re-embeds locally (cheap, no Gemini). `full` also
// carries the bge-small embedding (base64), so import restores it verbatim with no re-embed.

/** Stream corpus rows (optionally filtered by `source`, e.g. "bip-report"). Paged = bounded memory. */
export async function* exportCorpus(scope: ExportScope, source?: string): AsyncGenerator<Record<string, unknown>> {
  yield* db().corpus.export(scope, source);
}

function fromBase64(b64: string): Float32Array {
  const b = Buffer.from(b64, "base64");
  const f = new Float32Array(b.byteLength / 4);
  Buffer.from(f.buffer, f.byteOffset, f.byteLength).set(b);
  return f;
}

/** Insert/replace corpus rows. Rows without an `embedding` are re-embedded locally (bge-small). */
export async function importCorpus(rows: ImportRow[]): Promise<{ imported: number; replaced: number; embedded: number }> {
  const clean = rows.filter((r) => r && r.id && typeof r.description === "string");
  if (clean.length === 0) return { imported: 0, replaced: 0, embedded: 0 };

  // Re-embed only rows that arrived without an embedding.
  const needEmbed = clean.filter((r) => !r.embedding);
  const embVecs = needEmbed.length ? await embed(needEmbed.map((r) => r.description)) : [];
  const embMap = new Map<string, Float32Array>();
  needEmbed.forEach((r, i) => embMap.set(r.id, embVecs[i]));

  let embedded = 0;
  const vecs = clean.map((r) => {
    if (r.embedding) return fromBase64(r.embedding);
    embedded++;
    return embMap.get(r.id)!;
  });
  const res = await db().corpus.importRows(clean, vecs);
  return { ...res, embedded };
}
