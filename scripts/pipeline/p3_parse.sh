#!/usr/bin/env bash
# P3b — run the pinned sqlglot parse over work.clear_sql.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p3_parse.sh'
#
# Resumable: p3_parse.py skips statements already in work.facts_run, so an interrupted
# run continues where it stopped. PARSE_LIMIT=<n> makes it a sample run (never a release).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
# MUST match sqlglot_extract.SQLGLOT_PIN — the module asserts it at import and refuses to run.
PIN="$(sed -n 's/^SQLGLOT_PIN = "\(.*\)"/\1/p' "$REPO/scripts/sqlglot_extract.py")"
[ -n "$PIN" ] || { echo "[p3b] could not read SQLGLOT_PIN from scripts/sqlglot_extract.py"; exit 1; }

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgresql://postgres:${PW}@stack-db:5432/${DB}"

# the 9p /mnt/c mount is not a reliable bind-mount source; stage on the distro fs
STAGE=/tmp/pipeline-p3
rm -rf "$STAGE" && mkdir -p "$STAGE/pipeline"
cp "$REPO/scripts/sqlglot_extract.py" "$STAGE/"
cp "$REPO/scripts/pipeline/p3_parse.py" "$STAGE/pipeline/"

echo "[p3b] sqlglot==$PIN over $DB"
docker run --rm --network "$NET" \
  -v "$STAGE:/app/scripts" \
  -e DATABASE_URL="$URL" \
  -e PARSE_LIMIT="${PARSE_LIMIT:-0}" \
  -e PARSE_PROCS="${PARSE_PROCS:-}" \
  -e PARSE_BATCH="${PARSE_BATCH:-2000}" \
  "$IMAGE" sh -c "pip install -q 'sqlglot==$PIN' 'psycopg[binary]' && python /app/scripts/pipeline/p3_parse.py"
