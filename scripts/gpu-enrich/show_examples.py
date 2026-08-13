"""Show N real request+response pairs from the running enrichment (run ON the box in ~/work)."""
import json, sys
import enrich_client as ec   # reuse SYSTEM / build_messages / PREAMBLE (module-level, no requests made)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 2
out = [json.loads(l) for l in open("enrich_output.jsonl", encoding="utf-8") if '"ok": true' in l]
inp = {}
for l in open("enrich_input.jsonl", encoding="utf-8"):
    u = json.loads(l); inp[u["id"]] = u

picks = []
# prefer one with rich semantics (security/currentRow/qualityFlags), then fill with plain ones
for r in out:
    d = r["result"]
    if (d.get("security") or d.get("currentRow") or d.get("qualityFlags")) and len(picks) < max(1, N // 2):
        picks.append(r)
for r in out:
    if r not in picks and len(picks) < N:
        picks.append(r)

print("=" * 100)
print("SYSTEM PROMPT (shared across all requests):")
print("=" * 100)
print(ec.SYSTEM)
for r in picks:
    u = inp.get(r["id"])
    if not u:
        continue
    user = ec.build_messages(u)[1]["content"]
    print("\n" + "#" * 100)
    print(f"# REQUEST  id={r['id']}  source={r['source']}")
    print("#" * 100)
    print(user[:3000] + ("\n...(prompt truncated for display)" if len(user) > 3000 else ""))
    print("\n" + "-" * 60 + " MODEL RESPONSE (JSON) " + "-" * 17)
    print(json.dumps(r["result"], indent=2, ensure_ascii=False))
