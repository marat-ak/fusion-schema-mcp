/** Shared helpers: null normalization, name normalization, fuzzy distance. */

/** Treat literal "null"/empty as SQL NULL. */
export function nn(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  return t;
}

export function toInt(v: string | null | undefined): number | null {
  const s = nn(v);
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Normalize an object name the way an agent might pass it:
 * strip schema prefix ("FUSION.AP_INVOICES_ALL"), strip quotes/whitespace, uppercase.
 */
export function normName(raw: string): string {
  let s = (raw ?? "").trim().replace(/^["'`]|["'`]$/g, "");
  const dot = s.lastIndexOf(".");
  if (dot >= 0) s = s.slice(dot + 1);
  return s.trim().toUpperCase();
}

/** Bounded Levenshtein distance; returns `max+1` early if it exceeds `max`. */
export function levenshtein(a: string, b: string, max = 100): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Rank candidate names against a query for "did-you-mean" suggestions.
 * Combines substring containment (strong signal) with edit distance.
 */
export function suggestNames(query: string, names: string[], limit = 5): string[] {
  const q = normName(query);
  if (!q) return [];
  const scored: { name: string; score: number }[] = [];
  const maxDist = Math.max(2, Math.floor(q.length / 3));
  for (const name of names) {
    let score: number;
    if (name === q) continue; // exact handled by caller
    if (name.includes(q) || q.includes(name)) {
      // containment: rank by length delta (closer length = better)
      score = Math.abs(name.length - q.length) * 0.5;
    } else {
      const d = levenshtein(q, name, maxDist);
      if (d > maxDist) continue;
      score = d + 5; // edit-distance matches rank below containment matches
    }
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
