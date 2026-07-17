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
        model: "claude-haiku-4-5", max_tokens: 4000,
        system: p.system,
        output_config: { format: { type: "json_schema", schema: p.schema } },
        messages: [{ role: "user", content: p.user }],
      },
    };
  });

  const batch = await client.messages.batches.create({ requests: requests as any });
  console.error(`[enrich] batch ${batch.id} submitted`);
  // poll
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  let ok = 0, bad = 0;
  for await (const res of await client.messages.batches.results(batch.id)) {
    const s = byId.get(res.custom_id);
    if (!s) continue;
    if (res.result.type !== "succeeded") { bad++; continue; }
    const text = (res.result.message.content.find((b: any) => b.type === "text") as any)?.text ?? "";
    try { store.setEnrichment(s.id, parseEnrichReply(text, s)); ok++; }
    catch (e) { console.error(`[enrich] parse fail ${s.id}: ${(e as Error).message}`); bad++; }
  }
  console.error(`[enrich] done ok=${ok} bad=${bad}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
