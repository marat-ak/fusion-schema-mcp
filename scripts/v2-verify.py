"""Verification suite for the v2 round-0 extraction."""
import json
import sqlite3

con = sqlite3.connect("file:/data/sqls.sqlite?mode=ro", uri=True)

print("=== 1) parse_quality by source (final) ===")
for r in con.execute("SELECT source, parse_quality, COUNT(*) FROM sql_units GROUP BY source, parse_quality ORDER BY source, parse_quality"):
    print("  ", r)

print("\n=== 2) entity scan in view SQL (must be 0) ===")
r = con.execute("SELECT COUNT(*) FROM sql_units WHERE source='view' AND (sql_for_parse LIKE '%&quot;%' OR sql_for_parse LIKE '%&apos;%')").fetchone()
print("   contaminated view units:", r[0])

print("\n=== 3) extraction volumes ===")
for t in ["x_tables", "x_columns", "x_joins", "x_predicates", "x_params", "x_projection"]:
    print(f"   {t}: {con.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]:,}")

print("\n=== 4) CALIBRATION: x_tables vs OTBI relations references (ground truth) ===")
tp = fp = fn = rows = 0
for uid, tu in con.execute("SELECT id, tables_used_old FROM sql_units WHERE source='otbi' AND parse_quality='full' AND tables_used_old IS NOT NULL LIMIT 20000"):
    try:
        gt = set(x.upper() for x in json.loads(tu))
    except Exception:
        continue
    if not gt:
        continue
    got = set(r[0] for r in con.execute("SELECT table_name FROM x_tables WHERE unit_id=? AND is_cte=0", (uid,)))
    rows += 1
    tp += len(got & gt); fp += len(got - gt); fn += len(gt - got)
print(f"   rows={rows}  precision={tp/(tp+fp):.4f}  recall={tp/(tp+fn):.4f}")

print("\n=== 5) THE submitted_flag PROBE (MSC_AP_SALES_ORDER_V) ===")
for r in con.execute("""SELECT table_name, column_name, op, literal, found_in
                        FROM x_predicates WHERE unit_id='view:MSC_AP_SALES_ORDER_V'
                        AND column_name LIKE '%FLAG%' LIMIT 8"""):
    print("  ", r)

print("\n=== 6) CASE/EXISTS predicates found on DOO_HEADERS_ALL across corpus (the old blind spot) ===")
for r in con.execute("""SELECT found_in, COUNT(*) FROM x_predicates
                        WHERE table_name='DOO_HEADERS_ALL' AND column_name='SUBMITTED_FLAG'
                        GROUP BY found_in"""):
    print("  ", r)

print("\n=== 7) lexical params captured (bip) ===")
for r in con.execute("""SELECT u.title, p.name FROM x_params p JOIN sql_units u ON u.id=p.unit_id
                        WHERE p.kind='lexical' LIMIT 6"""):
    print("   ", r[0][-60:], "->", r[1])
print("   total lexical:", con.execute("SELECT COUNT(*) FROM x_params WHERE kind='lexical'").fetchone()[0])
print("   total binds:", con.execute("SELECT COUNT(*) FROM x_params WHERE kind='bind'").fetchone()[0])

print("\n=== 8) projection sample (view interface): DOO_HEADERS_ALL_V first 5 cols ===")
for r in con.execute("""SELECT seq, alias, substr(source_expr,1,60) FROM x_projection
                        WHERE unit_id='view:DOO_HEADERS_ALL_V' ORDER BY seq LIMIT 5"""):
    print("  ", r)

print("\n=== 9) security-plumbing predicates extracted (FND_GRANTS sample) ===")
for r in con.execute("""SELECT column_name, op, literal, found_in, COUNT(*) c FROM x_predicates
                        WHERE table_name='FND_GRANTS' GROUP BY column_name, op, literal, found_in
                        ORDER BY c DESC LIMIT 5"""):
    print("  ", r)

print("\n=== 10) top failed units (for the tail plan) ===")
for r in con.execute("""SELECT source, title, substr(parse_error,1,70) FROM sql_units
                        WHERE parse_quality='failed' LIMIT 8"""):
    print("  ", r[0], "|", (r[1] or "")[-50:], "|", r[2])
