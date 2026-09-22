#!/usr/bin/env bash
# P3d — PL/SQL package/function call inventory over work.clear_sql.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p3_calls.sh'
#
# Steps: p3_calls.sql (DDL, rebuild) → p3_calls.py extract (work.f_calls) →
#        p3_calls_post.sql (classify + roll up: work.plsql_api, work.plsql_api_tables) →
#        p3_calls.py export → <repo>/data/plsql_api_usage.{json,csv,md}
# Whole thing is a rebuild: nothing here is incremental, a re-run replaces the inventory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
OUT="${OUT:-$REPO/data}"

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgresql://postgres:${PW}@stack-db:5432/${DB}"

psqlf() {  # docker cp a file, run it as postgres with ON_ERROR_STOP (inline SQL through the WSL bridge mangles quoting)
  docker cp "$HERE/$1" "stack-db:/tmp/$1"
  docker exec stack-db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f "/tmp/$1"
}

# the 9p /mnt/c mount is not a reliable bind-mount source; stage on the distro fs
STAGE=/tmp/pipeline-p3d
rm -rf "$STAGE" && mkdir -p "$STAGE/pipeline" "$STAGE/out"
cp "$HERE/p3_calls.py" "$STAGE/pipeline/"

echo "[p3d] ddl";     psqlf p3_calls.sql
echo "[p3d] extract"
docker run --rm --network "$NET" -v "$STAGE:/app" -e DATABASE_URL="$URL" "$IMAGE" \
  sh -c "pip install -q 'psycopg[binary]' && python /app/pipeline/p3_calls.py extract"
echo "[p3d] rollup";  psqlf p3_calls_post.sql
echo "[p3d] export"
docker run --rm --network "$NET" -v "$STAGE:/app" -e DATABASE_URL="$URL" "$IMAGE" \
  sh -c "pip install -q 'psycopg[binary]' && python /app/pipeline/p3_calls.py export /app/out"
mkdir -p "$OUT"
cp "$STAGE"/out/plsql_api_usage.* "$OUT/"
echo "[p3d] wrote: $(ls "$OUT"/plsql_api_usage.* | tr '\n' ' ')"
