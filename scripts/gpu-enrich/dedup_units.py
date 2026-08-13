"""Storage-level dedup of byte-identical sql_units (OTBI catalog explosion: same fragment linked under
thousands of catalog paths — 74,400 of 85,688 otbi units are exact copies). Keeps ONE canonical unit per
distinct SQL; every path survives as a pointer row in unit_aliases (answers: all paths of a query; which
subject areas use table X). Views/bip are NOT deduped (3%/2% dup, already enriched per-name, and view names
carry the card-grounding chain).

  SQLS=sqls.sqlite SOURCES=otbi python3 dedup_units.py
Idempotent: re-running after a dedup finds nothing to merge. Writes canonical_map.json {old_id: canonical_id}.
"""
import sqlite3, hashlib, json, os, collections

SQLS = os.environ.get("SQLS", "sqls.sqlite")
SOURCES = [s.strip() for s in os.environ.get("SOURCES", "otbi").split(",") if s.strip()]
MAPF = os.environ.get("MAPF", "canonical_map.json")

con = sqlite3.connect(SQLS)
con.execute("""CREATE TABLE IF NOT EXISTS unit_aliases(
    alias_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, title TEXT, subject_area TEXT, source TEXT)""")
con.execute("CREATE INDEX IF NOT EXISTS ix_unit_aliases_unit ON unit_aliases(unit_id)")

# fact tables keyed by unit_id (x_tables, x_predicates, ...) — discovered, not hardcoded
xtabs = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'x_%'")
         if any(c[1] == "unit_id" for c in con.execute(f"PRAGMA table_info({r[0]})"))]

cmap = json.load(open(MAPF, encoding="utf-8")) if os.path.exists(MAPF) else {}
tot_merged = 0
for src in SOURCES:
    groups = collections.defaultdict(list)
    for uid, title, sql in con.execute(
            "SELECT id,title,COALESCE(sql_for_parse,original_sql) FROM sql_units WHERE source=? AND excluded_reason IS NULL ORDER BY id", (src,)):
        groups[hashlib.md5((sql or "").encode()).hexdigest()].append((uid, title))
    dead = []
    con.execute("BEGIN")
    for members in groups.values():
        canon = members[0][0]
        for uid, title in members:                        # every path (canonical's own included) -> pointer
            sa = (title or "").split(".", 1)[0].strip()
            con.execute("INSERT OR REPLACE INTO unit_aliases(alias_id,unit_id,title,subject_area,source) VALUES(?,?,?,?,?)",
                        (uid, canon, title, sa, src))
            if uid != canon:
                cmap[uid] = canon
                dead.append(uid)
    for i in range(0, len(dead), 500):                    # delete copies + their identical fact rows
        chunk = dead[i:i + 500]
        ph = ",".join("?" * len(chunk))
        con.execute(f"DELETE FROM sql_units WHERE id IN ({ph})", chunk)
        for t in xtabs:
            con.execute(f"DELETE FROM {t} WHERE unit_id IN ({ph})", chunk)
    con.execute("COMMIT")
    tot_merged += len(dead)
    print(f"[dedup] {src}: groups={len(groups)}  merged-away={len(dead)}  aliases={sum(len(m) for m in groups.values())}")

json.dump(cmap, open(MAPF, "w", encoding="utf-8"))
n_units = con.execute("SELECT COUNT(*) FROM sql_units WHERE excluded_reason IS NULL").fetchone()[0]
n_alias = con.execute("SELECT COUNT(*) FROM unit_aliases").fetchone()[0]
print(f"[dedup] total merged-away={tot_merged}; sql_units(active)={n_units}; unit_aliases={n_alias}; map={MAPF} ({len(cmap)})")
# demo the two pointer queries
row = con.execute("SELECT unit_id, COUNT(*) FROM unit_aliases GROUP BY unit_id ORDER BY COUNT(*) DESC LIMIT 1").fetchone()
if row:
    print(f"[dedup] biggest query: {row[1]} paths -> canonical {row[0][:80]}")
sa = [r[0] for r in con.execute("""SELECT DISTINCT a.subject_area FROM x_tables t JOIN unit_aliases a ON a.unit_id=t.unit_id
                                   WHERE t.table_name='EGP_SYSTEM_ITEMS_ALL_V' LIMIT 6""")]
print(f"[dedup] e.g. EGP_SYSTEM_ITEMS_ALL_V used in subject areas: {sa}")
