/**
 * REST ingest API — adds report SQL to the corpus at runtime WITHOUT touching the MCP transport.
 *
 *   POST /ingest/extracted  JSON {items:[...]} (or a bare array) from the bip-catalog-poller:
 *        each item {reportPath, provenance, relPath?, dataModel?, datasets?, sqls:[{hash,text}]}.
 *   POST /ingest/catalog    RAW BIP archive (.xdmz/.xdoz/.zip) as application/zip OR multipart
 *        field `file`; we unzip, extract physical (non-OTBI-logical) SQL, and ingest it.
 *   GET  /ingest/health     -> {ok:true, corpusCount:<n>}.
 *
 * Auth: Authorization: Bearer <INGEST_TOKEN>. If INGEST_TOKEN is unset, requests are allowed
 * (dev mode) with a startup warning.
 */
import express from "express";
import { corpusCount, ingestReport } from "./corpus/ingestStore.js";
import { extractModels } from "./corpus/extractArchive.js";

const TOKEN = process.env.INGEST_TOKEN;

/** Bearer-token guard; open (with a warning) when INGEST_TOKEN is unset. */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!TOKEN) return next();
  const auth = req.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === TOKEN) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

interface ExtractedItem {
  reportPath?: string;
  relPath?: string;
  provenance?: "shared" | "custom" | string;
  dataModel?: string;
  datasets?: { name?: string; dataSourceRef?: string; physical?: boolean }[];
  sqls?: ({ hash?: string; text?: string } | string)[];
}

function normSqls(sqls: ExtractedItem["sqls"]): { hash?: string; text: string }[] {
  return (sqls ?? [])
    .map((s) => (typeof s === "string" ? { text: s } : { hash: s?.hash, text: s?.text ?? "" }))
    .filter((s) => typeof s.text === "string" && /\S/.test(s.text));
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
    // body is between the header separator and the trailing CRLF before the next boundary
    let content = part.subarray(sep + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }
    return content;
  }
  return undefined;
}

export function createIngestRouter(): express.Router {
  const router = express.Router();

  router.get("/ingest/health", async (_req, res) => {
    try {
      res.json({ ok: true, corpusCount: corpusCount() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // JSON push from the poller. Own body parser with a generous limit (SQL can be large).
  router.post(
    "/ingest/extracted",
    requireAuth,
    express.json({ limit: "64mb" }),
    async (req, res) => {
      try {
        const body = req.body;
        const items: ExtractedItem[] = Array.isArray(body) ? body : (body?.items ?? []);
        if (!Array.isArray(items)) {
          return res.status(400).json({ ok: false, error: "expected an array or {items:[...]}" });
        }
        const results = [];
        for (const it of items) {
          const groupKey = it.reportPath ?? it.relPath;
          const sqls = normSqls(it.sqls);
          if (!groupKey || sqls.length === 0) continue;
          results.push(
            await ingestReport({
              groupKey,
              title: it.reportPath ?? it.relPath ?? groupKey,
              provenance: it.provenance,
              reportPath: it.reportPath,
              sqls,
            }),
          );
        }
        const inserted = results.reduce((n, r) => n + r.inserted, 0);
        const replaced = results.reduce((n, r) => n + r.replaced, 0);
        res.json({ ok: true, reports: results.length, inserted, replaced, corpusCount: corpusCount(), results });
      } catch (e: any) {
        console.error("[ingest] /extracted error", e);
        res.status(500).json({ ok: false, error: e?.message ?? String(e) });
      }
    },
  );

  // Raw archive upload. `express.raw` gives us the bytes for any content-type.
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
        if (bytes.length === 0) {
          return res.status(400).json({ ok: false, error: "empty body" });
        }
        // groupKey identifies this upload so re-uploading the same archive replaces its rows.
        const groupKey =
          (req.query.reportPath as string) ||
          (req.get("x-report-path") as string) ||
          `upload:${(req.query.name as string) || "catalog-archive"}`;

        const models = extractModels(bytes, "");
        const sqls = models.flatMap((m) =>
          m.physicalSqls.map((text) => ({ hash: undefined as string | undefined, text })),
        );
        if (sqls.length === 0) {
          return res.json({ ok: true, models: models.length, inserted: 0, replaced: 0, corpusCount: corpusCount(), note: "no physical SQL found" });
        }
        const result = await ingestReport({
          groupKey,
          title: groupKey,
          provenance: (req.query.provenance as string) || "custom",
          reportPath: groupKey,
          sqls,
        });
        res.json({ ok: true, models: models.length, ...result, corpusCount: corpusCount() });
      } catch (e: any) {
        console.error("[ingest] /catalog error", e);
        res.status(500).json({ ok: false, error: e?.message ?? String(e) });
      }
    },
  );

  return router;
}

export function ingestAuthWarning(): void {
  if (!TOKEN) console.error("[ingest] WARNING: INGEST_TOKEN unset — /ingest endpoints are UNAUTHENTICATED (dev mode).");
}
