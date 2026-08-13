"""Compare OLD enrichment (sql_units.description, prior process) vs NEW (this self-hosted Qwen run),
per category (view / otbi / bip). Read-only. Safe to run periodically as bip/otbi accumulate.

NEW is read from the enrich_output.*.jsonl (full result incl. intents). OLD from sql_units.description.
Metrics: coverage, description length, intents (new only), and description word-overlap (Jaccard) on the
units present in BOTH — plus side-by-side samples for human judgement (a true content compare, not a score)."""
import sqlite3, json, glob, re, statistics as st, os

RUN = "/root/enrich-run"
DB = os.path.join(RUN, "sqls.sqlite")
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

srcof = dict(c.execute("select id, source from sql_units"))

# OLD: prior description per unit (non-empty)
old = {}
for uid, desc in c.execute("select id, description from sql_units where description is not null and length(trim(description))>0"):
    old[uid] = desc

# NEW: our run outputs (ok rows only), full result
new = {}
files = sorted(glob.glob(os.path.join(RUN, "enrich_output.view.w*.jsonl"))) + \
        [os.path.join(RUN, "enrich_output.bip.jsonl"), os.path.join(RUN, "enrich_output.otbi.jsonl")]
for f in files:
    if not os.path.exists(f):
        continue
    for l in open(f, encoding="utf-8"):
        try:
            r = json.loads(l)
            if r.get("ok"):
                new[r["id"]] = r["result"]
        except Exception:
            pass

STOP = set("this that view which with from data into been have also each only more base table tables "
           "column columns record records provides contains value values used using user".split())
def words(s):
    return {w for w in re.findall(r"[a-zA-Z]{4,}", (s or "").lower())} - STOP

print(f"OLD (description) units total: {len(old)}   NEW (this run) ok units: {len(new)}\n")
CATS = [("view", "view"), ("otbi", "otbi"), ("bip", "bip-report")]
for label, src in CATS:
    ids = [i for i in new if srcof.get(i) == src]
    both = [i for i in ids if i in old]
    print(f"===== {label.upper()}  (new={len(ids)}, has-OLD={len(both)}) =====")
    if not ids:
        print("  (no NEW output yet)\n"); continue
    nlen = [len(new[i].get("description", "")) for i in ids]
    nint = [len(new[i].get("intents", [])) for i in ids]
    print(f"  NEW: desc avg={int(st.mean(nlen))}c  intents avg={round(st.mean(nint),1)}  (new has structured intents)")
    if both:
        olen = [len(old[i]) for i in both]
        jac = []
        for i in both:
            a, b = words(new[i].get("description", "")), words(old[i])
            if a or b:
                jac.append(len(a & b) / len(a | b))
        print(f"  OLD: desc avg={int(st.mean(olen))}c (on {len(both)} overlapping)")
        print(f"  desc word-overlap Jaccard: avg={round(st.mean(jac),2)} median={round(st.median(jac),2)}  "
              f"(higher = new covers the same concepts as old)")
        print("  --- SIDE BY SIDE (judge quality) ---")
        for i in both[:2]:
            print(f"  [{i}]")
            print(f"    OLD: {old[i][:300].strip()}")
            print(f"    NEW: {new[i].get('description','')[:300].strip()}")
            print(f"    NEW intents: {new[i].get('intents')}")
    else:
        print("  no OLD description for this category to compare against.")
        for i in ids[:1]:
            print(f"    NEW sample [{i}]: {new[i].get('description','')[:280].strip()}")
    print()
