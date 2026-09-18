import { BaseCorpus, RQ_COLS } from "../base/corpus.js";
import type * as T from "../types.js";
import { sqlQuote } from "./paths.js";
import type { SqliteProvider } from "./provider.js";

/** sqlite-vec shape: explicit rowids, the 1-vector `report_queries_vec` (rowid PK) + `report_queries_vec_multi` (+qrowid). */
export class SqliteCorpus extends BaseCorpus {
  constructor(protected p: SqliteProvider) { super(p); }

  async knn(vec: Float32Array, k: number, opts: { source?: string; multi?: boolean } = {}): Promise<T.CorpusHit[]> {
    const blob = this.p.vec(vec);
    if (opts.multi) {
      // multi-vector KNN: one vec row per intent PHRASING -> caller dedups by query row (qrid).
      // NB: the KNN must live in a bare subquery — joining/filtering the vec0 aux column inside
      // the KNN query itself is an "illegal WHERE constraint" for sqlite-vec.
      // the inner LIMIT (same value as k) blocks SQLite's subquery flattening, which would
      // otherwise push the JOIN constraint into vec0 and fail ("illegal WHERE constraint").
      return opts.source
        ? this.p.q<T.CorpusHit>(
            `SELECT ${RQ_COLS}, rq.rowid AS qrid, v.distance AS distance
             FROM (SELECT qrowid, distance FROM report_queries_vec_multi
                   WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
             JOIN report_queries rq ON rq.rowid = v.qrowid
             WHERE rq.source = ?
             ORDER BY v.distance
             LIMIT ?`, [blob, k, opts.source, k])
        : this.p.q<T.CorpusHit>(
            `SELECT ${RQ_COLS}, rq.rowid AS qrid, v.distance AS distance
             FROM (SELECT qrowid, distance FROM report_queries_vec_multi
                   WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
             JOIN report_queries rq ON rq.rowid = v.qrowid
             ORDER BY v.distance`, [blob, k]);
    }
    return opts.source
      ? this.p.q<T.CorpusHit>(
          `SELECT ${RQ_COLS}, v.distance AS distance
           FROM report_queries_vec v
           JOIN report_queries rq ON rq.rowid = v.rowid
           WHERE v.embedding MATCH ? AND k = ? AND rq.source = ?
           ORDER BY v.distance
           LIMIT ?`, [blob, k, opts.source, k])
      : this.p.q<T.CorpusHit>(
          `SELECT ${RQ_COLS}, v.distance AS distance
           FROM report_queries_vec v
           JOIN report_queries rq ON rq.rowid = v.rowid
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance`, [blob, k]);
  }

  /**
   * Insert enriched staging rows into report_queries + report_queries_vec (+ vec_multi). Idempotent by
   * id: a row whose id already exists is deleted (with its vecs) and re-inserted with a fresh rowid.
   * `vecs[i]` = embedTexts() order (description+tables first, then each intent). `approved` = 1.
   */
  async materialize(rows: T.MaterializeRow[], vecs: Float32Array[][]): Promise<{ inserted: number; replaced: number }> {
    const d = this.p.d;
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

    let inserted = 0, replaced = 0;
    await this.p.syncTx(() => {
      let next = (maxRowid.get() as any).m as number; // new rowids strictly exceed all existing → no collisions
      rows.forEach((r, i) => {
        const prev = qById.get(r.id) as { rowid: number } | undefined;
        if (prev) { delVec.run(prev.rowid); delMulti.run(prev.rowid); delRq.run(prev.rowid); replaced++; }
        const rowid = BigInt(++next);
        const rowVecs = vecs[i];
        const emb = this.p.vec(rowVecs[0]);
        insRq.run(
          rowid, r.id, r.source ?? "bip-report", r.title, r.originalSql, r.cleanSql ?? r.originalSql, r.description,
          JSON.stringify(r.tablesUsed ?? []), JSON.stringify(r.joins ?? []),
          JSON.stringify(r.filters ?? []), JSON.stringify(r.lookupTypes ?? []),
          r.securityPredicate ?? null, JSON.stringify(r.reports ?? []), emb,
          JSON.stringify(r.intents ?? []), r.mechanics ?? null,
        );
        insVec.run(rowid, emb);
        for (const v of rowVecs) insMulti.run(this.p.vec(v), rowid);
        inserted++;
      });
    });
    return { inserted, replaced };
  }

  /** v2 re-enrichment writer: rewrite one MATERIALIZED row in place and rebuild its vectors (1-vector + multi). */
  async updateEnrichment(id: string, e: T.EnrichmentPatch, vecs: Float32Array[]): Promise<boolean> {
    const d = this.p.d;
    const row = (await this.p.q<{ rowid: number }>("SELECT rowid FROM report_queries WHERE id = ?", [id]))[0];
    if (!row) return false;
    await this.p.syncTx(() => {
      d.prepare(
        `UPDATE report_queries SET description = ?, intents = ?, mechanics = ?${e.cleanSql ? ", clean_sql = ?" : ""}, embedding = ? WHERE rowid = ?`,
      ).run(
        ...(e.cleanSql
          ? [e.description, JSON.stringify(e.intents), e.mechanics, e.cleanSql, this.p.vec(vecs[0]), row.rowid]
          : [e.description, JSON.stringify(e.intents), e.mechanics, this.p.vec(vecs[0]), row.rowid]),
      );
      d.prepare("DELETE FROM report_queries_vec WHERE rowid = ?").run(BigInt(row.rowid));
      d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(row.rowid), this.p.vec(vecs[0]));
      const rid = BigInt(row.rowid);
      d.prepare("DELETE FROM report_queries_vec_multi WHERE qrowid = ?").run(rid);
      const ins = d.prepare("INSERT INTO report_queries_vec_multi (embedding, qrowid) VALUES (?, ?)");
      for (const v of vecs) ins.run(this.p.vec(v), rid);
    });
    return true;
  }

  /** Insert/replace corpus rows (portable export shape); `vecs[i]` = description vector (verbatim or re-embedded). */
  async importRows(rows: T.ImportRow[], vecs: Float32Array[]): Promise<{ imported: number; replaced: number }> {
    const d = this.p.d;
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
    let imported = 0, replaced = 0;
    await this.p.syncTx(() => {
      let next = (maxRowid.get() as any).m as number;
      rows.forEach((r, i) => {
        const prev = qById.get(r.id) as { rowid: number } | undefined;
        if (prev) { delVec.run(prev.rowid); delRq.run(prev.rowid); replaced++; }
        const rowid = BigInt(++next);
        const vec = this.p.vec(vecs[i]);
        insRq.run(
          rowid, r.id, r.source ?? "bip-report", r.title, r.original_sql, r.clean_sql ?? r.original_sql, r.description,
          r.tables_used ?? "[]", r.joins ?? "[]", r.filters ?? "[]", r.lookup_types ?? "[]", r.security_predicate ?? null,
          r.reports ?? "[]", vec,
        );
        insVec.run(rowid, vec);
        imported++;
      });
    });
    return { imported, replaced };
  }

  /** compile.ts: rowid set explicitly on BOTH tables so the vec JOIN back by rowid is guaranteed aligned. */
  async bulkLoad(rows: T.CorpusLoadRow[], vecs: Float32Array[]): Promise<number> {
    const d = this.p.d;
    const insRq = d.prepare(`
      INSERT INTO report_queries (rowid, id, source, title, original_sql, clean_sql, description,
        tables_used, joins, filters, lookup_types, security_predicate, approved, embedding)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insVec = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
    const maxRowid = d.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM report_queries");
    await this.p.syncTx(() => {
      let rid = (maxRowid.get() as any).m as number;
      rows.forEach((r, k) => {
        rid++;
        const emb = this.p.vec(vecs[k]);
        insRq.run(BigInt(rid), r.id, r.source, r.title, r.originalSql, r.cleanSql, r.description,
          JSON.stringify(r.tablesUsed), JSON.stringify(r.joins), JSON.stringify(r.filters), JSON.stringify(r.lookupTypes),
          r.securityPredicate, r.approved, emb);
        insVec.run(BigInt(rid), emb);
      });
    });
    return rows.length;
  }

  /** Rebuild report_queries_vec from every report_queries.embedding blob (no re-embedding). */
  async rebuildVectorIndex(): Promise<void> {
    const d = this.p.d;
    const ins = d.prepare("INSERT INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");
    // rows are read up front: better-sqlite3 rejects running a statement while an iterate() cursor
    // is open on the same connection (the pre-library provision.rebuildVec did exactly that — latent)
    const rows = d.prepare("SELECT rowid, embedding FROM report_queries WHERE embedding IS NOT NULL").all() as { rowid: number; embedding: Buffer }[];
    await this.p.syncTx(() => {
      d.exec("DELETE FROM report_queries_vec");
      for (const r of rows) ins.run(BigInt(r.rowid), r.embedding);
    });
  }

  /** queries_version bump: replace the rows of `sources` with the seed's (ATTACH), keep everything else. */
  async replaceSourcesFromSeed(seedFile: string, sources: string[]): Promise<number> {
    const d = this.p.d;
    const ph = sources.map(() => "?").join(",");
    await this.p.exec(`ATTACH DATABASE '${sqlQuote(seedFile)}' AS seed`);
    try {
      return await this.p.syncTx(() => {
        const seedRows = d.prepare(`SELECT * FROM seed.report_queries WHERE source IN (${ph}) ORDER BY rowid`).all(...sources) as any[];
        const seedCols = new Set(
          (d.prepare("SELECT name FROM pragma_table_info('report_queries', 'seed')").all() as any[]).map((c) => c.name),
        );
        const ins = d.prepare(
          `INSERT INTO report_queries
             (rowid, id, source, title, original_sql, clean_sql, description,
              tables_used, joins, filters, lookup_types, security_predicate, approved, reports, embedding)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        d.prepare(`DELETE FROM report_queries WHERE source IN (${ph})`).run(...sources);
        let next = (d.prepare("SELECT COALESCE(MAX(rowid),0) AS m FROM report_queries").get() as any).m as number;
        for (const r of seedRows) {
          ins.run(
            BigInt(++next), r.id, r.source, r.title,
            r.original_sql, r.clean_sql, r.description,
            r.tables_used ?? "[]", r.joins ?? "[]", r.filters ?? "[]",
            r.lookup_types ?? "[]", r.security_predicate ?? null,
            r.approved ?? 1, seedCols.has("reports") ? (r.reports ?? "[]") : "[]",
            seedCols.has("embedding") ? (r.embedding ?? null) : null,
          );
        }
        return seedRows.length;
      });
    } finally {
      await this.p.exec("DETACH DATABASE seed");
    }
  }
}
