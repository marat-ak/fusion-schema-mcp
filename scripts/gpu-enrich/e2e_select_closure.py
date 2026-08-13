"""E2E validation — STAGE A: pick N big BIP reports and resolve their recursive VIEW-dependency closure.

READ-ONLY. Opens both DBs with mode=ro (no ALTER, no write) so it is safe to run against the pristine
main DB for a dry preview, or against the isolated copy during the full run. Writes only plain files to
OUTDIR (closure.json + id lists) — never touches the DBs.

Env: SQLS, SCH, OUTDIR, N_BIPS (default 10), SELECT_BY (closure|sqllen|tables; default closure).

Selection metric (SELECT_BY):
  closure  -> rank by size of the recursive view-dependency closure, tie-break max closure depth, then
              SQL length. This is the default because the GOAL is to validate the recursive dependency +
              overlay mechanism; big-by-SQL bips are frequently view-poor (proven: the 175K-char bip has
              exactly ONE view dependency), which would not exercise recursion at all.
  sqllen   -> rank purely by length(COALESCE(sql_for_parse, original_sql))  (the literal "biggest" reading).
  tables   -> rank by number of referenced base objects (#x_tables, is_cte=0).

A "view" (per the task) = a name that is either type='VIEW' in schema.tables OR present in view_waves.
Only views present in view_waves have a sql_unit (verified: view_waves == sql_units(source='view')), so
only those are ENRICHABLE via export_wave.py. Schema-VIEWs absent from view_waves (there are ~827) are
referenced-but-unenrichable leaves: counted in the closure, flagged, but not scheduled for enrichment.
"""
import sqlite3, os, re, json, sys

SQLS = os.environ["SQLS"]
SCH = os.environ["SCH"]
OUTDIR = os.environ.get("OUTDIR", ".")
N_BIPS = int(os.environ.get("N_BIPS", "10"))
SELECT_BY = os.environ.get("SELECT_BY", "closure").lower()
os.makedirs(OUTDIR, exist_ok=True)

# same artifact filter export_wave.py uses (XMLTABLE/DUAL/SAWITHn are parse artifacts, never real objects)
ART = re.compile(r'^(XMLTABLE|DUAL|SAWITH\d+)$')

# mode=ro is safe on the copy; when reading the PRISTINE originals (dry preview) set RO_IMMUTABLE=1 so
# SQLite reads the main file directly and creates NO -wal/-shm sidecars in the pristine dir. immutable
# ignores the WAL, which is correct here because the run DB is checkpointed (empty WAL) during a preview.
_RO = "&immutable=1" if os.environ.get("RO_IMMUTABLE") == "1" else ""
con = sqlite3.connect(f"file:{SQLS}?mode=ro{_RO}", uri=True)
sch = sqlite3.connect(f"file:{SCH}?mode=ro{_RO}", uri=True)

viewset = set(n for (n,) in sch.execute("SELECT name FROM tables WHERE type='VIEW'"))
wave = dict(con.execute("SELECT view_name, depth FROM view_waves"))          # enrichable views + their depth


def is_view(t):
    return t in viewset or t in wave


# candidate bips (non-excluded); id is 'sql:<hash>', name is NULL, title is the catalog path
bips = {}
for bid, title, sqllen, ntab in con.execute(
        "SELECT u.id, u.title, length(COALESCE(u.sql_for_parse, u.original_sql)) AS L, "
        "(SELECT COUNT(*) FROM x_tables x WHERE x.unit_id=u.id AND x.is_cte=0) AS NT "
        "FROM sql_units u WHERE u.source='bip-report' AND u.excluded_reason IS NULL"):
    bips[bid] = {"title": title, "sqllen": sqllen or 0, "ntables": ntab or 0}

# ONE streaming pass over x_tables (625K rows, ~1s): build bip->direct-view-refs and view->direct-view-children
bip_direct = {}
child = {}
for uid, t, cte in con.execute("SELECT unit_id, table_name, is_cte FROM x_tables WHERE is_cte=0"):
    if not t or ART.match(t):
        continue
    if uid in bips:
        if is_view(t):
            bip_direct.setdefault(uid, set()).add(t)
    elif uid.startswith("view:"):
        if is_view(t):
            child.setdefault(uid[5:], set()).add(t)


def closure_of(seeds):
    """Transitive view closure via iterative BFS (cycle-safe: 'seen' guard). Views without a sql_unit have
    no entry in `child`, so they terminate as leaves — still counted, never recursed into."""
    seen, stack = set(), list(seeds)
    while stack:
        v = stack.pop()
        if v in seen:
            continue
        seen.add(v)
        for c in child.get(v, ()):
            if c not in seen:
                stack.append(c)
    return seen


def depth_of(v):
    return wave.get(v)                      # None => not enrichable (schema VIEW w/o sql_unit)


# rank all bips
rows = []
for bid, meta in bips.items():
    dv = bip_direct.get(bid, set())
    cl = closure_of(dv) if dv else set()
    maxd = max((wave.get(v, 0) for v in cl), default=0)
    rows.append({"id": bid, "title": meta["title"], "sqllen": meta["sqllen"], "ntables": meta["ntables"],
                 "directViews": sorted(dv), "closureViews": sorted(cl), "maxDepth": maxd})

if SELECT_BY == "sqllen":
    keyf = lambda r: (r["sqllen"], len(r["closureViews"]))
elif SELECT_BY == "tables":
    keyf = lambda r: (r["ntables"], len(r["closureViews"]))
else:
    SELECT_BY = "closure"
    keyf = lambda r: (len(r["closureViews"]), r["maxDepth"], r["sqllen"])
rows.sort(key=keyf, reverse=True)
chosen = rows[:N_BIPS]

# union closure across the chosen bips (each distinct view enriched once, at its depth)
union = set()
for r in chosen:
    union |= set(r["closureViews"])
by_depth = {}
unenrichable = []
for v in sorted(union):
    d = depth_of(v)
    if d is None:
        unenrichable.append(v)
    else:
        by_depth.setdefault(d, []).append(v)

manifest = {
    "params": {"n_bips": N_BIPS, "select_by": SELECT_BY, "sqls": SQLS, "sch": SCH},
    "bips": [{"id": r["id"], "title": r["title"], "sqllen": r["sqllen"], "ntables": r["ntables"],
              "directViewCount": len(r["directViews"]), "closureViewCount": len(r["closureViews"]),
              "maxDepth": r["maxDepth"], "directViews": r["directViews"], "closureViews": r["closureViews"]}
             for r in chosen],
    "closureUnion": {
        "totalViews": len(union),
        "enrichableCount": sum(len(v) for v in by_depth.values()),
        "byDepth": {str(d): by_depth[d] for d in sorted(by_depth)},
        "unenrichable": unenrichable,     # schema VIEW, no sql_unit/wave -> card = schema remark, not enriched
    },
}

with open(os.path.join(OUTDIR, "closure.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
# id lists for the filter step (one id per line)
with open(os.path.join(OUTDIR, "ids.bip.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(r["id"] for r in chosen) + "\n")
depths = sorted(by_depth)
with open(os.path.join(OUTDIR, "depths.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(str(d) for d in depths) + ("\n" if depths else ""))
for d in depths:
    with open(os.path.join(OUTDIR, f"ids.view.w{d}.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join("view:" + v for v in by_depth[d]) + "\n")

# ---- human-readable preview (this is the read-only proof the caller runs to validate logic) ----
print("=" * 100)
print(f"E2E SELECTION  select_by={SELECT_BY}  n_bips={N_BIPS}  candidate_bips={len(bips)}")
print("=" * 100)
print(f"{'#':>2}  {'closV':>5} {'maxD':>4} {'dirV':>4} {'sqllen':>7} {'ntab':>4}  title")
for i, r in enumerate(chosen, 1):
    print(f"{i:>2}  {len(r['closureViews']):>5} {r['maxDepth']:>4} {len(r['directViews']):>4} "
          f"{r['sqllen']:>7} {r['ntables']:>4}  {(r['title'] or '')[:62]}")
    print(f"     id={r['id']}")

print("\n---- per-bip closure by depth (view counts; sample names) ----")
for i, r in enumerate(chosen, 1):
    cl = set(r["closureViews"])
    bd = {}
    un = []
    for v in sorted(cl):
        d = depth_of(v)
        (un if d is None else bd.setdefault(d, [])).append(v)
    parts = "  ".join(f"d{d}:{len(bd[d])}" for d in sorted(bd)) or "(none)"
    print(f"#{i:<2} closure={len(cl):>3}  {parts}" + (f"  unenrichable:{len(un)}" if un else ""))
    for d in sorted(bd):
        print(f"      d{d}: {', '.join(bd[d][:8])}" + (" ..." if len(bd[d]) > 8 else ""))
    if un:
        print(f"      unenrichable(schema-VIEW,no-wave): {', '.join(un[:8])}" + (" ..." if len(un) > 8 else ""))

print("\n---- UNION closure across the chosen bips (drives the enrich loop) ----")
print(f"total distinct views: {len(union)}   enrichable: {manifest['closureUnion']['enrichableCount']}   "
      f"unenrichable: {len(unenrichable)}")
for d in sorted(by_depth):
    print(f"  depth {d}: {len(by_depth[d])} views")
if unenrichable:
    print(f"  unenrichable (no wave/sql_unit; carried as schema-remark cards): {len(unenrichable)}")
    print(f"    {', '.join(unenrichable[:12])}" + (" ..." if len(unenrichable) > 12 else ""))
print(f"\nwrote: closure.json, ids.bip.txt, depths.txt ({','.join(map(str, depths)) or '-'}), "
      f"ids.view.w*.txt -> {OUTDIR}")

# comparison: pure SQL-length ranking (so the caller can see what 'biggest by SQL' would have picked)
print("\n---- FOR REFERENCE: top 10 by SQL length (NOT selected unless SELECT_BY=sqllen) ----")
for r in sorted(rows, key=lambda r: r["sqllen"], reverse=True)[:10]:
    print(f"  sqllen={r['sqllen']:>7}  closV={len(r['closureViews']):>3}  dirV={len(r['directViews']):>3}  "
          f"{(r['title'] or '')[:58]}")
