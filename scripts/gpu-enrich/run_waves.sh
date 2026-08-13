#!/bin/bash
# Per-wave supervisor. Detached, resume-safe. Run on the box:
#   cd ~/work && nohup bash run_waves.sh > run.out 2>&1 & disown
# Flow: for each view wave 0..N -> export -> enrich -> persist(DB); then otbi ∥ bip (independent).
set -u
cd "$(dirname "$0")"
export SQLS=sqls.sqlite SCH=schema.sqlite CURATED=curated_column_remarks.json PORT=${PORT:-8000}
export MAX_NUM_SEQS=${MAX_NUM_SEQS:-256}
DP=${DP:-1}                                   # 1 = vLLM --data-parallel-size (one endpoint); 0 = N manual ports
NG=$(nvidia-smi -L 2>/dev/null | wc -l); [ "${NG:-0}" -lt 1 ] && NG=1
export CONC=${CONC:-$(python3 -c "print(int($NG*$MAX_NUM_SEQS*1.2))")}   # CONC env overrides (remote: set to endpoint capacity, e.g. 512); else NG*max-num-seqs*1.2
if [ "$DP" = 1 ]; then export NGPU=1; else export NGPU=$NG; fi  # NGPU here = client URL/port count
log(){ echo "$(date '+%F %T') $*" | tee -a run.log; }
log "start NG=$NG DP=$DP CONC=$CONC max-num-seqs=$MAX_NUM_SEQS"

# 1) vLLM endpoint.
#    REMOTE (HF_ENDPOINT_URL set): managed vLLM already serving -> just verify reachable, skip setup.sh.
#    LOCAL (unset): start vLLM on the box via setup.sh and wait for every port (original on-box path).
if [ -n "${HF_ENDPOINT_URL:-}" ]; then
  python3 - <<'PY' || { log "FATAL: HF endpoint /v1/models unreachable (paused? token?)"; exit 1; }
import os, urllib.request
u = os.environ["HF_ENDPOINT_URL"].rstrip("/") + "/v1/models"
urllib.request.urlopen(urllib.request.Request(u, headers={"Authorization": "Bearer " + os.environ.get("HF_TOKEN", "")}), timeout=30).read()
PY
  log "remote HF endpoint reachable (skipping local vLLM startup)"
else
  if ! curl -sf "localhost:$PORT/v1/models" >/dev/null 2>&1; then log "starting vLLM..."; DP=$DP NGPU=$NG bash setup.sh >> run.log 2>&1; fi
  NP=$([ "$DP" = 1 ] && echo 1 || echo $NG)
  for i in $(seq 0 $((NP-1))); do
    ok=0; for t in $(seq 1 180); do curl -sf "localhost:$((PORT+i))/v1/models" >/dev/null 2>&1 && { ok=1; break; }; sleep 10; done
    [ "$ok" = 1 ] && log "endpoint $((PORT+i)) UP" || { log "FATAL endpoint $((PORT+i)) never came up"; exit 1; }
  done
fi

enrich(){ IN_F="$1" OUT_F="$2" python3 enrich_client.py; }   # resume-safe (client skips done ids in OUT_F)

# 2) VIEW WAVES — sequential: export (cards from DB) -> enrich -> persist (writes descriptions+computed to DB)
MAXW=$(python3 -c "import sqlite3;print(max([d for _,d in sqlite3.connect('sqls.sqlite').execute('SELECT view_name,depth FROM view_waves')]+[0]))")
log "view waves 0..$MAXW"
for w in $(seq 0 "$MAXW"); do
  [ -f "done.view.w$w" ] && { log "wave $w already persisted"; continue; }
  PHASE=view WAVE=$w OUT="enrich_input.view.w$w.jsonl" python3 export_wave.py | tee -a run.log
  N=$(wc -l < "enrich_input.view.w$w.jsonl" 2>/dev/null || echo 0)
  if [ "$N" -gt 0 ]; then
    log "wave $w enrich ($N views)"; enrich "enrich_input.view.w$w.jsonl" "enrich_output.view.w$w.jsonl"
    IN="enrich_output.view.w$w.jsonl" python3 persist_wave.py | tee -a run.log
  fi
  touch "done.view.w$w"
done

# 3) OTBI + BIP — EXPORTS run in parallel (cheap, independent, WAL reads). But they share ONE vLLM, so two
#    full-CONC clients would over-subscribe (2×CONC) with no speedup. Enrich through ONE client: it processes
#    otbi then bip as sequential groups at full CONC. Then split the combined output back per source.
log "otbi + bip: parallel export, single enrich"
( PHASE=otbi OUT=enrich_input.otbi.jsonl python3 export_wave.py >>run.log 2>&1 ) &
( PHASE=bip  OUT=enrich_input.bip.jsonl  python3 export_wave.py >>run.log 2>&1 ) &
wait
cat enrich_input.otbi.jsonl enrich_input.bip.jsonl > enrich_input.leaf.jsonl
log "leaf enrich ($(wc -l < enrich_input.leaf.jsonl) units)"
enrich enrich_input.leaf.jsonl enrich_output.leaf.jsonl
python3 - <<'PY'
import json
o=open("enrich_output.otbi.jsonl","w",encoding="utf-8"); b=open("enrich_output.bip.jsonl","w",encoding="utf-8")
for l in open("enrich_output.leaf.jsonl",encoding="utf-8"):
    try: src=json.loads(l).get("source","")
    except Exception: src=""
    (o if src=="otbi" else b).write(l)               # source is on every row now (ok AND failed)
o.close(); b.close()
PY
log "ALL DONE — outputs: enrich_output.view.w*.jsonl + .otbi + .bip ; DB has description_generated+semantics_json"
touch DONE.flag
