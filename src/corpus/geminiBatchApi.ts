/**
 * DURABLE native Gemini Batch reenrich for materialized rows (e.g. the 85k OTBI corpus on
 * gemini-flash-lite, 50% off). Mirrors the Anthropic enrichBatchApi durability: every submitted
 * batch job's name + its row_id→response-index map is PERSISTED (gjob_jobs / gjob_items) so a
 * container restart never orphans a paid job. The scheduler polls open jobs; on SUCCEEDED it reads
 * inlinedResponses, ingests via the shared parser, records usage at the @batch half-rate, and marks
 * the job done. A per-run spend cap (checked before each new submit) protects a fixed budget.
 *
 * submit() only CREATES jobs (fast) — polling/ingest is the scheduler's job, so no long-lived
 * in-memory loop that a restart could kill.
 */
import Database from "better-sqlite3";
import { GoogleGenAI } from "@google/genai";
import { reportsDbPath } from "../dbPaths.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";
import { embed } from "./embed.js";
import { updateEnrichment, embedTexts, recordUsage, reenrichQueue, spentUsd } from "./ingestStore.js";

function apiKey(): string {
  const k = (process.env.GOOGLE_STUDIO_API_KEY ?? "").trim();
  if (!k) throw new Error("GOOGLE_STUDIO_API_KEY not set");
  return k;
}
const ai = () => new GoogleGenAI({ apiKey: apiKey() });

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const d = new Database(reportsDbPath());
  d.pragma("busy_timeout = 10000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS gjob_jobs (
      name TEXT PRIMARY KEY, model TEXT, n INTEGER, submitted_at TEXT, status TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS gjob_items (
      name TEXT, idx INTEGER, row_id TEXT, PRIMARY KEY (name, idx)
    );
    CREATE TABLE IF NOT EXISTS gjob_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER, sources TEXT, model TEXT, cap REAL, wave INTEGER, batch_size INTEGER
    );
  `);
  _db = d;
  return d;
}

const COMPLETED = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);
const BATCH_PRICE_MODEL = (m: string) => `${m}@batch`; // half-rate row in ingestStore PRICE

/** Submit up to `limit` pending rows of `sources` as native Gemini batch jobs of `batchSize` each.
 *  Persists job + row map. Respects a spend cap (stops submitting once gemini spend >= cap). */
export async function submitGeminiReenrich(opts: {
  sources: string[]; model: string; limit: number; batchSize?: number; spendCapUsd?: number;
}): Promise<{ submitted: number; jobs: string[]; skippedForCap?: boolean }> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 100, 1), 200);
  const cap = opts.spendCapUsd ?? 0;
  if (cap > 0 && spentUsd("gemini%") >= cap) return { submitted: 0, jobs: [], skippedForCap: true };

  const rows = reenrichQueue(opts.sources, opts.limit);
  if (!rows.length) return { submitted: 0, jobs: [] };
  const client = ai();
  const d = db();
  const insJob = d.prepare("INSERT OR REPLACE INTO gjob_jobs (name, model, n, submitted_at, status) VALUES (?,?,?,?,?)");
  const insItem = d.prepare("INSERT OR REPLACE INTO gjob_items (name, idx, row_id) VALUES (?,?,?)");
  const nowIso = new Date().toISOString();
  const jobs: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const src = chunk.map((r) => {
      const p = buildEnrichPrompt({ id: r.id, source: "catalog", title: r.title, originalSql: r.sql, sourceHash: "", raw: {} } as any);
      return { contents: [{ role: "user", parts: [{ text: p.user }] }], config: { systemInstruction: p.system, responseMimeType: "application/json" } };
    });
    const job = await client.batches.create({ model: opts.model, src: src as any, config: { displayName: `otbi-${chunk.length}` } });
    const name = job.name!;
    const tx = d.transaction(() => {
      insJob.run(name, opts.model, chunk.length, nowIso, job.state ?? "JOB_STATE_PENDING");
      chunk.forEach((r, k) => insItem.run(name, k, r.id));
    });
    tx();
    jobs.push(name);
  }
  return { submitted: rows.length, jobs };
}

export function openGeminiJobs(): { name: string; model: string; n: number }[] {
  return db().prepare("SELECT name, model, n FROM gjob_jobs WHERE status NOT IN ('done','JOB_STATE_FAILED','JOB_STATE_CANCELLED','JOB_STATE_EXPIRED')").all() as any[];
}
export function allGeminiJobs(): unknown[] {
  return db().prepare("SELECT name, model, n, status, note, submitted_at FROM gjob_jobs ORDER BY submitted_at DESC LIMIT 40").all();
}

/** Poll one persisted job; when SUCCEEDED, ingest its responses (idempotent) and mark done. */
export async function pollGeminiJob(name: string): Promise<Record<string, unknown>> {
  const d = db();
  const client = ai();
  const bj: any = await client.batches.get({ name });
  d.prepare("UPDATE gjob_jobs SET status = ? WHERE name = ?").run(bj.state, name);
  if (!COMPLETED.has(bj.state)) return { name, status: bj.state };
  if (bj.state !== "JOB_STATE_SUCCEEDED") {
    d.prepare("UPDATE gjob_jobs SET status = 'done', note = ? WHERE name = ?").run(String(bj.state), name);
    return { name, status: bj.state, ingested: 0 };
  }
  const inl: any[] = bj.dest?.inlinedResponses ?? [];
  const map = new Map<number, string>((d.prepare("SELECT idx, row_id FROM gjob_items WHERE name = ?").all(name) as any[]).map((x) => [x.idx, x.row_id]));
  const model = (d.prepare("SELECT model FROM gjob_jobs WHERE name = ?").get(name) as any)?.model ?? "gemini-flash-lite-latest";
  const rowMeta = new Map<string, { title: string; sql: string }>();
  for (const rid of map.values()) {
    const m = d.prepare("SELECT title, COALESCE(clean_sql, original_sql) sql FROM report_queries WHERE id = ?").get(rid) as any;
    if (m) rowMeta.set(rid, m);
  }
  let ok = 0, fail = 0, inTok = 0, outTok = 0;
  for (let i = 0; i < inl.length; i++) {
    const rid = map.get(i); const meta = rid && rowMeta.get(rid);
    if (!rid || !meta) { fail++; continue; }
    const r = inl[i];
    if (r?.error) { fail++; continue; }
    const text = r?.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const um = r?.response?.usageMetadata ?? {};
    try {
      const e = parseEnrichReply(text, { id: rid, source: "catalog", title: meta.title, originalSql: meta.sql, sourceHash: "", raw: {} } as any);
      const vecs = await embed(embedTexts(e.description, e.tablesUsed ?? [], e.intents ?? []));
      updateEnrichment(rid, { description: e.description, intents: e.intents ?? [], mechanics: e.mechanics ?? "(no notable mechanics)" }, vecs);
      inTok += Number(um.promptTokenCount ?? 0); outTok += Number(um.candidatesTokenCount ?? 0); ok++;
    } catch { fail++; }
  }
  recordUsage({ ts: new Date().toISOString(), model: BATCH_PRICE_MODEL(model), source: "otbi-batch", nItems: ok, inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheCreationTokens: 0, batchId: name });
  d.prepare("UPDATE gjob_jobs SET status = 'done', note = ? WHERE name = ?").run(`ok=${ok} fail=${fail}`, name);
  return { name, status: "done", ingested: ok, failed: fail };
}

/** Poll every open job (called by the scheduler). */
export async function pollGeminiJobs(): Promise<{ polled: number; ingested: number }> {
  let ingested = 0, polled = 0;
  for (const j of openGeminiJobs()) {
    try { const r = await pollGeminiJob(j.name); polled++; ingested += Number((r as any).ingested ?? 0); }
    catch (e: any) { console.error("[gjob] poll error", j.name, e?.message ?? e); }
  }
  return { polled, ingested };
}

// ---- self-driving control (durable across restarts) ----
export interface GeminiControl { active: number; sources: string; model: string; cap: number; wave: number; batch_size: number }
export function setGeminiControl(c: Omit<GeminiControl, "active"> & { active: boolean }): void {
  db().prepare("INSERT OR REPLACE INTO gjob_control (id, active, sources, model, cap, wave, batch_size) VALUES (1,?,?,?,?,?,?)")
    .run(c.active ? 1 : 0, c.sources, c.model, c.cap, c.wave, c.batch_size);
}
export function getGeminiControl(): GeminiControl | null {
  return (db().prepare("SELECT active, sources, model, cap, wave, batch_size FROM gjob_control WHERE id = 1").get() as any) ?? null;
}

/**
 * One scheduler tick: (1) poll+ingest open jobs; (2) if a control run is active, under its cap, and
 * no jobs are currently open, submit the next wave. Empties naturally: queue done or cap hit → the
 * run marks itself inactive. Fully resumable — all state (jobs, map, control) is on disk.
 */
export async function driveGeminiReenrich(): Promise<{ polled: number; ingested: number; submitted?: number; stopped?: string }> {
  const poll = await pollGeminiJobs();
  const ctl = getGeminiControl();
  if (!ctl || !ctl.active) return poll;
  const sources = ctl.sources.split(",").map((s) => s.trim()).filter(Boolean);
  if (ctl.cap > 0 && spentUsd("gemini%") >= ctl.cap) { setGeminiControl({ ...ctl, active: false }); return { ...poll, stopped: "spend-cap" }; }
  if (openGeminiJobs().length > 0) return poll; // let the in-flight wave finish before the next
  const r = await submitGeminiReenrich({ sources, model: ctl.model, limit: ctl.wave, batchSize: ctl.batch_size, spendCapUsd: ctl.cap });
  if (r.submitted === 0) { setGeminiControl({ ...ctl, active: false }); return { ...poll, stopped: r.skippedForCap ? "spend-cap" : "queue-empty" }; }
  return { ...poll, submitted: r.submitted };
}
