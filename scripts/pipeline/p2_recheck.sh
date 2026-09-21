#!/usr/bin/env bash
# P2-recheck — fold a finished enrichment journal into `work`, re-reconcile the table facts
# with the model's `missingTables` claims, re-export the statements whose grounding moved,
# and enrich them. Three subcommands, run in this order, each one idempotent:
#
#   load    JOURNALS=<names> ENRICH_DIR=<dir> OUTDIR=<dir>          p2_recheck.sh load
#           work.qwen_record := the ten primaries + $OUTDIR/<each JOURNAL>, in that order
#           (p2_qwen_load.py, EXTRA_FILES) → p2_promote.sql → p3_reconcile.sql →
#           p2_recheck.sql (the report) → p7_own.sql (work back to fusion_dev)
#   export  OUTDIR=<dir> FLEX=OFF|<path>                              p2_recheck.sh export
#           p2_gap.sh export with COHORT=recheck → $OUTDIR/enrich_input.recheck.jsonl
#   run     OUTDIR=<dir> ENV_FILE=<path> MODEL=<id> CONC=<n>          p2_recheck.sh run
#           p2_gap_run.py over that file, journal $OUTDIR/enrich_output.recheck.jsonl,
#           log $OUTDIR/run.recheck.log; resume-safe by ghash. Then `load` again with the
#           recheck journal appended to JOURNALS so `work` holds the re-enriched text.
#
# Every input is explicit. No default directory, journal list, endpoint file, model or
# concurrency: a missing one is a hard exit naming what is needed. ENV_FILE is sourced for
# HF_ENDPOINT_URL / HF_TOKEN and NEITHER value is ever printed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/scripts/pipeline"
CMD="${1:-}"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"

need() { [ -n "${!1:-}" ] || { echo "[p2-recheck] $1 is required — no default ($2)"; exit 1; }; }
need OUTDIR "distro-fs directory holding the journals and payloads, e.g. /root/gap-run"
[ -d "$OUTDIR" ] || { echo "[p2-recheck] OUTDIR=$OUTDIR does not exist"; exit 1; }

psqlf() {  # docker cp a file, run it as postgres with ON_ERROR_STOP (inline SQL through the WSL bridge mangles quoting)
  docker cp "$HERE/$1" "stack-db:/tmp/$1"
  docker exec stack-db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f "/tmp/$1"
}

case "$CMD" in
load)
  need JOURNALS "comma-separated journal file names under OUTDIR, e.g. enrich_output.gap.jsonl,enrich_output.recheck.jsonl"
  need ENRICH_DIR "directory of the ten primary 2026-08 JSONL files"
  [ -d "$ENRICH_DIR" ] || { echo "[p2-recheck] ENRICH_DIR=$ENRICH_DIR does not exist"; exit 1; }
  EXTRA=""
  IFS=',' read -ra J <<< "$JOURNALS"
  for j in "${J[@]}"; do
    [ -f "$OUTDIR/$j" ] || { echo "[p2-recheck] journal $OUTDIR/$j not found"; exit 1; }
    EXTRA="${EXTRA:+$EXTRA,}/journals/$j"
  done
  STAGE=/tmp/pipeline-p2recheck
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp "$HERE/p2_qwen_load.py" "$STAGE/"
  PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
  echo "[p2-recheck] before: $(docker exec stack-db psql -U postgres -d "$DB" -Atc \
      "SELECT count(*) || ' records · ' || (SELECT count(*) FROM work.r_tables WHERE provenance='model_added') || ' model_added rows' FROM work.qwen_record")"
  docker run --rm --network "$NET" \
    -v "$STAGE:/app/scripts" -v "$ENRICH_DIR:/data:ro" -v "$OUTDIR:/journals:ro" \
    -e DATABASE_URL="postgresql://postgres:${PW}@stack-db:5432/${DB}" \
    -e ENRICH_DIR=/data -e EXTRA_FILES="$EXTRA" \
    "$IMAGE" sh -c "pip install -q 'psycopg[binary]' && python /app/scripts/p2_qwen_load.py"
  echo "[p2-recheck] promote"; psqlf p2_promote.sql >/dev/null
  echo "[p2-recheck] reconcile"; psqlf p3_reconcile.sql >/dev/null
  echo "[p2-recheck] report"; psqlf p2_recheck.sql
  echo "[p2-recheck] own"; psqlf p7_own.sql >/dev/null
  ;;
export)
  need FLEX "path to flex_map.json, or OFF — same choice p2_gap.sh export takes"
  COHORT=recheck OUTDIR="$OUTDIR" FLEX="$FLEX" DB="$DB" NET="$NET" IMAGE="$IMAGE" bash "$HERE/p2_gap.sh" export
  ;;
run)
  need ENV_FILE "file exporting HF_ENDPOINT_URL and HF_TOKEN (values are never printed)"
  need MODEL "the served model id exactly as /v1/models reports it"
  need CONC "in-flight requests"
  [ -f "$ENV_FILE" ] || { echo "[p2-recheck] ENV_FILE=$ENV_FILE not found"; exit 1; }
  [ -f "$OUTDIR/enrich_input.recheck.jsonl" ] || { echo "[p2-recheck] run 'export' first"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  [ -n "${HF_ENDPOINT_URL:-}" ] && [ -n "${HF_TOKEN:-}" ] || { echo "[p2-recheck] ENV_FILE must export HF_ENDPOINT_URL and HF_TOKEN"; exit 1; }
  RUN_ID="recheck-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[p2-recheck] run_id=$RUN_ID model=$MODEL conc=$CONC → $OUTDIR/run.recheck.log"
  docker run --rm --network host -v "$OUTDIR:/work" \
    -v "$REPO/scripts:/scripts:ro" \
    -e HF_ENDPOINT_URL -e HF_TOKEN "$IMAGE" bash -c "
      pip install -q aiohttp psycopg && python3 /scripts/pipeline/p2_gap_run.py \
        --in /work/enrich_input.recheck.jsonl --out /work/enrich_output.recheck.jsonl \
        --url \"\$HF_ENDPOINT_URL\" --model '$MODEL' --conc '$CONC' --auth bearer \
        --run-id '$RUN_ID'" 2>&1 | tee -a "$OUTDIR/run.recheck.log"
  ;;
*)
  echo "usage: OUTDIR=<dir> [JOURNALS=… ENRICH_DIR=…] [FLEX=…] [ENV_FILE=… MODEL=… CONC=…] $0 {load|export|run}"; exit 1 ;;
esac
