#!/usr/bin/env bash
# P2a — load the Qwen generation-2 enrichment from its primary JSONL files.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p2_qwen.sh'
#
# The ten primary files live on the distro at /root/enrich-run and are mounted READ-ONLY;
# nothing in this pipeline ever writes to them. ENRICH_DIR must be given explicitly —
# there is no default path and no fallback.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
ENRICH_DIR="${ENRICH_DIR:-/root/enrich-run}"

[ -d "$ENRICH_DIR" ] || { echo "[p2a] ENRICH_DIR=$ENRICH_DIR does not exist"; exit 1; }

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgresql://postgres:${PW}@stack-db:5432/${DB}"

# the 9p /mnt/c mount is not a reliable bind-mount source; stage on the distro fs
STAGE=/tmp/pipeline-p2
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp "$REPO/scripts/pipeline/p2_qwen_load.py" "$STAGE/"

echo "[p2a] loading gen-2 enrichment from $ENRICH_DIR into $DB"
docker run --rm --network "$NET" \
  -v "$STAGE:/app/scripts" \
  -v "$ENRICH_DIR:/data:ro" \
  -e DATABASE_URL="$URL" \
  -e ENRICH_DIR=/data \
  "$IMAGE" sh -c "pip install -q 'psycopg[binary]' && python /app/scripts/p2_qwen_load.py"
