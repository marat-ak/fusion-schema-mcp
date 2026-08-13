/**
 * Usage graph — the reverse index table -> real queries that USE it, so the agent can pull the raw
 * join/filter idioms of real reports for a table it already knows (table-anchored retrieval, the
 * complement to intent-anchored findSimilarQueries). Coverage is near-total: `tables_used` is
 * populated on 100% of OTBI/view rows and 99.8% of hand-written bip-report rows — so this reaches the
 * exact sources where structured predicate/join extraction is blind (bip/view get 0 filters/joins),
 * letting the agent read their raw SQL instead. Mitigates G2 (blind sources) and G6 (adopt-before-
 * derive) without any re-enrichment.
 *
 * Built at runtime from report_queries (idempotent, version-gated) so it stays in sync with the
 * runtime-ingested corpus. Ranked for ADOPTION: real reports/views outrank per-column OTBI fragments
 * (which read tables flat — bad templates), then by SQL completeness. Stored capped per table.
 */
import Database from "better-sqlite3";
import { reportsDbPath, schemaDbPath, sqlQuote } from "../dbPaths.js";

// Keep at most this many usages per table (bounds storage; heavy-fan-in tables are used by ~58k
// queries — we only ever want the best few dozen real examples for adoption).
const MAX_USAGES_PER_TABLE = 60;
// Source weight for adoption: a real hand-written report or a delivered view is a far better template
// than a per-column OTBI fragment that reads the table flat.
const SOURCE_WEIGHT: Record<string, number> = { "bip-report": 3, view: 2, otbi: 1 };
// Per-usage inline-SQL cap for the explicit tool (several usages return at once, so smaller than the
// findSimilarQueries single-match cap); larger bodies ship a fetchWith(id) pointer.
const USAGE_SQL_INLINE_CAP = Number(process.env.USAGE_SQL_INLINE_CAP ?? 2500);

export interface UsageDigest {
  id: string;
  title: string;
  source: string;
  sqlChars: number;
  filters: string[];
  joins: string[];
  cleanSql?: string;
  cleanSqlOmitted?: true;
  fetchWith?: string;
}

function scoreUsage(source: string, sqlChars: number): number {
  const w = SOURCE_WEIGHT[source] ?? 1;
  return w * 100000 + Math.min(sqlChars, 90000);
}

function parseArr(s: string | null): string[] {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/** (Re)build table_usages from report_queries.tables_used. `d` = a WRITABLE reports connection. */
export function rebuildUsageGraph(d: Database.Database): { rows: number; tables: number } {
  d.exec(`
    CREATE TABLE IF NOT EXISTS table_usages (
      table_name TEXT NOT NULL,
      query_id   TEXT NOT NULL,
      source     TEXT,
      title      TEXT,
      sql_chars  INTEGER NOT NULL DEFAULT 0,
      score      INTEGER NOT NULL DEFAULT 0
    )`);
  d.exec("CREATE INDEX IF NOT EXISTS ix_table_usages ON table_usages(table_name, score DESC)");

  const rows = d.prepare(
    `SELECT id, source, title, tables_used,
            LENGTH(COALESCE(clean_sql, original_sql, '')) AS sql_chars
     FROM report_queries
     WHERE tables_used IS NOT NULL AND tables_used <> '[]'`,
  ).all() as { id: string; source: string; title: string; tables_used: string; sql_chars: number }[];

  // table -> array of candidate usages; we keep only the top MAX_USAGES_PER_TABLE by score.
  const byTable = new Map<string, { id: string; source: string; title: string; sql_chars: number; score: number }[]>();
  for (const r of rows) {
    const tabs = parseArr(r.tables_used);
    const seen = new Set<string>();
    for (const raw of tabs) {
      const t = String(raw).toUpperCase();
      if (!t || seen.has(t)) continue; // one credit per (query, table)
      seen.add(t);
      let arr = byTable.get(t);
      if (!arr) { arr = []; byTable.set(t, arr); }
      arr.push({ id: r.id, source: r.source, title: r.title, sql_chars: r.sql_chars, score: scoreUsage(r.source, r.sql_chars) });
    }
  }

  const ins = d.prepare(
    "INSERT INTO table_usages (table_name, query_id, source, title, sql_chars, score) VALUES (?,?,?,?,?,?)",
  );
  let total = 0;
  const tx = d.transaction(() => {
    d.exec("DELETE FROM table_usages");
    for (const [table, arr] of byTable) {
      arr.sort((a, b) => b.score - a.score);
      for (const u of arr.slice(0, MAX_USAGES_PER_TABLE)) {
        ins.run(table, u.id, u.source, u.title, u.sql_chars, u.score);
        total++;
      }
    }
  });
  tx();
  return { rows: total, tables: byTable.size };
}

/** Read the top real-query usages for a table (case-insensitive). `brief` omits SQL (auto-attach). */
export function getTableUsages(
  reports: Database.Database,
  table: string,
  opts: { limit?: number; brief?: boolean } = {},
): { table: string; usageCount: number; usages: UsageDigest[] } {
  const t = table.toUpperCase();
  const limit = Math.max(1, Math.min(opts.limit ?? 5, MAX_USAGES_PER_TABLE));
  let total = 0;
  try {
    total = (reports.prepare("SELECT COUNT(*) c FROM table_usages WHERE table_name = ?").get(t) as any)?.c ?? 0;
  } catch { return { table: t, usageCount: 0, usages: [] }; }

  const rows = reports.prepare(
    `SELECT u.query_id AS id, u.source, u.title, u.sql_chars,
            r.filters, r.joins, r.clean_sql, r.original_sql
     FROM table_usages u JOIN report_queries r ON r.id = u.query_id
     WHERE u.table_name = ? ORDER BY u.score DESC LIMIT ?`,
  ).all(t, limit) as any[];

  const usages: UsageDigest[] = rows.map((r) => {
    const base: UsageDigest = {
      id: r.id, title: r.title, source: r.source, sqlChars: r.sql_chars,
      filters: parseArr(r.filters), joins: parseArr(r.joins),
    };
    if (opts.brief) return base;
    const sql = (r.clean_sql ?? r.original_sql ?? "") as string;
    if (sql && sql.length <= USAGE_SQL_INLINE_CAP) base.cleanSql = sql;
    else if (sql) { base.cleanSqlOmitted = true; base.fetchWith = `getReportQuery(id) for the full SQL`; }
    return base;
  });
  return { table: t, usageCount: total, usages };
}

export function usageGraphCount(reports: Database.Database): number {
  try { return (reports.prepare("SELECT COUNT(*) c FROM table_usages").get() as any).c; } catch { return 0; }
}

// Bump when the build logic / ranking changes so a redeploy rebuilds the index.
const USAGE_VERSION = 1;

/** Startup helper: (re)build table_usages when empty, the logic version changed, or force=true. */
export function ensureUsageGraph(force = false): { built: boolean; rows: number; tables: number } {
  const d = new Database(reportsDbPath());
  try {
    d.exec(`ATTACH DATABASE '${sqlQuote(schemaDbPath())}' AS schemadb`);
    d.exec("CREATE TABLE IF NOT EXISTS usage_meta (k TEXT PRIMARY KEY, v TEXT)");
    const ver = (d.prepare("SELECT v FROM usage_meta WHERE k='version'").get() as any)?.v;
    const have = usageGraphCount(d);
    if (have > 0 && ver === String(USAGE_VERSION) && !force) return { built: false, rows: have, tables: 0 };
    const r = rebuildUsageGraph(d);
    d.prepare("INSERT INTO usage_meta (k,v) VALUES ('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(USAGE_VERSION));
    return { built: true, rows: r.rows, tables: r.tables };
  } finally {
    d.close();
  }
}
