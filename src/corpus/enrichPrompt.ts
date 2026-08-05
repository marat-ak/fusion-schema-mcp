import type { SqlSource } from "./sources.js";
import { otbiMeta } from "./otbiMeta.js";
import type { Enrichment } from "./enrichStore.js";

const SYSTEM_OTBI =
  "You rewrite Oracle BI machine-generated SQL into clean, readable, human-style Oracle SQL " +
  "using the REAL table and column names, with no c1/T-numbered aliases. Preserve exact " +
  "semantics: same output columns (keep their display aliases), same joins (keep outer joins as " +
  "LEFT JOIN), same filters, same lookup decodes (NVL(lookup.MEANING, code) on LOOKUP_TYPE/" +
  "LOOKUP_CODE). Keep any row-level security predicate in the SQL. Return ONLY JSON.";
const SYSTEM_DESC =
  "You analyze one Oracle Fusion SQL query ONCE so an AI agent can reuse its knowledge later. " +
  "Produce THREE artifacts and return ONLY JSON:\n" +
  "1. description — 1-2 sentences of plain business language: what business data the query returns " +
  "(entities, domain, key facts, business filters like unpaid/active/for a period). No SQL mechanics.\n" +
  "2. intents — 3 to 6 short natural-language questions/tasks this query ANSWERS, phrased exactly the " +
  "way a report developer would ask a search engine. Cover DIFFERENT angles: the whole report intent, " +
  "and each notable lookup/sub-capability it demonstrates (e.g. 'how to get the carrier name for a " +
  "sales order fulfillment line', 'shipping and billing addresses for a delivery', 'link a shipment " +
  "delivery to its source order lines'). Plain words, no table names, no SQL terms.\n" +
  "3. mechanics — a compact engineering playbook another developer can BUILD FROM WITHOUT reading the " +
  "SQL: the join bridges with REAL table names and key columns (A.col -> B.col), filter idioms " +
  "(status/version/context/date filters and WHY), dedup or aggregation techniques (KEEP DENSE_RANK, " +
  "LISTAGG, SUM(CASE) pivots, per-key CTEs), parameter handling (:BINDs, defaults, multi-select), and " +
  "any security predicate. Use terse bullet lines, <= 20 lines. Skip boilerplate column lists.\n" +
  "Do NOT mention technical/ETL noise (rownum watermarks, last-update incremental filters) in " +
  "description or intents; mechanics may note them in one line if structurally important.";

export const ENRICH_SCHEMA = {
  type: "object",
  properties: {
    cleanSql: { type: "string" },
    description: { type: "string" },
    intents: { type: "array", items: { type: "string" } },
    mechanics: { type: "string" },
    tablesUsed: { type: "array", items: { type: "string" } },
    lookupTypes: { type: "array", items: { type: "string" } },
  },
  required: ["description"],
  additionalProperties: false,
} as const;

export function buildEnrichPrompt(s: SqlSource): { system: string; user: string; schema: object } {
  if (s.source === "otbi") {
    const m = otbiMeta(s.raw);
    const cols = (s.raw?.logicalColumns ?? []).join(", ");
    const user =
      `Subject area / table: ${s.title}\n` +
      `Output columns: ${cols}\n` +
      `Real tables: ${m.tablesUsed.join(", ")}\n` +
      `Lookup types: ${m.lookupTypes.join(", ") || "none"}\n` +
      `Filters: ${m.filters.join(" | ") || "none"}\n\n` +
      `Machine SQL to rewrite:\n${s.originalSql}\n\n` +
      `Return JSON { cleanSql, description, intents, mechanics, tablesUsed, lookupTypes }. intents = ` +
      `3-6 short natural-language questions this query answers (plain words, no table names); ` +
      `mechanics = terse bullet playbook of join paths, filters, aggregation idioms with real table names.`;
    return { system: SYSTEM_OTBI, user, schema: ENRICH_SCHEMA };
  }
  const user =
    `Query title: ${s.title}\n\nSQL:\n${s.originalSql}\n\n` +
    `Return JSON { description, intents, mechanics, tablesUsed }.`;
  return { system: SYSTEM_DESC, user, schema: ENRICH_SCHEMA };
}

/**
 * Lenient JSON extraction — models occasionally wrap the object in ```json fences or append
 * prose after it ("Unexpected non-whitespace character after JSON"). Strip fences, then
 * balance-match the first complete {...} object. Truncated JSON (never balances) still throws.
 */
function extractJson(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return JSON.parse(t.slice(start, i + 1)); }
    }
  }
  throw new Error("no parseable JSON object");
}

export function parseEnrichReply(text: string, s: SqlSource): Enrichment {
  const j = extractJson(text);
  if (typeof j.description !== "string") throw new Error(`enrich reply missing description for ${s.id}`);
  const m = s.source === "otbi" ? otbiMeta(s.raw) : { lookupTypes: [], joins: [], filters: [], securityPredicate: null, tablesUsed: [] };
  return {
    cleanSql: typeof j.cleanSql === "string" && j.cleanSql.trim() ? j.cleanSql : s.originalSql,
    description: j.description,
    intents: Array.isArray(j.intents) ? j.intents.filter((x: unknown) => typeof x === "string" && (x as string).trim()).slice(0, 8) : [],
    mechanics: typeof j.mechanics === "string" && j.mechanics.trim() ? j.mechanics.trim() : null,
    tablesUsed: Array.isArray(j.tablesUsed) && j.tablesUsed.length ? j.tablesUsed : m.tablesUsed,
    lookupTypes: Array.isArray(j.lookupTypes) && j.lookupTypes.length ? j.lookupTypes : m.lookupTypes,
    joins: m.joins,
    filters: m.filters,
    securityPredicate: m.securityPredicate,
  };
}
