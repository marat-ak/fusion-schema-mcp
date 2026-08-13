"""Quality review of enrichment outputs (read-only). SRC=view|otbi|bip (default view)."""
import json, glob, os, statistics as st

SRC = os.environ.get("SRC", "view")
PAT = {"view": "enrich_output.view.w*.jsonl", "otbi": "enrich_output.otbi.jsonl",
       "bip": "enrich_output.bip.jsonl"}.get(SRC, "enrich_output.view.w*.jsonl")
print(f"[SRC={SRC}  pattern={PAT}]")
rows = []
for f in sorted(glob.glob("/root/enrich-run/" + PAT)):
    w = f.split(".w")[-1].split(".")[0] if ".w" in f else "-"
    for l in open(f, encoding="utf-8"):
        try:
            r = json.loads(l); r["_wave"] = w; rows.append(r)
        except Exception:
            pass
ok = [r for r in rows if r.get("ok")]
err = [r for r in rows if not r.get("ok")]
def R(r): return r.get("result", {})
print(f"TOTAL={len(rows)}  ok={len(ok)}  err={len(err)}  ({round(100*len(err)/max(len(rows),1),1)}% err)")
if err:
    print("  sample errors:", [str(e.get("error",""))[:80] for e in err[:3]])

dl = [len(R(r).get("description", "")) for r in ok]
il = [len(R(r).get("intents", [])) for r in ok]
print(f"\ndescription chars: avg={int(st.mean(dl))} median={int(st.median(dl))} min={min(dl)} max={max(dl)}")
print(f"  desc < 120 chars (thin): {sum(1 for x in dl if x<120)}")
print(f"intents count: avg={round(st.mean(il),1)} min={min(il)} max={max(il)}  (<3 intents: {sum(1 for x in il if x<3)})")

print("\n--- semantic-label coverage (% of ok units with non-empty field) ---")
for fld in ["security","currentRow","language","grainHandling","dateLogic","flexfield",
            "plsqlFunctions","computedColumns","qualityFlags","params","missingRemarks",
            "missingTables","extraTables"]:
    n = sum(1 for r in ok if R(r).get(fld))
    print(f"  {fld:16} {n:5}  ({round(100*n/max(len(ok),1),1)}%)")
print(f"  tablesConfirmed=false: {sum(1 for r in ok if R(r).get('tablesConfirmed') is False)}")
print(f"  missingRemarks total mentions: {sum(len(R(r).get('missingRemarks',[])) for r in ok)}")

sec = [r for r in ok if R(r).get("security")]
print(f"\n--- SECURITY sample (verify NARROW, not over-labeled) — {len(sec)} units ---")
for r in sec[:4]:
    print(" ", r["id"], "->", json.dumps(R(r)["security"])[:220])

def show(r, tag):
    rr = R(r)
    print(f"\n===== {tag}: {r['id']} (wave {r['_wave']}) =====")
    print("DESC:", rr.get("description", "")[:700])
    print("INTENTS:", rr.get("intents"))
    print("domain:", rr.get("domain"), "| grain:", rr.get("outputGrain"), "| tablesConfirmed:", rr.get("tablesConfirmed"))
    if rr.get("security"): print("security:", json.dumps(rr["security"])[:300])
    if rr.get("computedColumns"): print("computed:", json.dumps(rr["computedColumns"])[:300])
    if rr.get("grainHandling"): print("grain:", json.dumps(rr["grainHandling"])[:200])
    if rr.get("missingRemarks"): print("missingRemarks:", rr["missingRemarks"][:8])

# samples (source-agnostic): 2 plain + one with security + one with computed columns
comp = [r for r in ok if R(r).get("computedColumns")]
for i, r in enumerate(ok[:2]):
    show(r, f"SAMPLE {i+1}")
if sec: show(sec[0], "WITH SECURITY")
if comp: show(comp[0], "WITH COMPUTED COLUMNS")
