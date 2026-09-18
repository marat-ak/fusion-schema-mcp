/**
 * DURABLE native Gemini Batch reenrich for materialized rows (e.g. the 85k OTBI corpus on
 * gemini-flash-lite, 50% off). Mirrors the Anthropic enrichBatchApi durability: every submitted
 * batch job's name + its row_id→response-index map is PERSISTED (gjob_jobs / gjob_items) so a
 * container restart never orphans a paid job. The scheduler polls open jobs; on SUCCEEDED it reads
 * inlinedResponses, ingests via the shared parser, records usage at the @batch half-rate, and marks
 * the job done. A per-run spend cap (checked before each new submit) protects a fixed budget.
 *
 * submit() only CREATES jobs (fast) — polling/ingest is the scheduler's job, so no long-lived
 * in-memory loop that a restart could kill. Job persistence: `db().enrich.jobs`.
 */
import { GoogleGenAI } from "@google/genai";
import { db, type GeminiJob, type GeminiControl } from "../db/index.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";
import { embedBulk as embed } from "./embed.js";
import { updateEnrichment, embedTexts, recordUsage, clearBatchUsage, reenrichQueue, spentUsd } from "./ingestStore.js";

export type { GeminiControl };

function apiKey(): string {
  const k = (process.env.GOOGLE_STUDIO_API_KEY ?? "").trim();
  if (!k) throw new Error("GOOGLE_STUDIO_API_KEY not set");
  return k;
}
const ai = () => new GoogleGenAI({ apiKey: apiKey() });

const COMPLETED = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);
const BATCH_PRICE_MODEL = (m: string) => `${m}@batch`; // half-rate row in ingestStore PRICE

/** Submit up to `limit` pending rows of `sources` as native Gemini batch jobs of `batchSize` each.
 *  Persists job + row map. Respects a spend cap (stops submitting once gemini spend >= cap). */
export async function submitGeminiReenrich(opts: {
  sources: string[]; model: string; limit: number; batchSize?: number; spendCapUsd?: number;
}): Promise<{ submitted: number; jobs: string[]; skippedForCap?: boolean }> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 100, 1), 200);
  const cap = opts.spendCapUsd ?? 0;
  if (cap > 0 && (await spentUsd("gemini%")) >= cap) return { submitted: 0, jobs: [], skippedForCap: true };

  const rows = await reenrichQueue(opts.sources, opts.limit);
  if (!rows.length) return { submitted: 0, jobs: [] };
  const client = ai();
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
    await db().enrich.jobs.insertGeminiJob(
      { name, model: opts.model, n: chunk.length, submittedAt: nowIso, status: job.state ?? "JOB_STATE_PENDING" },
      chunk.map((r, k) => ({ idx: k, rowId: r.id })),
    );
    jobs.push(name);
  }
  return { submitted: rows.length, jobs };
}

export async function openGeminiJobs(): Promise<GeminiJob[]> {
  return db().enrich.jobs.openGeminiJobs();
}
export async function allGeminiJobs(): Promise<unknown[]> {
  return db().enrich.jobs.allGeminiJobs();
}

/** Poll one persisted job; when SUCCEEDED, ingest its responses (idempotent) and mark done. */
export async function pollGeminiJob(name: string): Promise<Record<string, unknown>> {
  const jobs = db().enrich.jobs;
  const client = ai();
  const bj: any = await client.batches.get({ name });
  await jobs.setGeminiStatus(name, bj.state);
  if (!COMPLETED.has(bj.state)) return { name, status: bj.state };
  if (bj.state !== "JOB_STATE_SUCCEEDED") {
    await jobs.finishGeminiJob(name, String(bj.state));
    return { name, status: bj.state, ingested: 0 };
  }
  const inl: any[] = bj.dest?.inlinedResponses ?? [];
  const map = new Map<number, string>((await jobs.geminiItems(name)).map((x) => [x.idx, x.row_id]));
  const model = (await jobs.geminiModel(name)) ?? "gemini-flash-lite-latest";
  const rowMeta = new Map<string, { title: string; sql: string }>();
  for (const rid of map.values()) {
    const m = await db().corpus.titleAndSql(rid);
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
      await updateEnrichment(rid, { description: e.description, intents: e.intents ?? [], mechanics: e.mechanics ?? "(no notable mechanics)" }, vecs);
      inTok += Number(um.promptTokenCount ?? 0); outTok += Number(um.candidatesTokenCount ?? 0); ok++;
    } catch { fail++; }
  }
  // Idempotent usage: a batch's execution is billed by Google ONCE, but a re-ingest (race, retry,
  // manual reingest) must NOT record its tokens again — clear any prior usage for this batch_id first
  // so `spentUsd` (and the spend cap) reflect real per-batch cost, not inflated re-counts.
  await clearBatchUsage(name);
  await recordUsage({ ts: new Date().toISOString(), model: BATCH_PRICE_MODEL(model), source: "otbi-batch", nItems: ok, inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheCreationTokens: 0, batchId: name });
  await jobs.finishGeminiJob(name, `ok=${ok} fail=${fail}`);
  return { name, status: "done", ingested: ok, failed: fail };
}

/** Poll every open job (called by the scheduler). */
export async function pollGeminiJobs(): Promise<{ polled: number; ingested: number }> {
  let ingested = 0, polled = 0;
  for (const j of await openGeminiJobs()) {
    try { const r = await pollGeminiJob(j.name); polled++; ingested += Number((r as any).ingested ?? 0); }
    catch (e: any) { console.error("[gjob] poll error", j.name, e?.message ?? e); }
  }
  return { polled, ingested };
}

// ---- self-driving control (durable across restarts) ----
export async function setGeminiControl(c: Omit<GeminiControl, "active"> & { active: boolean | number }): Promise<void> {
  await db().enrich.jobs.setGeminiControl({ ...c, active: c.active ? 1 : 0 });
}
export async function getGeminiControl(): Promise<GeminiControl | null> {
  return db().enrich.jobs.getGeminiControl();
}

/**
 * One scheduler tick: (1) poll+ingest open jobs; (2) if a control run is active, under its cap, and
 * no jobs are currently open, submit the next wave. Empties naturally: queue done or cap hit → the
 * run marks itself inactive. Fully resumable — all state (jobs, map, control) is on disk.
 */
// Re-entrancy lock: the scheduler interval AND a manual /start can both call this; without a lock
// two ticks pass the openGeminiJobs()==0 check before either inserts its jobs and BOTH submit the
// same wave (double-pay). The in-flight DB guard (NOT_IN_GEMINI_FLIGHT) also protects the queue, but
// this stops the wasted round-trip entirely.
// Keep this many batch JOBS in flight at once. The old design drained a whole wave to zero before
// submitting the next — with Gemini's async batch queue that left the pipeline mostly empty and was
// slow. We now TOP UP to the target every tick (refill as jobs complete). Overshoot past the spend
// cap is bounded by the in-flight commitment (~target*batch rows worth), which is fine for a fixed
// budget. GEMINI_MAX_INFLIGHT_JOBS overrides the default.
const MAX_INFLIGHT_JOBS = Math.max(1, Number(process.env.GEMINI_MAX_INFLIGHT_JOBS ?? 60));
let _driveInFlight = false;
export async function driveGeminiReenrich(): Promise<{ polled: number; ingested: number; submitted?: number; stopped?: string }> {
  if (_driveInFlight) return { polled: 0, ingested: 0, stopped: "already-running" };
  _driveInFlight = true;
  try {
    const poll = await pollGeminiJobs();
    const ctl = await getGeminiControl();
    if (!ctl || !ctl.active) return poll;
    const sources = ctl.sources.split(",").map((s) => s.trim()).filter(Boolean);
    if (ctl.cap > 0 && (await spentUsd("gemini%")) >= ctl.cap) { await setGeminiControl({ ...ctl, active: false }); return { ...poll, stopped: "spend-cap" }; }
    const open = (await openGeminiJobs()).length;
    const slots = MAX_INFLIGHT_JOBS - open;
    if (slots <= 0) return poll; // pipeline saturated — nothing to top up this tick
    // top up: submit up to `slots` more batches (bounded also by ctl.wave rows per tick)
    const topUp = Math.min(slots * ctl.batch_size, ctl.wave);
    const r = await submitGeminiReenrich({ sources, model: ctl.model, limit: topUp, batchSize: ctl.batch_size, spendCapUsd: ctl.cap });
    // deactivate only when nothing is left to submit AND nothing is still running
    if (r.submitted === 0 && open === 0) { await setGeminiControl({ ...ctl, active: false }); return { ...poll, stopped: r.skippedForCap ? "spend-cap" : "queue-empty" }; }
    return { ...poll, submitted: r.submitted };
  } finally {
    _driveInFlight = false;
  }
}
