#!/bin/bash
# Progress + health snapshot. Safe to run anytime (read-only). Reconnect after disconnect and run this.
cd "$(dirname "$0")"
PORT="${PORT:-8000}"; NG=$(nvidia-smi -L 2>/dev/null | wc -l); NGPU="${NGPU:-${NG:-1}}"
TOTAL=$(wc -l < enrich_input.jsonl 2>/dev/null || echo 0)
OK=$(grep -c '"ok": true' enrich_output.jsonl 2>/dev/null || echo 0)
ERR=$(grep -c '"ok": false' enrich_output.jsonl 2>/dev/null || echo 0)
DONE=$((OK+ERR)); PCT=0; [ "$TOTAL" -gt 0 ] && PCT=$((100*DONE/TOTAL))
echo "=========================================================="
echo " PROGRESS: $DONE / $TOTAL  (${PCT}%)   ok=$OK  err=$ERR"
[ -f DONE.flag ] && echo " STATE: ✅ COMPLETE (download enrich_output.jsonl, then DESTROY)" \
                 || { pgrep -f enrich_client.py >/dev/null && echo " STATE: ▶ running" || echo " STATE: ⏸ client not running (supervisor may be between attempts)"; }
echo "---- by source (done) ----"
grep -ho '"source": "[a-z-]*"' enrich_output.jsonl 2>/dev/null | sort | uniq -c
echo "---- input mix (target) ----"
grep -ho '"source": "[a-z-]*"' enrich_input.jsonl 2>/dev/null | sort | uniq -c
echo "---- vLLM endpoints ----"
for i in $(seq 0 $((NGPU-1))); do curl -sf "localhost:$((PORT+i))/v1/models" >/dev/null 2>&1 && echo "  gpu$i: UP" || echo "  gpu$i: DOWN"; done
echo "---- GPU util ----"; nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader 2>/dev/null
echo "---- last rate / phase (client.log) ----"; tail -3 client.log 2>/dev/null | sed 's/^/  /'
echo "---- last errors (up to 3) ----"; grep '"ok": false' enrich_output.jsonl 2>/dev/null | tail -3 | sed 's/^/  /'
echo "---- run.log tail ----"; tail -4 run.log 2>/dev/null | sed 's/^/  /'
