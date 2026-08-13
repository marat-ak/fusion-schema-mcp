"""Build the FLEX registry the enrichment injects: {COLUMN_NAME: [{context, label}]} from the flexStore
(reports.sqlite: flexfields). Physical-column flexfields only (ATTRIBUTE*/GLOBAL_ATTRIBUTE* — these match the
physical columns the SQL uses, e.g. EGO_ITEM_EFF_B.ATTRIBUTE_CHAR1). Real per-context segment meanings that
replace the generic 'Descriptive Flexfield: segment' placeholder in the prompt.
  REPORTS=/opt/fusion-catalog-test/reports.sqlite OUT=flex_map.json python3 build_flex_map.py"""
import sqlite3, json, re, os, collections

REPORTS = os.environ.get("REPORTS", "/opt/fusion-catalog-test/reports.sqlite")
OUT = os.environ.get("OUT", "flex_map.json")
ATTR = re.compile(r"^(ATTRIBUTE|GLOBAL_ATTRIBUTE)(_CHAR|_NUMBER|_DATE|_TIMESTAMP)?\d+$")

c = sqlite3.connect(f"file:{REPORTS}?mode=ro", uri=True)
m = collections.defaultdict(list)
seen = set()
rows = c.execute("SELECT flexfield_code, context_code, column_name, segment_name, prompt FROM flexfields "
                 "ORDER BY flexfield_code, context_code, sequence_number")
for code, ctx, col, seg, prompt in rows:
    if not col or not ATTR.match(col.strip().upper()):
        continue
    label = (seg or prompt or "").strip()
    if not label:
        continue
    key = col.strip().upper()
    dk = (key, (ctx or "").upper(), label.lower())
    if dk in seen:
        continue
    seen.add(dk)
    m[key].append({"context": ctx, "label": label, "code": code})

cols = {k: v[:400] for k, v in sorted(m.items())}  # keep ALL contexts (ATTRIBUTE_CHAR1 has 290) — export_wave filters by the unit's CONTEXT_CODE, so the full set must be present to match

# ADF extensions (CRM/ZCA/MOO/PSC EXTN_ATTRIBUTE_*): carry the PHYSICAL table_name -> direct join, no
# convention guessing. {TABLE: {COLUMN: label}}.
adf = {}
for t, col, disp, attr in c.execute("SELECT table_name, column_name, field_display, attribute_name FROM adf_extensions"):
    if not t or not col:
        continue
    label = (disp or attr or "").strip()
    if not label:
        continue
    adf.setdefault(t.strip().upper(), {})[col.strip().upper()] = label

out = {"columns": cols, "adf": adf}
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
print(f"flex_map: {len(cols)} flex columns / {sum(len(v) for v in cols.values())} (col,context) meanings"
      f" + adf: {len(adf)} tables / {sum(len(v) for v in adf.values())} EXTN columns -> {OUT}")
for k in list(cols)[:2]:
    print(" ", k, "->", [(e["context"], e["label"]) for e in cols[k][:3]])
for t in list(adf)[:2]:
    print("  adf", t, "->", list(adf[t].items())[:3])
