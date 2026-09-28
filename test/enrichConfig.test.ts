import { test } from "node:test";
import assert from "node:assert/strict";
import { getEnrichConfig, providerRequiresApiKey } from "../src/corpus/enrichConfig.js";

const ENV_KEYS = [
  "ENRICH_PROVIDER", "ENRICH_API_KEY", "ENRICH_CREDS_FILE",
  "ANTHROPIC_API_KEY", "GOOGLE_STUDIO_API_KEY", "OPENAI_API_KEY",
  "ENRICH_MODEL", "ENRICH_URL",
] as const;

/** Run fn with ONLY the given env vars set (all other ENV_KEYS cleared), then restore. */
function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { fn(); } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// Until 2026-09-28 (no-host-paths), prod's fusion-schema-mcp/.env (ANTHROPIC_API_KEY +
// GOOGLE_STUDIO_API_KEY) was mounted via a compose env_file into a stack running
// ENRICH_PROVIDER=agent — this test pinned the evidence that the agent provider never reads
// either key, with or without them present, so that env_file was always a no-op on this path
// (the verdict that let dev and prod both drop it; f9a134a).
test("agent provider never resolves an apiKey, whether or not ANTHROPIC_API_KEY/GOOGLE_STUDIO_API_KEY are set", () => {
  withEnv({ ENRICH_PROVIDER: "agent" }, () => {
    assert.equal(getEnrichConfig().apiKey, "", "no provider keys set: apiKey stays empty");
  });
  withEnv({
    ENRICH_PROVIDER: "agent",
    ANTHROPIC_API_KEY: "sk-ant-test-unused",
    GOOGLE_STUDIO_API_KEY: "gs-test-unused",
  }, () => {
    assert.equal(getEnrichConfig().apiKey, "", "provider keys set: agent still never falls back to them");
  });
});

test("gemini/anthropic/openai still resolve their own key via fallback (unchanged behavior)", () => {
  withEnv({ ENRICH_PROVIDER: "gemini", GOOGLE_STUDIO_API_KEY: "gs-test-key" }, () => {
    assert.equal(getEnrichConfig().apiKey, "gs-test-key");
  });
  withEnv({ ENRICH_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-key" }, () => {
    assert.equal(getEnrichConfig().apiKey, "sk-ant-test-key");
  });
});

// This is the single source of truth both call sites (enrichAdapters.enrichOne, ingest.runEnrich)
// must agree on for "does this provider need cfg.apiKey" — a mismatch here is what let runEnrich
// wrongly skip agent-provider rows as "no key" even though enrichAgent never reads cfg.apiKey.
test("providerRequiresApiKey: agent and custom are exempt (they don't use cfg.apiKey); the rest require one", () => {
  assert.equal(providerRequiresApiKey("agent"), false);
  assert.equal(providerRequiresApiKey("custom"), false);
  assert.equal(providerRequiresApiKey("gemini"), true);
  assert.equal(providerRequiresApiKey("anthropic"), true);
  assert.equal(providerRequiresApiKey("openai"), true);
});
