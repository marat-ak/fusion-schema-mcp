"""X1 — EXPERIMENT. The same pinned sqlglot parse, run over the Qwen REWRITE.

Not part of the release build. It answers one question: does parsing
`work.clear_sql.rewritten_sql` (the model's legible reconstruction of the OBIS SQL)
yield better tables/joins than parsing the machine `sql_text` directly — i.e. should
OTBI become a two-pass flow?

It is a thin I/O shim over the EXISTING pieces, so the comparison is fair by
construction:

  * the extractor is `scripts/sqlglot_extract.py`, imported unchanged (same
    `work()`, same `SQLGLOT_PIN` assertion at import — a wrong sqlglot refuses to run);
  * the dictionary loader and resolver are `p3_parse.load_dictionary` / `p3_parse.resolver`,
    imported from the release driver rather than re-implemented, so BOTH parses see the
    same UNFILTERED `work.meta_columns` (1.45M columns / 29.8k objects). That matters:
    without a dictionary `qualify()` silently DROPS unresolvable columns instead of
    raising, which would make the rewrite look better for free.

  in   work.clear_sql (sql_hash, source, rewritten_sql) WHERE source='otbi'
  out  work.f2_tables + work.f2_joins + work.facts2_run   (x1_facts2.sql)

Run (see x1_parse_rewrite.sh).
"""
import multiprocessing as mp
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psycopg  # noqa: E402
import sqlglot_extract  # noqa: E402
from sqlglot_extract import SQLGLOT_PIN, work  # noqa: E402

import p3_parse  # noqa: E402  — reuse the release driver's dictionary loader + resolver

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required — no default")

LIMIT = int(os.environ.get("PARSE_LIMIT") or 0)
PROCS = int(os.environ.get("PARSE_PROCS") or max(2, mp.cpu_count() - 2))
BATCH = int(os.environ.get("PARSE_BATCH") or 2000)


def log(msg):
    print(f"[x1-parse] {msg}", flush=True)


def write(conn, results):
    """Single writer. facts2_run is the resume marker, written LAST."""
    with conn.cursor() as cur:
        with cur.copy("COPY work.f2_tables (sql_hash, table_name, is_cte) FROM STDIN") as cp:
            for r in results:
                for t in r.get("tables", []):
                    cp.write_row((r["id"], t, False))
                for t in r.get("ctes", []):
                    cp.write_row((r["id"], t, True))
        with cur.copy("COPY work.f2_joins (sql_hash, from_t, from_c, to_t, to_c, join_type) FROM STDIN") as cp:
            for r in results:
                for a, b, c, d, e in r.get("joins", []):
                    cp.write_row((r["id"], a, b, c, d, e))
        with cur.copy("COPY work.facts2_run (sql_hash, parser_version, parse_quality, parse_error) FROM STDIN") as cp:
            for r in results:
                cp.write_row((r["id"], SQLGLOT_PIN, r["quality"], r.get("error")))
    conn.commit()


def main():
    log(f"sqlglot {SQLGLOT_PIN} pinned · procs={PROCS} · batch={BATCH} · INPUT = rewritten_sql")
    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    conn.execute("SET statement_timeout = 0")

    # the release driver's own loader, filling the release driver's own DICT;
    # `p3_parse.resolver` closes over that module global.
    p3_parse.load_dictionary(conn)
    sqlglot_extract.COLUMNS_RESOLVER = p3_parse.resolver   # installed BEFORE the pool forks

    todo = conn.execute(
        "SELECT count(*) FROM work.clear_sql c "
        "WHERE c.source = 'otbi' AND c.rewritten_sql IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM work.facts2_run f WHERE f.sql_hash = c.sql_hash)"
    ).fetchone()[0]
    log(f"rewrites to parse: {todo}")
    if LIMIT:
        log(f"PARSE_LIMIT={LIMIT} — SAMPLE RUN")

    done = 0
    t0 = time.time()
    pool = mp.Pool(PROCS)
    try:
        while True:
            rows = conn.execute(
                "SELECT c.sql_hash, c.source, c.rewritten_sql FROM work.clear_sql c "
                "WHERE c.source = 'otbi' AND c.rewritten_sql IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM work.facts2_run f WHERE f.sql_hash = c.sql_hash) "
                "ORDER BY length(c.rewritten_sql) LIMIT %s", (BATCH,)).fetchall()
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

    q = conn.execute("SELECT parse_quality, count(*) FROM work.facts2_run GROUP BY 1 ORDER BY 2 DESC").fetchall()
    log(f"DONE in {time.time() - t0:.0f}s — quality: {q}")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
