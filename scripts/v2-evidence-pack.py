"""Evidence pack for a missing/undescribed table: everything the corpus knows about it."""
import sqlite3, sys

con = sqlite3.connect("file:/data/sqls.sqlite?mode=ro", uri=True)

for T in ["SVC_CATEGORIES", "FND_LOOKUP_VALUES_TL", "ESS_REQUEST_HISTORY"]:
    print("=" * 96)
    n = con.execute("SELECT COUNT(DISTINCT unit_id) FROM x_tables WHERE table_name=?", (T,)).fetchone()[0]
    print(f"TABLE {T}   usedBy {n} units")

    print("  columns used (top 15 by frequency):")
    for r in con.execute("""SELECT column_name, COUNT(*) c, GROUP_CONCAT(DISTINCT context) ctx
                            FROM x_columns WHERE table_name=? GROUP BY column_name
                            ORDER BY c DESC LIMIT 15""", (T,)):
        print(f"    {r[0]:<36} x{r[1]:<5} [{r[2]}]")

    print("  joins (top 8):")
    for r in con.execute("""SELECT from_t||'.'||from_c||' = '||to_t||'.'||to_c j, COUNT(*) c
                            FROM x_joins WHERE from_t=? OR to_t=? GROUP BY j ORDER BY c DESC LIMIT 8""", (T, T)):
        print(f"    x{r[1]:<4} {r[0]}")

    print("  predicates (top 8):")
    for r in con.execute("""SELECT column_name||' '||op||' '||literal p, found_in, COUNT(*) c
                            FROM x_predicates WHERE table_name=? GROUP BY p, found_in ORDER BY c DESC LIMIT 8""", (T,)):
        print(f"    x{r[2]:<4} {r[0]}   ({r[1]})")

    print("  co-used tables (top 6):")
    for r in con.execute("""SELECT t2.table_name, COUNT(DISTINCT t2.unit_id) c FROM x_tables t1
                            JOIN x_tables t2 ON t2.unit_id=t1.unit_id AND t2.table_name<>t1.table_name AND t2.is_cte=0
                            WHERE t1.table_name=? GROUP BY t2.table_name ORDER BY c DESC LIMIT 6""", (T,)):
        print(f"    x{r[1]:<4} {r[0]}")

    print("  sample unit titles + descriptions (3):")
    for r in con.execute("""SELECT u.title, substr(u.description,1,150) FROM sql_units u
                            JOIN x_tables x ON x.unit_id=u.id WHERE x.table_name=? AND u.description IS NOT NULL
                            GROUP BY u.id LIMIT 3""", (T,)):
        print(f"    • {r[0][:75]}")
        print(f"      {r[1]}")
    print()
