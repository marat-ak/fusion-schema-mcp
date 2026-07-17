import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { SqlSource } from "./sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT = process.env.ENRICH_DB ?? path.resolve(__dirname, "../../data/enrich.sqlite");

export type EnrichRow = {
  id: string; source: string; title: string; sourceHash: string;
  originalSql: string; cleanSql: string | null; description: string | null;
  tablesUsed: string[]; lookupTypes: string[]; joins: any[]; filters: string[];
  securityPredicate: string | null; approved: number;
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
      security_predicate TEXT, approved INTEGER DEFAULT 0
    );`);

  const qHash = db.prepare("SELECT source_hash, description FROM enrich WHERE id = ?");
  const insSrc = db.prepare(`
    INSERT INTO enrich (id, source, title, source_hash, original_sql)
    VALUES (@id, @source, @title, @sourceHash, @originalSql)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source, title=excluded.title,
      source_hash=excluded.source_hash, original_sql=excluded.original_sql,
      clean_sql=NULL, description=NULL   -- hash changed → invalidate prior enrichment
    WHERE enrich.source_hash <> excluded.source_hash`);
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
  };

  return {
    pendingIds(sources: SqlSource[]): SqlSource[] {
      return sources.filter((s) => {
        const row = qHash.get(s.id) as { source_hash: string; description: string | null } | undefined;
        return !row || row.source_hash !== s.sourceHash || row.description == null;
      });
    },
    upsertSource(s: SqlSource) { insSrc.run(s); },
    setEnrichment(id: string, e: Enrichment) {
      updEnr.run({ id, cleanSql: e.cleanSql, description: e.description,
        tablesUsed: J(e.tablesUsed), lookupTypes: J(e.lookupTypes),
        joins: J(e.joins), filters: J(e.filters), securityPredicate: e.securityPredicate });
    },
    get(id: string) { return toRow(qGet.get(id)); },
    all(): EnrichRow[] { return (qAll.all() as any[]).map(toRow); },
    *iterateEnriched(): Generator<EnrichRow> {
      const stmt = db.prepare("SELECT * FROM enrich WHERE description IS NOT NULL");
      for (const r of stmt.iterate() as any) yield toRow(r);
    },
    db,
  };
}
export type EnrichStore = ReturnType<typeof openEnrichStore>;
