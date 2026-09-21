import { BaseCorpus, RQ_COLS } from "../base/corpus.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/** The physical corpus columns, in the order every INSERT below binds them. */
const RQ_COLUMNS = ["id", "source", "title", "original_sql", "clean_sql", "description",
  "tables_used", "joins", "filters", "lookup_types", "security_predicate", "approved", "reports",
  "embedding", "intents", "mechanics", "origin"];
const RQ_INSERT = `(${RQ_COLUMNS.join(", ")})`;
/** Replace-by-id rewrites every column except the identity. */
const RQ_UPDATE = RQ_COLUMNS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");

/**
 * pgvector corpus. KNN is EXACT (`ORDER BY embedding <-> $1`, no ANN index — ddl.sql:15-21): at
 * 23.7k rows a sequential scan beats index build/recall risk, and it returns the same L2 distance
 * sqlite-vec does, so the caller's `1 - d²/2` score is identical to float precision.
 *
 * Writes follow D14: every ingest/materialize/enrichment row lands in `customer` AND the active
 * version schema inside ONE transaction — `customer` is what the upgrade job merges forward, the
 * active schema is what serves reads until then. Each schema assigns its OWN `rid` (identity), and
 * the row's `report_queries_vec_multi` rows are keyed to that schema's rid.
 */
export class PgCorpus extends BaseCorpus {
  constructor(protected p: PostgresProvider) { super(p); }

  /**
   * Exact title first — the base statement, unchanged ("largest SQL wins" among the datasets of
   * one .xdm). On a miss, the REFERENCE titles: since v2026_10 every corpus row is one deduped
   * statement keyed `sql:<hash>`, and `reports` carries one `{path, title, index}` object per L2
   * unit that fed it (the old `otbi:`/`view:` ids as `path`, their titles as `title`). A title that
   * belonged to a unit which lost the collision pick — 166 shipped titles — lives there and nowhere
   * else. Two statements, not one, because the exact match is indexed and this scan is not.
   */
  async byTitle(title: string): Promise<T.CorpusRow | null> {
    const exact = await super.byTitle(title);
    if (exact) return exact;
    const rows = await this.p.q<T.CorpusRow>(
      `SELECT id, source, title, original_sql, clean_sql, description,
              tables_used, joins, filters, lookup_types, security_predicate
       FROM ${this.rq()}
       WHERE reports IS NOT NULL AND reports <> '[]'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(reports::jsonb) r WHERE r->>'title' = ?)
       ORDER BY LENGTH(COALESCE(clean_sql, original_sql)) DESC LIMIT 1`, [title]);
    return rows[0] ?? null;
  }

  async knn(vec: Float32Array, k: number, opts: { source?: string; multi?: boolean } = {}): Promise<T.CorpusHit[]> {
    const v = this.p.vec(vec);
    if (opts.multi) {
      // one vec row per intent phrasing → the caller dedups by query row (qrid)
      const src = opts.source ? "WHERE rq.source = ?" : "";
      return this.p.q<T.CorpusHit>(
        `SELECT ${RQ_COLS}, rq.rid AS qrid, v.distance AS distance
         FROM (SELECT qrowid, embedding <-> ?::vector AS distance
               FROM ${this.p.t("report_queries_vec_multi")} ORDER BY distance LIMIT ?) v
         JOIN ${this.rq()} rq ON rq.rid = v.qrowid ${src}
         ORDER BY v.distance${opts.source ? " LIMIT ?" : ""}`,
        opts.source ? [v, k, opts.source, k] : [v, k]);
    }
    const src = opts.source ? "WHERE rq.source = ?" : "";
    return this.p.q<T.CorpusHit>(
      `SELECT ${RQ_COLS}, rq.embedding <-> ?::vector AS distance
       FROM ${this.rq()} rq ${src} ORDER BY distance LIMIT ?`,
      opts.source ? [v, opts.source, k] : [v, k]);
  }

  /**
   * Write one corpus row into ONE schema. Replace-by-id is an `ON CONFLICT (id) DO UPDATE` rather
   * than delete+insert: it keeps `rid` stable (so the vectors re-key cleanly) and two concurrent
   * writers of the same id serialize on the row instead of racing a unique violation.
   */
  private async writeRow(rq: string, vm: string, cols: unknown[], vecs: Float32Array[]): Promise<{ rid: number; replaced: boolean }> {
    const prev = await this.p.q<{ rid: number }>(`SELECT rid FROM ${rq} WHERE id = ?`, [cols[0]]);
    const ins = await this.p.q<{ rid: number }>(
      `INSERT INTO ${rq} ${RQ_INSERT} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET ${RQ_UPDATE} RETURNING rid`, cols);
    const rid = ins[0].rid;
    await this.p.run(`DELETE FROM ${vm} WHERE qrowid = ?`, [rid]);
    for (const v of vecs) {
      await this.p.run(`INSERT INTO ${vm} (qrowid, embedding) VALUES (?, ?)`, [rid, this.p.vec(v)]);
    }
    return { rid, replaced: prev.length > 0 };
  }

  private targets(): { rq: string; vm: string }[] {
    const rq = this.p.tw("report_queries");
    const vm = this.p.tw("report_queries_vec_multi");
    return rq.map((t, i) => ({ rq: t, vm: vm[i] }));
  }

  async materialize(rows: T.MaterializeRow[], vecs: Float32Array[][]): Promise<{ inserted: number; replaced: number }> {
    let inserted = 0, replaced = 0;
    await this.p.tx(async () => {
      for (const [i, tgt] of this.targets().entries()) {
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k];
          const res = await this.writeRow(tgt.rq, tgt.vm, [
            r.id, r.source ?? "bip-report", r.title, r.originalSql, r.cleanSql ?? r.originalSql, r.description,
            JSON.stringify(r.tablesUsed ?? []), JSON.stringify(r.joins ?? []),
            JSON.stringify(r.filters ?? []), JSON.stringify(r.lookupTypes ?? []),
            r.securityPredicate ?? null, 1, JSON.stringify(r.reports ?? []), this.p.vec(vecs[k][0]),
            JSON.stringify(r.intents ?? []), r.mechanics ?? null, "customer",
          ], vecs[k]);
          if (i === 0) { inserted++; if (res.replaced) replaced++; }
        }
      }
    });
    return { inserted, replaced };
  }

  async updateEnrichment(id: string, e: T.EnrichmentPatch, vecs: Float32Array[]): Promise<boolean> {
    let found = false;
    await this.p.tx(async () => {
      for (const [i, tgt] of this.targets().entries()) {
        const row = (await this.p.q<{ rid: number }>(`SELECT rid FROM ${tgt.rq} WHERE id = ?`, [id]))[0];
        if (!row) continue;
        if (i === 0) found = true;
        await this.p.run(
          `UPDATE ${tgt.rq} SET description = ?, intents = ?, mechanics = ?${e.cleanSql ? ", clean_sql = ?" : ""}, embedding = ? WHERE rid = ?`,
          e.cleanSql
            ? [e.description, JSON.stringify(e.intents), e.mechanics, e.cleanSql, this.p.vec(vecs[0]), row.rid]
            : [e.description, JSON.stringify(e.intents), e.mechanics, this.p.vec(vecs[0]), row.rid]);
        await this.p.run(`DELETE FROM ${tgt.vm} WHERE qrowid = ?`, [row.rid]);
        for (const v of vecs) await this.p.run(`INSERT INTO ${tgt.vm} (qrowid, embedding) VALUES (?, ?)`, [row.rid, this.p.vec(v)]);
      }
    });
    return found;
  }

  async importRows(rows: T.ImportRow[], vecs: Float32Array[]): Promise<{ imported: number; replaced: number }> {
    let imported = 0, replaced = 0;
    await this.p.tx(async () => {
      for (const [i, tgt] of this.targets().entries()) {
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k];
          const res = await this.writeRow(tgt.rq, tgt.vm, [
            r.id, r.source ?? "bip-report", r.title, r.original_sql, r.clean_sql ?? r.original_sql, r.description,
            r.tables_used ?? "[]", r.joins ?? "[]", r.filters ?? "[]", r.lookup_types ?? "[]",
            r.security_predicate ?? null, 1, r.reports ?? "[]", this.p.vec(vecs[k]),
            "[]", null, "customer",
          ], []);
          if (i === 0) { imported++; if (res.replaced) replaced++; }
        }
      }
    });
    return { imported, replaced };
  }

  /** Vendor build path (compile): COPY into the ACTIVE version schema only — these rows ARE the
   *  delivered version, never customer state. `rid` comes from the identity sequence. */
  async bulkLoad(rows: T.CorpusLoadRow[], vecs: Float32Array[]): Promise<number> {
    if (!rows.length) return 0;
    const [schema] = this.p.schemasOf("report_queries");
    const cols = ["id", "source", "title", "original_sql", "clean_sql", "description", "tables_used", "joins",
      "filters", "lookup_types", "security_predicate", "approved", "embedding", "origin"];
    return this.p.copyIn(schema, "report_queries", cols, rows.map((r, i) => [
      r.id, r.source, r.title, r.originalSql, r.cleanSql, r.description,
      JSON.stringify(r.tablesUsed), JSON.stringify(r.joins), JSON.stringify(r.filters), JSON.stringify(r.lookupTypes),
      r.securityPredicate, r.approved, this.p.vec(vecs[i]), "vendor",
    ]));
  }
}
