/**
 * Enrichment provider layer — one interface, four adapters.
 *
 *   enrichOne(sql, title) -> { description, tablesUsed, lookupTypes }
 *
 * The enrich worker (ingest.ts) calls this per staged SQL. Provider + creds come from
 * getEnrichConfig() (the ONLY place env creds are read). On any failure enrichOne THROWS — the
 * worker leaves the row pending and logs; there is intentionally NO regex fallback, because the
 * whole point of the staged pipeline is model-quality tables_used.
 *
 * Implemented:  gemini (reuses the existing enrichPrompt + Gemini generateContent call).
 * Scaffolded:   anthropic, openai (documented stubs that throw "not yet implemented").
 * Implemented:  custom (our own documented POST contract — just a fetch).
 */
import crypto from "node:crypto";
import type { SqlSource } from "./sources.js";
import { buildEnrichPrompt, parseEnrichReply, buildBatchEnrichPrompt, parseBatchReply, shapeBatchItem } from "./enrichPrompt.js";
import { getEnrichConfig, type EnrichConfig } from "./enrichConfig.js";
import { recordUsage } from "./ingestStore.js";

export interface EnrichResult {
  description: string;
  tablesUsed: string[];
  lookupTypes: string[];
  /** v2: NL retrieval hooks + once-analyzed mechanics playbook (empty/null from legacy replies). */
  intents: string[];
  mechanics: string | null;
}

/**
 * Build a minimal non-OTBI SqlSource so we can reuse the EXISTING prompt + reply parser
 * (buildEnrichPrompt/parseEnrichReply). source !== "otbi" ⇒ the simple description prompt is used
 * ({ description, tablesUsed }) and otbiMeta() is not consulted.
 */
function asSource(sql: string, title: string): SqlSource {
  const t = title || "(untitled report SQL)";
  return {
    id: `ingest:${crypto.createHash("sha256").update(`${t}\n${sql}`).digest("hex").slice(0, 16)}`,
    source: "catalog",
    title: t,
    originalSql: sql,
    sourceHash: crypto.createHash("sha256").update(sql, "utf8").digest("hex"),
    raw: {},
  };
}

const backoff = (n: number, retryAfter?: string | null) =>
  new Promise<void>((r) =>
    setTimeout(r, retryAfter ? Number(retryAfter) * 1000 : Math.min(30_000, 1000 * 2 ** n)),
  );

/** Token usage of one model call (shape mirrors the Anthropic result usage). */
export interface CallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
const zeroUsage = (): CallUsage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
function normUsage(u: any): CallUsage {
  return {
    input_tokens: Number(u?.input_tokens ?? 0),
    output_tokens: Number(u?.output_tokens ?? 0),
    cache_creation_input_tokens: Number(u?.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(u?.cache_read_input_tokens ?? 0),
  };
}

/** Batch enrichment through the agent endpoint: N queries, ONE model call. Returns aligned
 *  EnrichResult[] + the call's token usage (throws on a length/shape mismatch → caller retries). */
export async function enrichAgentBatch(
  items: { sql: string; title: string }[], override?: { model?: string },
): Promise<{ results: EnrichResult[]; usage: CallUsage; model: string }> {
  const cfg = { ...getEnrichConfig(), ...(override?.model ? { model: override.model } : {}) };
  const url = cfg.url || "http://fusion-agent:8980/api/internal/llm";
  const token = process.env.INGEST_TOKEN ?? "";
  const p = buildBatchEnrichPrompt(items);
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ system: p.system, user: p.user, model: cfg.model }),
      });
    } catch (e) { lastErr = String(e); await backoff(attempt); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; await backoff(attempt); continue; }
    const j: any = await res.json();
    if (!res.ok) throw new Error(`agent-llm HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const arr = parseBatchReply(String(j.text ?? ""), items.length); // throws on count mismatch
    const results = arr.map((o) => {
      const s = shapeBatchItem(o);
      return { description: s.description, tablesUsed: s.tablesUsed, lookupTypes: [] as string[], intents: s.intents, mechanics: s.mechanics };
    });
    return { results, usage: j.usage ? normUsage(j.usage) : zeroUsage(), model: String(j.model ?? cfg.model ?? "") };
  }
  throw new Error(`agent-llm batch exhausted retries (${lastErr})`);
}

export async function enrichOne(sql: string, title: string, override?: { model?: string; provider?: string }): Promise<EnrichResult> {
  const base = getEnrichConfig();
  const provider = (override?.provider as EnrichConfig["provider"]) || base.provider;
  const switched = provider !== base.provider; // don't inherit base's key when switching providers
  const cfg: EnrichConfig = { ...base, provider, ...(override?.model ? { model: override.model } : {}), ...(switched ? { apiKey: "" } : {}) };
  // fill the SWITCHED provider's own fallback key (base's key belongs to base's provider)
  if (!cfg.apiKey) {
    if (provider === "gemini") cfg.apiKey = (process.env.GOOGLE_STUDIO_API_KEY ?? "").trim();
    else if (provider === "anthropic") cfg.apiKey = (process.env.ENRICH_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
    else if (provider === "openai") cfg.apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  }
  if (!cfg.apiKey && cfg.provider !== "custom" && cfg.provider !== "agent") {
    throw new Error(`no ENRICH_API_KEY configured for provider "${cfg.provider}"`);
  }
  switch (cfg.provider) {
    case "gemini": return enrichGemini(sql, title, cfg);
    case "anthropic": return enrichAnthropic(sql, title, cfg);
    case "openai": return enrichOpenAI(sql, title, cfg);
    case "custom": return enrichCustom(sql, title, cfg);
    case "agent": return enrichAgent(sql, title, cfg);
    default: throw new Error(`unknown ENRICH_PROVIDER "${cfg.provider}"`);
  }
}

// ---- agent (fusion-agent internal LLM endpoint) -----------------------------------------------
// One-shot completion through the Claude Agent SDK inside fusion-agent. This is the ONLY path that
// reaches premium Claude models on a SUBSCRIPTION credential — direct Messages calls with an OAuth
// token are 429'd outside the official client (verified live: direct opus-5 429, SDK opus-5 ok).
// Auth = the shared INGEST_TOKEN service secret. Retries left to the SDK; 502s bubble up as
// failures and the reenrich queue keeps the row pending.
async function enrichAgent(sql: string, title: string, cfg: EnrichConfig, tries = 3): Promise<EnrichResult> {
  const s = asSource(sql, title);
  const p = buildEnrichPrompt(s);
  const url = cfg.url || "http://fusion-agent:8980/api/internal/llm";
  const token = process.env.INGEST_TOKEN ?? "";
  let lastErr = "unknown";
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          system: p.system,
          user: p.user + "\n\nReturn ONLY the JSON object, no prose. The mechanics field is REQUIRED " +
            "and must be substantive: real join bridges (A.col -> B.col), filter idioms, aggregation " +
            "techniques and parameter handling from THIS SQL.",
          model: cfg.model,
        }),
      });
    } catch (e) { lastErr = String(e); await backoff(attempt); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; await backoff(attempt); continue; }
    const j: any = await res.json();
    if (!res.ok) throw new Error(`agent-llm HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const e = parseEnrichReply(String(j.text ?? ""), s);
    return { description: e.description, tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes, intents: e.intents ?? [], mechanics: e.mechanics ?? null };
  }
  throw new Error(`agent-llm exhausted retries (${lastErr})`);
}

// ---- gemini (IMPLEMENTED) ---------------------------------------------------------------------
// Lifted from enrichGemini.ts's per-SQL call: generateContent with JSON response + thinkingBudget 0,
// retry on 429/5xx with backoff. Reuses buildEnrichPrompt/parseEnrichReply verbatim.
async function enrichGemini(sql: string, title: string, cfg: EnrichConfig, tries = 4): Promise<EnrichResult> {
  const s = asSource(sql, title);
  const p = buildEnrichPrompt(s);
  const model = cfg.model || "gemini-flash-lite-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: p.system }] },
    contents: [{ role: "user", parts: [{ text: p.user }] }],
    // NB: no thinkingConfig — gemini-flash-lite-latest rejects thinkingBudget with HTTP 400
    // INVALID_ARGUMENT (it is already a non-thinking model). JSON response mode is all we need.
    generationConfig: { responseMimeType: "application/json" },
  };
  let lastErr = "unknown";
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      lastErr = String(e); await backoff(attempt); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`; await backoff(attempt, res.headers.get("retry-after")); continue;
    }
    const j: any = await res.json();
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const text = j.candidates?.[0]?.content?.parts?.map((x: any) => x.text).join("") ?? "";
    const e = parseEnrichReply(text, s);
    const um = j.usageMetadata ?? {};
    try {
      recordUsage({
        ts: new Date().toISOString(), model, source: "reenrich", nItems: 1,
        inputTokens: Number(um.promptTokenCount ?? 0), outputTokens: Number(um.candidatesTokenCount ?? 0),
        cacheReadTokens: 0, cacheCreationTokens: 0, sqlChars: sql.length,
      });
    } catch { /* usage table optional */ }
    return { description: e.description, tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes, intents: e.intents ?? [], mechanics: e.mechanics ?? null };
  }
  throw new Error(`gemini exhausted retries (${lastErr})`);
}

// ---- anthropic (SCAFFOLD) ---------------------------------------------------------------------
// Messages API. Shape when implementing:
//   POST {cfg.url || "https://api.anthropic.com"}/v1/messages
//   headers: "anthropic-version: 2023-06-01", "content-type: application/json"
//     auth: key starting "sk-ant-"  -> "x-api-key: <key>"
//           otherwise (OAuth token) -> "Authorization: Bearer <key>"
//   body: { model: cfg.model, max_tokens: 2048, system: <SYSTEM_DESC from enrichPrompt>,
//           messages: [{ role: "user", content: <buildEnrichPrompt().user> }] }
//   parse: response.content[0].text -> JSON { description, tablesUsed, lookupTypes }
//          (reuse parseEnrichReply for lenient extraction).
async function enrichAnthropic(sql: string, title: string, cfg: EnrichConfig, tries = 4): Promise<EnrichResult> {
  const s = asSource(sql, title);
  const p = buildEnrichPrompt(s);
  const base = (cfg.url || "https://api.anthropic.com").replace(/\/$/, "");
  // sk-ant-api* keys use x-api-key; OAuth (subscription) tokens are sk-ant-oat* / anything else
  // and need Bearer + the oauth beta header on direct Messages calls.
  const isApiKey = cfg.apiKey.startsWith("sk-ant-") && !cfg.apiKey.startsWith("sk-ant-oat");
  const auth: Record<string, string> = isApiKey
    ? { "x-api-key": cfg.apiKey }
    : { authorization: `Bearer ${cfg.apiKey}`, "anthropic-beta": "oauth-2025-04-20" };
  const body = {
    model: cfg.model || "claude-haiku-4-5",
    max_tokens: 4096, // v2 output (description+intents+mechanics) on huge SQLs must not truncate mid-JSON
    system: p.system,
    messages: [{ role: "user", content: p.user + "\n\nReturn ONLY the JSON object, no prose before or after. " +
      "The mechanics field is REQUIRED and must be substantive: extract the actual join bridges " +
      "(A.col -> B.col with real table names), filter idioms, hierarchy/aggregation techniques and " +
      "parameter handling from THIS SQL — an empty or trivial mechanics on a non-trivial query is a failure." }],
  };
  let lastErr = "unknown";
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...auth },
        body: JSON.stringify(body),
      });
    } catch (e) { lastErr = String(e); await backoff(attempt); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; await backoff(attempt, res.headers.get("retry-after")); continue; }
    const j: any = await res.json();
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const text = (j.content ?? []).map((c: any) => c.text ?? "").join("");
    const e = parseEnrichReply(text, s);
    return { description: e.description, tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes, intents: e.intents ?? [], mechanics: e.mechanics ?? null };
  }
  throw new Error(`anthropic exhausted retries (${lastErr})`);
}

// ---- openai (SCAFFOLD) ------------------------------------------------------------------------
// Chat Completions API with JSON mode. Shape when implementing:
//   POST {cfg.url || "https://api.openai.com"}/v1/chat/completions
//   headers: "Authorization: Bearer <cfg.apiKey>", "content-type: application/json"
//   body: { model: cfg.model, response_format: { type: "json_object" },
//           messages: [{ role: "system", content: <SYSTEM_DESC> },
//                      { role: "user", content: <buildEnrichPrompt().user> }] }
//   parse: choices[0].message.content -> JSON { description, tablesUsed, lookupTypes }.
async function enrichOpenAI(sql: string, title: string, cfg: EnrichConfig, tries = 4): Promise<EnrichResult> {
  const s = asSource(sql, title);
  const p = buildEnrichPrompt(s);
  const base = (cfg.url || "https://api.openai.com").replace(/\/$/, "");
  const body = {
    model: cfg.model || "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
  };
  let lastErr = "unknown";
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) { lastErr = String(e); await backoff(attempt); continue; }
    if (res.status === 429 || res.status >= 500) { lastErr = `HTTP ${res.status}`; await backoff(attempt, res.headers.get("retry-after")); continue; }
    const j: any = await res.json();
    if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const text = j.choices?.[0]?.message?.content ?? "";
    const e = parseEnrichReply(text, s);
    return { description: e.description, tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes, intents: e.intents ?? [], mechanics: e.mechanics ?? null };
  }
  throw new Error(`openai exhausted retries (${lastErr})`);
}

// ---- custom (IMPLEMENTED) ---------------------------------------------------------------------
/**
 * Our documented HTTP contract for a self-hosted enricher:
 *   POST {ENRICH_URL}
 *   headers: content-type: application/json
 *            Authorization: Bearer {ENRICH_API_KEY}   (sent only if a key is configured)
 *   body:    { "sql": string, "title": string }
 *   200:     { "description": string, "tablesUsed"?: string[], "lookupTypes"?: string[] }
 */
async function enrichCustom(sql: string, title: string, cfg: EnrichConfig): Promise<EnrichResult> {
  if (!cfg.url) throw new Error("custom provider requires ENRICH_URL");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify({ sql, title }) });
  if (!res.ok) throw new Error(`custom enrich HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  if (typeof j?.description !== "string") throw new Error("custom enrich response missing 'description'");
  return {
    description: j.description,
    tablesUsed: Array.isArray(j.tablesUsed) ? j.tablesUsed : [],
    lookupTypes: Array.isArray(j.lookupTypes) ? j.lookupTypes : [],
    intents: Array.isArray(j.intents) ? j.intents : [],
    mechanics: typeof j.mechanics === "string" ? j.mechanics : null,
  };
}
