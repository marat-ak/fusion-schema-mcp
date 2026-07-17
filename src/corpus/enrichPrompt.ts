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
  "You describe an Oracle SQL query for retrieval: what business question it answers and its key " +
  "tables, joins, filters, and lookups, in 1-3 sentences. Return ONLY JSON.";

export const ENRICH_SCHEMA = {
  type: "object",
  properties: {
    cleanSql: { type: "string" },
    description: { type: "string" },
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
      `Return JSON { cleanSql, description, tablesUsed, lookupTypes }.`;
    return { system: SYSTEM_OTBI, user, schema: ENRICH_SCHEMA };
  }
  const user =
    `Query title: ${s.title}\n\nSQL:\n${s.originalSql}\n\n` +
    `Return JSON { description, tablesUsed }.`;
  return { system: SYSTEM_DESC, user, schema: ENRICH_SCHEMA };
}

export function parseEnrichReply(text: string, s: SqlSource): Enrichment {
  const j = JSON.parse(text);
  if (typeof j.description !== "string") throw new Error(`enrich reply missing description for ${s.id}`);
  const m = s.source === "otbi" ? otbiMeta(s.raw) : { lookupTypes: [], joins: [], filters: [], securityPredicate: null, tablesUsed: [] };
  return {
    cleanSql: typeof j.cleanSql === "string" && j.cleanSql.trim() ? j.cleanSql : s.originalSql,
    description: j.description,
    tablesUsed: Array.isArray(j.tablesUsed) && j.tablesUsed.length ? j.tablesUsed : m.tablesUsed,
    lookupTypes: Array.isArray(j.lookupTypes) && j.lookupTypes.length ? j.lookupTypes : m.lookupTypes,
    joins: m.joins,
    filters: m.filters,
    securityPredicate: m.securityPredicate,
  };
}
