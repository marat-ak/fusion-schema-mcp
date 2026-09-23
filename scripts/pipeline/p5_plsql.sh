#!/usr/bin/env bash
# P5d — fill the PL/SQL API inventory tables of a release schema from `work` (after p3_calls.sh).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_plsql.sh v2026_11'
#
# A step of the chain for the release being BUILT (after p5_fill.sql, before p5_index.sql): the
# four plsql_* tables come from p5_ddl.sh (ddl.sql ddl_version 3). NEVER run against a release
# that is already built — fusion_dev.v<ver> is immutable after p7_own.sql; a content change is a
# new label through the full chain. One transaction, DELETE + INSERT.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="${1:-}"
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "usage: $(basename "$0") <ver>   (v<YYYY_MM>, the label is REQUIRED — a default would target a distributed release)"; exit 2; }
DB="${DB:-fusion_dev}"
STAGE=/tmp/pipeline-p5
mkdir -p "$STAGE"
OUT="$STAGE/${V}-plsql.sql"

sed "s/{{V}}/$V/g" "$HERE/p5_plsql.sql" > "$OUT"
docker cp "$OUT" stack-db:/tmp/p5plsql.sql >/dev/null
docker exec -i stack-db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /tmp/p5plsql.sql
echo "[p5d] $V.plsql_* filled from work (db $DB)"
