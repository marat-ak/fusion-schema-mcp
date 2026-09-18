import type { CorpusApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

export const RQ_COLS = `rq.id, rq.source, rq.title, rq.description, rq.clean_sql,
                rq.tables_used, rq.joins, rq.filters, rq.lookup_types,
                rq.intents, rq.mechanics`;
const LOOKUP_COLS = `id, source, title, original_sql, clean_sql, description,
                  tables_used, joins, filters, lookup_types, security_predicate`;

/** Rows already riding an unfinished ANTHROPIC batch job must not be re-submitted by the next chunk. */
const NOT_IN_FLIGHT = (bi: string, bj: string) => `id NOT IN (
  SELECT bi.row_id FROM ${bi} bi
  JOIN ${bj} bj ON bj.batch_id = bi.batch_id
  WHERE bj.status NOT IN ('done','failed','canceled'))`;
/** Same guard for the native GEMINI batch path (gjob_*): a row in any non-terminal gjob (pending or
 *  SUCCEEDED-but-not-yet-ingested) is still in flight — re-submitting it double-pays. */
const NOT_IN_GEMINI_FLIGHT = (gi: string, gj: string) => `id NOT IN (
  SELECT gi.row_id FROM ${gi} gi
  JOIN ${gj} gj ON gj.name = gi.name
  WHERE gj.status NOT IN ('done','JOB_STATE_FAILED','JOB_STATE_CANCELLED','JOB_STATE_EXPIRED'))`;

/** The searchable report-SQL corpus (report_queries + its vector index). */
export class BaseCorpus implements CorpusApi {
  constructor(protected p: BaseProvider) {}
  protected rq() { return this.p.t("report_queries"); }

  /** Portable KNN = the embedding column on the row itself, `<->` L2 (pgvector). Providers override. */
  async knn(vec: Float32Array, k: number, opts: { source?: string; multi?: boolean } = {}): Promise<T.CorpusHit[]> {
    if (opts.multi) {
      const src = opts.source ? "WHERE rq.source = ?" : "";
      return this.p.q<T.CorpusHit>(
        `SELECT ${RQ_COLS}, rq.${this.p.idCol()} AS qrid, v.distance AS distance
         FROM (SELECT qrowid, embedding <-> ? AS distance FROM ${this.p.t("report_queries_vec_multi")} ORDER BY distance LIMIT ?) v
         JOIN ${this.rq()} rq ON rq.${this.p.idCol()} = v.qrowid ${src}
         ORDER BY v.distance${opts.source ? " LIMIT ?" : ""}`,
        opts.source ? [this.p.vec(vec), k, opts.source, k] : [this.p.vec(vec), k]);
    }
    const src = opts.source ? "WHERE rq.source = ?" : "";
    return this.p.q<T.CorpusHit>(
      `SELECT ${RQ_COLS}, rq.embedding <-> ? AS distance FROM ${this.rq()} rq ${src} ORDER BY distance LIMIT ?`,
      opts.source ? [this.p.vec(vec), opts.source, k] : [this.p.vec(vec), k]);
  }

  async hasMultiVectors(): Promise<boolean> {
    const rows = await this.p.q<{ c: number }>(`SELECT COUNT(*) AS c FROM ${this.p.t("report_queries_vec_multi")}`);
    return (rows[0]?.c ?? 0) > 0;
  }

  // A .xdm data model has SEVERAL datasets stored as several rows sharing one title; the MAIN
  // query is the largest, so return the biggest-SQL row first.
  async byTitle(title: string): Promise<T.CorpusRow | null> {
    const rows = await this.p.q<T.CorpusRow>(
      `SELECT ${LOOKUP_COLS} FROM ${this.rq()} WHERE title = ?
       ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT 1`, [title]);
    return rows[0] ?? null;
  }

  async byId(id: string): Promise<T.CorpusRow | null> {
    const rows = await this.p.q<T.CorpusRow>(`SELECT ${LOOKUP_COLS} FROM ${this.rq()} WHERE id = ?`, [id]);
    return rows[0] ?? null;
  }

  async siblings(title: string): Promise<T.SiblingRow[]> {
    return this.p.q<T.SiblingRow>(
      `SELECT id, LENGTH(COALESCE(clean_sql, original_sql)) AS sqlChars, description
       FROM ${this.rq()} WHERE title = ?
       ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC`, [title]);
  }

  async byTitlePrefix(pattern: string, limit: number): Promise<T.CorpusRowLite[]> {
    return this.p.q<T.CorpusRowLite>(
      `SELECT id, source, title, description FROM ${this.rq()} WHERE title LIKE ? ORDER BY title LIMIT ?`, [pattern, limit]);
  }

  async nearTitles(pattern: string): Promise<string[]> {
    const rows = await this.p.q<{ title: string }>(`SELECT title FROM ${this.rq()} WHERE title LIKE ? ORDER BY title LIMIT 8`, [pattern]);
    return rows.map((r) => r.title);
  }

  async count(): Promise<number> {
    const rows = await this.p.q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.rq()}`);
    return rows[0]?.n ?? 0;
  }

  async ids(): Promise<Set<string>> {
    const rows = await this.p.q<{ id: string }>(`SELECT id FROM ${this.rq()}`);
    return new Set(rows.map((r) => r.id));
  }

  async titleAndSql(id: string): Promise<{ title: string; sql: string } | null> {
    const rows = await this.p.q<{ title: string; sql: string }>(
      `SELECT title, COALESCE(clean_sql, original_sql) sql FROM ${this.rq()} WHERE id = ?`, [id]);
    return rows[0] ?? null;
  }

  protected async ridOf(id: string): Promise<number | null> {
    const rows = await this.p.q<{ rid: number }>(`SELECT ${this.p.idCol()} AS rid FROM ${this.rq()} WHERE id = ?`, [id]);
    return rows[0]?.rid ?? null;
  }

  /** Delete one corpus row + its vectors (portable: vec_multi cascades / is deleted by key). */
  protected async deleteRow(rid: number): Promise<void> {
    await this.p.run(`DELETE FROM ${this.p.t("report_queries_vec_multi")} WHERE qrowid = ?`, [this.p.idBind(rid)]);
    await this.p.run(`DELETE FROM ${this.rq()} WHERE ${this.p.idCol()} = ?`, [this.p.idBind(rid)]);
  }

  protected async insertMulti(rid: number, vecs: Float32Array[]): Promise<void> {
    for (const v of vecs) {
      await this.p.run(`INSERT INTO ${this.p.t("report_queries_vec_multi")} (embedding, qrowid) VALUES (?, ?)`, [this.p.vec(v), this.p.idBind(rid)]);
    }
  }

  /** Portable materialize: identity generated by the table; vec_multi keyed by it. Providers override. */
  async materialize(rows: T.MaterializeRow[], vecs: Float32Array[][]): Promise<{ inserted: number; replaced: number }> {
    let inserted = 0, replaced = 0;
    await this.p.tx(async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const prev = await this.ridOf(r.id);
        if (prev != null) { await this.deleteRow(prev); replaced++; }
        const res = await this.p.run(
          `INSERT INTO ${this.rq()}
             (id, source, title, original_sql, clean_sql, description,
              tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding,
              intents, mechanics)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
          [r.id, r.source ?? "bip-report", r.title, r.originalSql, r.cleanSql ?? r.originalSql, r.description,
           JSON.stringify(r.tablesUsed ?? []), JSON.stringify(r.joins ?? []),
           JSON.stringify(r.filters ?? []), JSON.stringify(r.lookupTypes ?? []),
           r.securityPredicate ?? null, JSON.stringify(r.reports ?? []), this.p.vec(vecs[i][0]),
           JSON.stringify(r.intents ?? []), r.mechanics ?? null]);
        await this.insertMulti(res.lastInsertRowid, vecs[i]);
        inserted++;
      }
    });
    return { inserted, replaced };
  }

  async updateEnrichment(id: string, e: T.EnrichmentPatch, vecs: Float32Array[]): Promise<boolean> {
    const rid = await this.ridOf(id);
    if (rid == null) return false;
    await this.p.tx(async () => {
      await this.p.run(
        `UPDATE ${this.rq()} SET description = ?, intents = ?, mechanics = ?${e.cleanSql ? ", clean_sql = ?" : ""}, embedding = ? WHERE ${this.p.idCol()} = ?`,
        e.cleanSql
          ? [e.description, JSON.stringify(e.intents), e.mechanics, e.cleanSql, this.p.vec(vecs[0]), this.p.idBind(rid)]
          : [e.description, JSON.stringify(e.intents), e.mechanics, this.p.vec(vecs[0]), this.p.idBind(rid)]);
      await this.p.run(`DELETE FROM ${this.p.t("report_queries_vec_multi")} WHERE qrowid = ?`, [this.p.idBind(rid)]);
      await this.insertMulti(rid, vecs);
    });
    return true;
  }

  protected inflight(): string {
    return ` AND ${NOT_IN_FLIGHT(this.p.t("batch_items"), this.p.t("batch_jobs"))}`
      + ` AND ${NOT_IN_GEMINI_FLIGHT(this.p.t("gjob_items"), this.p.t("gjob_jobs"))}`;
  }

  /** Rows still lacking v2 enrichment for the given sources — the re-enrich worker's queue.
   *  `includeRedo` also catches BATCH-DEGRADED rows: "(no notable mechanics)" on a non-trivial SQL
   *  (>3000 chars) is a known artifact of prompt-batching, not an honest empty. */
  async reenrichQueue(sources: string[], limit: number, includeRedo = false): Promise<T.QueueRow[]> {
    const ph = sources.map(() => "?").join(",");
    const cond = includeRedo
      ? `(mechanics IS NULL OR (mechanics = '(no notable mechanics)' AND LENGTH(COALESCE(clean_sql, original_sql)) > 3000))`
      : `mechanics IS NULL`;
    return this.p.q<T.QueueRow>(
      `SELECT id, title, COALESCE(clean_sql, original_sql) AS sql, source
       FROM ${this.rq()} WHERE source IN (${ph}) AND ${cond}${this.inflight()}
       ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT ?`, [...sources, limit]);
  }

  /** Only the batch-degraded rows (for the Opus redo batch). */
  async redoQueue(sources: string[], limit: number): Promise<T.QueueRow[]> {
    const ph = sources.map(() => "?").join(",");
    return this.p.q<T.QueueRow>(
      `SELECT id, title, COALESCE(clean_sql, original_sql) AS sql, source
       FROM ${this.rq()} WHERE source IN (${ph})
         AND mechanics = '(no notable mechanics)' AND LENGTH(COALESCE(clean_sql, original_sql)) > 3000${this.inflight()}
       ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT ?`, [...sources, limit]);
  }

  async reenrichCounts(sources: string[]): Promise<{ total: number; done: number; pending: number }> {
    const ph = sources.map(() => "?").join(",");
    const total = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.rq()} WHERE source IN (${ph})`, sources))[0].c;
    const done = (await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.rq()} WHERE source IN (${ph}) AND mechanics IS NOT NULL`, sources))[0].c;
    return { total, done, pending: total - done };
  }

  /** Stream corpus rows (optionally filtered by `source`) in identity order; keyset-paged = O(page) memory. */
  async *export(scope: T.ExportScope, source?: string): AsyncIterable<Record<string, unknown>> {
    const idc = this.p.idCol();
    let after = 0;
    for (;;) {
      const rows = await this.p.q<any>(
        `SELECT q.*, q.${idc} AS _rid FROM ${this.rq()} q WHERE q.${idc} > ?${source ? " AND q.source = ?" : ""} ORDER BY q.${idc} LIMIT 500`,
        source ? [after, source] : [after]);
      if (!rows.length) return;
      for (const r of rows) {
        after = r._rid;
        const row: Record<string, unknown> = {
          id: r.id, source: r.source, title: r.title,
          original_sql: r.original_sql, clean_sql: r.clean_sql, description: r.description,
          tables_used: r.tables_used, joins: r.joins, filters: r.filters,
          lookup_types: r.lookup_types, security_predicate: r.security_predicate, approved: r.approved,
          reports: r.reports,
        };
        if (scope === "full" && r.embedding) {
          const f = this.p.fromVec(r.embedding);
          row.embedding = Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
        }
        yield row;
      }
    }
  }

  /** Insert/replace corpus rows (portable). `vecs[i]` = the row's description vector (decoded from the export, or re-embedded by the caller). */
  async importRows(rows: T.ImportRow[], vecs: Float32Array[]): Promise<{ imported: number; replaced: number }> {
    let imported = 0, replaced = 0;
    await this.p.tx(async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const prev = await this.ridOf(r.id);
        if (prev != null) { await this.deleteRow(prev); replaced++; }
        await this.p.run(
          `INSERT INTO ${this.rq()}
             (id, source, title, original_sql, clean_sql, description,
              tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          [r.id, r.source ?? "bip-report", r.title, r.original_sql, r.clean_sql ?? r.original_sql, r.description,
           r.tables_used ?? "[]", r.joins ?? "[]", r.filters ?? "[]", r.lookup_types ?? "[]", r.security_predicate ?? null,
           r.reports ?? "[]", this.p.vec(vecs[i])]);
        imported++;
      }
    });
    return { imported, replaced };
  }

  /** table_join_columns is written by the dev import pipeline (import_serving.mjs) and may be absent
   *  on a freshly compiled catalog — absence = no stats (the caller omits the key). */
  async joinColumnStats(table: string, limit: number): Promise<T.JoinColumnStat[]> {
    try {
      return await this.p.q<T.JoinColumnStat>(
        `SELECT column_name AS column, units, share FROM ${this.p.t("table_join_columns")} WHERE table_name = ? ORDER BY share DESC LIMIT ?`,
        [table, limit]);
    } catch { return []; }
  }

  async rowsForGrain(): Promise<T.GrainInputRow[]> {
    return this.p.q<T.GrainInputRow>(
      `SELECT tables_used, clean_sql, original_sql FROM ${this.rq()} WHERE clean_sql IS NOT NULL OR original_sql IS NOT NULL`);
  }

  async rowsForUsage(): Promise<T.UsageInputRow[]> {
    return this.p.q<T.UsageInputRow>(
      `SELECT id, source, title, tables_used,
              LENGTH(COALESCE(clean_sql, original_sql, '')) AS sql_chars
       FROM ${this.rq()}
       WHERE tables_used IS NOT NULL AND tables_used <> '[]'`);
  }

  async rowsForPredicates(): Promise<T.PredicateInputRow[]> {
    return this.p.q<T.PredicateInputRow>(`SELECT filters FROM ${this.rq()} WHERE filters IS NOT NULL AND filters <> '[]'`);
  }

  /** compile.ts bulk insert (portable shape; the sqlite provider assigns explicit identities). */
  async bulkLoad(rows: T.CorpusLoadRow[], vecs: Float32Array[]): Promise<number> {
    await this.p.tx(async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        await this.p.run(
          `INSERT INTO ${this.rq()} (id, source, title, original_sql, clean_sql, description,
             tables_used, joins, filters, lookup_types, security_predicate, approved, embedding)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.id, r.source, r.title, r.originalSql, r.cleanSql, r.description,
           JSON.stringify(r.tablesUsed), JSON.stringify(r.joins), JSON.stringify(r.filters), JSON.stringify(r.lookupTypes),
           r.securityPredicate, r.approved, this.p.vec(vecs[i])]);
      }
    });
    return rows.length;
  }

  async rowsMissingEmbedding(sources?: string[]): Promise<T.EmbeddingTarget[]> {
    const where = sources?.length ? `WHERE source IN (${sources.map(() => "?").join(",")}) AND embedding IS NULL` : "WHERE embedding IS NULL";
    return this.p.q<T.EmbeddingTarget>(`SELECT ${this.p.idCol()} AS rid, description FROM ${this.rq()} ${where}`, sources ?? []);
  }

  async allRowsForEmbedding(): Promise<T.EmbeddingTarget[]> {
    return this.p.q<T.EmbeddingTarget>(`SELECT ${this.p.idCol()} AS rid, description FROM ${this.rq()}`);
  }

  async setEmbeddings(entries: { rid: number; vec: Float32Array }[]): Promise<void> {
    await this.p.tx(async () => {
      for (const e of entries) {
        await this.p.run(`UPDATE ${this.rq()} SET embedding = ? WHERE ${this.p.idCol()} = ?`, [this.p.vec(e.vec), this.p.idBind(e.rid)]);
      }
    });
  }

  async rebuildVectorIndex(): Promise<void> { /* the portable shape keeps the vector on the row itself */ }

  async replaceSourcesFromSeed(_seedFile: string, _sources: string[]): Promise<number> {
    throw new Error("replaceSourcesFromSeed: sqlite-only provisioning step");
  }
}
