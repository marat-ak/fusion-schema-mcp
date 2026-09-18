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
 * Storage: `db().registries` (kind "usage").
 */
import { db, type UsageRegistryRow } from "../db/index.js";

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

/** (Re)build table_usages from report_queries.tables_used. */
export async function rebuildUsageGraph(): Promise<{ rows: number; tables: number }> {
  const rows = await db().corpus.rowsForUsage();

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

  const out: UsageRegistryRow[] = [];
  for (const [table, arr] of byTable) {
    arr.sort((a, b) => b.score - a.score);
    for (const u of arr.slice(0, MAX_USAGES_PER_TABLE)) {
      out.push({ table_name: table, query_id: u.id, source: u.source, title: u.title, sql_chars: u.sql_chars, score: u.score });
    }
  }
  const r = await db().registries.replaceAll("usage", out);
  return { rows: r.rows, tables: byTable.size };
}

/** Read the top real-query usages for a table (case-insensitive). `brief` omits SQL (auto-attach). */
export async function getTableUsages(
  table: string,
  opts: { limit?: number; brief?: boolean } = {},
): Promise<{ table: string; usageCount: number; usages: UsageDigest[] }> {
  const t = table.toUpperCase();
  const limit = Math.max(1, Math.min(opts.limit ?? 5, MAX_USAGES_PER_TABLE));
  const total = await db().registries.usageCount(t);
  const rows = await db().registries.usages(t, limit);

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

// Bump when the build logic / ranking changes so a redeploy rebuilds the index.
const USAGE_VERSION = 1;

/** Startup helper: (re)build table_usages when empty, the logic version changed, or force=true. */
export async function ensureUsageGraph(force = false): Promise<{ built: boolean; rows: number; tables: number }> {
  const ver = await db().registries.version("usage");
  const have = await db().registries.count("usage");
  if (have > 0 && ver === String(USAGE_VERSION) && !force) return { built: false, rows: have, tables: 0 };
  const r = await rebuildUsageGraph();
  await db().registries.setVersion("usage", String(USAGE_VERSION));
  return { built: true, rows: r.rows, tables: r.tables };
}
