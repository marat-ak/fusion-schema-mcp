"""Coverage gate check: every extracted referenced object must (a) exist in schema-v2, (b) have a description."""
import sqlite3

con = sqlite3.connect("file:/data/sqls.sqlite?mode=ro", uri=True)
con.execute("ATTACH DATABASE 'file:/data/schema.sqlite?mode=ro' AS sv2")

print("=== referenced objects (x_tables, is_cte=0, distinct) ===")
tot = con.execute("SELECT COUNT(DISTINCT table_name) FROM x_tables WHERE is_cte=0").fetchone()[0]
print("distinct referenced:", tot)

print("\n=== existence vs schema-v2 ===")
row = con.execute("""
  SELECT
    SUM(CASE WHEN t.name IS NOT NULL THEN 1 ELSE 0 END) AS found,
    SUM(CASE WHEN t.name IS NULL THEN 1 ELSE 0 END) AS missing
  FROM (SELECT DISTINCT table_name FROM x_tables WHERE is_cte=0) x
  LEFT JOIN sv2.tables t ON t.name = x.table_name""").fetchone()
print(f"exists in schema: {row[0]}   MISSING: {row[1]}")

print("\n=== missing objects by unit-impact (top 20) ===")
for r in con.execute("""
  SELECT x.table_name, COUNT(DISTINCT x.unit_id) units
  FROM x_tables x LEFT JOIN sv2.tables t ON t.name = x.table_name
  WHERE x.is_cte=0 AND t.name IS NULL
  GROUP BY x.table_name ORDER BY units DESC LIMIT 20"""):
    print(f"   {r[0]:<44} usedBy {r[1]} units")

print("\n=== units affected by >=1 missing object ===")
r = con.execute("""
  SELECT COUNT(DISTINCT x.unit_id) FROM x_tables x
  LEFT JOIN sv2.tables t ON t.name = x.table_name
  WHERE x.is_cte=0 AND t.name IS NULL""").fetchone()
print("units:", r[0], "of 98,154")

print("\n=== description coverage of EXISTING referenced objects ===")
for r in con.execute("""
  SELECT t.type,
         COUNT(*) total,
         SUM(CASE WHEN t.remarks IS NOT NULL AND t.remarks<>'' THEN 1 ELSE 0 END) with_remarks
  FROM (SELECT DISTINCT table_name FROM x_tables WHERE is_cte=0) x
  JOIN sv2.tables t ON t.name = x.table_name
  GROUP BY t.type"""):
    pct = 100*r[2]/r[1] if r[1] else 0
    print(f"   {r[0]:<6} referenced={r[1]:>6}  withDescription={r[2]:>6} ({pct:.0f}%)")

print("\n=== referenced VIEWS lacking remarks BUT having old LLM description (rescuable) ===")
r = con.execute("""
  SELECT COUNT(*) FROM (SELECT DISTINCT x.table_name
  FROM x_tables x JOIN sv2.tables t ON t.name=x.table_name
  WHERE x.is_cte=0 AND t.type='VIEW' AND (t.remarks IS NULL OR t.remarks='')) v
  WHERE EXISTS (SELECT 1 FROM sql_units u WHERE u.id='view:'||v.table_name AND u.description IS NOT NULL)""").fetchone()
print("views rescuable via description_generated/backfill:", r[0])

print("\n=== referenced TABLES lacking remarks, by unit-impact (top 12) ===")
for r in con.execute("""
  SELECT x.table_name, COUNT(DISTINCT x.unit_id) units
  FROM x_tables x JOIN sv2.tables t ON t.name=x.table_name
  WHERE x.is_cte=0 AND t.type='TABLE' AND (t.remarks IS NULL OR t.remarks='')
  GROUP BY x.table_name ORDER BY units DESC LIMIT 12"""):
    print(f"   {r[0]:<44} usedBy {r[1]} units")
