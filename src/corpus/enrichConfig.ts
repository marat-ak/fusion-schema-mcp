/**
 * Single source of enrichment credentials + config. This is the ONLY place env creds are read for
 * the runtime ingest enrich worker, so it can be swapped for a wallet/secret-manager later without
 * touching the adapters. Adapters (enrichAdapters.ts) receive a resolved EnrichConfig; they never
 * read process.env themselves.
 *
 * Env:
 *   ENRICH_PROVIDER     "gemini" | "anthropic" | "openai" | "custom"   (default "gemini")
 *   ENRICH_API_KEY      provider API key / token (takes precedence over provider-specific fallbacks)
 *   ENRICH_MODEL        model id override (gemini defaults to gemini-flash-lite-latest)
 *   ENRICH_URL          base/endpoint URL (required for "custom"; optional override for others)
 *   ENRICH_CONCURRENCY  worker-pool size for the enrich worker (default 8)
 *
 * Key fallbacks when ENRICH_API_KEY is unset: gemini -> GOOGLE_STUDIO_API_KEY, anthropic ->
 * ANTHROPIC_API_KEY, openai -> OPENAI_API_KEY. Each also falls back to the repo-root .env file so
 * local runs work without exporting env (mirrors enrichGemini.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type EnrichProvider = "gemini" | "anthropic" | "openai" | "custom" | "agent";

export interface EnrichConfig {
  provider: EnrichProvider;
  apiKey: string;
  model?: string;
  url?: string;
  concurrency: number;
}

/** Best-effort read of KEY=VALUE from the repo-root .env (never throws). */
function fromDotEnv(key: string): string {
  try {
    const dot = path.resolve(__dirname, "../../.env");
    if (!fs.existsSync(dot)) return "";
    const m = fs.readFileSync(dot, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
    return (m?.[1] ?? "").trim();
  } catch {
    return "";
  }
}

function envOrDotEnv(key: string): string {
  return (process.env[key] ?? "").trim() || fromDotEnv(key);
}

export function getEnrichConfig(): EnrichConfig {
  const provider = ((process.env.ENRICH_PROVIDER ?? "gemini").trim() || "gemini") as EnrichProvider;
  const concurrency = Math.max(1, Number(process.env.ENRICH_CONCURRENCY ?? 8) || 8);

  let apiKey = envOrDotEnv("ENRICH_API_KEY");
  // ENRICH_CREDS_FILE: JSON {mode,value} (the fusion-agent container credential, e.g. a Claude
  // subscription OAuth token) mounted read-only — lets enrichment ride the Max subscription
  // without copying the secret into env/compose.
  if (!apiKey) {
    const credsFile = (process.env.ENRICH_CREDS_FILE ?? "").trim();
    if (credsFile && fs.existsSync(credsFile)) {
      try { apiKey = String(JSON.parse(fs.readFileSync(credsFile, "utf8")).value ?? "").trim(); } catch { /* fall through */ }
    }
  }
  if (!apiKey) {
    if (provider === "gemini") apiKey = envOrDotEnv("GOOGLE_STUDIO_API_KEY");
    else if (provider === "anthropic") apiKey = envOrDotEnv("ANTHROPIC_API_KEY");
    else if (provider === "openai") apiKey = envOrDotEnv("OPENAI_API_KEY");
  }

  const model = (process.env.ENRICH_MODEL ?? "").trim() ||
    (provider === "gemini" ? "gemini-flash-lite-latest" : undefined);
  const url = (process.env.ENRICH_URL ?? "").trim() ||
    (provider === "agent" ? "http://fusion-agent:8980/api/internal/llm" : undefined);

  return { provider, apiKey, model, url, concurrency };
}
