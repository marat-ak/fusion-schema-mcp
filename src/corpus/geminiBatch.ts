/**
 * Reusable native Gemini Batch runner, on the official @google/genai SDK.
 *
 *   runGeminiBatches(items, cfg, opts) -> Map<key, {text|error}>
 *
 * Splits `items` into batches of `batchSize`, submits up to `concurrency` batch jobs concurrently,
 * and polls each to a terminal state (submit -> poll -> dest.inlinedResponses). ~50% cheaper than
 * per-request generateContent, async (minutes-to-hours). Inlined results come back IN ORDER, so we
 * map dest.inlinedResponses[i] back to items[i].key.
 */
import { GoogleGenAI } from "@google/genai";
import type { EnrichConfig } from "./enrichConfig.js";

export interface BatchItem { key: string; system?: string; user: string }
export interface BatchResult { key: string; text?: string; error?: string }

export interface RunBatchOpts {
  batchSize?: number;      // requests per batch job (default 100)
  concurrency?: number;    // concurrent batch jobs (default 4)
  pollIntervalMs?: number; // delay between status polls (default 20000)
  maxWaitMs?: number;      // give up on a single job after this (default 6h)
  onProgress?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const COMPLETED = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);

/** Submit one batch, poll to terminal, return results keyed by item.key (mapped by response order). */
async function runOneBatch(
  ai: GoogleGenAI, model: string, items: BatchItem[],
  o: { pollIntervalMs: number; maxWaitMs: number }, log: (m: string) => void, tag: string,
): Promise<BatchResult[]> {
  const src = items.map((it) => ({
    contents: [{ role: "user", parts: [{ text: it.user }] }],
    config: { ...(it.system ? { systemInstruction: it.system } : {}), responseMimeType: "application/json" },
  }));
  const job = await ai.batches.create({ model, src: src as any, config: { displayName: `enrich-${items.length}` } });
  log(`${tag} submitted ${items.length} req → ${job.name}`);

  const deadline = Date.now() + o.maxWaitMs;
  let bj: any = await ai.batches.get({ name: job.name! });
  while (!COMPLETED.has(bj.state)) {
    if (Date.now() > deadline) return items.map((it) => ({ key: it.key, error: `timeout (last=${bj.state})` }));
    await sleep(o.pollIntervalMs);
    bj = await ai.batches.get({ name: job.name! });
  }
  if (bj.state !== "JOB_STATE_SUCCEEDED") {
    const err = typeof bj.error === "string" ? bj.error : JSON.stringify(bj.error ?? {}).slice(0, 160);
    log(`${tag} ${bj.state} ${err}`);
    return items.map((it) => ({ key: it.key, error: err || bj.state }));
  }
  const inlined: any[] = bj.dest?.inlinedResponses ?? [];
  log(`${tag} SUCCEEDED (${inlined.length} responses)`);
  return items.map((it, i) => {
    const r = inlined[i];
    if (!r) return { key: it.key, error: "no response" };
    if (r.error) return { key: it.key, error: JSON.stringify(r.error).slice(0, 160) };
    const text = r.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    return { key: it.key, text };
  });
}

/**
 * Split `items` into batches and run up to `concurrency` batch jobs concurrently.
 * Returns a Map keyed by item.key with each item's {text} or {error}.
 */
export async function runGeminiBatches(items: BatchItem[], cfg: EnrichConfig, opts: RunBatchOpts = {}): Promise<Map<string, BatchResult>> {
  const model = cfg.model || "gemini-flash-lite-latest";
  const batchSize = opts.batchSize ?? 100;
  const concurrency = opts.concurrency ?? 4;
  const pollIntervalMs = opts.pollIntervalMs ?? 20_000;
  const maxWaitMs = opts.maxWaitMs ?? 6 * 3600_000;
  const log = opts.onProgress ?? (() => {});
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });

  const batches: BatchItem[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  const out = new Map<string, BatchResult>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= batches.length) return;
      const tag = `batch ${idx + 1}/${batches.length}`;
      try {
        for (const r of await runOneBatch(ai, model, batches[idx], { pollIntervalMs, maxWaitMs }, log, tag)) out.set(r.key, r);
      } catch (e) {
        log(`${tag} error: ${String(e).slice(0, 140)}`);
        for (const it of batches[idx]) out.set(it.key, { key: it.key, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return out;
}
