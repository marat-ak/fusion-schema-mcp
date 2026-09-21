#!/usr/bin/env bash
# P2-gap — export the prompt payload for the un-enriched L3 statements and dry-run it.
#
#   wsl -d CloudBeaver -u root -e bash -lc \
#     'OUTDIR=/root/gap-run bash /mnt/c/.../scripts/pipeline/p2_gap.sh export'
#   wsl -d CloudBeaver -u root -e bash -lc \
#     'OUTDIR=/root/gap-run bash /mnt/c/.../scripts/pipeline/p2_gap.sh dryrun'
#
# NEITHER subcommand contacts a model endpoint. The run itself is p2_gap_run.py, which takes
# the endpoint URL and the model id as required arguments and is deliberately NOT wired here:
# there is no URL in this repository to wire.
#
# Required, no defaults:
#   OUTDIR    where the payload / request / sample files are written (distro fs, not /mnt/c)
# Explicit choices, no defaults:
#   FLEX      path to flex_map.json, or the literal word OFF.
#             The original run exported otbi WITH a flex map and the view and bip waves
#             WITHOUT one (measured: enrich_input.otbi.jsonl carries 'flexfield (value by
#             CONTEXT_CODE)' annotations, enrich_input.bip.jsonl and .view.w0.jsonl carry
#             none). The gap cohort is 97 % bip, so this is a live choice about which
#             generation the new rows belong to, not a tuning knob.
#   CPT       measured user-message chars per prompt token, for the dry run's token estimate.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:-}"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
COHORT="${COHORT:-gap}"                 # gap (this script's own) | recheck (p2_recheck.sh export)

if [ "$CMD" != "vcr" ]; then            # vcr writes to the database, not to a directory
  [ -n "${OUTDIR:-}" ] || { echo "[p2-gap] OUTDIR is required — no default"; exit 1; }
  mkdir -p "$OUTDIR"
fi

STAGE=/tmp/pipeline-p2gap
rm -rf "$STAGE" && mkdir -p "$STAGE/pipeline" "$STAGE/gpu-enrich"
cp "$REPO/scripts/pipeline/p2_gap_export.py" "$REPO/scripts/pipeline/p2_gap_dryrun.py" "$STAGE/pipeline/"
cp "$REPO/scripts/gpu-enrich/enrich_client.py" "$REPO/scripts/gpu-enrich/curated_column_remarks.json" "$STAGE/gpu-enrich/"
cp "$REPO/scripts/gpu-enrich/flex_map.json" "$STAGE/gpu-enrich/"

case "$CMD" in
vcr)
  # Land the derived VIEW column remarks in work, from the run's own sqls.sqlite.
  # SQLS_DB must be given: there is one copy of that file and no default path to it.
  [ -n "${SQLS_DB:-}" ] || { echo "[p2-gap] SQLS_DB is required (path to the run's sqls.sqlite)"; exit 1; }
  [ -f "$SQLS_DB" ] || { echo "[p2-gap] SQLS_DB=$SQLS_DB not found"; exit 1; }
  cp "$REPO/scripts/pipeline/p2_gap_vcr.py" "$STAGE/pipeline/"
  PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
  # the DIRECTORY is mounted read-only, not just the file: nothing in the container can
  # create a -wal/-shm beside a 3.7 GB single-copy database.
  docker run --rm --network "$NET" \
    -v "$STAGE:/app/scripts:ro" -v "$(dirname "$SQLS_DB"):/data:ro" \
    -e DATABASE_URL="postgresql://postgres:${PW}@stack-db:5432/${DB}" \
    -e SQLITE="/data/$(basename "$SQLS_DB")" \
    "$IMAGE" sh -c "pip install -q 'psycopg[binary]' && python /app/scripts/pipeline/p2_gap_vcr.py"
  ;;
export)
  [ -n "${FLEX:-}" ] || { echo "[p2-gap] FLEX is required: a path to flex_map.json, or OFF"; exit 1; }
  if [ "$FLEX" = "OFF" ]; then FLEXARG="--no-flex"; else
    [ -f "$FLEX" ] || { echo "[p2-gap] FLEX=$FLEX not found"; exit 1; }
    cp "$FLEX" "$STAGE/gpu-enrich/flex_map.json"; FLEXARG="--flex /app/scripts/gpu-enrich/flex_map.json"
  fi
  PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
  docker run --rm --network "$NET" \
    -v "$STAGE:/app/scripts" -v "$OUTDIR:/out" \
    -e DATABASE_URL="postgresql://postgres:${PW}@stack-db:5432/${DB}" \
    "$IMAGE" sh -c "pip install -q 'psycopg[binary]' && \
      python /app/scripts/pipeline/p2_gap_export.py --cohort $COHORT \
        --out /out/enrich_input.$COHORT.jsonl \
        --curated /app/scripts/gpu-enrich/curated_column_remarks.json $FLEXARG"
  ;;
dryrun)
  [ -n "${CPT:-}" ] || { echo "[p2-gap] CPT is required (measured chars per prompt token)"; exit 1; }
  [ -f "$OUTDIR/enrich_input.gap.jsonl" ] || { echo "[p2-gap] run 'export' first"; exit 1; }
  docker run --rm \
    -v "$STAGE:/app/scripts" -v "$OUTDIR:/out" \
    "$IMAGE" sh -c "pip install -q aiohttp && \
      python /app/scripts/pipeline/p2_gap_dryrun.py \
        --in /out/enrich_input.gap.jsonl --out /out/gap_requests.jsonl \
        --sample-out /out/gap_sample_prompt.txt --chars-per-token $CPT"
  ;;
*)
  echo "usage: OUTDIR=<dir> [SQLS_DB=<path>] [FLEX=<path>|OFF] [CPT=<n>] $0 {vcr|export|dryrun}"; exit 1 ;;
esac
