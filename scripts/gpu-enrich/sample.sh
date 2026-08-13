#!/bin/bash
# Inspect N random completed results (default 3). Proves output quality mid-run.
#   bash sample.sh 5            # 5 random
#   bash sample.sh 5 view       # 5 random of a source (view|otbi|bip-report)
cd "$(dirname "$0")"
N="${1:-3}"; SRC="${2:-}"
python3 - "$N" "$SRC" <<'PY'
import json, sys, random
n = int(sys.argv[1]); src = sys.argv[2]
rows = []
for line in open("enrich_output.jsonl", encoding="utf-8"):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("ok") and (not src or r.get("source") == src):
        rows.append(r)
if not rows:
    print("no matching completed rows yet"); sys.exit(0)
for r in random.sample(rows, min(n, len(rows))):
    d = r["result"]
    print("=" * 90)
    print(f"{r['id']}  [{r['source']}]  {d.get('titleHuman','')}")
    print(f"domain={d.get('domain')}  outputGrain={d.get('outputGrain')}")
    print("DESCRIPTION:\n  " + (d.get("description", "")).replace("\n", "\n  "))
    print("INTENTS:")
    for q in d.get("intents", []): print("  - " + q)
    for k in ("security", "currentRow", "language", "grainHandling", "flexfield", "plsqlFunctions", "qualityFlags", "params", "missingTables"):
        v = d.get(k)
        if v: print(f"{k}: {json.dumps(v, ensure_ascii=False)[:300]}")
PY
