"""P3 — the REAL sqlglot parse over the 26,204 L3 statements, keyed on sql_hash.

This is a DRIVER, not a second extractor: it imports `work()` / `extract_one()` from
scripts/sqlglot_extract.py unchanged and only replaces that module's I/O ends —

  in   work.clear_sql (sql_hash, source, sql_text)      instead of sqls.sqlite sql_units
  dict work.meta_columns                                 instead of schema.sqlite columns
  out  work.f_* + work.facts_run                         instead of the x_* tables

The dictionary matters. `qualify()` binds an unqualified column to a table only if it knows that
table's columns; without the dictionary those references are SILENTLY DROPPED rather than raising,
so the parse would look like it succeeded while producing thin facts. `work.meta_columns` is the
UNFILTERED 1,449,501-row vendor dictionary (29,802 objects) — a superset of the TABLE/VIEW-filtered
one compile.ts ships — and it is loaded ONCE in the parent so forked workers share it.

The parser version is pinned in sqlglot_extract.SQLGLOT_PIN and asserted at import; it is written
to work.facts_run.parser_version and to v<ver>.facts_meta.

Run (see p3_parse.sh):
  docker run --rm --network oservices_default -v <repo>/scripts:/app/scripts \
    -e DATABASE_URL=postgresql://postgres:<pw>@stack-db:5432/fusion_dev \
    python:3.12-slim sh -c "pip install -q 'sqlglot==30.18.0' 'psycopg[binary]' &&
                            python /app/scripts/pipeline/p3_parse.py"
"""
import multiprocessing as mp
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import psycopg  # noqa: E402
import sqlglot_extract  # noqa: E402
from sqlglot_extract import SQLGLOT_PIN, work  # noqa: E402

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required — no default")

# `or` not a default: the runner exports these unconditionally, so an unset one arrives as ""
LIMIT = int(os.environ.get("PARSE_LIMIT") or 0)          # 0 = everything (sample mode for smoke runs)
PROCS = int(os.environ.get("PARSE_PROCS") or max(2, mp.cpu_count() - 2))
BATCH = int(os.environ.get("PARSE_BATCH") or 2000)       # statements fetched per write cycle

#: table -> {column: "TEXT"}; built once in the parent, inherited by every forked worker.
DICT: dict = {}


def resolver(tables):
    return {t: DICT[t] for t in tables if t in DICT}


def log(msg):
    print(f"[p3-parse] {msg}", flush=True)


def load_dictionary(conn):
    t0 = time.time()
    n = 0
    with conn.cursor(name="dict") as cur:          # server-side cursor: 1.45M rows, bounded memory
        cur.itersize = 100_000
        cur.execute("SELECT table_name, column_name FROM work.meta_columns "
                    "WHERE table_name IS NOT NULL AND column_name IS NOT NULL")
        for t, c in cur:
            # intern: ~1.45M column names over ~30k tables repeat heavily (CREATED_BY, LAST_UPDATE_DATE…)
            d = DICT.get(t)
            if d is None:
                d = DICT[sys.intern(t)] = {}
            d[sys.intern(c)] = "TEXT"
            n += 1
    log(f"dictionary: {n} columns over {len(DICT)} objects in {time.time() - t0:.1f}s")


def write(conn, results):
    """Single writer, COPY per fact table. facts_run is the resume marker, written LAST."""
    with conn.cursor() as cur:
        with cur.copy("COPY work.f_tables (sql_hash, table_name, is_cte) FROM STDIN") as cp:
            for r in results:
                for t in r.get("tables", []):
                    cp.write_row((r["id"], t, False))
                for t in r.get("ctes", []):
                    cp.write_row((r["id"], t, True))
        with cur.copy("COPY work.f_columns (sql_hash, table_name, column_name, context) FROM STDIN") as cp:
            for r in results:
                for a, b, c in r.get("columns", []):
                    cp.write_row((r["id"], a, b, c))
        with cur.copy("COPY work.f_joins (sql_hash, from_t, from_c, to_t, to_c, join_type) FROM STDIN") as cp:
            for r in results:
                for a, b, c, d, e in r.get("joins", []):
                    cp.write_row((r["id"], a, b, c, d, e))
        with cur.copy("COPY work.f_predicates (sql_hash, seq, table_name, column_name, op, literal, found_in) FROM STDIN") as cp:
            for r in results:
                for i, (a, b, c, d, e) in enumerate(r.get("predicates", [])):
                    cp.write_row((r["id"], i, a, b, c, d, e))
        with cur.copy("COPY work.f_params (sql_hash, name, kind) FROM STDIN") as cp:
            for r in results:
                for a, b in r.get("params", []):
                    cp.write_row((r["id"], a, b))
        with cur.copy("COPY work.f_projection (sql_hash, seq, alias, source_expr) FROM STDIN") as cp:
            for r in results:
                for i, a, b in r.get("projection", []):
                    cp.write_row((r["id"], i, a, b))
        with cur.copy("COPY work.facts_run (sql_hash, parser_version, parse_quality, parse_error) FROM STDIN") as cp:
            for r in results:
                cp.write_row((r["id"], SQLGLOT_PIN, r["quality"], r.get("error")))
    conn.commit()


def main():
    log(f"sqlglot {SQLGLOT_PIN} pinned · procs={PROCS} · batch={BATCH}")
    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    conn.execute("SET statement_timeout = 0")

    load_dictionary(conn)
    sqlglot_extract.COLUMNS_RESOLVER = resolver   # installed BEFORE the pool forks

    todo = conn.execute(
        "SELECT count(*) FROM work.clear_sql c "
        "WHERE NOT EXISTS (SELECT 1 FROM work.facts_run f WHERE f.sql_hash = c.sql_hash)"
    ).fetchone()[0]
    log(f"statements to parse: {todo}")
    if LIMIT:
        log(f"PARSE_LIMIT={LIMIT} — SAMPLE RUN, not a release build")

    done = 0
    t0 = time.time()
    pool = mp.Pool(PROCS)
    try:
        while True:
            rows = conn.execute(
                "SELECT c.sql_hash, c.source, c.sql_text FROM work.clear_sql c "
                "WHERE NOT EXISTS (SELECT 1 FROM work.facts_run f WHERE f.sql_hash = c.sql_hash) "
                "ORDER BY length(c.sql_text) LIMIT %s", (BATCH,)).fetchall()
            if not rows:
                break
            results = pool.map(work, rows, chunksize=8)
            write(conn, results)
            done += len(results)
            log(f"{done}/{todo}  ({done / max(1e-9, time.time() - t0):.0f}/s)")
            if LIMIT and done >= LIMIT:
                break
    finally:
        pool.close()
        pool.join()

    q = conn.execute("SELECT parse_quality, count(*) FROM work.facts_run GROUP BY 1 ORDER BY 2 DESC").fetchall()
    log(f"DONE in {time.time() - t0:.0f}s — quality: {q}")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
