/**
 * Layout pattern corpus — "verified-DSL recipes + capability map" (layered Option B).
 *
 * Rows (kind): archetype (whole-report shapes for the structure-alignment moment) | technique
 * (composable RENDER-VERIFIED blocks[]/layout-spec recipes for emission) | antipattern
 * (recognition + redirect). Patterns the DSL can't express yet stay as prose rows
 * (dsl_support:"unsupported") — the honesty layer + a demand sensor for builder features.
 *
 * Source of truth: repo-versioned JSONL (src/corpus/layoutPatterns/patterns.jsonl) + fixtures/
 * beside it. Loaded (and embedded) into the catalog DB at startup when the JSONL content hash
 * changes. Retrieval mirrors the SQL corpus: multi-vector KNN (one vec per intent + one for
 * description), dedup by pattern, optional TEI rerank, structured filters (kind/format/dslSupport)
 * post-KNN. Payload discipline: recipes over RECIPE_INLINE_CAP ship as recipeOmitted with a
 * follow-up getLayoutPattern(id). Format-conflict advice: format-exclusive patterns matched under
 * the OTHER pinned format return WITHOUT recipes + advice (deterministic, metadata-driven).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, type LayoutPatternRow } from "../db/index.js";
import { embed } from "./embed.js";

export type { LayoutPatternRow };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_JSONL = process.env.LAYOUT_PATTERNS_FILE ?? path.resolve(__dirname, "layoutPatterns/patterns.jsonl");

/** ~300-token nesting-matrix card, attached once per session (first findLayoutPattern response). */
export const GRAMMAR_CARD = `LAYOUT COMPOSITION GRAMMAR (blocks[] / xpt) — the hard rules:
- RTF blocks[] top level: heading | paragraph | table | forEach | chart | grid | image | if/choose | callTemplate.
- forEach nests forEach/table/heading/paragraph; INNER group paths are RELATIVE (no leading /) — an absolute inner group is rejected. splitByPage on a forEach = new page per iteration.
- chart: TOP-LEVEL ONLY (inside forEach it re-emits per iteration). Keys: graphType, group:{select,by}, measures:[{label,field,agg:sum|count|avg}]. A select matching 0 nodes renders "No data to display" silently — verify against the data tree.
- grid (RTF): columns in TWIPS; cells hold chart | COMPACT non-repeating table | text | image. A repeating <?for-each?> table inside an RTF grid cell is BROKEN in BIP — that shape is XPT-only.
- xpt grid: columns in PIXELS; cells: chart | repeating DataTable | crosstab | kpis. XPT charts: EXACTLY 1 measure (seriesField for multi-series); DataTable filtering via filters[] (an XPath predicate yields 0 rows).
- subtemplate imports are ALWAYS unconditional (top-level); call-template MAY be condition-wrapped.
- format masks (date/number/currency) belong on EVERY date/amount column, incl. expr columns.
- Aggregation belongs in SQL (PIVOT/ROLLUP/window) or a datamodel group-aggregate — NEVER a wide per-cell XSLT pivot in the template.`;

// ---- load/compile from JSONL (hash-gated) ----
export async function loadLayoutPatterns(force = false): Promise<{ loaded: number; skipped?: string }> {
  if (!fs.existsSync(PATTERNS_JSONL)) return { loaded: 0, skipped: "no patterns.jsonl" };
  const raw = fs.readFileSync(PATTERNS_JSONL, "utf8");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const prev = await db().layout.jsonlHash();
  if (!force && prev === hash) return { loaded: 0, skipped: "unchanged" };

  const rows: LayoutPatternRow[] = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  // embed: description + each intent, per row
  const texts: string[] = [];
  const offsets: number[] = [];
  for (const r of rows) {
    offsets.push(texts.length);
    texts.push(`${r.name}. ${r.description}`);
    for (const it of r.intents ?? []) texts.push(it);
  }
  const vecs = await embed(texts);
  const perRow = rows.map((r, i) => {
    const n = 1 + (r.intents?.length ?? 0);
    return Array.from({ length: n }, (_v, k) => vecs[offsets[i] + k]);
  });
  await db().layout.replaceAll(rows, perRow, hash);
  console.error(`[layout-corpus] loaded ${rows.length} patterns (hash ${hash})`);
  return { loaded: rows.length };
}

// ---- retrieval ----
const RECIPE_INLINE_CAP = Number(process.env.LAYOUT_RECIPE_INLINE_CAP ?? 3600); // chars of JSON

const grammarSent = new Set<string>(); // session-ish memory: key = caller-provided or "default"

function toPayload(r: any, withRecipe: boolean): Record<string, unknown> {
  const recipe = r.recipe ? JSON.parse(r.recipe) : undefined;
  const recipeStr = r.recipe ?? "";
  const base: Record<string, unknown> = {
    id: r.id, kind: r.kind, name: r.name, format: r.format, dslSupport: r.dsl_support,
    description: r.description, whenToUse: r.when_to_use,
    ...(r.requires ? { requires: JSON.parse(r.requires) } : {}),
    ...(r.composition ? { composition: JSON.parse(r.composition) } : {}),
    ...(r.pitfalls ? { pitfalls: JSON.parse(r.pitfalls) } : {}),
    verified: r.verified,
  };
  if (r.kind === "antipattern") {
    return { ...base, trigger: r.trigger, why: r.why, ...(r.instead ? { instead: JSON.parse(r.instead) } : {}), ...(r.alternative ? { alternative: r.alternative } : {}) };
  }
  if (withRecipe && recipe != null) {
    if (recipeStr.length > RECIPE_INLINE_CAP) return { ...base, recipeOmitted: true, recipeChars: recipeStr.length, fetchWith: `getLayoutPattern("${r.id}")` };
    return { ...base, recipe };
  }
  return base;
}

export interface FindLayoutOpts {
  format?: "rtf" | "xpt";
  kinds?: string[];
  limit?: number;
  sessionKey?: string; // grammar card sent once per key
}

export async function findLayoutPattern(intent: string, opts: FindLayoutOpts = {}): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 4, 1), 8);
  const [vec] = await embed([intent]);
  const K = 40;
  const hits = await db().layout.knn(vec, K);

  // dedup by pattern (multi-vector), keep best distance
  const seen = new Map<number, any>();
  for (const h of hits) if (!seen.has(h.rid)) seen.set(h.rid, h);
  let cands = [...seen.values()].map((r) => ({ ...r, score: +(1 - (r.distance * r.distance) / 2).toFixed(3) }));

  // optional rerank via TEI (same fail-open contract as the SQL path)
  cands = await rerankPatterns(intent, cands);

  // anti-patterns are ALWAYS scanned (top 2 relevant), regardless of kind filters
  const antis = cands.filter((c) => c.kind === "antipattern").slice(0, 2);

  let main = cands.filter((c) => c.kind !== "antipattern");
  if (opts.kinds?.length) main = main.filter((c) => opts.kinds!.includes(c.kind));

  // format handling: deterministic, metadata-driven (format_exclusive rows only)
  let formatAdvice: string | null = null;
  if (opts.format) {
    const conflicting = main.filter((c) => c.format_exclusive && c.format !== "both" && c.format !== "any" && c.format !== opts.format);
    const fitting = main.filter((c) => !(c.format_exclusive && c.format !== "both" && c.format !== "any" && c.format !== opts.format));
    if (conflicting.length && (!fitting.length || conflicting[0].score > (fitting[0]?.score ?? 0))) {
      formatAdvice =
        `Top match "${conflicting[0].name}" is ${conflicting[0].format.toUpperCase()}-only and cannot be built in ${opts.format.toUpperCase()}. ` +
        `Either switch the report format or use a ${opts.format.toUpperCase()}-feasible alternative below. Recipes for the conflicting patterns are withheld until the format is resolved.`;
      // the top conflicting pattern MUST appear (recipe withheld) — it is what the advice is about
      const shown = [conflicting[0], ...fitting].slice(0, limit);
      const conflictIds = new Set(conflicting.map((c) => c.id));
      const payload = shown.map((c) => toPayload(c, !conflictIds.has(c.id)));
      return finish(payload, antis, formatAdvice, opts.sessionKey);
    }
    main = fitting;
  }
  return finish(main.slice(0, limit).map((c) => toPayload(c, true)), antis, formatAdvice, opts.sessionKey);
}

function finish(patterns: unknown[], antis: any[], formatAdvice: string | null, sessionKey?: string): Record<string, unknown> {
  const key = sessionKey ?? "default";
  const includeGrammar = !grammarSent.has(key);
  if (includeGrammar) grammarSent.add(key);
  if (grammarSent.size > 500) grammarSent.clear(); // bounded memory
  return {
    ...(formatAdvice ? { formatAdvice } : {}),
    patterns,
    antiPatterns: antis.map((a) => toPayload(a, false)),
    ...(includeGrammar ? { grammar: GRAMMAR_CARD } : {}),
  };
}

export async function getLayoutPattern(id: string): Promise<Record<string, unknown> | { error: string }> {
  const r = await db().layout.get(id);
  if (!r) return { error: `no layout pattern '${id}'` };
  const p = toPayload(r, true);
  if ((p as any).recipeOmitted) { // getter always inlines
    return { ...p, recipeOmitted: undefined, fetchWith: undefined, recipe: JSON.parse(r.recipe!) };
  }
  return p;
}

// ---- rerank (duplicated small helper; catalog.ts's is private) ----
async function rerankPatterns<T extends { name: string; description: string; when_to_use?: string }>(intent: string, rows: T[]): Promise<T[]> {
  const url = (process.env.RERANK_URL ?? "").trim();
  if (!url || rows.length < 3) return rows;
  try {
    const texts = rows.map((r) => `${r.name}\n${r.description}\n${r.when_to_use ?? ""}`.slice(0, 1500));
    // chunk to TEI's --max-client-batch-size (default 32); scores are query-relative so mergeable
    const CHUNK = Number(process.env.RERANK_MAX_BATCH ?? 32);
    const scored: { index: number; score: number }[] = [];
    for (let off = 0; off < texts.length; off += CHUNK) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Number(process.env.RERANK_TIMEOUT_MS ?? 1500));
      const res = await fetch(`${url.replace(/\/$/, "")}/rerank`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: intent, texts: texts.slice(off, off + CHUNK), raw_scores: false }), signal: ctl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return rows;
      const part = (await res.json()) as { index: number; score: number }[];
      if (!Array.isArray(part)) return rows;
      for (const s of part) scored.push({ index: s.index + off, score: s.score });
    }
    if (!scored.length) return rows;
    const order = scored.sort((a, b) => b.score - a.score).map((s) => s.index);
    const seen = new Set(order);
    return [...order.map((i) => rows[i]), ...rows.filter((_r, i) => !seen.has(i))];
  } catch { return rows; }
}
