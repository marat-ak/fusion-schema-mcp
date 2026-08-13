#!/bin/bash
# Wait for the reconfigured endpoint (2 GPU / DP=2 / maxbatch 32768) to come up, then measure throughput.
set -a; . /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/.env; set +a
cd /root/enrich-run
echo "waiting for endpoint ready..."
code=000
for t in $(seq 1 60); do
  code=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $HF_TOKEN" "$HF_ENDPOINT_URL/v1/models")
  echo "$(date +%T) try $t HTTP=$code"
  [ "$code" = 200 ] && { echo READY; break; }
  sleep 15
done
[ "$code" = 200 ] || { echo "TIMEOUT: endpoint never returned 200"; exit 1; }

echo "=== throughput test: CONC=256, 256 units (2 GPU DP=2, maxbatch 32768) ==="
S=$(date +%s)
docker run --network host --rm -v /root/enrich-run:/work -w /work \
  -e HF_ENDPOINT_URL -e HF_TOKEN -e MODEL_NAME=Qwen/Qwen3-Coder-30B-A3B-Instruct -e CONC=256 \
  python:3.12 bash -c "pip install -q aiohttp && IN_F=enrich_input.view.w0.jsonl OUT_F=test256.jsonl python3 enrich_client.py --limit 256" 2>&1 | grep -E "client|DONE"
E=$(date +%s)
W=$((E-S))
echo "wall=${W}s rows=$(wc -l < test256.jsonl)"
python3 - "$W" <<'PY'
import json, sys
w=int(sys.argv[1])
r=[json.loads(l) for l in open("/root/enrich-run/test256.jsonl")]
ok=[x for x in r if x.get("ok")]
ct=[x["usage"].get("completion_tokens",0) for x in ok if x.get("usage")]
n=len(ok)
rate=n/max(w,1)
print(f"ok={n} err={len(r)-n} avg_out_tok={sum(ct)//max(len(ct),1)}")
print(f"rate={rate:.2f} units/s  ->  98154 units = {98154/max(rate,0.01)/3600:.1f} h  @ 2GPU*$2.75 = ${98154/max(rate,0.01)/3600*5.5:.0f}")
PY
