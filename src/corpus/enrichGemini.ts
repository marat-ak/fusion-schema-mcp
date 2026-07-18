import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSources, type SqlSource } from "./sources.js";
import { openEnrichStore } from "./enrichStore.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";

// Gemini Flash-Lite. Rates are env-overridable; defaults are a conservative non-batch
// estimate — the TRUE cost is your Google console. We log exact token counts so you can reconcile.
// Defaults = Gemini 3.1 Flash-Lite STANDARD ($0.25 in / $1.50 out per 1M) — the cheapest
// flash-lite a new AI Studio key can use (2.5/2.0 flash-lite are blocked for new users).
// Override for batch (0.125/0.75) or another model via GIN_RATE/GOUT_RATE.
const IN_RATE = Number(process.env.GIN_RATE ?? 0.25) / 1_000_000;
const OUT_RATE = Number(process.env.GOUT_RATE ?? 1.50) / 1_000_000;
const MODEL = process.env.GMODEL ?? "gemini-flash-lite-latest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_PATH = process.env.ENRICH_STATS ?? path.resolve(__dirname, "../../data/enrich-stats-gemini.jsonl");

const KEY = (() => {
  const envK = process.env.GOOGLE_STUDIO_API_KEY;
  if (envK) return envK;
  const dot = path.resolve(__dirname, "../../.env");
  const m = fs.existsSync(dot) ? fs.readFileSync(dot, "utf8").match(/^GOOGLE_STUDIO_API_KEY=(.+)$/m) : null;
  return (m?.[1] ?? "").trim();
})();

const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

type Usage = { inTok: number; outTok: number };

async function callGemini(s: SqlSource, tries = 4): Promise<{ enrichment: any; usage: Usage } | null> {
  const p = buildEnrichPrompt(s);
  const body = {
    system_instruction: { parts: [{ text: p.system }] },
    contents: [{ role: "user", parts: [{ text: p.user }] }],
    generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  };
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try { res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { await backoff(attempt); continue; }
    if (res.status === 429 || res.status >= 500) { await backoff(attempt, res.headers.get("retry-after")); continue; }
    const j: any = await res.json();
    if (!res.ok) { console.error(`[gemini] ${s.id} HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`); return null; }
    const text = j.candidates?.[0]?.content?.parts?.map((x: any) => x.text).join("") ?? "";
    const u = j.usageMetadata ?? {};
    const usage: Usage = { inTok: u.promptTokenCount ?? 0, outTok: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
    try { return { enrichment: parseEnrichReply(text, s), usage }; }
    catch (e) { console.error(`[gemini] parse fail ${s.id}: ${(e as Error).message}`); return null; }
  }
  console.error(`[gemini] ${s.id} exhausted retries`);
  return null;
}

const backoff = (n: number, retryAfter?: string | null) =>
  new Promise((r) => setTimeout(r, retryAfter ? Number(retryAfter) * 1000 : Math.min(30_000, 1000 * 2 ** n)));

async function main() {
  if (!KEY) { console.error("[gemini] GOOGLE_STUDIO_API_KEY not set"); process.exit(1); }
  const limit = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : undefined;
  const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
  const BUDGET = process.env.BUDGET_USD ? Number(process.env.BUDGET_USD) : Infinity;
  const only = process.env.ONLY_SOURCE; // 'otbi' | 'catalog' | 'view' — restrict this run

  let sources = scanSources({ limit });
  if (only) sources = sources.filter((s) => s.source === only);
  const store = openEnrichStore();
  let pending = store.pendingIds(sources);
  for (const s of pending) store.upsertSource(s);
  console.error(`[gemini] model=${MODEL} | ${sources.length} sources${only ? ` (${only})` : ""}, ${pending.length} pending | concurrency=${CONCURRENCY} budget=$${BUDGET === Infinity ? "∞" : BUDGET}`);
  if (pending.length === 0) { console.error("[gemini] nothing to do"); return; }

  let ok = 0, bad = 0, cumIn = 0, cumOut = 0, cumCost = 0, stopped = false;
  let idx = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      if (stopped) return;
      const i = idx++;
      if (i >= pending.length) return;
      const s = pending[i];
      const r = await callGemini(s);
      if (!r) { bad++; continue; }
      store.setEnrichment(s.id, r.enrichment);
      ok++; cumIn += r.usage.inTok; cumOut += r.usage.outTok;
      cumCost = cumIn * IN_RATE + cumOut * OUT_RATE;
      if (ok % 50 === 0 || cumCost >= BUDGET) {
        const rate = ok / ((Date.now() - t0) / 1000);
        console.error(`[gemini] ok=${ok} bad=${bad} | in=${cumIn} out=${cumOut} cost≈$${cumCost.toFixed(4)} | ${rate.toFixed(1)} rows/s`);
        fs.appendFileSync(STATS_PATH, JSON.stringify({ ts: new Date().toISOString(), ok, bad, cumInTok: cumIn, cumOutTok: cumOut, cumCostUsd: +cumCost.toFixed(4), perRowUsd: +(cumCost / ok).toFixed(6) }) + "\n");
      }
      if (cumCost >= BUDGET) { stopped = true; console.error(`[gemini] BUDGET STOP at $${cumCost.toFixed(4)} (>= $${BUDGET}). Remaining rows stay pending — resume by re-running.`); return; }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const stillPending = store.pendingIds(sources).length;
  console.error(`[gemini] DONE ok=${ok} bad=${bad} | in=${cumIn} out=${cumOut} cost≈$${cumCost.toFixed(4)} | still pending=${stillPending}`);
  if (ok) {
    const perRow = cumCost / ok;
    console.error(`[gemini] ≈$${perRow.toFixed(6)}/row → remaining ${stillPending} ≈ $${(perRow * stillPending).toFixed(2)} more for full corpus`);
  }
  fs.appendFileSync(STATS_PATH, JSON.stringify({ ts: new Date().toISOString(), final: true, ok, bad, cumInTok: cumIn, cumOutTok: cumOut, cumCostUsd: +cumCost.toFixed(4), stillPending }) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
