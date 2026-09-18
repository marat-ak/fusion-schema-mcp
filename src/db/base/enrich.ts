import type { EnrichApi, JobsApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = (s: string | null) => (s ? JSON.parse(s) : []);

export function toEnrichRow(r: any): T.EnrichRow {
  return r && {
    id: r.id, source: r.source, title: r.title, sourceHash: r.source_hash,
    originalSql: r.original_sql, cleanSql: r.clean_sql, description: r.description,
    tablesUsed: P(r.tables_used), lookupTypes: P(r.lookup_types), joins: P(r.joins),
    filters: P(r.filters), securityPredicate: r.security_predicate, approved: r.approved,
    reports: r.reports ? JSON.parse(r.reports) : [],
    intents: P(r.intents), mechanics: r.mechanics ?? null,
  };
}

/** Enrichment job control: Anthropic Message Batches (batch_*) + native Gemini batches (gjob_*). */
export class BaseJobs implements JobsApi {
  constructor(protected p: BaseProvider) {}

  protected batchItemSql(): string {
    return `INSERT INTO ${this.p.t("batch_items")} (batch_id, custom_id, row_id) VALUES (?,?,?)
            ON CONFLICT(batch_id, custom_id) DO UPDATE SET row_id=excluded.row_id`;
  }
  async insertBatchJob(job: { batchId: string; model: string; n: number; submittedAt: string; status: string }, items: { customId: string; rowId: string }[]): Promise<void> {
    const ins = this.batchItemSql();
    await this.p.tx(async () => {
      await this.p.run(`INSERT INTO ${this.p.t("batch_jobs")} (batch_id, model, n, submitted_at, status) VALUES (?,?,?,?,?)`,
        [job.batchId, job.model, job.n, job.submittedAt, job.status]);
      for (const it of items) await this.p.run(ins, [job.batchId, it.customId, it.rowId]);
    });
  }
  async runningBatchJobs(): Promise<T.BatchJob[]> {
    return this.p.q<T.BatchJob>(`SELECT batch_id, model, n, status, submitted_at FROM ${this.p.t("batch_jobs")} WHERE status NOT IN ('done','failed','canceled')`);
  }
  async finishedBatchJobs(): Promise<{ batch_id: string }[]> {
    return this.p.q<{ batch_id: string }>(`SELECT batch_id FROM ${this.p.t("batch_jobs")} WHERE status = 'done'`);
  }
  async allBatchJobs(): Promise<unknown[]> {
    return this.p.q(`SELECT * FROM ${this.p.t("batch_jobs")} ORDER BY submitted_at DESC LIMIT 20`);
  }
  async setBatchStatus(batchId: string, status: string): Promise<void> {
    await this.p.run(`UPDATE ${this.p.t("batch_jobs")} SET status = ? WHERE batch_id = ?`, [status, batchId]);
  }
  async batchItems(batchId: string): Promise<{ custom_id: string; row_id: string }[]> {
    return this.p.q(`SELECT custom_id, row_id FROM ${this.p.t("batch_items")} WHERE batch_id = ?`, [batchId]);
  }
  async batchModel(batchId: string): Promise<string | null> {
    const rows = await this.p.q<{ model: string }>(`SELECT model FROM ${this.p.t("batch_jobs")} WHERE batch_id = ?`, [batchId]);
    return rows[0]?.model ?? null;
  }
  async finishBatchJob(batchId: string, completedAt: string, note: string): Promise<void> {
    await this.p.run(`UPDATE ${this.p.t("batch_jobs")} SET status = 'done', completed_at = ?, note = ? WHERE batch_id = ?`, [completedAt, note, batchId]);
  }

  protected gjobSql(): string {
    return `INSERT INTO ${this.p.t("gjob_jobs")} (name, model, n, submitted_at, status) VALUES (?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET model=excluded.model, n=excluded.n, submitted_at=excluded.submitted_at, status=excluded.status`;
  }
  protected gitemSql(): string {
    return `INSERT INTO ${this.p.t("gjob_items")} (name, idx, row_id) VALUES (?,?,?)
            ON CONFLICT(name, idx) DO UPDATE SET row_id=excluded.row_id`;
  }
  protected gcontrolSql(): string {
    return `INSERT INTO ${this.p.t("gjob_control")} (id, active, sources, model, cap, wave, batch_size) VALUES (1,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET active=excluded.active, sources=excluded.sources, model=excluded.model,
              cap=excluded.cap, wave=excluded.wave, batch_size=excluded.batch_size`;
  }
  async insertGeminiJob(job: { name: string; model: string; n: number; submittedAt: string; status: string }, items: { idx: number; rowId: string }[]): Promise<void> {
    const insJob = this.gjobSql(), insItem = this.gitemSql();
    await this.p.tx(async () => {
      await this.p.run(insJob, [job.name, job.model, job.n, job.submittedAt, job.status]);
      for (const it of items) await this.p.run(insItem, [job.name, it.idx, it.rowId]);
    });
  }
  async openGeminiJobs(): Promise<T.GeminiJob[]> {
    return this.p.q<T.GeminiJob>(`SELECT name, model, n FROM ${this.p.t("gjob_jobs")} WHERE status NOT IN ('done','JOB_STATE_FAILED','JOB_STATE_CANCELLED','JOB_STATE_EXPIRED')`);
  }
  async allGeminiJobs(): Promise<unknown[]> {
    return this.p.q(`SELECT name, model, n, status, note, submitted_at FROM ${this.p.t("gjob_jobs")} ORDER BY submitted_at DESC LIMIT 40`);
  }
  async setGeminiStatus(name: string, status: string): Promise<void> {
    await this.p.run(`UPDATE ${this.p.t("gjob_jobs")} SET status = ? WHERE name = ?`, [status, name]);
  }
  async finishGeminiJob(name: string, note: string): Promise<void> {
    await this.p.run(`UPDATE ${this.p.t("gjob_jobs")} SET status = 'done', note = ? WHERE name = ?`, [note, name]);
  }
  async geminiItems(name: string): Promise<{ idx: number; row_id: string }[]> {
    return this.p.q(`SELECT idx, row_id FROM ${this.p.t("gjob_items")} WHERE name = ?`, [name]);
  }
  async geminiModel(name: string): Promise<string | null> {
    const rows = await this.p.q<{ model: string }>(`SELECT model FROM ${this.p.t("gjob_jobs")} WHERE name = ?`, [name]);
    return rows[0]?.model ?? null;
  }
  async setGeminiControl(c: T.GeminiControl): Promise<void> {
    await this.p.run(this.gcontrolSql(), [c.active, c.sources, c.model, c.cap, c.wave, c.batch_size]);
  }
  async getGeminiControl(): Promise<T.GeminiControl | null> {
    const rows = await this.p.q<T.GeminiControl>(`SELECT active, sources, model, cap, wave, batch_size FROM ${this.p.t("gjob_control")} WHERE id = 1`);
    return rows[0] ?? null;
  }
}

/** Staging queue (`enrich`) + usage ledger (`enrich_usage`) + job control. */
export class BaseEnrich implements EnrichApi {
  jobs: JobsApi;
  constructor(protected p: BaseProvider) { this.jobs = new BaseJobs(p); }
  protected e() { return this.p.t("enrich"); }

  protected insSrcSql(tbl = this.e()): string {
    return `INSERT INTO ${tbl} AS tgt (id, source, title, source_hash, original_sql, reports)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source, title=excluded.title,
      source_hash=excluded.source_hash, original_sql=excluded.original_sql,
      clean_sql=NULL, description=NULL   -- hash changed → invalidate prior enrichment
    WHERE tgt.source_hash <> excluded.source_hash`;
  }

  async upsertSource(s: T.SqlSource): Promise<void> {
    await this.p.run(this.insSrcSql(), [s.id, s.source, s.title, s.sourceHash, s.originalSql, null]);
  }

  /** Content-dedup stage: `s.id` is a normalized-SQL hash, so identical queries across reports collapse
   *  to ONE row. Merges the report reference; keeps the existing enrichment intact. True = brand-new. */
  async stage(s: T.SqlSource, ref: T.ReportRef): Promise<boolean> {
    const existing = (await this.p.q<{ reports: string | null }>(`SELECT reports FROM ${this.e()} WHERE id = ?`, [s.id]))[0];
    if (!existing) {
      await this.p.run(this.insSrcSql(), [s.id, s.source, s.title, s.sourceHash, s.originalSql, J([ref])]);
      return true;
    }
    const refs: T.ReportRef[] = existing.reports ? JSON.parse(existing.reports) : [];
    if (!refs.some((r) => r.path === ref.path && r.index === ref.index)) {
      refs.push(ref);
      await this.p.run(`UPDATE ${this.e()} SET reports=? WHERE id=?`, [J(refs), s.id]);
    }
    return false;
  }

  async pendingIds(sources: T.SqlSource[]): Promise<T.SqlSource[]> {
    const out: T.SqlSource[] = [];
    for (const s of sources) {
      const row = (await this.p.q<{ source_hash: string; description: string | null }>(
        `SELECT source_hash, description FROM ${this.e()} WHERE id = ?`, [s.id]))[0];
      if (!row || row.source_hash !== s.sourceHash || row.description == null) out.push(s);
    }
    return out;
  }

  async setEnrichment(id: string, e: T.Enrichment): Promise<void> {
    await this.p.run(
      `UPDATE ${this.e()} SET clean_sql=?, description=?,
         tables_used=?, lookup_types=?, joins=?,
         filters=?, security_predicate=?,
         intents=?, mechanics=? WHERE id=?`,
      [e.cleanSql, e.description, J(e.tablesUsed), J(e.lookupTypes), J(e.joins), J(e.filters), e.securityPredicate,
       J(e.intents ?? []), e.mechanics ?? null, id]);
  }

  async get(id: string): Promise<T.EnrichRow | null> {
    const rows = await this.p.q<any>(`SELECT * FROM ${this.e()} WHERE id = ?`, [id]);
    return rows[0] ? toEnrichRow(rows[0]) : null;
  }

  async all(): Promise<T.EnrichRow[]> {
    return (await this.p.q<any>(`SELECT * FROM ${this.e()}`)).map(toEnrichRow);
  }

  /** Staging rows awaiting enrichment (no description yet) — the enrich worker's queue. */
  async pendingRows(): Promise<T.EnrichRow[]> {
    return (await this.p.q<any>(`SELECT * FROM ${this.e()} WHERE description IS NULL`)).map(toEnrichRow);
  }

  /** Enriched rows in identity order, keyset-paged. */
  async *iterateEnriched(): AsyncIterable<T.EnrichRow> {
    const idc = this.p.idCol();
    let after = 0;
    for (;;) {
      const rows = await this.p.q<any>(
        `SELECT *, ${idc} AS _rid FROM ${this.e()} WHERE description IS NOT NULL AND ${idc} > ? ORDER BY ${idc} LIMIT 500`, [after]);
      if (!rows.length) return;
      for (const r of rows) { after = r._rid; yield toEnrichRow(r); }
    }
  }

  /** Staging counts for /ingest/health: pending (unenriched) vs enriched (has description). */
  async counts(): Promise<{ pending: number; enriched: number }> {
    const pending = (await this.p.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.e()} WHERE description IS NULL`))[0].n;
    const enriched = (await this.p.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.e()} WHERE description IS NOT NULL`))[0].n;
    return { pending, enriched };
  }

  async recordUsage(u: T.UsageRecord): Promise<void> {
    await this.p.run(`INSERT INTO ${this.p.t("enrich_usage")}
      (ts, model, source, n_items, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, sql_chars, batch_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [u.ts, u.model, u.source ?? null, u.nItems, u.inputTokens, u.outputTokens,
       u.cacheReadTokens, u.cacheCreationTokens, u.sqlChars ?? null, u.batchId ?? null]);
  }

  /** Idempotent re-ingest support: wipe a batch's usage rows before (re)recording them. */
  async clearBatchUsage(batchId: string): Promise<void> {
    await this.p.run(`DELETE FROM ${this.p.t("enrich_usage")} WHERE batch_id = ?`, [batchId]);
  }

  async usageByModelLike(modelLike: string): Promise<T.UsageByModel[]> {
    return this.p.q<T.UsageByModel>(
      `SELECT model, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr FROM ${this.p.t("enrich_usage")} WHERE model LIKE ? GROUP BY model`, [modelLike]);
  }

  async usagePerModel(): Promise<T.UsagePerModel[]> {
    return this.p.q<T.UsagePerModel>(`
      SELECT model, COUNT(*) calls, SUM(n_items) items,
        SUM(input_tokens) inp, SUM(output_tokens) outp,
        SUM(cache_read_tokens) cread, SUM(cache_creation_tokens) ccreate
      FROM ${this.p.t("enrich_usage")} GROUP BY model`);
  }
}
