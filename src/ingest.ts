/**
 * REST ingest API — DECOUPLED, STAGED pipeline feeding the report-SQL corpus (report_queries +
 * report_queries_vec in catalog.sqlite) at runtime, without touching the MCP transport.
 *
 *   [1] STAGE      POST /ingest — accept the EXACT ready_catalog JSON shape and land each SQL as a
 *                  PENDING staging row (enrich.sqlite). No model call → fast + non-blocking. NOT
 *                  searchable yet.
 *   [2] ENRICH     A background worker (periodic + POST /ingest/enrich) picks PENDING rows and calls
 *                  the provider adapter (enrichAdapters.enrichOne) → { description, tablesUsed,
 *                  lookupTypes }, sized by ENRICH_CONCURRENCY. Failures stay pending (no regex fallback).
 *   [3] MATERIALIZE (after enrich, + POST /ingest/materialize) — newly-ENRICHED rows not yet in
 *                  report_queries are embedded (local bge-small) and inserted → searchable.
 *
 * ready_catalog JSON shape (matches the "catalog" source in src/corpus/sources.ts). The request body
 * is EITHER a single report object, an ARRAY of them, or { "items": [ ... ] }. Each report object:
 *   {
 *     "path"?:       string,     // report path — preferred title (poller also sends "reportPath")
 *     "name"?:       string,     // fallback title
 *     "title"?:      string,     // explicit title (highest precedence)
 *     "sqls":        (string | { "text": string, "hash"?: string })[]   // REQUIRED, non-empty
 *   }
 * Title precedence: title > path > reportPath > name. Each SQL is staged under a stable id
 * `catalog:<title-or-hash>[#i]`, so re-pushing the same report REPLACES its rows (hash-dedup in
 * enrichStore invalidates enrichment when the SQL text changes).
 *
 * Endpoints (all /ingest/* require Authorization: Bearer <INGEST_TOKEN>; unset ⇒ open + startup warn):
 *   POST /ingest             stage a ready_catalog payload (PENDING).
 *   POST /ingest/extracted   alias of /ingest (accepts the poller's {items:[{reportPath,sqls:[{text}]}]}).
 *   POST /ingest/catalog     RAW .xdmz/.xdoz/.zip archive → extract physical SQL → normalize → stage.
 *   POST /ingest/enrich      run the enrich worker over PENDING rows now → { enriched, failed, pending }.
 *   POST /ingest/materialize insert newly-ENRICHED rows into report_queries. ?force=1 re-materializes all.
 *   GET  /ingest/health      { ok, pending, enriched, materialized }.
 *
 * Scheduler: every ENRICH_INTERVAL ms (default 60000) run enrich-then-materialize for anything
 * outstanding. Provider/creds come from getEnrichConfig() (enrichConfig.ts).
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { corpusCount, materialize, materializedIds, exportCorpus, importCorpus, type MaterializeRow, type ImportRow } from "./corpus/ingestStore.js";
import { extractModels } from "./corpus/extractArchive.js";
import { openEnrichStore, type EnrichStore } from "./corpus/enrichStore.js";
import { hashSql, hashSqlNormalized, type SqlSource } from "./corpus/sources.js";
import { enrichOne } from "./corpus/enrichAdapters.js";
import { getEnrichConfig } from "./corpus/enrichConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.INGEST_TOKEN;

/** Bearer-token guard; open (with a warning) when INGEST_TOKEN is unset. */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!TOKEN) return next();
  const auth = req.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === TOKEN) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

// ---- staging store (singleton) ----------------------------------------------------------------
let _store: EnrichStore | null = null;
function getStore(): EnrichStore {
  if (!_store) {
    const dbPath = process.env.ENRICH_DB ?? path.resolve(__dirname, "../data/enrich.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // better-sqlite3 needs the dir to exist
    _store = openEnrichStore(dbPath);
  }
  return _store;
}

// ---- ready_catalog parsing + staging ----------------------------------------------------------
interface ReadyCatalogReport {
  path?: string;
  reportPath?: string;
  name?: string;
  title?: string;
  sqls?: (string | { text?: string; hash?: string })[];
}

function reportTitle(r: ReadyCatalogReport): string {
  return (r.title ?? r.path ?? r.reportPath ?? r.name ?? "").trim();
}
function reportSqls(r: ReadyCatalogReport): string[] {
  return (r.sqls ?? [])
    .map((s) => (typeof s === "string" ? s : s?.text ?? ""))
    .filter((s) => typeof s === "string" && /\S/.test(s));
}

/** Normalize the request body into a list of report objects. */
function collectReports(body: any): ReadyCatalogReport[] {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  if (body && Array.isArray(body.sqls)) return [body]; // single report object
  return [];
}

/**
 * Stage one report's SQLs. Identity is a NORMALIZED-SQL content hash, so a query shared across
 * many reports (e.g. an LOV "list of ledgers") is staged and enriched ONCE; each report that uses
 * it is recorded as a reference. Returns { staged: total SQLs seen, unique: brand-new SQLs added }.
 */
function stageReport(store: EnrichStore, r: ReadyCatalogReport): { staged: number; unique: number } {
  const sqls = reportSqls(r);
  if (sqls.length === 0) return { staged: 0, unique: 0 };
  const title = reportTitle(r);
  const reportPath = (r.reportPath ?? r.path ?? title) || undefined;
  let unique = 0;
  sqls.forEach((sql, i) => {
    const id = `sql:${hashSqlNormalized(sql)}`;
    const src: SqlSource = {
      id, source: "catalog", title: title || id,
      originalSql: sql, sourceHash: hashSql(sql), raw: {},
    };
    if (store.stageSql(src, { path: reportPath, title: title || undefined, index: i })) unique++;
  });
  return { staged: sqls.length, unique };
}

// ---- enrich + materialize orchestration -------------------------------------------------------
let enrichRunning = false;

/** Run the enrich worker over PENDING staging rows via a concurrency-limited pool.
 *  `limit` (>0) caps how many pending rows this run processes — used for controlled test batches. */
async function runEnrich(store: EnrichStore, limit?: number): Promise<{ enriched: number; failed: number; pending: number; skipped?: string }> {
  if (enrichRunning) return { enriched: 0, failed: 0, pending: store.counts().pending, skipped: "already running" };
  enrichRunning = true;
  try {
    const cfg = getEnrichConfig();
    let pend = store.pendingRows();
    if (limit && limit > 0) pend = pend.slice(0, limit);
    if (pend.length === 0) return { enriched: 0, failed: 0, pending: 0 };
    if (!cfg.apiKey && cfg.provider !== "custom") {
      console.error(`[ingest] enrich: no key for provider "${cfg.provider}" — leaving ${pend.length} row(s) pending`);
      return { enriched: 0, failed: 0, pending: pend.length, skipped: "no key" };
    }
    let idx = 0, enriched = 0, failed = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= pend.length) return;
        const row = pend[i];
        try {
          const e = await enrichOne(row.originalSql, row.title);
          store.setEnrichment(row.id, {
            cleanSql: row.originalSql, description: e.description,
            tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes,
            joins: [], filters: [], securityPredicate: null,
          });
          enriched++;
        } catch (err) {
          failed++;
          console.error(`[ingest] enrich fail ${row.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, pend.length) }, worker));
    console.error(`[ingest] enrich done: enriched=${enriched} failed=${failed} (provider=${cfg.provider})`);
    return { enriched, failed, pending: store.counts().pending };
  } finally {
    enrichRunning = false;
  }
}

/** Materialize enriched staging rows not yet in report_queries (force=true re-does all). */
async function runMaterialize(store: EnrichStore, force = false): Promise<{ inserted: number; replaced: number }> {
  const have = force ? new Set<string>() : materializedIds();
  const rows: MaterializeRow[] = [];
  for (const r of store.iterateEnriched()) {
    if (!force && have.has(r.id)) continue;
    rows.push({
      id: r.id, title: r.title, originalSql: r.originalSql, cleanSql: r.cleanSql,
      description: r.description ?? "", tablesUsed: r.tablesUsed, lookupTypes: r.lookupTypes,
      joins: r.joins, filters: r.filters, securityPredicate: r.securityPredicate,
      source: "bip-report", reports: r.reports,
    });
  }
  if (rows.length === 0) return { inserted: 0, replaced: 0 };
  const res = await materialize(rows);
  if (res.inserted || res.replaced) console.error(`[ingest] materialize: inserted=${res.inserted} replaced=${res.replaced}`);
  return res;
}

function safeCorpusCount(): number | null {
  try { return corpusCount(); } catch { return null; }
}

// ---- router -----------------------------------------------------------------------------------
export function createIngestRouter(): express.Router {
  const router = express.Router();

  router.get("/ingest/health", async (_req, res) => {
    try {
      const c = getStore().counts();
      res.json({ ok: true, pending: c.pending, enriched: c.enriched, materialized: safeCorpusCount() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  const stageHandler = async (req: express.Request, res: express.Response) => {
    try {
      const reports = collectReports(req.body);
      if (reports.length === 0) {
        return res.status(400).json({ ok: false, error: "expected a report {sqls:[...]}, an array of reports, or {items:[...]}" });
      }
      const store = getStore();
      let staged = 0, unique = 0, reportsStaged = 0;
      for (const r of reports) {
        const n = stageReport(store, r);
        if (n.staged > 0) { staged += n.staged; unique += n.unique; reportsStaged++; }
      }
      const c = store.counts();
      res.json({ ok: true, reports: reportsStaged, staged, unique, deduped: staged - unique, pending: c.pending, enriched: c.enriched });
    } catch (e: any) {
      console.error("[ingest] stage error", e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  };

  // Primary staging endpoint + backward-compatible alias for the poller's extracted shape.
  router.post("/ingest", requireAuth, express.json({ limit: "64mb" }), stageHandler);
  router.post("/ingest/extracted", requireAuth, express.json({ limit: "64mb" }), stageHandler);

  // Raw archive upload → extract physical SQL → stage as one report.
  router.post(
    "/ingest/catalog",
    requireAuth,
    express.raw({ type: () => true, limit: "200mb" }),
    async (req, res) => {
      try {
        let bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
        const ct = req.get("content-type") ?? "";
        if (/multipart\/form-data/i.test(ct)) {
          const f = multipartFile(bytes, ct);
          if (!f) return res.status(400).json({ ok: false, error: "no `file` field in multipart body" });
          bytes = f;
        }
        if (bytes.length === 0) return res.status(400).json({ ok: false, error: "empty body" });

        const groupKey =
          (req.query.reportPath as string) ||
          (req.get("x-report-path") as string) ||
          `upload:${(req.query.name as string) || "catalog-archive"}`;

        const models = extractModels(bytes, "");
        const sqls = models.flatMap((m) => m.physicalSqls);
        if (sqls.length === 0) {
          return res.json({ ok: true, models: models.length, staged: 0, note: "no physical SQL found", ...getStore().counts() });
        }
        const st = stageReport(getStore(), { title: groupKey, reportPath: groupKey, sqls });
        const c = getStore().counts();
        res.json({ ok: true, models: models.length, staged: st.staged, unique: st.unique, pending: c.pending, enriched: c.enriched });
      } catch (e: any) {
        console.error("[ingest] /catalog error", e);
        res.status(500).json({ ok: false, error: e?.message ?? String(e) });
      }
    },
  );

  // Manual triggers.
  router.post("/ingest/enrich", requireAuth, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      res.json({ ok: true, ...(await runEnrich(getStore(), limit)) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message ?? String(e) }); }
  });

  router.post("/ingest/materialize", requireAuth, async (req, res) => {
    try {
      const force = req.query.force === "1" || req.query.force === "true";
      const r = await runMaterialize(getStore(), force);
      res.json({ ok: true, ...r, materialized: safeCorpusCount() });
    } catch (e: any) {
      console.error("[ingest] /materialize error", e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ---- portable corpus export / import ----
  //   GET  /ingest/export?scope=data|full[&source=bip-report]  -> streams NDJSON (one row/line)
  //   POST /ingest/import   (NDJSON or JSON array body)          -> insert/replace, re-embed if needed
  // scope=data omits embeddings (import re-embeds locally, no Gemini); full carries them verbatim.
  router.get("/ingest/export", requireAuth, (req, res) => {
    const scope = req.query.scope === "full" ? "full" : "data";
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="corpus-${scope}${source ? "-" + source : ""}.ndjson"`);
    try {
      let n = 0;
      for (const row of exportCorpus(scope, source)) { res.write(JSON.stringify(row) + "\n"); n++; }
      if (process.env.MCP_DEBUG) console.error(`[ingest] export scope=${scope} source=${source ?? "*"} rows=${n}`);
      res.end();
    } catch (e: any) {
      console.error("[ingest] /export error", e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: e?.message ?? String(e) });
      else res.end();
    }
  });

  router.post("/ingest/import", requireAuth, express.text({ type: () => true, limit: "1024mb" }), async (req, res) => {
    try {
      const body = typeof req.body === "string" ? req.body : "";
      const rows: ImportRow[] = body.trim().startsWith("[")
        ? JSON.parse(body)
        : body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      let imported = 0, replaced = 0, embedded = 0;
      for (let i = 0; i < rows.length; i += 500) {          // batch to bound embed() memory
        const r = await importCorpus(rows.slice(i, i + 500));
        imported += r.imported; replaced += r.replaced; embedded += r.embedded;
      }
      res.json({ ok: true, imported, replaced, embedded, materialized: safeCorpusCount() });
    } catch (e: any) {
      console.error("[ingest] /import error", e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  return router;
}

/** Background scheduler: enrich-then-materialize on an interval. Called once at server startup. */
export function startIngestScheduler(): void {
  const ms = Number(process.env.ENRICH_INTERVAL ?? 60_000);
  if (!(ms > 0)) {
    console.error("[ingest] scheduler disabled (ENRICH_INTERVAL <= 0)");
    return;
  }
  // Enrich at most ENRICH_BATCH pending rows per tick so a large backlog (e.g. a fresh full poll)
  // drains gradually instead of firing thousands of model calls at once. 0 = all pending per tick.
  const batch = Number(process.env.ENRICH_BATCH ?? 200) || undefined;
  const store = getStore();
  const tick = async () => {
    try {
      if (store.counts().pending > 0) await runEnrich(store, batch);
      await runMaterialize(store);
    } catch (e) {
      console.error("[ingest] scheduler tick error", e);
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref?.(); // don't keep the event loop alive for the scheduler alone
  console.error(`[ingest] scheduler on: enrich(${batch ?? "all"})+materialize every ${ms}ms (provider=${getEnrichConfig().provider})`);
}

export function ingestAuthWarning(): void {
  if (!TOKEN) console.error("[ingest] WARNING: INGEST_TOKEN unset — /ingest endpoints are UNAUTHENTICATED (dev mode).");
}

/** Minimal multipart/form-data parser — pulls the `file` field bytes from a raw body buffer. */
function multipartFile(body: Buffer, contentType: string): Buffer | undefined {
  const b = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = b && (b[1] ?? b[2]);
  if (!boundary) return undefined;
  const delim = Buffer.from(`--${boundary}`);
  let pos = 0;
  const parts: Buffer[] = [];
  for (;;) {
    const start = body.indexOf(delim, pos);
    if (start < 0) break;
    const next = body.indexOf(delim, start + delim.length);
    if (next < 0) break;
    parts.push(body.subarray(start + delim.length, next));
    pos = next;
  }
  for (const part of parts) {
    const sep = part.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const header = part.subarray(0, sep).toString("utf8");
    if (!/content-disposition:[^\n]*\bname="?file"?/i.test(header)) continue;
    let content = part.subarray(sep + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }
    return content;
  }
  return undefined;
}
