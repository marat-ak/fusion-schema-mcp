import Anthropic from "@anthropic-ai/sdk";
import { scanSources } from "./sources.js";
import { openEnrichStore } from "./enrichStore.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";

async function main() {
  const limit = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : undefined;
  const sources = scanSources({ limit });
  const store = openEnrichStore();
  const pending = store.pendingIds(sources);
  for (const s of pending) store.upsertSource(s);          // record source rows first
  console.error(`[enrich] ${sources.length} sources, ${pending.length} pending`);
  if (pending.length === 0) return;

  const byId = new Map(pending.map((s) => [s.id, s]));
  const client = new Anthropic();
  const requests = pending.map((s) => {
    const p = buildEnrichPrompt(s);
    return {
      custom_id: s.id,
      params: {
        model: "claude-haiku-4-5", max_tokens: s.source === "otbi" ? 8000 : 3000,
        system: p.system,
        output_config: { format: { type: "json_schema", schema: p.schema } },
        messages: [{ role: "user", content: p.user }],
      },
    };
  });

  const CHUNK = 5000;                 // requests per batch
  let ok = 0, bad = 0;
  const badIds: string[] = [];
  for (let i = 0; i < requests.length; i += CHUNK) {
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
    for await (const res of await client.messages.batches.results(batch.id)) {
      const s = byId.get(res.custom_id);
      if (!s) continue;
      if (res.result.type !== "succeeded") { console.error(`[enrich] result ${res.result.type} for ${res.custom_id}`); bad++; badIds.push(res.custom_id); continue; }
      const text = (res.result.message.content.find((b: any) => b.type === "text") as any)?.text ?? "";
      try { store.setEnrichment(s.id, parseEnrichReply(text, s)); ok++; }
      catch (e) { console.error(`[enrich] parse fail ${s.id}: ${(e as Error).message}`); bad++; badIds.push(s.id); }
    }
  }
  console.error(`[enrich] done ok=${ok} bad=${bad}`);
  if (badIds.length) console.error(`[enrich] bad ids (still pending, will retry next run): ${badIds.slice(0, 50).join(", ")}${badIds.length > 50 ? " …" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
