import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { SqlSource } from "./sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT = process.env.ENRICH_DB ?? path.resolve(__dirname, "../../data/enrich.sqlite");

export type ReportRef = { path?: string; title?: string; index?: number };

export type EnrichRow = {
  id: string; source: string; title: string; sourceHash: string;
  originalSql: string; cleanSql: string | null; description: string | null;
  tablesUsed: string[]; lookupTypes: string[]; joins: any[]; filters: string[];
  securityPredicate: string | null; approved: number; reports: ReportRef[];
};

export type Enrichment = {
  cleanSql: string; description: string; tablesUsed: string[];
  lookupTypes: string[]; joins: any[]; filters: string[]; securityPredicate: string | null;
};

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = (s: string | null) => (s ? JSON.parse(s) : []);

export function openEnrichStore(dbPath: string = DEFAULT) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrich (
      id TEXT PRIMARY KEY, source TEXT, title TEXT, source_hash TEXT,
      original_sql TEXT, clean_sql TEXT, description TEXT,
      tables_used TEXT, lookup_types TEXT, joins TEXT, filters TEXT,
      security_predicate TEXT, approved INTEGER DEFAULT 0, reports TEXT
    );`);
  // migrate older stores that predate the reports column
  try { db.exec("ALTER TABLE enrich ADD COLUMN reports TEXT"); } catch { /* already present */ }

  const qHash = db.prepare("SELECT source_hash, description FROM enrich WHERE id = ?");
  const qReports = db.prepare("SELECT reports FROM enrich WHERE id = ?");
  const insSrc = db.prepare(`
    INSERT INTO enrich (id, source, title, source_hash, original_sql, reports)
    VALUES (@id, @source, @title, @sourceHash, @originalSql, @reports)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source, title=excluded.title,
      source_hash=excluded.source_hash, original_sql=excluded.original_sql,
      clean_sql=NULL, description=NULL   -- hash changed → invalidate prior enrichment
    WHERE enrich.source_hash <> excluded.source_hash`);
  const updReports = db.prepare("UPDATE enrich SET reports=@reports WHERE id=@id");
  const updEnr = db.prepare(`
    UPDATE enrich SET clean_sql=@cleanSql, description=@description,
      tables_used=@tablesUsed, lookup_types=@lookupTypes, joins=@joins,
      filters=@filters, security_predicate=@securityPredicate WHERE id=@id`);
  const qGet = db.prepare("SELECT * FROM enrich WHERE id = ?");
  const qAll = db.prepare("SELECT * FROM enrich");

  const toRow = (r: any): EnrichRow => r && {
    id: r.id, source: r.source, title: r.title, sourceHash: r.source_hash,
    originalSql: r.original_sql, cleanSql: r.clean_sql, description: r.description,
    tablesUsed: P(r.tables_used), lookupTypes: P(r.lookup_types), joins: P(r.joins),
    filters: P(r.filters), securityPredicate: r.security_predicate, approved: r.approved,
    reports: r.reports ? JSON.parse(r.reports) : [],
  };

  return {
    pendingIds(sources: SqlSource[]): SqlSource[] {
      return sources.filter((s) => {
        const row = qHash.get(s.id) as { source_hash: string; description: string | null } | undefined;
        return !row || row.source_hash !== s.sourceHash || row.description == null;
      });
    },
    upsertSource(s: SqlSource) { insSrc.run({ ...s, reports: null }); },
    /**
     * Content-dedup stage: `s.id` is a normalized-SQL hash, so identical queries across reports
     * collapse to ONE row. Merges the report reference; keeps the existing enrichment intact.
     * Returns true if this was a brand-new SQL (first time seen).
     */
    stageSql(s: SqlSource, ref: ReportRef): boolean {
      const existing = qReports.get(s.id) as { reports: string | null } | undefined;
      if (!existing) {
        insSrc.run({ ...s, reports: J([ref]) });
        return true;
      }
      const refs: ReportRef[] = existing.reports ? JSON.parse(existing.reports) : [];
      if (!refs.some((r) => r.path === ref.path && r.index === ref.index)) {
        refs.push(ref);
        updReports.run({ id: s.id, reports: J(refs) });
      }
      return false;
    },
    setEnrichment(id: string, e: Enrichment) {
      updEnr.run({ id, cleanSql: e.cleanSql, description: e.description,
        tablesUsed: J(e.tablesUsed), lookupTypes: J(e.lookupTypes),
        joins: J(e.joins), filters: J(e.filters), securityPredicate: e.securityPredicate });
    },
    get(id: string) { return toRow(qGet.get(id)); },
    all(): EnrichRow[] { return (qAll.all() as any[]).map(toRow); },
    /** Staging rows awaiting enrichment (no description yet) — the enrich worker's queue. */
    pendingRows(): EnrichRow[] {
      const stmt = db.prepare("SELECT * FROM enrich WHERE description IS NULL");
      return (stmt.all() as any[]).map(toRow);
    },
    /** Staging counts for /ingest/health: pending (unenriched) vs enriched (has description). */
    counts(): { pending: number; enriched: number } {
      const pending = (db.prepare("SELECT COUNT(*) AS n FROM enrich WHERE description IS NULL").get() as any).n as number;
      const enriched = (db.prepare("SELECT COUNT(*) AS n FROM enrich WHERE description IS NOT NULL").get() as any).n as number;
      return { pending, enriched };
    },
    *iterateEnriched(): Generator<EnrichRow> {
      const stmt = db.prepare("SELECT * FROM enrich WHERE description IS NOT NULL");
      for (const r of stmt.iterate() as any) yield toRow(r);
    },
    db,
  };
}
export type EnrichStore = ReturnType<typeof openEnrichStore>;
