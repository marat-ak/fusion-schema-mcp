#!/usr/bin/env python3
"""
P3o-a — stage the OTBI presentation-layer sources into `work` (run by p3_otbi.sh inside
python:3.12-slim with psycopg + openpyxl; DATABASE_URL + OTBI_SRC required, no defaults).

Three inputs, three staging groups, every row as it was read — the DERIVATION is p3_otbi.sql:

  lineage workbooks   OTBI_SRC/lineage/r13-26b-<pillar>-otbi-database-mapping-with-viewobjects.xlsx
                      sheet "OTBI Subject Areas", header row 5, data from row 6
                      -> work.otbi_lineage          one row per (SA, folder, column, VO path, DB object)
  crawl metadata      OTBI_SRC/subject_areas.json   (SOAP: every SA -> folders -> columns + dataType)
                      -> work.otbi_crawl_folder / work.otbi_crawl_column / work.otbi_crawl_error
  crawl probes        OTBI_SRC/presentation_tables.jsonl  (one line per folder: status, the logical
                      column list, the crawler's column lineage, joins/filters, the physical SQL)
                      -> work.otbi_probe / work.otbi_probe_column

Name discipline: presentation names are stored VERBATIM (double spaces kept, the `- ` / `-- `
child-folder prefixes kept). The ONE normalisation is the workbook's literal double quotes around
dash-prefixed folder names (`"- Header Information"`), which the crawl and logical SQL do not carry.

The per-column `aggregation` / `expression` / `expr_refs` come from resolving the probe's physical
SQL alias chain: OBIS emits `WITH SAWITH0 AS (select T.C123 as c2 ...), SAWITH1 AS (select sum(D1.c2)
as c1 ... from SAWITH0 D1 group by ...) select D1.c1 as c1 ... from SAWITH1 D1`, and the outermost
`cN` is `logicalColumns[N-1]`. resolve() follows `Dx.cM` references down through the CTEs and
derived tables to the base `TABLE.COLUMN` refs, records the first aggregate function met on the way,
and keeps a non-trivial expression (nvl / case / arithmetic / sum(1)) as the column's physical
expression. A folder whose outermost projection does not have one alias per logical column is
marked `alias_mismatch` and gets no expressions (never a positional guess).
"""
import glob
import json
import os
import re
import sys
from multiprocessing import Pool

import openpyxl
import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
SRC = os.environ.get("OTBI_SRC")
PROCS = int(os.environ.get("PARSE_PROCS") or max(2, (os.cpu_count() or 4) - 2))
EXPR_CAP = 600

DDL = """
DROP TABLE IF EXISTS work.otbi_lineage;
CREATE TABLE work.otbi_lineage (
  pillar text NOT NULL, subject_area text NOT NULL, pres_table text NOT NULL, pres_column text NOT NULL,
  vo_path text, vo_attr text, vo_def text, db_object text, db_column text, indexed text
);
DROP TABLE IF EXISTS work.otbi_crawl_folder;
CREATE TABLE work.otbi_crawl_folder (subject_area text NOT NULL, pres_table text NOT NULL, ordinal int NOT NULL, n_columns int NOT NULL);
DROP TABLE IF EXISTS work.otbi_crawl_column;
CREATE TABLE work.otbi_crawl_column (subject_area text NOT NULL, pres_table text NOT NULL, ordinal int NOT NULL, pres_column text NOT NULL, data_type text);
DROP TABLE IF EXISTS work.otbi_crawl_error;
CREATE TABLE work.otbi_crawl_error (subject_area text NOT NULL, error text);
DROP TABLE IF EXISTS work.otbi_probe;
CREATE TABLE work.otbi_probe (
  subject_area text NOT NULL, pres_table text NOT NULL, status text, has_sql boolean NOT NULL, sql_chars int NOT NULL,
  n_logical int NOT NULL, n_out int, alias_mismatch boolean NOT NULL,
  db_tables jsonb, joins jsonb, filters jsonb, date_ranges jsonb, view_objects jsonb
);
DROP TABLE IF EXISTS work.otbi_probe_column;
CREATE TABLE work.otbi_probe_column (
  subject_area text NOT NULL, pres_table text NOT NULL, ordinal int NOT NULL, logical_column text NOT NULL,
  physical_alias text, view_object text, base_table text, base_column text, resolved boolean,
  aggregation text, expression text, expr_refs jsonb
);
"""

# --------------------------------------------------------------------------- lineage workbooks
def strip_literal_quotes(s):
    if s is None:
        return None
    s = str(s)
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1]
    return s


def load_lineage(cur):
    files = sorted(glob.glob(os.path.join(SRC, "lineage", "r13-26b-*-otbi-database-mapping-with-viewobjects.xlsx")))
    if not files:
        raise SystemExit(f"no lineage workbooks under {SRC}/lineage")
    n = 0
    with cur.copy("COPY work.otbi_lineage (pillar, subject_area, pres_table, pres_column, vo_path, vo_attr, vo_def, db_object, db_column, indexed) FROM STDIN") as cp:
        for f in files:
            pillar = re.search(r"r13-26b-(.+?)-otbi-database", os.path.basename(f)).group(1)
            wb = openpyxl.load_workbook(f, read_only=True)
            ws = wb["OTBI Subject Areas"]
            rows = ws.iter_rows(min_row=5, values_only=True)
            header = [str(x).strip() if x is not None else None for x in next(rows)]
            want = ["SUBJECT_AREA", "PRESENTATION_TABLE", "PRESENTATION_COLUMN", "PHYSICAL_TABLE", "PHYSICAL_COLUMN", "VO_DEFINITION", "DATABASE_OBJECT", "DATABASE_COLUMN", "INDEXED"]
            idx = [header.index(w) for w in want]
            k = 0
            for r in rows:
                v = [r[i] if i < len(r) else None for i in idx]
                if v[0] is None or v[1] is None or v[2] is None:
                    continue
                cp.write_row([pillar, str(v[0]), strip_literal_quotes(v[1]), str(v[2]),
                              *(None if x is None else str(x) for x in v[3:9])])
                k += 1
            n += k
            print(f"[p3o] lineage {pillar}: {k} rows", file=sys.stderr)
    return n


# --------------------------------------------------------------------------- crawl metadata
def load_crawl(cur):
    with open(os.path.join(SRC, "subject_areas.json"), "r", encoding="utf-8") as fh:
        d = json.load(fh)
    folders, columns, errors = [], [], []
    for sa in d["subjectAreas"]:
        name = sa["name"]
        for ti, t in enumerate(sa.get("tables") or []):
            tn = t.get("name")
            if not tn:
                errors.append([name, json.dumps(t)[:500]])
                continue
            cols = t.get("columns") or []
            folders.append([name, tn, ti, len(cols)])
            for ci, c in enumerate(cols):
                cn = c.get("name")
                if cn:
                    columns.append([name, tn, ci, cn, c.get("dataType")])
    # ONE COPY at a time on the connection (a second copy on the same cursor blocks behind the first)
    copy_rows(cur, "COPY work.otbi_crawl_folder (subject_area, pres_table, ordinal, n_columns) FROM STDIN", folders)
    copy_rows(cur, "COPY work.otbi_crawl_column (subject_area, pres_table, ordinal, pres_column, data_type) FROM STDIN", columns)
    copy_rows(cur, "COPY work.otbi_crawl_error (subject_area, error) FROM STDIN", errors)
    print(f"[p3o] crawl: {len(d['subjectAreas'])} SAs, {len(folders)} folders, {len(columns)} columns, {len(errors)} error entries", file=sys.stderr)
    return len(folders), len(columns)


def copy_rows(cur, stmt, rows):
    with cur.copy(stmt) as cp:
        for r in rows:
            cp.write_row(r)


# --------------------------------------------------------------------------- physical SQL alias resolver
AGG_RE = re.compile(r"^\s*(sum|count|min|max|avg)\s*\(\s*(distinct\s+)?(.*)\)\s*$", re.I | re.S)
REF_RE = re.compile(r"^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*$")
ITEM_RE = re.compile(r"^(.*?)\s+(?:as\s+)?([A-Za-z_]\w*)\s*$", re.I | re.S)
TOKEN_RE = re.compile(r"[()']|\b(?:from|where|group|order|having|union|fetch|on|join|select|with|as)\b", re.I)
REFS_IN_RE = re.compile(r"\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b")


def scan(s, start=0):
    """Yield (pos, token) for depth-0 tokens; string literals are skipped."""
    depth = 0
    i = start
    n = len(s)
    while i < n:
        m = TOKEN_RE.search(s, i)
        if not m:
            return
        t = m.group(0)
        i = m.end()
        if t == "'":
            j = s.find("'", i)
            while j != -1 and j + 1 < n and s[j + 1] == "'":
                j = s.find("'", j + 2)
            i = n if j == -1 else j + 1
            continue
        if t == "(":
            depth += 1
            continue
        if t == ")":
            depth -= 1
            if depth < 0:
                yield (m.start(), ")")
                return
            continue
        if depth == 0:
            yield (m.start(), t.lower())


def split_top(s):
    """Split on depth-0 commas (string literals skipped)."""
    out, depth, last, i, n = [], 0, 0, 0, len(s)
    while i < n:
        c = s[i]
        if c == "'":
            j = s.find("'", i + 1)
            while j != -1 and j + 1 < n and s[j + 1] == "'":
                j = s.find("'", j + 2)
            i = n if j == -1 else j + 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            out.append(s[last:i]); last = i + 1
        i += 1
    out.append(s[last:])
    return out


class Block:
    __slots__ = ("proj", "sources", "memo")

    def __init__(self):
        self.proj = {}
        self.sources = {}
        self.memo = {}


SUBQ_RE = re.compile(r"\s*select\b", re.I)


def strip_join_groups(clause):
    """OBIS nests joins as `((( A D1 left outer join B D2 On …) left outer join C D3 On …) …)`. Drop the
    parentheses of such JOIN GROUPS (a `(` not followed by `select`) so the sources split flat; a
    subquery's parentheses — and everything inside them — are copied through untouched."""
    out, stack, i, n = [], [], 0, len(clause)
    while i < n:
        c = clause[i]
        if c == "'":
            j = clause.find("'", i + 1)
            while j != -1 and j + 1 < n and clause[j + 1] == "'":
                j = clause.find("'", j + 2)
            j = n if j == -1 else j + 1
            out.append(clause[i:j]); i = j
            continue
        if c == "(":
            if stack and stack[-1] == "sub":
                stack.append("sub"); out.append(c)
            elif SUBQ_RE.match(clause, i + 1):
                stack.append("sub"); out.append(c)
            else:
                stack.append("grp")
        elif c == ")":
            kind = stack.pop() if stack else "grp"
            if kind == "sub":
                out.append(c)
        else:
            out.append(c)
        i += 1
    return "".join(out)


def parse_from_sources(clause, ctes):
    """`SAWITH1 D1` | `( subquery ) D1` | `TABLE alias` pieces of a FROM clause -> {alias: source}."""
    src = {}
    pieces = []
    clause = strip_join_groups(clause)
    for piece in split_top(clause):
        # split joins at depth 0; drop the ON conditions
        cur = piece
        parts = re.split(r"\b(?:left|right|full|inner|outer|cross|natural)?\s*(?:outer\s+)?join\b", cur, flags=re.I)
        for p in parts:
            p = p.strip()
            if not p:
                continue
            for pos, tok in scan(p):
                if tok == "on":
                    p = p[:pos].strip()
                    break
            pieces.append(p)
    for p in pieces:
        if not p:
            continue
        if p[0] == "(":
            depth, j = 0, 0
            for j, c in enumerate(p):
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        break
            inner = p[1:j]
            alias = p[j + 1:].strip().split()
            if alias and alias[0].lower() == "as":
                alias = alias[1:]
            if alias:
                src[alias[0]] = ("sub", inner)
        else:
            toks = p.split()
            if not toks:
                continue
            name = toks[0]
            alias = toks[1] if len(toks) > 1 and toks[1].lower() != "as" else (toks[2] if len(toks) > 2 else name)
            if name.upper().startswith("SAWITH") and name in ctes:
                src[alias] = ("cte", name)
            else:
                src[alias] = ("tbl", name)
    return src


def parse_select(text, ctes, cache):
    """Parse ONE select block (text starts at or before `select`) into a Block; sources are lazy."""
    key = text[:200] + str(len(text))
    if key in cache:
        return cache[key]
    b = Block()
    cache[key] = b
    toks = scan(text)
    sel = None
    frm = None
    end = None
    for pos, t in toks:
        if sel is None:
            if t == "select":
                sel = pos + 6
            continue
        if frm is None:
            if t == "from":
                frm = pos
            continue
        if t in ("where", "group", "order", "having", "union", "fetch", ")"):
            end = pos
            break
    if sel is None or frm is None:
        return b
    proj = text[sel:frm]
    proj = re.sub(r"^\s*distinct\b", "", proj, flags=re.I)
    for item in split_top(proj):
        item = item.strip()
        m = ITEM_RE.match(item)
        if m:
            b.proj[m.group(2)] = m.group(1).strip()
            continue
        # an alias-less item (`InvoiceHeader.INVOICE_AMOUNT`, `INVOICE_ID`) is addressed by its column name
        m = REF_RE.match(item) or re.match(r"^\s*([A-Za-z_]\w*)\s*$", item)
        if m:
            b.proj[m.group(m.lastindex)] = item
    b.sources = parse_from_sources(text[frm + 4:end if end is not None else len(text)], ctes)
    return b


def resolve(b, alias, ctes, blocks, cache, depth=0):
    """-> (aggregation, expression, refs). expression is None for a plain base-column passthrough."""
    if alias in b.memo:
        return b.memo[alias]
    if depth > 60:
        return (None, None, [])
    expr = b.proj.get(alias)
    if expr is None:
        return (None, None, [])
    res = _resolve_expr(b, expr, ctes, blocks, cache, depth)
    b.memo[alias] = res
    return res


def _source_block(b, src_alias, ctes, blocks, cache):
    s = b.sources.get(src_alias)
    if not s:
        return None
    if s[0] == "cte":
        blk = blocks.get(s[1])
        if blk is None:
            blk = parse_select(ctes[s[1]], ctes, cache)
            blocks[s[1]] = blk
        return blk
    if s[0] == "sub":
        return parse_select(s[1], ctes, cache)
    return None


def _resolve_expr(b, expr, ctes, blocks, cache, depth):
    m = REF_RE.match(expr)
    if m:
        src, col = m.group(1), m.group(2)
        s = b.sources.get(src)
        if s and s[0] == "tbl":
            ref = f"{s[1]}.{col}"
            return (None, None, [ref])
        sb = _source_block(b, src, ctes, blocks, cache)
        if sb is None:
            return (None, None, [f"{src}.{col}"])
        return resolve(sb, col, ctes, blocks, cache, depth + 1)
    m = AGG_RE.match(expr)
    if m and _balanced(m.group(3)):
        fn = m.group(1).lower() + (" distinct" if m.group(2) else "")
        agg, inner_expr, refs = _resolve_expr(b, m.group(3), ctes, blocks, cache, depth + 1)
        return (fn, inner_expr, refs)
    # general expression: substitute every Dx.cM reference by what it resolves to
    refs, agg_found = [], None

    def sub(mm):
        nonlocal agg_found
        src, col = mm.group(1), mm.group(2)
        s = b.sources.get(src)
        if s and s[0] == "tbl":
            r = f"{s[1]}.{col}"
            refs.append(r)
            return r
        sb = _source_block(b, src, ctes, blocks, cache)
        if sb is None:
            return mm.group(0)
        a, e, rs = resolve(sb, col, ctes, blocks, cache, depth + 1)
        refs.extend(rs)
        if a and not agg_found:
            agg_found = a
        if e:
            # a long sub-expression is folded to its first base ref so the outer text stays readable
            return e if len(e) <= 120 or not rs else "(" + rs[0] + ")"
        return rs[0] if rs else mm.group(0)

    out = REFS_IN_RE.sub(sub, expr)
    out = re.sub(r"\s+", " ", out).strip()
    if len(out) > EXPR_CAP:
        out = out[:EXPR_CAP] + " …"
    seen, uniq = set(), []
    for r in refs:
        if r not in seen:
            seen.add(r); uniq.append(r)
    return (agg_found, out, uniq)


def _balanced(s):
    d = 0
    for c in s:
        if c == "(":
            d += 1
        elif c == ")":
            d -= 1
            if d < 0:
                return False
    return d == 0


def split_ctes(sql):
    """`WITH SAWITH0 AS ( ... ), SAWITH1 AS ( ... ) select ...` -> ({name: body}, final_select_text)."""
    ctes = {}
    m = re.match(r"\s*with\s+", sql, re.I)
    if not m:
        return ctes, sql
    i = m.end()
    n = len(sql)
    while True:
        mm = re.match(r"\s*([A-Za-z_]\w*)\s+as\s*\(", sql[i:], re.I)
        if not mm:
            break
        name = mm.group(1)
        j = i + mm.end()
        depth, k = 1, j
        while k < n and depth > 0:
            c = sql[k]
            if c == "'":
                q = sql.find("'", k + 1)
                k = n if q == -1 else q + 1
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            k += 1
        ctes[name] = sql[j:k - 1]
        i = k
        mm2 = re.match(r"\s*,", sql[i:])
        if mm2:
            i += mm2.end()
            continue
        break
    return ctes, sql[i:]


def resolve_probe(args):
    """One presentation_tables.jsonl line -> (probe row, [probe_column rows])."""
    line = args
    j = json.loads(line)
    sa, tn = j.get("subjectArea"), j.get("table")
    cols = j.get("logicalColumns") or []
    sql = j.get("realSql") or ""
    lineage = {c.get("logicalColumn"): c for c in (j.get("columnLineage") or [])}
    n_out = None
    mismatch = False
    per = {}
    if sql.strip():
        try:
            ctes, final = split_ctes(sql)
            cache, blocks = {}, {}
            top = parse_select(final, ctes, cache)
            n_out = len(top.proj)
            mismatch = n_out != len(cols)
            if not mismatch:
                for i, _ in enumerate(cols):
                    a, e, refs = resolve(top, f"c{i + 1}", ctes, blocks, cache)
                    per[i] = (a, e, refs)
        except RecursionError:
            mismatch = True
    probe = [sa, tn, j.get("status"), bool(sql.strip()), len(sql), len(cols), n_out, mismatch,
             json.dumps(j.get("dbTables") or []), json.dumps(j.get("joins") or []), json.dumps(j.get("filters") or []),
             json.dumps(j.get("dateRanges") or []), json.dumps(j.get("viewObjects") or [])]
    rows = []
    for i, c in enumerate(cols):
        l = lineage.get(c) or {}
        a, e, refs = per.get(i, (None, None, []))
        # a plain passthrough of one base column is not an expression
        if e is not None and len(refs) == 1 and e == refs[0]:
            e = None
        rows.append([sa, tn, i, c, l.get("physicalAlias"), l.get("viewObject"), l.get("baseTable"), l.get("baseColumn"),
                     l.get("resolved"), a, e, json.dumps(refs)])
    return probe, rows


def load_probes(cur):
    path = os.path.join(SRC, "presentation_tables.jsonl")
    probes, cols = [], []
    with open(path, "r", encoding="utf-8") as fh, Pool(PROCS) as pool:
        for probe, rows in pool.imap_unordered(resolve_probe, (l for l in fh if l.strip()), chunksize=64):
            probes.append(probe)
            cols.extend(rows)
            if len(probes) % 10000 == 0:
                print(f"[p3o] probes {len(probes)} ({len(cols)} columns)", file=sys.stderr)
    copy_rows(cur, "COPY work.otbi_probe (subject_area, pres_table, status, has_sql, sql_chars, n_logical, n_out, alias_mismatch, db_tables, joins, filters, date_ranges, view_objects) FROM STDIN", probes)
    copy_rows(cur, "COPY work.otbi_probe_column (subject_area, pres_table, ordinal, logical_column, physical_alias, view_object, base_table, base_column, resolved, aggregation, expression, expr_refs) FROM STDIN", cols)
    print(f"[p3o] probes: {len(probes)} folders, {len(cols)} columns ({PROCS} procs)", file=sys.stderr)
    return len(probes), len(cols)


def main():
    if not DATABASE_URL or not SRC:
        raise SystemExit("DATABASE_URL and OTBI_SRC are required — no defaults")
    with psycopg.connect(DATABASE_URL, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute(DDL)
            nl = load_lineage(cur)
            nf, nc = load_crawl(cur)
            np_, npc = load_probes(cur)
            cur.execute("CREATE INDEX ON work.otbi_lineage (subject_area, pres_table, pres_column)")
            cur.execute("CREATE INDEX ON work.otbi_crawl_column (subject_area, pres_table, pres_column)")
            cur.execute("CREATE INDEX ON work.otbi_probe_column (subject_area, pres_table, logical_column)")
            cur.execute("CREATE INDEX ON work.otbi_probe (subject_area, pres_table)")
            cur.execute("ANALYZE work.otbi_lineage; ANALYZE work.otbi_crawl_column; ANALYZE work.otbi_crawl_folder; ANALYZE work.otbi_probe; ANALYZE work.otbi_probe_column")
        conn.commit()
    print(f"[p3o] staged: lineage {nl} rows; crawl {nf} folders / {nc} columns; probes {np_} folders / {npc} columns", file=sys.stderr)


if __name__ == "__main__":
    main()
