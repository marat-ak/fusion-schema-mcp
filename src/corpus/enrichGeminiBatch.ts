import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { scanSources, type SqlSource } from "./sources.js";
import { openEnrichStore } from "./enrichStore.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";

// Gemini Batch API = 50% off. 3.1 Flash-Lite batch: $0.125 in / $0.75 out per 1M.
const IN_RATE = Number(process.env.GIN_RATE ?? 0.125) / 1_000_000;
const OUT_RATE = Number(process.env.GOUT_RATE ?? 0.75) / 1_000_000;
const MODEL = process.env.GMODEL ?? "gemini-flash-lite-latest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_PATH = process.env.ENRICH_STATS ?? path.resolve(__dirname, "../../data/enrich-stats-gemini-batch.jsonl");
const KEY = (() => {
  if (process.env.GOOGLE_STUDIO_API_KEY) return process.env.GOOGLE_STUDIO_API_KEY;
  const dot = path.resolve(__dirname, "../../.env");
  const m = fs.existsSync(dot) ? fs.readFileSync(dot, "utf8").match(/^GOOGLE_STUDIO_API_KEY=(.+)$/m) : null;
  return (m?.[1] ?? "").trim();
})();

const cid = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!KEY) { console.error("[gbatch] GOOGLE_STUDIO_API_KEY not set"); process.exit(1); }
  const limit = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : undefined;
  const CHUNK = Number(process.env.CHUNK_SIZE ?? 1000);   // requests per batch job
  const BUDGET = process.env.BUDGET_USD ? Number(process.env.BUDGET_USD) : Infinity;
  const only = process.env.ONLY_SOURCE;

  let sources = scanSources({ limit });
  if (only) sources = sources.filter((s) => s.source === only);
  const store = openEnrichStore();
  const pending = store.pendingIds(sources);
  for (const s of pending) store.upsertSource(s);
  console.error(`[gbatch] model=${MODEL} | ${sources.length} sources${only ? ` (${only})` : ""}, ${pending.length} pending | chunk=${CHUNK} budget=$${BUDGET === Infinity ? "∞" : BUDGET}`);
  if (pending.length === 0) { console.error("[gbatch] nothing to do"); return; }

  const ai = new GoogleGenAI({ apiKey: KEY });
  const byCustom = new Map(pending.map((s) => [cid(s.id), s]));
  let ok = 0, bad = 0, cumIn = 0, cumOut = 0, cumCost = 0;

  for (let i = 0; i < pending.length; i += CHUNK) {
    if (rowsBudgetHit()) break;
    const slice = pending.slice(i, i + CHUNK);
    const inlined = slice.map((s) => {
      const p = buildEnrichPrompt(s);
      return {
        contents: p.user,
        config: { systemInstruction: p.system, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        metadata: { key: cid(s.id) },
      };
    });

    let job = await ai.batches.create({ model: MODEL, src: inlined as any });
    console.error(`[gbatch] job ${job.name} (${slice.length} reqs) state=${job.state}`);
    const terminal = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"]);
    while (!terminal.has(String(job.state))) {
      await sleep(15_000);
      job = await ai.batches.get({ name: job.name! });
    }
    if (job.state === "JOB_STATE_FAILED" || job.state === "JOB_STATE_EXPIRED" || job.state === "JOB_STATE_CANCELLED") {
      console.error(`[gbatch] job ${job.name} ended ${job.state}: ${JSON.stringify(job.error ?? {})}`); continue;
    }

    const responses: any[] = (job.dest as any)?.inlinedResponses ?? [];
    let cIn = 0, cOut = 0;
    for (const r of responses) {
      const key = r?.metadata?.key;
      const s = key ? byCustom.get(key) : undefined;
      if (!s) continue;
      if (r.error) { console.error(`[gbatch] err ${s.id}: ${JSON.stringify(r.error).slice(0, 120)}`); bad++; continue; }
      const resp = r.response;
      const text = resp?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      const u = resp?.usageMetadata ?? {};
      cIn += u.promptTokenCount ?? 0; cOut += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      try { store.setEnrichment(s.id, parseEnrichReply(text, s)); ok++; }
      catch (e) { console.error(`[gbatch] parse fail ${s.id}: ${(e as Error).message}`); bad++; }
    }
    cumIn += cIn; cumOut += cOut; cumCost = cumIn * IN_RATE + cumOut * OUT_RATE;
    const stat = { ts: new Date().toISOString(), job: job.name, reqs: slice.length, gotResponses: responses.length, ok, bad, cumInTok: cumIn, cumOutTok: cumOut, cumCostUsd: +cumCost.toFixed(4), perRowUsd: ok ? +(cumCost / ok).toFixed(6) : 0 };
    fs.appendFileSync(STATS_PATH, JSON.stringify(stat) + "\n");
    console.error(`[gbatch] chunk done resp=${responses.length} ok=${ok} bad=${bad} | in=${cumIn} out=${cumOut} cost≈$${cumCost.toFixed(4)}`);
  }

  function rowsBudgetHit() {
    if (cumCost >= BUDGET) { console.error(`[gbatch] BUDGET STOP at $${cumCost.toFixed(4)} (>= $${BUDGET}). Remaining pending — resume by re-running.`); return true; }
    return false;
  }

  const stillPending = store.pendingIds(sources).length;
  console.error(`[gbatch] DONE ok=${ok} bad=${bad} | in=${cumIn} out=${cumOut} cost≈$${cumCost.toFixed(4)} | still pending=${stillPending}`);
  if (ok) console.error(`[gbatch] ≈$${(cumCost / ok).toFixed(6)}/row → remaining ${stillPending} ≈ $${((cumCost / ok) * stillPending).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
