"""Round-0 deterministic extraction over sqls.sqlite (NO semantics, NO regex classification).

Per sql_unit: parse with sqlglot (dialect=oracle), two-phase schema-fed qualify, then walk the AST:
  x_tables      physical tables/views referenced (CTE names excluded, flagged)
  x_columns     alias-resolved column references w/ context (select|where|join|group|order|having)
  x_joins       equi-join pairs (ANSI ON + comma-join WHERE equalities), join type
  x_predicates  <table.column> <op> <literal> facts + found_in (where|join|case|exists|subquery|having)
  x_params      :binds and &lexical parameters (BIP)
  x_projection  top-level output columns: alias + source expression (the unit's public interface)

parse_quality: full | full_lex (lexical-substituted) | fallback (tables only, tokenizer) | failed.
Resumable: only units WHERE parse_quality IS NULL are processed. Multiprocess: workers parse,
the parent writes (single writer).

Run:  docker run --rm -v /opt/fusion-catalog-v2:/data python:3.12-slim sh -c \
        "pip install -q sqlglot && python /data/sqlglot_extract.py"
"""
import json
import multiprocessing as mp
import re
import sqlite3
import sys
import time

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import traverse_scope

DB = "/data/sqls.sqlite"
SCHEMA_DB = "/data/schema.sqlite"
DIALECT = "oracle"
LIT_MAX = 120
EXPR_MAX = 200
BATCH = 400          # units fetched per work batch
PROCS = max(2, mp.cpu_count() - 1)

LEX_RE = re.compile(r"&&?([A-Za-z_][A-Za-z0-9_]*)")


# ----------------------------------------------------------------------------- worker side
_schema_conn = None  # per-process lazy connection for column lookups


def _columns_for(tables):
    """table -> {column: 'TEXT'} map for qualify(), from schema-v2 (per-process connection)."""
    global _schema_conn
    if _schema_conn is None:
        _schema_conn = sqlite3.connect(f"file:{SCHEMA_DB}?mode=ro", uri=True)
    out = {}
    q = _schema_conn.execute(
        f"SELECT table_name, name FROM columns WHERE table_name IN ({','.join('?' * len(tables))})",
        list(tables),
    )
    for t, c in q:
        out.setdefault(t, {})[c] = "TEXT"
    return out


def _context_of(node):
    """Nearest meaningful ancestor bucket for a predicate/column."""
    p = node.parent
    while p is not None:
        if isinstance(p, exp.Exists):
            return "exists"
        if isinstance(p, exp.Case):
            return "case"
        if isinstance(p, exp.Join):
            return "join"
        if isinstance(p, exp.Where):
            return "where"
        if isinstance(p, exp.Having):
            return "having"
        if isinstance(p, exp.Group):
            return "group"
        if isinstance(p, exp.Order):
            return "order"
        if isinstance(p, exp.Select) and p.parent is not None:
            return "subquery"
        p = p.parent
    return "select"


def _is_literal(node):
    if isinstance(node, exp.Literal):
        return True
    if isinstance(node, exp.Neg) and isinstance(node.this, exp.Literal):
        return True
    if isinstance(node, (exp.CurrentDate, exp.CurrentTimestamp)):
        return True
    if isinstance(node, exp.Anonymous) and (node.this or "").upper() == "SYSDATE":
        return True
    if isinstance(node, exp.Column) and (node.name or "").upper() == "SYSDATE" and not node.table:
        return True
    if isinstance(node, exp.Tuple) and all(_is_literal(e) for e in node.expressions):
        return True
    return False


def _lit_text(node):
    return node.sql(dialect=DIALECT)[:LIT_MAX]


def extract_one(unit):
    """Returns dict of extraction lists or raises. unit = (id, source, sql)."""
    uid, source, sql = unit
    quality = "full"
    lex_params = []

    try:
        parsed = sqlglot.parse(sql, dialect=DIALECT)
    except Exception:
        # BIP lexical &PARAMs make raw text unparseable — substitute NULL and retry once.
        lex_params = sorted(set(LEX_RE.findall(sql)))
        if not lex_params:
            raise
        subbed = LEX_RE.sub("NULL", sql)
        parsed = sqlglot.parse(subbed, dialect=DIALECT)
        quality = "full_lex"

    tables, ctes = set(), set()
    columns, joins, predicates, params, projection = [], [], [], [], []

    for stmt in parsed:
        if stmt is None:
            continue
        for cte in stmt.find_all(exp.CTE):
            ctes.add(cte.alias_or_name.upper())
        for t in stmt.find_all(exp.Table):
            nm = (t.name or "").upper()
            if nm and nm not in ctes and nm != "DUAL":
                tables.add(nm)

    # qualify with real schema (two-phase) — resolves unqualified columns + expands stars.
    schema_map = _columns_for(sorted(tables)) if tables else {}
    qparsed = []
    for stmt in parsed:
        if stmt is None:
            continue
        try:
            qparsed.append(qualify(stmt, schema=schema_map, dialect=DIALECT,
                                   validate_qualify_columns=False, identify=False))
        except Exception:
            qparsed.append(stmt)  # qualify is best-effort; raw stmt still walkable

    for stmt in qparsed:
        # ---- scope-aware alias resolution: per scope, alias -> physical table (or None if derived)
        try:
            scopes = list(traverse_scope(stmt))
        except Exception:
            scopes = []

        def resolve(scope, col):
            """Column -> physical table name, resolved through THIS scope's sources."""
            al = col.table or ""
            if al:
                src = scope.sources.get(al) or scope.sources.get(al.upper()) or scope.sources.get(al.lower())
                if isinstance(src, exp.Table):
                    nm = (src.name or "").upper()
                    return nm if nm in tables else None
                return None  # derived table / CTE / unknown alias
            # unqualified: unique physical source in scope wins
            phys = [s for s in scope.sources.values() if isinstance(s, exp.Table)]
            if len(phys) == 1:
                nm = (phys[0].name or "").upper()
                return nm if nm in tables else None
            return None

        for scope in scopes:
            # columns w/ context
            for c in scope.find_all(exp.Column):
                tn = resolve(scope, c)
                if tn:
                    columns.append((tn, (c.name or "").upper(), _context_of(c)))

            # predicates: <col> op <literal>
            for node in scope.find_all(exp.Binary):
                if isinstance(node, (exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Like)):
                    l, r = node.left, node.expression
                    col, lit = (l, r) if isinstance(l, exp.Column) else (r, l) if isinstance(r, exp.Column) else (None, None)
                    if col is None or not _is_literal(lit):
                        continue
                    tn = resolve(scope, col)
                    if not tn:
                        continue
                    predicates.append((tn, (col.name or "").upper(), node.key.upper(), _lit_text(lit), _context_of(node)))
            for node in scope.find_all(exp.In):
                col = node.this
                if isinstance(col, exp.Column) and node.expressions and all(_is_literal(e) for e in node.expressions):
                    tn = resolve(scope, col)
                    if tn:
                        lits = ",".join(_lit_text(e) for e in node.expressions)[:LIT_MAX]
                        predicates.append((tn, (col.name or "").upper(), "IN", lits, _context_of(node)))
            for node in scope.find_all(exp.Between):
                col = node.this
                if isinstance(col, exp.Column) and _is_literal(node.args.get("low")) and _is_literal(node.args.get("high")):
                    tn = resolve(scope, col)
                    if tn:
                        lit = f"{_lit_text(node.args['low'])} AND {_lit_text(node.args['high'])}"[:LIT_MAX]
                        predicates.append((tn, (col.name or "").upper(), "BETWEEN", lit, _context_of(node)))

            # joins: ANSI ON equalities + comma-join WHERE equalities (col = col across tables)
            def join_pairs(node_, jtype):
                for eqn in node_.find_all(exp.EQ):
                    l, r = eqn.left, eqn.expression
                    if isinstance(l, exp.Column) and isinstance(r, exp.Column):
                        lt, rt = resolve(scope, l), resolve(scope, r)
                        if lt and rt and lt != rt:
                            joins.append((lt, (l.name or "").upper(), rt, (r.name or "").upper(), jtype))

            for j in scope.find_all(exp.Join):
                on = j.args.get("on")
                if on is not None:
                    join_pairs(on, (j.kind or j.side or "INNER").upper())
            for w in scope.find_all(exp.Where):
                join_pairs(w, "WHERE")

        # binds (statement-wide; no scope needed)
        for p in stmt.find_all(exp.Placeholder):
            nm = p.name if isinstance(p.name, str) else p.sql(dialect=DIALECT)
            params.append((str(nm), "bind"))
        for p in stmt.find_all(exp.Parameter):
            params.append((p.sql(dialect=DIALECT).lstrip(":@"), "bind"))

    # projection: top-level statement output columns (interface of the unit)
    top = qparsed[0] if qparsed else None
    if isinstance(top, exp.Select) or (top is not None and isinstance(top, (exp.Union,))):
        sel = top
        while isinstance(sel, exp.Union):
            sel = sel.this
        if isinstance(sel, exp.Select):
            for i, e in enumerate(sel.expressions):
                alias = (e.alias_or_name or "").upper()
                src = e.this.sql(dialect=DIALECT)[:EXPR_MAX] if isinstance(e, exp.Alias) else e.sql(dialect=DIALECT)[:EXPR_MAX]
                projection.append((i, alias, src))

    for lp in lex_params:
        params.append((lp, "lexical"))

    return {
        "id": uid, "quality": quality, "error": None,
        "tables": sorted(tables), "ctes": sorted(ctes),
        "columns": sorted(set(columns)), "joins": sorted(set(joins)),
        "predicates": list(dict.fromkeys(predicates)), "params": sorted(set(params)),
        "projection": projection,
    }


def fallback_tables(sql):
    """Tokenizer-level FROM/JOIN table sniff for units the parser cannot handle at all."""
    out = set()
    try:
        toks = list(sqlglot.tokenize(sql, dialect=DIALECT))
    except Exception:
        return out
    prev_kw = None
    for t in toks:
        v = t.text.upper()
        if t.token_type.name in ("FROM", "JOIN"):
            prev_kw = "T"
            continue
        if prev_kw == "T" and t.token_type.name in ("VAR", "IDENTIFIER"):
            out.add(v)
            prev_kw = None
        elif prev_kw == "T" and t.token_type.name not in ("L_PAREN",):
            prev_kw = None
    return out


def work(unit):
    uid, source, sql = unit
    if not sql or not sql.strip():
        return {"id": uid, "quality": "failed", "error": "empty sql"}
    try:
        return extract_one(unit)
    except Exception as e:
        tabs = fallback_tables(sql)
        return {
            "id": uid, "quality": "fallback" if tabs else "failed",
            "error": f"{type(e).__name__}: {str(e)[:200]}",
            "tables": sorted(tabs), "ctes": [], "columns": [], "joins": [],
            "predicates": [], "params": [], "projection": [],
        }


# ----------------------------------------------------------------------------- parent side
def main():
    con = sqlite3.connect(DB)
    con.execute("PRAGMA journal_mode=WAL")
    total = con.execute("SELECT COUNT(*) FROM sql_units WHERE parse_quality IS NULL").fetchone()[0]
    print(f"[extract] pending units: {total}  procs={PROCS}", flush=True)
    done = 0
    t0 = time.time()

    while True:
        rows = con.execute(
            "SELECT id, source, sql_for_parse FROM sql_units WHERE parse_quality IS NULL LIMIT ?",
            (BATCH * PROCS,),
        ).fetchall()
        if not rows:
            break
        with mp.Pool(PROCS) as pool:
            results = pool.map(work, rows, chunksize=25)

        cur = con.cursor()
        cur.execute("BEGIN")
        for r in results:
            uid = r["id"]
            cur.execute("UPDATE sql_units SET parse_quality=?, parse_error=? WHERE id=?",
                        (r["quality"], r.get("error"), uid))
            if r["quality"] == "failed" and not r.get("tables"):
                continue
            cur.executemany("INSERT INTO x_tables (unit_id, table_name, is_cte) VALUES (?,?,0)",
                            [(uid, t) for t in r.get("tables", [])])
            cur.executemany("INSERT INTO x_tables (unit_id, table_name, is_cte) VALUES (?,?,1)",
                            [(uid, t) for t in r.get("ctes", [])])
            cur.executemany("INSERT INTO x_columns (unit_id, table_name, column_name, context) VALUES (?,?,?,?)",
                            [(uid, a, b, c) for a, b, c in r.get("columns", [])])
            cur.executemany("INSERT INTO x_joins (unit_id, from_t, from_c, to_t, to_c, join_type) VALUES (?,?,?,?,?,?)",
                            [(uid, a, b, c, d, e) for a, b, c, d, e in r.get("joins", [])])
            cur.executemany("INSERT INTO x_predicates (unit_id, seq, table_name, column_name, op, literal, found_in) VALUES (?,?,?,?,?,?,?)",
                            [(uid, i, a, b, c, d, e) for i, (a, b, c, d, e) in enumerate(r.get("predicates", []))])
            cur.executemany("INSERT INTO x_params (unit_id, name, kind) VALUES (?,?,?)",
                            [(uid, a, b) for a, b in r.get("params", [])])
            cur.executemany("INSERT INTO x_projection (unit_id, seq, alias, source_expr) VALUES (?,?,?,?)",
                            [(uid, i, a, b) for i, a, b in r.get("projection", [])])
        con.commit()
        done += len(results)
        rate = done / max(1e-9, time.time() - t0)
        print(f"[extract] {done}/{total}  ({rate:.0f}/s)", flush=True)

    q = con.execute("SELECT parse_quality, COUNT(*) FROM sql_units GROUP BY parse_quality").fetchall()
    print("[extract] DONE quality breakdown:", q, flush=True)
    con.close()


if __name__ == "__main__":
    sys.exit(main())
