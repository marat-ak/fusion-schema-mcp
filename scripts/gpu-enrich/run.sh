#!/bin/bash
# ONE-COMMAND async launcher for the GPU box. Detached, restartable, resume-safe.
#
#   cd ~/work && nohup bash run.sh > run.out 2>&1 & disown
#   # you may now disconnect SSH. Reconnect anytime:
#   cd ~/work && bash status.sh          # progress
#   cd ~/work && bash sample.sh 5        # inspect results
#
# Idempotent: re-running resumes (skips done ids, rebuilds card overlay from output).
set -u
cd "$(dirname "$0")"
source /venv/main/bin/activate 2>/dev/null || true   # venv has aiohttp+vllm
export PORT="${PORT:-8000}"
NG=$(nvidia-smi -L 2>/dev/null | wc -l); [ "${NG:-0}" -lt 1 ] && NG=1
export NGPU="${NGPU:-$NG}"
log() { echo "$(date '+%F %T') $*" | tee -a run.log; }
log "run.sh start NGPU=$NGPU PORT=$PORT"

# 1) input
if [ ! -f enrich_input.jsonl ]; then
  gunzip -kf enrich_input.jsonl.gz 2>/dev/null || { log "FATAL: no enrich_input.jsonl(.gz)"; exit 1; }
fi
TOTAL=$(wc -l < enrich_input.jsonl)
log "input units: $TOTAL"

# 2) vLLM up (setup.sh idempotent: skips model download if ./model exists)
if ! curl -sf "localhost:$PORT/v1/models" >/dev/null 2>&1; then
  log "starting vLLM ($NGPU instance(s))..."
  NGPU=$NGPU PORT=$PORT bash setup.sh >> run.log 2>&1
fi
# wait for every endpoint (up to 30 min for cold model load)
for i in $(seq 0 $((NGPU-1))); do
  ok=0
  for t in $(seq 1 180); do curl -sf "localhost:$((PORT+i))/v1/models" >/dev/null 2>&1 && { ok=1; break; }; sleep 10; done
  [ "$ok" = 1 ] && log "gpu$i endpoint UP" || { log "FATAL: gpu$i endpoint never came up (see vllm_$i.log)"; exit 1; }
done
log "all vLLM endpoints ready"

# 3) supervisor: run client to completion, auto-restart on crash (resume-safe)
attempt=0
while true; do
  DONE=$(wc -l < enrich_output.jsonl 2>/dev/null || echo 0)
  if [ "$DONE" -ge "$TOTAL" ]; then log "COMPLETE $DONE/$TOTAL"; break; fi
  attempt=$((attempt+1))
  log "launch client attempt#$attempt ($DONE/$TOTAL done)"
  NGPU=$NGPU PORT=$PORT python enrich_client.py >> client.log 2>&1
  rc=$?
  log "client exited rc=$rc"
  if [ $rc -ne 0 ]; then sleep 15; fi   # crash → backoff then resume; clean exit → loop re-checks
done
touch DONE.flag
log "run.sh DONE — download enrich_output.jsonl, then DESTROY the instance"
