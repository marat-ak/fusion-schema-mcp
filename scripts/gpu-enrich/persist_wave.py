"""After a view wave enriches, persist results to the DB so the NEXT wave's export sees them:
  - sql_units.description_generated = result.description   (becomes the card for wave N+1 / otbi / bip)
  - sql_units.semantics_json        = the full result JSON (the shippable corpus)
  - view_column_remarks.remark      = model's computedColumns[alias].meaning for computed output columns
    (so downstream views/otbi/bip inherit the computed-column meanings too)

  IN=enrich_output.view.w0.jsonl SQLS=sqls.sqlite python persist_wave.py
"""
import sqlite3, json, os
SQLS = os.environ.get("SQLS", "sqls.sqlite")
IN = os.environ.get("IN", "enrich_output.view.w0.jsonl")
con = sqlite3.connect(SQLS, isolation_level=None)   # autocommit; we bracket the writes with explicit BEGIN/COMMIT (portable across Python versions)
for col in ("description_generated", "semantics_json"):
    try: con.execute(f"ALTER TABLE sql_units ADD COLUMN {col} TEXT")
    except Exception: pass
updDesc = con.cursor(); updComp = con.cursor()
n_desc = n_comp = n_err = 0
con.execute("BEGIN")
for line in open(IN, encoding="utf-8"):
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if not rec.get("ok"):
        n_err += 1; continue
    if rec.get("source") != "view":
        continue
    name = (rec.get("id") or "")[5:] if str(rec.get("id", "")).startswith("view:") else None
    res = rec.get("result") or {}
    if not name:
        continue
    updDesc.execute("UPDATE sql_units SET description_generated=?, semantics_json=? WHERE id=?",
                    (res.get("description"), json.dumps(res, ensure_ascii=False), rec["id"]))
    n_desc += 1
    for cc in (res.get("computedColumns") or []):
        alias, meaning = cc.get("alias"), cc.get("meaning")
        if alias and meaning:
            # fill the computed column's remark (the lineage left it NULL)
            r = updComp.execute("UPDATE view_column_remarks SET remark=? WHERE view=? AND column=? AND (remark IS NULL OR kind='computed')",
                                (meaning, name, alias))
            n_comp += r.rowcount
con.execute("COMMIT")
print(f"[persist] {IN}: views updated={n_desc}  computed-col meanings filled={n_comp}  err-skipped={n_err}")
