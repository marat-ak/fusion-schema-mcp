import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type SqlSource = {
  id: string;
  source: "otbi" | "catalog" | "view";
  title: string;
  originalSql: string;
  sourceHash: string;
  raw: any;
};

const DEF = "C:/Marat/OSaaS/ClaudeShared/Bip/OTBI/results";
const OTBI = process.env.OTBI_READY_DIR ?? `${DEF}/ready`;
const CAT = process.env.OTBI_CATALOG_DIR ?? `${DEF}/ready_catalog`;
const VIEWS = process.env.OTBI_VIEWS_DIR ?? `${DEF}/ready_views`;

export function hashSql(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Normalize SQL for content-dedup: strip comments, collapse whitespace, lowercase. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Content hash used as the corpus identity — identical queries (ignoring formatting) collapse. */
export function hashSqlNormalized(sql: string): string {
  return crypto.createHash("sha256").update(normalizeSql(sql), "utf8").digest("hex");
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function baseId(file: string): string {
  return path.basename(file).replace(/\.json$/i, "");
}

function pushEach(
  out: SqlSource[], dir: string, source: SqlSource["source"],
  map: (d: any, file: string) => { title: string; sqls: string[] } | null,
  limit?: number,
) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    if (limit && out.length >= limit) return;
    const file = path.join(dir, f);
    const d = readJson(file);
    if (!d) continue;
    const m = map(d, file);
    if (!m) continue;
    m.sqls.forEach((sql, i) => {
      if (!sql) return;
      const id = m.sqls.length > 1 ? `${source}:${baseId(file)}#${i}` : `${source}:${baseId(file)}`;
      out.push({ id, source, title: m.title, originalSql: sql, sourceHash: hashSql(sql), raw: d });
    });
  }
}

export function scanSources(opts: {
  otbiDir?: string; catalogDir?: string; viewsDir?: string; limit?: number;
} = {}): SqlSource[] {
  const out: SqlSource[] = [];
  pushEach(out, opts.otbiDir ?? OTBI, "otbi",
    (d) => d.physicalSqlNamed ? { title: `${d.subjectArea}.${d.table}`, sqls: [d.physicalSqlNamed] } : null,
    opts.limit);
  pushEach(out, opts.catalogDir ?? CAT, "catalog",
    (d) => Array.isArray(d.sqls) ? { title: d.path ?? d.name ?? "", sqls: d.sqls } : null,
    opts.limit);
  pushEach(out, opts.viewsDir ?? VIEWS, "view",
    (d) => Array.isArray(d.sqls) ? { title: d.name ?? "", sqls: d.sqls } : null,
    opts.limit);
  return out;
}
