/** Query layer over the catalog DB (typed CatalogProvider — no SQL here). Names normalized. */
import { db } from "./db/index.js";
import { embed } from "./corpus/embed.js";
import { textHash, getVecs, putVecs } from "./corpus/colCache.js";
import { classifyDomain, topDomain } from "./corpus/domain.js";
import { getTableGrain } from "./corpus/grainRegistry.js";
import { getTableUsages } from "./corpus/usageGraph.js";
import { getTableRules } from "./corpus/tableRules.js";
import { getTablePredicates } from "./corpus/predicateMiner.js";
import { normName, suggestNames } from "./util.js";

// In-memory table-name list for fuzzy did-you-mean (~30k strings, cheap): the provider's snapshot,
// materialized as an array once per snapshot instance.
let _namesArr: string[] = [];
let _namesSet: ReadonlySet<string> | null = null;
function nameSet(): ReadonlySet<string> { return db().schema.tableNames(); }
function allNames(): string[] {
  const s = nameSet();
  if (s !== _namesSet) { _namesSet = s; _namesArr = [...s]; }
  return _namesArr;
}

export async function stats() {
  return db().meta.stats();
}

function ftsSanitize(query: string): string[] {
  return (query.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toUpperCase());
}

export async function searchTables(query: string, limit = 20) {
  const tokens = ftsSanitize(query);
  if (tokens.length === 0) return [];
  // AND first (precise); fall back to OR if nothing matches.
  let rows = await db().schema.searchTables(tokens, "and", limit);
  if (rows.length === 0 && tokens.length > 1) rows = await db().schema.searchTables(tokens, "or", limit);
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    module: r.module,
    remarks: r.remarks,
  }));
}

export async function getTable(name: string) {
  const n = normName(name);
  const t = await db().schema.getTable(n);
  if (!t) return null;
  const pk = await db().schema.primaryKey(n);
  const cc = await db().schema.columnCount(n);
  return {
    name: t.name,
    schema: t.schema,
    type: t.type,
    module: t.module,
    remarks: t.remarks,
    viewText: t.view_text,
    primaryKey: pk,
    columnCount: cc,
    ...(await mostlyUsedStats(n)),
  };
}

export async function getColumns(table: string, opts?: { like?: string; limit?: number }) {
  const n = normName(table);
  if (!nameSet().has(n)) return { tableExists: false, columns: [] as any[] };
  const pk = new Set(await db().schema.primaryKey(n));
  let rows: any[] = await db().schema.columns(n);
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
  const res: any = { tableExists: true, totalColumns: total, returned: cols.length, columns: cols, ...(await mostlyUsedStats(n)) };
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
  if (!nameSet().has(n)) return { tableExists: false, columns: [] as any[] };
  const pk = new Set(await db().schema.primaryKey(n));
  const rows: any[] = await db().schema.columns(n);
  if (!rows.length) return { tableExists: true, totalColumns: 0, columns: [] };

  // Column text is static → cache its embedding by content hash; only embed cache misses + the query.
  const texts = rows.map((r) => `${r.name}: ${r.remarks ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 220));
  const hashes = texts.map(textHash);
  const cached = await getVecs(hashes);
  const missIdx = hashes.map((h, i) => (cached.has(h) ? -1 : i)).filter((i) => i >= 0);
  if (missIdx.length) {
    const fresh = await embed(missIdx.map((i) => texts[i]));
    const toStore: { hash: string; vec: Float32Array }[] = [];
    missIdx.forEach((i, k) => { cached.set(hashes[i], fresh[k]); toStore.push({ hash: hashes[i], vec: fresh[k] }); });
    await putVecs(toStore);
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

export async function validateTable(name: string) {
  const n = normName(name);
  if (nameSet().has(n)) {
    const t = (await db().schema.getTable(n))!;
    // Pushed payload = corpus statistics only (user directive): mostlyUsedFilters/mostlyUsedJoinFilters +
    // brief real-usage examples. Grain classification + curated rules stay PULL-only via getTableGrain.
    const usages = (await tableUsages(t.name, { limit: 3, brief: true })).usages;
    return {
      exists: true,
      table: { name: t.name, type: t.type, module: t.module, remarks: t.remarks },
      ...(await mostlyUsedStats(t.name)),
      ...(usages.length ? { topUsages: usages } : {}),
      suggestions: [] as string[],
    };
  }
  return { exists: false, table: null, suggestions: suggestNames(n, allNames(), 5) };
}

/** Grain hint for a table (case-insensitive) — reads the table_grain registry, then folds in curated
 *  rules (curated OVERRIDES derived). So a human-recorded fact (e.g. dedup by submitted_flag='Y')
 *  surfaces on both validateTable and getTableGrain without those callers knowing about curation. */
export async function grainFor(name: string): Promise<any> {
  let g: any;
  try { g = await getTableGrain(name); } catch { return null; }
  if (!g) return null;
  const rules = await getTableRules(name);
  if (rules.length) {
    const gr = rules.find((r) => r.kind === "grain");
    if (gr) {
      g = {
        ...g,
        grain: gr.grain ?? g.grain,
        dedup: gr.dedup ?? g.dedup,
        multiRow: gr.grain ? gr.grain !== "single_row" : g.multiRow,
        note: (gr.body ? gr.body + " " : "") + (g.note ?? "") + ` [curated grain by ${gr.author}]`,
        curated: true,
      };
    }
    g.curatedRules = rules.map((r) => ({
      kind: r.kind, column: r.column, grain: r.grain, dedup: r.dedup, body: r.body, author: r.author, source: r.source,
    }));
  }
  // Most-used hardcoded filters for this table (structural = always-apply, discriminator = pick-by-intent).
  const p = await getTablePredicates(name);
  if (p.structural.length || p.discriminator.length) g.commonPredicates = p;
  return g;
}

/** Corpus usage statistics pushed with EVERY table payload (getTable/getColumns/validateColumns/
 *  validateTable): what real queries FILTER this table by (mostlyUsedFilters, from x_predicates rolled up
 *  at import — no skip-lists, counts per canonical query) and which of its columns participate in JOIN
 *  conditions (mostlyUsedJoinFilters, column-participation share — the model picks the paired field).
 *  The agent contract: apply each hint, ask the user, or say why not — never silently ignore. */
export async function mostlyUsedStats(name: string) {
  const n = normName(name);
  const out: any = {};
  const f = await db().registries.topPredicates(n, 8);
  if (f.length) out.mostlyUsedFilters = f;
  const j = await db().corpus.joinColumnStats(n, 8);
  if (j.length) out.mostlyUsedJoinFilters = j;
  return out;
}

/** Top real-query usages of a table (table-anchored retrieval — the complement to the intent-anchored
 *  findSimilarQueries). Lets the agent adopt real join/filter idioms, incl. from bip/view sources that
 *  have no structured predicates/joins extracted. `brief` omits SQL (for auto-attach). */
export async function tableUsages(name: string, opts: { limit?: number; brief?: boolean } = {}) {
  try { return await getTableUsages(name, opts); } catch { return { table: normName(name), usageCount: 0, usages: [] }; }
}

export async function validateColumns(table: string, columns: string[]) {
  const n = normName(table);
  const tableExists = nameSet().has(n);
  if (!tableExists) {
    return {
      table: n,
      tableExists: false,
      tableSuggestions: suggestNames(n, allNames(), 5),
      results: [] as any[],
    };
  }
  const cols = await db().schema.columns(n);
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
  // PUSH the grain + most-used-filter knowledge on the tool the agent ALWAYS calls (validateTable already
  // does this; the customer-A requirements-doc session showed agents validate columns without ever calling validateTable —
  // and shipped DOO_HEADERS_ALL without its SUBMITTED_FLAG='Y' revision dedup as a result).
  // pushed payload carries ONLY corpus statistics (user directive) — grain/curated stay pull-only
  // via the explicit getTableGrain tool.
  return {
    table: n,
    tableExists: true,
    results,
    ...(await mostlyUsedStats(n)),
  };
}

export async function getIndexes(table: string) {
  const n = normName(table);
  if (!nameSet().has(n)) return { tableExists: false, indexes: [] as any[] };
  const rows = await db().schema.indexes(n);
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

export async function getRelatedTables(table: string) {
  const n = normName(table);
  if (!nameSet().has(n)) {
    return { tableExists: false, suggestions: suggestNames(n, allNames(), 5), related: [] as any[] };
  }
  const out: any[] = [];
  const fk = await db().schema.fkeys(n);
  for (const r of fk.out) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "outgoing",
      source: "declared",
      name: r.name,
    });
  }
  for (const r of fk.in) {
    out.push({
      relatedTable: r.other,
      fromColumn: r.col,
      toColumn: r.col,
      direction: "incoming",
      source: "declared",
      name: r.name,
    });
  }
  const rel = await db().schema.relationships(n);
  for (const r of rel.from) {
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
  for (const r of rel.to) {
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
    // TEI rejects client batches over its --max-client-batch-size (default 32) with a 4xx — chunk
    // the candidate list and merge the scored chunks (scores are query-relative, so comparable).
    const CHUNK = Number(process.env.RERANK_MAX_BATCH ?? 32);
    const scored: { index: number; score: number }[] = [];
    for (let off = 0; off < texts.length; off += CHUNK) {
      const slice = texts.slice(off, off + CHUNK);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Number(process.env.RERANK_TIMEOUT_MS ?? 1500));
      const res = await fetch(`${url.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: intent, texts: slice, raw_scores: false }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return rows;
      const part = (await res.json()) as { index: number; score: number }[];
      if (!Array.isArray(part)) return rows;
      for (const s of part) scored.push({ index: s.index + off, score: s.score });
    }
    if (!scored.length) return rows;
    const order = scored.sort((a, b) => b.score - a.score).map((s) => s.index);
    const seen = new Set(order);
    return [...order.map((i) => rows[i]), ...rows.filter((_r, i) => !seen.has(i))];
  } catch {
    return rows;
  }
}

/** Full SQL only when it is small enough to be worth inlining; big ones ship mechanics instead. */
const CLEAN_SQL_INLINE_CAP = Number(process.env.CLEAN_SQL_INLINE_CAP ?? 6000);
function sqlPayload(cleanSql: string | null): { cleanSql?: string; cleanSqlOmitted?: true; sqlChars?: number; fetchWith?: string } {
  if (!cleanSql) return {};
  if (cleanSql.length <= CLEAN_SQL_INLINE_CAP) return { cleanSql };
  // Big report: don't inline (would flood context) but make the SQL FETCHABLE — the caller pulls the
  // full text by this match's id. Mechanics alone is NOT enough to adopt/adapt a large report.
  return { cleanSqlOmitted: true, sqlChars: cleanSql.length, fetchWith: "getReportQuery(id) for the full SQL" };
}

// If the top matches split across >=2 business domains whose best scores are within this margin,
// the request is treated as domain-ambiguous and full SQL is WITHHELD until a domain is chosen.
const DOMAIN_AMBIGUITY_MARGIN = 0.10;

// Table -> Fusion application module (tables.module = META_TABLES.APPLICATION_SHORT_NAME).
// Authoritative signal for classifyDomain; cached per process. Resolved through the async API up
// front for every candidate table, then read synchronously by classifyDomain.
const _moduleCache = new Map<string, string | undefined>();
async function resolveModules(tables: Iterable<string>): Promise<void> {
  for (const t of tables) {
    const n = normName(t);
    if (!_moduleCache.has(n)) _moduleCache.set(n, await db().schema.moduleOf(n));
  }
}
function moduleOf(table: string): string | undefined {
  return _moduleCache.get(normName(table));
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
  const K = Math.max(limit * 6, 24); // overfetch so we can classify + domain-filter
  // Prefer the multi-vector index (per-intent phrasings) once populated; dedup phrasing hits by
  // query row keeping the BEST distance. Fall back to the legacy 1-vector index when empty.
  let rawRows: any[];
  const useMulti = await db().corpus.hasMultiVectors();
  if (useMulti) {
    const KM = K * 3; // several phrasings of the same query may occupy top slots
    const hits = await db().corpus.knn(vec, KM, { source: opts.source, multi: true });
    const seen = new Map<number, any>();
    for (const h of hits) if (!seen.has(h.qrid!)) seen.set(h.qrid!, h);
    rawRows = [...seen.values()].slice(0, K);
  } else {
    rawRows = await db().corpus.knn(vec, K, { source: opts.source });
  }

  const parsed = rawRows.map((r) => ({ r, tablesUsed: JSON.parse(r.tables_used ?? "[]") as string[] }));
  await resolveModules(parsed.flatMap((x) => x.tablesUsed));
  let enriched = parsed.map(({ r, tablesUsed }) => ({
    id: r.id, source: r.source, title: r.title, description: r.description,
    cleanSql: r.clean_sql, tablesUsed,
    joins: JSON.parse(r.joins ?? "[]"),
    filters: JSON.parse(r.filters ?? "[]"),
    lookupTypes: JSON.parse(r.lookup_types ?? "[]"),
    intents: JSON.parse(r.intents ?? "[]"),
    mechanics: r.mechanics ?? null,
    score: 1 - (r.distance * r.distance) / 2,
    domain: classifyDomain(tablesUsed, r.title, moduleOf),
  }));
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

/** Exact query by TITLE or by ID. Title -> the MAIN (largest) dataset of that .xdm + a `datasets`
 *  list of sibling datasets (fetch each by id). Id -> that exact row, at FULL size (this is how the
 *  caller pulls the SQL that findSimilarQueries omitted for being large — it returns the match's id). */
export async function getReportQuery(arg: string) {
  const isId = /^(sql:|view:)/.test(arg);
  const r = isId ? await db().corpus.byId(arg) : await db().corpus.byTitle(arg);
  if (!r) {
    const suggestions = isId ? [] : await db().corpus.nearTitles(`%${arg}%`);
    return { found: false, suggestions };
  }
  // when a title has multiple datasets, expose the others so nothing stays hidden
  const sibs = isId ? [] : (await db().corpus.siblings(r.title)).filter((x) => x.id !== r.id);
  return {
    found: true, id: r.id, source: r.source, title: r.title,
    originalSql: r.original_sql, cleanSql: r.clean_sql, description: r.description,
    tablesUsed: JSON.parse(r.tables_used ?? "[]"),
    joins: JSON.parse(r.joins ?? "[]"),
    filters: JSON.parse(r.filters ?? "[]"),
    lookupTypes: JSON.parse(r.lookup_types ?? "[]"),
    securityPredicate: r.security_predicate,
    ...(sibs.length
      ? { datasets: sibs.map((s) => ({ id: s.id, sqlChars: s.sqlChars, description: s.description })),
          note: `This .xdm has ${sibs.length + 1} datasets; returned the largest. Fetch another with getReportQuery(id).` }
      : {}),
  };
}

/** All report queries under a subject area (OTBI). Matches "<area>.*" then falls back to "<area>%". */
export async function listQueriesForSubjectArea(area: string, limit = 100) {
  let rows = await db().corpus.byTitlePrefix(`${area}.%`, limit);
  if (rows.length === 0) rows = await db().corpus.byTitlePrefix(`${area}%`, limit);
  return rows.map((r) => ({ id: r.id, source: r.source, title: r.title, description: r.description }));
}
