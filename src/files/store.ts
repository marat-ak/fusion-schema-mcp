/**
 * In-memory session file store for uploaded / generated BI Publisher archives.
 *
 * Files are referenced by an opaque `fileId` (the capability handle the agent passes to the file
 * tools). Entries carry the raw bytes + a COMPACT summary (never the raw XML/SQL — that is fetched
 * on demand via getDataset). TTL-evicted so long-lived containers don't leak memory.
 */
import crypto from "node:crypto";
import type { FileSummary } from "./analyze.js";

export type FileKind = "datamodel" | "report" | "unknown";

export interface StoredFile {
  id: string;
  name: string;
  kind: FileKind;
  bytes: Buffer;
  summary: FileSummary;
  createdAt: number;
  derivedFrom?: string; // fileId this was produced from (modify/update), if any
}

export interface FileMeta {
  id: string;
  name: string;
  kind: FileKind;
  summary: FileSummary;
  derivedFrom?: string;
}

const TTL_MS = Number(process.env.FILE_TTL_MS ?? 2 * 3600_000); // 2h default
const MAX_FILES = Number(process.env.FILE_STORE_MAX ?? 500);
const store = new Map<string, StoredFile>();

function gc(): void {
  const now = Date.now();
  for (const [id, f] of store) if (now - f.createdAt > TTL_MS) store.delete(id);
  // hard cap: drop oldest beyond MAX_FILES
  if (store.size > MAX_FILES) {
    const oldest = [...store.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, store.size - MAX_FILES);
    for (const f of oldest) store.delete(f.id);
  }
}

export function putFile(name: string, kind: FileKind, bytes: Buffer, summary: FileSummary, derivedFrom?: string): FileMeta {
  gc();
  const id = crypto.randomBytes(9).toString("hex");
  store.set(id, { id, name, kind, bytes, summary, createdAt: Date.now(), derivedFrom });
  return { id, name, kind, summary, derivedFrom };
}

export function getFile(id: string): StoredFile | undefined {
  const f = store.get(id);
  if (!f) return undefined;
  if (Date.now() - f.createdAt > TTL_MS) { store.delete(id); return undefined; }
  return f;
}

export function listFiles(ids?: string[]): FileMeta[] {
  gc();
  const entries = ids && ids.length ? ids.map((i) => store.get(i)).filter((f): f is StoredFile => !!f) : [...store.values()];
  return entries.map((f) => ({ id: f.id, name: f.name, kind: f.kind, summary: f.summary, derivedFrom: f.derivedFrom }));
}
