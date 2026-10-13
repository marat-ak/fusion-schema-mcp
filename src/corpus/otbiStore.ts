/**
 * OTBI presentation-catalog grounding — the SQL-free domain layer over `db().otbi` for the three
 * tools of the business persona: `searchOtbi` (vector search over subject area / folder / column
 * text), `describeOtbiFolder` (a subject area's folder tree, or one folder's columns) and
 * `checkOtbiSql` (the offline lint in ./otbiLint.ts). Physical depth (grain, mostlyUsedFilters,
 * real SQL) stays with the existing tools: every folder carries `dbTables` / `unitId`, every column
 * `dbRefs`, for validateTable / getTableGrain / getReportQuery.
 */
import { db, type OtbiColumnRow, type OtbiFolderRow } from "../db/index.js";
import { embed } from "./embed.js";
import { lintOtbiSql, nearestNames, type LintResult } from "./otbiLint.js";

const parseJson = (s: string | null): unknown => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const score = (d: number) => +(1 - (d * d) / 2).toFixed(3);

function columnOut(c: OtbiColumnRow) {
  return {
    name: c.name, dataType: c.data_type, kind: c.kind,
    ...(c.aggregation ? { aggregation: c.aggregation } : {}),
    ...(c.expression ? { expression: c.expression } : {}),
    description: c.description,
    ...(c.gap_cause ? { noDescriptionBecause: c.gap_cause } : {}),
    dbRefs: ((parseJson(c.db_refs) as { t: string; c: string }[] | null) ?? []).map((r) => `${r.t}.${r.c}`),
    // the VO hop (ddl_version 9): the view object(s) the column is read through (otbi_vo carries their physical objects)
    ...((parseJson(c.vo_refs) as string[] | null)?.length ? { voRefs: parseJson(c.vo_refs) as string[] } : {}),
    ...(c.indexed ? { indexed: true } : {}),
  };
}

function folderOut(f: OtbiFolderRow, brief: boolean) {
  return {
    name: f.name, kind: f.kind, columns: f.n_columns, measures: f.n_measures,
    ...(f.nested ? { nestedPath: true } : {}),
    description: brief && f.description ? f.description.slice(0, 200) + (f.description.length > 200 ? "…" : "") : f.description,
    ...(brief ? {} : { dbTables: (parseJson(f.db_tables) as string[] | null) ?? [], ...(f.grain_note ? { grainNote: f.grain_note } : {}) }),
    ...(f.unit_id ? { unitId: f.unit_id } : {}),
    coverage: { lineage: f.in_lineage === 1, crawl: f.in_crawl === 1, corpus: f.in_corpus === 1 },
  };
}

/** Semantic search over the catalog texts. Each hit carries `hit` = column | folder | subject_area
 *  (the entity's own `kind` is attribute/measure or fact/dimension). A column hit is ONE text shared
 *  by every subject area that carries the column, so it lists its locations; `subjectArea` narrows
 *  locations to one area. */
export async function searchOtbi(query: string, opts: { subjectArea?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 40));
  let subjectArea: string | undefined;
  if (opts.subjectArea) {
    const sa = await db().otbi.subjectArea(opts.subjectArea);
    if (!sa) return { query, found: false, error: `subject area "${opts.subjectArea}" is not in the catalog`, suggestions: nearestNames(opts.subjectArea, await db().otbi.subjectAreaNames()) };
    subjectArea = sa.name;
  }
  const [vec] = await embed([query]);
  // a column text is shared across subject areas: under a subject-area filter most nearest hashes
  // have no entity in that area, so overfetch harder
  const K = subjectArea ? limit * 20 : limit * 4;
  const hits = await db().otbi.knn(vec, K);
  const byKind = (k: string) => hits.filter((h) => h.kind === k).map((h) => h.text_hash);
  const perHash = subjectArea ? 50 : 6;
  const [cols, folders, sas] = await Promise.all([
    db().otbi.columnsByHash(byKind("column"), subjectArea, perHash + 1),
    db().otbi.foldersByHash(byKind("folder"), subjectArea),
    subjectArea ? Promise.resolve([]) : db().otbi.subjectAreasByHash(byKind("subject_area")),
  ]);
  const colsByHash = new Map<string, OtbiColumnRow[]>();
  for (const c of cols) { const a = colsByHash.get(c.text_hash!) ?? []; a.push(c); colsByHash.set(c.text_hash!, a); }
  const foldersByHash = new Map<string, OtbiFolderRow[]>();
  for (const f of folders) { const a = foldersByHash.get(f.text_hash!) ?? []; a.push(f); foldersByHash.set(f.text_hash!, a); }
  const saByHash = new Map(sas.map((s) => [s.text_hash!, s]));

  const out: any[] = [];
  for (const h of hits) {
    if (out.length >= limit) break;
    if (h.kind === "column") {
      const rows = colsByHash.get(h.text_hash);
      if (!rows?.length) continue;
      const c = rows[0];
      out.push({
        hit: "column", score: score(h.distance), ...columnOut(c),
        locations: rows.slice(0, perHash).map((r) => ({ subjectArea: r.subject_area, folder: r.folder })),
        ...(rows.length > perHash ? { moreLocations: true } : {}),
      });
    } else if (h.kind === "folder") {
      for (const f of foldersByHash.get(h.text_hash) ?? []) {
        if (out.length >= limit) break;
        out.push({ hit: "folder", score: score(h.distance), subjectArea: f.subject_area, ...folderOut(f, true) });
      }
    } else if (h.kind === "subject_area") {
      const s = saByHash.get(h.text_hash);
      if (!s) continue;
      out.push({ hit: "subject_area", score: score(h.distance), name: s.name, pillar: s.pillar, folders: s.n_folders, factFolders: parseJson(s.fact_folders) ?? [] });
    }
  }
  return {
    query, ...(subjectArea ? { subjectArea } : {}), hits: out,
    next: 'describeOtbiFolder(subjectArea, folder) for a folder\'s full column list; checkOtbiSql(sql) before running logical SQL',
  };
}

/** A subject area's folder tree (no `folder`) or one folder's columns. */
export async function describeOtbiFolder(subjectArea: string, folder?: string) {
  const sa = await db().otbi.subjectArea(subjectArea);
  if (!sa) return { found: false, error: `subject area "${subjectArea}" is not in the catalog`, suggestions: nearestNames(subjectArea, await db().otbi.subjectAreaNames()) };
  const folders = await db().otbi.folders(sa.name);
  if (!folder) {
    const plain = folders.filter((f) => !f.nested);
    const nested = folders.filter((f) => f.nested);
    const NESTED_CAP = 60;
    return {
      found: true,
      subjectArea: {
        name: sa.name, pillar: sa.pillar, folders: sa.n_folders, columns: sa.n_columns,
        factFolders: parseJson(sa.fact_folders) ?? [],
        coverage: { lineage: sa.in_lineage === 1, crawl: sa.in_crawl === 1, corpus: sa.in_corpus === 1 },
      },
      facts: plain.filter((f) => f.kind === "fact").map((f) => folderOut(f, true)),
      dimensions: plain.filter((f) => f.kind !== "fact").map((f) => folderOut(f, true)),
      ...(nested.length ? {
        nestedFolders: nested.slice(0, NESTED_CAP).map((f) => ({ name: f.name, columns: f.n_columns })),
        nestedFolderCount: nested.length,
        ...(nested.length > NESTED_CAP ? { note: `${nested.length} extension-folder paths (\`A > B > C\`); ${NESTED_CAP} shown — searchOtbi(query, subjectArea) finds the rest` } : {}),
      } : {}),
      reference: `select "${sa.name}"."<Folder>"."<Column>" … from "${sa.name}" — names verbatim, one subject area per query`,
    };
  }
  let f = folders.find((x) => x.name === folder);
  if (!f) {
    const names = folders.map((x) => x.name);
    const near = nearestNames(folder, names);
    return { found: false, subjectArea: sa.name, error: `folder "${folder}" is not in "${sa.name}"`, suggestions: near };
  }
  const cols = await db().otbi.columns(sa.name, f.name);
  const CAP = 400;
  return {
    found: true, subjectArea: sa.name, folder: folderOut(f, false),
    columns: cols.slice(0, CAP).map(columnOut),
    ...(cols.length > CAP ? { note: `${cols.length} columns; ${CAP} shown — searchOtbi(query, subjectArea) finds the rest` } : {}),
    ...(f.unit_id ? { physicalSql: `getReportQuery({title: "${sa.name}.${f.name}"}) — the real physical SQL behind this folder` } : {}),
  };
}

/** Offline lint of a logical SQL statement against the catalog. */
export async function checkOtbiSql(sql: string): Promise<LintResult> {
  return lintOtbiSql(sql, db().otbi);
}
