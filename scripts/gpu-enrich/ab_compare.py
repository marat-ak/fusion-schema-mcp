"""A/B validation: OLD (pre-flex, generic placeholder) vs NEW (real flexfield meanings + tightened
missingRemarks prompt) on the SAME 200 otbi units. Confirms the fix reduces flex false-flags and overall
missingRemarks without hurting comprehension.
  OLD=abtest_old.json NEW=enrich_output.abtest.jsonl python3 ab_compare.py"""
import json, os, statistics, collections

OLD = json.load(open(os.environ.get("OLD", "abtest_old.json"), encoding="utf-8"))
NEWF = os.environ.get("NEW", "enrich_output.abtest.jsonl")

# dedup-aware: old per-path ids collapse to canonical ids (dedup_units.py); aggregate old stats per canonical
CANONF = os.environ.get("CANON_MAP", "canonical_map.json")
CANON = json.load(open(CANONF, encoding="utf-8")) if os.path.exists(CANONF) else {}
_oc = collections.defaultdict(list)
for k, v in OLD.items():
    _oc[CANON.get(k, k)].append(v)
OLD = {k: {"mr": statistics.mean(x["mr"] for x in v),
           "tc": False if any(x.get("tc") is False for x in v) else v[0].get("tc"),
           "mrlist": [m for x in v for m in x.get("mrlist", [])]}
       for k, v in _oc.items()}

def is_flex(x):
    x = str(x).upper()
    return "ATTRIBUTE_CHAR" in x or "GLOBAL_ATTRIBUTE" in x or "EGO_ITEM_EFF" in x

new = {}
for line in open(NEWF, encoding="utf-8"):
    try:
        o = json.loads(line)
    except Exception:
        continue
    r = o.get("result") or {}
    mr = r.get("missingRemarks") or []
    new[str(o["id"])] = {"mr": len(mr), "tc": r.get("tablesConfirmed"),
                         "flex": sum(1 for x in mr if is_flex(x))}

ids = [u for u in OLD if u in new]
mean = lambda xs: statistics.mean(xs) if xs else 0.0
o_mr = [OLD[u]["mr"] for u in ids]
n_mr = [new[u]["mr"] for u in ids]
o_flex = [sum(1 for x in OLD[u].get("mrlist", []) if is_flex(x)) for u in ids]
n_flex = [new[u]["flex"] for u in ids]
o_tcf = sum(1 for u in ids if OLD[u]["tc"] is False)
n_tcf = sum(1 for u in ids if new[u]["tc"] is False)
improved = sum(1 for u in ids if new[u]["mr"] < OLD[u]["mr"])
worse = sum(1 for u in ids if new[u]["mr"] > OLD[u]["mr"])

pct = lambda a, b: (100 * (a - b) / a) if a else 0
print(f"A/B on {len(ids)} units   (before = pre-flex generic; after = real flexfield meanings + tightened prompt)")
print(f"  missingRemarks / unit   : {mean(o_mr):7.1f}  ->  {mean(n_mr):7.1f}   ({pct(mean(o_mr), mean(n_mr)):+.0f}%)")
print(f"  flex false-flags / unit : {mean(o_flex):7.1f}  ->  {mean(n_flex):7.1f}   ({pct(mean(o_flex), mean(n_flex)):+.0f}%)")
print(f"  tablesConfirmed = false : {o_tcf:7d}  ->  {n_tcf:7d}   (of {len(ids)})")
print(f"  units improved / worse  : {improved} / {worse}   (unchanged {len(ids)-improved-worse})")
