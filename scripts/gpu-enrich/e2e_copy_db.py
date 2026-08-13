"""Consistent online copy of a (possibly live-written) SQLite DB via the backup API.

Used by e2e_bip_test.sh when COPY_MODE=backup. Unlike `cp`, sqlite3's backup API takes a transactionally
consistent page-by-page snapshot even while another process is writing the source (relevant here: a live
run_waves.sh may be mid-persist on /root/enrich-run/sqls.sqlite). Source is opened read-only and never
written. Usage:  python3 e2e_copy_db.py SRC.sqlite DST.sqlite
"""
import sqlite3, os, sys, time

SRC, DST = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)   # read-only: never writes the pristine source
dst = sqlite3.connect(DST)
t = time.time()
done = {"p": 0}


def _progress(status, remaining, total):
    if total:
        done["p"] = 100 * (total - remaining) // total


src.backup(dst, pages=20000, progress=_progress)          # consistent snapshot, coexists with a live writer
dst.commit(); dst.close(); src.close()
print(f"[copy-backup] {SRC} -> {DST}  {os.path.getsize(DST)} bytes  {time.time()-t:.1f}s")
