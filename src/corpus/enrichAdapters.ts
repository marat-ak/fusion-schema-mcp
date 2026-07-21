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
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";
import { getEnrichConfig, type EnrichConfig } from "./enrichConfig.js";

export interface EnrichResult {
  description: string;
  tablesUsed: string[];
  lookupTypes: string[];
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

export async function enrichOne(sql: string, title: string): Promise<EnrichResult> {
  const cfg = getEnrichConfig();
  if (!cfg.apiKey && cfg.provider !== "custom") {
    throw new Error(`no ENRICH_API_KEY configured for provider "${cfg.provider}"`);
  }
  switch (cfg.provider) {
    case "gemini": return enrichGemini(sql, title, cfg);
    case "anthropic": return enrichAnthropic(sql, title, cfg);
    case "openai": return enrichOpenAI(sql, title, cfg);
    case "custom": return enrichCustom(sql, title, cfg);
    default: throw new Error(`unknown ENRICH_PROVIDER "${cfg.provider}"`);
  }
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
    generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
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
    return { description: e.description, tablesUsed: e.tablesUsed, lookupTypes: e.lookupTypes };
  }
  throw new Error(`gemini exhausted retries (${lastErr})`);
}

// ---- anthropic (SCAFFOLD) ---------------------------------------------------------------------
// Messages API. Shape when implementing:
//   POST {cfg.url || "https://api.anthropic.com"}/v1/messages
//   headers: "anthropic-version: 2023-06-01", "content-type: application/json"
//     auth: key starting "sk-ant-"  -> "x-api-key: <key>"
//           otherwise (OAuth token) -> "Authorization: Bearer <key>"
//   body: { model: cfg.model, max_tokens: 1024, system: <SYSTEM_DESC from enrichPrompt>,
//           messages: [{ role: "user", content: <buildEnrichPrompt().user> }] }
//   parse: response.content[0].text -> JSON { description, tablesUsed, lookupTypes }
//          (reuse parseEnrichReply for lenient extraction).
async function enrichAnthropic(_sql: string, _title: string, _cfg: EnrichConfig): Promise<EnrichResult> {
  throw new Error("anthropic enrichment not yet implemented");
}

// ---- openai (SCAFFOLD) ------------------------------------------------------------------------
// Chat Completions API with JSON mode. Shape when implementing:
//   POST {cfg.url || "https://api.openai.com"}/v1/chat/completions
//   headers: "Authorization: Bearer <cfg.apiKey>", "content-type: application/json"
//   body: { model: cfg.model, response_format: { type: "json_object" },
//           messages: [{ role: "system", content: <SYSTEM_DESC> },
//                      { role: "user", content: <buildEnrichPrompt().user> }] }
//   parse: choices[0].message.content -> JSON { description, tablesUsed, lookupTypes }.
async function enrichOpenAI(_sql: string, _title: string, _cfg: EnrichConfig): Promise<EnrichResult> {
  throw new Error("openai enrichment not yet implemented");
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
  };
}
