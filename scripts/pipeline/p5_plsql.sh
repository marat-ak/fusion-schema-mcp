#!/usr/bin/env bash
# P5d — fill the PL/SQL API inventory tables of a release schema from `work` (after p3_calls.sh).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_plsql.sh [v2026_10]'
#
# Needs the four plsql_* tables to exist in the release schema (ddl_version 3): a schema created
# by p5_ddl.sh from the current ddl.sql has them; an older release gets them with:
#   docker exec stack-db psql -U postgres -d fusion_dev -c "<the plsql_* CREATE TABLE block of scripts/pg-import/ddl.sql with {{V}} = v2026_10>"
# Re-runnable: one transaction, DELETE + INSERT.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="${1:-v2026_10}"
DB="${DB:-fusion_dev}"
STAGE=/tmp/pipeline-p5
mkdir -p "$STAGE"
OUT="$STAGE/${V}-plsql.sql"

sed "s/{{V}}/$V/g" "$HERE/p5_plsql.sql" > "$OUT"
docker cp "$OUT" stack-db:/tmp/p5plsql.sql >/dev/null
docker exec -i stack-db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /tmp/p5plsql.sql
echo "[p5d] $V.plsql_* filled from work (db $DB)"
