#!/bin/bash
# =============================================================================================
# E2E VALIDATION of the Fusion enrichment pipeline, scoped to N big BIP reports.
#
# Flow:  select 10 view-rich bips + their recursive VIEW closure  ->  enrich the closure views
#        depth 0..K (base->dependent, persisting each depth so the next sees grounded cards)  ->
#        enrich the 10 bips with now-grounded prompts  ->  dump every level to e2e_report.md.
#
# It ORCHESTRATES the existing, unmodified scripts (export_wave.py / enrich_client.py /
# persist_wave.py) exactly as run_waves.sh does, but scopes each phase by FILTERING the full
# export down to the closure/chosen ids (e2e_filter_jsonl.py). Nothing here reimplements them.
#
# ISOLATION: operates on a COPY under $DIR so the pristine run DB in $SRC is never written.
# Enrichment runs in Docker (--network host; the distro has no aiohttp/pip and containers have
# no bridge net) — the exact image/command the task specifies.
#
# RUN (full — hits the GPU endpoint, writes the copy DB, costs GPU time):
#   wsl -d CloudBeaver -u root -e bash -lc 'set -a; . /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/.env; set +a; bash /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/scripts/gpu-enrich/e2e_bip_test.sh'
#
# DRY PREVIEW (read-only: selection + closure only, no copy, no endpoint, no DB write):
#   wsl -d CloudBeaver -u root -e bash -lc 'DRY_RUN=1 bash /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/scripts/gpu-enrich/e2e_bip_test.sh'
# =============================================================================================
set -euo pipefail

SRC=${SRC:-/root/enrich-run}                     # pristine run folder (source of DBs + reuse scripts)
DIR=${DIR:-/root/enrich-e2e}                     # isolated working copy
E2E_SRC=${E2E_SRC:-/mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/scripts/gpu-enrich}
ENVFILE=${ENVFILE:-/mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/.env}
N_BIPS=${N_BIPS:-10}
SELECT_BY=${SELECT_BY:-closure}                  # closure | sqllen | tables  (see e2e_select_closure.py)
CONC=${CONC:-64}                                 # tiny batches; capped by batch size anyway
MODEL=${MODEL:-Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8}
IMAGE=${IMAGE:-python:3.12}
DRY_RUN=${DRY_RUN:-0}
RESET=${RESET:-0}                                # 1 = wipe $DIR (fresh copy) for a clean re-validation

log(){ echo "$(date '+%F %T') [e2e] $*"; }

# ---- STAGE A: selection + closure (READ-ONLY) --------------------------------------------------
# Dry preview reads the pristine DBs directly in mode=ro (no 3.7GB copy just to preview); the select
# script never writes to the DBs (SELECT-only), only emits small manifest files to $DIR.
if [ "$DRY_RUN" = 1 ]; then
  mkdir -p "$DIR"
  log "DRY_RUN: selection + closure only (read-only+immutable against $SRC — no sidecars, no DB write)"
  SQLS="$SRC/sqls.sqlite" SCH="$SRC/schema.sqlite" OUTDIR="$DIR" RO_IMMUTABLE=1 \
    N_BIPS="$N_BIPS" SELECT_BY="$SELECT_BY" python3 "$E2E_SRC/e2e_select_closure.py"
  log "DRY_RUN done — no enrichment, no DB write. Manifest: $DIR/closure.json"
  exit 0
fi

# ---- full run: isolate ------------------------------------------------------------------------
[ -n "$DIR" ] && [ "$DIR" != "/" ] || { echo "refusing: bad DIR='$DIR'"; exit 1; }
[ "$RESET" = 1 ] && { log "RESET: wiping $DIR"; rm -rf "$DIR"; }
mkdir -p "$DIR"
log "isolate into $DIR"
cp -f "$SRC"/export_wave.py "$SRC"/enrich_client.py "$SRC"/persist_wave.py "$DIR"/
cp -f "$E2E_SRC"/e2e_select_closure.py "$E2E_SRC"/e2e_filter_jsonl.py "$E2E_SRC"/e2e_dump_report.py "$E2E_SRC"/e2e_copy_db.py "$DIR"/
cp -f "$SRC"/curated_column_remarks.json "$DIR"/
# big DBs: copy only if absent, so reruns are fast. COPY_MODE:
#   cp     (default) — fast; SAFE for the pristine SOURCE (cp only reads it). Take it when the live
#                      run_waves.sh is idle (not mid-persist) so the DESTINATION snapshot is clean.
#   backup           — consistent online snapshot via sqlite backup API; safe even if a live writer is
#                      persisting during the copy. Slower (streams the DB through python). USE THIS if a
#                      run_waves.sh is actively enriching/persisting on $SRC (one was observed running).
COPY_MODE=${COPY_MODE:-cp}
copydb(){  # $1=basename
  if [ -f "$DIR/$1" ]; then return; fi
  if [ "$COPY_MODE" = backup ]; then log "backup-copy $1 (consistent snapshot)..."; python3 "$DIR/e2e_copy_db.py" "$SRC/$1" "$DIR/$1"
  else log "cp $1 ..."; cp -f "$SRC/$1"* "$DIR"/; fi
}
copydb sqls.sqlite
copydb schema.sqlite

# creds for the endpoint must be exported for `docker -e HF_ENDPOINT_URL -e HF_TOKEN` passthrough
if [ -z "${HF_ENDPOINT_URL:-}" ]; then
  log "sourcing $ENVFILE for HF_ENDPOINT_URL/HF_TOKEN"
  set -a; . "$ENVFILE"; set +a
fi
[ -n "${HF_ENDPOINT_URL:-}" ] && [ -n "${HF_TOKEN:-}" ] || { echo "missing HF_ENDPOINT_URL/HF_TOKEN (source $ENVFILE)"; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }

log "selection + closure on the COPY (select_by=$SELECT_BY n_bips=$N_BIPS)"
SQLS="$DIR/sqls.sqlite" SCH="$DIR/schema.sqlite" OUTDIR="$DIR" \
  N_BIPS="$N_BIPS" SELECT_BY="$SELECT_BY" python3 "$DIR/e2e_select_closure.py"

# enrich() — the exact Docker invocation from the task; IN_F/OUT_F are relative to /work=$DIR
enrich(){  # $1=IN_F basename  $2=OUT_F basename
  log "enrich (docker): $1 -> $2"
  docker run --network host --rm -v "$DIR":/work -w /work \
    -e HF_ENDPOINT_URL -e HF_TOKEN -e MODEL_NAME="$MODEL" -e CONC="$CONC" \
    -e IN_F="$1" -e OUT_F="$2" "$IMAGE" \
    bash -c "pip install -q aiohttp && python3 enrich_client.py"
}

# ---- STAGE B1: view closure, depth 0..K (base -> dependent) ------------------------------------
DEPTHS=$(cat "$DIR/depths.txt" 2>/dev/null || true)
log "view-closure depths present: ${DEPTHS//$'\n'/ }"
for d in $DEPTHS; do
  log "=== view depth $d ==="
  # reuse export_wave.py for the WHOLE wave, then filter to the closure ids at this depth
  PHASE=view WAVE="$d" SQLS="$DIR/sqls.sqlite" SCH="$DIR/schema.sqlite" \
    CURATED="$DIR/curated_column_remarks.json" OUT="$DIR/enrich_input.view.w$d.full.jsonl" \
    python3 "$DIR/export_wave.py"
  IN="$DIR/enrich_input.view.w$d.full.jsonl" IDS="$DIR/ids.view.w$d.txt" \
    OUT="$DIR/enrich_input.view.w$d.jsonl" python3 "$DIR/e2e_filter_jsonl.py"
  enrich "enrich_input.view.w$d.jsonl" "enrich_output.view.w$d.jsonl"
  # persist so the NEXT depth's export cards carry these fresh descriptions (the grounding under test)
  IN="$DIR/enrich_output.view.w$d.jsonl" SQLS="$DIR/sqls.sqlite" python3 "$DIR/persist_wave.py"
done

# ---- STAGE B2: the 10 bips, with now-grounded full prompts -------------------------------------
log "=== bips ==="
PHASE=bip SQLS="$DIR/sqls.sqlite" SCH="$DIR/schema.sqlite" \
  CURATED="$DIR/curated_column_remarks.json" OUT="$DIR/enrich_input.bip.full.jsonl" \
  python3 "$DIR/export_wave.py"
IN="$DIR/enrich_input.bip.full.jsonl" IDS="$DIR/ids.bip.txt" \
  OUT="$DIR/enrich_input.bip.jsonl" python3 "$DIR/e2e_filter_jsonl.py"
enrich "enrich_input.bip.jsonl" "enrich_output.bip.jsonl"
# persist_wave.py only writes source='view' rows, so this is a no-op for bips by design (matches
# run_waves.sh, which does not persist bips). Kept for symmetry with task step 6; harmless.
IN="$DIR/enrich_output.bip.jsonl" SQLS="$DIR/sqls.sqlite" python3 "$DIR/persist_wave.py"

# ---- STAGE C: dump every level for quality review ---------------------------------------------
log "=== dump report ==="
DIR="$DIR" python3 "$DIR/e2e_dump_report.py"
log "DONE — review $DIR/e2e_report.md"
