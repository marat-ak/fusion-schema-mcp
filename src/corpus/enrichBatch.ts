import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { scanSources } from "./sources.js";
import { openEnrichStore } from "./enrichStore.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";

// Haiku 4.5 Batch API rates (50% off standard $1/$5 per 1M): $0.50 in / $2.50 out.
const IN_RATE = 0.5 / 1_000_000;
const OUT_RATE = 2.5 / 1_000_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_PATH = process.env.ENRICH_STATS ?? path.resolve(__dirname, "../../data/enrich-stats.jsonl");

async function main() {
  const limit = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : undefined;
  const CHUNK = process.env.CHUNK_SIZE ? Number(process.env.CHUNK_SIZE) : 1000;
  const BUDGET = process.env.BUDGET_USD ? Number(process.env.BUDGET_USD) : Infinity;

  const sources = scanSources({ limit });
  const store = openEnrichStore();
  const pending = store.pendingIds(sources);
  for (const s of pending) store.upsertSource(s); // record source rows first (resume-safe)
  console.error(`[enrich] ${sources.length} sources scanned, ${pending.length} pending, budget=$${BUDGET === Infinity ? "∞" : BUDGET}`);
  if (pending.length === 0) { console.error("[enrich] nothing to do"); return; }

  // Batch API caps custom_id at 64 chars; our source ids (full OTBI filenames) exceed it.
  // Use a stable 40-hex-char hash of the id as custom_id and map it back.
  const cid = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 40);
  const byCustom = new Map(pending.map((s) => [cid(s.id), s]));
  const client = new Anthropic();
  const requests = pending.map((s) => {
    const p = buildEnrichPrompt(s);
    return {
      custom_id: cid(s.id),
      params: {
        model: "claude-haiku-4-5", max_tokens: s.source === "otbi" ? 8000 : 3000,
        system: p.system,
        output_config: { format: { type: "json_schema", schema: p.schema } },
        messages: [{ role: "user", content: p.user }],
      },
    };
  });

  let ok = 0, bad = 0, cumIn = 0, cumOut = 0, cumCost = 0, rowsDone = 0;
  const badIds: string[] = [];

  for (let i = 0; i < requests.length; i += CHUNK) {
    // Budget guard: project the next chunk from the running per-row average; stop before overspending.
    if (rowsDone > 0) {
      const perRow = cumCost / rowsDone;
      const remaining = Math.min(CHUNK, requests.length - i);
      if (cumCost + perRow * remaining > BUDGET) {
        console.error(`[enrich] BUDGET STOP: cum=$${cumCost.toFixed(4)}, next chunk ~$${(perRow * remaining).toFixed(4)} would exceed $${BUDGET}. ${requests.length - i} rows left pending (resume by re-running).`);
        break;
      }
    }

    const slice = requests.slice(i, i + CHUNK);
    const batch = await client.messages.batches.create({ requests: slice as any });
    console.error(`[enrich] batch ${batch.id} (${slice.length} reqs) submitted`);
    for (;;) {
      let b;
      try { b = await client.messages.batches.retrieve(batch.id); }
      catch (e) { console.error(`[enrich] poll error, retrying: ${(e as Error).message}`); await new Promise((r) => setTimeout(r, 15_000)); continue; }
      if (b.processing_status === "ended") break;
      await new Promise((r) => setTimeout(r, 30_000));
    }

    let cIn = 0, cOut = 0, cOk = 0, cBad = 0;
    for await (const res of await client.messages.batches.results(batch.id)) {
      const s = byCustom.get(res.custom_id);
      if (!s) continue;
      if (res.result.type !== "succeeded") { console.error(`[enrich] result ${res.result.type} for ${s.id}`); bad++; cBad++; badIds.push(s.id); continue; }
      const usage = res.result.message.usage as any;
      cIn += usage?.input_tokens ?? 0;
      cOut += usage?.output_tokens ?? 0;
      const text = (res.result.message.content.find((b: any) => b.type === "text") as any)?.text ?? "";
      try { store.setEnrichment(s.id, parseEnrichReply(text, s)); ok++; cOk++; }
      catch (e) { console.error(`[enrich] parse fail ${s.id}: ${(e as Error).message}`); bad++; cBad++; badIds.push(s.id); }
    }

    const chunkCost = cIn * IN_RATE + cOut * OUT_RATE;
    cumIn += cIn; cumOut += cOut; cumCost += chunkCost; rowsDone += cOk;
    const stat = {
      ts: new Date().toISOString(), batchId: batch.id, reqs: slice.length,
      ok: cOk, bad: cBad, inTok: cIn, outTok: cOut,
      chunkCostUsd: +chunkCost.toFixed(4), cumOkRows: rowsDone,
      cumInTok: cumIn, cumOutTok: cumOut, cumCostUsd: +cumCost.toFixed(4),
      perRowUsd: rowsDone ? +(cumCost / rowsDone).toFixed(6) : 0,
    };
    fs.appendFileSync(STATS_PATH, JSON.stringify(stat) + "\n");
    console.error(`[enrich] chunk done ok=${cOk} bad=${cBad} | in=${cIn} out=${cOut} cost=$${chunkCost.toFixed(4)} | CUM rows=${rowsDone} cost=$${cumCost.toFixed(4)} ($${stat.perRowUsd}/row)`);
  }

  const stillPending = store.pendingIds(sources).length;
  console.error(`[enrich] DONE ok=${ok} bad=${bad} | total in=${cumIn} out=${cumOut} cost=$${cumCost.toFixed(4)} | still pending=${stillPending}`);
  if (rowsDone) {
    const perRow = cumCost / rowsDone;
    console.error(`[enrich] projection: $${perRow.toFixed(6)}/row → full ${stillPending + rowsDone} rows ≈ $${(perRow * (stillPending + rowsDone)).toFixed(2)}`);
  }
  if (badIds.length) console.error(`[enrich] bad ids (still pending, retry next run): ${badIds.slice(0, 30).join(", ")}${badIds.length > 30 ? " …" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
