"""P3d — PL/SQL package/function CALL facts over the L3 statements (work.clear_sql → work.f_calls),
and the file export of the rolled-up inventory (work.plsql_api → data/plsql_api_usage.*).

Deterministic, no model: a lexical scan of the statement with comments, string literals and quoted
identifiers MASKED (blanked to spaces, offsets preserved) so a dot inside a literal or a comment can
never produce a call and a call's snippet can still be cut from the ORIGINAL text with its literals.

What counts as a call
  PKG.FN(            2-part dotted identifier followed by `(`
  SCHEMA.PKG.FN(     3-part
  PKG.FN             parameterless reference (FND_GLOBAL.USER_NAME, HZ_SESSION_UTIL.GET_USER_PARTYID —
                     the most-used Fusion APIs are ONLY ever written this way). Second pass; the left
                     part must (a) be a PACKAGE object of the vendor dictionary (work.meta_tables
                     table_type='PACKAGE', 6,935 names — the canonical package list), or match an
                     Oracle/XX package, or be a package pass 1 saw with parens; (b) not be a TABLE/VIEW
                     name (then it is a column reference); (c) not be defined as a table alias in THAT
                     statement (`<object|)> [AS] X` guard). The rollup keeps a bare-only package only
                     when >= 2 statements reference it.
What is excluded, deterministically
  alias.col (+)      Oracle outer-join marker after the paren
  a `.` directly before the match (chained method call on an expression result)
Classification (fusion / oracle / custom / method / unknown) is NOT done here — it is a SQL step
over the vendor dictionary in p3_calls_post.sql, so it can be re-run without re-scanning.

Why not sqlglot: the pinned parse (p3_parse.py) drops 8 % of statements to `fallback`/`failed`
(the OTBI giants among them) and its AST does not distinguish a package call from a column of an
aliased table without the dictionary knowing PACKAGES, which no dictionary carries. A masked
lexical scan reaches every statement, including the 2,072 the parser could not read.

Run (see p3_calls.sh): DATABASE_URL required, no default.
  python p3_calls.py extract          # fill work.f_calls (drops nothing: p3_calls.sql created it empty)
  python p3_calls.py export <outdir>  # write plsql_api_usage.{json,csv,md} from work.plsql_api
"""
import csv
import json
import os
import re
import sys
import time

import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required — no default")

SNIPPET_MAX = 240
BATCH = 500
ORACLE_PKG_RE = re.compile(r"^(DBMS_|UTL_|XMLTYPE$|XMLTYPE_|XMLDOM|XMLPARSER|XSLPROCESSOR|HTP$|HTF$|OWA_|CTX_|SDO_"
                           r"|ANYDATA|ANYTYPE|APEX_|WWV_|ORA_|SYS$|SYS_|JSON_|OLAP|STANDARD$|ODCI|DBMS$|XDB|MDSYS"
                           r"|CTXSYS|SYSTEM$|WPG_|SEM_)")

IDENT = r"[A-Za-z][A-Za-z0-9_$#]*"
# lookbehind: not preceded by an identifier char, a quote, or a dot (that would be a longer chain)
CALL_RE = re.compile(rf"(?<![A-Za-z0-9_$#\"'.])({IDENT})\s*\.\s*({IDENT})(?:\s*\.\s*({IDENT}))?\s*\(")
OUTER_JOIN_RE = re.compile(r"\s*\+\s*\)")
# regions to blank: -- comments, /* */ comments, q-quoted literals, 'literals' ('' escapes), "quoted idents"
MASK_RE = re.compile(
    r"--[^\n]*"
    r"|/\*.*?\*/"
    r"|(?<![A-Za-z0-9_$#])[qQ]'\[.*?\]'"
    r"|(?<![A-Za-z0-9_$#])[qQ]'\{.*?\}'"
    r"|(?<![A-Za-z0-9_$#])[qQ]'\(.*?\)'"
    r"|(?<![A-Za-z0-9_$#])[qQ]'<.*?>'"
    r"|'(?:[^']|'')*'"
    r"|\"[^\"]*\"",
    re.S,
)
WITH_PLSQL_RE = re.compile(r"\bWITH\s+(FUNCTION|PROCEDURE)\b", re.I)
END_RE = re.compile(r"\bEND\s*;", re.I)
BLOCK_START_RE = re.compile(r"^\s*(DECLARE|BEGIN)\b", re.I)
WS_RE = re.compile(r"\s+")


def log(msg):
    print(f"[p3-calls] {msg}", flush=True)


def mask(sql: str) -> str:
    """Same length as `sql`. Comments become spaces; literals and quoted identifiers keep their
    DELIMITERS and lose their content (`'abc'` → `'   '`, `"COL"` → `"   "`). Keeping the delimiter is
    what stops `B."COL" FROM (` from collapsing into `B . FROM (` and reading as a call."""
    out = []
    last = 0
    for m in MASK_RE.finditer(sql):
        out.append(sql[last:m.start()])
        t = m.group(0)
        if t.startswith("--") or t.startswith("/*"):
            out.append(" " * len(t))
        else:
            out.append(t[0] + " " * (len(t) - 2) + t[-1])
        last = m.end()
    out.append(sql[last:])
    return "".join(out)


def balanced(masked: str, open_pos: int):
    """From the `(` at open_pos: (close_pos, top_level_arg_count) or (None, None) if never closed."""
    depth = 0
    commas = 0
    blank = True
    for i in range(open_pos, len(masked)):
        c = masked[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i, (0 if blank else commas + 1)
        elif depth == 1:
            if c == ",":
                commas += 1
            elif not c.isspace():
                blank = False
    return None, None


def plsql_region(masked: str):
    """(start, end) of the inline PL/SQL declarations, or None. Approximation that fits the corpus:
    the region opens at the first WITH FUNCTION/PROCEDURE and closes at the last `END;`; a statement
    that starts with DECLARE/BEGIN is a block end to end."""
    if BLOCK_START_RE.match(masked):
        return 0, len(masked)
    m = WITH_PLSQL_RE.search(masked)
    if not m:
        return None
    ends = [e.end() for e in END_RE.finditer(masked, m.end())]
    return (m.start(), ends[-1]) if ends else (m.start(), len(masked))


def snippet_of(sql: str, start: int, end):
    """The call expression as written. `end` = close paren pos, or None (unbalanced → cut at max)."""
    if end is None:
        raw = sql[start:start + SNIPPET_MAX]
        trunc = True
    else:
        raw = sql[start:end + 1]
        trunc = len(raw) > SNIPPET_MAX
        if trunc:
            raw = raw[:SNIPPET_MAX]
    return WS_RE.sub(" ", raw).strip(), trunc


def scan_calls(sql: str, masked: str):
    """Pass 1: dotted calls with parens. Yields fact tuples (seq assigned by the caller)."""
    region = plsql_region(masked)
    for m in CALL_RE.finditer(masked):
        open_pos = m.end() - 1
        if OUTER_JOIN_RE.match(masked, open_pos + 1):        # alias.col (+)
            continue
        a, b, c = m.group(1), m.group(2), m.group(3)
        schema, pkg, fn = (a, b, c) if c else (None, a, b)
        close_pos, argc = balanced(masked, open_pos)
        snip, trunc = snippet_of(sql, m.start(), close_pos)
        found_in = "plsql" if region and region[0] <= m.start() < region[1] else "sql"
        yield (schema.upper() if schema else None, pkg.upper(), fn.upper(), argc, True, found_in, m.start(), snip, trunc)


BARE_RE = re.compile(rf"(?<![A-Za-z0-9_$#\"'.])({IDENT})\s*\.\s*({IDENT})\b(?!\s*[(.])")


def alias_guard(masked: str, x: str) -> bool:
    """True when `x` is defined as a table/subquery alias somewhere in the statement:
    an object name or a `)` followed by whitespace, optional AS, then x as a whole word."""
    return re.search(rf"(?:\)|[\"A-Za-z0-9_$#])\s+(?:AS\s+)?{re.escape(x)}(?![A-Za-z0-9_$#.\"])", masked, re.I) is not None


def scan_bare(sql: str, masked: str, eligible, objects):
    """Pass 2: PKG.NAME without parens. `eligible` = dictionary packages ∪ packages pass 1 saw with parens."""
    region = plsql_region(masked)
    verdict: dict[str, bool] = {}
    for m in BARE_RE.finditer(masked):
        x = m.group(1).upper()
        ok = verdict.get(x)
        if ok is None:
            ok = (x not in objects
                  and (x in eligible
                       or x.startswith("XX")
                       or ORACLE_PKG_RE.match(x) is not None)
                  and not alias_guard(masked, m.group(1)))
            verdict[x] = ok
        if not ok:
            continue
        # a bare reference is just a name: keep ~40 chars of left context so the sample shows its use
        snip, trunc = snippet_of(sql, max(0, m.start() - 40), m.end() - 1)
        found_in = "plsql" if region and region[0] <= m.start() < region[1] else "sql"
        yield (None, x, m.group(2).upper(), 0, False, found_in, m.start(), snip, trunc)


def statements(conn, batch=BATCH):
    # withhold: the COPY batches commit mid-iteration, which would close a plain server cursor
    with conn.cursor(name="stmts", withhold=True) as cur:
        cur.itersize = batch
        cur.execute("SELECT sql_hash, sql_text FROM work.clear_sql ORDER BY sql_hash")
        for row in cur:
            yield row


def copy_rows(conn, rows):
    with conn.cursor() as cur:
        with cur.copy("COPY work.f_calls (sql_hash, seq, schema_name, package_name, function_name, "
                      "arg_count, paren, found_in, pos, snippet, truncated) FROM STDIN") as cp:
            for r in rows:
                cp.write_row(r)
    conn.commit()


def extract(conn):
    have = conn.execute("SELECT count(*) FROM work.f_calls").fetchone()[0]
    if have:
        raise SystemExit(f"work.f_calls already holds {have} rows — run p3_calls.sql first (a re-run is a rebuild)")
    objects = {r[0] for r in conn.execute(
        "SELECT DISTINCT upper(table_name) FROM work.meta_tables WHERE table_type IN ('TABLE', 'VIEW')")}
    packages = {r[0] for r in conn.execute(
        "SELECT DISTINCT upper(table_name) FROM work.meta_tables WHERE table_type = 'PACKAGE'")}
    log(f"dictionary: {len(objects)} tables/views (column-reference guard), {len(packages)} packages")

    # ---- pass 1: calls with parens ---------------------------------------------------------
    t0 = time.time()
    n_stmt = n_calls = 0
    pkg_stmts: dict[str, set] = {}
    seq_by_hash: dict[str, int] = {}
    buf = []
    for sql_hash, sql in statements(conn):
        n_stmt += 1
        masked = mask(sql)
        seq = 0
        for fact in scan_calls(sql, masked):
            buf.append((sql_hash, seq) + fact)
            seq += 1
            pkg_stmts.setdefault(fact[1], set()).add(sql_hash)
        seq_by_hash[sql_hash] = seq
        n_calls += seq
        if len(buf) >= 5000:
            copy_rows(conn, buf); buf = []
        if n_stmt % 5000 == 0:
            log(f"pass 1: {n_stmt} statements, {n_calls} calls ({time.time() - t0:.0f}s)")
    if buf:
        copy_rows(conn, buf); buf = []
    log(f"pass 1 done: {n_stmt} statements, {n_calls} dotted calls, {len(pkg_stmts)} distinct left parts "
        f"({time.time() - t0:.0f}s)")

    # ---- pass 2: parameterless references ------------------------------------------------------
    eligible = packages | {p for p, s in pkg_stmts.items() if len(s) >= 2 and p not in objects and "_" in p}
    t1 = time.time()
    n_bare = 0
    for sql_hash, sql in statements(conn):
        masked = mask(sql)
        seq = seq_by_hash.get(sql_hash, 0)
        for fact in scan_bare(sql, masked, eligible, objects):
            buf.append((sql_hash, seq) + fact)
            seq += 1
            n_bare += 1
        if len(buf) >= 5000:
            copy_rows(conn, buf); buf = []
    if buf:
        copy_rows(conn, buf)
    log(f"pass 2 done: {n_bare} parameterless references ({time.time() - t1:.0f}s)")


# ------------------------------------------------------------------------------------------ export
EXPORT_COLS = ["api_class", "module", "module_source", "package_name", "function_name", "in_dictionary", "statements", "units", "reports",
               "titles", "by_source", "arg_counts", "found_in", "top_tables", "top_modules", "samples"]


def export(conn, outdir: str):
    os.makedirs(outdir, exist_ok=True)
    rows = conn.execute(
        "SELECT " + ", ".join(EXPORT_COLS) + " FROM work.plsql_api "
        "ORDER BY statements DESC, units DESC, package_name, function_name").fetchall()
    recs = [dict(zip(EXPORT_COLS, r)) for r in rows]
    meta = dict(conn.execute("SELECT k, v FROM work.build_meta").fetchall())
    ranked = conn.execute(
        "SELECT api_class, count(DISTINCT package_name), count(*), sum(statements), sum(units) "
        "FROM work.plsql_api GROUP BY 1 ORDER BY 3 DESC").fetchall()
    scope = conn.execute(
        "SELECT (SELECT count(*) FROM work.clear_sql), (SELECT count(*) FROM work.sql_unit), "
        "(SELECT count(DISTINCT sql_hash) FROM work.f_calls), (SELECT count(*) FROM work.f_calls)").fetchone()

    with open(os.path.join(outdir, "plsql_api_usage.json"), "w", encoding="utf-8") as f:
        json.dump({"generated_by": "scripts/pipeline/p3_calls.py", "scope": {
            "l3_statements": scope[0], "l2_units": scope[1], "statements_with_calls": scope[2], "call_facts": scope[3],
            "ranking": "statements = distinct L3 statements (content-deduped SQL); units = distinct L2 source "
                       "units; reports = distinct BIP catalog paths (bip only — otbi/view carry no path)"},
            "build_meta": meta, "apis": recs}, f, indent=1, default=str)

    with open(os.path.join(outdir, "plsql_api_usage.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["api_class", "module", "package", "function", "statements", "units", "reports", "titles",
                    "by_source", "arg_counts", "found_in", "top_tables", "sample_call", "sample_sql_hash"])
        for r in recs:
            s0 = (r["samples"] or [{}])[0]
            w.writerow([r["api_class"], r["module"], r["package_name"], r["function_name"], r["statements"],
                        r["units"], r["reports"], r["titles"], json.dumps(r["by_source"]), json.dumps(r["arg_counts"]),
                        json.dumps(r["found_in"]),
                        " ".join(f"{t['table']}:{t['statements']}" for t in (r["top_tables"] or [])),
                        s0.get("snippet", ""), s0.get("sql_hash", "")])

    lines = ["# PL/SQL package usage across the Fusion report-SQL corpus", "",
             f"Scope: {scope[0]:,} L3 statements (content-deduped SQL) from {scope[1]:,} L2 units; "
             f"{scope[2]:,} statements carry at least one dotted call; {scope[3]:,} call facts. "
             "Extraction: masked lexical scan (`scripts/pipeline/p3_calls.py`), classification over the "
             "vendor dictionary (`p3_calls_post.sql`). Ranking = distinct statements; `units` = distinct L2 "
             "source units, `reports` = distinct BIP catalog paths (otbi/view have none).", "",
             "## Per class", "", "| class | packages | functions | call statements (sum) | units (sum) |", "|---|---|---|---|---|"]
    for c, np_, nf, ns, nu in ranked:
        lines.append(f"| {c} | {np_} | {nf} | {ns} | {nu} |")
    lines += ["", "## Top 40 by distinct statements", "",
              "| # | package.function | class | module | statements | units | reports | args | top tables |", "|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(recs[:40], 1):
        args = ",".join(sorted(r["arg_counts"].keys(), key=lambda k: (k == "?", int(k) if k.isdigit() else 99))) if r["arg_counts"] else ""
        tt = ", ".join(t["table"] for t in (r["top_tables"] or [])[:3])
        lines.append(f"| {i} | `{r['package_name']}.{r['function_name']}` | {r['api_class']} | {r['module'] or ''} | "
                     f"{r['statements']} | {r['units']} | {r['reports']} | {args} | {tt} |")
    lines += ["", "## Top 40 Fusion application APIs by distinct BIP reports", "",
              "| # | package.function | module | reports | statements | sample |", "|---|---|---|---|---|---|"]
    fus = sorted((r for r in recs if r["api_class"] == "fusion"), key=lambda r: (-r["reports"], -r["statements"]))
    for i, r in enumerate(fus[:40], 1):
        s0 = (r["samples"] or [{}])[0].get("snippet", "").replace("|", "\\|")
        lines.append(f"| {i} | `{r['package_name']}.{r['function_name']}` | {r['module'] or ''} | {r['reports']} | "
                     f"{r['statements']} | `{s0[:110]}` |")
    with open(os.path.join(outdir, "plsql_api_usage.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log(f"exported {len(recs)} apis to {outdir}")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("extract", "export"):
        raise SystemExit("usage: p3_calls.py extract | export <outdir>")
    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    conn.execute("SET statement_timeout = 0")
    if sys.argv[1] == "extract":
        extract(conn)
    else:
        if len(sys.argv) < 3:
            raise SystemExit("export needs <outdir>")
        export(conn, sys.argv[2])
    conn.close()


if __name__ == "__main__":
    main()
