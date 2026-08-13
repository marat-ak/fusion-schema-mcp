#!/bin/bash
# Leaves runner: BIP first (already exported + grounded by the view run), then OTBI (full export + enrich).
# Resume-safe: outputs are append-only; enrich_client skips done ids. Stop anytime (credit-out / stack-kill /
# manual) -> completed units are saved. Leaves need no persist (nothing depends on them; import ingests the
# jsonl later). Reuses export_wave.py + enrich_client.py unchanged.
set -u
cd "$(dirname "$0")"
export SQLS=sqls.sqlite SCH=schema.sqlite CURATED=curated_column_remarks.json FLEX="${FLEX:-flex_map.json}"   # real flexfield meanings (skipped if file absent)
: "${HF_ENDPOINT_URL:?set HF_ENDPOINT_URL}"
: "${HF_TOKEN:?set HF_TOKEN}"
log(){ echo "$(date '+%F %T') $*" | tee -a run.log; }

python3 - <<'PY' || { log "FATAL: endpoint /v1/models unreachable (paused? token?)"; exit 1; }
import os, urllib.request
u = os.environ["HF_ENDPOINT_URL"].rstrip("/") + "/v1/models"
urllib.request.urlopen(urllib.request.Request(u, headers={"Authorization": "Bearer " + os.environ["HF_TOKEN"]}), timeout=30).read()
PY
log "endpoint reachable. CONC=${CONC:-default}"

# 1) BIP — input already grounded from the view run (re-export only if missing)
if [ ! -f done.bip ]; then
  [ -s enrich_input.bip.jsonl ] || { log "export bip"; PHASE=bip OUT=enrich_input.bip.jsonl python3 export_wave.py | tee -a run.log; }
  log "BIP enrich ($(wc -l < enrich_input.bip.jsonl) units)"
  IN_F=enrich_input.bip.jsonl OUT_F=enrich_output.bip.jsonl python3 enrich_client.py && touch done.bip
  log "BIP done"
fi

# 2) OTBI — full export (views are persisted, so cards are grounded), then resume-safe enrich until done/killed
[ -s enrich_input.otbi.jsonl ] || { log "export otbi (full)"; PHASE=otbi OUT=enrich_input.otbi.jsonl python3 export_wave.py | tee -a run.log; }
log "OTBI enrich ($(wc -l < enrich_input.otbi.jsonl) units) — runs until complete or credit/kill"
IN_F=enrich_input.otbi.jsonl OUT_F=enrich_output.otbi.jsonl python3 enrich_client.py && touch DONE.flag
log "ALL LEAVES DONE"
