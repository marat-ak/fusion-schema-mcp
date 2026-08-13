"""READ-ONLY analysis of an enrichment DB pair. Opens read-only (mode=ro) — never writes.
  python3 analyze_dbs.py <sqls.sqlite> [schema.sqlite]"""
import sqlite3, sys, os


def ro(p):
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def cnt(c, sql, *a):
    try:
        return c.execute(sql, a).fetchone()[0]
    except Exception as e:
        return f"ERR:{e}"


def analyze(p):
    if not os.path.exists(p):
        print(f"# {p}  -> MISSING\n"); return
    c = ro(p)
    tbls = sorted(r[0] for r in c.execute("select name from sqlite_master where type='table'"))
    print(f"# {p}  ({os.path.getsize(p)//1024//1024} MB)")
    print("  tables:", tbls)
    if "sql_units" in tbls:
        cols = [r[1] for r in c.execute("PRAGMA table_info(sql_units)")]
        print("  sql_units:", cnt(c, "select count(*) from sql_units"),
              "| by source:", {s: cnt(c, "select count(*) from sql_units where source=?", s)
                               for s in ("view", "otbi", "bip-report")})
        print("  sql_units cols incl:", [x for x in cols if x in
              ("description_generated", "semantics_json", "description", "excluded_reason")])
        if "description_generated" in cols:
            print("  description_generated populated:",
                  cnt(c, "select count(*) from sql_units where description_generated is not null"))
        if "semantics_json" in cols:
            print("  semantics_json populated:",
                  cnt(c, "select count(*) from sql_units where semantics_json is not null"))
    for t in ("view_waves", "view_column_remarks", "x_column_lineage", "x_tables", "x_predicates",
              "x_columns", "x_projection", "x_joins", "x_params", "tables", "columns"):
        if t in tbls:
            extra = ""
            if t == "view_column_remarks":
                extra = f" (remark not null: {cnt(c, 'select count(*) from view_column_remarks where remark is not null')})"
            if t == "columns":
                extra = f" (remarked: {cnt(c, 'select count(*) from columns where remarks is not null and remarks != %s' % chr(39)+chr(39))})"
            print(f"  {t}: {cnt(c, f'select count(*) from {t}')}{extra}")
    print()


for arg in sys.argv[1:]:
    analyze(arg)
