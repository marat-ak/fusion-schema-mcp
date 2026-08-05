/** Query layer over the split DBs (reports.sqlite main + schema.sqlite attached). Names normalized. */
import fs from "node:fs";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed } from "./corpus/embed.js";
import { textHash, getVecs, putVecs } from "./corpus/colCache.js";
import { classifyDomain, topDomain } from "./corpus/domain.js";
import { normName, suggestNames } from "./util.js";
import { reportsDbPath, schemaDbPath, isSingleFile, sqlQuote } from "./dbPaths.js";

// SPLIT DBs: the read layer opens reports.sqlite as the MAIN connection (so the sqlite-vec `vec0`
// KNN over report_queries_vec runs on a native, non-attached DB — vec0 KNN is unreliable over an
// ATTACHed database) and ATTACHes schema.sqlite. Table names are unique across the two files, so
// unqualified queries (FROM tables / FROM report_queries / FROM meta) resolve unchanged. When a
// legacy single catalog.sqlite is in play (isSingleFile), both paths resolve to it and we skip the
// ATTACH (every table already lives in main).
const REPORTS_PATH = reportsDbPath();
const SCHEMA_PATH = schemaDbPath();

if (!fs.existsSync(REPORTS_PATH)) {
  throw new Error(
    `reports DB not found at ${REPORTS_PATH}. Provision or migrate first ` +
      `(node dist/provision.js / node dist/migrate-split.js), or set CATALOG_DB to a legacy catalog.sqlite.`,
  );
}

const db = new Database(REPORTS_PATH, { readonly: true, fileMustExist: true });
if (!isSingleFile()) {
  db.exec(`ATTACH DATABASE '${sqlQuote(SCHEMA_PATH)}' AS schemadb`);
}
db.pragma("query_only = true");

// In-memory table-name list for fuzzy did-you-mean (~30k strings, cheap).
const ALL_NAMES: string[] = db
  .prepare("SELECT name FROM tables")
  .all()
  .map((r: any) => r.name as string);
const NAME_SET = new Set(ALL_NAMES);

export function stats() {
  const rows = db.prepare("SELECT key, value FROM meta").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---- prepared statements ----
const qTable = db.prepare(
  "SELECT name, schema, type, module, remarks, view_text FROM tables WHERE name = ?",
);
const qPk = db.prepare(
  "SELECT column_name FROM pkeys WHERE table_name = ? ORDER BY seq",
);
const qColCount = db.prepare(
  "SELECT COUNT(*) AS n FROM columns WHERE table_name = ?",
);
const qColumns = db.prepare(
  `SELECT name, data_type, size, nullable, remarks, ordinal
   FROM columns WHERE table_name = ? ORDER BY ordinal`,
);
const qIndexes = db.prepare(
  `SELECT index_name, is_unique, ordinal, column_name
   FROM indexes WHERE table_name = ? ORDER BY index_name, ordinal`,
);
const qFkOut = db.prepare(
  `SELECT parent_table AS other, column_name AS col, name FROM fkeys WHERE child_table = ?`,
);
const qFkIn = db.prepare(
  `SELECT child_table AS other, column_name AS col, name FROM fkeys WHERE parent_table = ?`,
);
const qRelFrom = db.prepare(
  `SELECT to_table AS other, from_col, to_col, evidence, occurrences, confidence
   FROM relationships WHERE from_table = ?`,
);
const qRelTo = db.prepare(
  `SELECT from_table AS other, from_col, to_col, evidence, occurrences, confidence
   FROM relationships WHERE to_table = ?`,
);

function ftsSanitize(query: string): string[] {
  return (query.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toUpperCase());
}

export function searchTables(query: string, limit = 20) {
  const tokens = ftsSanitize(query);
  if (tokens.length === 0) return [];
  const run = (join: string) => {
    // tokens are pure [A-Za-z0-9_], safe as bareword prefix queries
    const match = tokens.map((t) => `${t}*`).join(join);
    return db
      .prepare(
        `SELECT t.name, t.type, t.module, t.remarks
         FROM tables_fts f JOIN tables t ON t.rowid = f.rowid
         WHERE tables_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as any[];
  };
  // AND first (precise); fall back to OR if nothing matches.
  let rows = run(" AND ");
  if (rows.length === 0 && tokens.length > 1) rows = run(" OR ");
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    module: r.module,
    remarks: r.remarks,
  }));
}

export function getTable(name: string) {
  const n = normName(name);
  const t = qTable.get(n) as any;
  if (!t) return null;
  const pk = (qPk.all(n) as any[]).map((r) => r.column_name);
  const cc = (qColCount.get(n) as any).n as number;
  return {
    name: t.name,
    schema: t.schema,
    type: t.type,
    module: t.module,
    remarks: t.remarks,
    viewText: t.view_text,
    primaryKey: pk,
    columnCount: cc,
  };
}

export function getColumns(table: string, opts?: { like?: string; limit?: number }) {
  const n = normName(table);
  if (!NAME_SET.has(n)) return { tableExists: false, columns: [] as any[] };
  const pk = new Set((qPk.all(n) as any[]).map((r) => r.column_name));
  let rows = qColumns.all(n) as any[];
  const total = rows.length;
  if (opts?.like) {
    const p = opts.like.toUpperCase();
    rows = rows.filter((r) => String(r.name).toUpperCase().includes(p));
  }
  // Wide Fusion tables (e.g. AP_INVOICES_ALL ~150 cols) with full remarks produce a huge payload
  // that can overflow the stream/context — cap the count and truncate remarks.
  const cap = Math.max(1, Math.min(opts?.limit ?? 120, 400));
  const shown = rows.length;
  const truncated = rows.length > cap;
  if (truncated) rows = rows.slice(0, cap);
  const cols = rows.map((r) => ({
    name: r.name,
    dataType: r.data_type,
    size: r.size,
    nullable: r.nullable === 1,
    remarks: r.remarks ? String(r.remarks).replace(/\s+/g, " ").trim().slice(0, 140) : null,
    ordinal: r.ordinal,
    isPrimaryKey: pk.has(r.name),
  }));
  const res: any = { tableExists: true, totalColumns: total, returned: cols.length, columns: cols };
  if (truncated) {
    res.note = `Showing ${cols.length} of ${shown}${opts?.like ? ` matching '${opts.like}'` : ""} (table has ${total} columns). ` +
      `Refine with getColumns(table, {like:'...'}), searchColumns for a concept, or validateColumns(table, [...]).`;
  }
  return res;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * Semantic column search within ONE table: embeds each column's "NAME: remarks" and ranks by
 * cosine to the query intent (e.g. "amount owed to the supplier" → GROSS_AMOUNT, AMOUNT_PAID,
 * BALANCING_AMOUNT...). Better than a name substring because it uses the column DESCRIPTIONS too.
 * Embeds on the fly (no precompute) — bounded to the table's columns.
 */
export async function searchColumns(table: string, query: string, limit = 20) {
  const n = normName(table);
  if (!NAME_SET.has(n)) return { tableExists: false, columns: [] as any[] };
  const pk = new Set((qPk.all(n) as any[]).map((r) => r.column_name));
  const rows = qColumns.all(n) as any[];
  if (!rows.length) return { tableExists: true, totalColumns: 0, columns: [] };

  // Column text is static → cache its embedding by content hash; only embed cache misses + the query.
  const texts = rows.map((r) => `${r.name}: ${r.remarks ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 220));
  const hashes = texts.map(textHash);
  const cached = getVecs(hashes);
  const missIdx = hashes.map((h, i) => (cached.has(h) ? -1 : i)).filter((i) => i >= 0);
  if (missIdx.length) {
    const fresh = await embed(missIdx.map((i) => texts[i]));
    const toStore: { hash: string; vec: Float32Array }[] = [];
    missIdx.forEach((i, k) => { cached.set(hashes[i], fresh[k]); toStore.push({ hash: hashes[i], vec: fresh[k] }); });
    putVecs(toStore);
  }
  const qv = (await embed([query]))[0];
  const scored = rows
    .map((r, i) => ({ r, s: cosine(qv, cached.get(hashes[i])!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, Math.min(limit, 100)));
  const columns = scored.map(({ r, s }) => ({
    name: r.name,
    dataType: r.data_type,
    size: r.size,
    nullable: r.nullable === 1,
    remarks: r.remarks ? String(r.remarks).replace(/\s+/g, " ").trim().slice(0, 140) : null,
    isPrimaryKey: pk.has(r.name),
    score: Number(s.toFixed(3)),
  }));
  return { tableExists: true, totalColumns: rows.length, query, columns };
}

export function validateTable(name: string) {
  const n = normName(name);
  if (NAME_SET.has(n)) {
    const t = qTable.get(n) as any;
    return {
      exists: true,
      table: { name: t.name, type: t.type, module: t.module, remarks: t.remarks },
      suggestions: [] as string[],
    };
  }
  return { exists: false, table: null, suggestions: suggestNames(n, ALL_NAMES, 5) };
}

export function validateColumns(table: string, columns: string[]) {
  const n = normName(table);
  const tableExists = NAME_SET.has(n);
  if (!tableExists) {
    return {
      table: n,
      tableExists: false,
      tableSuggestions: suggestNames(n, ALL_NAMES, 5),
      results: [] as any[],
    };
  }
  const cols = qColumns.all(n) as any[];
  const colNames = cols.map((c) => c.name as string);
  const colSet = new Set(colNames);
  const results = columns.map((raw) => {
    const c = (raw ?? "").trim().toUpperCase();
    const exists = colSet.has(c);
    return {
      column: c,
      exists,
      suggestions: exists ? [] : suggestNames(c, colNames, 5),
    };
  });
  return { table: n, tableExists: true, results };
}

export function getIndexes(table: string) {
  const n = normName(table);
  if (!NAME_SET.has(n)) return { tableExists: false, indexes: [] as any[] };
  const rows = qIndexes.all(n) as any[];
  const byName = new Map<string, { indexName: string; unique: boolean; columns: string[] }>();
  for (const r of rows) {
    let e = byName.get(r.index_name);
    if (!e) {
      e = { indexName: r.index_name, unique: r.is_unique === 1, columns: [] };
      byName.set(r.index_name, e);
    }
    if (r.column_name) e.columns.push(r.column_name);
  }
  return { tableExists: true, indexes: [...byName.values()] };
}

const CONF_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function getRelatedTables(table: string) {
  const n = normName(table);
  if (!NAME_SET.has(n)) {
    return { tableExists: false, suggestions: suggestNames(n, ALL_NAMES, 5), related: [] as any[] };
  }
  const out: any[] = [];
  for (const r of qFkOut.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "outgoing",
      source: "declared",
      name: r.name,
    });
  }
  for (const r of qFkIn.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "incoming",
      source: "declared",
      name: r.name,
    });
  }
  for (const r of qRelFrom.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.from_col,
      toColumn: r.to_col,
      direction: "outgoing",
      source: "mined",
      evidence: r.evidence,
      occurrences: r.occurrences,
      confidence: r.confidence,
    });
  }
  for (const r of qRelTo.all(n) as any[]) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.to_col,
      toColumn: r.from_col,
      direction: "incoming",
      source: "mined",
      evidence: r.evidence,
      occurrences: r.occurrences,
      confidence: r.confidence,
    });
  }
  // declared first, then mined by confidence then occurrences
  out.sort((a, b) => {
    if (a.source !== b.source) return a.source === "declared" ? -1 : 1;
    const cr = (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3);
    if (cr !== 0) return cr;
    return (b.occurrences ?? 0) - (a.occurrences ?? 0);
  });
  return { tableExists: true, related: out };
}

const SRC_OVERFETCH = 40;
const RQ_COLS = `rq.id, rq.source, rq.title, rq.description, rq.clean_sql,
                rq.tables_used, rq.joins, rq.filters, rq.lookup_types,
                rq.intents, rq.mechanics`;
let _vecStmts: { qVec: any; qVecSrc: any; qMulti: any; qMultiSrc: any; multiCount: any } | null = null;
function vecStmts() {
  if (!_vecStmts) {
    loadVec(db);
    _vecStmts = {
      qVec: db.prepare(
        `SELECT ${RQ_COLS}, v.distance AS distance
         FROM report_queries_vec v
         JOIN report_queries rq ON rq.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`),
      qVecSrc: db.prepare(
        `SELECT ${RQ_COLS}, v.distance AS distance
         FROM report_queries_vec v
         JOIN report_queries rq ON rq.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND rq.source = ?
         ORDER BY v.distance
         LIMIT ?`),
      // multi-vector KNN: one vec row per intent PHRASING -> dedup by query row in JS.
      // NB: the KNN must live in a bare subquery — joining/filtering the vec0 aux column inside
      // the KNN query itself is an "illegal WHERE constraint" for sqlite-vec.
      // the inner LIMIT (same value as k) blocks SQLite's subquery flattening, which would
      // otherwise push the JOIN constraint into vec0 and fail ("illegal WHERE constraint").
      qMulti: db.prepare(
        `SELECT ${RQ_COLS}, rq.rowid AS qrid, v.distance AS distance
         FROM (SELECT qrowid, distance FROM report_queries_vec_multi
               WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
         JOIN report_queries rq ON rq.rowid = v.qrowid
         ORDER BY v.distance`),
      qMultiSrc: db.prepare(
        `SELECT ${RQ_COLS}, rq.rowid AS qrid, v.distance AS distance
         FROM (SELECT qrowid, distance FROM report_queries_vec_multi
               WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
         JOIN report_queries rq ON rq.rowid = v.qrowid
         WHERE rq.source = ?
         ORDER BY v.distance
         LIMIT ?`),
      multiCount: db.prepare("SELECT COUNT(*) AS c FROM report_queries_vec_multi"),
    };
  }
  return _vecStmts;
}

/**
 * Two-stage retrieval: cross-encoder rerank of the KNN overfetch via a TEI sidecar (/rerank).
 * Candidate text = title + description + intents (short, what cross-encoders score best on).
 * Fail-open: no RERANK_URL, timeout (1.5s) or any error -> return rows in KNN order unchanged.
 */
async function rerank<T extends { title: string; description: string; intents?: string[] }>(intent: string, rows: T[]): Promise<T[]> {
  const url = (process.env.RERANK_URL ?? "").trim();
  if (!url || rows.length < 3) return rows;
  try {
    const texts = rows.map((r) =>
      `${r.title}\n${r.description}\n${(r.intents ?? []).join("; ")}`.slice(0, 2000));
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(process.env.RERANK_TIMEOUT_MS ?? 1500));
    const res = await fetch(`${url.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: intent, texts, raw_scores: false }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return rows;
    const scores = (await res.json()) as { index: number; score: number }[];
    if (!Array.isArray(scores) || !scores.length) return rows;
    const order = [...scores].sort((a, b) => b.score - a.score).map((s) => s.index);
    const seen = new Set(order);
    return [...order.map((i) => rows[i]), ...rows.filter((_r, i) => !seen.has(i))];
  } catch {
    return rows;
  }
}

/** Full SQL only when it is small enough to be worth inlining; big ones ship mechanics instead. */
const CLEAN_SQL_INLINE_CAP = Number(process.env.CLEAN_SQL_INLINE_CAP ?? 6000);
function sqlPayload(cleanSql: string | null): { cleanSql?: string; cleanSqlOmitted?: true; sqlChars?: number } {
  if (!cleanSql) return {};
  if (cleanSql.length <= CLEAN_SQL_INLINE_CAP) return { cleanSql };
  return { cleanSqlOmitted: true, sqlChars: cleanSql.length };
}

// If the top matches split across >=2 business domains whose best scores are within this margin,
// the request is treated as domain-ambiguous and full SQL is WITHHELD until a domain is chosen.
const DOMAIN_AMBIGUITY_MARGIN = 0.10;

// Table -> Fusion application module (tables.module = META_TABLES.APPLICATION_SHORT_NAME).
// Authoritative signal for classifyDomain; cached per process.
let _qModule: any = null;
const _moduleCache = new Map<string, string | undefined>();
function moduleOf(table: string): string | undefined {
  if (_moduleCache.has(table)) return _moduleCache.get(table);
  _qModule ??= db.prepare("SELECT module FROM tables WHERE name = ?");
  const mod = (_qModule.get(normName(table)) as any)?.module ?? undefined;
  _moduleCache.set(table, mod);
  return mod;
}

// domain-filter matching: want "Financials" hits all Financials/*, want "AP" or
// "Financials/AP" hits only that sub-domain.
function domainMatches(key: string, want: string): boolean {
  const k = key.toLowerCase(), w = want.toLowerCase();
  const [kTop, kSub] = k.split("/");
  return k === w || kTop === w || (kSub !== undefined && kSub === w);
}

function buildBreakdown(items: { domain: string; score: number }[], keyFn: (d: string) => string) {
  const agg: Record<string, { count: number; topScore: number }> = {};
  for (const m of items) {
    const key = keyFn(m.domain);
    const d = (agg[key] ??= { count: 0, topScore: 0 });
    d.count++; d.topScore = Math.max(d.topScore, m.score);
  }
  return Object.entries(agg)
    .map(([domain, v]) => ({ domain, count: v.count, topScore: +v.topScore.toFixed(3) }))
    .sort((a, b) => b.topScore - a.topScore);
}

const isTied = (b: { topScore: number }[]) =>
  b.length >= 2 && b[0].topScore - b[1].topScore <= DOMAIN_AMBIGUITY_MARGIN;

/**
 * Domain-aware few-shot retrieval. Classifies each match into a business-domain key
 * (`HCM`, `Procurement`, ... or `Financials/<sub-ledger>` e.g. Financials/AP vs Financials/AR).
 * Behaviour:
 *  - `domain` given  -> return that domain's matches WITH full cleanSql (targeted second call).
 *    Accepts a top level ("Financials"), a sub-domain ("AP"), or the full key ("Financials/AP").
 *  - matches agree on one domain key -> return matches WITH cleanSql (unambiguous).
 *  - matches split across >=2 near-tied TOP-LEVEL domains (department: HCM vs Financials), or
 *    across >=2 near-tied SUB-domains within one domain (invoice: Financials/AP vs Financials/AR)
 *    -> return { ambiguous:true, domainBreakdown, candidates } with NO cleanSql, forcing the
 *    agent to disambiguate before it can copy any SQL.
 */
export async function findSimilarQueries(
  intent: string, opts: { source?: string; domain?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 5;
  const [vec] = await embed([intent]);
  const blob = Buffer.from(vec.buffer);
  const { qVec, qVecSrc, qMulti, qMultiSrc, multiCount } = vecStmts();
  const K = Math.max(limit * 6, 24); // overfetch so we can classify + domain-filter
  // Prefer the multi-vector index (per-intent phrasings) once populated; dedup phrasing hits by
  // query row keeping the BEST distance. Fall back to the legacy 1-vector index when empty.
  let rawRows: any[];
  const useMulti = ((multiCount.get() as any)?.c ?? 0) > 0;
  if (useMulti) {
    const KM = K * 3; // several phrasings of the same query may occupy top slots
    const hits = (opts.source ? qMultiSrc.all(blob, KM, opts.source, KM) : qMulti.all(blob, KM)) as any[];
    const seen = new Map<number, any>();
    for (const h of hits) if (!seen.has(h.qrid)) seen.set(h.qrid, h);
    rawRows = [...seen.values()].slice(0, K);
  } else {
    rawRows = (opts.source ? qVecSrc.all(blob, K, opts.source, K) : qVec.all(blob, K)) as any[];
  }

  let enriched = rawRows.map((r) => {
    const tablesUsed = JSON.parse(r.tables_used ?? "[]");
    return {
      id: r.id, source: r.source, title: r.title, description: r.description,
      cleanSql: r.clean_sql, tablesUsed,
      joins: JSON.parse(r.joins ?? "[]"),
      filters: JSON.parse(r.filters ?? "[]"),
      lookupTypes: JSON.parse(r.lookup_types ?? "[]"),
      intents: JSON.parse(r.intents ?? "[]"),
      mechanics: r.mechanics ?? null,
      score: 1 - (r.distance * r.distance) / 2,
      domain: classifyDomain(tablesUsed, r.title, moduleOf),
    };
  });
  // two-stage: cross-encoder reorders the overfetch before domain logic + slicing (fail-open)
  enriched = await rerank(intent, enriched);

  // mechanics-first payload: the once-analyzed playbook always ships; full SQL only when small
  // (large exemplars: read mechanics, then getReportQuery(title) for the verbatim SQL if needed).
  const toMatch = (m: any) => ({
    id: m.id, source: m.source, title: m.title, description: m.description,
    mechanics: m.mechanics, tablesUsed: m.tablesUsed, joins: m.joins, filters: m.filters,
    lookupTypes: m.lookupTypes, domain: m.domain, score: +m.score.toFixed(3),
    ...sqlPayload(m.cleanSql),
  });

  // Targeted second call: caller already resolved the domain -> full examples for that domain.
  if (opts.domain) {
    const matches = enriched.filter((m) => domainMatches(m.domain, opts.domain!)).slice(0, limit).map(toMatch);
    return { ambiguous: false, domain: opts.domain, matches };
  }

  const window = enriched.slice(0, Math.max(limit + 3, 8));

  // Stage 1: top-level split (cross-domain ambiguity, e.g. HCM vs Financials).
  let domainBreakdown = buildBreakdown(window, topDomain);
  let ambiguous = isTied(domainBreakdown);

  // Stage 2: single top-level domain, but sub-domains split (e.g. Financials/AP vs Financials/AR).
  // Bare keys without a sub (title-fallback classifications) don't create a split.
  if (!ambiguous) {
    const subBreakdown = buildBreakdown(
      window.filter((m) => m.domain.includes("/") && topDomain(m.domain) === domainBreakdown[0]?.domain),
      (d) => d);
    if (isTied(subBreakdown)) { ambiguous = true; domainBreakdown = subBreakdown; }
  }

  if (ambiguous) {
    return {
      ambiguous: true,
      domainBreakdown,
      guidance:
        `Closest real reports span ${domainBreakdown.length} business domains — ` +
        domainBreakdown.map((b) => `${b.domain} (${b.topScore})`).join(", ") + ". " +
        "SQL is withheld until you resolve this. If these are two readings of the SAME term " +
        "(e.g. 'invoice' = AP supplier invoice vs AR customer invoice), ASK the user which domain " +
        "and DO NOT emit SQL this turn. If different parts of the request genuinely need different " +
        "domains, call findSimilarQueries once per domain and combine. To get the full example SQL, " +
        "call findSimilarQueries again with domain=<one of the domains above>.",
      // candidates carry titles/tables but NO cleanSql — nothing to copy until a domain is chosen
      candidates: window.map((m) => ({
        domain: m.domain, source: m.source, title: m.title,
        description: m.description, tablesUsed: m.tablesUsed, score: +m.score.toFixed(3),
      })),
    };
  }

  return {
    ambiguous: false,
    domain: domainBreakdown[0]?.domain,
    matches: enriched.slice(0, limit).map(toMatch),
  };
}

// ---- exact report-query lookup (by title / subject area) ----
// Lazily prepared so an un-migrated catalog.sqlite (no report_queries) doesn't crash
// the whole server at import — same pattern as vecStmts().
let _rqStmts: { byTitle: any; byArea: any; near: any } | null = null;
function rqStmts() {
  if (!_rqStmts) {
    _rqStmts = {
      byTitle: db.prepare(
        `SELECT id, source, title, original_sql, clean_sql, description,
                tables_used, joins, filters, lookup_types, security_predicate
         FROM report_queries WHERE title = ?`),
      byArea: db.prepare(
        `SELECT id, source, title, description FROM report_queries
         WHERE title LIKE ? ORDER BY title LIMIT ?`),
      near: db.prepare(
        `SELECT title FROM report_queries WHERE title LIKE ? ORDER BY title LIMIT 8`),
    };
  }
  return _rqStmts;
}

/** Exact query behind a title (OTBI title = "subjectArea.table"). Returns original + clean SQL. */
export function getReportQuery(title: string) {
  const { byTitle, near } = rqStmts();
  const r = byTitle.get(title) as any;
  if (!r) {
    const suggestions = (near.all(`%${title}%`) as any[]).map((x) => x.title);
    return { found: false, suggestions };
  }
  return {
    found: true, id: r.id, source: r.source, title: r.title,
    originalSql: r.original_sql, cleanSql: r.clean_sql, description: r.description,
    tablesUsed: JSON.parse(r.tables_used ?? "[]"),
    joins: JSON.parse(r.joins ?? "[]"),
    filters: JSON.parse(r.filters ?? "[]"),
    lookupTypes: JSON.parse(r.lookup_types ?? "[]"),
    securityPredicate: r.security_predicate,
  };
}

/** All report queries under a subject area (OTBI). Matches "<area>.*" then falls back to "<area>%". */
export function listQueriesForSubjectArea(area: string, limit = 100) {
  const { byArea } = rqStmts();
  let rows = byArea.all(`${area}.%`, limit) as any[];
  if (rows.length === 0) rows = byArea.all(`${area}%`, limit) as any[];
  return rows.map((r) => ({ id: r.id, source: r.source, title: r.title, description: r.description }));
}
