#!/usr/bin/env bash
# P4 runner — embed every L3 statement with the repo's own embedder, sharded.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p4_run.sh [SHARDS]'
#
# One container per shard, all in parallel. Shards are a pure function of sql_hash,
# so they are disjoint and the run is order-independent and restartable.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHARDS="${1:-12}"
DB="${DB:-fusion_dev}"
IMAGE="${IMAGE:-schema-mcp-build:latest}"
NET="${NET:-oservices_default}"

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgres://postgres:${PW}@stack-db:5432/${DB}"

# the 9p /mnt/c mount cannot be bind-mounted into a container reliably; stage on the distro fs
STAGE=/tmp/pipeline-p4
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp "$REPO/scripts/pipeline"/*.mts "$STAGE/"

echo "[p4] $SHARDS shards -> work.embeddings on $DB"
pids=()
for ((s = 0; s < SHARDS; s++)); do
  docker run --rm --network "$NET" \
    -v "$STAGE:/app/scripts/pipeline" \
    -e DATABASE_URL="$URL" -e SHARD="$s" -e SHARDS="$SHARDS" \
    "$IMAGE" npx tsx /app/scripts/pipeline/p4_embed.mts \
    > "$STAGE/shard-$s.log" 2>&1 &
  pids+=($!)
done

fail=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then echo "[p4] shard $i FAILED"; tail -20 "$STAGE/shard-$i.log"; fail=1; fi
done
grep -h "done:\|layout patterns:" "$STAGE"/shard-*.log || true
[ "$fail" -eq 0 ] || { echo "[p4] at least one shard failed"; exit 1; }
echo "[p4] all shards complete"
