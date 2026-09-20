#!/usr/bin/env bash
# X1 — EXPERIMENT runner: the pinned sqlglot parse over `clear_sql.rewritten_sql` (OTBI only).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/x1_parse_rewrite.sh'
#
# Same container, same pin, same dictionary as p3_parse.sh — only the input column and the
# output tables differ. Resumable: x1_parse_rewrite.py skips hashes already in work.facts2_run.
# Run x1_facts2.sql first. Writes nothing the release build reads.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
PIN="$(sed -n 's/^SQLGLOT_PIN = "\(.*\)"/\1/p' "$REPO/scripts/sqlglot_extract.py")"
[ -n "$PIN" ] || { echo "[x1] could not read SQLGLOT_PIN from scripts/sqlglot_extract.py"; exit 1; }

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgresql://postgres:${PW}@stack-db:5432/${DB}"

# the 9p /mnt/c mount is not a reliable bind-mount source; stage on the distro fs
STAGE=/tmp/pipeline-x1
rm -rf "$STAGE" && mkdir -p "$STAGE/pipeline"
cp "$REPO/scripts/sqlglot_extract.py" "$STAGE/"
cp "$REPO/scripts/pipeline/p3_parse.py" "$STAGE/pipeline/"          # imported for its dictionary loader
cp "$REPO/scripts/pipeline/x1_parse_rewrite.py" "$STAGE/pipeline/"

echo "[x1] sqlglot==$PIN over $DB — parsing rewritten_sql"
docker run --rm --network "$NET" \
  -v "$STAGE:/app/scripts" \
  -e DATABASE_URL="$URL" \
  -e PARSE_LIMIT="${PARSE_LIMIT:-0}" \
  -e PARSE_PROCS="${PARSE_PROCS:-}" \
  -e PARSE_BATCH="${PARSE_BATCH:-2000}" \
  "$IMAGE" sh -c "pip install -q 'sqlglot==$PIN' 'psycopg[binary]' && python /app/scripts/pipeline/x1_parse_rewrite.py"
