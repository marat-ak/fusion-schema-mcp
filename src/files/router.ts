/**
 * File HTTP surface (bearer INGEST_TOKEN, same as /ingest):
 *   POST /files/upload?name=  (raw archive bytes) -> analyze + store -> { files:[{fileId,name,kind,summary}] }
 *        A .zip bundle of .xdmz/.xdoz is expanded into one stored file per inner archive.
 *   GET  /files/:id/download  -> the raw archive bytes.
 * The agent proxies browser uploads here; the model then operates on the files by fileId via the
 * MCP file tools.
 */
import express from "express";
import { unzipSync } from "fflate";
import { analyze } from "./analyze.js";
import { putFile, getFile, type FileMeta } from "./store.js";

const TOKEN = process.env.INGEST_TOKEN;
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!TOKEN) return next();
  const m = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === TOKEN) return next();
  res.status(401).json({ ok: false, error: "unauthorized" });
}

/** Store one uploaded blob — expanding a .zip bundle of archives into multiple stored files. */
function ingestUpload(name: string, bytes: Buffer): FileMeta[] {
  let entries: Record<string, Uint8Array> | null = null;
  try { entries = unzipSync(new Uint8Array(bytes)); } catch { entries = null; }
  if (entries) {
    const names = Object.keys(entries);
    const isSingleArchive = names.some((n) => /_datamodel\.xdm$|_report\.xdo$/i.test(n) || /\.(xdm|xdo)$/i.test(n));
    if (!isSingleArchive) {
      const inner = names.filter((n) => /\.(xdmz|xdoz)$/i.test(n));
      if (inner.length) {
        return inner.map((n) => {
          const b = Buffer.from(entries![n]);
          const s = analyze(b);
          return putFile(n.split("/").pop() || n, s.kind, b, s);
        });
      }
    }
  }
  const s = analyze(bytes);
  return [putFile(name, s.kind, bytes, s)];
}

export function createFilesRouter(): express.Router {
  const router = express.Router();

  router.post("/files/upload", requireAuth, express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    if (!bytes.length) { res.status(400).json({ ok: false, error: "empty body" }); return; }
    const name = String(req.query.name ?? "upload");
    try {
      res.json({ ok: true, files: ingestUpload(name, bytes) });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  router.get("/files/:id/download", requireAuth, (req, res) => {
    const f = getFile(req.params.id);
    if (!f) { res.status(404).json({ ok: false, error: "file not found or expired" }); return; }
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${f.name.replace(/"/g, "")}"`);
    res.end(f.bytes);
  });

  return router;
}
