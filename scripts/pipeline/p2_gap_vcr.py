"""P2-gap (0) — land the derived VIEW column remarks in `work`.

WHY THIS EXISTS. The vendor dictionary carries a remark on 99.9 % of TABLE columns and on
**0.0 %** of VIEW columns (1,205,092 of 1,205,723 against 0 of 243,778, measured). Every VIEW
column meaning the 2026-08 enrichment ever saw came from ONE derived table — base remark
inherited through the view's projection, plus `computed` / `constant` / `unresolved` verdicts —
built during the v2 catalog pass and never carried into `raw`. Without it a ported export drops
5,853 column references across 575 of the un-enriched statements, and the prompt goes quiet on
exactly the objects BIP data models are written against.

WHERE IT COMES FROM, AND THE CARE THAT TAKES. `/root/enrich-run/sqls.sqlite` — 3.7 GB, WAL mode,
**the only copy**. It is also the database the 2026-08 run itself read, so it is evidence, not a
working file. Opened `mode=ro&immutable=1`: immutable makes SQLite skip locking and the WAL
entirely, so no `-wal` / `-shm` is created beside it. The directory is mounted read-only in the
container as well (`p2_gap.sh vcr`), so a bug cannot write where a flag might. Size, mtime and
md5 are checked unchanged after the load.

`view_column_remarks(view, column, remark, kind, src_table, src_col)` — 222,510 rows over 5,982
views, 200,438 with a remark. `view`/`column` are reserved words in Postgres and are landed as
`view_name`/`column_name`, matching what `meta_columns` and `f_columns` already call them.

`seq` IS LOAD-BEARING, not a tidy surrogate. `export_wave.py` builds its lookup as
`vrem[(v, c)] = rm` over an unordered scan — on a sqlite rowid table that is rowid order, and
LAST WINS. 20 (view, column) pairs occur twice and **2 of those carry different remarks**, so
which row wins is a real choice. `seq` is the sqlite rowid, and the exporter rebuilds the dict in
`seq` order, so the same remark wins here as won there.

NOT PART OF THE p0-p8 CHAIN. `p0_fn.sql` drops and recreates `work`; this table is acquisition
from outside the database, like the Qwen JSONL, and a rebuild from p0 drops it. Re-run this step
after any rebuild, or fold it into `p1_l2_l3.sql` beside the `meta_*` copies.

  SQLITE=/data/sqls.sqlite DATABASE_URL=... python p2_gap_vcr.py
"""
import os
import sqlite3
import sys

import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required — no default")

SQLITE = os.environ.get("SQLITE")
if not SQLITE:
    raise SystemExit("SQLITE is required (path to the run's sqls.sqlite) — no default")

DDL = """
DROP TABLE IF EXISTS work.view_column_remarks CASCADE;
CREATE TABLE work.view_column_remarks (
  seq         bigint PRIMARY KEY,  -- the sqlite rowid; the exporter replays in this order
  view_name   text NOT NULL,       -- sqlite column "view"
  column_name text NOT NULL,       -- sqlite column "column"
  remark      text,                -- NULL where the derivation found no meaning
  kind        text,                -- passthrough | computed | constant | unresolved
  src_table   text,                -- passthrough: the base object the remark was inherited from
  src_col     text
);
"""


def log(m):
    print(f"[p2-gap-vcr] {m}", flush=True)


def main():
    if not os.path.exists(SQLITE):
        raise SystemExit(f"SQLITE={SQLITE} does not exist")
    before = os.stat(SQLITE)
    log(f"source {SQLITE} size={before.st_size} mtime={int(before.st_mtime)} (read-only, immutable)")

    con = sqlite3.connect(f"file:{SQLITE}?mode=ro&immutable=1", uri=True)
    n_total = con.execute("SELECT count(*) FROM view_column_remarks").fetchone()[0]
    rows = con.execute(
        'SELECT rowid, "view", "column", remark, kind, src_table, src_col '
        'FROM view_column_remarks ORDER BY rowid').fetchall()
    con.close()
    if len(rows) != n_total:
        raise SystemExit(f"read {len(rows)} of {n_total} rows")
    log(f"read {len(rows)} rows")

    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    conn.execute("SET statement_timeout = 0")
    conn.execute(DDL)
    with conn.cursor() as cur:
        with cur.copy("COPY work.view_column_remarks "
                      "(seq, view_name, column_name, remark, kind, src_table, src_col) "
                      "FROM STDIN") as cp:
            for r in rows:
                cp.write_row(r)
    conn.execute("CREATE INDEX ix_vcr_view_col ON work.view_column_remarks (view_name, column_name)")
    conn.execute("ANALYZE work.view_column_remarks")
    conn.commit()

    got = conn.execute("SELECT count(*), count(remark), count(DISTINCT view_name) "
                       "FROM work.view_column_remarks").fetchone()
    log(f"work.view_column_remarks: {got[0]} rows, {got[1]} with a remark, over {got[2]} views")
    if got[0] != len(rows):
        raise SystemExit(f"load mismatch: staged {len(rows)} but table holds {got[0]}")
    for kind, k in conn.execute("SELECT kind, count(*) FROM work.view_column_remarks "
                                "GROUP BY 1 ORDER BY 2 DESC"):
        log(f"  {kind}: {k}")
    dups = conn.execute(
        "SELECT count(*) FROM (SELECT view_name, column_name FROM work.view_column_remarks "
        "GROUP BY 1,2 HAVING count(DISTINCT coalesce(remark,'')) > 1) d").fetchone()[0]
    log(f"  (view,column) pairs whose duplicate rows disagree: {dups} — seq order decides, last wins")
    conn.close()

    after = os.stat(SQLITE)
    if (after.st_size, int(after.st_mtime)) != (before.st_size, int(before.st_mtime)):
        raise SystemExit(f"SOURCE CHANGED: {before.st_size}/{int(before.st_mtime)} -> "
                         f"{after.st_size}/{int(after.st_mtime)}")
    stray = [p for p in (SQLITE + "-wal", SQLITE + "-shm")
             if os.path.exists(p) and os.path.getsize(p) > 0]
    log(f"source unchanged (size and mtime); non-empty sidecars: {stray or 'none'}")


if __name__ == "__main__":
    sys.exit(main())
