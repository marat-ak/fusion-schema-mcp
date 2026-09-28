import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempCatalog } from "./fixture.js";
import { runEnrich } from "../src/ingest.js";

/**
 * Reproduces the prod scenario: ENRICH_PROVIDER=agent, no ANTHROPIC_API_KEY/GOOGLE_STUDIO_API_KEY,
 * no ENRICH_API_KEY/ENRICH_CREDS_FILE — the agent provider authenticates to fusion-agent's
 * /api/internal/llm with INGEST_TOKEN, never with cfg.apiKey (see enrichAdapters.enrichAgent).
 * runEnrich's own "no key" pre-check must agree, or it wrongly skips every pending row before ever
 * reaching enrichOne.
 */
test("runEnrich processes agent-provider rows with no provider keys set (fetch stub, no network)", async (t) => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;

  for (const k of ["ENRICH_API_KEY", "ENRICH_CREDS_FILE", "ANTHROPIC_API_KEY", "GOOGLE_STUDIO_API_KEY", "ENRICH_MODEL", "ENRICH_URL"]) {
    delete process.env[k];
  }
  process.env.ENRICH_PROVIDER = "agent";
  process.env.INGEST_TOKEN = "test-ingest-token";

  let calledUrl = "";
  (globalThis as any).fetch = async (url: string) => {
    calledUrl = String(url);
    return new Response(
      JSON.stringify({ text: JSON.stringify({ description: "d", tablesUsed: ["T"] }), usage: {}, model: "claude-x" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  t.after(() => {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  });

  const store = (await openTempCatalog("en-", false)).db.enrich;
  await store.upsertSource({ id: "catalog:x1", source: "catalog", title: "T", originalSql: "SELECT 1", sourceHash: "h1", raw: {} });

  const result = await runEnrich(store);
  assert.equal(result.skipped, undefined, `expected no skip, got skipped="${result.skipped}"`);
  assert.equal(result.enriched, 1);
  assert.equal(result.failed, 0);
  assert.match(calledUrl, /\/api\/internal\/llm$/, "enrichAgent must call the fusion-agent internal LLM endpoint");
});
