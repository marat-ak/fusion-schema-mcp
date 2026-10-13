/**
 * Offline lint of OTBI logical SQL against the presentation catalog (`checkOtbiSql`).
 *
 * Reference forms, both accepted (verified 2026-09-28 on downloaded data models + the crawl probes):
 *   three-part   SELECT "SA"."Folder"."Column" … FROM "SA"                 (BI EE datasets in .xdm files)
 *   two-part     SELECT "Column" FROM "SA"."Folder"                         (the crawl's probe form)
 *   folder.col   SELECT "Folder"."Column" … FROM "SA"                        (mixed, also seen in DMs)
 * Names are matched VERBATIM first; a case- / whitespace-insensitive match is accepted with a
 * `name_spelling` warning carrying the canonical spelling. Nothing here runs SQL: the resolver is the
 * catalog DB library's `otbi` group (or an in-memory stand-in in the unit tests).
 */
import { levenshtein } from "../util.js";

export interface LintCatalog {
  subjectAreaNames(): Promise<string[]>;
  folders(subjectArea: string): Promise<{ name: string; kind: string }[]>;
  columns(subjectArea: string, folder: string): Promise<{ name: string; kind: string; aggregation: string | null; data_type: string | null }[]>;
  foldersWithColumn(subjectArea: string, column: string): Promise<string[]>;
}

export interface LintIssue { code: string; message: string; ref?: string; suggestions?: string[] }
export interface LintResolved {
  ref: string; subjectArea: string; folder: string; column: string; kind: string; dataType: string | null; aggregation: string | null;
  clause: string;
}
export interface LintResult {
  ok: boolean;
  subjectArea: string | null;
  fromFolder: string | null;
  errors: LintIssue[];
  warnings: LintIssue[];
  resolved: LintResolved[];
  measures: string[];
  notes: string[];
}

type Tok = { t: "ident" | "word" | "punct" | "str" | "bind" | "num"; v: string };

const CLAUSE_WORDS = new Set(["select", "from", "where", "group", "having", "order", "fetch", "limit", "union", "minus", "intersect"]);
const AGG = new Set(["sum", "count", "avg", "min", "max"]);

/** Tokenize: comments dropped, string literals kept as one token, quoted identifiers unescaped. */
export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { const j = sql.indexOf("\n", i); i = j === -1 ? n : j + 1; continue; }
    if (c === "/" && sql[i + 1] === "*") { const j = sql.indexOf("*/", i + 2); i = j === -1 ? n : j + 2; continue; }
    if (c === '"') {
      let j = i + 1, v = "";
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += sql[j++];
      }
      out.push({ t: "ident", v }); i = j + 1; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out.push({ t: "str", v: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      let j = i + 1; while (j < n && /[\w]/.test(sql[j])) j++;
      out.push({ t: "bind", v: sql.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < n && /[\w$#]/.test(sql[j])) j++;
      out.push({ t: "word", v: sql.slice(i, j) }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < n && /[\w.]/.test(sql[j])) j++;
      out.push({ t: "num", v: sql.slice(i, j) }); i = j; continue;
    }
    out.push({ t: "punct", v: c }); i++;
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const loose = (s: string) => norm(s).replace(/^(-+\s*)+/, "");

/** Nearest names for a miss: exact-after-normalisation first, then containment, then edit distance. */
export function nearestNames(q: string, names: string[], limit = 5): string[] {
  const nq = norm(q), lq = loose(q);
  const scored: { name: string; score: number }[] = [];
  const maxDist = Math.max(2, Math.floor(lq.length / 4));
  for (const name of names) {
    const nn = norm(name), ln = loose(name);
    let score: number;
    if (nn === nq) score = 0;
    else if (ln === lq) score = 0.5;
    else if (ln.includes(lq) || lq.includes(ln)) score = 1 + Math.abs(ln.length - lq.length) * 0.01;
    else {
      const d = levenshtein(lq, ln, maxDist);
      if (d > maxDist) continue;
      score = 2 + d;
    }
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/** Verbatim match, else the ONE name equal after case/whitespace normalisation (reported as a spelling warning). */
function matchName(q: string, names: string[]): { name: string; exact: boolean } | null {
  if (names.includes(q)) return { name: q, exact: true };
  const nq = norm(q);
  const hits = names.filter((n) => norm(n) === nq);
  return hits.length === 1 ? { name: hits[0], exact: false } : null;
}

type Ref = { parts: string[]; clause: string; block: Block };
/** One SELECT block (a statement, a derived table or a UNION branch): its own FROM context. */
type Block = {
  depth: number; clause: string; parent: Block | null;
  subjectAreas: string[];                       // verbatim SA names as written in FROM
  fromFolders: { sa: string; folder: string; alias: string | null; extraParts: boolean }[];
  derivedAliases: Set<string>;                  // `( subquery ) alias` names
  aliases: Set<string>;                         // output aliases of the select list
  hasSelect: boolean; selectStar: boolean; hasFetch: boolean; subqueryInFrom: boolean;
};
const newBlock = (depth: number, parent: Block | null): Block => ({
  depth, clause: "", parent, subjectAreas: [], fromFolders: [], derivedAliases: new Set(), aliases: new Set(),
  hasSelect: false, selectStar: false, hasFetch: false, subqueryInFrom: false,
});

// tokens after which a lone quoted identifier in a select list is still a reference (an expression
// start), not an output alias
const EXPR_START_WORDS = new Set(["select", "distinct", "and", "or", "not", "in", "when", "then", "else", "case", "by", "on", "like", "between", "is", "all", "exists", "having", "where", "union", "minus", "intersect"]);
const EXPR_START_PUNCT = new Set([",", "(", "=", "<", ">", "+", "-", "*", "/", "|", "!"]);

/** Walk the tokens into SELECT blocks; collect identifier chains per block, FROM entries, aliases. */
function collect(toks: Tok[]) {
  const refs: Ref[] = [];
  const aggs: string[] = [];
  const blocks: Block[] = [];
  const setStatements: string[] = [];
  let depth = 0;
  let cur: Block = newBlock(0, null);
  blocks.push(cur);
  let inSetStatement = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (inSetStatement) { if (t.t === "punct" && t.v === ";") inSetStatement = false; continue; }
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
        if (toks[i + 1]?.t === "word" && toks[i + 1].v.toLowerCase() === "select") {
          if (cur.clause === "from") cur.subqueryInFrom = true;
          cur = newBlock(depth, cur); blocks.push(cur);
        }
      } else if (t.v === ")") {
        depth = Math.max(0, depth - 1);
        while (cur.parent && cur.depth > depth) cur = cur.parent;
        // `( subquery ) alias` — the alias names a derived table of the enclosing block
        const nx = toks[i + 1];
        if (cur.clause === "from" && nx && (nx.t === "ident" || (nx.t === "word" && !CLAUSE_WORDS.has(nx.v.toLowerCase()) && !["left", "right", "inner", "outer", "full", "join", "on", "as"].includes(nx.v.toLowerCase())))) {
          cur.derivedAliases.add(nx.v); i++;
        }
      } else if (t.v === "*" && cur.clause === "select" && toks[i - 1]?.t === "word") cur.selectStar = true;
      else if (t.v === ";") { cur = blocks[0]; depth = 0; }
      continue;
    }
    if (t.t === "word") {
      const w = t.v.toLowerCase();
      if (w === "set" && toks[i + 1]?.t === "word" && toks[i + 1].v.toLowerCase() === "variable") { inSetStatement = true; setStatements.push(t.v); continue; }
      if (CLAUSE_WORDS.has(w)) {
        if (w === "select") {
          if (cur.hasSelect && cur.clause !== "") { // a UNION branch at the same depth = a sibling block
            cur = newBlock(depth, cur.parent); blocks.push(cur);
          }
          cur.hasSelect = true;
        }
        if (w === "fetch" || w === "limit") cur.hasFetch = true;
        cur.clause = w;
      }
      if (AGG.has(w) && toks[i + 1]?.t === "punct" && toks[i + 1].v === "(") aggs.push(t.v);
      if (/^report_(sum|aggregate|count|avg|min|max)$/.test(w)) aggs.push(t.v);
      continue;
    }
    if (t.t !== "ident") continue;
    const prev = toks[i - 1];
    if (prev?.t === "punct" && prev.v === ".") continue; // NQ_SESSION."USER" — a session variable, not a column
    const parts = [t.v];
    let j = i;
    while (toks[j + 1]?.t === "punct" && toks[j + 1].v === "." && toks[j + 2]?.t === "ident") { parts.push(toks[j + 2].v); j += 2; }
    if (cur.clause === "from") {
      // "SA" | "SA"."Folder", optionally followed by an alias ident/word
      const nx = toks[j + 1];
      let alias: string | null = null;
      if (nx && (nx.t === "ident" || (nx.t === "word" && !CLAUSE_WORDS.has(nx.v.toLowerCase()) && !["left", "right", "inner", "outer", "full", "join", "on", "as"].includes(nx.v.toLowerCase())))) { alias = nx.v; j++; }
      else if (nx?.t === "word" && nx.v.toLowerCase() === "as" && toks[j + 2]?.t === "ident") { alias = toks[j + 2].v; j += 2; }
      refs.push({ parts, clause: "from", block: cur });
      cur.fromFolders.push({ sa: parts[0], folder: parts[1] ?? "", alias, extraParts: parts.length > 2 });
      i = j; continue;
    }
    const prevIsExprStart = !prev || (prev.t === "punct" && EXPR_START_PUNCT.has(prev.v)) || (prev.t === "word" && EXPR_START_WORDS.has(prev.v.toLowerCase()));
    if (parts.length === 1 && cur.clause === "select" && !prevIsExprStart) { cur.aliases.add(t.v); i = j; continue; }
    refs.push({ parts, clause: cur.clause || "select", block: cur });
    i = j;
  }
  return { refs, aggs, blocks, setStatements };
}

export async function lintOtbiSql(sql: string, cat: LintCatalog): Promise<LintResult> {
  const errors: LintIssue[] = [], warnings: LintIssue[] = [], resolved: LintResolved[] = [], notes: string[] = [];
  const toks = tokenize(sql);
  const { refs, aggs, blocks, setStatements } = collect(toks);
  const saNames = await cat.subjectAreaNames();
  const folderCache = new Map<string, { name: string; kind: string }[]>();
  const foldersOf = async (sa: string) => { let f = folderCache.get(sa); if (!f) { f = await cat.folders(sa); folderCache.set(sa, f); } return f; };
  const colCache = new Map<string, { name: string; kind: string; aggregation: string | null; data_type: string | null }[]>();
  const columnsOf = async (sa: string, folder: string) => { const k = `${sa}\u0000${folder}`; let c = colCache.get(k); if (!c) { c = await cat.columns(sa, folder); colCache.set(k, c); } return c; };

  if (!blocks.some((b) => b.hasSelect)) errors.push({ code: "not_a_select", message: "no `select` found" });
  if (setStatements.length) notes.push(`${setStatements.length} SET VARIABLE statement(s) precede the query — passed through, not checked`);
  if (blocks.some((b) => b.selectStar)) errors.push({ code: "select_star", message: "`select *` is not valid logical SQL — list the presentation columns" });
  const branches = blocks.filter((b) => b.hasSelect).length;
  if (branches > 1) notes.push(`${branches} select blocks (derived tables / set-operator branches) — each is checked against its own FROM`);

  // ---- FROM of every block: "SA" | "SA"."Folder" [alias]; the SA set of the whole query
  const querySAs = new Set<string>();
  const folderMatchWarned = new Set<string>();
  for (const b of blocks) {
    const seen = new Set<string>();
    for (const f of b.fromFolders) {
      const refText = `"${f.sa}"${f.folder ? `."${f.folder}"` : ""}`;
      if (f.extraParts) errors.push({ code: "invalid_reference", message: `FROM takes "Subject Area" or "Subject Area"."Folder", not a column reference`, ref: refText });
      const m = matchName(f.sa, saNames);
      if (!m) {
        // a derived-table alias or a word-alias used as a table name is not a subject area
        errors.push({ code: "unknown_subject_area", message: `subject area "${f.sa}" is not in the catalog`, ref: refText, suggestions: nearestNames(f.sa, saNames) });
        continue;
      }
      if (!m.exact) warnings.push({ code: "name_spelling", message: `subject area "${f.sa}" matched "${m.name}" ignoring case/whitespace — use the exact spelling`, ref: f.sa, suggestions: [m.name] });
      f.sa = m.name; seen.add(m.name); querySAs.add(m.name);
      if (!b.subjectAreas.includes(m.name)) b.subjectAreas.push(m.name);
      if (f.folder) {
        const folders = await foldersOf(m.name);
        const fm = matchName(f.folder, folders.map((x) => x.name));
        if (!fm) {
          errors.push(f.folder.includes(" > ")
            ? { code: "extension_folder", message: `"${f.folder}" is an extension-object path of one pod (custom object / EFF tree) — not in the vendor catalog; verify it on the target pod`, ref: refText }
            : { code: "unknown_folder", message: `folder "${f.folder}" is not in subject area "${m.name}"`, ref: refText, suggestions: nearestNames(f.folder, folders.map((x) => x.name)) });
          f.folder = ""; continue;
        }
        if (!fm.exact && !folderMatchWarned.has(refText)) { folderMatchWarned.add(refText); warnings.push({ code: "name_spelling", message: `folder "${f.folder}" matched "${fm.name}" ignoring case/whitespace`, ref: refText, suggestions: [fm.name] }); }
        f.folder = fm.name;
      }
    }
    if (seen.size > 1) warnings.push({ code: "cross_subject_area", message: `FROM names ${[...seen].map((s) => `"${s}"`).join(", ")} — a cross-subject-area query works only when the areas share one business model (HCM areas often do); prefer one subject area`, suggestions: [...seen] });
  }
  const topSA = blocks.find((b) => b.subjectAreas.length)?.subjectAreas[0] ?? null;
  if (!blocks.some((b) => b.fromFolders.length)) errors.push({ code: "no_from", message: 'no FROM "Subject Area" clause found' });

  // ---- column references, each against its own block's FROM
  const seenRef = new Set<string>();
  for (const r of refs) {
    if (r.clause === "from") continue;
    const b = r.block;
    const refText = r.parts.map((p) => `"${p}"`).join(".");
    if (r.parts.length === 1 && b.aliases.has(r.parts[0]) && r.clause !== "select") continue;                 // ORDER BY "Alias"
    if (b.derivedAliases.has(r.parts[0]) || (b.parent === null && r.parts.length === 1 && blocks.some((x) => x !== b && x.aliases.has(r.parts[0])))) continue; // Promotions."s_6", outer select of a derived table
    if (seenRef.has(`${blocks.indexOf(b)}|${r.clause}|${refText}`)) continue;
    seenRef.add(`${blocks.indexOf(b)}|${r.clause}|${refText}`);
    // the block's own SA, else the nearest ancestor's (a correlated reference)
    let ctx: Block | null = b;
    while (ctx && !ctx.subjectAreas.length) ctx = ctx.parent;
    let sa: string | null = ctx?.subjectAreas[0] ?? null;
    let folder: string | null = null;
    let column: string;
    if (r.parts.length >= 4) { errors.push({ code: "invalid_reference", message: `a reference has at most 3 parts ("SA"."Folder"."Column")`, ref: refText }); continue; }
    if (r.parts.length === 3) {
      const m = matchName(r.parts[0], saNames);
      if (!m) { errors.push({ code: "unknown_subject_area", message: `subject area "${r.parts[0]}" is not in the catalog`, ref: refText, suggestions: nearestNames(r.parts[0], saNames) }); continue; }
      if (!m.exact) warnings.push({ code: "name_spelling", message: `subject area "${r.parts[0]}" matched "${m.name}" ignoring case/whitespace`, ref: refText, suggestions: [m.name] });
      if (ctx && !ctx.subjectAreas.includes(m.name) && !querySAs.has(m.name)) {
        querySAs.add(m.name);
        warnings.push({ code: "cross_subject_area", message: `"${m.name}" referenced while FROM names "${sa}" — a cross-subject-area query works only when the areas share one business model; prefer one subject area`, ref: refText });
      }
      sa = m.name; folder = r.parts[1]; column = r.parts[2];
    } else if (r.parts.length === 2) {
      // "Alias"."Column" (FROM "SA"."Folder" "Alias") or "Folder"."Column"
      const fa = (ctx ?? b).fromFolders.find((f) => f.alias === r.parts[0] && f.folder);
      if (fa) { sa = fa.sa; folder = fa.folder; } else folder = r.parts[0];
      column = r.parts[1];
    } else {
      column = r.parts[0];
    }
    if (!sa) { errors.push({ code: "unresolved_reference", message: `cannot resolve ${refText} without a known subject area`, ref: refText }); continue; }
    const folders = await foldersOf(sa);
    if (folder === null) {
      const fromFolder = (ctx ?? b).fromFolders.find((f) => f.sa === sa && f.folder)?.folder ?? null;
      if (fromFolder && (ctx ?? b).fromFolders.filter((f) => f.folder).length === 1) folder = fromFolder;
      else {
        const where = await cat.foldersWithColumn(sa, column);
        if (where.length === 1) { folder = where[0]; notes.push(`${refText} is unqualified — resolved to folder "${folder}"`); }
        else if (where.length > 1) { errors.push({ code: "ambiguous_column", message: `"${column}" exists in ${where.length} folders of "${sa}" — qualify it`, ref: refText, suggestions: where.slice(0, 8).map((f) => `"${sa}"."${f}"."${column}"`) }); continue; }
        else { errors.push({ code: "unknown_column", message: `column "${column}" is not in any folder of "${sa}"`, ref: refText }); continue; }
      }
    } else {
      const fm = matchName(folder, folders.map((f) => f.name));
      if (!fm) {
        errors.push(folder.includes(" > ")
          ? { code: "extension_folder", message: `"${folder}" is an extension-object path of one pod (custom object / EFF tree) — not in the vendor catalog; verify it on the target pod`, ref: refText }
          : { code: "unknown_folder", message: `folder "${folder}" is not in subject area "${sa}"`, ref: refText, suggestions: nearestNames(folder, folders.map((f) => f.name)) });
        continue;
      }
      if (!fm.exact && !folderMatchWarned.has(`${sa}|${folder}`)) { folderMatchWarned.add(`${sa}|${folder}`); warnings.push({ code: "name_spelling", message: `folder "${folder}" matched "${fm.name}" ignoring case/whitespace`, ref: refText, suggestions: [fm.name] }); }
      folder = fm.name;
    }
    const cols = await columnsOf(sa, folder);
    const cm = matchName(column, cols.map((c) => c.name));
    if (!cm) {
      const elsewhere = await cat.foldersWithColumn(sa, column);
      const sugg = nearestNames(column, cols.map((c) => c.name));
      errors.push({
        code: "unknown_column",
        message: `column "${column}" is not in folder "${folder}" of "${sa}"` + (elsewhere.length ? ` (it exists in: ${elsewhere.slice(0, 5).map((f) => `"${f}"`).join(", ")})` : ""),
        ref: refText, suggestions: [...sugg, ...elsewhere.slice(0, 5).map((f) => `"${sa}"."${f}"."${column}"`)],
      });
      continue;
    }
    if (!cm.exact) warnings.push({ code: "name_spelling", message: `column "${column}" matched "${cm.name}" ignoring case/whitespace`, ref: refText, suggestions: [cm.name] });
    const c = cols.find((x) => x.name === cm.name)!;
    resolved.push({ ref: refText, subjectArea: sa, folder, column: c.name, kind: c.kind, dataType: c.data_type, aggregation: c.aggregation, clause: r.clause });
  }

  if (aggs.length) {
    warnings.push({ code: "aggregate_function", message: `${[...new Set(aggs)].join(", ")} used — the BI server aggregates measures at the grain of the selected attributes; an explicit aggregate is only needed for a deliberate re-aggregation` });
  }
  const measures = [...new Set(resolved.filter((r) => r.kind === "measure").map((r) => r.column))];
  if (!blocks.some((b) => b.hasFetch)) notes.push("no FETCH FIRST n ROWS ONLY — add one to bound the result");
  const fromFolder = blocks.find((b) => b.fromFolders.some((f) => f.folder))?.fromFolders.find((f) => f.folder)?.folder ?? null;
  return { ok: errors.length === 0, subjectArea: topSA, fromFolder, errors, warnings, resolved, measures, notes };
}
